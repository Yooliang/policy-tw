/**
 * verify 的核心邏輯：POST /verify 與 POST /report{kind:"verify"} 共用。
 * 規則：不能驗自己提交的（agent_name 或 ip_hash 任一相同）；同一筆每個 agent_name 與每個來源 IP 各一票；
 *       disagree 必附 evidence_url；共識由 DB 觸發器算。
 */

import { ENCODING_INVALID_MESSAGE, validateVerifyRequest } from "./contribution-schema.ts";
import { type Actor } from "./actor.ts";
import { resolveIdentity } from "./contribute-handler.ts";
import { isDuplicateVote, isSelfVote, requiredAgree, BLIND_DISAGREE_NOTE, isBlindDisagree } from "./consensus.ts";
import type { HandlerResult } from "./contribute-handler.ts";
import { type ApplyFn, autoApplyContribution, shouldAutoApply } from "./auto-apply.ts";
import { ensureAdjudicationTask } from "./adjudication.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/**
 * 每個來源 IP 每日最多驗幾筆。提交的四倍：驗證比提交便宜，而且待驗證的量
 * （目前 198 筆 pending）本來就該讓人一次消化得完。2026-09-14 從 200 調到 800。
 */
export const VERIFY_DAILY_LIMIT_PER_IP = 800;

export async function handleVerify(supabase: SupabaseLike, body: unknown, ipHash: string, applyFn?: ApplyFn): Promise<HandlerResult> {
  // 身份：agent_name 可能是 ditrust:<序號>，先換成代號與身份鍵（序號不能當代號收進去）
  const identity = await resolveIdentity(body, ipHash);
  if (!identity.ok) return { status: identity.status, body: { success: false, error: "identity_invalid", message: identity.error } };
  body = identity.body;
  const actor: Actor = identity.actor;
  const v = validateVerifyRequest(body);
  if (!v.ok || !v.input) {
    const encoding = v.errors.some((e) => e.code === "encoding_invalid");
    return { status: 400, body: { success: false, error: encoding ? "encoding_invalid" : "validation_failed", ...(encoding ? { message: ENCODING_INVALID_MESSAGE } : {}), errors: v.errors } };
  }
  const input = v.input;

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { count: used, error: countError } = await supabase
    .from("contribution_votes").select("id", { count: "exact", head: true })
    .eq("verifier_ip_hash", ipHash).gte("created_at", todayStart.toISOString());
  if (countError) throw new Error(`rate limit lookup: ${countError.message}`);
  if ((used ?? 0) >= VERIFY_DAILY_LIMIT_PER_IP) {
    return { status: 429, body: { success: false, error: "rate_limited", message: `每個來源 IP 每日最多驗 ${VERIFY_DAILY_LIMIT_PER_IP} 筆` } };
  }

  const { data: contribution, error: cError } = await supabase
    .from("contributions")
    .select("id, status, contribution_type, payload, source_urls, agent_name, contributor_ip_hash, agree_count, disagree_count, unsure_count")
    .eq("id", input.contribution_id)
    .maybeSingle();
  if (cError) throw new Error(`contributions lookup: ${cError.message}`);
  if (!contribution) return { status: 404, body: { success: false, error: "not_found", message: "沒有這筆貢獻" } };
  if (!["pending", "verified", "disputed"].includes(contribution.status)) {
    return { status: 409, body: { success: false, error: "closed", message: `這筆已是 ${contribution.status}，不再收驗證` } };
  }
  if (isSelfVote(contribution, { agent_name: input.agent_name, ip_hash: ipHash })) {
    return { status: 403, body: { success: false, error: "self_vote", message: "不能驗證自己（同 agent_name 或同一來源 IP）提交的貢獻，請跳過這筆" } };
  }
  // 裁決的驗證：原貢獻的提交者也不能投（利益相關）
  if (contribution.contribution_type === "adjudication") {
    const originalId = typeof contribution.payload?.contribution_id === "string" ? contribution.payload.contribution_id : null;
    const { data: original } = originalId ? await supabase.from("contributions").select("agent_name, contributor_ip_hash").eq("id", originalId).maybeSingle() : { data: null };
    if (original && isSelfVote(original, { agent_name: input.agent_name, ip_hash: ipHash })) {
      return { status: 403, body: { success: false, error: "self_vote", message: "這是對你自己那筆貢獻的裁決，不能投票，請跳過" } };
    }
  }

  const { data: existing, error: eError } = await supabase
    .from("contribution_votes").select("id, agent_name, verifier_ip_hash").eq("contribution_id", contribution.id);
  if (eError) throw new Error(`votes lookup: ${eError.message}`);
  if (isDuplicateVote(existing ?? [], { agent_name: input.agent_name, ip_hash: ipHash })) {
    return { status: 409, body: { success: false, error: "already_voted", message: "這筆已經投過票了（同一個來源 IP 只能投一次，換代號不會多一票），請跳過這筆" } };
  }

  // 盲反對改記 unsure（2026-09-19）：備註是「打不開／確認不了」的 disagree 沒有反證，不能算反對
  const blind = input.verdict === "disagree" && isBlindDisagree(input.note);
  const finalVerdict = blind ? "unsure" : input.verdict;
  const finalNote = blind ? `${BLIND_DISAGREE_NOTE}${input.note ?? ""}` : (input.note ?? null);

  const { data: vote, error: insertError } = await supabase
    .from("contribution_votes")
    .insert({
      contribution_id: contribution.id,
      verdict: finalVerdict,
      evidence_url: input.evidence_url ?? null,
      note: finalNote,
      agent_name: input.agent_name,
      agent_tool: input.agent_tool ?? null,
      verifier_ip_hash: ipHash,
      // 身份鍵，同 contributions.actor_id
      actor_id: actor.actor_id,
      resolved_politician_id: input.resolved_politician_id ?? null,
    })
    .select("id")
    .maybeSingle();
  if (insertError) {
    if (/unique|duplicate/i.test(insertError.message)) return { status: 409, body: { success: false, error: "already_voted", message: "這個 agent_name 已對這筆投過票" } };
    throw new Error(`votes insert: ${insertError.message}`);
  }

  const { data: after, error: aError } = await supabase
    .from("contributions").select("status, agree_count, disagree_count, unsure_count").eq("id", contribution.id).maybeSingle();
  if (aError) throw new Error(`contributions reread: ${aError.message}`);
  // 回給代理的「還要幾票」用有效門檻（系統票折進去；2026-09-20），拿不到就退回原門檻
  let effectiveRequired: number | null = null;
  try {
    const { data: eff } = await supabase.rpc("contribution_effective_agree", { p_contribution_id: contribution.id });
    if (typeof eff === "number") effectiveRequired = eff;
  } catch { /* 舊 DB 沒這支函式：退回原門檻 */ }

  // 同儕驗證通過 → 同一請求內自動落庫（失敗不影響投票成功，狀態會變 apply_failed 由掃地機重試）
  const autoApply = shouldAutoApply(after?.status) ? await autoApplyContribution(supabase, contribution.id, applyFn) : { triggered: false };
  const finalStatus = autoApply.triggered && autoApply.status ? autoApply.status : (after?.status ?? contribution.status);
  // 這一票把它變成 disputed → 自動建裁決任務（零人工點）；建不成只記 log
  let adjudicationTaskId: string | null = null;
  if (after?.status === "disputed" && contribution.status !== "disputed") {
    try { adjudicationTaskId = (await ensureAdjudicationTask(supabase, contribution.id, "兩票反對")).task_id; } catch (e) { console.error("ensureAdjudicationTask:", e instanceof Error ? e.message : String(e)); }
  }

  return {
    status: 201,
    body: {
      success: true,
      vote_id: vote?.id,
      contribution_id: contribution.id,
      verdict: finalVerdict,
      ...(blind ? { downgraded_from: "disagree", downgrade_reason: "備註是「無法開啟／確認不了」：那是 unsure，不是反對。反對票要寫出哪一欄與來源矛盾、或附反證網址；來源打不開請投 unsure 並列出試過的網址" } : {}),
      agree_count: after?.agree_count ?? 0,
      disagree_count: after?.disagree_count ?? 0,
      unsure_count: after?.unsure_count ?? 0,
      status: finalStatus,
      required_agree: effectiveRequired ?? requiredAgree(contribution.contribution_type, contribution.payload, contribution.source_urls ?? []),
      ...(autoApply.triggered ? { auto_apply: { status: autoApply.status, message: autoApply.outcome?.message ?? autoApply.error } } : {}),
      ...(adjudicationTaskId ? { adjudication_task_id: adjudicationTaskId, note: "兩票反對 → 已建裁決任務，會派給其他代理用更多票決定" } : {}),
      ...(finalStatus === "applied" ? { note: "同儕驗證通過，已自動上線（applied）；維護者可整筆還原" } : {}),
    },
  };
}
