/**
 * contribution_tasks 的建立／關閉（維護者 apply create_task／close_task、task_suggestion 落庫、request-task 都走這裡）。
 * validateTaskInput 是純函式（可測）。
 */

import { TASK_TYPES } from "./contribution-schema.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export type TaskSource = "manual" | "suggested" | "web_request" | "auto_dispute";

export interface TaskInput {
  title: string;
  description?: string | null;
  task_type?: string;
  target_politician_id?: string | null;
  target_policy_id?: string | null;
  region?: string | null;
  priority?: number;
  hint_sources?: string[];
  /** task_type=audit：要核對的文件網址（存進 target.source_url） */
  source_url?: string | null;
  /** task_type=adjudicate：被裁決的貢獻（存進 target.contribution_id） */
  target_contribution_id?: string | null;
  /** 其他要放進 target 的欄位（例如 contributor、reason） */
  target_extra?: Record<string, unknown>;
}

export interface TaskValidation {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
  input: TaskInput | null;
}

const isStr = (v: unknown, min = 1, max = 2000): v is string => typeof v === "string" && v.trim().length >= min && v.length <= max;
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function validateTaskInput(raw: unknown): TaskValidation {
  const errors: Array<{ path: string; message: string }> = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: [{ path: "task", message: "task 要是物件" }], input: null };
  const t = raw as Obj;
  if (!isStr(t.title, 4, 120)) errors.push({ path: "task.title", message: "title 必填（4～120 字）" });
  if (t.description !== undefined && t.description !== null && !isStr(t.description, 1, 2000)) errors.push({ path: "task.description", message: "要是 1～2000 字" });
  if (t.task_type !== undefined && !(TASK_TYPES as readonly string[]).includes(String(t.task_type))) errors.push({ path: "task.task_type", message: `要是 ${TASK_TYPES.join("／")} 之一` });
  if (t.target_politician_id !== undefined && t.target_politician_id !== null && !isUuid(t.target_politician_id)) errors.push({ path: "task.target_politician_id", message: "要是 uuid" });
  if (t.target_policy_id !== undefined && t.target_policy_id !== null && !isUuid(t.target_policy_id)) errors.push({ path: "task.target_policy_id", message: "要是 uuid" });
  if (t.region !== undefined && t.region !== null && !isStr(t.region, 2, 20)) errors.push({ path: "task.region", message: "縣市名要是字串" });
  if (t.priority !== undefined && !(Number.isInteger(t.priority) && (t.priority as number) >= -10 && (t.priority as number) <= 100)) errors.push({ path: "task.priority", message: "要是 -10～100 的整數" });
  if (t.hint_sources !== undefined && !(Array.isArray(t.hint_sources) && (t.hint_sources as unknown[]).every((s) => isStr(s, 1, 300)))) errors.push({ path: "task.hint_sources", message: "要是字串陣列" });
  if (t.source_url !== undefined && t.source_url !== null && !(isStr(t.source_url, 8, 500) && /^https?:\/\/\S+$/.test(t.source_url))) errors.push({ path: "task.source_url", message: "要是 http(s) 網址" });
  if (errors.length > 0) return { ok: false, errors, input: null };
  return {
    ok: true,
    errors,
    input: {
      title: (t.title as string).trim(),
      description: typeof t.description === "string" ? t.description.trim() : null,
      task_type: typeof t.task_type === "string" ? t.task_type : "other",
      target_politician_id: typeof t.target_politician_id === "string" ? t.target_politician_id : null,
      target_policy_id: typeof t.target_policy_id === "string" ? t.target_policy_id : null,
      region: typeof t.region === "string" ? t.region.replace(/臺/g, "台").trim() : null,
      priority: typeof t.priority === "number" ? t.priority : undefined,
      hint_sources: Array.isArray(t.hint_sources) ? (t.hint_sources as string[]) : [],
      source_url: typeof t.source_url === "string" ? t.source_url.trim() : null,
      target_contribution_id: isUuid(t.target_contribution_id) ? t.target_contribution_id : null,
      target_extra: t.target_extra && typeof t.target_extra === "object" ? (t.target_extra as Record<string, unknown>) : undefined,
    },
  };
}

export function taskTarget(input: TaskInput): Obj {
  return {
    ...(input.target_extra ?? {}),
    ...(input.target_politician_id ? { politician_id: input.target_politician_id } : {}),
    ...(input.target_policy_id ? { policy_id: input.target_policy_id } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(input.source_url ? { source_url: input.source_url } : {}),
    ...(input.target_contribution_id ? { contribution_id: input.target_contribution_id } : {}),
  };
}

/** audit 任務給代理的統一說明（/next、/tasks 都用） */
export const AUDIT_WHAT_WE_NEED = "打開這份文件，核對其內容與我們資料庫既有的相關政見／進度是否一致；不一致就提 correction 或 policy_progress，一致就回報無異動（contribution_type: no_change，payload 帶 task_id、checked_urls、finding）";
/** question 任務給代理的統一說明：講清楚型別、上限、與「重複角度沒有加分」這個容易被忽略的規則 */
export const QUESTION_WHAT_WE_NEED = "這是網站訪客的提問，請找有出處的答案來回答；用 contribution_type: question_answer 回報（payload 帶 question_id、answer）。同一題最多收 3 份不同代理的答案；看 item.current.existing_answers 有沒有人答過，答同一個角度沒有加分，請補不同角度或指出前一份的錯誤，不確定就別答。" +
  "★提問裡附了網址就先打開它：訪客常用這個表單投遞線索（某人在社群宣布參選、某篇報導提到新政見）。除了回答，還要把查到的事實用對應型別補進資料庫——" +
  "candidacy（有人宣布參選）、policy（具體政見）、policy_progress（既有政見有新進度），source_urls 放那個網址。" +
  "只回答不補資料，那筆資料就永遠不會進站，訪客白投一次。" +
  "社群貼文（facebook／threads／IG）是社群級來源，加參選人需要 8 票、實務上過不了：請再找一個官方或媒體來源（鄉鎮公所公告、選委會、地方新聞）一起附上，降到 4 票。找不到第二來源就只回答、在 answer 裡寫明目前只有社群來源可查。";

export interface ManualTaskRowLike { title: string; description: string | null; task_type: string; target: unknown }

/** 手動任務的 what_we_need 與 source_url（audit／question 型別用統一說明並把關鍵資訊提到 item 上） */
export function describeManualTask(t: ManualTaskRowLike): { what_we_need: string; source_url: string | null } {
  const target = (t.target && typeof t.target === "object" ? t.target : {}) as Obj;
  const sourceUrl = typeof target.source_url === "string" ? target.source_url : null;
  if (t.task_type === "audit" && sourceUrl) {
    return { what_we_need: `${AUDIT_WHAT_WE_NEED}。文件：${sourceUrl}${t.description ? `。${t.description}` : ""}`, source_url: sourceUrl };
  }
  // 掃 RSS：把來源網址提到 item.source_url，代理不用從敘述裡撈網址
  if (t.task_type === "news_sweep") {
    const feed = typeof target.feed_url === "string" ? target.feed_url : null;
    return { what_we_need: t.description ?? t.title, source_url: feed };
  }
  if (t.task_type === "question") {
    return { what_we_need: `${QUESTION_WHAT_WE_NEED}。提問：「${t.description ?? t.title}」`, source_url: sourceUrl };
  }
  return { what_we_need: t.description ? `${t.title}：${t.description}` : t.title, source_url: sourceUrl };
}

/** audit 去重：同網址＋同目標（policy_id／politician_id 都要相同，含都沒有） */
export function sameAuditTarget(target: unknown, want: { politician_id?: string | null; policy_id?: string | null }): boolean {
  const t = (target && typeof target === "object" ? target : {}) as Obj;
  return (t.policy_id ?? null) === (want.policy_id ?? null) && (t.politician_id ?? null) === (want.politician_id ?? null);
}

export const AUDIT_DUPLICATE_WINDOW_HOURS = 24;

/** 24 小時內同網址＋同目標建過的 audit 任務（open 或 closed 都算，避免同一份文件被重複丟） */
export async function findRecentAuditTask(supabase: SupabaseLike, want: { source_url: string; politician_id?: string | null; policy_id?: string | null }): Promise<Obj | null> {
  const since = new Date(Date.now() - AUDIT_DUPLICATE_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase.from("contribution_tasks").select("id, target, status, created_at")
    .eq("task_type", "audit").eq("target->>source_url", want.source_url).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(50);
  if (error) throw new Error(`contribution_tasks audit lookup: ${error.message}`);
  return ((data ?? []) as Obj[]).find((r) => sameAuditTarget(r.target, want)) ?? null;
}

export interface CreateTaskOptions {
  source: TaskSource;
  created_by?: string | null;
  suggested_by?: string | null;
  requester_ip_hash?: string | null;
  /** 沒給時：manual=1、web_request=2、suggested=0（見 DEFAULT_PRIORITY） */
  default_priority?: number;
}

/**
 * 任務的預設 priority，由來源決定。數字大的先派（見 dispatch.ts 的 pickManualTask）。
 *
 * 派工順序（2026-09-15 小良哥拍板）：公民提問 > 任務清單 > 自動缺口。
 *   - 公民提問：ask 端點明確帶 QUESTION_PRIORITY，手動池最高那一層
 *   - 任務清單：網站按鈕建的任務（web_request）與裁決同一層；自動缺口本來就排在整個手動池之後
 *
 * 2026-09-13 之前 web_request 是 0、裁決是 2，而且挑選是整池隨機的，所以民眾提問要抽籤。
 * 小良哥：「這種提問 不會優先被領走嗎，有人問，提早解決啊」。
 */
export const QUESTION_PRIORITY = 3;
export const DEFAULT_PRIORITY: Readonly<Record<string, number>> = {
  web_request: 2,  // 網站訪客按按鈕：有真人在等，但排在公民提問後面
  manual: 1,       // 維護者自己建的
};
// 其餘（auto_dispute 的裁決／修正任務自己帶 priority、suggested 是代理提議通過的）落到 0。

export async function createTask(supabase: SupabaseLike, input: TaskInput, options: CreateTaskOptions): Promise<Obj> {
  const defaultPriority = options.default_priority ?? DEFAULT_PRIORITY[options.source] ?? 0;
  const { data, error } = await supabase.from("contribution_tasks").insert({
    title: input.title,
    description: input.description ?? null,
    task_type: input.task_type ?? "other",
    target: taskTarget(input),
    region: input.region ?? null,
    priority: input.priority ?? defaultPriority,
    reward: 1,
    status: "open",
    source: options.source,
    created_by: options.created_by ?? null,
    suggested_by: options.suggested_by ?? null,
    hint_sources: input.hint_sources ?? [],
    requester_ip_hash: options.requester_ip_hash ?? null,
  }).select("*").maybeSingle();
  if (error) throw new Error(`contribution_tasks insert: ${error.message}`);
  if (!data) throw new Error("contribution_tasks insert 沒有回傳");
  return data as Obj;
}

export async function closeTask(supabase: SupabaseLike, taskId: string, closedBy: string | null): Promise<Obj | null> {
  const { data, error } = await supabase.from("contribution_tasks")
    .update({ status: "closed", closed_at: new Date().toISOString(), ...(closedBy ? { created_by: undefined } : {}) })
    .eq("id", taskId).select("*").maybeSingle();
  if (error) throw new Error(`contribution_tasks close: ${error.message}`);
  return (data as Obj) ?? null;
}

/**
 * 同一目標是否已有 open 的手動／提議／網站任務。
 * 有給 task_type 就只比同型別：同一筆政見「查進度」與「這不是政見？」是兩件不同的事，
 * 也不該因為有人對它發了一題公民提問，按鈕就回「已在任務池中」。
 */
export async function findOpenTaskForTarget(supabase: SupabaseLike, target: { politician_id?: string | null; policy_id?: string | null; task_type?: string | null }): Promise<Obj | null> {
  let q = supabase.from("contribution_tasks").select("id, title, source, task_type, created_at").eq("status", "open").limit(1);
  if (target.task_type) q = q.eq("task_type", target.task_type);
  if (target.policy_id) q = q.eq("target->>policy_id", target.policy_id);
  else if (target.politician_id) q = q.eq("target->>politician_id", target.politician_id);
  else return null;
  const { data, error } = await q;
  if (error) throw new Error(`contribution_tasks lookup: ${error.message}`);
  return ((data ?? []) as Obj[])[0] ?? null;
}
