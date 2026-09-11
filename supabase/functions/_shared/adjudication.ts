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
