/**
 * 爭議不由人處理：一筆貢獻轉 disputed（兩票反對、身份指認衝突／判不出、落庫連續失敗）就自動建一筆 adjudicate 任務，
 * /next 派給其他代理；代理用 contribution_type=adjudication（uphold／reject）回報，4 票同向即定案（見 apply-contribution.ts applyAdjudication）。
 * adjudication 本身被爭議不會再建任務（避免遞迴）；原任務保持 open，下一位代理再裁一次。
 */

import { createTask, type TaskInput } from "./task-admin.ts";
import { summarizeContribution } from "./contribution-summary.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;

export const ADJUDICATE_TASK_TYPE = "adjudicate";
export const ADJUDICATE_PRIORITY = 2;
export const ADJUDICATE_SOURCE = "auto_dispute";

export interface DisputedContribution {
  id: string;
  contribution_type: string;
  payload: Obj;
  source_urls: string[] | null;
  agent_name: string | null;
  status: string;
  review_notes?: string | null;
  last_error?: string | null;
}
export interface DisputeVote { verdict: string; evidence_url: string | null; note: string | null; agent_name: string | null }

const IDENTITY_TYPES = new Set(["politician", "candidacy"]);

/** 純函式：把爭議組成任務（標題／說明／正反雙方來源） */
export function buildAdjudicationTask(c: DisputedContribution, votes: readonly DisputeVote[], reason: string): TaskInput {
  const disagree = votes.filter((v) => v.verdict === "disagree");
  const evidence = disagree.map((v) => v.evidence_url).filter((u): u is string => typeof u === "string" && u.length > 0);
  const hint_sources = [...new Set([...(c.source_urls ?? []), ...evidence])];
  const summary = summarizeContribution({ contribution_type: c.contribution_type, payload: c.payload, applied_politician_id: null, applied_policy_id: null }).summary;
  const objections = disagree.length > 0
    ? disagree.map((v) => `${v.agent_name ?? "?"}：${v.note ?? "（無說明）"}${v.evidence_url ? `（${v.evidence_url}）` : ""}`).join("；")
    : "無";
  const identityHint = IDENTITY_TYPES.has(c.contribution_type) ? "；若爭點是同名多位判不出，payload 多帶 resolved_politician_id 指認" : "";
  const description = `${reason}。原貢獻（${c.contribution_type}，提交者 ${c.agent_name ?? "?"}）：${summary}；payload：${JSON.stringify(c.payload).slice(0, 300)}。反對意見：${objections}。` +
    `${c.last_error ? `落庫錯誤：${c.last_error}（可能是資料問題，可改提 correction）。` : ""}` +
    `請打開 hint_sources 裡正反雙方的來源獨立判斷，用 contribution_type=adjudication 回報 {contribution_id, verdict: "uphold"（原貢獻正確）或 "reject"（原貢獻有誤）, reason（≥20 字）, checked_urls}${identityHint}。4 票同向即定案。`;
  return {
    title: `裁決：${summary}`.slice(0, 120),
    description,
    task_type: ADJUDICATE_TASK_TYPE,
    priority: ADJUDICATE_PRIORITY,
    hint_sources,
    target_contribution_id: c.id,
    target_extra: { contribution_type: c.contribution_type, contributor: c.agent_name ?? null, reason },
  };
}

export async function findOpenAdjudicationTask(supabase: SupabaseLike, contributionId: string): Promise<Obj | null> {
  const { data, error } = await supabase.from("contribution_tasks").select("id, status, created_at")
    .eq("task_type", ADJUDICATE_TASK_TYPE).eq("status", "open").eq("target->>contribution_id", contributionId).limit(1);
  if (error) throw new Error(`adjudicate task lookup: ${error.message}`);
  return ((data ?? []) as Obj[])[0] ?? null;
}

export interface EnsureResult { created: boolean; task_id: string | null; skipped?: "not_found" | "adjudication_itself" | "not_disputed" }

/** 冪等：同一筆爭議只會有一個 open 的裁決任務；adjudication 型別本身不建（避免遞迴） */
export async function ensureAdjudicationTask(supabase: SupabaseLike, contributionId: string, reason: string): Promise<EnsureResult> {
  const { data: c, error } = await supabase.from("contributions")
    .select("id, contribution_type, payload, source_urls, agent_name, status, review_notes, last_error").eq("id", contributionId).maybeSingle();
  if (error) throw new Error(`contributions read: ${error.message}`);
  if (!c) return { created: false, task_id: null, skipped: "not_found" };
  if (c.contribution_type === "adjudication") return { created: false, task_id: null, skipped: "adjudication_itself" };
  if (c.status !== "disputed") return { created: false, task_id: null, skipped: "not_disputed" };
  const existing = await findOpenAdjudicationTask(supabase, contributionId);
  if (existing) return { created: false, task_id: String(existing.id) };
  const { data: votes, error: vError } = await supabase.from("contribution_votes").select("verdict, evidence_url, note, agent_name").eq("contribution_id", contributionId);
  if (vError) throw new Error(`votes read: ${vError.message}`);
  const task = await createTask(supabase, buildAdjudicationTask(c as DisputedContribution, (votes ?? []) as DisputeVote[], reason), { source: "auto_dispute", created_by: "auto-dispute" });
  return { created: true, task_id: String(task.id) };
}


// ------------------------------------------------------------
// 修正任務：反對達門檻時，除了裁決任務再長一筆「照反對意見修好它」。
//
// 為什麼需要：裁決只能二選一（uphold 落庫／reject 退件），沒有第三個出口。
// 但實務上反對者常常**知道正確答案**——2026-09-13 那筆就是：兩位代理都指出
// 「來源是 2026 台中市長選舉的專訪，但這筆政見標 election_id=2024」。
// 舊流程下這筆會被 reject，然後要有人想到去重提一筆同時修 source_url 與
// election_id 的 correction，同一件事跑兩輪，而且第二輪沒人保證會做。
// 現在反對意見會原樣變成一筆任務，不必等人想起來。
//
// 裁決 uphold（原貢獻其實是對的）時這筆任務會被關掉；reject 時刻意留著，
// 因為那正是還沒做完的事。查過覺得不用改就用 no_change 回報關掉它。
// ------------------------------------------------------------
export const FIX_TASK_TYPE = "fix_disputed";
export const FIX_PRIORITY = 2;

/** 純函式：把反對意見組成一筆「請修好它」的任務 */
export function buildFixTask(c: DisputedContribution, votes: readonly DisputeVote[]): TaskInput {
  const disagree = votes.filter((v) => v.verdict === "disagree");
  const evidence = disagree.map((v) => v.evidence_url).filter((u): u is string => typeof u === "string" && u.length > 0);
  const hint_sources = [...new Set([...(c.source_urls ?? []), ...evidence])];
  const summary = summarizeContribution({ contribution_type: c.contribution_type, payload: c.payload, applied_politician_id: null, applied_policy_id: null }).summary;
  const objections = disagree.length > 0
    ? disagree.map((v, i) => `（${i + 1}）${v.agent_name ?? "?"}：${v.note ?? "（無說明）"}${v.evidence_url ? `［反證 ${v.evidence_url}］` : ""}`).join(" ")
    : "（沒有留下反對說明）";
  const description = `有人提了「${summary}」，被反對擋下來了。反對的理由如下，請逐條看過，然後提一筆**改好的新貢獻**——` +
    `不要只重送原本那一欄，反對意見指出的問題要一起修掉（例如來源對了但屆別錯，就連 election_id 一起改）。` +
    `反對意見：${objections}。原本的內容：${JSON.stringify(c.payload).slice(0, 300)}。` +
    `先打開 hint_sources 裡正反雙方的網址自己確認一次，不要直接相信反對者說的。` +
    `確認之後照一般規則提交（多半是 correction；若整筆本來就不該存在，用 removal）。` +
    `查完覺得原本沒問題、或真的無從修起，用 no_change 帶 task_id 回報，這筆任務就會關掉。`;
  return {
    title: `照反對意見修正：${summary}`.slice(0, 120),
    description,
    task_type: FIX_TASK_TYPE,
    priority: FIX_PRIORITY,
    hint_sources,
    target_contribution_id: c.id,
    target_extra: { contribution_type: c.contribution_type, contributor: c.agent_name ?? null, objections: disagree.length },
  };
}

/** 冪等：同一筆爭議只會有一個 open 的修正任務 */
export async function ensureFixTask(supabase: SupabaseLike, contributionId: string): Promise<EnsureResult> {
  const { data: c, error } = await supabase.from("contributions")
    .select("id, contribution_type, payload, source_urls, agent_name, status, review_notes, last_error").eq("id", contributionId).maybeSingle();
  if (error) throw new Error(`contributions read: ${error.message}`);
  if (!c) return { created: false, task_id: null, skipped: "not_found" };
  if (c.contribution_type === "adjudication") return { created: false, task_id: null, skipped: "adjudication_itself" };
  if (c.status !== "disputed") return { created: false, task_id: null, skipped: "not_disputed" };
  const { data: existing, error: exErr } = await supabase.from("contribution_tasks").select("id")
    .eq("task_type", FIX_TASK_TYPE).eq("status", "open").eq("target->>contribution_id", contributionId).limit(1);
  if (exErr) throw new Error(`fix task lookup: ${exErr.message}`);
  if (((existing ?? []) as Obj[])[0]) return { created: false, task_id: String(((existing ?? []) as Obj[])[0].id) };
  const { data: votes, error: vError } = await supabase.from("contribution_votes").select("verdict, evidence_url, note, agent_name").eq("contribution_id", contributionId);
  if (vError) throw new Error(`votes read: ${vError.message}`);
  // 沒有任何反對說明就不建：那多半是落庫失敗轉 disputed，修正任務沒有內容可寫
  const disagree = ((votes ?? []) as DisputeVote[]).filter((v) => v.verdict === "disagree");
  if (disagree.length === 0) return { created: false, task_id: null, skipped: "not_disputed" };
  const task = await createTask(supabase, buildFixTask(c as DisputedContribution, (votes ?? []) as DisputeVote[]), { source: "auto_dispute", created_by: "auto-dispute" });
  return { created: true, task_id: String(task.id) };
}

/** 原貢獻最後是 applied 時才關修正任務；reject 時刻意留著，那是還沒做完的事 */
export async function closeFixTasks(supabase: SupabaseLike, contributionId: string): Promise<number> {
  const { data, error } = await supabase.from("contribution_tasks")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("task_type", FIX_TASK_TYPE).eq("status", "open").eq("target->>contribution_id", contributionId).select("id");
  if (error) throw new Error(`fix task close: ${error.message}`);
  return ((data ?? []) as Obj[]).length;
}
/** 定案後關閉該貢獻所有 open 的裁決任務；回關了幾筆 */
export async function closeAdjudicationTasks(supabase: SupabaseLike, contributionId: string): Promise<number> {
  const { data, error } = await supabase.from("contribution_tasks")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("task_type", ADJUDICATE_TASK_TYPE).eq("status", "open").eq("target->>contribution_id", contributionId).select("id");
  if (error) throw new Error(`adjudicate task close: ${error.message}`);
  return ((data ?? []) as Obj[]).length;
}

/** 掃地機補漏：disputed 但沒有 open 裁決任務的，補建 */
export async function backfillAdjudicationTasks(supabase: SupabaseLike, limit = 20): Promise<{ scanned: number; created: number }> {
  const { data, error } = await supabase.from("contributions").select("id").eq("status", "disputed").neq("contribution_type", "adjudication").limit(limit);
  if (error) throw new Error(`disputed scan: ${error.message}`);
  let created = 0;
  for (const r of (data ?? []) as Obj[]) {
    const res = await ensureAdjudicationTask(supabase, String(r.id), "兩票反對或落庫無法完成（掃地機補建）");
    if (res.created) created++;
  }
  return { scanned: (data ?? []).length, created };
}
