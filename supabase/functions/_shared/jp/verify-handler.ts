/**
 * 日本站 verify 的核心邏輯（POST jp-report{kind:"verify"}）。
 *
 * 複製自 ../verify-handler.ts 的 handleVerify／handleVerifyInner／verifyQuotaFor，結構與函式名照舊。
 * 保留的：派工憑證（含 revise 過期放行）、身份、不能驗自己、派發即綁定（verify_dispatches）、每個來源一票與 revise 改票、
 *   盲反對改記 unsure、備註三道守門（重複／抄襲／太薄）、每日額度（匿名 800、DiTrust 2400）、
 *   contribution_effective_agree RPC（系統票折進去的有效門檻）、回應格式。
 * 拿掉的：中選會筆數核對（cec-count）、gate_rejections 寫入、legacyIpHash 過渡、裁決（adjudication）型別的利益迴避、
 *   resolved_politician_id、agentToolNotice 之外的正見專屬提示。
 * 落庫：本 PR 不套用已通過的貢獻。applyFn 預設不給＝不落庫，狀態停在 verified（要接落庫時傳入 applyFn，
 *   只有在票數讓狀態變 verified 時才呼叫，失敗不影響投票成功）。【待定】日本站的落庫另開 PR。
 */

import { ENCODING_INVALID_MESSAGE, validateVerifyRequest } from "./contribution-schema.ts";
import { type Actor } from "../actor.ts";
import { resolveIdentity, type HandlerResult } from "./contribute-handler.ts";
import { BLIND_DISAGREE_NOTE, isBlindDisagree, isCopiedNote, isDuplicateVote, isRepeatedNote, isRubberStampAgree, isSelfVote, rejectFloor, requiredAgree, sameSiteAsSubmitted, voteWeight, weightReason } from "./consensus.ts";
import { agentToolNotice } from "../agent-tool-hint.ts";
import { checkDispatchToken, dispatchTokenOf, invalidTokenResult, logDispatchBinding } from "../dispatch-token.ts";
import { VERIFY_BINDING_DAYS } from "../dispatch.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 落庫函式（本 PR 不提供實作；給了才會在狀態變 verified 時呼叫） */
export type JpApplyFn = (supabase: SupabaseLike, contributionId: string) => Promise<{ status?: string; message?: string }>;

/** 每個來源網段每日最多驗幾筆（同正見） */
export const VERIFY_DAILY_LIMIT_PER_IP = 800;
export const VERIFY_DAILY_LIMIT_PER_DITRUST = 2400;

export function verifyQuotaFor(actor: Actor, ipHash: string): { limit: number; column: "actor_id" | "verifier_ip_hash"; value: string; scope: string } {
  return actor.level === "ditrust"
    ? { limit: VERIFY_DAILY_LIMIT_PER_DITRUST, column: "actor_id", value: actor.actor_id, scope: "每個 DiTrust 帳號" }
    : { limit: VERIFY_DAILY_LIMIT_PER_IP, column: "verifier_ip_hash", value: ipHash, scope: "每個來源網段（IPv4 /24、IPv6 /64）" };
}

export async function handleVerify(supabase: SupabaseLike, body: unknown, reportIpHash: string, applyFn?: JpApplyFn, via = "verify", dispatchSecret?: string): Promise<HandlerResult> {
  // 派工憑證：帶了就只驗憑證、不看 IP；無效回 403。通過時這一票的來源是領任務時的網段（一張憑證只換一張票）。
  let ipHash = reportIpHash;
  let tokenBinding: { tokenId: string; issuedNet: string; agent: string } | null = null;
  // 改票（revise:true）遇到過期憑證：簽章與 task 照驗，放過期限，但要求同一個來源已經有這筆的票
  let expiredRevise = false;
  const tokenField = via === "merge" ? { present: false as const } : dispatchTokenOf(body);
  if (tokenField.present) {
    const rawId = isObj(body) ? (body as Record<string, unknown>).contribution_id : undefined;
    const expectedTask = `verify:${typeof rawId === "string" ? rawId : ""}`;
    let chk = await checkDispatchToken(dispatchSecret, tokenField.value, expectedTask);
    if (!chk.ok && chk.reason === "expired" && isObj(body) && (body as Record<string, unknown>).revise === true) {
      const again = await checkDispatchToken(dispatchSecret, tokenField.value, expectedTask, Date.now(), { ignoreExpiry: true });
      chk = again;
      expiredRevise = again.ok;
    }
    if (!chk.ok) return invalidTokenResult(chk.reason);
    ipHash = chk.payload.h;
    tokenBinding = { tokenId: chk.tokenId, issuedNet: chk.payload.h, agent: chk.payload.a };
  }
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
  // 投錯了要改：同一筆再送一次帶 revise:true，就覆寫自己那一個來源的票，計分不變一票
  const revise = isObj(body) && (body as Record<string, unknown>).revise === true;

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const vq = verifyQuotaFor(actor, ipHash);
  const { count: used, error: countError } = await supabase
    .from("contribution_votes").select("id", { count: "exact", head: true })
    .eq(vq.column, vq.value).gte("created_at", todayStart.toISOString());
  if (countError) throw new Error(`rate limit lookup: ${countError.message}`);
  if ((used ?? 0) >= vq.limit) {
    return { status: 429, body: { success: false, error: "rate_limited", message: `${vq.scope}每日最多驗 ${vq.limit} 筆` } };
  }

  const { data: contribution, error: cError } = await supabase
    .from("contributions")
    .select("id, status, contribution_type, payload, source_urls, agent_name, contributor_ip_hash, agree_count, disagree_count, unsure_count, score")
    .eq("id", input.contribution_id)
    .maybeSingle();
  if (cError) throw new Error(`contributions lookup: ${cError.message}`);
  if (!contribution) return { status: 404, body: { success: false, error: "not_found", message: "沒有這筆貢獻" } };
  if (!["pending", "verified", "disputed"].includes(contribution.status)) {
    return { status: 409, body: { success: false, error: "closed", message: `這筆已是 ${contribution.status}，不再收驗證` } };
  }
  // 憑證路徑：領任務的網段與交件當下的網段，哪一個是提交者的都算自己
  const isReportNet = (stored: string | null | undefined) => tokenBinding !== null && !!stored && stored === reportIpHash;
  if (isSelfVote(contribution, { agent_name: input.agent_name, ip_hash: ipHash }) || isReportNet(contribution.contributor_ip_hash)) {
    return { status: 403, body: { success: false, error: "self_vote", message: "不能驗證自己（同 agent_name 或同一來源網段）提交的貢獻，請跳過這筆" } };
  }

  // 派發即綁定：只收「/next 派給你的那一筆」（via merge 例外：重複提交被系統配對成同意票）
  if (tokenBinding) {
    logDispatchBinding({
      event: "dispatch_binding", endpoint: `jp:${via}`, binding: expiredRevise ? "token_expired_revise" : "token", task_id: `verify:${contribution.id}`,
      agent_name: input.agent_name, token_id: tokenBinding.tokenId, issued_net: tokenBinding.issuedNet, report_net: reportIpHash,
    });
  } else if (via !== "merge") {
    // 只認派出後 VERIFY_BINDING_DAYS 天內的紀錄（派工紀錄會定時清掉更舊的，#485；時限明寫，清理前後結果才一樣）
    const bindingSince = new Date(Date.now() - VERIFY_BINDING_DAYS * 86_400_000).toISOString();
    const { data: dispatched, error: dErr } = await supabase.from("verify_dispatches")
      .select("contribution_id").eq("contribution_id", contribution.id).eq("ip_hash", ipHash).gte("dispatched_at", bindingSince).maybeSingle();
    if (dErr) throw new Error(`verify dispatch lookup: ${dErr.message}`);
    if (!dispatched) {
      return {
        status: 409,
        body: {
          success: false,
          error: "not_dispatched",
          message: "這一筆不是派給你的。工作只從 GET jp-next 來：呼叫一次，伺服器會給你一筆要驗的，做完再用 POST jp-report 回報那一筆。不要自己挑題目。如果你的領取與回報會從不同網段出去（雲端環境常見），回報時帶上 jp-next 給的 dispatch_token 就不看 IP。",
        },
      };
    }
    logDispatchBinding({
      event: "dispatch_binding", endpoint: `jp:${via}`, binding: "ip", task_id: `verify:${contribution.id}`,
      agent_name: input.agent_name, report_net: ipHash,
    });
  }

  const { data: existing, error: eError } = await supabase
    .from("contribution_votes").select("id, agent_name, verifier_ip_hash, note").eq("contribution_id", contribution.id);
  if (eError) throw new Error(`votes lookup: ${eError.message}`);
  let revising: { id: string } | null = null;
  if (expiredRevise) {
    const own = ((existing ?? []) as Array<{ verifier_ip_hash: string | null }>)
      .find((x) => !!x.verifier_ip_hash && (x.verifier_ip_hash === ipHash || x.verifier_ip_hash === reportIpHash));
    if (!own) return invalidTokenResult("expired");
    ipHash = own.verifier_ip_hash as string;
  }
  if (isDuplicateVote(existing ?? [], { agent_name: input.agent_name, ip_hash: ipHash })) {
    const mine = ((existing ?? []) as Array<{ id: string; agent_name: string; verifier_ip_hash: string | null }>)
      .find((x) => x.verifier_ip_hash ? x.verifier_ip_hash === ipHash : x.agent_name.toLowerCase() === input.agent_name.toLowerCase());
    if (!revise || !mine) {
      return {
        status: 409,
        body: {
          success: false,
          error: "already_voted",
          message: "這筆已經投過票了（同一個來源網段只能投一次，換代號不會多一票）。如果你剛做完查證才看到這個，那是同一台機器上另一個代理在你查證期間投掉了它——**你的工不算白做，也不是你做錯**，請直接領下一筆。**如果是你自己投錯了要改**：同一筆再送一次並帶 `revise: true`，會覆寫你那張票。",
        },
      };
    }
    revising = { id: mine.id };
  }

  // 盲反對改記 unsure：備註是「打不開／確認不了」的 disagree 沒有反證，不能算反對
  const blind = input.verdict === "disagree" && isBlindDisagree(input.note, {
    evidenceUrl: input.evidence_url,
    sourceUrls: contribution.source_urls ?? [],
  });
  // 罐頭同意票退回重寫：跟自己上一票一字不差
  if (input.verdict === "agree" && input.note && !revising) {
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
  // 防從眾：沒引文、沒來源、又跟既有票一字不差 → 退回補寫
  if (!revising && input.verdict === "agree" && !input.evidence_url && input.note && isCopiedNote(input.note, ((existing ?? []) as Array<{ note?: string | null }>).map((x) => x.note))) {
    return {
      status: 400,
      body: {
        success: false,
        error: "note_copied",
        message: "這句備註跟這筆既有的一張票一字不差，而且沒有你自己的引文或 evidence_url。看得到別人的理由是為了讓你針對爭點查，不是抄——" +
          "請寫你這次實際核對到什麼（哪一頁、哪一列、哪個欄位），或附你自己找到的來源。改好再送一次，這次不算你被拒。",
      },
    };
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

  // +2／−2 由系統自己核 evidence_url 後翻 judge_backed，代理端的票先是 ±1
  const judgeBacked = false;

  const voteRow = {
    contribution_id: contribution.id,
    verdict: finalVerdict,
    evidence_url: input.evidence_url ?? null,
    judge_backed: judgeBacked,
    evidence_checked_at: null,
    evidence_verdict: null,
    note: finalNote,
    agent_name: input.agent_name,
    agent_tool: input.agent_tool ?? null,
    verifier_ip_hash: ipHash,
    actor_id: actor.actor_id,
    via: revising ? `${via}:revise` : via,
  };
  const { data: vote, error: insertError } = revising
    ? await supabase.from("contribution_votes").update(voteRow).eq("id", revising.id).select("id").maybeSingle()
    : await supabase.from("contribution_votes").insert(voteRow).select("id").maybeSingle();
  if (insertError) {
    if (/unique|duplicate/i.test(insertError.message)) return { status: 409, body: { success: false, error: "already_voted", message: "這個來源已對這筆投過票" } };
    throw new Error(`votes insert: ${insertError.message}`);
  }

  const { data: after, error: aError } = await supabase
    .from("contributions").select("status, agree_count, disagree_count, unsure_count, score").eq("id", contribution.id).maybeSingle();
  if (aError) throw new Error(`contributions reread: ${aError.message}`);
  // 回給代理的「還要幾票」用有效門檻（系統票折進去），拿不到就退回原門檻
  let effectiveRequired: number | null = null;
  try {
    const { data: eff } = await supabase.rpc("contribution_effective_agree", { p_contribution_id: contribution.id });
    if (typeof eff === "number") effectiveRequired = eff;
  } catch { /* 沒這支函式：退回原門檻 */ }

  // 落庫（本 PR 沒有實作，applyFn 沒給就停在 verified）；失敗不影響投票成功
  let autoApply: { triggered: boolean; status?: string; message?: string } = { triggered: false };
  if (applyFn && after?.status === "verified") {
    try {
      const out = await applyFn(supabase, contribution.id);
      autoApply = { triggered: true, status: out.status, message: out.message };
    } catch (e) {
      autoApply = { triggered: true, message: e instanceof Error ? e.message : String(e) };
    }
  }
  const finalStatus = autoApply.triggered && autoApply.status ? autoApply.status : (after?.status ?? contribution.status);
  const weight = voteWeight(finalVerdict, judgeBacked);
  const targetScore = effectiveRequired ?? requiredAgree(contribution.contribution_type, contribution.payload, contribution.source_urls ?? []);
  const scoreBefore = (contribution as { score?: number | null }).score ?? 0;
  const scoreAfter = (after as { score?: number | null } | null)?.score ?? scoreBefore + weight;
  const toolNotice = agentToolNotice(input.agent_tool);

  return {
    status: 201,
    body: {
      success: true,
      vote_id: vote?.id ?? revising?.id,
      contribution_id: contribution.id,
      verdict: finalVerdict,
      ...(revising ? { revised: true, note_revise: "已覆寫你原本那張票；分數依新的 verdict 重算，仍只算一票" } : {}),
      ...(blind ? { downgraded_from: "disagree", downgrade_reason: "備註是「無法開啟／確認不了」：那是 unsure，不是反對。反對票要寫出哪一欄與來源矛盾、或附反證網址；來源打不開請投 unsure 並列出試過的網址" } : {}),
      weight,
      weight_reason: weightReason(finalVerdict, judgeBacked, Boolean(input.evidence_url)),
      ...(sameSiteAsSubmitted(input.evidence_url, contribution.source_urls ?? [])
        ? { evidence_warning: "evidence_url 跟提交者附的來源是同一個網站，不算第二來源，這票會維持 ±1。要 ±2 請換一個不同網域、直接寫到這件事的來源，可以帶 revise:true 重送覆寫這票" }
        : {}),
      score: { before: scoreBefore, after: scoreAfter, target: targetScore },
      agree_count: after?.agree_count ?? 0,
      disagree_count: after?.disagree_count ?? 0,
      unsure_count: after?.unsure_count ?? 0,
      status: finalStatus,
      required_agree: targetScore,
      ...(autoApply.triggered ? { auto_apply: { status: autoApply.status, message: autoApply.message } } : {}),
      ...(finalStatus === "rejected" && contribution.status !== "rejected" ? { note: `分數 ${scoreAfter} 已跌到退件門檻（−${rejectFloor(contribution.contribution_type)}），這筆已退件並清出驗證池` } : {}),
      ...(toolNotice ? { notice: toolNotice } : {}),
    },
  };
}
