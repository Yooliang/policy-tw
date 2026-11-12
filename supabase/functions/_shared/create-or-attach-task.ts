/**
 * 建任務前先用 work_key 查重併卡（工作卡③，migration 20261112080000，docs/PLAN-workcard-123.md 項目③）。
 *
 * 這張卡（同一人×同一件事）已經在派工隊列上，就不再開一筆平行任務：改寫一筆需求訊號（work_card_signals，①的疊加來源）、
 * 必要時插隊一次，回 { attached: true, task_id, work_key }。沒有卡（或任務型別不是卡的形狀：question、audit、adjudicate…）才照舊 createTask。
 * work_key 一律由 SQL 算（task_work_key_for_manual），TS 不自己拼。
 *
 * 保險絲：環境變數 WORK_CARD_ATTACH=off 時整個退回舊的 createTask（併卡與訊號都不做）。
 * 訊號與併卡失敗（資料庫函式還沒上線、暫時連不上）一律退回舊行為（新開任務）並留 console.warn，不擋請求。
 */
import { createTask, taskTarget, type CreateTaskOptions, type TaskInput } from "./task-admin.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

/** 來源 → 訊號類別；manual（維護者指定）只回報命中、不算需求 */
export const SOURCE_SIGNAL_KIND: Readonly<Record<string, "request" | "suggest" | null>> = {
  web_request: "request",
  suggested: "suggest",
  manual: null,
  auto_dispute: null,
};

export interface AttachResult {
  attached: boolean;
  task_id?: string;
  signal_added?: boolean;
  /** 卡在查核冷卻中：訊號已寫、沒插隊；呼叫端照「近期查過」回應 */
  cooling?: boolean;
  last_checked_at?: string | null;
}

export interface CreateOrAttachOptions extends CreateTaskOptions {
  /** 維護者指定任務專用：true＝不查重、照開（apply create_task 的 force_new） */
  force_new?: boolean;
  /** 訊號的人：request＝requester_ip_hash、suggest＝代理名；沒給時用 requester_ip_hash／suggested_by／created_by */
  actor?: string | null;
  /** 網站請求的範圍（pledge／tenure），影響併到哪一張（見 work_card_resolve） */
  scope?: string | null;
  /** 併卡時對這次新增的訊號插隊一次（網站請求用，同 #912 的待遇） */
  boost?: boolean;
  /** 系統自己的掃描（Jev 追問、jev-bio…）：只併卡、不寫需求訊號（系統掃描不算需求） */
  no_signal?: boolean;
  /** 併卡時存進 work_card_notes 的說明；沒給就用標題＋說明＋來源網址 */
  note?: string | null;
  /** 覆蓋保險絲（預設讀環境變數 WORK_CARD_ATTACH）；false＝退回舊的 createTask */
  enabled?: boolean;
}

export type CreateOrAttachResult =
  | { attached: true; task_id: string; work_key: string; signal_added: boolean; cooling: boolean; last_checked_at: string | null }
  | { attached: false; task: Obj; work_key: string | null };

/** 保險絲：測試或呼叫端可直接傳 enabled；沒傳就讀 WORK_CARD_ATTACH（沒有 env 權限讀不到時當 on） */
export const workCardAttachEnabled = (enabled?: boolean): boolean => {
  if (enabled !== undefined) return enabled;
  try {
    return (Deno.env.get("WORK_CARD_ATTACH") ?? "on").toLowerCase() !== "off";
  } catch {
    return true;
  }
};

const noteOf = (input: TaskInput, options: CreateOrAttachOptions): string | null => {
  if (options.note !== undefined) return options.note;
  const text = [input.title, input.description, input.source_url].filter((x) => typeof x === "string" && x.trim()).join("｜");
  return text || null;
};

const actorOf = (options: CreateOrAttachOptions): string | null =>
  (options.actor ?? options.requester_ip_hash ?? options.suggested_by ?? options.created_by ?? null) || null;

/** 這個任務輸入對應的工作卡鍵與尚開著的任務（SQL 算）；算不出（不是卡的形狀、保險絲關了、資料庫失敗）回 null */
export async function workCardOf(
  supabase: SupabaseLike,
  input: TaskInput,
  scope: string | null = null,
  enabled?: boolean,
): Promise<{ work_key: string; task_id: string | null } | null> {
  if (!workCardAttachEnabled(enabled)) return null;
  try {
    const target = taskTarget(input);
    const { data: key, error } = await supabase.rpc("task_work_key_for_manual", { p_type: input.task_type ?? "other", p_target: target });
    if (error) throw new Error(error.message);
    if (typeof key !== "string" || !key) return null;
    const { data: taskId, error: e2 } = await supabase.rpc("work_card_resolve", { p_work_key: key, p_scope: scope });
    if (e2) throw new Error(e2.message);
    return { work_key: key, task_id: typeof taskId === "string" && taskId ? taskId : null };
  } catch (e) {
    console.warn("work_card lookup 失敗，退回舊行為：", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 對一張卡寫訊號（request-task 在「已在任務池」時也要算一次需求）。失敗不丟，回 null */
export async function attachSignal(
  supabase: SupabaseLike,
  workKey: string,
  kind: "request" | "suggest" | null,
  actor: string | null,
  opts: { boost?: boolean; scope?: string | null; note?: string | null; source?: string | null; enabled?: boolean } = {},
): Promise<AttachResult | null> {
  if (!workCardAttachEnabled(opts.enabled)) return null;
  try {
    const { data, error } = await supabase.rpc("work_card_attach", {
      p_work_key: workKey, p_kind: actor ? kind : null, p_actor: actor ?? "", p_boost: opts.boost === true, p_scope: opts.scope ?? null,
      p_note: opts.note ?? null, p_source: opts.source ?? null,
    });
    if (error) throw new Error(error.message);
    return (data ?? null) as AttachResult | null;
  } catch (e) {
    console.warn("work_card_attach 失敗：", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * 有卡就併（寫訊號、不開任務），沒卡才 createTask。
 * force_new、保險絲關閉、任務型別不是卡的形狀、卡上沒有尚開著的任務，都走 createTask。
 */
export async function createOrAttachTask(supabase: SupabaseLike, input: TaskInput, options: CreateOrAttachOptions): Promise<CreateOrAttachResult> {
  const { force_new, actor: _a, scope, boost, no_signal: _n, note: _note, enabled, ...createOptions } = options;
  if (force_new || !workCardAttachEnabled(enabled)) {
    return { attached: false, task: await createTask(supabase, input, createOptions), work_key: null };
  }
  const card = await workCardOf(supabase, input, scope ?? null, enabled);
  if (card?.task_id) {
    const kind = options.no_signal ? null : (SOURCE_SIGNAL_KIND[options.source] ?? null);
    const res = await attachSignal(supabase, card.work_key, kind, actorOf(options), { boost, scope, note: noteOf(input, options), source: options.source, enabled });
    if (res?.attached && res.task_id) {
      return { attached: true, task_id: res.task_id, work_key: card.work_key, signal_added: res.signal_added === true,
        cooling: res.cooling === true, last_checked_at: res.last_checked_at ?? null };
    }
  }
  return { attached: false, task: await createTask(supabase, input, createOptions), work_key: card?.work_key ?? null };
}
