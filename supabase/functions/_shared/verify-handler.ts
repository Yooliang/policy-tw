/**
 * verify 的核心邏輯：POST /verify 與 POST /report{kind:"verify"} 共用。
 * 規則：不能驗自己提交的（agent_name 或 ip_hash 任一相同）；同一筆每個 agent_name 與每個來源 IP 各一票；
 *       disagree 必附 evidence_url；共識由 DB 觸發器算。
 */

import { ENCODING_INVALID_MESSAGE, validateVerifyRequest } from "./contribution-schema.ts";
import { type Actor } from "./actor.ts";
import { resolveIdentity } from "./contribute-handler.ts";
import { isDuplicateVote, isSelfVote, requiredAgree, BLIND_DISAGREE_NOTE, isBlindDisagree, isRubberStampAgree, isRepeatedNote } from "./consensus.ts";
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

export async function handleVerify(supabase: SupabaseLike, body: unknown, ipHash: string, applyFn?: ApplyFn, via = "verify"): Promise<HandlerResult> {
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

  // 派發即綁定：只收「/next 派給你的那一筆」。2026-09-21 使用者裁示——
  // 代理自己挑題目是派發的問題，不是投票的問題，所以執行點在這裡而不是在權重上補丁。
  {
    const { data: dispatched, error: dErr } = await supabase.from("verify_dispatches")
      .select("contribution_id").eq("contribution_id", contribution.id).eq("ip_hash", ipHash).maybeSingle();
    if (dErr) throw new Error(`verify dispatch lookup: ${dErr.message}`);
    if (!dispatched) {
      return {
        status: 409,
        body: {
          success: false,
          error: "not_dispatched",
          message: "這一筆不是派給你的。工作只從 GET /next 來：呼叫一次，伺服器會給你一筆要驗的，做完再用 POST /report 回報那一筆。不要自己挑題目。",
        },
      };
    }
  }

  const { data: existing, error: eError } = await supabase
    .from("contribution_votes").select("id, agent_name, verifier_ip_hash").eq("contribution_id", contribution.id);
  if (eError) throw new Error(`votes lookup: ${eError.message}`);
  if (isDuplicateVote(existing ?? [], { agent_name: input.agent_name, ip_hash: ipHash })) {
    return {
      status: 409,
      body: {
        success: false,
        error: "already_voted",
        // 2026-09-21：代理做完整套查證才吃到這個錯，而它不知道自己沒做錯——
        // 同一台機器上有別的代理在跑，在它回報前投掉了同一筆。講清楚，不然它會以為是自己的問題。
        message: "這筆已經投過票了（同一個來源 IP 只能投一次，換代號不會多一票）。如果你剛做完查證才看到這個，那是同一台機器上另一個代理在你查證期間投掉了它——**你的工不算白做，也不是你做錯**，請直接領下一筆。",
      },
    };
  }

  // 盲反對改記 unsure（2026-09-19）：備註是「打不開／確認不了」的 disagree 沒有反證，不能算反對
  const blind = input.verdict === "disagree" && isBlindDisagree(input.note, {
    evidenceUrl: input.evidence_url,
    sourceUrls: contribution.source_urls ?? [],
  });
  // 罐頭同意票退回重寫（2026-09-21）：agree 但備註只有套語、也沒附 evidence_url。
  //
  // 原本想比照盲反對改記 unsure，但實地查過之後理由變了：那 30 票寫著「查證通過」的，
  // 逐筆去核來源**內容其實是對的**（新北市議員登記名單那頁逐名比對得上）。
  // 所以問題不是「無據放行」，是「查了卻沒留下痕跡」——下游沒有任何辦法分辨
  // 真查過的票和沒查過的票（連提交者自己回頭看都分辨不出來，因此誤判過一次）。
  //
  // 既然多數是查過的，降級成 unsure 會永久吃掉一張有效的票（同一個 IP 不能重投），
  // 對誠實的代理是懲罰。退回 400 讓它把核對內容寫上再送一次才對：工不白做、痕跡留得下。
  // 第二層：跟自己上一票一字不差（2026-09-21）。事故裡代理自承 vote 5–33 完全沒開網頁，
  // 那 29 票的 note 全是同一句；而它真的查過的前 6 票，每一票的 note 都不一樣。
  // 訊號乾淨，而且不要求代理多做任何事——兩次查證本來就不會產生一模一樣的描述。
  if (input.verdict === "agree" && input.note) {
    const { data: prev } = await supabase.from("contribution_votes")
      .select("note").eq("verifier_ip_hash", ipHash)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (prev && isRepeatedNote(input.note, (prev as { note?: string }).note)) {
      return {
        status: 400,
        body: {
          success: false,
          error: "note_repeated",
          message: "這句備註跟你上一票一字不差。每一筆驗證核對的是不同的來源與欄位，描述不該一模一樣——" +
            "請寫這一筆你實際看到什麼（哪一頁、哪一段、哪幾個欄位對得上）。改好再送一次，這次不算你被拒。",
        },
      };
    }
  }
  if (input.verdict === "agree" && isRubberStampAgree(input.note, input.evidence_url)) {
    return {
      status: 400,
      body: {
        success: false,
        error: "note_too_thin",
        message: "同意票要說出你核對了什麼（哪一頁、哪一段、哪幾個欄位對得上），或附上你找到的第二來源 evidence_url。" +
          "只寫「驗證通過」這類套語的話，之後沒有人分得出這張票是查過還是沒查過——包括你自己。" +
          "把核對內容補上再送一次，這次不算你被拒。",
      },
    };
  }
  const finalVerdict = blind ? "unsure" : input.verdict;
  const finalNote = blind ? `${BLIND_DISAGREE_NOTE}${input.note ?? ""}` : (input.note ?? null);

  // 票的來歷（審查建議 7）：evidence_url 曾由這台機器拿去 judge 判過 → 這張票的判斷者是 Jev，不是代理
  let judgeBacked = false;
  if (input.evidence_url) {
    try {
      const { data: judged } = await supabase.from("jev_decisions").select("state").eq("subject_type", "contribution").eq("subject_id", contribution.id)
        .eq("question", "second_source").eq("requester_ip_hash", ipHash).order("asked_at", { ascending: false }).limit(20);
      type Judged = { state?: { page?: { url?: string } } };
      judgeBacked = ((judged ?? []) as Judged[]).some((j: Judged) => (j.state?.page?.url ?? "") === input.evidence_url);
    } catch { /* 查不到就當不是 */ }
  }

  const { data: vote, error: insertError } = await supabase
    .from("contribution_votes")
    .insert({
      contribution_id: contribution.id,
      verdict: finalVerdict,
      evidence_url: input.evidence_url ?? null,
      judge_backed: judgeBacked,
      note: finalNote,
      agent_name: input.agent_name,
      agent_tool: input.agent_tool ?? null,
      verifier_ip_hash: ipHash,
      // 身份鍵，同 contributions.actor_id
      actor_id: actor.actor_id,
      resolved_politician_id: input.resolved_politician_id ?? null,
      // 從哪個端點進來的（2026-09-21）
      via,
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
