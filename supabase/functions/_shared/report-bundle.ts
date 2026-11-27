/**
 * report 讀取端的單一 RPC（report_context_bundle）呼叫與回傳驗證
 * （Edge Function 內部 REST 瘦身 第 1 期 PR-2，migration 20261127093000；設計 docs/function-rest-slim-plan.md 第 5.3 節）。
 *
 * 只合併「讀」：寫入（insert 票、insert 貢獻、租約歸還、落庫）一個字沒動，判斷條件與回應文字也沒動——
 * 呼叫端照原本的順序做原本的檢查，只是資料改從這一次 RPC 的結果拿。
 *   verify_pre     投票前：額度計數、被驗貢獻、裁決的原貢獻、派工綁定、這筆的既有票、自己上一票的備註（原本 4～6 次 REST）
 *   verify_post    投票後：貢獻最新狀態與分數、目標分數（原本 2 次）
 *   contribute_pre 交件前：額度計數、這批任務的型別與多人任務內容、同 IP 在排隊的貢獻（原本 4～5 次）
 * RPC 回錯（函式不存在、例外、形狀不對）一律回 null 並 console.warn 一行，呼叫端退回原本的逐項查詢（輸出不變）。
 * 這支檔只有純函式與一次 rpc 呼叫，不 import 任何 handler（沒有循環載入）。
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const isObj = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

async function callBundle(supabase: SupabaseLike, kind: string, params: Record<string, unknown>): Promise<unknown | null> {
  try {
    const res = await supabase.rpc("report_context_bundle", { p_kind: kind, p_params: params });
    if (res.error) throw new Error(res.error.message ?? String(res.error));
    if (res.data === null || res.data === undefined) throw new Error("empty response");
    return res.data;
  } catch (e) {
    console.warn(`report_context_bundle(${kind}) 失敗，退回逐項查詢：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ---- verify_pre ----

export interface VerifyPreParams {
  contribution_id: string;
  quota_column: "actor_id" | "verifier_ip_hash";
  quota_value: string;
  window_start: string;
  /** 沒帶派工憑證且不是併票時，要查派工綁定：{ ip_hash }；其他情況 null。時限在 SQL 裡寫死 7 天（＝VERIFY_BINDING_DAYS，守門見 dispatch-records-purge.test.ts） */
  binding: { ip_hash: string } | null;
  /** 同意票帶備註時要比自己上一票：{ column, value }；其他情況 null */
  prev: { column: "actor_id" | "agent_name"; value: string } | null;
}

export interface VerifyPre {
  used: number;
  contribution: Row | null;
  original: Row | null;
  dispatched: Row[];
  existing: Row[];
  prev: { note?: string | null } | null;
}

export function isVerifyPre(x: unknown): x is VerifyPre {
  if (!isObj(x)) return false;
  return typeof x.used === "number" && "contribution" in x && (x.contribution === null || isObj(x.contribution))
    && (x.original === null || isObj(x.original)) && isArr(x.dispatched) && isArr(x.existing) && (x.prev === null || isObj(x.prev));
}

export async function readVerifyPre(supabase: SupabaseLike, p: VerifyPreParams): Promise<VerifyPre | null> {
  const data = await callBundle(supabase, "verify_pre", { ...p });
  if (data === null) return null;
  if (!isVerifyPre(data)) {
    console.warn("report_context_bundle(verify_pre) 回傳形狀不對，退回逐項查詢");
    return null;
  }
  return data;
}

// ---- verify_post ----

export interface VerifyPost {
  after: Row | null;
  effective: number | null;
}

export function isVerifyPost(x: unknown): x is VerifyPost {
  return isObj(x) && "after" in x && (x.after === null || isObj(x.after)) && "effective" in x && (x.effective === null || typeof x.effective === "number");
}

export async function readVerifyPost(supabase: SupabaseLike, contributionId: string): Promise<VerifyPost | null> {
  const data = await callBundle(supabase, "verify_post", { contribution_id: contributionId });
  if (data === null) return null;
  if (!isVerifyPost(data)) {
    console.warn("report_context_bundle(verify_post) 回傳形狀不對，退回逐項查詢");
    return null;
  }
  return data;
}

// ---- contribute_pre ----

export interface ContributePreParams {
  quota_column: "actor_id" | "contributor_ip_hash";
  quota_value: string;
  window_start: string;
  /** 這批任務裡所有 uuid 形狀的 task_id（含 payload.task_id）；auto: 開頭的不用給 */
  task_ids: string[];
  /** 這批的 task_id（含 auto:），用來查同 IP 排隊中的貢獻 */
  inflight_task_ids: string[];
  ip_hash: string;
}

export interface ContributePre {
  used: number;
  tasks: Array<{ id: string; task_type: string; multi_person: boolean; target: unknown }>;
  in_flight: string[];
}

export function isContributePre(x: unknown): x is ContributePre {
  return isObj(x) && typeof x.used === "number" && isArr(x.tasks) && x.tasks.every((t) => isObj(t) && typeof t.id === "string")
    && isArr(x.in_flight) && x.in_flight.every((t) => typeof t === "string");
}

export async function readContributePre(supabase: SupabaseLike, p: ContributePreParams): Promise<ContributePre | null> {
  const data = await callBundle(supabase, "contribute_pre", { ...p });
  if (data === null) return null;
  if (!isContributePre(data)) {
    console.warn("report_context_bundle(contribute_pre) 回傳形狀不對，退回逐項查詢");
    return null;
  }
  return data;
}
