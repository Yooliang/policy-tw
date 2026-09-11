/**
 * verify 的核心邏輯：POST /verify 與 POST /report{kind:"verify"} 共用。
 * 規則：不能驗自己提交的（agent_name 或 ip_hash 任一相同）；同一筆每個 agent_name 一票；
 *       disagree 必附 evidence_url；共識由 DB 觸發器算。
 */

import { ENCODING_INVALID_MESSAGE, validateVerifyRequest } from "./contribution-schema.ts";
import { isDuplicateVote, isSelfVote, requiredAgree } from "./consensus.ts";
import type { HandlerResult } from "./contribute-handler.ts";
import { type ApplyFn, autoApplyContribution, shouldAutoApply } from "./auto-apply.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export const VERIFY_DAILY_LIMIT_PER_IP = 200;

export async function handleVerify(supabase: SupabaseLike, body: unknown, ipHash: string, applyFn?: ApplyFn): Promise<HandlerResult> {
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
    .select("id, status, contribution_type, payload, agent_name, contributor_ip_hash, agree_count, disagree_count, unsure_count")
    .eq("id", input.contribution_id)
    .maybeSingle();
  if (cError) throw new Error(`contributions lookup: ${cError.message}`);
  if (!contribution) return { status: 404, body: { success: false, error: "not_found", message: "沒有這筆貢獻" } };
  if (!["pending", "verified", "disputed"].includes(contribution.status)) {
    return { status: 409, body: { success: false, error: "closed", message: `這筆已是 ${contribution.status}，維護者已處理，不再收驗證` } };
  }
  if (isSelfVote(contribution, { agent_name: input.agent_name, ip_hash: ipHash })) {
    return { status: 403, body: { success: false, error: "self_vote", message: "不能驗證自己（同 agent_name 或同一來源 IP）提交的貢獻，請跳過這筆" } };
  }

  const { data: existing, error: eError } = await supabase
    .from("contribution_votes").select("id, agent_name").eq("contribution_id", contribution.id);
  if (eError) throw new Error(`votes lookup: ${eError.message}`);
  if (isDuplicateVote(existing ?? [], { agent_name: input.agent_name, ip_hash: ipHash })) {
    return { status: 409, body: { success: false, error: "already_voted", message: "這個 agent_name 已對這筆投過票" } };
  }

  const { data: vote, error: insertError } = await supabase
    .from("contribution_votes")
    .insert({
      contribution_id: contribution.id,
      verdict: input.verdict,
      evidence_url: input.evidence_url ?? null,
      note: input.note ?? null,
      agent_name: input.agent_name,
      agent_tool: input.agent_tool ?? null,
      verifier_ip_hash: ipHash,
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

  // 同儕驗證通過 → 同一請求內自動落庫（失敗不影響投票成功，狀態會變 apply_failed 由掃地機／維護者處理）
  const autoApply = shouldAutoApply(after?.status) ? await autoApplyContribution(supabase, contribution.id, applyFn) : { triggered: false };
  const finalStatus = autoApply.triggered && autoApply.status ? autoApply.status : (after?.status ?? contribution.status);

  return {
    status: 201,
    body: {
      success: true,
      vote_id: vote?.id,
      contribution_id: contribution.id,
      verdict: input.verdict,
      agree_count: after?.agree_count ?? 0,
      disagree_count: after?.disagree_count ?? 0,
      unsure_count: after?.unsure_count ?? 0,
      status: finalStatus,
      required_agree: requiredAgree(contribution.contribution_type, contribution.payload),
      ...(autoApply.triggered ? { auto_apply: { status: autoApply.status, message: autoApply.outcome?.message ?? autoApply.error } } : {}),
      ...(finalStatus === "applied" ? { note: "同儕驗證通過，已自動上線（applied）；維護者可整筆還原" } : {}),
    },
  };
}
