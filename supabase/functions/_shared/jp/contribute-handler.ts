/**
 * 日本站 contribute 的核心邏輯（POST jp-report{kind:"contribute"}）。
 *
 * 複製自 ../contribute-handler.ts 的 handleContribute／submitQuotaFor／ipHashOf／resolveIdentity，結構與函式名照舊。
 * 保留的：派工憑證（task 比對、來源記領任務的網段）、身份（ditrust:<序號> 換代號）、schema 驗證、
 *   每日額度（匿名按來源網段 200、DiTrust 按帳號 600，UTC 零時重置）、24 小時內相同內容去重、
 *   重複宣稱併成同意票（duplicate-claim.ts 原封沿用）、同一台機器重複宣稱的提示、提交後釋放任務認領、回應格式。
 * 落庫：重複提交併成的同意票若讓那一筆變 verified，由這一票呼叫 applyFn 落庫（沒給 applyFn 就交給排程）。
 * 日本站加的：local_government 交件當下跟總務省的團體碼表核對（machine-verify.ts，照正見 cec-verify）。
 * 拿掉的：中選會名冊大批次（rosterBatchProblems）、單一答案型任務擋重複（single-answer-guard，任務型別是正見的）、
 *   公民提問檢查、搜尋結果頁／政見唯一出處／同名人物／議員選舉區／參選紀錄登記證據等守門（全是正見資料專屬）、
 *   「查無」要 5 個網址的守門（not-found-guard，綁正見的任務型別）與 agent_tool 查無比例、空操作更正檢查（要讀日本站目標列，待定）、
 *   no_change＋unreachable 當場試抓與直接記錄（要落庫，本 PR 不做；日本站的 unreachable 照常進投票）、
 *   落庫前置檢查（precheckApplyTargets）、政見口號提示、得票數提示、gate_rejections 寫入（日本站不一定有這張表）、
 *   出處等級 source_details、legacyIpHash（日本站沒有 1.79.0 以前的資料）。
 * 時區：正見這支只有登記截止日用 +8（已拿掉）；額度重置本來就是 UTC，日本站照舊，沒有要改的時區。
 */

import { canonicalPayload, ENCODING_INVALID_MESSAGE, sha256Hex, validateContributionRequest } from "./contribution-schema.ts";
import { networkOf } from "../ip-network.ts";
import { chunksOf } from "../in-chunks.ts";
import { type Actor, resolveActor, resolveActorFromRequest } from "../actor.ts";
import { requiredAgree } from "./consensus.ts";
import { JP_PROTOCOL_URL } from "./protocol.ts";
import { claimKey, claimTarget, type ExistingClaim, findMergeTarget, findSameMachineClaim } from "../duplicate-claim.ts";
import { agentToolNotice } from "../agent-tool-hint.ts";
import { checkDispatchToken, dispatchTokenOf, invalidTokenResult, logDispatchBinding } from "../dispatch-token.ts";
import { handleVerify, type JpApplyFn } from "./verify-handler.ts";
import { machineVerifyInline } from "./machine-verify.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/** 每個來源網段每日最多提交幾筆（同正見 CONTRIBUTE_DAILY_LIMIT_PER_IP） */
export const CONTRIBUTE_DAILY_LIMIT_PER_IP = 200;
/** DiTrust 帳號每日提交上限，按帳號算（同正見 CONTRIBUTE_DAILY_LIMIT_PER_DITRUST） */
export const CONTRIBUTE_DAILY_LIMIT_PER_DITRUST = 600;
export const DEDUPE_WINDOW_HOURS = 24;

/** 這個身份的提交額度按什麼算：DiTrust 帳號按 actor_id、匿名按來源網段。 */
export function submitQuotaFor(actor: Actor, ipHash: string): { limit: number; column: "actor_id" | "contributor_ip_hash"; value: string; scope: string } {
  return actor.level === "ditrust"
    ? { limit: CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, column: "actor_id", value: actor.actor_id, scope: "每個 DiTrust 帳號" }
    : { limit: CONTRIBUTE_DAILY_LIMIT_PER_IP, column: "contributor_ip_hash", value: ipHash, scope: "每個來源網段（IPv4 /24、IPv6 /64）" };
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

/** 來源身份的雜湊：看網段（IPv4 /24、IPv6 /64），同正見 ipHashOf（鹽也是同一個 CONTRIBUTION_IP_SALT；兩站資料表分開，雜湊相同不互通） */
export async function ipHashOf(req: Request, ipSalt: string): Promise<string> {
  return await sha256Hex(`${ipSalt}|${networkOf(clientIp(req))}`);
}

/** 投票端（預設 handleVerify；測試可換掉） */
export type VerifyFn = typeof handleVerify;

/** 撈「可能是同一個宣稱」的待驗證貢獻：依 (型別, 對象欄位) 分組，每組一次查詢 */
async function fetchClaimCandidates(
  supabase: SupabaseLike,
  items: ReadonlyArray<{ contribution_type: string; payload: unknown }>,
): Promise<ExistingClaim[]> {
  const groups = new Map<string, { type: string; field: string; values: Set<string> }>();
  for (const item of items) {
    const target = claimTarget(item.contribution_type, item.payload);
    if (!target || claimKey(item.contribution_type, item.payload) === null) continue;
    const gk = `${item.contribution_type}|${target.field}`;
    const g = groups.get(gk) ?? { type: item.contribution_type, field: target.field, values: new Set<string>() };
    g.values.add(target.value);
    groups.set(gk, g);
  }
  if (groups.size === 0) return [];
  const rows = await Promise.all([...groups.values()].flatMap((g) => chunksOf([...g.values]).map(async (chunk) => {
    const { data, error } = await supabase.from("contributions")
      .select("id, contribution_type, payload, agent_name, contributor_ip_hash, status")
      .eq("contribution_type", g.type).eq("status", "pending")
      .in(`payload->>${g.field}`, chunk)
      .order("created_at", { ascending: true }).limit(200);
    if (error) throw new Error(`claim candidates (${g.type}): ${error.message}`);
    return (data ?? []) as ExistingClaim[];
  })));
  return rows.flat();
}

/** 合併時寫進票裡的理由——事後在查核履歷上看得出這票是怎麼來的 */
function mergeNote(agentName: string, sourceUrls: readonly string[], note: string | null | undefined): string {
  const head = `這票來自重複提交：${agentName} 獨立查證後提交了同一個宣稱，系統改記為對這一筆的同意票。`;
  const src = sourceUrls.length > 0 ? `對方的來源：${sourceUrls.join("、")}` : "";
  const own = note ? `對方備註：${note}` : "";
  return [head, src, own].filter(Boolean).join(" ").slice(0, 2000);
}

export async function handleContribute(
  supabase: SupabaseLike,
  _supabaseUrl: string,
  body: unknown,
  ipHashArg: string,
  verifyFn: VerifyFn = handleVerify,
  via = "contribute",
  // 派工憑證的簽章鑰匙；沒給就驗不了憑證，帶憑證的請求回 403
  dispatchSecret?: string,
  // 落庫函式：重複提交併成的同意票剛好讓那一筆變 verified 時，由這一票落庫（沒給＝交給排程 apply_verified_pending）
  applyFn?: JpApplyFn,
): Promise<HandlerResult> {
  // 派工憑證：帶了就驗憑證（簽章、期限、task 相符），無效回 403 invalid_dispatch_token，不默默當作沒帶。
  // 通過時，額度、併票、提交者網段都用領任務時的網段（憑證裡簽的），跟 jp-next 回報給代理的額度同一把尺。
  const reportIpHash = ipHashArg;
  let ipHash = ipHashArg;
  let tokenBinding: { tokenId: string; issuedNet: string; taskId: string; agent: string } | null = null;
  const tokenField = via === "merge" ? { present: false as const } : dispatchTokenOf(body);
  if (tokenField.present) {
    const chk = await checkDispatchToken(dispatchSecret, tokenField.value, null);
    if (!chk.ok) return invalidTokenResult(chk.reason);
    ipHash = chk.payload.h;
    tokenBinding = { tokenId: chk.tokenId, issuedNet: chk.payload.h, taskId: chk.payload.t, agent: chk.payload.a };
  }
  // 身份：agent_name 可能是 ditrust:<序號>，先換成代號與身份鍵，再做格式驗證（序號不能當代號收進去）
  const identity = await resolveIdentity(body, ipHash);
  if (!identity.ok) return { status: identity.status, body: { success: false, error: "identity_invalid", message: identity.error } };
  body = identity.body;
  const actor: Actor = identity.actor;
  const validation = validateContributionRequest(body);
  if (!validation.ok) {
    const encoding = validation.errors.some((e) => e.code === "encoding_invalid");
    const error = encoding ? "encoding_invalid" : "validation_failed";
    const message = encoding
      ? ENCODING_INVALID_MESSAGE
      : "有欄位不合格，整批未收；請依 errors 修正後重送（格式見 skill.md）";
    return { status: 400, body: { success: false, error, message, errors: validation.errors } };
  }
  // 憑證綁的是哪個任務，這批裡有 task_id 的每一筆都要是那一個；一筆也對不上＝拿錯憑證
  {
    const itemTaskIds = validation.items.map((it) => it.task_id);
    if (tokenBinding) {
      const wrong = itemTaskIds.some((id) => typeof id === "string" && id !== tokenBinding!.taskId);
      const matched = itemTaskIds.some((id) => id === tokenBinding!.taskId);
      if (wrong || !matched) return invalidTokenResult("task_mismatch");
    }
    const firstTask = itemTaskIds.find((id): id is string => typeof id === "string");
    if (firstTask) {
      logDispatchBinding({
        event: "dispatch_binding", endpoint: `jp:${via}`, binding: tokenBinding ? "token" : "none", task_id: firstTask,
        agent_name: validation.contributor.agent_name, token_id: tokenBinding?.tokenId ?? null,
        issued_net: tokenBinding?.issuedNet ?? null, report_net: reportIpHash,
      });
    }
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const sq = submitQuotaFor(actor, ipHash);
  const { count: usedToday, error: countError } = await supabase
    .from("contributions").select("id", { count: "exact", head: true })
    .eq(sq.column, sq.value).gte("created_at", todayStart.toISOString());
  if (countError) throw new Error(`rate limit lookup: ${countError.message}`);
  const used = usedToday ?? 0;
  if (used + validation.items.length > sq.limit) {
    return {
      status: 429,
      body: { success: false, error: "rate_limited", message: `${sq.scope}每日最多 ${sq.limit} 筆，今日已用 ${used}，這批 ${validation.items.length} 筆放不下`, retry_after: "tomorrow (UTC)" },
    };
  }

  const hashes = await Promise.all(validation.items.map((item) => sha256Hex(canonicalPayload(item))));
  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000).toISOString();
  type ExistingRow = { id: string; payload_hash: string; status: string };
  const existing: ExistingRow[] = [];
  for (let i = 0; i < hashes.length; i += 40) {
    const { data: part, error: dupError } = await supabase
      .from("contributions").select("id, payload_hash, status").in("payload_hash", hashes.slice(i, i + 40)).gte("created_at", since);
    if (dupError) throw new Error(`dedupe lookup: ${dupError.message}`);
    existing.push(...((part ?? []) as ExistingRow[]));
  }
  const existingByHash = new Map<string, ExistingRow>(existing.map((r) => [r.payload_hash, r]));

  // 重複提交＝同意票（說明見 ../contribute-handler.ts）：只對結構化型別生效，走 handleVerify 投票，投不成就照原路收下這筆
  const mergedByIndex = new Map<number, { existing_id: string; agree_count: number; status: string; required_agree: number; from_agent: string | null }>();
  /** 同對象的既有提交是同一台機器（同網段）交的：不能併成票，但要告訴它，不然它會一直重交 */
  const sameMachineDup = new Map<number, string>();
  const mergeCandidateIdx = validation.items
    .map((item, i) => ({ item, i }))
    .filter(({ item, i }) => !existingByHash.has(hashes[i]) && claimKey(item.contribution_type, item.payload) !== null);
  if (mergeCandidateIdx.length > 0) {
    const candidates = await fetchClaimCandidates(supabase, mergeCandidateIdx.map(({ item }) => item));
    const claimed = new Set<string>(); // 同一批裡兩筆指向同一個既有貢獻時，只投一票
    for (const { item, i } of mergeCandidateIdx) {
      const target = findMergeTarget(item, { agent_name: validation.contributor.agent_name, ip_hash: ipHash }, candidates);
      if (!target) {
        const sameMachine = findSameMachineClaim(item, { agent_name: validation.contributor.agent_name, ip_hash: ipHash }, candidates);
        if (sameMachine) sameMachineDup.set(i, sameMachine.id);
        continue;
      }
      if (claimed.has(target.id)) continue;
      const voted = await verifyFn(supabase, {
        contribution_id: target.id,
        verdict: "agree",
        agent_name: validation.contributor.agent_name,
        ...(validation.contributor.agent_tool ? { agent_tool: validation.contributor.agent_tool } : {}),
        note: mergeNote(validation.contributor.agent_name, item.source_urls, item.note),
        ...(item.source_urls[0] ? { evidence_url: item.source_urls[0] } : {}),
      // via "merge"：這一票是系統把重複提交配對成的，不是代理自己挑的題目——派發閘對它放行。
      }, ipHash, applyFn, "merge");
      if (voted.status !== 201) continue; // 投不成就照原路收下
      claimed.add(target.id);
      const b = voted.body as Record<string, unknown>;
      mergedByIndex.set(i, {
        existing_id: target.id,
        agree_count: typeof b.agree_count === "number" ? b.agree_count : 0,
        status: typeof b.status === "string" ? b.status : "pending",
        required_agree: typeof b.required_agree === "number" ? b.required_agree : 0,
        from_agent: target.agent_name,
      });
    }
  }

  // 同一批裡內容完全相同（雜湊相同）的只寫第一筆
  const seenInBatch = new Set<string>();
  const dupInBatch = new Set<number>();
  hashes.forEach((h, i) => {
    if (existingByHash.has(h) || mergedByIndex.has(i)) return;
    if (seenInBatch.has(h)) dupInBatch.add(i); else seenInBatch.add(h);
  });
  const toInsert = validation.items
    .map((item, i) => ({ item, hash: hashes[i], i }))
    .filter(({ hash, i }) => !existingByHash.has(hash) && !mergedByIndex.has(i) && !dupInBatch.has(i))
    .map(({ item, hash }) => ({
      contribution_type: item.contribution_type,
      payload: item.payload,
      source_urls: item.source_urls,
      note: item.note ?? null,
      task_id: item.task_id ?? null,
      agent_name: validation.contributor.agent_name,
      agent_tool: validation.contributor.agent_tool ?? null,
      contributor_url: validation.contributor.url ?? null,
      contributor_ip_hash: ipHash,
      // 身份鍵：去重與歸戶看這個，agent_name 只給人看
      actor_id: actor.actor_id,
      payload_hash: hash,
      via,
    }));

  let inserted: Array<{ id: string; payload_hash: string }> = [];
  if (toInsert.length > 0) {
    const { data, error } = await supabase.from("contributions").insert(toInsert).select("id, payload_hash");
    if (error) throw new Error(`contributions insert: ${error.message}`);
    inserted = data ?? [];
  }
  const insertedByHash = new Map(inserted.map((r) => [r.payload_hash, r.id]));
  // 有官方表可比的型別（local_government）交件當下就核對一次：對得上直接落庫、不計額度（排程也會掃，這裡失敗不影響交件）
  const typeByHash = new Map(toInsert.map((r) => [r.payload_hash, r.contribution_type]));
  const machineVerify = await machineVerifyInline(supabase, inserted.map((r) => ({ id: r.id, contribution_type: typeByHash.get(r.payload_hash) ?? "" })));

  // 提交後釋放該任務的軟認領（別人可以接手同一目標）
  const taskIds = [...new Set(validation.items.map((it) => it.task_id).filter((t): t is string => typeof t === "string"))];
  if (taskIds.length > 0) {
    for (const chunk of chunksOf(taskIds)) {
      const { error: leaseError } = await supabase.from("contribution_task_leases").delete().in("task_id", chunk);
      if (leaseError) console.error("lease release failed:", leaseError.message);
    }
  }

  const results = validation.items.map((item, i) => {
    const merged = mergedByIndex.get(i);
    if (merged) {
      return {
        index: i,
        contribution_type: item.contribution_type,
        contribution_id: merged.existing_id,
        status: "counted_as_vote",
        agree_count: merged.agree_count,
        required_agree: merged.required_agree,
        message: `${merged.from_agent ?? "另一個代理"} 已經交過同一個宣稱，你這筆改記為對那一筆的同意票（目前同意 ${merged.agree_count}／${merged.required_agree}${merged.status === "applied" ? "，已上線" : ""}）。`,
      };
    }
    const hash = hashes[i];
    const dup = existingByHash.get(hash);
    const id = dup ? dup.id : insertedByHash.get(hash)!;
    const need = requiredAgree(item.contribution_type, item.payload, item.source_urls);
    return {
      index: i,
      contribution_type: item.contribution_type,
      contribution_id: id,
      status: dup || dupInBatch.has(i) ? "duplicate" : "pending",
      required_agree: need,
      ...(dup ? { existing_status: dup.status, message: `${DEDUPE_WINDOW_HOURS} 小時內已有相同內容的貢獻，沿用原 id` } : {}),
      ...(!dup && dupInBatch.has(i) ? { existing_status: "pending", message: "這一批裡有內容完全相同的一筆，只收第一筆，沿用它的 id" } : {}),
      ...(sameMachineDup.has(i) ? { note: `同一台機器（同來源網段）已經交過同對象的同一件事（${sameMachineDup.get(i)}），你這筆**不會**算成對它的同意票——一台機器只有一票。之後同對象的別再交，去驗別人的。` } : {}),
    };
  });

  const needs = [...new Set(results.map((r) => ("required_agree" in r ? r.required_agree : null)).filter((n): n is number => typeof n === "number"))].sort((a, b) => a - b);
  const single = !Array.isArray((body as Record<string, unknown>).contributions);
  const toolNotice = agentToolNotice(validation.contributor.agent_tool);
  const trailingVoteNote = needs.length > 0
    ? `；通過 ${needs.join("／")} 票同儕驗證（required_agree=${needs.join("／")}）後標為 verified 並自動落庫（task_suggestion、correction 這兩種停在 verified）`
    : "";
  return {
    status: 201,
    body: {
      success: true,
      message: [
        `已收到 ${inserted.length} 筆新貢獻`,
        mergedByIndex.size > 0 ? `${mergedByIndex.size} 筆與別人交過的是同一件事，改記為對那幾筆的同意票` : "",
        results.length - inserted.length - mergedByIndex.size > 0 ? `${results.length - inserted.length - mergedByIndex.size} 筆重複` : "",
      ].filter(Boolean).join("；") + trailingVoteNote,
      agent_name: validation.contributor.agent_name,
      ...(single ? results[0] : { results }),
      daily_quota: { limit: sq.limit, used: used + inserted.length },
      ...(machineVerify ? { machine_verify: { ...machineVerify, by: "總務省「全国地方公共団体コード」との自動照合（一致＝確定して反映、不一致＝差し戻し、判断できないもの＝同儕の検証待ち）" } } : {}),
      ...(toolNotice ? { notice: toolNotice } : {}),
      docs: JP_PROTOCOL_URL,
    },
  };
}

/** 把 body.agent_name 從 ditrust:<序號> 換成代號；回新的 body 與身份。一般代號原樣通過（同正見 resolveIdentity） */
export async function resolveIdentity(body: unknown, ipHash: string): Promise<
  { ok: true; body: unknown; actor: Actor } | { ok: false; status: number; error: string }
> {
  const raw = (body && typeof body === "object") ? body as Record<string, unknown> : null;
  const name = raw && typeof raw.agent_name === "string" ? raw.agent_name : "";
  const outcome = await resolveActorFromRequest(name, ipHash);
  if (!outcome.ok) return outcome;
  const next = raw && outcome.actor.level !== "ip" ? { ...raw, agent_name: outcome.actor.handle } : body;
  return { ok: true, body: next, actor: outcome.actor };
}

export { resolveActor };
