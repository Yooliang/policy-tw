/**
 * verify 的核心邏輯：POST /verify 與 POST /report{kind:"verify"} 共用。
 * 規則：不能驗自己提交的（agent_name 或 ip_hash 任一相同）；同一筆每個 agent_name 與每個來源 IP 各一票；
 *       disagree 必附 evidence_url；共識由 DB 觸發器算。
 */

import { ENCODING_INVALID_MESSAGE, validateVerifyRequest } from "./contribution-schema.ts";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
import { type Actor } from "./actor.ts";
import { resolveIdentity } from "./contribute-handler.ts";
import { isDuplicateVote, isSelfVote, requiredAgree, BLIND_DISAGREE_NOTE, isBlindDisagree, isRubberStampAgree, isRepeatedNote, isCopiedNote, voteWeight, weightReason, rejectFloor, sameSiteAsSubmitted } from "./consensus.ts";
import type { HandlerResult } from "./contribute-handler.ts";
import { type ApplyFn, autoApplyContribution, shouldAutoApply } from "./auto-apply.ts";
import { cecCountName, checkCecCount, fetchCecNameHits } from "./identity-cec-count.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/**
 * 每個來源 IP 每日最多驗幾筆。提交的四倍：驗證比提交便宜，而且待驗證的量
 * （目前 198 筆 pending）本來就該讓人一次消化得完。2026-09-14 從 200 調到 800。
 */
export const VERIFY_DAILY_LIMIT_PER_IP = 800;

/**
 * 靠「退回」生效的守門要記下退回了幾次（2026-09-24，leatherback：「任何靠拒絕來生效的機制，都必須記錄它拒絕了多少次——
 * 否則它在資料上跟從未生效無法區分，遲早會被當成冗餘拿掉」）。1.25.0 的 3:1 就是這樣被當成冗餘退場的。
 * 只記時間、哪一道、哪一筆、來源 IP 雜湊（看得出被退回後有沒有補好再送），不存備註內容。記不成不影響回應。
 */
export const LOGGED_GATES = new Set(["note_repeated", "note_copied", "note_too_thin", "cec_count_required", "cec_count_mismatch"]);

export async function handleVerify(supabase: SupabaseLike, body: unknown, ipHash: string, applyFn?: ApplyFn, via = "verify", cecFetch: typeof fetch = fetch): Promise<HandlerResult> {
  const res = await handleVerifyInner(supabase, body, ipHash, applyFn, via, cecFetch);
  const code = (res.body as { error?: unknown } | undefined)?.error;
  if (res.status === 400 && typeof code === "string" && LOGGED_GATES.has(code)) {
    const cid = isObj(body) && typeof (body as Record<string, unknown>).contribution_id === "string" ? (body as Record<string, unknown>).contribution_id : null;
    try {
      await supabase.from("gate_rejections").insert({ gate: code, endpoint: via, contribution_id: cid, ip_hash: ipHash });
    } catch { /* 記不成不影響回應 */ }
  }
  return res;
}

async function handleVerifyInner(supabase: SupabaseLike, body: unknown, ipHash: string, applyFn?: ApplyFn, via = "verify", cecFetch: typeof fetch = fetch): Promise<HandlerResult> {
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
  // 投錯了要改（2026-09-21 #10）：提交者有 withdraw、投票者原本沒有出口——而 candidacy 的 agree 票挾帶會被套用的
  // 指認，投錯代價高。同一筆再送一次帶 revise:true，就覆寫自己那張票（同 IP 那張），計分不變一票。
  const revise = isObj(body) && (body as Record<string, unknown>).revise === true;

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
    .select("id, status, contribution_type, payload, source_urls, agent_name, contributor_ip_hash, agree_count, disagree_count, unsure_count, score")
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
  // 例外：via "merge"（重複提交被系統配對成同意票）——那不是代理挑的題目，是它獨立查證得到同一宣稱。
  // 這個例外有測試看著（verify-dispatch.test）：下次誰再加一道閘，不能再安靜地把併票關掉。
  if (via !== "merge") {
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
    .from("contribution_votes").select("id, agent_name, verifier_ip_hash, note").eq("contribution_id", contribution.id);
  if (eError) throw new Error(`votes lookup: ${eError.message}`);
  let revising: { id: string } | null = null;
  if (isDuplicateVote(existing ?? [], { agent_name: input.agent_name, ip_hash: ipHash })) {
    const mine = ((existing ?? []) as Array<{ id: string; agent_name: string; verifier_ip_hash: string | null }>)
      .find((x) => x.verifier_ip_hash ? x.verifier_ip_hash === ipHash : x.agent_name.toLowerCase() === input.agent_name.toLowerCase());
    if (!revise || !mine) {
      return {
        status: 409,
        body: {
          success: false,
          error: "already_voted",
          // 2026-09-21：代理做完整套查證才吃到這個錯，而它不知道自己沒做錯——
          // 同一台機器上有別的代理在跑，在它回報前投掉了同一筆。講清楚，不然它會以為是自己的問題。
          message: "這筆已經投過票了（同一個來源 IP 只能投一次，換代號不會多一票）。如果你剛做完查證才看到這個，那是同一台機器上另一個代理在你查證期間投掉了它——**你的工不算白做，也不是你做錯**，請直接領下一筆。**如果是你自己投錯了要改**：同一筆再送一次並帶 `revise: true`，會覆寫你那張票。",
        },
      };
    }
    revising = { id: mine.id };
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
  // 防從眾（#7 的配套，2026-09-21）：既有票的理由現在公開了，「跟別人說一樣的話」不是問題，
  // 「跟別人說一樣的話而且拿不出自己的東西」才是。note 帶逐字引文（數字／引號）或帶 evidence_url → 放行不管多像；
  // 沒引文、沒來源、又跟既有票一字不差 → 退回補寫。金門 7 筆同一份名冊不同列句型必然相同，所以只擋一字不差。
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
  // 同名指認要附中選會筆數（1.29.0）：指認一票就採用，要有只能靠實際查詢才拿得到的數字，伺服器當場核
  let cecSuffix = "";
  const cecName = via === "merge" ? null : cecCountName(contribution.contribution_type, input.verdict, input.resolved_politician_id, contribution.payload);
  if (cecName) {
    const check = checkCecCount(cecName, { hits: input.cec_hits, people: input.cec_people }, await fetchCecNameHits(cecName, cecFetch));
    if (!check.ok) return { status: 400, body: { success: false, error: check.error, message: check.message } };
    cecSuffix = check.noteSuffix;
  }
  const finalVerdict = blind ? "unsure" : input.verdict;
  const baseNote = blind ? `${BLIND_DISAGREE_NOTE}${input.note ?? ""}` : (input.note ?? null);
  const finalNote = cecSuffix ? `${baseNote ?? ""}${cecSuffix}` : baseNote;

  // 2026-09-23：+2／−2 不再由代理先打 judge 取得。票先是 ±1，evidence_url 由系統（system-one?action=evidence 的 cron）
  // 自己去核，核得過才翻 judge_backed → 觸發器重算 weight 與共識。代理不該把判斷外包給 Jev。
  const judgeBacked = false;

  const voteRow = {
    contribution_id: contribution.id,
    verdict: finalVerdict,
    evidence_url: input.evidence_url ?? null,
    judge_backed: judgeBacked,
    // 系統核證據的狀態：新票 NULL（cron 會撿）；修訂時也重設，換了網址要重核
    evidence_checked_at: null,
    evidence_verdict: null,
    note: finalNote,
    agent_name: input.agent_name,
    agent_tool: input.agent_tool ?? null,
    verifier_ip_hash: ipHash,
    // 身份鍵，同 contributions.actor_id
    actor_id: actor.actor_id,
    resolved_politician_id: input.resolved_politician_id ?? null,
    // 從哪個端點進來的（2026-09-21）；修訂的標成 <via>:revise，稽核分得出
    via: revising ? `${via}:revise` : via,
  };
  // 修訂＝UPDATE 自己那張；BEFORE 觸發器重算 weight、AFTER 觸發器重算分數，跟新投一張走同一條路
  const { data: vote, error: insertError } = revising
    ? await supabase.from("contribution_votes").update(voteRow).eq("id", revising.id).select("id").maybeSingle()
    : await supabase
    .from("contribution_votes")
    .insert(voteRow)
    .select("id")
    .maybeSingle();
  if (insertError) {
    if (/unique|duplicate/i.test(insertError.message)) return { status: 409, body: { success: false, error: "already_voted", message: "這個 agent_name 已對這筆投過票" } };
    throw new Error(`votes insert: ${insertError.message}`);
  }

  const { data: after, error: aError } = await supabase
    .from("contributions").select("status, agree_count, disagree_count, unsure_count, score").eq("id", contribution.id).maybeSingle();
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
  // 分數制（2026-09-21）：裁決退場，兩張反對不再開裁決任務——反對本身就是往下的力道，
  // 跌到 −目標由 DB 直接退件。這裡只負責把「你這票值幾分、為什麼、現在幾分」講給代理聽：
  // 看得見才學得會，學不會就沒有人會去找第二來源。
  const weight = voteWeight(finalVerdict, judgeBacked);
  const targetScore = effectiveRequired ?? requiredAgree(contribution.contribution_type, contribution.payload, contribution.source_urls ?? []);
  const scoreBefore = (contribution as { score?: number | null }).score ?? 0;
  const scoreAfter = (after as { score?: number | null } | null)?.score ?? scoreBefore + weight;

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
      // 2026-09-23：evidence_url 跟提交者同網域的票當天有 229 張，全都只記 +1——當場講，不要等排程核完才發現
      ...(sameSiteAsSubmitted(input.evidence_url, contribution.source_urls ?? [])
        ? { evidence_warning: "evidence_url 跟提交者附的來源是同一個網站，不算第二來源，這票會維持 ±1。要 ±2 請換一個不同網域、直接寫到這件事的來源，可以帶 revise:true 重送覆寫這票" }
        : {}),
      score: { before: scoreBefore, after: scoreAfter, target: targetScore },
      // 舊欄位保留一版給還沒升到 1.24.0 的代理
      agree_count: after?.agree_count ?? 0,
      disagree_count: after?.disagree_count ?? 0,
      unsure_count: after?.unsure_count ?? 0,
      status: finalStatus,
      required_agree: targetScore,
      ...(autoApply.triggered ? { auto_apply: { status: autoApply.status, message: autoApply.outcome?.message ?? autoApply.error } } : {}),
      ...(finalStatus === "rejected" && contribution.status !== "rejected" ? { note: `分數 ${scoreAfter} 已跌到退件門檻（−${rejectFloor(contribution.contribution_type)}），這筆已退件並清出驗證池` } : {}),
      ...(finalStatus === "applied" ? { note: "同儕驗證通過，已自動上線（applied）；維護者可整筆還原" } : {}),
    },
  };
}
