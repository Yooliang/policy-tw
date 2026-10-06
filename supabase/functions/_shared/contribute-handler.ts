/**
 * contribute 的核心邏輯：POST /contribute 與 POST /report{kind:"contribute"} 共用。
 * 只寫 contributions（待審佇列）；schema 驗證、來源網址格式、每 IP 每日限額、24 小時去重。
 */

import { canonicalPayload, ENCODING_INVALID_MESSAGE, sha256Hex, validateContributionRequest } from "./contribution-schema.ts";
import { type Actor, resolveActor, resolveActorFromRequest } from "./actor.ts";
import { requiredAgree } from "./consensus.ts";
import { blockedSingleAnswerIndexes, IN_FLIGHT_STATUSES } from "./single-answer-guard.ts";
import { checkNoOp, type NoOpCheck, normalizeCorrection } from "./correction.ts";
import { withTaskPolitician } from "./task-politician.ts";
import { CORRECTION_FIELDS } from "./contribution-schema.ts";
import { policyLikenessNotice } from "./policy-likeness.ts";
import { claimKey, claimTarget, type ExistingClaim, findMergeTarget, findSameMachineClaim } from "./duplicate-claim.ts";
import { handleVerify } from "./verify-handler.ts";
import { fetchSource, hasUsableText } from "./system-one.ts";
import { applyContribution, contributionStatusFor, type ApplyOutcome } from "./apply-contribution.ts";
import { precheckApplyTargets } from "./apply-precheck.ts";
import { normalizeCandidacyDistrictField } from "./electoral-district.ts";
import { checkElectoralDistrict } from "./district-registry.ts";
import { councilDistrictProblems } from "./council-district-guard.ts";
import { REGISTERED_STATUSES, REGISTRATION_DEADLINE, reasonNamesTarget, registrationEvidenceOk } from "./candidacy-guards.ts";
import { gatedNotFoundType, notFoundSearchMessage, notFoundSearchShortfall } from "./not-found-guard.ts";
import { agentToolVerdict, fetchNotFoundRates, NOT_FOUND_RATE_WINDOW_DAYS, seriesVerdictMessage, type SeriesVerdict } from "./not-found-series.ts";
import { agentToolNotice } from "./agent-tool-hint.ts";
import { soleSourceProblems } from "./sole-source-guard.ts";
import { SEARCH_PAGE_GATE, searchPageProblems, strippedNotice, stripSearchPages } from "./search-page-guard.ts";
import { voteFieldsNotice } from "./candidacy-result.ts";
import { detailsOfPayload, sourceLevelNotice } from "./source-write.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/**
 * 每個來源 IP 每日最多提交幾筆。
 * 2026-09-14：「初期改 200 筆」——現在瓶頸是沒人來貢獻，不是有人灌水，
 * 額度卡住的是自己人。等真的有外部代理進來、也真的出現濫用再往下收。
 */
export const CONTRIBUTE_DAILY_LIMIT_PER_IP = 200;
/**
 * DiTrust 帳號（agent_name=ditrust:<序號>）的每日提交上限，按帳號算、不按 IP（2026-10-02 維護者裁示）。
 * 藍圖 docs/BLUEPRINT-agent-identity.md §6：「帳號多拿的是額度（註冊誘因）與貢獻榜歸屬，不是票」——
 * 投票照舊每個來源 IP 一票，獨立核對的防護不變。匿名代理照舊每 IP 200。
 * 起因：雲端 VM 關機再開只會輪到同一小撮臨時 IP（10-03 凌晨三個 IP 輪流），撞到當天已交滿的 IP 那一輪就交不出東西。
 */
export const CONTRIBUTE_DAILY_LIMIT_PER_DITRUST = 600;

/** 這個身份的提交額度按什麼算：DiTrust 帳號按 actor_id、匿名按來源 IP。 */
export function submitQuotaFor(actor: Actor, ipHash: string): { limit: number; column: "actor_id" | "contributor_ip_hash"; value: string; scope: string } {
  return actor.level === "ditrust"
    ? { limit: CONTRIBUTE_DAILY_LIMIT_PER_DITRUST, column: "actor_id", value: actor.actor_id, scope: "每個 DiTrust 帳號" }
    : { limit: CONTRIBUTE_DAILY_LIMIT_PER_IP, column: "contributor_ip_hash", value: ipHash, scope: "每個來源 IP" };
}
export const DEDUPE_WINDOW_HOURS = 24;
const SITE_URL = "https://policy-tw.web.app";

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function ipHashOf(req: Request, ipSalt: string): Promise<string> {
  return await sha256Hex(`${ipSalt}|${clientIp(req)}`);
}

/** 撈這批任務的型別與同 IP 排隊中的貢獻，交給純函式判斷要擋哪幾筆 */
async function findBlockedSingleAnswers(supabase: SupabaseLike, items: ReadonlyArray<{ task_id?: string | null }>, ipHash: string): Promise<Set<number>> {
  const taskIds = [...new Set(items.map((it) => it.task_id).filter((t): t is string => typeof t === "string" && t.length > 0))];
  if (taskIds.length === 0) return new Set();
  const manualIds = taskIds.filter((t) => !t.startsWith("auto:") && UUID_RE.test(t));
  const [manualRes, inFlightRes] = await Promise.all([
    manualIds.length > 0
      ? supabase.from("contribution_tasks").select("id, task_type").in("id", manualIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("contributions").select("task_id").eq("contributor_ip_hash", ipHash)
      .in("task_id", taskIds).in("status", [...IN_FLIGHT_STATUSES]).limit(1000),
  ]);
  if (manualRes.error) throw new Error(`task types lookup: ${manualRes.error.message}`);
  if (inFlightRes.error) throw new Error(`in-flight lookup: ${inFlightRes.error.message}`);
  const manualTypes = new Map<string, string>(((manualRes.data ?? []) as Array<{ id: string; task_type: string }>).map((r) => [r.id, r.task_type]));
  const inFlight = new Set<string>(((inFlightRes.data ?? []) as Array<{ task_id: string }>).map((r) => r.task_id));
  return blockedSingleAnswerIndexes(items, manualTypes, inFlight);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- no_change＋unreachable：交件時伺服器當場試抓一次（2026-09-26 裁決） ----
//
// 「打不開」沒有資訊量，卻常常其實抓得到（原文 404 但 archive.org 有存檔、403 加 UA 就開）。
// 讓它跟其他宣稱一樣排隊等兩三票認可，等於叫另一個代理去驗證「我什麼都沒看到」——沒東西可驗。
// 抓得到就直接告訴代理去哪裡看（回 400，不算退件）；全部抓不到，這一次嘗試本身就是成果，
// 記下來就好，不必為了「沒有東西」再排隊等票（apply-contribution.ts 的 applyNoChange 早就這樣待 auto: 任務）。
export const UNREACHABLE_PRECHECK_URL_LIMIT = 3;
export const UNREACHABLE_PRECHECK_BUDGET_MS = 20_000;

export interface PrecheckAttempt {
  url: string;
  note: string;
}
export interface PrecheckResult {
  /** 抓到可用正文的第一個網址（含 archive.org 的存檔網址，因為那就是「系統實際看到內容」的地方）；全部抓不到就是 null */
  fetchedUrl: string | null;
  attempts: PrecheckAttempt[];
}

/**
 * 對代理回報 unreachable 的網址，伺服器自己也試一次。fetchSource（system-one.ts）已經帶瀏覽器 UA、
 * 4xx／5xx／逾時會自動回退到 web.archive.org，這裡不重新發明——「有沒有可用正文」一樣用它的既有門檻
 * （hasUsableText）。总时限抓 UNREACHABLE_PRECHECK_BUDGET_MS：時間到還沒有結果的網址算「來不及確認」，
 * 不能讓伺服器自己的試抓拖住代理的交件。
 */
export async function precheckUnreachable(urls: readonly string[], fetchImpl: typeof fetch = fetch): Promise<PrecheckResult> {
  const targets = urls.slice(0, UNREACHABLE_PRECHECK_URL_LIMIT);
  const attempts: PrecheckAttempt[] = [];
  if (targets.length === 0) return { fetchedUrl: null, attempts };

  const timedOut = Symbol("unreachable_precheck_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), UNREACHABLE_PRECHECK_BUDGET_MS);
  });
  const runs = Promise.allSettled(targets.map(async (url) => ({ url, result: await fetchSource(url, fetchImpl) })));

  const settled = await Promise.race([runs, budget]);
  if (timer) clearTimeout(timer);
  if (settled === timedOut) {
    for (const url of targets) attempts.push({ url, note: `逾時（伺服器 ${UNREACHABLE_PRECHECK_BUDGET_MS / 1000} 秒內沒試完）` });
    return { fetchedUrl: null, attempts };
  }

  let fetchedUrl: string | null = null;
  for (const s of settled) {
    if (s.status === "fulfilled") {
      const { url, result } = s.value;
      attempts.push({ url, note: result.note });
      // 名字比對交給代理自己判斷內容；伺服器這一關只問「有沒有可用正文」，門檻照抄 hasUsableText，不另外發明
      // 內容是從存檔回退拿到的（note 帶 archive:）→ 直接給代理存檔網址，不然它照原網址再開一次還是 404
      if (!fetchedUrl && result.kind === "html" && hasUsableText(result.text, [])) fetchedUrl = /archive:\d/.test(result.note ?? "") ? `https://web.archive.org/web/${url}` : url;
    } else {
      attempts.push({ url: "?", note: `試抓例外：${s.reason instanceof Error ? s.reason.message : String(s.reason)}` });
    }
  }
  return { fetchedUrl, attempts };
}

/** 投票端（預設 handleVerify；測試可換掉） */
export type VerifyFn = typeof handleVerify;

/**
 * 撈「可能是同一個宣稱」的待驗證貢獻。
 * 依 (型別, 對象欄位) 分組，每組一次查詢——不是每筆一次，也不是整張表拉回來。
 */
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
  const rows = await Promise.all([...groups.values()].map(async (g) => {
    const { data, error } = await supabase.from("contributions")
      .select("id, contribution_type, payload, agent_name, contributor_ip_hash, status")
      .eq("contribution_type", g.type).eq("status", "pending")
      .in(`payload->>${g.field}`, [...g.values])
      .order("created_at", { ascending: true }).limit(200);
    if (error) throw new Error(`claim candidates (${g.type}): ${error.message}`);
    return (data ?? []) as ExistingClaim[];
  }));
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
  supabaseUrl: string,
  body: unknown,
  ipHash: string,
  verifyFn: VerifyFn = handleVerify,
  via = "contribute",
  fetchImpl: typeof fetch = fetch,
  // 測試用：注入一個會丟例外的假試抓，驗證「試抓本身出錯」真的照舊收成 pending（不是沒東西可測的空話）
  precheckFn: typeof precheckUnreachable = precheckUnreachable,
): Promise<HandlerResult> {
  // 身份：agent_name 可能是 ditrust:<序號>，先換成代號與身份鍵，再做格式驗證（序號不能當代號收進去）
  const identity = await resolveIdentity(body, ipHash);
  if (!identity.ok) return { status: identity.status, body: { success: false, error: "identity_invalid", message: identity.error } };
  body = identity.body;
  const actor: Actor = identity.actor;
  const validation = validateContributionRequest(body);
  if (!validation.ok) {
    const encoding = validation.errors.some((e) => e.code === "encoding_invalid");
    const category = validation.errors.some((e) => e.code === "category_invalid");
    const error = encoding ? "encoding_invalid" : category ? "category_invalid" : "validation_failed";
    const message = encoding
      ? ENCODING_INVALID_MESSAGE
      : category
      ? validation.errors.find((e) => e.code === "category_invalid")!.message
      : "有欄位不合格，整批未收；請依 errors 修正後重送（格式見 skill.md）";
    return { status: 400, body: { success: false, error, message, errors: validation.errors } };
  }
  // profile_gap 交的 politician 沒帶 id → 用任務編號裡的那位補上（存進 payload，驗證時的身份比對與落庫都看得到）
  for (const item of validation.items) {
    (item as { payload: unknown }).payload = withTaskPolitician(item.contribution_type, item.payload, item.task_id);
  }
  // 縣市議員候選人的選舉區寫法統一（2026-09-28）：有給就正規化，沒給就從 position 抽；就地修改 payload
  for (const item of validation.items) {
    if (item.contribution_type === "candidacy") normalizeCandidacyDistrictField(item.payload as Record<string, unknown>);
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

  // 單一答案型任務：同 IP 已有一份在排隊就不收第二份（見 single-answer-guard.ts）
  // 提問任務只收 question_answer（2026-09-20）：no_change 通過會把提問任務關掉，訪客卻永遠看到「AI 正在查證」。
  // 查不到、連結打不開也要回一份說明——那才是訪客看得到的東西。
  const manualNoChange = validation.items.filter((it) => it.contribution_type === "no_change" && typeof it.task_id === "string" && !it.task_id.startsWith("auto:")).map((it) => it.task_id as string);
  if (manualNoChange.length > 0) {
    const { data: qTasks } = await supabase.from("contribution_tasks").select("id").in("id", manualNoChange).eq("task_type", "question").limit(50);
    if ((qTasks ?? []).length > 0) {
      return { status: 400, body: { success: false, error: "question_needs_answer", message: "提問任務只收 question_answer：查不到、連結需登入打不開，也請用 question_answer 回一份說明（訪客看得到的是回答，不是 no_change）", task_ids: ((qTasks ?? []) as Array<{ id: string }>).map((t) => t.id) } };
    }
  }
  const blocked = await findBlockedSingleAnswers(supabase, validation.items, ipHash);

  // 搜尋結果頁不是出處、也不算查過的網址（2026-10-06，見 search-page.ts）：不計入網址數，
  // 扣掉之後一個實際頁面都不剩（或單一出處欄本身就是搜尋結果頁）→ 整批 400，不算被拒。
  const searchPages = searchPageProblems(validation.items);
  if (searchPages.length > 0) {
    try {
      await supabase.from("gate_rejections").insert(searchPages.map(() => ({ gate: SEARCH_PAGE_GATE, endpoint: via, contribution_id: null, ip_hash: ipHash })));
    } catch { /* 記不成不影響回應 */ }
    return {
      status: 400,
      body: {
        success: false,
        error: SEARCH_PAGE_GATE,
        message: "搜尋結果頁不是出處，請附實際打開的頁面。有出處欄位扣掉搜尋結果頁之後不夠，整批未收；請照 errors 改附從搜尋結果點進去、實際打開的頁面後重送。這不算被拒。",
        errors: searchPages,
      },
    };
  }

  // 政見／基本資料缺口回「查無」：checked_urls 至少 5 個（維護者 2026-10-01，見 not-found-guard.ts）。
  // 「查無」是在主張不存在；只看中選會、議會官網、一兩家媒體就回報，14 天內這個缺口不再派。
  // 2026-10-04（協議 1.44.0）：自報的 agent_tool 歸到的那個模型系列，近 14 天查無比例異常高時門檻提高
  // （7 個網址、≥4 個不同網域，見 not-found-series.ts）。統計拿不到就用一般門檻，不擋。
  const gatedNotFound = validation.items.some((item) =>
    item.contribution_type === "no_change" &&
    gatedNotFoundType((item.payload as Record<string, unknown>)?.task_id ?? item.task_id, item.payload) !== null
  );
  let toolVerdict: SeriesVerdict | null = null;
  if (gatedNotFound) {
    const rates = await fetchNotFoundRates(supabase);
    toolVerdict = rates ? agentToolVerdict(rates, validation.contributor.agent_tool) : null;
  }
  for (const item of validation.items) {
    if (item.contribution_type !== "no_change") continue;
    const shortfall = notFoundSearchShortfall(
      (item.payload as Record<string, unknown>)?.task_id ?? item.task_id,
      item.payload,
      toolVerdict?.elevated ?? false,
    );
    if (!shortfall) continue;
    // 搜尋結果頁被扣掉的另記一道，看得出新規則擋了幾次
    const gate = shortfall.search_pages > 0
      ? SEARCH_PAGE_GATE
      : shortfall.elevated ? "not_found_search_insufficient_elevated" : "not_found_search_insufficient";
    try {
      await supabase.from("gate_rejections").insert({ gate, endpoint: via, contribution_id: null, ip_hash: ipHash });
    } catch { /* 記不成不影響回應 */ }
    return {
      status: 400,
      body: {
        success: false,
        error: "not_found_search_insufficient",
        message: notFoundSearchMessage(shortfall) +
          (shortfall.elevated && toolVerdict ? `\n${seriesVerdictMessage(toolVerdict, shortfall.required, shortfall.required_domains)}` : ""),
        checked: shortfall.checked,
        required: shortfall.required,
        domains: shortfall.domains,
        required_domains: shortfall.required_domains,
        ...(shortfall.search_pages > 0 ? { search_pages_excluded: shortfall.search_pages } : {}),
        ...(shortfall.elevated && toolVerdict
          ? { elevated: { model: toolVerdict.model, not_found_rate: Number(toolVerdict.rate.toFixed(3)), site_rate: Number(toolVerdict.overall_rate.toFixed(3)), submitted: toolVerdict.submitted, window_days: NOT_FOUND_RATE_WINDOW_DAYS } }
          : {}),
      },
    };
  }

  // 通過上面兩道之後，搜尋結果頁從要存的出處裡拿掉（驗證者照 source_urls 核對，打開搜尋結果頁核不到東西）；
  // 回應的 notice 會講拿掉幾個，不是默默吃掉。後面的「唯一出處」守門看的是拿掉之後的網址。
  const strippedSearch = stripSearchPages(validation.items);
  const strippedCount = [...strippedSearch.values()].reduce((n, l) => n + l.length, 0);

  // 媒體不能當唯一出處（#347 第 3 項，協議 1.45.0）：政見與政見進度沒有官方來源時，要兩個不同網站的來源。
  // 門檻表不分來源等級（一律 3），三張 +1 擋不住「整筆只建立在一篇報導上」；交件當下補一個來源最便宜。不算被拒。
  const soleSource = soleSourceProblems(validation.items);
  if (soleSource.length > 0) {
    try {
      await supabase.from("gate_rejections").insert(soleSource.map(() => ({ gate: "single_non_official_source", endpoint: via, contribution_id: null, ip_hash: ipHash })));
    } catch { /* 記不成不影響回應 */ }
    return {
      status: 400,
      body: {
        success: false,
        error: "single_non_official_source",
        message: "有政見或政見進度只附了一個網站的非官方來源（媒體、社群或其他），整批未收；請照 errors 補第二個不同網站的來源或改附官方來源後重送。這不算被拒。",
        errors: soleSource,
      },
    };
  }

  // 政見只給姓名、而同名人物不只一位：交件時就擋（2026-09-26：陳瑩兩筆，政見過了驗證才在落庫時炸、重試到退件）
  for (const item of validation.items) {
    if (item.contribution_type !== "policy" && item.contribution_type !== "policy_progress") continue;
    const p = (item.payload ?? {}) as Record<string, unknown>;
    if (typeof p.politician_id === "string" && p.politician_id) continue;
    const name = typeof p.name === "string" ? p.name.trim() : typeof p.politician_name === "string" ? p.politician_name.trim() : "";
    if (!name) continue;
    // query-bounds: ok — 只要知道有沒有第二位，limit 5 夠列候選
    const { data: same } = await supabase.from("politicians").select("id, region, party, birth_year").eq("name", name).is("merged_into", null).limit(5);
    if ((same ?? []).length > 1) {
      return {
        status: 400,
        body: {
          success: false, error: "ambiguous_politician_name",
          message: `「${name}」有 ${(same ?? []).length} 位同名人物，請在 payload 帶 politician_id 指定是哪一位（任務的 target 或 item.current 裡有 id）。這不算被拒。`,
          candidates: same,
        },
      };
    }
  }

  // 縣市議員要帶選舉區才收（2026-10-05，協議 1.48.0，見 council-district-guard.ts）：
  // 2026 已登記的議員有 105 筆沒有選區，103 筆是照登記名冊交的——名冊上有選區，只是沒抄。不算被拒。
  const districtMissing = councilDistrictProblems(validation.items);
  if (districtMissing.length > 0) {
    try {
      await supabase.from("gate_rejections").insert(districtMissing.map(() => ({ gate: "electoral_district_required", endpoint: via, contribution_id: null, ip_hash: ipHash })));
    } catch { /* 記不成不影響回應 */ }
    return {
      status: 400,
      body: {
        success: false,
        error: "electoral_district_required",
        message: "有縣市議員的參選紀錄沒填選舉區（electoral_district），整批未收；請照 errors 補上「第NN選舉區」後重送。這不算被拒。",
        errors: districtMissing.map((d) => ({ path: `items[${d.index}].payload.electoral_district`, name: d.name, region: d.region, message: d.message })),
      },
    };
  }

  // 縣市議員候選人的選舉區存不存在（2026-09-28）：名冊裡有這個縣市時，統一寫法後的 electoral_district
  // 一定要是名冊裡的選區，或該縣市的原住民保留議席；都不是就整批 400，不算被拒。
  // 名冊裡沒有該縣市（例如新竹縣 2026）或查詢出錯，不擋——見 district-registry.ts 開頭的說明。
  for (const item of validation.items) {
    if (item.contribution_type !== "candidacy") continue;
    const p = (item.payload ?? {}) as Record<string, unknown>;
    if (p.election_type !== "縣市議員") continue;
    const district = typeof p.electoral_district === "string" ? p.electoral_district : null;
    const region = typeof p.region === "string" ? p.region : null;
    const electionId = typeof p.election_id === "number" ? p.election_id : null;
    if (!district || !region || electionId === null) continue;
    const check = await checkElectoralDistrict(supabase, electionId, region, district);
    if (check.status === "unknown") {
      return {
        status: 400,
        body: {
          success: false,
          error: "unknown_electoral_district",
          message: `${region}${electionId}年縣市議員選舉的名冊裡沒有「${district}」這個選區。${
            check.validDistricts && check.validDistricts.length > 0 ? `${region}有效的選區：${check.validDistricts.join("、")}（含原住民保留議席）。` : ""
          }請核對選區編號後重新提交；這不算被拒。`,
        },
      };
    }
  }

  // 參選紀錄的兩道守門（維護者 2026-10-01，見 candidacy-guards.ts）：
  //   1. 更正參選紀錄，reason 要寫出被改的那個人的名字（陳瑩／陳見賢那筆就是 target_id 填錯人）
  //   2. 登記截止後標成 registered／qualified／confirmed，來源要有中選會或截止後的報導（陳琬惠那筆是拿 4 月的造勢新聞）
  {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    for (const item of validation.items) {
      const p = (item.payload ?? {}) as Record<string, unknown>;
      const urls = Array.isArray(item.source_urls) ? (item.source_urls as unknown[]).filter((u): u is string => typeof u === "string") : [];
      if (item.contribution_type === "correction") {
        const { target_table, target_id, changes, reason } = normalizeCorrection(p);
        // 任期（#345 後續）跟參選紀錄一樣：id 是整數、填錯一號就改到別人，reason 要寫出本人姓名
        if ((target_table !== "politician_elections" && target_table !== "politician_offices") || !target_id) continue;
        // query-bounds: ok — 按 id 取一列
        let row: unknown = null;
        try {
          ({ data: row } = await supabase.from(target_table)
            .select(target_table === "politician_elections" ? "id, election_id, candidacy_status, politicians(name)" : "id, election_id, politicians(name)")
            .eq("id", target_id).maybeSingle());
        } catch { continue; } // 查不到就不擋（跟 no-op 檢查同一個原則）
        if (!row) continue; // 對象不存在由落庫前置檢查處理
        const r = row as { election_id: number | null; politicians: { name?: string } | null };
        const targetName = r.politicians?.name ?? null;
        if (!reasonNamesTarget(reason, targetName)) {
          return {
            status: 400,
            body: {
              success: false, error: "reason_missing_target_name",
              message: `這筆更正要改的是「${targetName}」的${target_table === "politician_offices" ? "任期" : "參選紀錄"}（target_id=${target_id}），但 reason 裡沒有寫到「${targetName}」。請確認 target_id 是不是本人那筆；是的話在 reason 寫出姓名再送。這不算被拒。`,
              target: { id: target_id, name: targetName },
            },
          };
        }
        if (target_table !== "politician_elections") continue;
        // 退選前有沒有登記（#345 後續，協議 1.55.0）只在退選的紀錄上有意義（資料庫 CHECK）：交件當下就講，不要讓它進投票
        const status = (row as { candidacy_status?: string | null }).candidacy_status ?? null;
        if (changes.some((c) => c.field === "withdrawn_after_filing") && status !== "withdrawn") {
          return {
            status: 400,
            body: {
              success: false, error: "not_withdrawn",
              message: `「${targetName}」這筆參選紀錄（target_id=${target_id}）現在不是退選（candidacy_status＝${status ?? "空的"}），withdrawn_after_filing 只在退選的紀錄上有值。他其實還在選就只改 candidate_status；這不算被拒。`,
            },
          };
        }
        const toRegistered = changes.some((c) => c.field === "candidate_status" && REGISTERED_STATUSES.has(String(c.correct_value)));
        if (toRegistered && !registrationEvidenceOk(urls, r.election_id, today)) {
          return {
            status: 400,
            body: {
              success: false, error: "registration_evidence_required",
              message: `${r.election_id} 年的參選登記在 ${REGISTRATION_DEADLINE[r.election_id ?? 0]} 截止，之後要把人標成 registered／qualified／confirmed，source_urls 至少要有一個中選會（cec.gov.tw）的名冊或公告，或網址看得出是截止日之後的報導。政黨提名、造勢等截止前的消息證明不了他最後有登記。這不算被拒。`,
            },
          };
        }
      }
      if (item.contribution_type === "candidacy") {
        const electionId = typeof p.election_id === "number" ? p.election_id : null;
        if (!REGISTERED_STATUSES.has(String(p.candidate_status)) || registrationEvidenceOk(urls, electionId, today)) continue;
        return {
          status: 400,
          body: {
            success: false, error: "registration_evidence_required",
            message: `${electionId} 年的參選登記在 ${REGISTRATION_DEADLINE[electionId ?? 0]} 截止，之後交 candidate_status=${p.candidate_status} 的 candidacy，source_urls 至少要有一個中選會（cec.gov.tw）的名冊或公告，或網址看得出是截止日之後的報導。這不算被拒。`,
          },
        };
      }
    }
  }

  const hashes = await Promise.all(validation.items.map((item) => sha256Hex(canonicalPayload(item))));
  const since = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data: existing, error: dupError } = await supabase
    .from("contributions").select("id, payload_hash, status").in("payload_hash", hashes).gte("created_at", since);
  if (dupError) throw new Error(`dedupe lookup: ${dupError.message}`);
  type ExistingRow = { id: string; payload_hash: string; status: string };
  const existingByHash = new Map<string, ExistingRow>(((existing ?? []) as ExistingRow[]).map((r) => [r.payload_hash, r]));

  /**
   * 重複提交＝同意票（2026-09-18）。
   *
   * 兩個代理各自查證後得到同一個宣稱，比「看別人交的東西投一票」更強的證據，
   * 但原本是各躺各的、兩筆都 0 票——李四川那 21 筆堆積就是這麼來的。
   * 實測線上 1,207 筆 pending 有 110 對這種配對（涉及 152 筆）。
   *
   * 只對結構化型別生效（見 duplicate-claim.ts），而且走 handleVerify 投票——
   * 自驗、重複票、每日額度、自動落庫、爭議建案全部沿用既有那一套，這裡不另開一條路。
   * 投不成（自己那台交的／已投過／對方剛定案／額度用完）就照原路收下這筆，不能默默丟掉。
   */
  const mergedByIndex = new Map<number, { existing_id: string; agree_count: number; status: string; required_agree: number; from_agent: string | null }>();
  /** 同對象的既有提交是同一台機器（同 IP）交的：不能併成票，但要告訴它，不然它會一直重交（2026-09-22） */
  const sameMachineDup = new Map<number, string>();
  const mergeCandidateIdx = validation.items
    .map((item, i) => ({ item, i }))
    .filter(({ item, i }) => !existingByHash.has(hashes[i]) && !blocked.has(i) && claimKey(item.contribution_type, item.payload) !== null);
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
      // 2026-09-21 派發閘上線後，這條路安靜地被關了 10 小時（每筆重複都變新件），leatherback 打端點才發現。
      }, ipHash, undefined, "merge");
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

  // 空操作的更正在這裡擋掉（2026-09-21，兩隻跑任務的代理各自獨立回報）：
  // 改完之後值跟現在一樣的 correction，照樣佔一個驗證名額、要好幾票、通過還寫一筆
  // edit_history。而驗證票是最稀缺的資源（全站 1,400+ 筆待驗證）。
  // 成因多半是資料新鮮度——提交者看到的是舊的，別人已經修好了。
  const noOpIndexes = new Map<number, NoOpCheck>();
  // #6（2026-09-22）：一筆多個 change 只有部分是 no-op → 收下，但當場告訴提交者哪幾欄白做（不擋）
  const partialNoOp = new Map<number, string[]>();
  {
    const corrections = validation.items
      .map((item, i) => ({ item, i }))
      .filter(({ item, i }) => item.contribution_type === "correction" && !blocked.has(i) && !mergedByIndex.has(i));
    for (const { item, i } of corrections) {
      const { target_table, target_id } = normalizeCorrection(item.payload);
      if (!target_table || !target_id) continue;
      const cols = CORRECTION_FIELDS[target_table as keyof typeof CORRECTION_FIELDS];
      if (!cols) continue;
      try {
        // query-bounds: ok — 按 id 取一列
        const { data: row } = await supabase.from(target_table).select(["id", ...cols].join(", ")).eq("id", target_id).maybeSingle();
        const check = checkNoOp(item.payload, row as Record<string, unknown> | null);
        if (check.allNoOp) noOpIndexes.set(i, check);
        else if (check.fields.some((f) => f.same)) partialNoOp.set(i, check.fields.filter((f) => f.same).map((f) => f.field));
      } catch { /* 查不到就不擋，讓它照常走驗證 */ }
    }
  }
  if (noOpIndexes.size > 0 && noOpIndexes.size === validation.items.filter((_, i) => !blocked.has(i) && !mergedByIndex.has(i)).length) {
    const first = [...noOpIndexes.values()][0];
    return {
      status: 400,
      body: {
        success: false,
        error: "no_op_correction",
        message: "這筆更正改完之後值跟現在一樣——資料已經是對的了，可能是別人先修好了。請重新讀一次現值再決定要不要提交；**這不算你做錯**，也不計入你的退件。",
        fields: first.fields.map((f) => ({ field: f.field, db_current: f.db_current,correct_value: f.correct_value })),
      },
    };
  }

  // no_change＋outcome:unreachable：伺服器當場試抓一次（2026-09-26 裁決，見上方 precheckUnreachable）。
  // 抓得到就整批 400 退回（不算被拒，代理照系統抓到的內容改判 confirmed／not_found）；
  // 全部抓不到，這筆改成落庫時就是 applied、不進投票——bypassNotes 記著要寫進 review_notes 的話。
  const bypassNotes = new Map<number, string>();
  {
    const unreachableCandidates = validation.items
      .map((item, i) => ({ item, i }))
      .filter(({ item, i }) =>
        item.contribution_type === "no_change" && !blocked.has(i) && !mergedByIndex.has(i) && !existingByHash.has(hashes[i]) &&
        (item.payload as Record<string, unknown>).outcome === "unreachable"
      );
    for (const { item, i } of unreachableCandidates) {
      const payload = item.payload as Record<string, unknown>;
      const urls = Array.isArray(payload.checked_urls) ? (payload.checked_urls as unknown[]).filter((u): u is string => typeof u === "string") : [];
      try {
        const check = await precheckFn(urls, fetchImpl);
        if (check.fetchedUrl) {
          try {
            await supabase.from("gate_rejections").insert({ gate: "unreachable_but_fetchable", endpoint: via, contribution_id: null, ip_hash: ipHash });
          } catch { /* 記不成不影響回應 */ }
          return {
            status: 400,
            body: {
              success: false,
              error: "unreachable_but_fetchable",
              message: `系統剛剛也試了一次，${check.fetchedUrl} 打得開（或它的網路存檔有內容）。這不算退件——請照系統抓到的內容改判 confirmed 或 not_found，不要回 unreachable。`,
              fetched_url: check.fetchedUrl,
              attempts: check.attempts,
            },
          };
        }
        const tried = check.attempts.map((a) => `${a.url}（${a.note}）`).join("；") || "沒有可試的網址";
        bypassNotes.set(i, `[系統] 打不開：伺服器也抓不到——${tried}。只記一次嘗試，不進投票。`);
      } catch (e) {
        // 試抓本身出錯（程式例外）：不能讓系統自己的錯擋掉代理，照舊收成 pending
        console.error("unreachable precheck failed:", e instanceof Error ? e.message : String(e));
      }
    }
  }

  // 落庫前置檢查（2026-09-27 裁決）：連續 5 次「驗證通過→落庫才失敗→重試三次退件」（#261／#262／#275／#276／#263），
  // 每次都是事後補一條守門，投過票的人白投也看不出會失敗。這裡在寫入 contributions 之前，把 apply-contribution.ts
  // 實際會查的對象（人物、政見、參選紀錄、任務）先唯讀查一遍，查到「一定落不了庫」就整批 400，不算被拒。
  // 已被其他守門處理過的（併成同意票、單一答案已交過、24 小時內重複）不用再查。
  const precheckSkip = new Set<number>([...blocked, ...mergedByIndex.keys(), ...bypassNotes.keys(), ...validation.items.map((_, i) => i).filter((i) => existingByHash.has(hashes[i]))]);
  const precheckProblems = await precheckApplyTargets(supabase, validation.items, precheckSkip);
  if (precheckProblems.length > 0) {
    const allTargetNotFound = precheckProblems.every((p) => p.code === "target_not_found");
    const code = allTargetNotFound ? "target_not_found" : "apply_would_fail";
    try {
      await supabase.from("gate_rejections").insert(precheckProblems.map((p) => ({ gate: p.code, endpoint: via, contribution_id: null, ip_hash: ipHash })));
    } catch { /* 記不成不影響回應 */ }
    return {
      status: 400,
      body: {
        success: false,
        error: code,
        message: `這批有 ${precheckProblems.length} 筆送出後會在落庫時失敗，整批未收；請依 errors 修正後重送。這不算被拒`,
        errors: precheckProblems.map(({ index, code: c, path, message }) => ({ index, code: c, path, message })),
      },
    };
  }

  const toInsert = validation.items
    .map((item, i) => ({ item, hash: hashes[i], i }))
    .filter(({ hash, i }) => !existingByHash.has(hash) && !blocked.has(i) && !mergedByIndex.has(i) && !bypassNotes.has(i))
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
      // 身份鍵：去重與歸戶看這個，agent_name 只給人看（docs/BLUEPRINT-agent-identity.md §3）
      actor_id: actor.actor_id,
      payload_hash: hash,
      // 從哪個端點進來的：要收掉舊端點之前，得先看得到還有誰在用（2026-09-21）
      via,
    }));

  let inserted: Array<{ id: string; payload_hash: string }> = [];
  if (toInsert.length > 0) {
    const { data, error } = await supabase.from("contributions").insert(toInsert).select("id, payload_hash");
    if (error) throw new Error(`contributions insert: ${error.message}`);
    inserted = data ?? [];
  }
  const insertedByHash = new Map(inserted.map((r) => [r.payload_hash, r.id]));

  // 打不開、系統也抓不到的 no_change：直接寫進 contributions 再立刻落庫為 applied，不進投票佇列
  // （applyNoChange 自己知道 auto: 任務要記 task_checks、手動任務只記錄不關，見 apply-contribution.ts）
  const bypassResults = new Map<number, { id: string; outcome: ApplyOutcome }>();
  for (const [i, reviewNote] of bypassNotes) {
    const item = validation.items[i];
    const insertRow = {
      contribution_type: item.contribution_type,
      payload: item.payload,
      source_urls: item.source_urls,
      note: item.note ?? null,
      task_id: item.task_id ?? null,
      agent_name: validation.contributor.agent_name,
      agent_tool: validation.contributor.agent_tool ?? null,
      contributor_url: validation.contributor.url ?? null,
      contributor_ip_hash: ipHash,
      actor_id: actor.actor_id,
      payload_hash: hashes[i],
      via,
    };
    const { data: insertedRow, error: insertError } = await supabase.from("contributions").insert(insertRow).select("id").maybeSingle();
    if (insertError) throw new Error(`contributions insert (unreachable bypass): ${insertError.message}`);
    const id = (insertedRow as { id?: string } | null)?.id;
    if (!id) throw new Error("contributions insert (unreachable bypass) 沒有回傳 id");
    const outcome = await applyContribution(supabase, {
      id,
      contribution_type: item.contribution_type,
      payload: item.payload,
      source_urls: item.source_urls,
      note: item.note ?? null,
      agent_name: validation.contributor.agent_name,
      contributor_url: validation.contributor.url ?? null,
      task_id: item.task_id ?? null,
    });
    const status = contributionStatusFor(outcome.status);
    const now = new Date().toISOString();
    const { error: updateError } = await supabase.from("contributions").update({
      status,
      review_notes: reviewNote,
      reviewed_by: "system:unreachable-precheck",
      reviewed_at: now,
      applied_at: status === "applied" ? now : null,
    }).eq("id", id);
    if (updateError) console.error("unreachable bypass status update failed:", updateError.message);
    bypassResults.set(i, { id, outcome });
  }

  // 提交後釋放該任務的軟認領（別人可以接手同一目標）
  const taskIds = [...new Set(validation.items.map((it) => it.task_id).filter((t): t is string => typeof t === "string"))];
  if (taskIds.length > 0) {
    const { error: leaseError } = await supabase.from("contribution_task_leases").delete().in("task_id", taskIds);
    if (leaseError) console.error("lease release failed:", leaseError.message);
  }

  const results = validation.items.map((item, i) => {
    const bypass = bypassResults.get(i);
    if (bypass) {
      return {
        index: i,
        contribution_type: item.contribution_type,
        contribution_id: bypass.id,
        status: "applied",
        message: `已記錄這次嘗試：${bypass.outcome.message}。不需要別人驗證。`,
        task_id: bypass.outcome.task_id,
        review_url: `${supabaseUrl}/functions/v1/contribution-status?id=${bypass.id}`,
      };
    }
    const merged = mergedByIndex.get(i);
    if (merged) {
      return {
        index: i,
        contribution_type: item.contribution_type,
        contribution_id: merged.existing_id,
        status: "counted_as_vote",
        agree_count: merged.agree_count,
        required_agree: merged.required_agree,
        message: `${merged.from_agent ?? "另一個代理"} 已經交過同一個宣稱，你這筆改記為對那一筆的同意票（目前同意 ${merged.agree_count}／${merged.required_agree}${merged.status === "applied" ? "，已上線" : ""}）。下次可以先看 /verifications 有沒有人交過，直接投票比重交一份快。`,
        review_url: `${supabaseUrl}/functions/v1/contribution-status?id=${merged.existing_id}`,
      };
    }
    if (blocked.has(i) && !existingByHash.has(hashes[i])) {
      return {
        index: i,
        contribution_type: item.contribution_type,
        contribution_id: null,
        status: "already_submitted",
        message: "這個任務只收一份，你（同一個來源 IP）已經有一份在等票；等它定案，或去 GET /next 領別的",
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
      status: dup ? "duplicate" : "pending",
      required_agree: need,
      // 疑似口號／行程／個人表態：收下但當場告訴提交者，驗證者也會看到同一句（見 policy-likeness.ts）
      ...(item.contribution_type === "policy"
        ? (() => {
          const p = (item.payload && typeof item.payload === "object" ? item.payload : {}) as Record<string, unknown>;
          const notice = policyLikenessNotice(p.title, p.description);
          return notice ? { warning: notice } : {};
        })()
        : {}),
      // 得票數、得票率不收（#345）：照收這筆，只講一聲那兩欄略過
      ...(item.contribution_type === "candidacy"
        ? (() => {
          const notice = voteFieldsNotice((item.payload && typeof item.payload === "object" ? item.payload : {}) as Record<string, unknown>);
          return notice ? { warning: notice } : {};
        })()
        : {}),
      ...(dup ? { existing_status: dup.status, message: `${DEDUPE_WINDOW_HOURS} 小時內已有相同內容的貢獻，沿用原 id` } : {}),
      ...(sameMachineDup.has(i) ? { note: `同一台機器（同來源 IP）已經交過同對象的同一件事（${sameMachineDup.get(i)}），你這筆**不會**算成對它的同意票——一台機器只有一票。之後同對象的別再交，去驗別人的。` } : {}),
      ...(partialNoOp.has(i) ? { warning: `這幾欄改完跟現值一樣（別人先修好了）：${partialNoOp.get(i)!.join("、")}；只有其餘欄位會被驗證與套用` } : {}),
      review_url: `${supabaseUrl}/functions/v1/contribution-status?id=${id}`,
    };
  });

  const needs = [...new Set(results.map((r) => ("required_agree" in r ? r.required_agree : null)).filter((n): n is number => typeof n === "number"))].sort((a, b) => a - b);
  const single = !Array.isArray((body as Record<string, unknown>).contributions);
  // 整批都是「已經交過一份」：不是成功，回 409 讓代理知道去領別的
  if (results.every((r) => r.status === "already_submitted")) {
    return {
      status: 409,
      body: { success: false, error: "already_submitted", message: results[0].message, ...(single ? results[0] : { results }), docs: `${SITE_URL}/skill.md` },
    };
  }
  // agent_tool 只填別名（claude-code/haiku）時統計拆不出版本：不擋件，附一句提醒（協議 1.44.0）
  const toolNotice = agentToolNotice(validation.contributor.agent_tool);
  // 出處等級只有 self 由交件決定；交件說了別的等級，伺服器照網域重判，講一聲（#347 第二階段 A）
  const levelNotice = [...new Set(validation.items.map((it) => sourceLevelNotice(detailsOfPayload(it.payload, it.source_urls))).filter(Boolean))].join("\n");
  const trailingVoteNote = needs.length > 0
    ? `；通過 ${needs.join("／")} 票同儕驗證後自動上線（required_agree=${needs.join("／")}），有爭議或疑似重複才由維護者處理`
    : "";
  return {
    status: 201,
    body: {
      success: true,
      message: [
        `已收到 ${inserted.length} 筆新貢獻`,
        mergedByIndex.size > 0 ? `${mergedByIndex.size} 筆與別人交過的是同一件事，改記為對那幾筆的同意票` : "",
        bypassResults.size > 0 ? `${bypassResults.size} 筆打不開、系統也抓不到，已直接記錄這次嘗試（不進投票）` : "",
        results.length - inserted.length - mergedByIndex.size - bypassResults.size > 0
          ? `${results.length - inserted.length - mergedByIndex.size - bypassResults.size} 筆重複`
          : "",
      ].filter(Boolean).join("；") + trailingVoteNote,
      agent_name: validation.contributor.agent_name,
      ...(single ? results[0] : { results }),
      daily_quota: { limit: sq.limit, used: used + inserted.length + bypassResults.size },
      ...(toolNotice || strippedCount > 0 || levelNotice ? { notice: [toolNotice, strippedCount > 0 ? strippedNotice(strippedCount) : "", levelNotice].filter(Boolean).join("\n") } : {}),
      docs: `${SITE_URL}/skill.md`,
    },
  };
}

/** 把 body.agent_name 從 ditrust:<序號> 換成代號；回新的 body 與身份。一般代號原樣通過 */
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
