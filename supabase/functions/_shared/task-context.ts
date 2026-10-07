/**
 * /next、/tasks 的 `current`（現況）與 `lookup`（現成 REST 網址）；kind=verify 的 `current`。
 * 純函式 shape*（可測）＋ fetch*（碰 DB）分開。長文字截 500 字並標 truncated:true。
 */

import { createSupabaseIdentityStore, resolvePolitician } from "./politician-identity.ts";
import { identityInputOf } from "./candidate-import.ts";
import { normalizeCorrection } from "./correction.ts";
import { normalizeSeatDistrict } from "./district-seats.ts";
import { fetchAllRows } from "./fetch-all.ts";
import { fetchVerificationSources, needsForTask, sourcesForTask, type TaskSourceHint } from "./verification-sources.ts";
import { fetchPrimarySourceUrls, overlayPrimarySources, overlaySourceUrl } from "./source-read.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;
type Obj = Record<string, unknown>;
import { buildBranchTemplates, buildNoChangeTemplate, buildReportTemplate, newsItemGuidance, PAYLOAD_SHAPE, TASK_GUIDANCE } from "./task-guidance.ts";
import { SUGGESTED_TYPE } from "./task-types.ts";
import { missingElements } from "./policy-elements.ts";
import { partyInfoIds, partyInfoItems } from "./party-info.ts";
import { type CompareRow, resultsUnitLabel, shapeResultsRows } from "./election-results.ts";
import { resultOfCandidacyStatus } from "./candidacy-status.ts";
import { loadReassignContext, personLabel, type ReassignContext, reassignProblems } from "./reassign-candidacy.ts";

export const POLICY_SIMILARITY_THRESHOLD = 0.6;

export const REST_BASE = "https://wiiqoaytpqvegtknlbue.supabase.co/rest/v1";
export const TEXT_LIMIT = 500;
export const MAX_EXISTING_POLICIES = 30;
/** duplicate_policy：整份清單要給代理看完才判得出重複；全站最長的一份是 25 筆，留一倍餘裕 */
export const MAX_POLICY_DUPE_LIST = 60;
/** 清單裡每筆描述只取開頭：判「是不是同一個承諾」看得到主旨就夠，不必整段 */
export const POLICY_DUPE_DESC_LIMIT = 200;
export const MAX_TRACKING_LOGS = 5;

export function truncateText(value: unknown, limit = TEXT_LIMIT): { text: string | null; truncated: boolean } {
  if (typeof value !== "string") return { text: null, truncated: false };
  return value.length > limit ? { text: value.slice(0, limit), truncated: true } : { text: value, truncated: false };
}

/** 把物件裡的長字串欄位截短；有截短就加 truncated:true */
export function truncateFields<T extends Obj>(row: T, fields: readonly string[]): T & { truncated?: true } {
  let truncated = false;
  const out: Obj = { ...row };
  for (const f of fields) {
    const t = truncateText(row[f]);
    if (t.truncated) { out[f] = t.text; truncated = true; }
  }
  return (truncated ? { ...out, truncated: true } : out) as T & { truncated?: true };
}

export interface TaskContextData {
  /** party_info_missing（2026-10-06）：要補的政黨（改名的那一種新舊兩筆） */
  parties?: Obj[];
  /** profile_gap：內政部地方公職人員名單上同名同縣市的現職紀錄（照片、機關、職稱、黨籍），沒有就 undefined */
  moi_official?: Obj | null;
  /** profile_detail_gap：這個人的學經歷一項一列（視圖 politician_careers_full，#346）；needs_source＝待補出處。表還沒上線就是 undefined */
  careers?: Obj[];
  roster?: unknown;
  politician?: Obj | null;
  elections?: Obj[];
  policies?: Obj[];
  policies_total?: number;
  /** duplicate_policy：這個人整份政見清單（含描述開頭），由代理逐組比對有沒有同一個承諾被記成兩筆 */
  /** policy_missing：這個人還在等票的政見提交（避免重複查同一件事） */
  queued_policies?: Obj[];
  policy?: Obj | null;
  tracking_logs?: Obj[];
  politician_election?: Obj | null;
  /** adjudicate：被裁決的貢獻、它的所有票、未定案的裁決數 */
  contribution?: Obj | null;
  votes?: Obj[];
  pending_adjudications?: number;
  /** legacy_audit：系統對這筆政見來源的逐欄核對（jev_decisions policy／source_support），沒有就 null */
  system_check?: Obj | null;
  /** duplicate_politician：兩筆人物各自的全欄、參選紀錄、政見標題；pair_verdict 是 Jev 的 same_person 判定 */
  pair?: { a: Obj | null; b: Obj | null; a_elections: Obj[]; b_elections: Obj[]; a_policies: Obj[]; b_policies: Obj[]; verdict: Obj | null };
  /** question：這一題本身（citizen_questions 一列） */
  question?: Obj | null;
  /** question：已經有哪些代理答過、答了什麼（citizen_questions.id = target.question_id） */
  question_answers?: Obj[];
  /** policy_missing／term_policy_missing：這個人歷屆推得出來的選舉公報（politician_bulletins_for，2026-10-06）；撈不到就 undefined */
  bulletins?: Obj[];
  /** 查證來源（2026-09-28）：依這個任務對象的政黨／縣市／選舉別自動附上的查證來源，撈不到就 undefined */
  verification_sources?: TaskSourceHint[];
  /** 政見三要素（#364）：這條政見已經有的要素列（沒有的那幾個＝未調查） */
  elements?: Obj[];
  /** 政策脈絡（#349）：這條脈絡（lineages_full 一列：政見 id、參與者、交接、關聯） */
  lineage?: Obj | null;
  /** 政策脈絡（#349）：脈絡裡的政見，或候選格裡的政見（含說明開頭、提出者姓名） */
  lineage_policies?: Obj[];
  /** 政策脈絡（#349）：候選格同一層級同一地方已經有的脈絡；上下級候選的上一級脈絡 */
  related_lineages?: Obj[];
  /** 整批補選舉結果（2026-10-06）：這一件每一位的參選紀錄＋系統比對到的中選會那一列（SQL election_result_cec_matches） */
  results_items?: Obj[];
}

/** 整批補選舉結果的名單（2026-10-06）：每一位一列，cec 是線索不是答案 */
export function shapeResultsTaskItems(rows: readonly Obj[]): Obj[] {
  return rows.map((r) => ({
    politician_election_id: r.politician_election_id ?? null,
    politician_id: r.politician_id ?? null,
    name: r.name ?? null,
    place: [r.county, r.town, r.village].filter((x) => typeof x === "string" && x).join(" ") || null,
    // 議員、代表的選舉區（村里長的 district 就是鄉鎮，跟 place 重複就不給）
    ...(typeof r.district === "string" && r.district && r.district !== r.town ? { district: r.district } : {}),
    current_result: r.current_result ?? null,
    cec: r.cec_hits === 1
      ? { elected: r.cec_elected ?? null, sub_region: r.cec_sub_region ?? null, village: r.cec_village ?? null, birth_year: r.cec_birth_year ?? null, cec_cand_id: r.cec_cand_id ?? null, cec_theme_id: r.cec_theme_id ?? null }
      : null,
  }));
}

/** 脈絡裡的政見給代理看的欄位（#349）：說明只取開頭，判「是不是同一件事」看得到主旨就夠 */
function shapeLineagePolicy(row: Obj): Obj {
  const person = row.politicians && typeof row.politicians === "object" ? row.politicians as Obj : null;
  const desc = typeof row.description === "string" ? row.description : null;
  return {
    policy_id: row.id ?? row.policy_id ?? null,
    title: row.title ?? null,
    description: desc && desc.length > POLICY_DUPE_DESC_LIMIT ? `${desc.slice(0, POLICY_DUPE_DESC_LIMIT)}…` : desc,
    politician_id: row.politician_id ?? null,
    name: person?.name ?? row.name ?? null,
    election_id: row.election_id ?? null,
    status: row.status ?? null,
    lineage_id: row.lineage_id ?? null,
    source_url: row.source_url ?? null,
  };
}

/** 一條脈絡給代理看的樣子（#349）：本身＋參與者、交接、關聯（政見另外給） */
function shapeLineageBrief(row: Obj | null | undefined): Obj | null {
  if (!row) return null;
  return {
    lineage_id: row.id ?? null,
    ...pick(row, ["title", "summary", "category", "level", "region", "sub_region"]),
    policy_ids: Array.isArray(row.policy_ids) ? row.policy_ids : [],
    participants: Array.isArray(row.participants) ? (row.participants as Obj[]).map((x) => pick(x, ["politician_id", "name", "role", "basis", "source_url", "source_locator"])) : [],
    handovers: Array.isArray(row.handovers) ? (row.handovers as Obj[]).map((x) => pick(x, ["from_politician_id", "from_name", "from_election_id", "to_politician_id", "to_name", "to_election_id", "handover_type", "decided_on", "note", "source_url"])) : [],
    links: Array.isArray(row.links) ? (row.links as Obj[]).map((x) => pick(x, ["direction", "lineage_id", "title", "level", "region", "link_type", "note"])) : [],
  };
}

/**
 * 名單清查要拿哪一塊「我們現有的人」給代理（2026-10-05）：以鄉鎮市區為單位的清查（2026 村里長、已投票屆別的
 * 中選會名單缺口），target.region 是「縣市＋鄉鎮」這一串，另外帶 county／township；縣市層級的只有 region。
 */
export function rosterOursScope(target: Obj): { county: string; township: string | null } | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const county = str(target.county) ?? str(target.region);
  if (!county) return null;
  return { county, township: str(target.county) ? str(target.township) : null };
}

/**
 * 學經歷補出處（#346）：代理要做的是「照原文重交那幾項＋附看得到它們的頁面」，伺服器只把出處掛到文字相同的項目上。
 * 臉書、IG、Threads 讀不到（驗證者與系統都打不開），掛不上去——跟政策脈絡的角色、交接同一份清單（lineage.ts）。
 */
export const CAREER_SOURCES_HINT =
  "unsourced 列的是這個人還沒有出處的學經歷（網站上標「待補出處」）。找看得到這幾項的頁面（議會、機關的個人介紹頁最常有，其次本人官網、維基百科、新聞），" +
  "用 politician 型別交：education／experience 照 unsourced 的原文抄你查得到的那幾項（一條一項、字要一樣），source_urls 放那些頁面。" +
  "伺服器只會把出處掛到文字相同的項目上；查到的寫法不同或查到這裡沒有的項目，照抄原文並在 note 說明，不要改字。" +
  "臉書、IG、Threads 讀不到，不算出處。查不到就用 no_change 回報你查了哪裡。";

/** politician_careers_full 的列 → 給代理看的形狀（kind 換成跟交件同名的 education／experience） */
export function shapeCareers(rows: Obj[]): { items: Obj[]; unsourced: { education: string[]; experience: string[] } } {
  // 學歷在前、經歷在後，各自照陣列順序
  const kindRank = (k: unknown) => (k === "career" ? 1 : 0);
  const sorted = [...rows].sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0));
  const field = (kind: unknown) => (kind === "career" ? "experience" : "education");
  const items = sorted.map((r) => ({
    field: field(r.kind),
    text: r.text ?? null,
    needs_source: r.needs_source === true,
    sources: Array.isArray(r.sources) ? (r.sources as Obj[]).map((s) => pick(s, ["url", "role", "archive_url"])) : [],
  }));
  const unsourced = { education: [] as string[], experience: [] as string[] };
  for (const it of items) if (it.needs_source && typeof it.text === "string") unsourced[it.field as "education" | "experience"].push(it.text);
  return { items, unsourced };
}

/** 已投票屆別的名單缺口（target.list_source＝cec）：名單就在中選會資料庫、缺的人已經列好，跟 2026 找登記名冊不同 */
export const ROSTER_CEC_GAP_HINT =
  "這一屆已經投票：中選會選舉資料庫（db.cec.gov.tw）上的名單我們已經比對過，缺的人列在任務 target.missing（姓名、選區或村里、當選與否、號次）。" +
  "逐位到中選會核對後用 candidacy 補一筆（candidate_status 填 qualified——名單公告後在名單上的人都是 qualified，confirmed 只表示表態參選——election_result 照中選會填），附你核對的中選會頁面；ours 是我們現有的，" +
  "名字在 ours 裡的不要重補。名字相同不代表同一人，同名的先查他的參選紀錄與出生年。全部補完才交 roster_check（cec_count 填中選會名單人數），只補了一部分就不要交。" +
  "縣市議員要把 target.missing 裡的選區填進 electoral_district（第NN選舉區），沒填交件會被退回（400 electoral_district_required，不算被拒）。";

/**
 * 還沒投票的屆別（2026）的名單缺口：中選會候選人登記彙總表已解析成資料表（cec_registrations，2026-10-08，協議 1.74.0），
 * 系統比對過這個單位我們缺誰，直接附在 current.registration.missing——代理不必自己去找名冊、逐位比對。
 * 有名冊資料的單位才用這段 hint；沒有的（名冊裡沒人、資料表查不到）照舊找名單。
 */
export const ROSTER_REGISTRATION_GAP_HINT =
  "中選會登記彙總表（registration.source_urls）我們已經解析成資料表、跟 ours 比對過：這個單位名冊上共 registration.registered 位，我們已經有 registration.matched 位，" +
  "缺的人列在 registration.missing（姓名、政黨、鄉鎮市區、村里、選舉區、名冊列序；一件最多列 120 位，truncated 為真代表還有，補完下一輪會列出剩下的）。不用自己找名冊、逐位比對。" +
  "照 missing 逐位用 candidacy 補一筆：election_id、election_type、region 照任務；candidate_status 照任務敘述的階段填；" +
  "鄉鎮市長、代表、區長的 sub_region 填 missing 的 sub_region，村里長再加 village（照 missing 的原字），縣市議員的 electoral_district 填 missing 的 district（第NN選舉區，沒填會被退回）；" +
  "source_urls 第一個放 registration.source_urls 裡的那份名冊——系統會逐位核對名冊上的姓名、縣市、鄉鎮、政黨，對得上的一張同意就通過，核對不上的才逐筆驗。" +
  "ours 裡已經有同名的人先確認是不是同一人，是同一人填他的 politician_id；名字相同不代表同一人。一次最多 20 筆，可分多次交。" +
  "全部補完才交 roster_check（cec_count 填 registration.registered）；只補了一部分就不要交，系統下一輪會再派。" +
  "registration.unnamed_count 不是 0 時，名冊上有幾列的姓名欄是空的（罕用字抽不出來），不在 missing 裡，要打開名冊 PDF 自己看。";

/** 名單缺口附給代理的名冊比對結果（roster_registration_gap 的回傳）；一件最多列這麼多位 */
export const ROSTER_GAP_LIMIT = 120;

/**
 * 退選前有沒有登記（#345 後續，協議 1.55.0）：not_running_recheck 的 filing 那一種（target.kind＝withdrawn_filing，
 * 任務編號 auto:not_running_recheck:filing:<參選紀錄 id>，contribution_auto_tasks_withdrawn_filing 派）。
 * 要的是 correction 改 withdrawn_after_filing，跟原本「他在不在名單上」那一種收尾的方式不同，hint 另外給。
 */
export const WITHDRAWN_FILING_HINT =
  "這一列是退選，但看不出他退選之前有沒有登記過（politician_election.withdrawn_after_filing 是空的），網站只能寫「不參選」。" +
  "打開任務附的中選會登記名冊（target.rosters；已投票的屆別看中選會選舉資料庫，target.cec_listed_as）找他：" +
  "**不在名冊上** → correction 把 politician_elections 這一列的 withdrawn_after_filing 改成 false（沒登記過，網站寫「表態不參選」）；" +
  "**在名冊上、後來宣布退選** → 改成 true（登記後退選），source_urls 另附一篇退選的報導；" +
  "**在名冊上、而且還在選** → 這一列標錯了：不要改 withdrawn_after_filing，改用 correction 把 candidate_status 改成 registered。" +
  "correction 的 target_id 是 target.politician_election_id（整數），reason 要寫出他的姓名與你核對的名冊；兩個欄位不要同一筆改。" +
  "target.prior_not_on_roster 有值，代表之前不參選重查的代理已經回報過他「不在登記名單上」，可以先打開那份核對。" +
  "找不到名冊就用 no_change（outcome 填 unreachable 或 not_found），不要猜。";

/** not_running_recheck 的 filing 那一種（看不出退選前有沒有登記） */
export function isWithdrawnFilingTask(taskType: string, target: Obj | null | undefined): boolean {
  return taskType === "not_running_recheck" && !!target && target.kind === "withdrawn_filing";
}

/**
 * 參選紀錄缺政黨（#346 第二階段，協議 1.56.0）：candidacy_source_missing 的 party 那一種（target.kind＝party，
 * 任務編號 auto:candidacy_source_missing:party:<參選紀錄 id>，contribution_auto_tasks_party_gap 派）。
 */
export const PARTY_GAP_HINT =
  "這一筆參選紀錄缺的是「那一次參選時的政黨」（target.missing＝party）。target.cec 是中選會名冊上這一屆的他（推薦政黨、號次、當選與否），" +
  "target.person_party 是他現在登記的政黨——人會換黨，**party 要照中選會名冊那一屆填，不要填現在的**。" +
  "先打開中選會選舉資料庫核對是同一個人（縣市、選區、出生年），再用 candidacy 重交同一人同一屆：politician_id、name、election_id、election_type 照 target，" +
  "地區照 target.fill（縣市議員一定要有 electoral_district），party 照名冊原字（target.cec.party），candidate_status 照現況，election_result 照名冊（target.cec.election_result）。" +
  "系統會用中選會的資料自動核對：我們只有一位同名、當選與否與推薦政黨都對得上就直接上線；推薦政黨對不上會被退件。" +
  "名冊上的不是同一個人（同名同姓）就不要交 candidacy，改用 no_change 回報、finding 寫「掛錯人」。";

/**
 * 參選紀錄缺政黨、這一屆還沒投票（2026-10-06）：candidacy_source_missing 的 party_roster 那一種
 * （contribution_auto_tasks_party_roster 派），照中選會候選人登記彙總表的「推薦之政黨」補。
 */
export const PARTY_ROSTER_HINT =
  "這一筆參選紀錄缺的是「這一次參選時的政黨」，這一屆還沒投票，中選會選舉資料庫還沒有名單——照中選會候選人登記彙總表（target.rosters）補：" +
  "找到他那一列（縣市、選舉區、姓名都要對得上），用 candidacy 重交同一人同一屆，party 照那一列的「推薦之政黨」原字填（寫「無」就填「無」，系統認得是無黨籍），" +
  "不要填他現在登記的政黨（target.person_party）——人會換黨，這一欄記的是這一次。縣市議員要帶 electoral_district（名冊上的選舉區）。" +
  "source_urls 第一個放那份登記彙總表的網址：系統會逐位核對名冊上的姓名、縣市、政黨，吻合的一票就過。名冊上找不到他就用 no_change 回報，不要猜。";

/** candidacy_source_missing 的 party 那一種（參選紀錄缺政黨） */
export function isPartyGapTask(taskType: string, target: Obj | null | undefined): boolean {
  return taskType === "candidacy_source_missing" && !!target && target.kind === "party";
}

/** party_info（#346 第二階段）的驗證提示 */
export const PARTY_INFO_VERIFY_HINT =
  "打開 source_urls（內政部政黨資訊網、政黨官網的公告或報導），逐個政黨核對：claimed 是提交者要寫的值，db 是我們現有的（空白＝還沒有）。" +
  "名稱起始日、停用日要是來源上寫得出來的日子（不是拿月初、年初或報導日期推的）；前身（predecessor）要是來源講明「同一個政黨改名」，名字像、理念相近不算。" +
  "全部對得上才投 agree；任一項來源沒寫或對不上投 disagree，note 寫是哪一個政黨哪一欄；來源打不開投 unsure。";

/** 參選紀錄給代理看的欄位（不參選重查：退選前有沒有登記、核對過名冊沒有） */
const PARTICIPATION_FIELDS = ["id", "election_id", "election_type", "position", "candidacy_status", "withdrawn_after_filing", "verified", "source_note"] as const;

const POLITICIAN_BRIEF = ["id", "name", "party", "region", "election_type", "current_position", "birth_year"] as const;
/** 政見三要素一列給代理看的欄位（#364） */
const ELEMENT_FIELDS = ["element", "stated", "text", "deadline_date", "source_url", "source_locator"] as const;
const PROFILE_FIELDS = ["birth_year", "current_position", "avatar_url", "education_level", "bio", "sub_region"] as const;

function pick(row: Obj | null | undefined, keys: readonly string[]): Obj | null {
  if (!row) return null;
  return Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
}

/**
 * 任何一種任務最後都可能以 no_change 收尾，而 outcome 從 2026-09-21 起是必填的
 * （沒填會被 schema 擋下 400）。十幾條任務敘述散在 SQL 與這支檔案裡，逐條補字遲早漏一條，
 * 所以改成每個任務的 current 都帶著這份說明——代理讀 item 就看得到，不必回頭翻協議。
 * 現場實例：legacy_audit 的提示還停在「都對 → no_change」，照它送會被 400 擋。
 */
export const NO_CHANGE_OUTCOMES_HINT = {
  confirmed: "確認無誤：你打開了來源、對過了，資料正確（只有這個值會把資料標成已核對）。例：政見來源報導寫到那條政見；登記公告名單上有他；確認不參選；進度沒變；要補的欄位資料庫已有且一致。不算：只看標題、看的不是提交的來源。",
  unreachable: "打不開：根本沒拿到內容。例：原文 404 且存檔也沒有；付費牆沒別的版本；網站整個連不上；只有圖片讀不出文字。不算（要回頭照內容判 confirmed／not_found）：403 加 UA 就開、404 但存檔有、PDF（你自己讀得了）、打得開只是沒寫到（那是 not_found）。填之前至少試過瀏覽器 UA、站內搜尋／另一家媒體、web.archive.org（遇 429 要退避重試）。2026-09-26 起伺服器會當場試抓：抓得到會退回 400 unreachable_but_fetchable 並附系統抓到的網址，請照那份內容改判；抓不到只記一次嘗試、不進投票、不用等別人驗證。",
  not_found: "查無資料：內容拿得到，但就是沒有要的東西——你在主張「不存在」，要證明找對地方。例：官網臉書兩家媒體搜姓名都還沒發表政見；議會官網／內政部頁都沒照片；中選會有人但生年欄空白；來源打得開、主題相關，但全文沒有這條、另外也找不到出處；選委會還沒公告開票。要列帶姓名的搜尋網址或具體人物頁，不是首頁。政見缺漏、補基本資料回查無：一定要用搜尋引擎搜至少三組關鍵字（「姓名 政見」「姓名 參選 2026」「姓名 臉書」，照片加「姓名 照片」），看非官方來源（候選人臉書／IG／YouTube、READr 政見總覽 whoareyou.readr.tw、地方新聞、政黨候選人頁），checked_urls 至少 5 個實際打開的頁面（搜尋結果頁不是出處、不計入），finding 寫出搜了哪些關鍵字；少於 5 個會被當場退回。不算：只列首頁；來源寫了你沒看到；來源跟資料矛盾（那是 correction）；找到別的出處（那是 correction 換來源）。",
  _note: "來源打得開、主題也相關、但那一頁沒寫到這筆宣稱 → 先找真出處，找到用 correction 換 source_url，確實找不到才 no_change + not_found。來源與資料矛盾 → correction 或 removal，不要回 no_change",
} as const;

/**
 * 這個人歷屆推得出來的選舉公報（2026-10-06）：吳文振那件「網站訪客請求」的補政見任務只給了「cec.gov.tw 選舉公報」，
 * 代理搜了六次 Google 就回查無；公報其實就在 eebulletin，他是號次 2。推得出來就直接放進現況。
 */
export function shapeBulletins(rows: readonly Obj[] | undefined): { bulletins: Obj[]; bulletins_note: string } | null {
  const list = (rows ?? []).filter((r) => Array.isArray(r.urls) && (r.urls as unknown[]).length > 0).map((r) => ({
    election_id: r.election_id ?? null,
    election_type: r.election_type ?? null,
    cand_no: r.cand_no ?? null,
    elected: r.elected ?? null,
    unit: [r.region, r.sub_region, r.village].filter((x) => typeof x === "string" && x.length > 0).join(" "),
    urls: r.urls,
  }));
  if (list.length === 0) return null;
  const first = list[0];
  return {
    bulletins: list,
    bulletins_note: `中選會選舉公報已經找到：${first.election_id} ${first.election_type}（${first.unit}）${(first.urls as string[])[0]}，他是號次 ${first.cand_no ?? "？"}。` +
      "公報上印的是候選人自己登記的政見原文，先看公報：依姓名與號次找到他自己那一欄（圖片版要裁切放大核對，不要看成隔壁的），" +
      "把那一欄的政見逐條交成 policy（election_id 填那一屆、source_urls 放公報網址、note 寫第幾頁第幾點）。公報那一欄確實空白才算查無。",
  };
}

/** 純函式：依 task_type 組 current（尾端統一補上 no_change 的 outcome 說明） */
export function shapeTaskCurrent(
  taskType: string,
  data: TaskContextData,
  task?: { task_id?: string | null; target?: unknown },
): Obj {
  const target = (task?.target && typeof task.target === "object" ? task.target : null) as Obj | null;
  // 單則新聞的 news_sweep（2026-09-29，Jev 初篩後建）跟整份 RSS 那種做法不同，current 與 hint 另外組
  const newsItem = isNewsItemTask(taskType, target);
  const inner = newsItem ? shapeNewsItemCurrent(target!, data) : shapeTaskCurrentInner(taskType, data);
  // 「這一種任務怎麼做」隨任務送出（2026-09-21）：代理只做眼前這一筆，不該先讀一份 20 種型別的目錄。
  // 依當筆資料而變的 hint 由上面各 case 自己組，組過的就不要覆蓋。
  // 不參選重查的 filing 那一種（#345 後續）收尾是 correction 改 withdrawn_after_filing，hint 另外給
  const hint = inner.hint ?? (isWithdrawnFilingTask(taskType, target) ? WITHDRAWN_FILING_HINT
    : isPartyGapTask(taskType, target) ? PARTY_GAP_HINT
    : taskType === "candidacy_source_missing" && target?.kind === "party_roster" ? PARTY_ROSTER_HINT : TASK_GUIDANCE[taskType]);
  // 回報的 payload 形狀也跟著送：任務說「用 correction 回報」卻不說 correction 長什麼樣，
  // 代理只能回頭翻協議或用猜的，猜錯就是一次 400、查證的工白做（2026-09-21 現場回報）。
  // 單則新聞初篩判成進度的，預設骨架給 policy_progress（其他分支在 report_templates_by_type 裡）
  const suggested = newsItem && target?.suggestion === "progress" ? "policy_progress" : (SUGGESTED_TYPE[taskType] ?? "");
  const shape = PAYLOAD_SHAPE[suggested];
  // 骨架把已知的 id 先填好。candidate_status_stale 要改 politician_elections 的某一列卻沒給
  // 那一列的 id，代理只能猜複合鍵——那個 id 其實一直在 task_id 裡（2026-09-21 實測回報）。
  const template = task ? buildReportTemplate(taskType, suggested, target, task.task_id) : null;
  return {
    ...inner,
    ...(hint ? { hint } : {}),
    ...(shape ? { payload_shape: shape } : {}),
    ...(template ? { report_template: template } : {}),
    // 查不到東西那一條路也要有骨架：教了 outcome 三選一卻沒示範怎麼送，
    // 代理會猜成 {"kind":"no_change"} 然後被 400 擋下（2026-09-21 實測）
    ...(task ? { report_template_no_change: buildNoChangeTemplate(task.task_id) } : {}),
    // 多分支任務把每一條路的骨架都送出去：實測發現正確分支常常不是預設那個
    // （legacy_audit 預設 no_change、正確是 correction），代理只好回頭翻 payload_shape——
    // 而整個改動的目的就是讓它不必回頭翻（2026-09-21）
    ...(task ? (() => { const b = buildBranchTemplates(taskType, target, task.task_id); return b ? { report_templates_by_type: b } : {}; })() : {}),
    no_change_outcomes: NO_CHANGE_OUTCOMES_HINT,
    // 查證來源（2026-09-28）：代理常只查媒體首頁就回「查無」，其實政黨／議會官網查得到照片、學經歷、選區、政見。
    // fetchTaskContext 已經依這個任務對象篩過、限量 6 筆；這裡沒有就不附，不能讓派工因為這個失敗。
    ...(data.verification_sources && data.verification_sources.length > 0 ? { verification_sources: data.verification_sources } : {}),
  };
}

/** Jev 初篩後建的單則新聞任務（news_sweep 且 target.kind='news_item'）；舊的整份 RSS 任務 target 只有 feed_url */
export function isNewsItemTask(taskType: string, target: Obj | null | undefined): boolean {
  return taskType === "news_sweep" && !!target && target.kind === "news_item";
}

/** 單則新聞任務的 current：新聞本身、對應的政見（判成進度時）、這個人現有與等票中的政見（判成新承諾時查重用） */
export function shapeNewsItemCurrent(target: Obj, data: TaskContextData): Obj {
  const p = data.politician ?? null;
  const queued = (data.queued_policies ?? []).map((c) => ({
    contribution_id: c.id,
    title: (c.payload && typeof c.payload === "object" ? (c.payload as Obj).title : null) ?? null,
  })).filter((x) => typeof x.title === "string" && x.title.length > 0);
  return {
    news: {
      url: target.url ?? null,
      title: target.title ?? null,
      source: target.source_label ?? null,
      published_at: target.published_at ?? null,
    },
    suggestion: target.suggestion === "progress" ? "progress" : "new_pledge",
    politician: pick(p, POLITICIAN_BRIEF),
    policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "status", "progress", "source_url", "election_id", "last_updated"])!, ["description"]) : null,
    recent_tracking_logs: (data.tracking_logs ?? []).slice(0, MAX_TRACKING_LOGS).map((l) => truncateFields(pick(l, ["date", "event", "description", "source_url"])!, ["description"])),
    existing_policies: (data.policies ?? []).slice(0, MAX_EXISTING_POLICIES).map((x) => pick(x, ["id", "title", "status", "election_id"])),
    queued_policies: queued,
    hint: newsItemGuidance(typeof target.suggestion === "string" ? target.suggestion : null),
  };
}

function shapeTaskCurrentInner(taskType: string, data: TaskContextData): Obj {
  const p = data.politician ?? null;
  switch (taskType) {
    // 補任期政見（2026-10-02）跟缺政見給同一份現況；既有政見帶 election_id，代理才看得出哪些是別屆的、不算這一屆
    case "policy_missing":
    case "term_policy_missing": {
      const list = (data.policies ?? []).slice(0, MAX_EXISTING_POLICIES).map((x) => pick(x, ["id", "title", "category", "status", "election_id"]));
      // 已經有人交、還在等票的：交一樣的東西不會加分，看到同一件事請去投它的票
      const queued = (data.queued_policies ?? []).map((c) => ({
        contribution_id: c.id,
        title: (c.payload && typeof c.payload === "object" ? (c.payload as Obj).title : null) ?? null,
        agent_name: c.agent_name ?? null,
      })).filter((x) => typeof x.title === "string" && x.title.length > 0);
      return {
        politician: p ? { ...pick(p, POLITICIAN_BRIEF), has_avatar: !!p.avatar_url } : null,
        elections: (data.elections ?? []).map((e) => pick(e, ["election_id", "election_type", "candidacy_status", "source_note"])),
        existing_policies: list,
        existing_policies_total: data.policies_total ?? (data.policies ?? []).length,
        queued_policies: queued,
        queued_policies_note: queued.length > 0
          ? `已經有 ${queued.length} 筆在等票，內容重複的不要再交；找到同一件事請改去投那一筆的票。`
          : null,
        ...(shapeBulletins(data.bulletins) ?? {}),
      };
    }
    case "policy_validity":
    case "policy_election_missing":
    case "policy_election_mismatch":
    case "progress_stale":
    case "policy_source_missing": {
      const policy = data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "progress", "source_url", "proposed_date", "last_updated"])!, ["description"]) : null;
      return {
        policy,
        politician: pick(p, POLITICIAN_BRIEF),
        // 競選承諾的 progress_stale 問的是「當選了嗎？兌現了嗎？」，
        // 所以參選紀錄（含結果：candidacy_status 的 elected／not_elected）要一起給，代理不必為此多打一次 API。
        elections: (data.elections ?? []).map((e) => pick(e, ["election_id", "election_type", "candidacy_status"])),
        recent_tracking_logs: (data.tracking_logs ?? []).slice(0, MAX_TRACKING_LOGS).map((l) => truncateFields(pick(l, ["date", "event", "description", "source_url"])!, ["description"])),
      };
    }
    case "profile_gap": {
      const full = p ? truncateFields(p, ["bio"]) : null;
      const missing = PROFILE_FIELDS.filter((f) => !p || p[f] === null || p[f] === undefined || p[f] === "");
      const present = PROFILE_FIELDS.filter((f) => !missing.includes(f));
      const moi = data.moi_official ? pick(data.moi_official, ["name", "region", "org", "title", "party", "photo_url", "detail_url"]) : null;
      return {
        politician: full, missing_fields: missing, present_fields: present,
        ...(moi ? {
          official_record: moi,
          official_record_hint: "內政部地方公職人員名單上有同縣市、同名的現職紀錄。先打開 detail_url 確認是同一個人（機關、職稱對得上）；是的話，照片可用 photo_url、黨籍與現職照這份官方資料補，source_urls 放 detail_url。不是同一人就忽略這份。",
        } : {}),
      };
    }
    // 補學經歷條列（2026-10-02）：bio 要原樣給（不截斷）—— 它是代理知道「要找什麼」的線索。
    // 但 bio 沒有附來源，所以提醒它 source_urls 要放真的打開過的頁，不是照抄 bio。
    // 學經歷補出處（#346，2026-10-06）：同一個型別，另外給每一項學經歷現在有沒有出處（careers）、還缺出處的原文（unsourced）。
    case "profile_detail_gap": {
      const emptyArray = (v: unknown) => !Array.isArray(v) || v.length === 0;
      const missing = (["education", "experience"] as const).filter((f) => emptyArray(p?.[f]));
      const careers = data.careers ? shapeCareers(data.careers) : null;
      return {
        politician: p,
        missing_fields: missing,
        present_fields: (["education", "experience"] as const).filter((f) => !missing.includes(f)),
        bio_hint: p?.bio
          ? "politician.bio 裡通常已經寫著學經歷，用它知道要找什麼；但 bio 本身沒有附來源，source_urls 要放你實際打開、看得到這些學經歷的網址，不是照抄 bio。bio 跟來源不一致時以來源為準，並在 note 說明。"
          : null,
        ...(careers ? { careers: careers.items, unsourced: careers.unsourced } : {}),
        ...(careers && (careers.unsourced.education.length > 0 || careers.unsourced.experience.length > 0)
          ? { career_sources_hint: CAREER_SOURCES_HINT }
          : {}),
      };
    }
    case "candidacy_source_missing":
    case "election_result_missing":
      return { politician_election: data.politician_election ?? null, politician: pick(p, POLITICIAN_BRIEF) };
    // 疑似測試資料的人物（2026-10-06）：這個人與他的參選紀錄
    case "placeholder_politician":
      return { politician: pick(p, POLITICIAN_BRIEF), elections: data.elections ?? [] };
    // 政黨資訊缺口（2026-10-06）：要補的政黨現在的名稱起訖、前身、名冊狀態
    case "party_info_missing":
      return { parties: (data.parties ?? []).map((x) => pick(x, ["id", "name", "short_name", "moi_no", "moi_name", "moi_status", "valid_from", "valid_to", "predecessor_id"])) };
    // 不參選重查（含 filing 那一種）：那一列的狀態、退選前有沒有登記、核對過名冊沒有（#345 後續）
    case "not_running_recheck":
      return { politician_election: pick(data.politician_election ?? null, PARTICIPATION_FIELDS), politician: pick(p, POLITICIAN_BRIEF) };
    // 整批補選舉結果（2026-10-06）：名單在派工當下才查（target 只放參選紀錄 id，佇列每 10 分鐘整批重寫 target）
    case "election_results_missing": {
      const items = shapeResultsTaskItems(data.results_items ?? []);
      return { items, items_count: items.length };
    }
    // 政策脈絡（#349）：候選格給整份政見（含說明開頭）＋同一地方已有的脈絡；其餘三種給那條脈絡與它的政見
    case "lineage_candidate":
      return {
        policies: (data.lineage_policies ?? []).map(shapeLineagePolicy),
        existing_lineages: (data.related_lineages ?? []).map(shapeLineageBrief),
      };
    case "handover_missing":
    case "lineage_roles_missing":
      return {
        lineage: shapeLineageBrief(data.lineage),
        lineage_policies: (data.lineage_policies ?? []).map(shapeLineagePolicy),
      };
    case "lineage_link_candidate":
      return {
        lineage: shapeLineageBrief(data.lineage),
        lineage_policies: (data.lineage_policies ?? []).map(shapeLineagePolicy),
        upper_candidates: (data.related_lineages ?? []).map(shapeLineageBrief),
      };
    // 政見三要素（#364）：政見本身（description 是我們的摘要、不是原文——hint 有講）＋已經有的要素
    case "policy_elements_missing": {
      const existing = (data.elements ?? []).map((e) => pick(e, ELEMENT_FIELDS)!);
      return {
        policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "election_id", "source_url"])!, ["description"]) : null,
        politician: pick(p, POLITICIAN_BRIEF),
        existing_elements: existing,
        missing_elements: missingElements(existing),
      };
    }
    // 期限到了查進度（#364）：跟 progress_stale 同一份現況，另外帶原文寫的期限那一列
    case "deadline_due": {
      const deadline = (data.elements ?? []).find((e) => e.element === "deadline") ?? null;
      return {
        policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "progress", "source_url", "proposed_date", "last_updated"])!, ["description"]) : null,
        politician: pick(p, POLITICIAN_BRIEF),
        deadline: deadline ? pick(deadline, ELEMENT_FIELDS) : null,
        elections: (data.elections ?? []).map((e) => pick(e, ["election_id", "election_type", "candidacy_status"])),
        recent_tracking_logs: (data.tracking_logs ?? []).slice(0, MAX_TRACKING_LOGS).map((l) => truncateFields(pick(l, ["date", "event", "description", "source_url"])!, ["description"])),
      };
    }
    case "roster_check": {
      const r = (data.roster ?? null) as { rows?: Obj[]; history?: Obj[]; region?: string; list_source?: string; registration?: Obj | null } | null;
      // politician_elections 的 join 會把人物包在 politicians 裡，攤平成代理好比對的樣子
      const ours = (r?.rows ?? []).map((row) => {
        const who = (row.politicians ?? {}) as Obj;
        const at = (row.regions ?? {}) as Obj;
        return {
          name: who.name, party: who.party, region: r?.region ?? who.region,
          // 指到的選區／鄉鎮／村里（有的話），比對時看得出是不是同一個地方的同名者
          ...(at.sub_region ? { sub_region: at.sub_region } : {}),
          ...(at.village ? { village: at.village } : {}),
          candidacy_status: row.candidacy_status, position: row.position,
        };
      });
      const reg = r?.registration && typeof r.registration === "object" ? r.registration : null;
      return {
        region: r?.region ?? null,
        ours_count: ours.length,
        ours,
        previous_checks: r?.history ?? [],
        ...(reg ? { registration: pick(reg, ["source_urls", "registered", "matched", "missing_count", "unnamed_count", "truncated", "missing"]) } : {}),
        hint: r?.list_source === "cec"
          ? ROSTER_CEC_GAP_HINT
          : reg ? ROSTER_REGISTRATION_GAP_HINT
          : "照任務敘述所說的階段去找名單（登記階段看該縣市選委會的登記公告或媒體整理的登記名單，審定公告後才看中選會），把名單全部列出來跟 ours 逐一比對。名單有、ours 沒有的，每一位用 candidacy 補一筆，附你查的那份名單網址；最後用 roster_check 回報這次清查。名字相同不代表同一人，比對時連政黨與選區一起看。**縣市議員每一筆都要填 electoral_district**：名冊每一列都印著「<縣市>第N選舉區」，照抄成「第NN選舉區」；沒填會整批退回（400 electoral_district_required，不算被拒）——只抄姓名、政黨、縣市，網站就只能把他記到縣市，選區分組找不到他。",
      };
    }
    case "question": {
      const q = data.question ?? null;
      return {
        question: q ? truncateFields(pick(q, ["id", "question", "region", "stance_up", "stance_down", "answer_count"])!, ["question"]) : null,
        // 這題掛在哪個政見／人物：帶標題與姓名，不要只有 uuid，讓代理不用另外查
        policy: data.policy ? pick(data.policy, ["id", "title"]) : null,
        politician: p ? pick(p, ["id", "name"]) : null,
        // 已經有哪些代理答過、答了什麼：新代理不要重複同一個角度，該補不同角度或指出前一份的錯誤
        existing_answers: (data.question_answers ?? []).map((a) => truncateFields(pick(a, ["agent_name", "answer", "source_urls", "created_at"])!, ["answer"])),
        hint: q && (q.answer_count as number) > 0
          ? "已經有代理答過：看 existing_answers 的角度，答一樣的沒有加分，請補不同面向或指出前一份哪裡查證不足／有誤"
          : "還沒有人答過，找有出處的答案（政府網頁、新聞、候選人官方發言優先）",
      };
    }
    case "legacy_audit": {
      const policy = data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "source_url", "election_id", "proposed_date"])!, ["description"]) : null;
      return {
        policy,
        politician: pick(p, POLITICIAN_BRIEF),
        elections: (data.elections ?? []).map((e) => pick(e, ["election_id", "election_type", "candidacy_status"])),
        system_check: data.system_check ?? null,
        hint: "打開 policy.source_url：這是不是這個人說過的承諾、標題與內容對不對、是哪一場選舉的。都對 → no_change 且 outcome=confirmed（note 寫你核對到什麼，只有 confirmed 會把這筆標成已核對）；來源拿不到 → no_change 且 outcome=unreachable（不會標成已核對，過幾天換人再試）；來源打得開卻沒寫到這筆政見 → 先找真出處，找到用 correction 換 source_url、找不到才 no_change + not_found；欄位錯 → correction；不是政見 → removal。**每一個網址都要打開**，同批匯入的政見會互相借錯連結。system_check 是系統逐欄核對的結果，contradicted 的欄位優先看；它判 cannot_tell 是「系統看不出來」，不是背書。",
      };
    }
    case "duplicate_policy": {
      // 系統配不出「哪兩筆重複」（實測：真重複那對的字面相似度比不重複的那對還低），
      // 所以這裡不挑配對，整份清單交給代理判。它要回報比對過哪幾組，不能只給結論。
      const list = (data.policies ?? []).slice(0, MAX_POLICY_DUPE_LIST).map((x) => {
        const row = pick(x, ["id", "title", "description", "category", "status", "election_id", "proposed_date", "source_url", "ai_extracted"])!;
        const d = truncateText(row.description, POLICY_DUPE_DESC_LIMIT);
        return d.truncated ? { ...row, description: d.text, truncated: true } : row;
      });
      // 同一個 source_url 的先分好組給它看（selkie 2026-09-21：判掉的假重複全是「同一篇報導、
      // 不同標的」＝同場發表的 N 大政見）。我們沒有 source_title／發布日欄位，但「同一篇」
      // 光靠網址相同就判得出來，不必加欄位、也不必叫代理自己比對 60 條網址。
      const bySource = new Map<string, string[]>();
      for (const row of list) {
        const url = typeof row.source_url === "string" ? row.source_url.trim() : "";
        if (!url) continue;
        bySource.set(url, [...(bySource.get(url) ?? []), String(row.id)]);
      }
      const sameSource = [...bySource.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([source_url, policy_ids]) => ({ source_url, policy_ids }));
      return {
        politician: pick(p, POLITICIAN_BRIEF),
        policies: list,
        policies_total: data.policies_total ?? list.length,
        same_source_groups: sameSource,
        same_source_note: sameSource.length > 0
          ? "這幾組出自同一個網址，多半是同一場發表的「N 大政見」被正確拆成 N 筆——標的不同就不是重複，別急著退。"
          : null,
        hint: "逐組比對這份清單。**先看 source_url**：同一篇報導拆出來的多筆，標的不同（不同醫院、不同路線、不同補助對象）就不是重複（見 same_source_groups）。換句話說講同一件事才是重複——空泛的一筆碰上具體的一筆而且講同一件事，保留具體那筆、對空泛那筆提 removal，reason 寫「與 <保留的 policy_id> 是同一個承諾」；具體資訊只在要移除的那筆才有就先用 correction 補過去。ai_extracted=true 表示這筆是早期 AI 匯入的，來源掛錯的比率偏高，判之前先打開它的 source_url 確認那一頁真的講了這筆政見。沒有重複就用 no_change（outcome=confirmed）帶 task_id，note 列出你比對過哪幾組。",
      };
    }
    case "duplicate_politician": {
      const pr = data.pair;
      const side = (who: Obj | null, elections: Obj[], policies: Obj[]) => ({
        politician: who ? truncateFields(who, ["bio"]) : null,
        elections: elections.map((e) => pick(e, ["election_id", "election_type", "candidacy_status", "position", "source_note"])),
        policies: policies.slice(0, 10).map((x) => pick(x, ["id", "title", "election_id", "status"])),
        policies_total: policies.length,
      });
      return {
        a: side(pr?.a ?? null, pr?.a_elections ?? [], pr?.a_policies ?? []),
        b: side(pr?.b ?? null, pr?.b_elections ?? [], pr?.b_policies ?? []),
        system_vote: pr?.verdict ?? null,
        hint: "同名不代表同一人：連政黨、縣市／選區、出生年、歷屆參選一起看。中選會歷屆參選查詢會把同一人列在同一筆。是同一人就 merge_politician same_person=true，keep_id 選資料較完整、參選紀錄較多的那筆；不是就 same_person=false。兩種都附 reason（≥20 字）與你查的網址。",
      };
    }
    case "adjudicate": {
      const c = data.contribution ?? null;
      return {
        contribution: c
          ? { ...pick(c, ["id", "contribution_type", "status", "agent_name", "agent_tool", "source_urls", "note", "agree_count", "disagree_count", "unsure_count", "review_notes", "last_error", "created_at"]), payload: c.payload ?? null }
          : null,
        votes: (data.votes ?? []).map((v) => pick(v, ["verdict", "evidence_url", "note", "agent_name", "resolved_politician_id", "created_at"])),
        pending_adjudications: data.pending_adjudications ?? 0,
        hint: "正方＝contribution.source_urls，反方＝votes 裡 disagree 的 evidence_url／note；都打開、獨立判斷。uphold＝原貢獻正確、reject＝原貢獻有誤；payload 帶 contribution_id、verdict、reason（≥20 字）、checked_urls；身份爭議多帶 resolved_politician_id。**來源是選舉公報且為圖片版時，請截圖放大核對候選人自己那一欄，不要只看抽出來的文字**——公報圖片版常把相鄰候選人的政見黏在一起。你的裁決會再被 3 票驗證才定案。",
      };
    }
    default:
      return { politician: pick(p, POLITICIAN_BRIEF) };
  }
}

/** 現成 REST 查詢網址（要帶 apikey／Authorization header，見 skill.md §7） */
export function buildLookup(target: Obj): Record<string, string> {
  const pid = typeof target.politician_id === "string" ? target.politician_id : null;
  const policyId = typeof target.policy_id === "string" ? target.policy_id : null;
  const out: Record<string, string> = {};
  if (pid) {
    out.politician = `${REST_BASE}/politicians?select=*&id=eq.${pid}`;
    // 出處在出處表（2026-10 起資料表沒有 source_url 欄）：政見清單改讀視圖 policies_with_logs 的 sources（主要出處排最前）
    out.policies = `${REST_BASE}/policies_with_logs?select=id,title,category,status,progress,election_id,sources&politician_id=eq.${pid}&order=proposed_date.desc`;
    out.elections = `${REST_BASE}/politician_elections?select=id,election_id,election_type,position,candidacy_status,source_note,verified&politician_id=eq.${pid}`;
  }
  if (policyId) {
    out.policy = `${REST_BASE}/policies_with_logs?select=*&id=eq.${policyId}`;
    out.tracking_logs = `${REST_BASE}/tracking_logs?select=id,date,event,description&policy_id=eq.${policyId}&order=date.desc&limit=20`;
  }
  return out;
}

/** 政策脈絡（#349）：lineages_full 幾列（一次最多 30 條） */
async function fetchLineagesFull(supabase: SupabaseLike, ids: readonly string[]): Promise<Obj[]> {
  const list = [...new Set(ids.filter((x) => typeof x === "string" && x))].slice(0, 30);
  if (list.length === 0) return [];
  // query-bounds: ok — 最多 30 條脈絡
  const { data } = await supabase.from("lineages_full").select("*").in("id", list).limit(30);
  return (data ?? []) as Obj[];
}

/** 政策脈絡（#349）：一批政見（含提出者姓名）；一格最多 60 條，脈絡裡的政見也是這個量級 */
const LINEAGE_POLICY_COLUMNS = "id, title, description, politician_id, election_id, status, lineage_id, politicians(name)";
async function fetchPoliciesByIds(supabase: SupabaseLike, ids: readonly string[]): Promise<Obj[]> {
  const list = [...new Set(ids.filter((x) => typeof x === "string" && x))].slice(0, MAX_POLICY_DUPE_LIST);
  if (list.length === 0) return [];
  // query-bounds: ok — 一格或一條脈絡最多 MAX_POLICY_DUPE_LIST 條
  const { data } = await supabase.from("policies").select(LINEAGE_POLICY_COLUMNS).in("id", list).is("removed_at", null).limit(MAX_POLICY_DUPE_LIST);
  return (data ?? []) as Obj[];
}
async function fetchLineagePolicies(supabase: SupabaseLike, lineageId: string): Promise<Obj[]> {
  // query-bounds: ok — 一條脈絡的政見最多幾十條，取 MAX_POLICY_DUPE_LIST
  const { data } = await supabase.from("policies").select(LINEAGE_POLICY_COLUMNS).eq("lineage_id", lineageId).is("removed_at", null)
    .order("election_id", { ascending: true }).limit(MAX_POLICY_DUPE_LIST);
  return (data ?? []) as Obj[];
}

/** 碰 DB：依 task_type／target 撈 current 要的資料 */
export async function fetchTaskContext(supabase: SupabaseLike, taskType: string, target: Obj): Promise<TaskContextData> {
  const pid = typeof target.politician_id === "string" ? target.politician_id : null;
  const policyId = typeof target.policy_id === "string" ? target.policy_id : null;
  const data: TaskContextData = {};

  // 政策脈絡（#349）
  if (taskType === "lineage_candidate") {
    const ids = (Array.isArray(target.policies) ? target.policies as Obj[] : []).map((x) => String(x.policy_id ?? ""));
    const existing = (Array.isArray(target.existing_lineages) ? target.existing_lineages as Obj[] : []).map((x) => String(x.lineage_id ?? ""));
    const [pols, lins] = await Promise.all([fetchPoliciesByIds(supabase, ids), fetchLineagesFull(supabase, existing)]);
    // 照 target.policies 的順序（投票日、姓名）排回去
    const order = new Map(ids.map((id, i) => [id, i]));
    data.lineage_policies = pols.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
    data.related_lineages = lins;
  }
  if ((taskType === "handover_missing" || taskType === "lineage_roles_missing" || taskType === "lineage_link_candidate") && typeof target.lineage_id === "string") {
    const uppers = taskType === "lineage_link_candidate" && Array.isArray(target.upper_candidates)
      ? (target.upper_candidates as Obj[]).map((x) => String(x.lineage_id ?? "")) : [];
    const [lins, pols] = await Promise.all([
      fetchLineagesFull(supabase, [target.lineage_id, ...uppers]),
      fetchLineagePolicies(supabase, target.lineage_id),
    ]);
    data.lineage = lins.find((l) => l.id === target.lineage_id) ?? null;
    data.related_lineages = lins.filter((l) => l.id !== target.lineage_id);
    data.lineage_policies = pols;
  }

  if (pid) {
    const { data: p } = await supabase.from("politicians").select("*").eq("id", pid).maybeSingle();
    data.politician = p ?? null;
  }
  // 補學經歷條列／學經歷補出處（#346）：每一項現在有沒有出處。視圖還沒上線（migration 比函式晚套上的那幾分鐘）就不給
  if (taskType === "profile_detail_gap" && pid) {
    // query-bounds: ok — 一個人的學經歷，全站最多的一位 30 多項
    const { data: rows, error } = await supabase.from("politician_careers_full")
      .select("kind, text, sort_order, needs_source, sources").eq("politician_id", pid).order("sort_order").limit(200);
    if (!error) data.careers = (rows ?? []) as Obj[];
  }
  // 補基本資料：內政部現職名單有這個人的話一起給（2026-09-24，陳雅倫的照片內政部就有，代理卻回報查無）
  if (taskType === "profile_gap" && pid) {
    const { data: m } = await supabase.rpc("moi_official_for", { p_politician_id: pid });
    data.moi_official = ((m ?? []) as Obj[])[0] ?? null;
  }
  if (taskType === "legacy_audit" && policyId) {
    const [pl, el, jv] = await Promise.all([
      supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
      pid ? supabase.from("politician_elections").select("election_id, election_type, candidacy_status").eq("politician_id", pid).order("election_id", { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
      supabase.from("jev_decisions").select("choice, probability, probabilities, asked_at").eq("subject_type", "policy").eq("subject_id", policyId).eq("question", "source_support").order("asked_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    data.policy = (pl.data as Obj | null) ?? null;
    data.elections = (el.data ?? []) as Obj[];
    const v = jv.data as { choice?: string; probability?: number; probabilities?: unknown; asked_at?: string } | null;
    data.system_check = v ? { verdict: v.choice, probability: Number(v.probability), fields: v.probabilities ?? null, checked_at: v.asked_at } : null;
  }
  if (taskType === "duplicate_politician") {
    const a = (target.a && typeof target.a === "object" ? (target.a as Obj).id : null) as string | null;
    const b = (target.b && typeof target.b === "object" ? (target.b as Obj).id : null) as string | null;
    if (a && b) {
      const pairKey = [a, b].sort().join("|");
      const [pa, pb, ea, eb, la, lb, jv] = await Promise.all([
        supabase.from("politicians").select("*").eq("id", a).maybeSingle(),
        supabase.from("politicians").select("*").eq("id", b).maybeSingle(),
        supabase.from("politician_elections").select("election_id, election_type, candidacy_status, position, source_note").eq("politician_id", a).order("election_id", { ascending: false }).limit(20),
        supabase.from("politician_elections").select("election_id, election_type, candidacy_status, position, source_note").eq("politician_id", b).order("election_id", { ascending: false }).limit(20),
        supabase.from("policies").select("id, title, election_id, status").eq("politician_id", a).is("removed_at", null).order("proposed_date", { ascending: false }).limit(50),
        supabase.from("policies").select("id, title, election_id, status").eq("politician_id", b).is("removed_at", null).order("proposed_date", { ascending: false }).limit(50),
        supabase.from("jev_decisions").select("choice, probability, asked_at").eq("subject_type", "politician_pair").eq("subject_id", pairKey).eq("question", "same_person").order("asked_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const v = jv.data as { choice?: string; probability?: number } | null;
      data.pair = {
        a: (pa.data as Obj | null) ?? null, b: (pb.data as Obj | null) ?? null,
        a_elections: (ea.data ?? []) as Obj[], b_elections: (eb.data ?? []) as Obj[],
        a_policies: (la.data ?? []) as Obj[], b_policies: (lb.data ?? []) as Obj[],
        verdict: v ? { verdict: v.choice === "same" ? "same_person" : v.choice === "diff" ? "different_person" : v.choice, probability: Number(v.probability) } : null,
      };
    }
  }
  if (taskType === "roster_check") {
    // 把「我們現有的名單」直接給代理。它的工作是跟中選會比對，
    // 沒必要為了知道我們有誰而多打幾次 API，也避免它查錯範圍。
    const electionId = typeof target.election_id === "number" ? target.election_id : null;
    const region = typeof target.region === "string" ? target.region : null;
    const electionType = typeof target.election_type === "string" ? target.election_type : null;
    const scope = rosterOursScope(target);
    if (electionId && region && electionType && scope) {
      // 縣市怎麼算跟 SQL 的 ours 一模一樣：COALESCE(參選紀錄選區所屬縣市, 人物的縣市)。
      // 原本撈全國同類選舉前 300 筆再在這裡篩縣市——縣市議員全國上千人，目標縣市的人
      // 可能根本不在那 300 筆裡，代理會以為我們缺人而重複補（2026-09-18）。
      // 拆兩段在資料庫篩：有選區的看選區、沒選區的看人物；各自翻頁撈完。
      // 以鄉鎮市區為單位的清查（村里長等，target.region 是「縣市＋鄉鎮」）再加鄉鎮條件（2026-10-05；
      // 在這之前拿「台北市中山區」去比 regions.region，ours 永遠是空的，代理會以為我們一個都沒有而重複補）。
      const base = "candidacy_status, position, region_id";
      const [byDistrict, byPerson, history] = await Promise.all([
        fetchAllRows<Obj>("roster ours by district", (from, to) => {
          const q = supabase.from("politician_elections")
            .select(`${base}, regions!inner(region, sub_region, village), politicians!inner(id, name, party, region)`)
            .eq("election_id", electionId).eq("election_type", electionType)
            .or("candidacy_status.is.null,candidacy_status.neq.withdrawn").eq("regions.region", scope.county);
          return (scope.township ? q.eq("regions.sub_region", scope.township) : q)
            .order("politician_id", { ascending: true }).range(from, to);
        }),
        fetchAllRows<Obj>("roster ours by person", (from, to) => {
          const q = supabase.from("politician_elections")
            .select(`${base}, politicians!inner(id, name, party, region, sub_region)`)
            .eq("election_id", electionId).eq("election_type", electionType)
            .or("candidacy_status.is.null,candidacy_status.neq.withdrawn").is("region_id", null).eq("politicians.region", scope.county);
          return (scope.township ? q.eq("politicians.sub_region", scope.township) : q)
            .order("politician_id", { ascending: true }).range(from, to);
        }),
        supabase.from("roster_checks")
          .select("checked_at, cec_count, ours_count, submitted, agent_name, source_url")
          .eq("election_id", electionId).eq("region", region).eq("election_type", electionType)
          .order("checked_at", { ascending: false }).limit(3),
      ]);
      // 還沒投票的屆別（2026）：名冊資料表算出這個單位缺誰，一起附上（2026-10-08）。已投票屆別（list_source＝cec）的缺口在任務 target.missing，不查。
      // 函式還沒上線（migration 比函式晚套上的那幾分鐘）、出錯、這個單位名冊裡沒人（回 NULL）都不給，不擋派工
      let registration: Obj | null = null;
      if (target.list_source !== "cec") {
        const gap = await supabase.rpc("roster_registration_gap", {
          p_election_id: electionId, p_election_type: electionType, p_county: scope.county, p_town: scope.township, p_limit: ROSTER_GAP_LIMIT,
        });
        if (!gap.error && gap.data && typeof gap.data === "object") registration = gap.data as Obj;
      }
      data.roster = {
        rows: [...byDistrict, ...byPerson], history: history.data ?? [], region,
        ...(target.list_source === "cec" ? { list_source: "cec" } : {}),
        ...(registration ? { registration } : {}),
      };
    }
  }
  if (taskType === "duplicate_policy" && pid) {
    const { data: pol, count } = await supabase.from("policies")
      .select("id, title, description, category, status, election_id, proposed_date, ai_extracted", { count: "exact" })
      .eq("politician_id", pid).is("removed_at", null)
      .order("proposed_date", { ascending: false, nullsFirst: false }).order("id", { ascending: true })
      .limit(MAX_POLICY_DUPE_LIST);
    data.policies = pol ?? [];
    data.policies_total = count ?? (data.policies ?? []).length;
  }
  if ((taskType === "policy_missing" || taskType === "term_policy_missing") && pid) {
    const [el, pol, queued, bul] = await Promise.all([
      supabase.from("politician_elections").select("election_id, election_type, candidacy_status, source_note").eq("politician_id", pid).order("election_id", { ascending: false }),
      supabase.from("policies").select("id, title, category, status, election_id", { count: "exact" }).eq("politician_id", pid).is("removed_at", null).order("proposed_date", { ascending: false }).limit(MAX_EXISTING_POLICIES),
      // 還在等票的提交也要給代理看見（2026-09-17：「輪到這種任務時，要先問是不是
      // 已經有類似的政見了」）。只列已上線的害慘了李四川：21 筆等票的沒被列出來，
      // 代理看不到「居住新五箭」已經交過三次，於是交了第四次。
      supabase.from("contributions").select("id, payload, agent_name")
        .eq("contribution_type", "policy").in("status", ["pending", "verified"])
        .eq("payload->>politician_id", pid).order("created_at", { ascending: false }).limit(MAX_EXISTING_POLICIES),
      // 歷屆選舉公報（2026-10-06）：函式還沒上線（migration 比函式晚套上的那幾分鐘）或出錯就不給，不擋派工
      supabase.rpc("politician_bulletins_for", { p_politician_id: pid }),
    ]);
    if (!bul.error && Array.isArray(bul.data)) data.bulletins = bul.data as Obj[];
    data.elections = el.data ?? [];
    data.policies = pol.data ?? [];
    data.policies_total = pol.count ?? (data.policies ?? []).length;
    data.queued_policies = queued.data ?? [];
  }
  // 單則新聞任務（2026-09-29）：判成進度的要看那條政見與它的時間軸；判成新承諾的要看這個人已有／等票中的政見，免得重交
  if (isNewsItemTask(taskType, target) && pid) {
    const [pol, queued] = await Promise.all([
      supabase.from("policies").select("id, title, status, election_id").eq("politician_id", pid).is("removed_at", null)
        .order("proposed_date", { ascending: false, nullsFirst: false }).limit(MAX_EXISTING_POLICIES),
      supabase.from("contributions").select("id, payload")
        .eq("contribution_type", "policy").in("status", ["pending", "verified"])
        .eq("payload->>politician_id", pid).order("created_at", { ascending: false }).limit(MAX_EXISTING_POLICIES),
    ]);
    data.policies = pol.data ?? [];
    data.queued_policies = queued.data ?? [];
  }
  if ((taskType === "progress_stale" || taskType === "policy_source_missing" || taskType === "policy_validity" || taskType === "policy_election_missing" || taskType === "policy_election_mismatch" || isNewsItemTask(taskType, target)) && policyId) {
    const [pl, logs] = await Promise.all([
      supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
      supabase.from("tracking_logs").select("id, date, event, description").eq("policy_id", policyId).order("date", { ascending: false }).limit(MAX_TRACKING_LOGS),
    ]);
    data.policy = pl.data ?? null;
    data.tracking_logs = logs.data ?? [];
  }
  // 承諾類的 progress_stale 要先判斷當選與否，把這個人的參選紀錄一起帶上
  if (taskType === "progress_stale" && pid) {
    const { data: el } = await supabase.from("politician_elections")
      .select("election_id, election_type, candidacy_status")
      .eq("politician_id", pid).order("election_id", { ascending: false });
    data.elections = el ?? [];
  }
  // 政見三要素／期限到了（#364）：政見本身、已經有的要素；期限到了另外要時間軸與參選紀錄（判斷當選與否）
  if ((taskType === "policy_elements_missing" || taskType === "deadline_due") && policyId) {
    const [pl, el, logs] = await Promise.all([
      supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
      // query-bounds: ok — 一條政見最多三列（policy_id, element 唯一）
      supabase.from("policy_elements").select("element, stated, text, deadline_date, source_url, source_locator, updated_at").eq("policy_id", policyId).limit(3),
      taskType === "deadline_due"
        ? supabase.from("tracking_logs").select("id, date, event, description").eq("policy_id", policyId).order("date", { ascending: false }).limit(MAX_TRACKING_LOGS)
        : Promise.resolve({ data: [] }),
    ]);
    data.policy = pl.data ?? null;
    data.elements = (el.data ?? []) as Obj[];
    data.tracking_logs = (logs.data ?? []) as Obj[];
  }
  if (taskType === "placeholder_politician" && pid) {
    // query-bounds: ok — 一個人的參選紀錄（一屆一筆）
    const { data: el } = await supabase.from("politician_elections")
      .select("id, election_id, election_type, candidacy_status, source_note")
      .eq("politician_id", pid).order("election_id", { ascending: false }).limit(50);
    data.elections = el ?? [];
  }
  if (taskType === "party_info_missing") {
    const ids = (Array.isArray(target.party_ids) ? target.party_ids : [target.party_id]).filter((x) => typeof x === "number");
    if (ids.length > 0) {
      // query-bounds: ok — 一件任務最多兩個政黨（改名的新舊兩筆）
      const { data: ps } = await supabase.from("parties").select("id, name, short_name, moi_no, moi_name, moi_status, valid_from, valid_to, predecessor_id").in("id", ids).limit(10);
      data.parties = (ps ?? []) as Obj[];
    }
  }
  if (taskType === "deadline_due" && pid) {
    const { data: el } = await supabase.from("politician_elections")
      .select("election_id, election_type, candidacy_status")
      .eq("politician_id", pid).order("election_id", { ascending: false });
    data.elections = el ?? [];
  }
  // 整批補選舉結果（2026-10-06）：名單細節派工當下查，跟系統票同一支比對（election_result_cec_matches）
  if (taskType === "election_results_missing" && Array.isArray(target.politician_election_ids)) {
    const ids = (target.politician_election_ids as unknown[]).filter((x): x is number => typeof x === "number" && Number.isInteger(x)).slice(0, 200);
    if (ids.length > 0) {
      const { data: rows, error } = await supabase.rpc("election_result_cec_matches", { p_ids: ids });
      if (!error) {
        const order = new Map(ids.map((id, i) => [id, i]));
        data.results_items = ((rows ?? []) as Obj[]).sort((a, b) => (order.get(Number(a.politician_election_id)) ?? 0) - (order.get(Number(b.politician_election_id)) ?? 0));
      }
    }
  }
  if ((taskType === "candidacy_source_missing" || taskType === "election_result_missing" || taskType === "not_running_recheck") && pid) {
    const electionId = typeof target.election_id === "number" ? target.election_id : 2026;
    const { data: pe } = await supabase.from("politician_elections").select("*").eq("politician_id", pid).eq("election_id", electionId).maybeSingle();
    data.politician_election = pe ?? null;
  }
  if (taskType === "question" && typeof target.question_id === "string") {
    const questionId = target.question_id;
    const { data: q } = await supabase.from("citizen_questions").select("*").eq("id", questionId).maybeSingle();
    data.question = q ?? null;
    // question 的 target 不一定帶 politician_id／policy_id（ask 端點是照提問當下的欄位存的），
    // 這題本身掛的 policy_id 才是最新真相，query 一次現成的 policy 標題附上
    const linkedPolicyId = policyId ?? (typeof q?.policy_id === "string" ? q.policy_id : null);
    if (linkedPolicyId) {
      const { data: pl } = await supabase.from("policies").select("id, title").eq("id", linkedPolicyId).maybeSingle();
      data.policy = pl ?? null;
    }
    const questionPid = pid ?? (typeof q?.politician_id === "string" ? q.politician_id : null);
    if (questionPid && !data.politician) {
      const { data: pol } = await supabase.from("politicians").select("*").eq("id", questionPid).maybeSingle();
      data.politician = pol ?? null;
    }
    const { data: answers } = await supabase.from("question_answers").select("agent_name, answer, source_urls, created_at").eq("question_id", questionId).order("created_at", { ascending: true });
    data.question_answers = answers ?? [];
  }
  if (taskType === "adjudicate" && typeof target.contribution_id === "string") {
    const cid = target.contribution_id;
    const [c, votes, adj] = await Promise.all([
      supabase.from("contributions").select("*").eq("id", cid).maybeSingle(),
      supabase.from("contribution_votes").select("verdict, evidence_url, note, agent_name, resolved_politician_id, created_at").eq("contribution_id", cid).order("created_at", { ascending: true }),
      supabase.from("contributions").select("id", { count: "exact", head: true }).eq("contribution_type", "adjudication").eq("payload->>contribution_id", cid).in("status", ["pending", "verified"]),
    ]);
    data.contribution = c.data ?? null;
    data.votes = votes.data ?? [];
    data.pending_adjudications = adj.count ?? 0;
  }
  // 查證來源（2026-09-28）：「有人物對象」的任務——列在 SOURCE_TASK_TYPES 的自動缺口（含
  // 沒有 politician_id 的 roster_check，用 target 的縣市／選舉別）、以及任何 target 帶
  // politician_id 的任務（含手動任務）——依政黨／縣市／選舉別、這種任務要查的東西附上。
  // 來源表很小，撈一次全部快取在函式記憶體幾分鐘，不要每次派工都多打查詢；撈不到就不附，
  // 不能讓派工因為這個失敗。
  if (SOURCE_TASK_TYPES.has(taskType) || pid) {
    try {
      const party = typeof data.politician?.party === "string" ? data.politician.party : null;
      // 村里長清查任務的 target.region 是「台北市松山區」（縣市＋鄉鎮市區），verification_sources.regions 是縣市清單：
      // 優先取 target.county；沒有的話 sourceMatches 會從 region 取縣市前綴（countyKey）
      const region = (typeof data.politician?.region === "string" ? data.politician.region : null)
        ?? (typeof target.county === "string" ? target.county : null)
        ?? (typeof target.region === "string" ? target.region : null);
      const electionType = (typeof data.politician?.election_type === "string" ? data.politician.election_type : null)
        ?? (typeof target.election_type === "string" ? target.election_type : null);
      const all = await fetchVerificationSources(supabase);
      const hints = sourcesForTask(all, { party, region, electionType, need: needsForTask(taskType) });
      if (hints.length > 0) data.verification_sources = hints;
    } catch (e) {
      console.error("verification_sources:", e instanceof Error ? e.message : String(e));
    }
  }
  // 政見與進度紀錄的 source_url 來自出處表的主要出處（#347 第二階段 B-1：資料表的欄位不再讀）；沒有主要出處就是 null。
  // 出處表出錯不擋派工（overlayPrimarySources 自己記 log、那一欄不給）
  await overlayPrimarySources(supabase, data as Obj);
  return data;
}

/** 「有人物對象」的自動任務型別：手動任務另外看 target 有沒有 politician_id（見上面呼叫處） */
export const SOURCE_TASK_TYPES: ReadonlySet<string> = new Set([
  "profile_gap",
  "profile_detail_gap",
  "policy_missing",
  "term_policy_missing",
  "candidacy_source_missing",
  "candidate_status_stale",
  "not_running_recheck",
  "roster_check",
]);

/**
 * 驗證項標明「這票通過後會改到誰」（維護者 2026-10-01）：一筆 correction 的 reason 寫陳瑩、target_id 卻是陳見賢那筆，
 * 驗證者核了陳瑩、投同意，陳見賢被改成已登記。只給 target_id 看不出改的是誰，所以把人名攤在最上層。
 */
export const TARGET_SUMMARY_HINT = "先確認這個人就是交件理由與來源講的那個人；不是就投 disagree（note 寫「target_id 指的是另一個人」）。";

const fmtValue = (v: unknown): string => (v === null || v === undefined || v === "" ? "（空白）" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** 純函式：correction（politicians／politician_elections）的「這筆通過後會改：…」；對象找不到或其他表回 null */
export function correctionTargetSummary(
  targetTable: unknown,
  target: Obj | null | undefined,
  person: { name?: string | null; region?: string | null } | null | undefined,
  changes: ReadonlyArray<{ field: string; db_current: unknown; correct_value: unknown }>,
): string | null {
  if (!target || (targetTable !== "politicians" && targetTable !== "politician_elections" && targetTable !== "politician_offices")) return null;
  const who = targetTable === "politicians" ? { name: target.name, region: target.region } : (person ?? {});
  const name = typeof who.name === "string" && who.name.trim() ? who.name.trim() : "（查不到姓名）";
  const parts = [typeof who.region === "string" && who.region.trim() ? who.region.trim() : null];
  if (targetTable === "politician_elections" || targetTable === "politician_offices") {
    const election = [target.election_id, target.election_type].filter((x) => x !== null && x !== undefined && x !== "").join(" ");
    if (election) parts.push(targetTable === "politician_offices" ? `${election} 任期` : election);
  }
  const ctx = parts.filter(Boolean).join("，");
  const diff = changes.filter((c) => c.field).map((c) => {
    const cur = fmtValue(c.db_current);
    return `${c.field}${cur.startsWith("（") ? "" : " "}${cur} → ${fmtValue(c.correct_value)}`;
  }).join("；");
  return `這筆通過後會改：${name}${ctx ? `（${ctx}）` : ""}的 ${diff || "（沒有欄位）"}。${TARGET_SUMMARY_HINT}`;
}

export interface VerifyContextData {
  politicians?: Obj[];
  elections?: Obj[];
  policies?: Obj[];
  /** policy：find_similar_policies（pg_trgm）命中的既有政見，給驗證者判斷是否重複 */
  similar_policies?: Array<{ id: string; title: string; similarity: number }>;
  /** politician／candidacy：多面向比對的 dry-run 結果（不寫回） */
  identity?: { decision: string; politician_id?: string | null; reason: string; candidate_ids: string[] } | null;
  policy?: Obj | null;
  tracking_logs?: Obj[];
  target?: Obj | null;
  /** correction 對 politician_elections：那筆參選紀錄是誰的（join politicians 出來的 name／region） */
  target_politician?: { name?: string | null; region?: string | null } | null;
  /** merge_politician：跟 duplicate_politician 任務同一份 current（兩筆全欄、參選、政見、Jev 判定） */
  pair_current?: Obj | null;
  /** adjudication：跟 adjudicate 任務同一份 current（原貢獻＋正反票） */
  adjudicate_current?: Obj | null;
  /** no_change：這筆回報的是哪個任務（手動任務的標題與敘述；auto 任務拆出型別與目標） */
  task?: Obj | null;
  /** 派工池（contribution_verify_pool）回的目前分數／目標分數（2026-09-21 票數→分數）；兩者都是數字才附 scoring，缺一就不附（呼叫端沒傳，或池子還沒上這個欄位） */
  score?: number | null;
  target_score?: number | null;
  /** 這筆既有的票（去識別）：後到的驗證者要看得到前一張反對票的理由與反證，不然只能從頭重查（#7，實例 bd3fedaf 林鑫一） */
  votes?: Array<{ verdict: string; weight?: number | null; note?: string | null; evidence_url?: string | null; created_at?: string | null }>;
  /** 提交者附的來源網址；shapeVerifyCurrent 用它算按網域的 source_hints（#4） */
  source_urls?: string[] | null;
  /** district_seats：這個縣市這種選舉我們現有的選舉區與名額（election_districts） */
  districts?: Obj[];
  /** party_info（#346 第二階段）：交件提到的政黨（含前身）現在的名稱起訖、前身、名冊狀態 */
  parties?: Obj[];
  /** policy_elements（#364）：這條政見現在已經有的要素列 */
  elements?: Obj[];
  /** policy_elements（#364）：這一任的卸任日（「任內」換算 deadline_date 用） */
  term_end?: string | null;
  /** 政策脈絡（#349）：這筆動到的脈絡（lineages_full 列；關聯是上下兩條） */
  lineages?: Obj[];
  /** 政策脈絡（#349）：這筆要歸入／拿掉的政見，或脈絡裡現有的政見（含提出者姓名） */
  lineage_policies?: Obj[];
  /** election_results（2026-10-06）：逐位跟中選會名單比的結果（SQL election_results_compare） */
  results_compare?: Obj[];
  /** reassign_candidacy（2026-10-06）：這筆參選紀錄、新舊兩人、兩人各自的參選紀錄、中選會名冊唯一對上的那一列 */
  reassign?: { ctx: ReassignContext; from_elections: Obj[]; to_elections: Obj[]; cec: Obj | null } | null;
}

/**
 * 驗證政策脈絡（#349）：四種各一段提示。共同的重點——同一件事 vs 主題相近、角色以官方紀錄為準、中止要有來源明寫。
 */
export const LINEAGE_VERIFY_HINT: Record<string, string> = {
  lineage:
    "核對這些政見講的是不是**同一件事**（同一個建設、同一部法律、同一筆補助或同一個制度）：打開各條政見的出處與 note 引的依據，" +
    "主題相近但標的不同（不同的醫院、不同的路線、不同的對象）就不是同一件事；新脈絡的層級與地方要是這件事實際決定與執行的那一級政府；標題要中性、照事實。" +
    "existing 是網站上現在的脈絡（歸入既有的才有）。全部對得上投 agree；有任何一條政見不是同一件事、或層級地方標錯，投 disagree 並在 note 寫是哪一條、為什麼；出處打不開、確認不了投 unsure。",
  lineage_participants:
    "逐項核對角色：basis=official_record 的要打開那一頁官方紀錄（立法院議事系統、議會網站），確認這個人真的列在提案、共同提案或連署名單、或官方紀錄裡有他主張推動的發言；" +
    "basis=self_claim 的要確認是本人說的（官網、答辯書、受訪），而且沒有被當成官方角色。新聞轉述不是官方紀錄。" +
    "全部對得上投 agree；任一項角色或依據不對投 disagree，note 寫是誰、官方紀錄實際怎麼寫；打不開投 unsure。",
  lineage_handover:
    "核對交接：前後兩任要是這件事在這個地方真正的前任與後任；交接型態要有來源寫出後任實際怎麼處理——" +
    "接手、轉向、縮小、中止、重新開始各自對得上來源的描述；**中止要有來源明確寫出停止、喊卡、解約或終止**，只因為後任政見裡沒提就判中止的，投 disagree。" +
    "中止這一型要兩台不同機器的同意票才會上線。對得上投 agree；型態或前後任不對投 disagree 並寫來源實際怎麼說；打不開投 unsure。",
  lineage_link:
    "核對上下級：upper 要在 lower 的上一級（中央之於縣市或鄉鎮、縣市之於同縣市的鄉鎮），兩件事之間要有實際的法規、補助核定或執行計畫連結，" +
    "方向對（top_down＝上級立法或補助、下級執行；bottom_up＝下級爭取、上級採納）。只是主題相近投 disagree；對得上投 agree；打不開投 unsure。",
};

/**
 * 按網域的查證提示（#4，2026-09-21）。任務側的 hint_sources 傳不到驗證側，沒被特別交代過的代理
 * 碰到中選會登記頁只看到「這頁只有連結」就卡住。資訊系統早就知道，只是沒送到代理手上。
 */
export const SOURCE_HINTS: ReadonlyArray<{ host: RegExp; hint: string }> = [
  { host: /(^|\.)web\.cec\.gov\.tw$/, hint: "中選會登記公告：名單在頁面的 PDF 附件裡（候選人登記情形一覽表），系統不解析 PDF，你要自己下載讀。逐欄印的名冊不要用 pdftotext -layout（會錯配），各欄各抓成清單再 zip，三欄長度要相等。" },
  { host: /(^|\.)bulletin\.cec\.gov\.tw$/, hint: "中選會選舉公報：PDF，政見常做成圖，pdftotext 抽到空字串不代表沒有——裁切渲染成圖目視核對。圖片版要先依候選人姓名定位到他自己那一欄再放大看，不要看成相鄰候選人的欄位。" },
  { host: /(^|\.)db\.cec\.gov\.tw$/, hint: "中選會候選人資料庫：頁面是 SPA、抓不到正文；直接用 API `/query/api/v1/elections/candidates/query?cand_name=<姓名>`——它證明「這個人是誰」（出生年、歷屆），證明不了「本屆有沒有登記」（只有已投票的選舉，2026 登記期不在裡面）；系統核到 election_id／candidate_status absent 回 cannot_tell 是對的。" },
  { host: /(^|\.)cna\.com\.tw$/, hint: "中央社：不帶瀏覽器 User-Agent 會 403，帶了就 200。" },
  { host: /(^|\.)chinatimes\.com$/, hint: "中時：Cloudflare 擋程式，帶 UA 仍常 403；改抓 web.archive.org/web/2026/<網址> 的快照。" },
  { host: /(^|\.)upmedia\.mg$/, hint: "上報：常 403；改抓 archive.org 快照。" },
  { host: /(^|\.)udn\.com$/, hint: "聯合：舊文常 404（真的下架了，不是擋你）；archive.org 通常有。" },
];

export function sourceHintsFor(urls: ReadonlyArray<string> | null | undefined): Array<{ url: string; hint: string }> {
  const out: Array<{ url: string; hint: string }> = [];
  for (const u of urls ?? []) {
    let host = "";
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    const m = SOURCE_HINTS.find((h) => h.host.test(host));
    if (m) out.push({ url: u, hint: m.hint });
  }
  return out;
}

/** 既有票去識別：只留判斷需要的（verdict／分數／理由／反證／時間），不留代號與 IP */
export function shapeVotes(votes: VerifyContextData["votes"]): Array<Record<string, unknown>> {
  return (votes ?? []).map((v) => ({
    verdict: v.verdict,
    ...(typeof v.weight === "number" ? { weight: v.weight } : {}),
    ...(v.note ? { note: String(v.note).slice(0, 500) } : {}),
    ...(v.evidence_url ? { evidence_url: v.evidence_url } : {}),
    ...(v.created_at ? { at: v.created_at } : {}),
  }));
}

/**
 * 候選人「為什麼被列進來」（#8，2026-09-21）。金門那批 11 筆同名衝突：清單只給了縣市欄位，代理用地理常識
 * 否決了本人；如果當時帶著「同出生年、2022 第01選舉區當選」，就不會。這裡只講事實，不下結論。
 */
export function candidateReasons(candidate: Obj, payload: Obj, elections: ReadonlyArray<Obj>): string[] {
  const why: string[] = [];
  const same = (a: unknown, b: unknown) => a !== undefined && a !== null && b !== undefined && b !== null && String(a).trim() !== "" && String(a).trim() === String(b).trim();
  if (same(candidate.name, payload.name)) why.push("同名");
  if (same(candidate.birth_year, payload.birth_year)) why.push(`同出生年 ${candidate.birth_year}`);
  else if (candidate.birth_year && payload.birth_year) why.push(`出生年不同（清單 ${candidate.birth_year}／提交 ${payload.birth_year}）`);
  if (same(candidate.party, payload.party)) why.push(`同政黨 ${candidate.party}`);
  if (same(candidate.region, payload.region)) why.push(`同縣市 ${candidate.region}`);
  else if (candidate.region && payload.region) why.push(`縣市不同（清單 ${candidate.region}／提交 ${payload.region}）——清單的縣市可能標錯，以中選會 API 為準`);
  const mine = elections.filter((e) => e.politician_id === candidate.id);
  const sameType = mine.filter((e) => same(e.election_type, payload.election_type));
  if (sameType.length > 0) why.push(`有 ${sameType.map((e) => `${e.election_id} ${e.election_type}（${e.candidacy_status}）`).join("、")} 的紀錄`);
  if (candidate.current_position) why.push(`現職 ${candidate.current_position}`);
  return why;
}

/** 一票最多能加幾分、怎麼拿到滿分：給 shapeVerifyCurrent 的 scoring 區塊用 */
const VOTE_SCORE_GUIDE = {
  max: 2,
  how: "同意票預設要找第二來源：item.source_urls 是提交者附的，加分看的是你這票的 evidence_url——另一個網域、直接寫到當事人與這件事的來源，系統核過就是 +2；只打開提交者的來源核對是 +1。提交者附的同一個網域不算第二來源",
} as const;

/**
 * 這筆還差幾分、你這票能不能讓它上線（2026-09-23 維護者：驗票儘量要求第二來源）。
 * 48 小時內只有 4 台機器在投票、一台一筆最多 +2、目標 3——+1 的票要三台全到，+2 的票兩台就夠，
 * 系統票把目標降到 2 時一張 +2 就夠。把這個算術當場講給代理聽，它才知道多花幾分鐘找第二來源值得。
 */
/** 提交者附的來源網域（去 www.、去重）：放進 evidence_url 不算第二來源 */
export function submittedDomains(sourceUrls: readonly string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const u of sourceUrls ?? []) {
    try { out.add(new URL(u).hostname.replace(/^www\./, "").toLowerCase()); } catch { /* 不是網址就略過 */ }
  }
  return [...out];
}

/**
 * 系統會核第二來源（evidence_url）的型別；其他型別附了也只算 +1（evidence_verdict=not_eligible）。
 * system-one 的 evidence／judge 用同一份。2026-09-24 實測：40 張附了 evidence_url 的票有 32 張投在
 * no_change／removal 上，全部白找（leatherback 經工頭轉：該在驗證項上直接講）。
 */
export const SECOND_SOURCE_TYPES: readonly string[] = ["policy", "candidacy", "politician", "correction", "policy_progress"];
export const secondSourceCounts = (contributionType?: string) => !contributionType || SECOND_SOURCE_TYPES.includes(contributionType);

export function scoringHint(score: number, target: number, contributionType?: string): { points_short: number; hint: string } {
  const short = Math.max(0, target - score);
  if (short === 0) return { points_short: 0, hint: "已達目標分數，等系統落庫" };
  if (!secondSourceCounts(contributionType)) {
    return { points_short: short, hint: `這筆差 ${short} 分。這種型別系統不核第二來源，附 evidence_url 也只算 +1——核對無誤投 +1 就是正常的一票，不用另外找來源` };
  }
  // 參選紀錄（2026-09-23 實測）：「附第二來源」推下去，代理拿中選會公告頁當第二來源——名單在附檔 PDF、頁面本身沒有姓名，
  // 系統核不了（no_subject 31 張裡 28 張是這種）。協議 §6 本來就寫登記期參選紀錄 +1 是正常的一票，不要讓提示跟它打架。
  if (contributionType === "candidacy") {
    return { points_short: short, hint: `這筆差 ${short} 分。參選紀錄的官方名冊多半是 PDF，系統核不了——你打開名冊逐欄核對無誤投 +1 就是正常的一票，不用為了 +2 硬找（中選會公告頁的姓名在附檔裡，當第二來源會被判「頁面沒有當事人」）；另一家媒體的登記報導寫到這個人，才值得附` };
  }
  if (short === 1) return { points_short: 1, hint: "這筆只差 1 分：你核對無誤投 agree（+1）就能讓它上線；附第二來源更穩" };
  if (short === 2) return { points_short: 2, hint: "這筆差 2 分：你附一個不同網域、系統核得過的第二來源（+2），這一票就能讓它上線；只投 +1 還要再等一台機器" };
  return { points_short: short, hint: `這筆差 ${short} 分：附第二來源（+2）能讓它少等一台機器；只投 +1 要再多兩台` };
}

/**
 * 驗證三要素（#364）：逐個要素對原文。重點是「不補、不換算、不評價」與「未說明／未調查」的分別——
 * 驗證者要確認的是 stated=false 的那幾個真的在原文那一段找不到，不是「我也沒看到」就算。
 */
export const POLICY_ELEMENTS_VERIFY_HINT =
  "逐個要素打開原文核對（source_locator 指的那一段）：stated=true 的 text 要在原文找得到——數字、期限、財源一字一句對得上，不可以是提交者補的、換算的或評價的字；" +
  "stated=false 的要在原文那一段確認真的沒寫（原文其實有寫就是錯的）；deadline_date 要照規則換算（會計年度是曆年：「2028 年前」＝2028-12-31；「任內」＝ term_end）。" +
  "原文要是這位候選人自己的（公報上看清楚是他那一欄，不是相鄰候選人的）。existing_elements 是網站上現有的，這筆通過後同一個要素會被覆蓋。" +
  "全部對得上投 agree；任一個要素不對投 disagree，note 寫是哪一個要素、原文實際怎麼寫；原文打不開、確認不了投 unsure。";

const IDENTITY_HINT = {
  matched: "系統比對到唯一一位（identity.politician_id）；核對來源後 agree 即可，不用帶 resolved_politician_id",
  new: "系統找不到同一人，通過後會建新人物；若你認為其實是 identity_candidates 裡的某位，agree 時帶 resolved_politician_id（連同 cec_hits／cec_people，見 §2 第 11 條第 5 步）",
  ambiguous: "同名多位、系統判不出：核對來源後投 agree 時**必須帶 resolved_politician_id**（identity_candidates 之一的 id；都不是就填 \"new\" 建新人物）；通過時採用 agree 票裡帶的指認（目前一票指認即採用，所以請確定你指的是對的人）；指認不一致（含 new 與某人混）或都沒指認 → 這筆退件、缺口回到任務佇列重做（2026-09-21 起沒有裁決）。判斷方法見協議 §2 第 11 條：先用中選會 API 以出生年收斂同名者，再看這次提交跟哪一位相容；查無不是新人的證據。帶指認的 agree 要一併帶 cec_hits（中選會查這個姓名回幾筆）與 cec_people（依出生年收斂成幾人），伺服器會當場核 cec_hits（1.29.0）",
} as const;

/**
 * 純函式：依 contribution_type 組驗證用的 current。
 * scoring 區塊只在呼叫端傳了 score／target_score 兩個數字才附上（見 VerifyContextData 的說明）：
 * 派工池還沒上這兩欄、或這條路徑沒有分數概念（如 no_change）時，缺一律不附，不要印出 undefined／null 的分數騙代理。
 */
export function shapeVerifyCurrent(contributionType: string, payload: Obj, data: VerifyContextData): Obj {
  let out = shapeVerifyCurrentInner(contributionType, payload, data);
  if (typeof data.score === "number" && typeof data.target_score === "number") {
    out = {
      ...out,
      scoring: {
        target_score: data.target_score,
        current_score: data.score,
        ...scoringHint(data.score, data.target_score, contributionType),
        // 把系統知道、代理不知道的事先講出來（2026-09-23 leatherback-ec）：這些網域是提交者的，放進 evidence_url 會被判 same_source、不加分
        ...(submittedDomains(data.source_urls).length > 0 && secondSourceCounts(contributionType) ? { not_a_second_source: submittedDomains(data.source_urls) } : {}),
        second_source_counts: secondSourceCounts(contributionType),
        your_vote_could_be: secondSourceCounts(contributionType) ? VOTE_SCORE_GUIDE : { max: 1, how: "這種型別系統不核第二來源：打開提交者附的來源逐欄核對過、投 agree 就是 +1（附 evidence_url 也不會變 +2）" },
      },
    };
  }
  // #7：既有票公開（去識別）。看得到前一張反對票的理由，後到的人才能針對爭點查、也才看得出盲反對。
  if (data.votes && data.votes.length > 0) out = { ...out, votes: shapeVotes(data.votes) };
  // #4：按網域的查證提示
  const hints = sourceHintsFor(data.source_urls);
  if (hints.length > 0) out = { ...out, source_hints: hints };
  return out;
}

function shapeVerifyCurrentInner(contributionType: string, payload: Obj, data: VerifyContextData): Obj {
  switch (contributionType) {
    // 政策脈絡（#349）
    case "lineage": {
      const lid = typeof payload.lineage_id === "string" ? payload.lineage_id.toLowerCase() : null;
      return {
        existing: lid ? shapeLineageBrief((data.lineages ?? []).find((l) => String(l.id).toLowerCase() === lid)) : null,
        policies: (data.lineage_policies ?? []).map(shapeLineagePolicy),
        hint: LINEAGE_VERIFY_HINT.lineage,
      };
    }
    case "lineage_participants":
    case "lineage_handover":
      return {
        lineage: shapeLineageBrief((data.lineages ?? [])[0]),
        lineage_policies: (data.lineage_policies ?? []).map(shapeLineagePolicy),
        people: (data.politicians ?? []).map((x) => pick(x, POLITICIAN_BRIEF)),
        hint: LINEAGE_VERIFY_HINT[contributionType],
      };
    case "lineage_link": {
      const find = (v: unknown) => typeof v === "string" ? (data.lineages ?? []).find((l) => String(l.id).toLowerCase() === v.toLowerCase()) : undefined;
      return {
        upper: shapeLineageBrief(find(payload.upper_lineage_id)),
        lower: shapeLineageBrief(find(payload.lower_lineage_id)),
        hint: LINEAGE_VERIFY_HINT.lineage_link,
      };
    }
    case "politician":
    case "candidacy": {
      const elections = (data.elections ?? []).map((e) => pick(e, ["politician_id", "election_id", "election_type", "candidacy_status", "source_note"]));
      const candidates = (data.politicians ?? []).map((p) => ({
        ...pick(p, POLITICIAN_BRIEF),
        has_avatar: !!p.avatar_url,
        elections: elections.filter((e) => e?.politician_id === p.id).map((e) => `${e?.election_id} ${e?.election_type}（${e?.candidacy_status}）`),
        // #8：為什麼被列進來——只講事實（同名／同出生年／同縣市／有哪一屆的紀錄），結論由你下
        why: candidateReasons(p, payload, (data.elections ?? []) as Obj[]),
      }));
      const decision = data.identity?.decision ?? null;
      return {
        identity: data.identity ? { decision: data.identity.decision, politician_id: data.identity.politician_id ?? null, reason: data.identity.reason } : null,
        identity_pick_required: decision === "ambiguous",
        identity_candidates: candidates,
        matching_politicians: candidates.map(({ elections: _e, ...rest }) => rest),
        elections,
        hint: (decision && decision in IDENTITY_HINT ? IDENTITY_HINT[decision as keyof typeof IDENTITY_HINT] : "同名多位時，用 payload 的政黨／縣市／現職／出生年判斷是不是同一人") +
          "；candidacy 要看該人是否已有這場選舉的紀錄。逐欄核對來源後投 agree／disagree（附 evidence_url 與 note）／unsure",
      };
    }
    case "policy":
      return {
        politician: pick(data.politicians?.[0] ?? null, POLITICIAN_BRIEF),
        existing_policy_titles: (data.policies ?? []).slice(0, MAX_EXISTING_POLICIES).map((x) => pick(x, ["id", "title", "category", "status"])),
        similar_policies: (data.similar_policies ?? []).map((s) => ({ id: s.id, title: s.title, similarity: Math.round(s.similarity * 100) / 100 })),
        hint: "先看重複：similar_policies 是系統用**字面**相似度撈的，中文換句話說的重複它抓不到（實測「加速都市更新」與「都更5夠力」的字面相似度低於兩筆不重複的政見），所以請把 existing_policy_titles 整份看過再判斷。與其中一條實質重複（同一承諾換句話說）就投 disagree 並在 note 寫「重複於 <policy_id>」；只是主題相近、標的不同（不同醫院、不同路線）就照來源核對。來源一句話連著幾個承諾（「A 及 B」）時可以拆成幾條交：這一條只核它自己寫的那部分，只寫了其中一件而相符不算不完整，從同一句拆出來的兩條也不算重複（§2 第 10b 條）。先確認來源證明的是這個人、年份與職權都對得上：主題相符的政府網頁不等於這位候選人的政見，把他人或前任的政績當成這位的政見來源要投 disagree。**來源是選舉公報且為圖片版時，請截圖放大核對候選人自己那一欄，不要只看抽出來的文字**——公報圖片版常把相鄰候選人的政見黏在一起；也要確認這不是議員議會質詢、總質詢時提出的主張（那不是政見）",
      };
    case "policy_progress":
      return {
        policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "status", "progress", "last_updated", "source_url", "description"])!, ["description"]) : null,
        recent_tracking_logs: (data.tracking_logs ?? []).slice(0, MAX_TRACKING_LOGS).map((l) => truncateFields(pick(l, ["date", "event", "description", "source_url"])!, ["description"])),
        hint: "先確認來源證明的是這個人、年份與職權都對得上：施政成果要能歸屬到該政見主體本人任內、其職權範圍內，別人或前任做的同主題事情不算，對不上就投 disagree",
      };
    case "correction": {
      // 多欄位：每個 change 都附資料庫現值；第一個欄位另放在 field／current_value 維持相容
      const { changes } = normalizeCorrection(payload);
      const withCurrent = changes.map((c) => ({ field: c.field, claimed_current: c.current_value ?? null, db_current: data.target ? (data.target[c.field] ?? null) : null, correct_value: c.correct_value }));
      const summary = correctionTargetSummary(payload.target_table, data.target, data.target_politician, withCurrent);
      return {
        ...(summary ? { target_summary: summary } : {}),
        target_table: payload.target_table ?? null,
        target_id: payload.target_id ?? null,
        field: withCurrent[0]?.field ?? "",
        current_value: withCurrent[0]?.db_current ?? null,
        changes: withCurrent,
        target: data.target ? truncateFields(data.target, ["description", "bio"]) : null,
        hint: "逐欄核對：db_current 是資料庫現值、correct_value 是提交者主張的正確值；每個欄位都要在來源找得到才 agree，任一欄對不上就 disagree 並指出是哪一欄",
      };
    }
    // 2026-09-20 審查建議 5：這幾種型別的驗證項原本只有 payload，驗證者只能照 reason 投
    case "merge_politician": {
      // 跟 adjudication 同一個形狀：pair_current 是任務端的 current，它的 hint 寫給
      // 「要提交一份合併」的人看（「是同一人就 same_person=true」），驗證回合照抄的話，
      // 等於教投票的人去交一筆新貢獻。2026-09-21 把驗證守門測試的取樣擴大後掃出來的第二處。
      if (!data.pair_current) return { hint: "找不到那兩筆人物（可能已合併或不存在）：投 unsure" };
      const { hint: _submitHint, ...rest } = data.pair_current as Obj;
      return {
        ...rest,
        hint: "你要判的是**提交者的結論站不站得住**，不是自己重判一次：payload 的 same_person 是 true（同一人、通過後會軟合併）還是 false（不同人、這一對之後不再派）。" +
          "打開它附的 source_urls，看那份中選會或官方名單能不能支持這個結論；a／b 兩邊的政黨、縣市、出生年、歷屆參選也一起對。" +
          "**合併沒有便宜的回頭路**，判 same_person=true 的要特別嚴：同名同縣市不等於同一人。" +
          "支持就 agree、來源推不出這個結論或與它矛盾就 disagree（附 evidence_url 與 note）、看不出來就 unsure。**你這一票是 agree／disagree／unsure**。",
      };
    }
    case "adjudication": {
      // 任務端的 current（含 hint）是寫給「要提交一份裁決」的人看的——uphold／reject 是那一側的詞彙。
      // 驗證回合要做的事完全不同：對別人交的那份裁決投 agree／disagree／unsure。
      // 2026-09-21 之前這裡直接把任務端的 current 原樣回傳，於是教投票的人送 verdict:"reject"，
      // 被 schema 擋下 400（ballyhoo-4d 的子代理實際撞到）。hint 要換成驗證端的。
      const { hint: _submitHint, ...rest } = (data.adjudicate_current ?? {}) as Obj;
      return {
        ...rest,
        hint: "你要判的是**這份裁決站不站得住**，不是自己重判一次爭議：contribution 是被裁決的原貢獻、votes 是它的正反票，payload.verdict／reason／checked_urls 是裁決者的結論與理由。打開它列的 checked_urls，看理由是否從那些來源推得出來、有沒有漏掉反方的反證。站得住投 agree、推不出來或與來源矛盾投 disagree（附 evidence_url 與 note）、看不出來投 unsure。**你這一票是 agree／disagree／unsure**，uphold／reject 是裁決者提交時用的詞，不要填進 verdict。",
      };
    }
    case "removal":
      // 移除人物（2026-10-06，只收測試資料、查無此人）：給這個人與他的參選紀錄
      if (payload.target_table === "politicians") {
        return {
          politician: data.politicians?.[0] ? pick(data.politicians[0], POLITICIAN_BRIEF) : null,
          elections: data.elections ?? [],
          hint: "這筆要把整個人（連參選紀錄）移除，只該用在測試資料、查無此人。自己查一次中選會選舉資料庫、選委會公告、媒體：真的查無此人才 agree；查得到這個人就 disagree，note 附你找到的網址。",
        };
      }
      return {
        policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "category", "status", "source_url", "election_id", "proposed_date"])!, ["description"]) : null,
        politician: data.politicians?.[0] ? pick(data.politicians[0], POLITICIAN_BRIEF) : null,
        hint: "看這筆政見的標題與內容：它是不是「當選後要做的具體事情」？口號、行程、表態、團隊組成不是政見 → agree 移除；是政見但只是缺出處 → disagree 並在 note 說應該用 correction 補 source_url",
      };
    case "party_info": {
      // 逐個政黨對照：交上來的值、我們現有的值（空白＝還沒有）；名冊外的政黨（moi_no 空的）要特別看前身那一欄
      const have = new Map((data.parties ?? []).map((x) => [Number(x.id), x]));
      const nameOf = (id: unknown) => (have.get(Number(id))?.name as string | undefined) ?? null;
      return {
        parties: partyInfoItems(payload).map((it) => {
          const cur = have.get(it.party_id) ?? null;
          return {
            party_id: it.party_id, name: cur?.name ?? null, moi_no: cur?.moi_no ?? null, moi_status: cur?.moi_status ?? null,
            claimed: { ...it, ...(it.predecessor_id ? { predecessor_name: nameOf(it.predecessor_id) } : {}) },
            db: cur ? { valid_from: cur.valid_from ?? null, valid_to: cur.valid_to ?? null, predecessor_id: cur.predecessor_id ?? null, predecessor_name: nameOf(cur.predecessor_id) } : null,
          };
        }),
        hint: PARTY_INFO_VERIFY_HINT,
      };
    }
    case "district_seats": {
      // 逐區對照：交上來的名額、我們現有的名額（空白＝還沒有）、是不是公告上多出來的新選舉區
      const have = new Map((data.districts ?? []).map((d) => [String(d.sub_region ?? ""), d]));
      const given = (Array.isArray(payload.districts) ? payload.districts : []) as Obj[];
      const rows = given.map((d) => {
        const name = normalizeSeatDistrict(String(payload.election_type ?? ""), d.district) ?? String(d.district ?? "");
        const cur = have.get(name);
        return { district: name, claimed_seats: d.seats ?? null, db_seats: cur?.seats ?? null, ...(d.kind ? { kind: d.kind } : {}), new_district: !cur };
      });
      const givenNames = new Set(rows.map((r) => r.district));
      return {
        election_id: payload.election_id ?? null, election_type: payload.election_type ?? null, region: payload.region ?? null,
        districts: rows,
        not_in_submission: [...have.keys()].filter((k) => k && !givenNames.has(k)),
        hint: "打開 source_urls 的選舉公告（應選名額表）或選舉公報，逐區核對：claimed_seats 是提交者照公告抄的名額，db_seats 是我們現有的（空白＝還沒有）。" +
          "每一區都對得上公告、而且是這一屆這個縣市這種選舉的公告，才投 agree；任一區不符、公告上有的選舉區漏列（含原住民選舉區）、或名額看起來是拿候選人數或當選人數推的，投 disagree 並在 note 寫哪一區；" +
          "not_in_submission 是我們有、這筆沒交的選舉區，公告上確實沒有的話不影響你的票。公告打不開或看不出是哪一份，投 unsure。",
      };
    }
    case "reassign_candidacy": {
      // 參選紀錄改掛（2026-10-06）：最上層寫清楚「這票通過後會把哪一筆從誰改到誰」，再列兩人各自的參選紀錄
      const r = data.reassign;
      if (!r || !r.ctx.pe) return { hint: "找不到這筆參選紀錄（可能已被改掛或刪除）：投 unsure" };
      const { ctx, cec } = r;
      const pe = r.ctx.pe;
      const elRow = (e: Obj) => {
        const reg = (e.regions && typeof e.regions === "object" ? e.regions : {}) as Obj;
        return { politician_election_id: e.id, election_id: e.election_id, election_type: e.election_type, place: [reg.region, reg.sub_region, reg.village].filter(Boolean).join(" ") || null, election_result: resultOfCandidacyStatus(e.candidacy_status as string | null | undefined) };
      };
      const problems = reassignProblems(ctx, payload);
      return {
        target_summary: `這筆通過後會把 ${ctx.from?.name ?? "?"} 的 ${pe.election_id} ${pe.election_type ?? ""}參選紀錄（${pe.county ?? ""}，id ${pe.id}）` +
          `從 ${personLabel(ctx.from)} 改掛到 ${personLabel(ctx.to)}${ctx.to?.id ? "" : "（新建）"}，兩人記為不同人。`,
        from: { ...ctx.from, elections: r.from_elections.map(elRow) },
        to: ctx.to ? { ...ctx.to, is_new: !ctx.to.id, elections: r.to_elections.map(elRow) } : null,
        evidence: (payload.evidence ?? null) as unknown,
        cec_record: cec && cec.cec_hits === 1 ? { birth_year: cec.cec_birth_year ?? null, sub_region: cec.cec_sub_region ?? null, village: cec.cec_village ?? null, elected: cec.cec_elected ?? null } : null,
        ...(problems.length > 0 ? { server_check: problems.map((x) => x.message) } : {}),
        hint: "你要判的是**這筆參選紀錄是不是掛錯人**：打開 source_urls（中選會名冊、報導），看名冊上這一筆的出生年、推薦政黨、選舉區，跟 from（現在掛的）與 to（要改掛的）各自對不對得上；" +
          "也看兩人各自的參選紀錄（elections）是不是同一個人會走的路。cec_record 是系統從中選會名冊（已投票的屆別）找到的那一列。" +
          "改掛錯了＝把一筆參選紀錄從對的人身上拿走，**要兩台不同機器的同意票才會上線**。分辨根據站得住投 agree（note 寫你核對到的出生年／政黨／選區）；" +
          "其實是同一個人（例如真的換縣市參選，有報導）或要改掛的對象不對，投 disagree 並附反證；查不到投 unsure。",
      };
    }
    case "election_results": {
      // 整批補選舉結果（2026-10-06）：逐位列出系統跟中選會名單比的結果，對不上的排前面
      const rows = shapeResultsRows((data.results_compare ?? []) as unknown as CompareRow[]);
      const mismatched = rows.filter((r) => r.status !== "match").length;
      return {
        unit: resultsUnitLabel(payload),
        items: rows,
        items_count: rows.length,
        mismatched_count: mismatched,
        hint: "打開 source_urls 的中選會選舉資料庫那一頁（這一屆、這種選舉、這個縣市或鄉鎮的結果表），逐位核對 items：是不是同一個人、claimed（交件的當選／落選）對不對。" +
          (mismatched > 0
            ? `系統逐位比對中選會名單，有 ${mismatched} 位對不上（status 不是 match 的那幾位，status_label 寫了原因），所以這一筆沒有系統票、要兩張同意。那幾位要特別看：交件對、系統比錯了（例如我們的村里寫錯）照樣可以 agree，note 寫你怎麼確認的；交件錯了就 disagree，note 寫是哪一位、中選會實際怎麼寫。`
            : "系統已逐位比對中選會名單、每一位都對得上，所以投了系統票，你核對無誤投 agree 就會上線——這一票要真的打開那一頁，note 寫你核對了哪一頁、幾位。") +
          "任何一位當選與否寫錯、或根本不是同一個人，投 disagree 並在 note 寫是哪一位；那一頁打不開、確認不了投 unsure。",
      };
    }
    case "no_change":
      return { task: data.task ?? null, hint: "看提交者說查了哪些網址、為什麼沒有可交的東西；你自己也查一下，真的沒有就 agree（這筆會讓那個缺口 14 天不再派）" };
    case "policy_elements":
      return {
        policy: data.policy ? truncateFields(pick(data.policy, ["id", "title", "description", "status", "election_id", "source_url"])!, ["description"]) : null,
        politician: data.politicians?.[0] ? pick(data.politicians[0], POLITICIAN_BRIEF) : null,
        existing_elements: (data.elements ?? []).map((e) => pick(e, ELEMENT_FIELDS)),
        term_end: data.term_end ?? null,
        hint: POLICY_ELEMENTS_VERIFY_HINT,
      };
    case "question_answer":
      return data.task ?? {};
    default:
      return {};
  }
}

/** 多面向身份比對 dry-run（persist:false，不寫 keys、不寫 reviews）；失敗不影響派工 */
async function dryRunIdentity(supabase: SupabaseLike, payload: Obj, name: string): Promise<VerifyContextData["identity"]> {
  try {
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    // 跟落庫同一份正規化（identityInputOf），派工說不用指認、落庫卻因未指認退件的落差由此而來
    const resolution = await resolvePolitician(createSupabaseIdentityStore(supabase), identityInputOf({
      name,
      party: s(payload.party),
      region: s(payload.region),
      election_type: s(payload.election_type),
      position: s(payload.position),
      current_position: s(payload.current_position),
      birth_year: typeof payload.birth_year === "number" ? payload.birth_year : s(payload.birth_year),
      cec_cand_id: typeof payload.cec_cand_id === "number" ? payload.cec_cand_id : s(payload.cec_cand_id),
      cec_theme_id: s(payload.cec_theme_id),
    }), { persist: false });
    return { decision: resolution.decision, politician_id: resolution.politician_id ?? null, reason: resolution.reason, candidate_ids: resolution.candidates.map((c) => c.politician_id) };
  } catch (e) {
    console.error("dryRunIdentity:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 碰 DB：依 contribution_type／payload 撈驗證用資料 */
export async function fetchVerifyContext(supabase: SupabaseLike, contributionType: string, payload: Obj, contributionId?: string | null): Promise<VerifyContextData> {
  const data: VerifyContextData = {};
  // 整批補選舉結果（2026-10-06）：跟系統票同一支逐位比對（election_results_compare），驗證者看到的就是系統比的那一份
  // 參選紀錄改掛（2026-10-06）：新舊兩人與各自的參選紀錄、中選會名冊那一列（跟系統票同一支比對）
  if (contributionType === "reassign_candidacy") {
    try {
      const rc = await loadReassignContext(supabase, payload);
      const els = async (pid: string | null | undefined) => {
        if (!pid) return [] as Obj[];
        // query-bounds: ok — 一個人的參選紀錄，最多十幾屆
        const { data: rows } = await supabase.from("politician_elections")
          .select("id, election_id, election_type, candidacy_status, regions(region, sub_region, village)")
          .eq("politician_id", pid).order("election_id", { ascending: true }).limit(50);
        return (rows ?? []) as Obj[];
      };
      const [fromEls, toEls, cecRows] = await Promise.all([
        els(rc.from?.id), els(rc.to?.id),
        rc.pe ? supabase.rpc("election_result_cec_matches", { p_ids: [rc.pe.id] }) : Promise.resolve({ data: [] }),
      ]);
      data.reassign = { ctx: rc, from_elections: fromEls, to_elections: toEls, cec: (((cecRows as { data?: unknown }).data ?? []) as Obj[])[0] ?? null };
    } catch (e) {
      console.error("reassign verify context:", e instanceof Error ? e.message : String(e));
    }
  }
  if (contributionType === "election_results" && contributionId) {
    const { data: rows, error } = await supabase.rpc("election_results_compare", { p_contribution_id: contributionId });
    if (!error) data.results_compare = (rows ?? []) as Obj[];
  }
  const pid = typeof payload.politician_id === "string" ? payload.politician_id : null;
  const name = typeof payload.name === "string" ? payload.name.trim() : null;

  // 政策脈絡（#349）：動到的脈絡、要歸入或拿掉的政見、被標角色或交接的人
  if (contributionType === "lineage") {
    const ids = ["policy_ids", "detach_policy_ids"].flatMap((k) => Array.isArray(payload[k]) ? (payload[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
    const [lins, pols] = await Promise.all([
      typeof payload.lineage_id === "string" ? fetchLineagesFull(supabase, [payload.lineage_id]) : Promise.resolve([]),
      fetchPoliciesByIds(supabase, ids),
    ]);
    data.lineages = lins;
    data.lineage_policies = pols;
  }
  if ((contributionType === "lineage_participants" || contributionType === "lineage_handover") && typeof payload.lineage_id === "string") {
    const people = contributionType === "lineage_participants"
      ? (Array.isArray(payload.participants) ? payload.participants as Obj[] : []).map((x) => String(x?.politician_id ?? ""))
      : [String(payload.from_politician_id ?? ""), String(payload.to_politician_id ?? "")];
    const list = [...new Set(people.filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
    const [lins, pols, ps] = await Promise.all([
      fetchLineagesFull(supabase, [payload.lineage_id]),
      fetchLineagePolicies(supabase, payload.lineage_id),
      // query-bounds: ok — 一筆最多 MAX_PARTICIPANTS（50）位
      list.length > 0 ? supabase.from("politicians").select("*").in("id", list).limit(60) : Promise.resolve({ data: [] }),
    ]);
    data.lineages = lins;
    data.lineage_policies = pols;
    data.politicians = (ps.data ?? []) as Obj[];
  }
  if (contributionType === "lineage_link") {
    data.lineages = await fetchLineagesFull(supabase, [String(payload.upper_lineage_id ?? ""), String(payload.lower_lineage_id ?? "")]);
  }

  if (contributionType === "politician" || contributionType === "candidacy" || contributionType === "policy") {
    let q = supabase.from("politicians").select("*").limit(10);
    q = pid ? q.eq("id", pid) : q.eq("name", name ?? "");
    const { data: ps } = await q;
    data.politicians = ps ?? [];
    const ids = (data.politicians ?? []).map((p) => p.id as string);
    if (ids.length > 0 && contributionType !== "policy") {
      const { data: el } = await supabase.from("politician_elections").select("politician_id, election_id, election_type, candidacy_status, source_note").in("politician_id", ids).order("election_id", { ascending: false });
      data.elections = el ?? [];
    }
    if (ids.length === 1 && contributionType === "policy") {
      const [{ data: pol }, similar] = await Promise.all([
        supabase.from("policies").select("id, title, category, status").eq("politician_id", ids[0]).is("removed_at", null).limit(MAX_EXISTING_POLICIES),
        typeof payload.title === "string"
          ? supabase.rpc("find_similar_policies", { p_politician_id: ids[0], p_title: payload.title, p_threshold: POLICY_SIMILARITY_THRESHOLD })
          : Promise.resolve({ data: [] }),
      ]);
      data.policies = pol ?? [];
      data.similar_policies = (similar.data ?? []) as VerifyContextData["similar_policies"];
    }
    if (contributionType !== "policy" && name) {
      data.identity = await dryRunIdentity(supabase, payload, name);
      // 比對出來的候選人若不在同名清單裡（別名／改名），一併附上，讓驗證者能指認
      const missing = (data.identity?.candidate_ids ?? []).filter((id) => !ids.includes(id));
      if (missing.length > 0) {
        const [{ data: more }, { data: moreEl }] = await Promise.all([
          supabase.from("politicians").select("*").in("id", missing),
          supabase.from("politician_elections").select("politician_id, election_id, election_type, candidacy_status, source_note").in("politician_id", missing).order("election_id", { ascending: false }),
        ]);
        data.politicians = [...(data.politicians ?? []), ...(more ?? [])];
        data.elections = [...(data.elections ?? []), ...(moreEl ?? [])];
      }
    }
  }
  if (contributionType === "policy_progress") {
    const policyId = typeof payload.policy_id === "string" ? payload.policy_id : null;
    if (policyId) {
      const [pl, logs] = await Promise.all([
        supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
        supabase.from("tracking_logs").select("id, date, event, description").eq("policy_id", policyId).order("date", { ascending: false }).limit(MAX_TRACKING_LOGS),
      ]);
      data.policy = pl.data ?? null;
      data.tracking_logs = logs.data ?? [];
    }
  }
  if (contributionType === "policy_elements") {
    const policyId = typeof payload.policy_id === "string" ? payload.policy_id : null;
    if (policyId) {
      const [pl, el] = await Promise.all([
        supabase.from("policies").select("*").eq("id", policyId).maybeSingle(),
        // query-bounds: ok — 一條政見最多三列（policy_id, element 唯一）
        supabase.from("policy_elements").select("element, stated, text, deadline_date, source_url, source_locator, updated_at").eq("policy_id", policyId).limit(3),
      ]);
      const policy = (pl.data ?? null) as Obj | null;
      data.policy = policy;
      data.elements = (el.data ?? []) as Obj[];
      const pid = typeof policy?.politician_id === "string" ? policy.politician_id : null;
      const electionId = typeof policy?.election_id === "number" ? policy.election_id : null;
      if (pid) {
        const [{ data: person }, { data: pe }] = await Promise.all([
          supabase.from("politicians").select("*").eq("id", pid).maybeSingle(),
          electionId !== null
            ? supabase.from("politician_elections").select("election_type").eq("politician_id", pid).eq("election_id", electionId).limit(1).maybeSingle()
            : Promise.resolve({ data: null }),
        ]);
        data.politicians = person ? [person] : [];
        const electionType = (pe as Obj | null)?.election_type;
        if (electionId !== null && typeof electionType === "string") {
          // 卸任日跟任期表用同一支 SQL（election_term_end：吃 elections.id、看投票日與事由，補選補足剩餘任期），不在這裡另算一份（#344 第二階段 A）
          const { data: end } = await supabase.rpc("election_term_end", { p_election_id: electionId, p_election_type: electionType });
          data.term_end = typeof end === "string" ? end : null;
        }
      }
    }
  }
  if (contributionType === "merge_politician") {
    const keep = typeof payload.keep_id === "string" ? payload.keep_id : null, remove = typeof payload.remove_id === "string" ? payload.remove_id : null;
    if (keep && remove) {
      const ctx = await fetchTaskContext(supabase, "duplicate_politician", { a: { id: keep }, b: { id: remove } });
      data.pair_current = ctx.pair?.a && ctx.pair?.b ? shapeTaskCurrent("duplicate_politician", ctx) : null;
    }
  }
  if (contributionType === "adjudication") {
    const cid = typeof payload.contribution_id === "string" ? payload.contribution_id : null;
    if (cid) data.adjudicate_current = shapeTaskCurrent("adjudicate", await fetchTaskContext(supabase, "adjudicate", { contribution_id: cid }));
  }
  if (contributionType === "removal") {
    const id = typeof payload.target_id === "string" ? payload.target_id : null;
    if (id && payload.target_table === "politicians") {
      const [{ data: p }, { data: el }] = await Promise.all([
        supabase.from("politicians").select("*").eq("id", id).maybeSingle(),
        // query-bounds: ok — 一個人的參選紀錄（一屆一筆）
        supabase.from("politician_elections").select("election_id, election_type, candidacy_status, source_note").eq("politician_id", id).order("election_id", { ascending: false }).limit(50),
      ]);
      data.politicians = p ? [p] : [];
      data.elections = el ?? [];
    }
    if (id && payload.target_table === "policies") {
      const { data: pl } = await supabase.from("policies").select("*").eq("id", id).maybeSingle();
      data.policy = pl ?? null;
      const pid = (pl as Obj | null)?.politician_id;
      if (typeof pid === "string") {
        const { data: p } = await supabase.from("politicians").select("*").eq("id", pid).maybeSingle();
        data.politicians = p ? [p] : [];
      }
    }
  }
  if (contributionType === "no_change" || contributionType === "question_answer") {
    const taskId = typeof payload.task_id === "string" ? payload.task_id : null;
    const questionId = typeof payload.question_id === "string" ? payload.question_id : null;
    if (questionId) {
      data.task = shapeTaskCurrent("question", await fetchTaskContext(supabase, "question", { question_id: questionId }));
    } else if (taskId?.startsWith("auto:")) {
      const [, taskType, ...rest] = taskId.split(":");
      data.task = { task_id: taskId, task_type: taskType, target_id: rest.join(":"), source: "auto" };
    } else if (taskId) {
      const { data: t } = await supabase.from("contribution_tasks").select("id, task_type, title, description, target, source").eq("id", taskId).maybeSingle();
      data.task = t ? { task_id: taskId, ...pick(t, ["task_type", "title", "description", "target", "source"]) } : { task_id: taskId };
    }
  }
  if (contributionType === "party_info") {
    const ids = partyInfoIds(partyInfoItems(payload));
    if (ids.length > 0) {
      // query-bounds: ok — 一筆最多 5 個政黨（＋前身）
      const { data: ps } = await supabase.from("parties").select("id, name, short_name, moi_no, moi_status, valid_from, valid_to, predecessor_id").in("id", ids).limit(20);
      data.parties = (ps ?? []) as Obj[];
    }
  }
  if (contributionType === "district_seats") {
    const electionId = typeof payload.election_id === "number" ? payload.election_id : null;
    const electionType = typeof payload.election_type === "string" ? payload.election_type : null;
    const region = typeof payload.region === "string" ? payload.region : null;
    if (electionId && electionType && region) {
      // query-bounds: ok — 一個縣市一種選舉的選舉區（最多百來區）
      const { data: ds } = await supabase.from("election_districts")
        .select("sub_region, district_kind, seats, seats_basis, seats_source")
        .eq("election_id", electionId).eq("election_type", electionType).eq("region", region)
        .order("sub_region", { ascending: true }).limit(1000);
      data.districts = (ds ?? []) as Obj[];
    }
  }
  if (contributionType === "correction") {
    const table = typeof payload.target_table === "string" ? payload.target_table : null;
    const id = payload.target_id;
    if (table && id !== undefined && ["politicians", "politician_elections", "policies", "politician_offices"].includes(table)) {
      // 參選紀錄、任期 join 出人名（2026-10-01：驗證項要寫出這票改到誰）；人物另放 target_politician，target 只留那一列的欄位
      const withPerson = table === "politician_elections" || table === "politician_offices";
      const { data: t } = await supabase.from(table).select(withPerson ? "*, politicians(name, region)" : "*").eq("id", id).maybeSingle();
      if (t && withPerson) {
        const { politicians: person, ...row } = t as Obj;
        data.target = row;
        data.target_politician = person && typeof person === "object" ? person as VerifyContextData["target_politician"] : null;
      } else {
        data.target = t ?? null;
      }
    }
  }
  // 政見與進度紀錄的 source_url 來自出處表的主要出處（#347 第二階段 B-1）：驗證者看的現值跟派給代理的同一份
  await overlayPrimarySources(supabase, data as Obj);
  if (contributionType === "correction" && payload.target_table === "policies" && data.target && typeof data.target === "object") {
    overlaySourceUrl([data.target as Obj], await fetchPrimarySourceUrls(supabase, "policies", [String(payload.target_id)]));
  }
  return data;
}
