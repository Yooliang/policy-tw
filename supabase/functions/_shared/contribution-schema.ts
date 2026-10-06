/**
 * 外部貢獻（contribute／report Edge Function）的請求格式與驗證。手寫、無依賴，Deno／Node 都能跑。
 * public/skill.md 描述的就是這份 schema，改欄位要兩處一起改。
 */

import { checkSourceSet, isHttpUrl } from "./source-priority.ts";
import { isValidAgentName, isValidAgentTool, type Verdict } from "./consensus.ts";
import { MAX_CORRECTION_CHANGES, normalizeCorrection } from "./correction.ts";
import { partyInfoProblems } from "./party-info.ts";
import { isPlaceholderName, PLACEHOLDER_NAME_MSG } from "./placeholder-name.ts";
import { DISTRICT_SEAT_KINDS, DISTRICT_SEAT_TYPES, MAX_DISTRICTS_PER_SUBMISSION, MAX_SEATS_PER_DISTRICT, normalizeSeatDistrict } from "./district-seats.ts";
import { MAX_RESULTS_PER_SUBMISSION } from "./election-results.ts";
import { charLength, DEADLINE_YEAR_MAX, DEADLINE_YEAR_MIN, isRealDate, POLICY_ELEMENT_KINDS, POLICY_ELEMENT_LOCATOR_MAX, POLICY_ELEMENT_TEXT_MAX } from "./policy-elements.ts";
import {
  HANDOVER_TYPES, isOfficialUrl, isUnreadableSocial, LINEAGE_LEVELS, LINEAGE_MAX_POLICIES, LINEAGE_NOTE_MAX, LINEAGE_NOTE_MIN,
  LINEAGE_SUMMARY_MAX, LINEAGE_TITLE_MAX, LINEAGE_TITLE_MIN, LINK_NOTE_MAX, LINK_NOTE_MIN, LINK_TYPES, LOCATOR_MAX, MAX_PARTICIPANTS,
  PARTICIPANT_BASES, PARTICIPANT_NOTE_MAX, PARTICIPANT_ROLES, POLICY_ORIGINS,
} from "./lineage.ts";

/**
 * 現職存成選舉名稱（「111年直轄市議員選舉」）是早期匯入留下的錯，879 位（2026-09-25）。
 * 這個字尾在職稱裡不會出現，所以直接擋；補基本資料任務也把它當成缺（current_position_missing）。
 */
export const isElectionName = (v: unknown): boolean => typeof v === "string" && /選舉\s*$/.test(v);
const CURRENT_POSITION_NOT_ELECTION = "現職要寫職稱（例如「台北市議員」「立法委員」），不是選舉名稱（「111年直轄市議員選舉」）";

/** /next 給的 task_id 只有兩種形狀：手動任務 uuid、自動缺口 auto:<型別>:<對象> */
export const isTaskIdShape = (v: unknown): boolean =>
  typeof v === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^auto:[a-z0-9_]+:\S+$/.test(v));

// policy_elements（政見三要素，#364，2026-10-05）：DB CHECK、這份清單、skill.md、標籤四處一起加（thresholds.test 盯 CHECK）
// lineage／lineage_participants／lineage_handover／lineage_link（政策脈絡，#349，2026-10-06）：同樣四處一起加
// election_results（整批補已投票選舉的結果，2026-10-06）：同樣四處一起加
export const CONTRIBUTION_TYPES = ["politician", "candidacy", "policy", "policy_progress", "correction", "task_suggestion", "no_change", "adjudication", "question_answer", "removal", "roster_check", "merge_politician", "district_seats", "policy_elements", "lineage", "lineage_participants", "lineage_handover", "lineage_link", "party_info", "election_results"] as const;
// 2026-09-18 補上 policy_validity／election_result_missing／candidate_status_stale：這三種早就在派（自動缺口），
// 清單卻沒跟上，代理用 task_suggestion 提議這三種任務會被擋下來。資料庫的 task_type 是 TEXT、沒有限制，照樣寫得進去。
export const TASK_TYPES = ["policy_missing", "profile_gap", "policy_source_missing", "progress_stale", "candidacy_source_missing", "audit", "adjudicate", "question", "roster_check", "news_sweep", "fix_disputed", "policy_election_missing", "policy_validity", "election_result_missing", "candidate_status_stale", "duplicate_politician", "duplicate_policy", "not_running_recheck", "legacy_audit", "policy_election_mismatch", "source_mismatch", "term_policy_missing", "profile_detail_gap", "district_seats_missing", "policy_elements_missing", "deadline_due", "lineage_candidate", "handover_missing", "lineage_roles_missing", "lineage_link_candidate", "placeholder_politician", "party_info_missing", "election_results_missing", "other"] as const;
/** citizen_questions.answer／question_answers.answer 的長度界線（跟 migration 20260912000014 的 CHECK 一致） */
export const QUESTION_ANSWER_MIN = 30;
export const QUESTION_ANSWER_MAX = 4000;
export const ADJUDICATION_VERDICTS = ["uphold", "reject"] as const;
/**
 * no_change 在主張哪一件事（2026-09-21）。原本一種型別承載四種主張，其中兩種是
 * 「我沒能確認」被記成「我確認了」——legacy_audit 還會照著蓋「已核對來源」的章，
 * 而蓋完章那筆政見就永遠不再被派。分成三個值之後，「我拿不到來源」有了一個
 * 合法、填得下去的答案，代理不必為了交差去編一個打得開的網址。
 */
export const NO_CHANGE_OUTCOMES = ["confirmed", "unreachable", "not_found"] as const;
/** 身份指認：候選人物的 uuid，或 "new"（都不是，建新人物） */
export const IDENTITY_PICK_NEW = "new";
export function isIdentityPick(v: unknown): v is string {
  return v === IDENTITY_PICK_NEW || (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
}
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

export const ELECTION_TYPES = [
  "總統副總統", "立法委員", "縣市長", "縣市議員", "鄉鎮市長",
  "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長",
] as const;

export { POLICY_CATEGORIES } from "./category-map.ts";
import { categoryErrorMessage, isCanonicalCategory, POLICY_CATEGORIES } from "./category-map.ts";
export const POLICY_STATUSES = ["Campaign Pledge", "Proposed", "In Progress", "Achieved", "Stalled", "Failed"] as const;
export const CANDIDATE_STATUSES = ["confirmed", "registered", "qualified", "withdrawn", "not_running"] as const;
/**
 * correction 改參選紀錄的 candidate_status 只能改成這四種（#345，協議 1.51.0）。
 * 不收傳聞：rumored（傳聞參選）、likely（可能參選）改不進去；當選落選是選舉結果，用 candidacy 帶 election_result 補；
 * 退選落庫本來就是 not_running（apply 端把 withdrawn 落成 not_running），correction 直接寫，所以只收 not_running。
 * 改之前資料庫 CHECK 只擋拼錯，代理交 rumored／elected 都進得去。
 */
export const CORRECTION_CANDIDATE_STATUSES = ["confirmed", "registered", "qualified", "not_running"] as const;
export { ELECTION_RESULTS } from "./candidacy-result.ts";
import { ELECTION_RESULTS as ELECTION_RESULTS_LIST } from "./candidacy-result.ts";
export const CORRECTION_TABLES = ["politicians", "politician_elections", "policies", "politician_offices"] as const;
/** 任期的卸任原因（跟資料庫 politician_offices.end_reason 的 CHECK 同一份；#345） */
export const OFFICE_END_REASONS = ["term_expired", "took_other_office", "resigned", "recalled", "deceased", "removed", "other"] as const;

/** correction 改 withdrawn_after_filing 的值（#345 後續，協議 1.55.0） */
export const WITHDRAWN_AFTER_FILING_MSG =
  "withdrawn_after_filing 要是 true（登記後退選：在登記名冊上、後來宣布退選）或 false（沒登記過：不在登記名冊上、只是表態不參選），布林值不加引號";

/** correction 可改的欄位（其他欄位一律拒收，避免任意 UPDATE） */
export const CORRECTION_FIELDS: Record<(typeof CORRECTION_TABLES)[number], readonly string[]> = {
  politicians: ["name", "party", "birth_year", "current_position", "region", "sub_region", "education_level", "bio", "avatar_url"],
  // 退選前有沒有登記（#345 後續，協議 1.55.0）：true 登記後退選／false 沒登記過（表態不參選）；只在退選的紀錄上有值
  politician_elections: ["candidate_status", "position", "election_type", "withdrawn_after_filing"],
  // 任期（#345 後續）：只開放卸任日與原因——轉任的卸任日是推定的，附出處可以更正；其餘欄位由參選紀錄同步
  politician_offices: ["end_date", "end_reason"],
  // origin（政見從哪裡來，#349）：pledge 競選承諾／policy_address 施政報告／assembly 議會提案／budget 預算
  policies: ["title", "description", "category", "status", "proposed_date", "source_url", "election_id", "origin"],
};

/**
 * 可以移除的：政見（軟移除）、人物（2026-10-06 起，只收測試資料、查無此人這種——沒有政見、任期、學經歷、提問、脈絡、
 * 沒有別人併進來的人；整個人連參選紀錄一起刪、每一列整列留履歷可還原，見 apply-contribution.ts 的 politicianRemovalBlockers）。
 * 參選紀錄本身不單獨移除：參選狀態錯了用 correction。
 */
export const REMOVAL_TABLES = ["policies", "politicians"] as const;

export const MAX_BATCH = 20;
export const MAX_SOURCE_URLS = 10;
export const MIN_POLICY_DESCRIPTION = 20;
export const KNOWN_ELECTION_IDS = [2022, 2024, 2026];

/** 同名者辨識用欄位（politician／candidacy／policy 都可帶） */
export interface IdentityHints {
  politician_id?: string;
  party?: string;
  region?: string;
  birth_year?: number;
  current_position?: string;
  election_type?: string;
}

export interface ContributionInput {
  contribution_type: ContributionType;
  payload: Record<string, unknown>;
  source_urls: string[];
  note?: string;
  /** 對應 /next 的 task_id（手動任務 uuid 或 auto:<type>:<target_id>） */
  task_id?: string;
}

/** 身份第一版：agent_name＝人的代號（必填）；agent_tool＝AI 自報工具（選填，只統計）；contributor_url 選填 */
export interface Contributor {
  agent_name: string;
  agent_tool?: string;
  url?: string;
}

export interface VerifyInput {
  contribution_id: string;
  verdict: Verdict;
  evidence_url?: string;
  note?: string;
  agent_name: string;
  agent_tool?: string;
  /** politician／candidacy：指認 payload 說的是 current.identity_candidates 裡哪一位 */
  resolved_politician_id?: string;
  /** 帶指認的同意票：中選會候選人查詢 API 查這個姓名回幾筆（1.29.0） */
  cec_hits?: number;
  /** 帶指認的同意票：那些紀錄依出生年收斂成幾個人（1.29.0） */
  cec_people?: number;
}

export interface VerifyValidation {
  ok: boolean;
  errors: Array<{ path: string; message: string; code?: ValidationCode }>;
  input: VerifyInput | null;
}

const AGENT_NAME_MSG = "agent_name 必填：使用者代號（GitHub 帳號或暱稱），2～64 字，只能字母數字與 ._-，不要放模型名（模型名放 agent_tool）";
const AGENT_TOOL_MSG = "agent_tool 要是 1～64 字的字串（例：<工具>/<模型>）";

export type ValidationCode = "encoding_invalid" | "category_invalid";

export interface ValidationError {
  index: number;
  path: string;
  message: string;
  /** encoding_invalid：字串含 U+FFFD 或 C0 控制字元；category_invalid：分類不在 19 值內 */
  code?: ValidationCode;
}

export const ENCODING_INVALID_MESSAGE =
  "字串含亂碼（U+FFFD／無法以 UTF-8 解碼）或控制字元。請以 UTF-8 送出；Windows 請把 JSON 寫到檔案再用 curl --data-binary @file，不要在指令列內嵌中文。";

// U+FFFD 或 C0 控制字元（保留 \t \n \r）
const BAD_CHARS_RE = /[�\x00-\x08\x0B\x0C\x0E-\x1F]/;

/** 遞迴找出所有含亂碼／控制字元的字串欄位路徑 */
export function findEncodingProblems(value: unknown, path = ""): string[] {
  if (typeof value === "string") return BAD_CHARS_RE.test(value) ? [path || "(root)"] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => findEncodingProblems(v, `${path}[${i}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => findEncodingProblems(v, path ? `${path}.${k}` : k));
  }
  return [];
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  items: ContributionInput[];
  contributor: Contributor;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, min = 1, max = 2000): v is string => typeof v === "string" && v.trim().length >= min && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

// 提出日期是選填的：查不到就別填。填錯比留空傷害更大——留空前端會改顯示屆別，
// 填錯會讓舊屆的政見看起來像這次剛提出的。
/**
 * status 不是競選承諾（Proposed 等）的，是「任內施政承諾」：這一任當選之後才宣布（例：2024 當選的總統 2026 年宣布普發一萬），
 * 提出日期本來就晚於屆別年份，不能擋（2026-09-23 維護者：任內新提出的也要追蹤；原本這條把它們全擋掉，代理只好硬塞成競選承諾）。
 */
function isCampaignStatus(status: unknown): boolean {
  return status === undefined || status === null || status === "Campaign Pledge";
}

function validateProposedDate(value: unknown, electionId: unknown, push: (path: string, message: string) => void, status?: unknown): void {
  if (value === undefined || value === null) return;
  if (!isDate(value)) {
    push("payload.proposed_date", "要是 YYYY-MM-DD；查不到政見實際提出的日期就整個別填，不要填今天");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (value > today) {
    push("payload.proposed_date", "不能是未來日期");
    return;
  }
  // election_id 就是選舉年份，競選承諾不會在那屆選完之後才提出；任內施政承諾（status 非 Campaign Pledge）不受這條限制
  if (isInt(electionId) && Number(value.slice(0, 4)) > electionId && isCampaignStatus(status)) {
    push("payload.proposed_date", `這筆掛在 ${electionId} 年那屆選舉，競選承諾的提出日期不會晚於 ${electionId} 年；查不到就別填。若這是他這一任當選後才宣布的施政承諾，status 請填 Proposed`);
  }
}
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);
const ORIGIN_MSG = "origin 要是 pledge（競選承諾）／policy_address（施政報告、施政方針）／assembly（議會或立法院提案）／budget（預算）之一";

/** 政策脈絡（#349）：一串 uuid（不可重複），1～LINEAGE_MAX_POLICIES 個 */
function validateIdList(v: unknown, path: string, what: string, push: (path: string, message: string) => void): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > LINEAGE_MAX_POLICIES) {
    push(path, `${what}要是 1～${LINEAGE_MAX_POLICIES} 個 uuid 的陣列`);
    return [];
  }
  const ids = v.filter(isUuid);
  if (ids.length !== v.length) push(path, `${what}每個都要是 uuid（任務 target 裡的 policy_id）`);
  if (new Set(ids.map((x) => x.toLowerCase())).size !== ids.length) push(path, `${what}有重複的 id`);
  return ids.map((x) => x.toLowerCase());
}

/** 政策脈絡（#349）：地方要跟層級對得上——中央不填地方、縣市填 region、鄉鎮填 region＋sub_region */
function validateLineagePlace(nl: Obj, push: (path: string, message: string) => void): void {
  if (!oneOf(LINEAGE_LEVELS, nl.level)) {
    push("payload.new_lineage.level", "level 要是 national（中央）／county（縣市）／township（鄉鎮市區）：這件事在哪一級政府決定、執行");
    return;
  }
  const region = typeof nl.region === "string" ? nl.region.trim() : "";
  const sub = typeof nl.sub_region === "string" ? nl.sub_region.trim() : "";
  if (nl.level === "national") {
    if ((region && region !== "全國") || sub) push("payload.new_lineage.region", "中央層級的脈絡不填 region／sub_region（或 region 填「全國」）");
  } else if (!region || region.length > 20) {
    push("payload.new_lineage.region", "縣市、鄉鎮層級要填 region（縣市，例：台中市）");
  } else if (nl.level === "county" && sub) {
    push("payload.new_lineage.sub_region", "縣市層級不填 sub_region；這件事在鄉鎮公所決定、執行的話 level 填 township");
  } else if (nl.level === "township" && (!sub || sub.length > 20)) {
    push("payload.new_lineage.sub_region", "鄉鎮層級要填 sub_region（鄉鎮市區，例：大雅區）");
  }
}

function validateHints(p: Obj, push: (path: string, message: string) => void): void {
  if (p.politician_id !== undefined && !isUuid(p.politician_id)) push("payload.politician_id", "要是 uuid");
  if (p.birth_year !== undefined && !(isInt(p.birth_year) && p.birth_year >= 1900 && p.birth_year <= 2010)) push("payload.birth_year", "要是 1900～2010 的整數（西元）");
  if (p.party !== undefined && !isStr(p.party, 1, 50)) push("payload.party", "政黨要是非空字串");
  if (p.region !== undefined && !isStr(p.region, 2, 20)) push("payload.region", "縣市名要是字串（例：彰化縣）");
  if (p.current_position !== undefined && !isStr(p.current_position, 1, 200)) push("payload.current_position", "現職要是非空字串");
  else if (p.current_position !== undefined && isElectionName(p.current_position)) push("payload.current_position", CURRENT_POSITION_NOT_ELECTION);
  if (p.election_type !== undefined && !oneOf(ELECTION_TYPES, p.election_type)) push("payload.election_type", `要是 ${ELECTION_TYPES.join("／")} 之一`);
}

function validatePayload(type: ContributionType, p: Obj, push: (path: string, message: string, code?: ValidationCode) => void): void {
  // 測試資料的姓名（2026-10-06）：「測試候選人ABC」這種一看就不是人的，交件當下就擋（placeholder-name.ts）
  if ((type === "politician" || type === "candidacy") && isPlaceholderName(p.name)) push("payload.name", PLACEHOLDER_NAME_MSG);
  switch (type) {
    case "politician": {
      if (!isStr(p.name, 2, 30)) push("payload.name", "姓名必填（2～30 字）");
      validateHints(p, push);
      // current_position 與 birth_year 是 profile_gap 任務明文要補的兩欄，落庫也真的會寫
      // （apply-contribution.ts applyPolitician），卻一直沒有任何驗證——送「民國50年」或 19666 都會過。
      // 2026-09-21：payload 形狀與 schema 對帳時發現。
      const optional = ["position", "current_position", "sub_region", "education_level", "bio", "avatar_url", "slogan"];
      for (const k of optional) if (p[k] !== undefined && !isStr(p[k], 1, 5000)) push(`payload.${k}`, "要是非空字串");
      if (p.avatar_url !== undefined && !/^https:\/\//.test(String(p.avatar_url))) push("payload.avatar_url", "要是 https 網址");
      if (p.birth_year !== undefined && !(isInt(p.birth_year) && p.birth_year >= 1900 && p.birth_year <= new Date().getUTCFullYear())) {
        push("payload.birth_year", "出生年要是西元四位數整數（例：1975），不是民國年也不是文字");
      }
      for (const k of ["education", "experience"]) {
        if (p[k] !== undefined && !(Array.isArray(p[k]) && (p[k] as unknown[]).every((s) => isStr(s, 1, 200)))) push(`payload.${k}`, "要是字串陣列");
      }
      break;
    }
    case "candidacy": {
      if (!isUuid(p.politician_id) && !isStr(p.name, 2, 30)) push("payload.name", "要給 politician_id 或姓名");
      if (!(isInt(p.election_id) && KNOWN_ELECTION_IDS.includes(p.election_id))) push("payload.election_id", `election_id 要是 ${KNOWN_ELECTION_IDS.join("／")}（就是選舉年份）`);
      if (!oneOf(ELECTION_TYPES, p.election_type)) push("payload.election_type", `election_type 必填，要是 ${ELECTION_TYPES.join("／")} 之一`);
      if (!isStr(p.region, 2, 20)) push("payload.region", "參選縣市必填（例：彰化縣；總統填「全國」）");
      if (!oneOf(CANDIDATE_STATUSES, p.candidate_status)) push("payload.candidate_status", `candidate_status 必填，要是 ${CANDIDATE_STATUSES.join("／")} 之一`);
      validateHints({ ...p, election_type: undefined }, push);
      if (p.position !== undefined && !isStr(p.position, 1, 100)) push("payload.position", "要是非空字串");
      // 選區文字驗證只管「有沒有給、是不是字串」；統一寫法（第NN選舉區）與是否存在於名冊，
      // 是 contribute-handler.ts 接資料庫後才做的事（normalizeCandidacyDistrictField／checkElectoralDistrict）
      if (p.electoral_district !== undefined && !isStr(p.electoral_district, 1, 100)) push("payload.electoral_district", "要是非空字串");
      if (p.cand_no !== undefined && !(isInt(p.cand_no) && p.cand_no > 0)) push("payload.cand_no", "號次要是正整數");
      // election_result_missing 任務要補的結果：選填，但給了就要對（2026-09-19 前沒驗也沒寫進去）
      if (p.election_result !== undefined && !oneOf(ELECTION_RESULTS_LIST, p.election_result)) push("payload.election_result", "election_result 要是 elected／not_elected 之一");
      // 得票數、得票率不收（#345）：不寫進去，也就不驗格式——為一個會被略過的欄位把整筆擋下來沒道理；回覆會講一聲（voteFieldsNotice）
      break;
    }
    case "policy": {
      if (!isUuid(p.politician_id) && !isStr(p.name, 2, 30)) push("payload.name", "要給 politician_id 或政治人物姓名");
      if (!isStr(p.title, 4, 200)) push("payload.title", "政見標題必填（4～200 字）");
      if (!isStr(p.description, MIN_POLICY_DESCRIPTION, 5000)) push("payload.description", `政見內容必填（至少 ${MIN_POLICY_DESCRIPTION} 字，寫清楚承諾了什麼）`);
      if (!isCanonicalCategory(p.category)) push("payload.category", categoryErrorMessage(p.category), "category_invalid");
      if (p.status !== undefined && !oneOf(POLICY_STATUSES, p.status)) push("payload.status", `要是 ${POLICY_STATUSES.join("／")} 之一`);
      if (p.election_id !== undefined && !(isInt(p.election_id) && KNOWN_ELECTION_IDS.includes(p.election_id))) push("payload.election_id", `要是 ${KNOWN_ELECTION_IDS.join("／")}`);
      validateProposedDate(p.proposed_date, p.election_id, push, p.status);
      validateHints(p, push);
      // 政見從哪裡來（#349，協議 1.52.0；照日本站 policy_origin）：選填，不給的話競選承諾由資料庫自動標 pledge
      if (p.origin !== undefined && !oneOf(POLICY_ORIGINS, p.origin)) push("payload.origin", ORIGIN_MSG);
      break;
    }
    case "policy_progress": {
      if (!isUuid(p.policy_id) && !(isStr(p.policy_title, 2, 200) && (isUuid(p.politician_id) || isStr(p.name, 2, 30)))) {
        push("payload.policy_id", "要給 policy_id，或 policy_title＋（politician_id 或 name）");
      }
      if (!oneOf(POLICY_STATUSES, p.status)) push("payload.status", `status 必填，要是 ${POLICY_STATUSES.join("／")} 之一`);
      if (p.progress !== undefined && !(isInt(p.progress) && p.progress >= 0 && p.progress <= 100)) push("payload.progress", "要是 0～100 的整數");
      if (!isStr(p.note, 10, 3000)) push("payload.note", "進度說明必填（至少 10 字：做了什麼、依據哪份文件）");
      if (!isDate(p.date)) push("payload.date", "事件日期必填，YYYY-MM-DD");
      break;
    }
    case "policy_elements": {
      // 政見三要素（#364，協議 1.50.0）：一筆交一條政見的 1～3 個要素，同一個要素只交一次。
      // stated=false（查過原文、沒寫）也是答案——畫面顯示「未說明」，跟「還沒有人查」（沒有列）分開。
      // 不幫候選人補數字、不換算、不評價：text 只寫原文的事實，沒寫就不填。
      if (!isUuid(p.policy_id)) push("payload.policy_id", "policy_id 必填（這條政見的 uuid，任務的 target.policy_id）");
      if (!Array.isArray(p.elements) || p.elements.length === 0 || p.elements.length > POLICY_ELEMENT_KINDS.length) {
        push("payload.elements", "elements 必填：1～3 個要素，每個是一個物件（target 數值目標／deadline 達成期限／funding 財源）");
        break;
      }
      const seenKinds = new Set<string>();
      (p.elements as unknown[]).forEach((raw, i) => {
        const at = `payload.elements[${i}]`;
        if (!isObj(raw)) { push(at, "每個要素要是物件：{element, stated, text, deadline_date, source_locator, source_url}"); return; }
        const e = raw;
        for (const k of ["text", "deadline_date", "source_locator", "source_url"]) {
          if (e[k] !== undefined && e[k] !== null && typeof e[k] !== "string") push(`${at}.${k}`, "要是字串");
        }
        if (!oneOf(POLICY_ELEMENT_KINDS, e.element)) push(`${at}.element`, "element 要是 target（數值目標）／deadline（達成期限）／funding（財源）之一");
        else if (seenKinds.has(e.element)) push(`${at}.element`, `${e.element} 重複了：同一條政見同一個要素只交一次`);
        else seenKinds.add(e.element);
        if (typeof e.stated !== "boolean") {
          push(`${at}.stated`, "stated 必填：true＝原文有寫；false＝查過原文、沒寫（畫面會顯示「未說明」）");
        } else if (e.stated) {
          const text = typeof e.text === "string" ? e.text.trim() : "";
          if (!text) push(`${at}.text`, "原文有寫（stated=true）就要填 text：照原文寫，不改寫、不補數字");
          else if (charLength(text) > POLICY_ELEMENT_TEXT_MAX) push(`${at}.text`, `text 最多 ${POLICY_ELEMENT_TEXT_MAX} 字，只寫這個要素本身（原句太長就只留寫到數字、期限或財源的那一段）`);
        } else if (typeof e.text === "string" && e.text.trim()) {
          push(`${at}.text`, "stated=false（原文沒寫）時 text 不要填——沒寫就是沒寫，不要幫他補或寫「未說明」");
        }
        if (e.deadline_date !== undefined && e.deadline_date !== null && e.deadline_date !== "") {
          if (e.element !== "deadline" || e.stated !== true) {
            push(`${at}.deadline_date`, "只有原文寫了的達成期限（element=deadline、stated=true）才填 deadline_date");
          } else if (!isRealDate(e.deadline_date) || Number(e.deadline_date.slice(0, 4)) < DEADLINE_YEAR_MIN || Number(e.deadline_date.slice(0, 4)) > DEADLINE_YEAR_MAX) {
            push(`${at}.deadline_date`, "要是西元 YYYY-MM-DD 的真實日期。會計年度是曆年：「2028 年前」填 2028-12-31；換不成日期（例：「盡快」「兩年內」而原文沒寫起算日）就整個不要填");
          }
        }
        const locator = typeof e.source_locator === "string" ? e.source_locator.trim() : "";
        if (!locator || charLength(locator) > POLICY_ELEMENT_LOCATOR_MAX) {
          push(`${at}.source_locator`, `source_locator 必填（1～${POLICY_ELEMENT_LOCATOR_MAX} 字）：原句在原文的位置，例如「公報第 2 頁〈交通〉第 3 點」「政見發表會 00:12:30」；stated=false 也要寫你查的是原文哪一段`);
        }
        if (e.source_url !== undefined && e.source_url !== null && e.source_url !== "" && !isHttpUrl(e.source_url)) {
          push(`${at}.source_url`, "source_url 要是 http(s) 網址，而且是這筆 source_urls 的其中一個（這個要素出自哪一份原文）");
        }
      });
      break;
    }
    case "lineage": {
      // 政策脈絡（#349，協議 1.52.0）：建一條新的（new_lineage）或歸入既有的（lineage_id），把同一件事的政見掛上去。
      // 一條脈絡＝一件事在某一層級、某一地方；判斷「是不是同一件事」是這筆的核心，note 要寫得出依據。
      const hasId = p.lineage_id !== undefined && p.lineage_id !== null && p.lineage_id !== "";
      const hasNew = p.new_lineage !== undefined && p.new_lineage !== null;
      if (hasId === hasNew) push("payload.lineage_id", "lineage_id（歸入既有的脈絡）與 new_lineage（建一條新的）二擇一");
      else if (hasId && !isUuid(p.lineage_id)) push("payload.lineage_id", "lineage_id 要是 uuid（任務 target.existing_lineages 裡的 lineage_id）");
      const attach = p.policy_ids === undefined ? [] : validateIdList(p.policy_ids, "payload.policy_ids", "policy_ids ", push);
      const detach = p.detach_policy_ids === undefined ? [] : validateIdList(p.detach_policy_ids, "payload.detach_policy_ids", "detach_policy_ids ", push);
      if (attach.some((id) => detach.includes(id))) push("payload.detach_policy_ids", "同一條政見不能同時歸入又拿掉");
      for (const k of ["title", "summary", "category"]) {
        if (p[k] !== undefined && typeof p[k] !== "string") push(`payload.${k}`, "要是字串");
      }
      const checkTitle = (v: unknown, path: string) => {
        const t = typeof v === "string" ? v.trim() : "";
        if (charLength(t) < LINEAGE_TITLE_MIN || charLength(t) > LINEAGE_TITLE_MAX) push(path, `標題 ${LINEAGE_TITLE_MIN}～${LINEAGE_TITLE_MAX} 字：這件事的名稱，中性、照事實（例：「台中捷運藍線」「國定假日法制化」），不要寫評價或口號`);
      };
      const checkSummary = (v: unknown, path: string) => {
        const t = typeof v === "string" ? v.trim() : "";
        if (!t || charLength(t) > LINEAGE_SUMMARY_MAX) push(path, `摘要 1～${LINEAGE_SUMMARY_MAX} 字：一兩句話講這件事是什麼，只寫事實`);
      };
      if (hasNew) {
        const nl = isObj(p.new_lineage) ? p.new_lineage : null;
        if (!nl) {
          push("payload.new_lineage", "new_lineage 要是物件：{title, summary, category, level, region, sub_region}");
        } else {
          for (const k of ["title", "summary", "category", "level", "region", "sub_region"]) {
            if (nl[k] !== undefined && nl[k] !== null && typeof nl[k] !== "string") push(`payload.new_lineage.${k}`, "要是字串");
          }
          checkTitle(nl.title, "payload.new_lineage.title");
          if (nl.summary !== undefined && nl.summary !== null) checkSummary(nl.summary, "payload.new_lineage.summary");
          if (!isCanonicalCategory(nl.category)) push("payload.new_lineage.category", categoryErrorMessage(nl.category), "category_invalid");
          validateLineagePlace(nl, push);
          // 一條脈絡至少要有兩條政見（前後任或同級多人）；中央層級的法案常常只有一位在我們這裡有政見、其他人是共同提案或連署，一條就可以建
          const min = nl.level === "national" ? 1 : 2;
          if (attach.length < min) push("payload.policy_ids", `建新脈絡要附 policy_ids：至少 ${min} 條政見（只有一條政見、也沒有別人或別屆談同一件事的，不要建脈絡）`);
        }
        if (detach.length > 0) push("payload.detach_policy_ids", "新建的脈絡沒有政見可拿掉");
        for (const k of ["title", "summary", "category"]) if (p[k] !== undefined) push(`payload.${k}`, `建新脈絡時 ${k} 放在 new_lineage 裡`);
      } else if (hasId) {
        const edits = ["title", "summary", "category"].filter((k) => p[k] !== undefined);
        if (attach.length === 0 && detach.length === 0 && edits.length === 0) {
          push("payload.policy_ids", "歸入既有脈絡要帶 policy_ids（要掛上去的政見）；或用 detach_policy_ids 拿掉歸錯的、用 title／summary／category 更正脈絡本身");
        }
        if (p.title !== undefined) checkTitle(p.title, "payload.title");
        if (p.summary !== undefined) checkSummary(p.summary, "payload.summary");
        if (p.category !== undefined && !isCanonicalCategory(p.category)) push("payload.category", categoryErrorMessage(p.category), "category_invalid");
      }
      if (!isStr(p.note, LINEAGE_NOTE_MIN, LINEAGE_NOTE_MAX)) push("payload.note", `note 必填（${LINEAGE_NOTE_MIN}～${LINEAGE_NOTE_MAX} 字）：憑什麼判定這些是同一件事——同一個計畫名稱、同一個地點、同一部法律或同一筆預算，引用原文或報導`);
      break;
    }
    case "lineage_participants": {
      // 標參與角色（#349，協議 1.52.0）：角色以官方紀錄為準；本人自述只標「本人宣稱」；臉書讀不到不收。
      if (!isUuid(p.lineage_id)) push("payload.lineage_id", "lineage_id 必填（這條脈絡的 uuid，任務的 target.lineage_id）");
      if (!Array.isArray(p.participants) || p.participants.length === 0 || p.participants.length > MAX_PARTICIPANTS) {
        push("payload.participants", `participants 必填：1～${MAX_PARTICIPANTS} 項，每項 {politician_id, role, basis, source_locator, source_url, note}`);
        break;
      }
      const seen = new Set<string>();
      (p.participants as unknown[]).forEach((raw, i) => {
        const at = `payload.participants[${i}]`;
        if (!isObj(raw)) { push(at, "每一項要是物件：{politician_id, role, basis, source_locator, source_url, note}"); return; }
        for (const k of ["politician_id", "role", "basis", "source_locator", "source_url", "note"]) {
          if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== "string") push(`${at}.${k}`, "要是字串");
        }
        if (!isUuid(raw.politician_id)) push(`${at}.politician_id`, "politician_id 必填（人物 uuid）；人物還不在網站上的先不要標");
        if (!oneOf(PARTICIPANT_BASES, raw.basis)) push(`${at}.basis`, "basis 要是 official_record（官方紀錄：立法院議事系統、議會網站）或 self_claim（本人宣稱：本人官網、答辯書、受訪）");
        const remove = raw.remove === true;
        if (raw.remove !== undefined && typeof raw.remove !== "boolean") push(`${at}.remove`, "remove 要是 true（拿掉這個人這一種依據的角色）或不填");
        if (!remove && !oneOf(PARTICIPANT_ROLES, raw.role)) push(`${at}.role`, "role 要是 proposer（提案）／co_proposer（共同提案）／cosigner（連署）／advocate（主張推動）之一");
        const locator = typeof raw.source_locator === "string" ? raw.source_locator.trim() : "";
        if (!locator || charLength(locator) > LOCATOR_MAX) push(`${at}.source_locator`, `source_locator 必填（1～${LOCATOR_MAX} 字）：議案編號、關係文書第幾頁、會議紀錄的日期與案由`);
        if (raw.source_url !== undefined && raw.source_url !== null && raw.source_url !== "" && !isHttpUrl(raw.source_url)) push(`${at}.source_url`, "source_url 要是 http(s) 網址，而且是這筆 source_urls 的其中一個");
        if (raw.note !== undefined && raw.note !== null && !isStr(raw.note, 1, PARTICIPANT_NOTE_MAX)) push(`${at}.note`, `note 最多 ${PARTICIPANT_NOTE_MAX} 字`);
        const key = `${String(raw.politician_id).toLowerCase()}|${String(raw.basis)}`;
        if (isUuid(raw.politician_id) && seen.has(key)) push(`${at}.politician_id`, "同一個人同一種依據只能出現一次（官方紀錄一個角色、本人宣稱一個角色）");
        seen.add(key);
      });
      break;
    }
    case "lineage_handover": {
      // 記交接（#349，協議 1.52.0）：脈絡裡從前一任到下一任，這件事怎麼被處理。中止（stop）要兩台不同機器的驗證票。
      if (!isUuid(p.lineage_id)) push("payload.lineage_id", "lineage_id 必填（這條脈絡的 uuid，任務的 target.lineage_id）");
      if (!isUuid(p.from_politician_id)) push("payload.from_politician_id", "from_politician_id 必填（前一任的人物 uuid）");
      if (!isUuid(p.to_politician_id)) push("payload.to_politician_id", "to_politician_id 必填（下一任的人物 uuid）");
      for (const k of ["from_election_id", "to_election_id"] as const) {
        if (p[k] !== undefined && p[k] !== null && !(isInt(p[k]) && KNOWN_ELECTION_IDS.includes(p[k] as number))) push(`payload.${k}`, `要是 ${KNOWN_ELECTION_IDS.join("／")}（那一任是哪一屆選出的）；那一屆不在網站上（2018 以前）就不填`);
      }
      if (isUuid(p.from_politician_id) && isUuid(p.to_politician_id) && p.from_politician_id.toLowerCase() === p.to_politician_id.toLowerCase()
        && (p.from_election_id ?? null) === (p.to_election_id ?? null)) {
        push("payload.to_politician_id", "前後兩任是同一人同一屆：交接要是不同人，或同一人連任的不同屆");
      }
      if (!oneOf(HANDOVER_TYPES, p.handover_type)) push("payload.handover_type", "handover_type 要是 keep（接手）／pivot（轉向）／shrink（縮小）／stop（中止）／resume（重新開始）之一");
      if (p.decided_on !== undefined && p.decided_on !== null && p.decided_on !== "") {
        const today = new Date().toISOString().slice(0, 10);
        if (!isRealDate(p.decided_on) || p.decided_on > today) push("payload.decided_on", "decided_on 要是 YYYY-MM-DD、不能是未來；判定依據的日期（預算刪除、議會決議、宣布停工的日子），不知道就不填");
      }
      if (!isStr(p.note, LINK_NOTE_MIN, LINK_NOTE_MAX)) push("payload.note", `note 必填（${LINK_NOTE_MIN}～${LINK_NOTE_MAX} 字）：依據哪份文件、文件怎麼說（中止要寫出誰、哪份文件說停止或終止）`);
      for (const k of ["source_locator", "source_url"]) {
        if (p[k] !== undefined && p[k] !== null && typeof p[k] !== "string") push(`payload.${k}`, "要是字串");
      }
      const locator = typeof p.source_locator === "string" ? p.source_locator.trim() : "";
      if (!locator || charLength(locator) > LOCATOR_MAX) push("payload.source_locator", `source_locator 必填（1～${LOCATOR_MAX} 字）：依據在出處的哪裡（預算書第幾頁、議事錄日期與案由、報導哪一段）`);
      if (p.source_url !== undefined && p.source_url !== null && p.source_url !== "" && !isHttpUrl(p.source_url)) push("payload.source_url", "source_url 要是 http(s) 網址，而且是這筆 source_urls 的其中一個");
      break;
    }
    case "lineage_link": {
      // 記脈絡關聯（#349，協議 1.52.0）：上下級是不同的脈絡，互相關聯。上級要在下級的上一層（落庫再對一次）。
      if (!isUuid(p.upper_lineage_id)) push("payload.upper_lineage_id", "upper_lineage_id 必填（上一級那條脈絡的 uuid）");
      if (!isUuid(p.lower_lineage_id)) push("payload.lower_lineage_id", "lower_lineage_id 必填（下一級那條脈絡的 uuid）");
      if (isUuid(p.upper_lineage_id) && isUuid(p.lower_lineage_id) && p.upper_lineage_id.toLowerCase() === p.lower_lineage_id.toLowerCase()) {
        push("payload.lower_lineage_id", "上下級要是兩條不同的脈絡");
      }
      if (!oneOf(LINK_TYPES, p.link_type)) push("payload.link_type", "link_type 要是 top_down（上級立法或補助，下級執行）或 bottom_up（下級爭取，上級採納）");
      if (!isStr(p.note, LINK_NOTE_MIN, LINK_NOTE_MAX)) push("payload.note", `note 必填（${LINK_NOTE_MIN}～${LINK_NOTE_MAX} 字）：哪一份法規、補助核定或執行計畫把兩件事連起來`);
      for (const k of ["source_locator", "source_url"]) {
        if (p[k] !== undefined && p[k] !== null && typeof p[k] !== "string") push(`payload.${k}`, "要是字串");
      }
      const locator = typeof p.source_locator === "string" ? p.source_locator.trim() : "";
      if (!locator || charLength(locator) > LOCATOR_MAX) push("payload.source_locator", `source_locator 必填（1～${LOCATOR_MAX} 字）：依據在出處的哪裡（條文、核定公文字號、計畫書頁碼）`);
      if (p.source_url !== undefined && p.source_url !== null && p.source_url !== "" && !isHttpUrl(p.source_url)) push("payload.source_url", "source_url 要是 http(s) 網址，而且是這筆 source_urls 的其中一個");
      break;
    }
    case "roster_check": {
      // 回報「我清查過某縣市某選舉的名單」。它不改核心資料，但會讓那個縣市的清查任務
      // 七天內不再派，所以要求附得出官方名單網址；查不到就讓 cec_count 留空並說明。
      if (!(isInt(p.election_id) && KNOWN_ELECTION_IDS.includes(p.election_id))) push("payload.election_id", `election_id 要是 ${KNOWN_ELECTION_IDS.join("／")}`);
      if (!isStr(p.region, 2, 20)) push("payload.region", "region 必填（任務 target 裡的縣市，原樣帶回）");
      if (!oneOf(ELECTION_TYPES, p.election_type)) push("payload.election_type", `election_type 要是 ${ELECTION_TYPES.join("／")} 之一`);
      if (p.cec_count !== undefined && p.cec_count !== null && !(isInt(p.cec_count) && p.cec_count >= 0)) push("payload.cec_count", "中選會名單人數要是 0 或正整數；查不到就整個不要填");
      if (p.ours_count !== undefined && !(isInt(p.ours_count) && p.ours_count >= 0)) push("payload.ours_count", "要是 0 或正整數");
      if (p.submitted !== undefined && !(isInt(p.submitted) && p.submitted >= 0)) push("payload.submitted", "要是 0 或正整數");
      if (!isStr(p.note, 10, 2000)) push("payload.note", "note 必填（至少 10 字）：說明你打開了哪個名單、比對結果如何、補了誰");
      break;
    }
    case "party_info": {
      // 政黨資訊（#346 第二階段，協議 1.56.0）：改名（前身、名稱起訖）、解散日、名冊外政黨的對應。格式規則在 party-info.ts
      for (const problem of partyInfoProblems(p)) push(problem.path, problem.message);
      break;
    }
    case "district_seats": {
      // 應選名額（#344，2026-10-06）：一個縣市、一種選舉，照選舉公告把每個選舉區的名額交上來。
      // 名額只能照公告抄——候選人數、當選人數都不是名額（同額不足、無人登記的選舉區對不上）。
      if (!(isInt(p.election_id) && KNOWN_ELECTION_IDS.includes(p.election_id))) push("payload.election_id", `election_id 要是 ${KNOWN_ELECTION_IDS.join("／")}（任務 target 原樣帶回）`);
      if (!oneOf(DISTRICT_SEAT_TYPES, p.election_type)) push("payload.election_type", `election_type 要是 ${DISTRICT_SEAT_TYPES.join("／")} 之一（名額法律定死的首長與立委不用交）`);
      if (!isStr(p.region, 2, 20)) push("payload.region", "region 必填（任務 target 裡的縣市，原樣帶回）");
      if (!Array.isArray(p.districts) || p.districts.length === 0 || p.districts.length > MAX_DISTRICTS_PER_SUBMISSION) {
        push("payload.districts", `districts 必填：公告上這個縣市每個選舉區一項 {district, seats}（1～${MAX_DISTRICTS_PER_SUBMISSION} 項）`);
      } else {
        const seen = new Set<string>();
        (p.districts as unknown[]).forEach((d, i) => {
          const item = (d && typeof d === "object" ? d : {}) as Obj;
          const name = normalizeSeatDistrict(String(p.election_type ?? ""), item.district);
          if (!name) push(`payload.districts[${i}].district`, "選舉區寫法認不出來：議員寫「第01選舉區」，代表寫「麥寮鄉第01選舉區」（一個鄉鎮只有一區的寫「蘭嶼鄉選舉區」）");
          else if (seen.has(name)) push(`payload.districts[${i}].district`, `${name} 重複了`);
          else seen.add(name);
          if (!(isInt(item.seats) && item.seats >= 1 && item.seats <= MAX_SEATS_PER_DISTRICT)) push(`payload.districts[${i}].seats`, `名額要是 1～${MAX_SEATS_PER_DISTRICT} 的整數（照公告的應選名額，不是候選人數）`);
          if (item.kind !== undefined && !oneOf(DISTRICT_SEAT_KINDS, item.kind)) push(`payload.districts[${i}].kind`, `kind 要是 ${DISTRICT_SEAT_KINDS.join("／")} 之一（一般選舉區不用填）`);
        });
      }
      if (p.note !== undefined && !isStr(p.note, 1, 2000)) push("payload.note", "要是非空字串");
      break;
    }
    case "election_results": {
      // 整批補已投票選舉的結果（2026-10-06）：一個單位（屆別×選舉×縣市，村里長與代表到鄉鎮）一筆，items 每位一項。
      // 核對不了或不是同一個人的不要放進 items——系統票是「每一位都對得上中選會名單」才投，放一位猜的進來整批就少一票。
      if (!(isInt(p.election_id) && KNOWN_ELECTION_IDS.includes(p.election_id))) push("payload.election_id", `election_id 要是 ${KNOWN_ELECTION_IDS.join("／")}（任務 target 原樣帶回）`);
      if (!oneOf(ELECTION_TYPES, p.election_type)) push("payload.election_type", `election_type 要是 ${ELECTION_TYPES.join("／")} 之一（任務 target 原樣帶回）`);
      if (!isStr(p.region, 2, 20)) push("payload.region", "region 必填（任務 target 裡的縣市，原樣帶回）");
      if (p.sub_region !== undefined && p.sub_region !== null && !isStr(p.sub_region, 1, 20)) push("payload.sub_region", "sub_region 要是鄉鎮市區名稱（任務 target 有才帶）");
      if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > MAX_RESULTS_PER_SUBMISSION) {
        push("payload.items", `items 必填：這個單位你核對過的每一位一項 {politician_election_id, election_result}（1～${MAX_RESULTS_PER_SUBMISSION} 項）`);
      } else {
        const seen = new Set<number>();
        (p.items as unknown[]).forEach((raw, i) => {
          const at = `payload.items[${i}]`;
          if (!isObj(raw)) { push(at, "每一項要是物件：{politician_election_id, election_result}"); return; }
          const itemKeys = new Set<string>();
          for (const k of ["politician_election_id", "election_result"]) itemKeys.add(k);
          for (const k of Object.keys(raw)) {
            if (!itemKeys.has(k)) push(`${at}.${k}`, `每一項只收 politician_election_id 與 election_result，${k} 不收（參選狀態、地區、姓名不在這一件改）`);
          }
          const id = raw.politician_election_id;
          if (!(isInt(id) && id > 0)) push(`${at}.politician_election_id`, "politician_election_id 要是正整數（current.items 裡那一位的參選紀錄 id）");
          else if (seen.has(id)) push(`${at}.politician_election_id`, `${id} 重複了`);
          else seen.add(id);
          if (!oneOf(ELECTION_RESULTS_LIST, raw.election_result)) push(`${at}.election_result`, "election_result 要是 elected（當選）或 not_elected（落選）");
        });
      }
      if (p.note !== undefined && !isStr(p.note, 1, 2000)) push("payload.note", "要是非空字串（沒放進 items 的是哪幾位、為什麼）");
      break;
    }
    case "removal": {
      // 移除是軟移除：資料從網站消失但留著、可以復原。所以要求的是「講清楚為什麼不該存在」，
      // 不是要求你附一個證明它不存在的來源——最常見的移除理由就是查遍了找不到任何來源。
      if (!oneOf(REMOVAL_TABLES, p.target_table)) push("payload.target_table", `目前只能移除 ${REMOVAL_TABLES.join("／")}`);
      if (!isUuid(p.target_id)) push("payload.target_id", "target_id 要是該筆資料的 uuid");
      if (!isStr(p.reason, 20, 2000)) push("payload.reason", "reason 必填（至少 20 字）：說清楚這筆為什麼不該存在，例如「這是參選表態不是政見」「查遍官方與媒體都沒有這個人」");
      break;
    }
    case "merge_politician": {
      // 同名人物：same_person=true → keep_id 保留、remove_id 併入（軟合併）；false → 記「不同人」，任務不再派。
      // 兩種都要理由與來源（中選會候選人資料庫、官方簡介）；3 票＋系統票（Jev same_person）
      if (!isUuid(p.keep_id)) push("payload.keep_id", "keep_id 必填（保留的那筆 uuid）");
      if (!isUuid(p.remove_id)) push("payload.remove_id", "remove_id 必填（併入的那筆 uuid）");
      if (isUuid(p.keep_id) && isUuid(p.remove_id) && p.keep_id === p.remove_id) push("payload.remove_id", "keep_id 與 remove_id 不能是同一筆");
      if (typeof p.same_person !== "boolean") push("payload.same_person", "same_person 必填：true＝同一人（合併）、false＝不同人");
      if (!isStr(p.reason, 20, 2000)) push("payload.reason", "reason 必填（≥20 字：查了哪裡、為什麼是／不是同一人）");
      break;
    }
    case "adjudication": {
      // 裁決一筆 disputed 的貢獻：uphold＝原貢獻正確、reject＝原貢獻有誤；3 票同向定案
      if (!isUuid(p.contribution_id)) push("payload.contribution_id", "contribution_id 必填（被裁決的貢獻 uuid，在任務的 target.contribution_id）");
      if (!oneOf(ADJUDICATION_VERDICTS, p.verdict)) push("payload.verdict", "verdict 要是 uphold（原貢獻正確）或 reject（原貢獻有誤）");
      if (!isStr(p.reason, 20, 2000)) push("payload.reason", "reason 必填（≥20 字：看了哪些來源、為什麼站這一邊）");
      if (!(Array.isArray(p.checked_urls) && p.checked_urls.length > 0 && (p.checked_urls as unknown[]).every((u) => typeof u === "string" && /^https?:\/\/\S+$/.test(u)))) push("payload.checked_urls", "checked_urls 必填：你實際打開核對過的網址（http(s) 陣列）");
      if (p.resolved_politician_id !== undefined && !isIdentityPick(p.resolved_politician_id)) push("payload.resolved_politician_id", "要是 uuid 或 \"new\"");
      break;
    }
    case "question_answer": {
      // 公民提問的答案：question_id 指哪一題，answer 是內容本身；來源網址走通用規則（見下方 rawList 驗證）
      if (!isUuid(p.question_id)) push("payload.question_id", "question_id 必填（uuid，任務 target.question_id）");
      if (!isStr(p.answer, QUESTION_ANSWER_MIN, QUESTION_ANSWER_MAX)) push("payload.answer", `answer 必填（${QUESTION_ANSWER_MIN}～${QUESTION_ANSWER_MAX} 字，附出處，不要只寫結論）`);
      break;
    }
    case "no_change": {
      // 查完發現與資料庫一致：只關任務、不改資料；checked_urls 就是驗證者要核對的來源
      if (!isStr(p.task_id, 1, 160)) push("payload.task_id", "task_id 必填（/next 給的 task_id）");
      // 2026-09-25：有代理自己編了「李玫-新竹市-2026縣市議員」當 task_id，收下後落庫關任務時才炸（uuid 格式錯），重試三次退件
      else if (!isTaskIdShape(p.task_id)) push("payload.task_id", "task_id 要照抄 /next 給的值：手動任務是 uuid，自動缺口是 auto:<型別>:<對象 id>；不要自己組");
      if (!oneOf(NO_CHANGE_OUTCOMES, p.outcome)) {
        push("payload.outcome", "outcome 必填：confirmed（來源支持、資料無誤）／unreachable（拿不到來源內容，未能確認）／not_found（公開資料就是沒有）。拿不到來源就填 unreachable，不要填 confirmed——只有 confirmed 會把資料標成已核對");
      }
      if (!(Array.isArray(p.checked_urls) && p.checked_urls.length > 0 && (p.checked_urls as unknown[]).every((u) => typeof u === "string" && /^https?:\/\/\S+$/.test(u)))) push("payload.checked_urls", "checked_urls 必填：你實際打開核對過的網址（http(s) 陣列）");
      if (!isStr(p.finding, 10, 2000)) push("payload.finding", "finding 必填（≥10 字：核對了什麼、為什麼判定沒有異動）");
      break;
    }
    case "task_suggestion": {
      if (!isStr(p.title, 10, 100)) push("payload.title", "title 必填（10～100 字：一句話說要查什麼）");
      if (!isStr(p.description, 20, 2000)) push("payload.description", "description 必填（≥20 字：為什麼該查、預期能查到什麼）");
      if (p.task_type !== undefined && !oneOf(TASK_TYPES, p.task_type)) push("payload.task_type", `task_type 要是 ${TASK_TYPES.join("／")} 之一`);
      if (p.target_politician_id !== undefined && !isUuid(p.target_politician_id)) push("payload.target_politician_id", "要是 uuid");
      if (p.target_policy_id !== undefined && !isUuid(p.target_policy_id)) push("payload.target_policy_id", "要是 uuid");
      if (p.region !== undefined && !isStr(p.region, 2, 20)) push("payload.region", "縣市名要是字串");
      if (p.hint_sources !== undefined && !(Array.isArray(p.hint_sources) && (p.hint_sources as unknown[]).every((s) => isStr(s, 1, 300)))) push("payload.hint_sources", "要是字串陣列");
      break;
    }
    case "correction": {
      // 舊格式 {field, correct_value} 與新格式 {changes:[{field, current_value, correct_value}]} 都收（normalizeCorrection）
      if (!oneOf(CORRECTION_TABLES, p.target_table)) push("payload.target_table", `要是 ${CORRECTION_TABLES.join("／")} 之一`);
      if (!isStr(p.target_id, 1, 64)) push("payload.target_id", "target_id 必填（該筆資料的 id）");
      const table = oneOf(CORRECTION_TABLES, p.target_table) ? p.target_table : null;
      // 參選紀錄的 id 是整數、人物與政見是 uuid（09-26：a-zhen 把人物 uuid 當成參選紀錄 id 交，落庫時才炸、重試到退件）
      if (!isStr(p.target_id, 1, 64)) { /* 上面已報 */ } else if (table === "politician_elections" && !/^[1-9]\d{0,9}$/.test(String(p.target_id))) push("payload.target_id", "參選紀錄（politician_elections）的 target_id 是整數 id（任務 current 裡的參選紀錄 id），不是人物的 uuid");
      else if (table === "politician_offices" && !/^[1-9]\d{0,17}$/.test(String(p.target_id))) push("payload.target_id", "任期（politician_offices）的 target_id 是整數 id（任期表那一列的 id）");
      else if (table && table !== "politician_elections" && table !== "politician_offices" && !isUuid(p.target_id)) push("payload.target_id", `${table} 的 target_id 要是 uuid`);
      const { changes } = normalizeCorrection(p);
      const usesChanges = Array.isArray(p.changes);
      if (changes.length === 0) push(usesChanges ? "payload.changes" : "payload.field", "至少要一個要更正的欄位：changes:[{field, current_value, correct_value}]（或舊格式 field＋correct_value）");
      else if (changes.length > MAX_CORRECTION_CHANGES) push("payload.changes", `一筆最多更正 ${MAX_CORRECTION_CHANGES} 個欄位`);
      const seen = new Set<string>();
      changes.forEach((c, i) => {
        const at = usesChanges ? `payload.changes[${i}]` : "payload";
        if (!isStr(c.field, 1, 50)) push(`${at}.field`, "field 必填");
        else if (table && !CORRECTION_FIELDS[table].includes(c.field)) push(`${at}.field`, `${table} 只接受修正：${CORRECTION_FIELDS[table].join("／")}`);
        else if (seen.has(c.field)) push(`${at}.field`, `欄位 ${c.field} 重複`);
        seen.add(c.field);
        const clearable = table === "policies" && c.field === "proposed_date"; // 提出日期查不到時可以清空
        const empty = c.correct_value === undefined || c.correct_value === null || c.correct_value === "";
        if (empty && !clearable) push(`${at}.correct_value`, "correct_value 必填");
        else if (empty) { /* 清空提出日期：合法 */ }
        else if (table === "politicians" && c.field === "current_position" && isElectionName(c.correct_value)) push(`${at}.correct_value`, CURRENT_POSITION_NOT_ELECTION);
        else if (table === "politician_offices" && c.field === "end_date" && !isDate(c.correct_value)) push(`${at}.correct_value`, "卸任日要是 YYYY-MM-DD");
        else if (table === "politician_offices" && c.field === "end_reason" && !oneOf(OFFICE_END_REASONS, c.correct_value)) push(`${at}.correct_value`, `卸任原因要是 ${OFFICE_END_REASONS.join("／")} 之一`);
        else if (table === "politician_elections" && c.field === "candidate_status" && !oneOf(CORRECTION_CANDIDATE_STATUSES, c.correct_value)) push(`${at}.correct_value`, `參選狀態只能改成 ${CORRECTION_CANDIDATE_STATUSES.join("／")} 之一：不收傳聞（rumored、likely），當選落選用 candidacy 帶 election_result，退選填 not_running（協議 1.51.0）`);
        else if (table === "politician_elections" && c.field === "withdrawn_after_filing" && typeof c.correct_value !== "boolean") push(`${at}.correct_value`, WITHDRAWN_AFTER_FILING_MSG);
        else if (table === "policies" && c.field === "category" && !isCanonicalCategory(c.correct_value)) push(`${at}.correct_value`, categoryErrorMessage(c.correct_value), "category_invalid");
        else if (table === "policies" && c.field === "proposed_date") validateProposedDate(c.correct_value, undefined, (_path, message) => push(`${at}.correct_value`, message));
        else if (table === "policies" && c.field === "election_id" && !(isInt(c.correct_value) && KNOWN_ELECTION_IDS.includes(c.correct_value))) push(`${at}.correct_value`, `要是 ${KNOWN_ELECTION_IDS.join("／")}（就是選舉年份）`);
        else if (table === "policies" && c.field === "origin" && !oneOf(POLICY_ORIGINS, c.correct_value)) push(`${at}.correct_value`, ORIGIN_MSG);
      });
      // 退選前有沒有登記只在「退選」的紀錄上有意義：同一筆又改參選狀態的話，落庫時狀態一變這一欄就被清掉（#345 後續）
      if (table === "politician_elections" && changes.some((c) => c.field === "withdrawn_after_filing") && changes.some((c) => c.field === "candidate_status")) {
        push(usesChanges ? "payload.changes" : "payload", "withdrawn_after_filing 不能跟 candidate_status 同一筆改：他其實還在選（在名冊上、沒退選）就只改 candidate_status；退選前有沒有登記另外交一筆");
      }
      if (table === "policies") {
        // 同一筆裡同時改屆別與提出日期時，兩者要對得上
        const newElection = changes.find((c) => c.field === "election_id")?.correct_value;
        const newDate = changes.find((c) => c.field === "proposed_date")?.correct_value;
        const newStatus = changes.find((c) => c.field === "status")?.correct_value;
        if (isInt(newElection) && typeof newDate === "string" && isDate(newDate) && Number(newDate.slice(0, 4)) > newElection && isCampaignStatus(newStatus)) {
          push(usesChanges ? "payload.changes" : "payload", `提出日期 ${newDate} 晚於你要改成的 ${newElection} 年那屆選舉，兩者對不上。若這是他 ${newElection} 年當選後、任內才宣布的施政承諾，同一筆把 status 改成 Proposed`);
        }
      }
      if (!isStr(p.reason, 10, 2000)) push("payload.reason", "reason 必填（至少 10 字，只放判斷依據；事實請放進 changes 的欄位）");
      break;
    }
  }
}

/**
 * 政策脈絡（#349）的出處守門：每一項角色（或交接、關聯）實際依據的那個網址＝它自己的 source_url，沒給就是 source_urls 第一個。
 *   - 那個網址要是這筆 source_urls 之一（驗證者只會打開 source_urls）
 *   - 臉書、IG、Threads 讀不到，不收（驗證者與系統都打不開，等於沒有出處）
 *   - basis=official_record 的要是官方網址（立法院、議會、*.gov.tw）：角色以官方紀錄為準，新聞轉述不是官方紀錄
 */
export function lineageSourceProblems(type: string, payload: unknown, sourceUrls: readonly unknown[]): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  const listed = sourceUrls.filter((u): u is string => typeof u === "string").map((u) => u.trim());
  const first = listed[0] ?? "";
  const listedSet = new Set(listed);
  const p = isObj(payload) ? payload : {};
  const check = (rawUrl: unknown, path: string, official: boolean) => {
    const own = typeof rawUrl === "string" && rawUrl.trim() ? rawUrl.trim() : "";
    if (own && isHttpUrl(own) && !listedSet.has(own)) out.push({ path: `${path}.source_url`, message: "source_url 要是這筆 source_urls 的其中一個（驗證者只會打開 source_urls）；不填就是第一個" });
    const url = own || first;
    if (!url) return;
    if (isUnreadableSocial(url)) out.push({ path: own ? `${path}.source_url` : "source_urls", message: "臉書、IG、Threads 讀不到（驗證者與系統都打不開），不收：請改附官方紀錄、本人官網或報導的網址" });
    else if (official && !isOfficialUrl(url)) out.push({ path: own ? `${path}.source_url` : "source_urls", message: "basis=official_record（官方紀錄）要附官方網址：立法院議事系統（ly.gov.tw）、議會網站或 *.gov.tw。新聞報導、本人官網講的是本人宣稱，basis 填 self_claim" });
  };
  if (type === "lineage_participants") {
    (Array.isArray(p.participants) ? p.participants : []).forEach((item, i) => {
      if (!isObj(item) || item.remove === true) return;
      check(item.source_url, `payload.participants[${i}]`, item.basis === "official_record");
    });
  } else if (type === "lineage_handover" || type === "lineage_link") {
    check(p.source_url, "payload", false);
  }
  return out;
}

/** 把請求 body 正規化成清單並逐筆驗證；有任何錯就整批不收（讓 AI 一次修完再送）。 */
export function validateContributionRequest(body: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const items: ContributionInput[] = [];
  const contributor: Contributor = { agent_name: "" };

  if (!isObj(body)) return { ok: false, errors: [{ index: -1, path: "body", message: "body 要是 JSON 物件" }], items, contributor };

  // 先擋亂碼：任何字串欄位含 U+FFFD 或控制字元就整批退，不再往下驗
  const encodingProblems = findEncodingProblems(body);
  if (encodingProblems.length > 0) {
    return {
      ok: false,
      errors: encodingProblems.map((p) => ({ index: -1, path: p, message: ENCODING_INVALID_MESSAGE, code: "encoding_invalid" as const })),
      items,
      contributor,
    };
  }

  if (!isValidAgentName(body.agent_name)) {
    errors.push({ index: -1, path: "agent_name", message: AGENT_NAME_MSG });
  } else {
    contributor.agent_name = body.agent_name;
  }
  if (body.agent_tool !== undefined) {
    if (!isValidAgentTool(body.agent_tool)) errors.push({ index: -1, path: "agent_tool", message: AGENT_TOOL_MSG });
    else contributor.agent_tool = String(body.agent_tool).trim();
  }
  if (body.contributor_url !== undefined) {
    if (!/^https?:\/\/\S+$/.test(String(body.contributor_url))) errors.push({ index: -1, path: "contributor_url", message: "要是 http(s) 網址" });
    else contributor.url = String(body.contributor_url);
  }

  const rawList: unknown[] = Array.isArray(body.contributions) ? body.contributions : [body];
  if (Array.isArray(body.contributions) && rawList.length === 0) errors.push({ index: -1, path: "contributions", message: "contributions 不能是空陣列" });
  if (rawList.length > MAX_BATCH) errors.push({ index: -1, path: "contributions", message: `一次最多 ${MAX_BATCH} 筆` });

  rawList.slice(0, MAX_BATCH).forEach((raw, index) => {
    const push = (path: string, message: string, code?: ValidationCode) => errors.push({ index, path, message, ...(code ? { code } : {}) });
    if (!isObj(raw)) { push("", "每筆要是物件"); return; }
    if (!oneOf(CONTRIBUTION_TYPES, raw.contribution_type)) { push("contribution_type", `要是 ${CONTRIBUTION_TYPES.join("／")} 之一`); return; }
    if (!isObj(raw.payload)) { push("payload", "payload 要是物件"); return; }
    // no_change／adjudication 沒給 source_urls 時，用 payload.checked_urls 當來源（驗證者照那些網址核對）
    const usesChecked = raw.contribution_type === "no_change" || raw.contribution_type === "adjudication";
    const sourceUrls: unknown = Array.isArray(raw.source_urls) || !usesChecked ? raw.source_urls : raw.payload.checked_urls;
    if (!Array.isArray(sourceUrls) || sourceUrls.length === 0) push("source_urls", "source_urls 必填，至少一個可打開的來源網址");
    else if (sourceUrls.length > MAX_SOURCE_URLS) push("source_urls", `最多 ${MAX_SOURCE_URLS} 個`);
    else if (!sourceUrls.every((u) => typeof u === "string")) push("source_urls", "每個都要是字串");
    else {
      const check = checkSourceSet(sourceUrls as string[]);
      if (!check.ok) push("source_urls", `${check.reason}：${check.details.filter((d) => d.kind === "invalid").map((d) => d.url).join("、")}`);
    }
    if (raw.note !== undefined && !isStr(raw.note, 1, 2000)) push("note", "要是 1～2000 字");
    if (raw.task_id !== undefined && !isStr(raw.task_id, 1, 160)) push("task_id", "要是字串（/next 給的 task_id）");
    // no_change 的 task_id：/next 的 how_to 教代理放頂層，schema 卻只認 payload.task_id（外部審查 2026-09-19 建議 4）。
    // 只對 no_change 做這個補正：頂層有、payload 沒有 → 灌進去再驗。其他型別的 payload 一律原樣。
    if (raw.contribution_type === "no_change" && isObj(raw.payload) && !raw.payload.task_id && typeof raw.task_id === "string" && raw.task_id) {
      raw.payload.task_id = raw.task_id;
    }
    validatePayload(raw.contribution_type, raw.payload, push);
    // 三要素的每個要素指的出處，要是這筆交件的 source_urls 之一：驗證者只會打開 source_urls，指到別處等於沒給人核對
    if (raw.contribution_type === "policy_elements" && Array.isArray(raw.payload.elements) && Array.isArray(sourceUrls)) {
      const listed = new Set((sourceUrls as unknown[]).filter((u): u is string => typeof u === "string").map((u) => u.trim()));
      (raw.payload.elements as unknown[]).forEach((e, i) => {
        const url = isObj(e) && typeof e.source_url === "string" ? e.source_url.trim() : "";
        if (url && isHttpUrl(url) && !listed.has(url)) push(`payload.elements[${i}].source_url`, "source_url 要是這筆 source_urls 的其中一個（驗證者只會打開 source_urls）；不填就是第一個");
      });
    }
    // 政策脈絡（#349）：角色、交接、關聯各自的出處要是這筆 source_urls 之一；臉書讀不到不收；官方紀錄要附官方網址
    if (Array.isArray(sourceUrls) && (raw.contribution_type === "lineage_participants" || raw.contribution_type === "lineage_handover" || raw.contribution_type === "lineage_link")) {
      for (const problem of lineageSourceProblems(raw.contribution_type, raw.payload, sourceUrls as unknown[])) push(problem.path, problem.message);
    }
    // 政黨資訊（#346）：臉書、IG、Threads 讀不到（驗證者與系統都打不開），不算出處——跟學經歷、政策脈絡同一份清單
    if (raw.contribution_type === "party_info" && Array.isArray(sourceUrls)) {
      (sourceUrls as unknown[]).forEach((u, i) => {
        if (typeof u === "string" && isUnreadableSocial(u)) push(`source_urls[${i}]`, "臉書、IG、Threads 讀不到（驗證者與系統都打不開），不算出處：請改附內政部政黨資訊網、政黨官網的公告或報導的網址");
      });
    }
    items.push({
      contribution_type: raw.contribution_type,
      payload: raw.payload,
      source_urls: Array.isArray(sourceUrls) ? (sourceUrls as string[]) : [],
      ...(raw.note !== undefined ? { note: String(raw.note) } : {}),
      ...(raw.task_id !== undefined ? { task_id: String(raw.task_id) } : {}),
    });
  });

  return { ok: errors.length === 0, errors, items, contributor };
}

export const VERDICTS = ["agree", "disagree", "unsure"] as const;

/** POST /verify／/report{kind:verify} 的請求驗證：disagree 一定要有 evidence_url（http(s)）與 note。 */
export function validateVerifyRequest(body: unknown): VerifyValidation {
  const errors: Array<{ path: string; message: string; code?: "encoding_invalid" }> = [];
  if (!isObj(body)) return { ok: false, errors: [{ path: "body", message: "body 要是 JSON 物件" }], input: null };
  const encodingProblems = findEncodingProblems(body);
  if (encodingProblems.length > 0) {
    return { ok: false, errors: encodingProblems.map((p) => ({ path: p, message: ENCODING_INVALID_MESSAGE, code: "encoding_invalid" as const })), input: null };
  }
  if (!isUuid(body.contribution_id)) errors.push({ path: "contribution_id", message: "contribution_id 必填（uuid，/next 給的）" });
  if (!oneOf(VERDICTS, body.verdict)) errors.push({ path: "verdict", message: "verdict 要是 agree／disagree／unsure" });
  if (!isValidAgentName(body.agent_name)) errors.push({ path: "agent_name", message: AGENT_NAME_MSG });
  if (body.agent_tool !== undefined && !isValidAgentTool(body.agent_tool)) errors.push({ path: "agent_tool", message: AGENT_TOOL_MSG });
  if (body.evidence_url !== undefined) {
    if (!isStr(body.evidence_url, 8, 2000) || !isHttpUrl(body.evidence_url)) errors.push({ path: "evidence_url", message: "evidence_url 要是可打開的 http(s) 網址" });
  } else if (body.verdict === "disagree") {
    errors.push({ path: "evidence_url", message: "投 disagree 一定要附 evidence_url（反證網址；來源打不開時可附原 source_url）與 note 說明哪裡不對" });
  }
  if (body.verdict === "disagree" && !isStr(body.note, 5, 2000)) errors.push({ path: "note", message: "投 disagree 要寫 note（至少 5 字）說明依據" });
  else if (body.note !== undefined && !isStr(body.note, 1, 2000)) errors.push({ path: "note", message: "要是 1～2000 字" });
  if (body.resolved_politician_id !== undefined && body.resolved_politician_id !== null && !isIdentityPick(body.resolved_politician_id)) errors.push({ path: "resolved_politician_id", message: "要是 uuid（current.identity_candidates 裡的 id）或 \"new\"（都不是，建新人物）" });
  for (const k of ["cec_hits", "cec_people"] as const) {
    if (body[k] !== undefined && !(Number.isInteger(body[k]) && (body[k] as number) >= 0 && (body[k] as number) <= 10000)) errors.push({ path: k, message: "要是 0 以上的整數" });
  }
  if (errors.length > 0) return { ok: false, errors, input: null };
  return {
    ok: true,
    errors,
    input: {
      contribution_id: body.contribution_id as string,
      verdict: body.verdict as Verdict,
      agent_name: body.agent_name as string,
      ...(body.agent_tool !== undefined ? { agent_tool: String(body.agent_tool).trim() } : {}),
      ...(body.evidence_url !== undefined ? { evidence_url: String(body.evidence_url) } : {}),
      ...(body.note !== undefined ? { note: String(body.note) } : {}),
      ...(typeof body.resolved_politician_id === "string" ? { resolved_politician_id: body.resolved_politician_id } : {}),
      ...(typeof body.cec_hits === "number" ? { cec_hits: body.cec_hits } : {}),
      ...(typeof body.cec_people === "number" ? { cec_people: body.cec_people } : {}),
    },
  };
}

/** 去重用：型別＋payload（鍵排序後）的穩定 JSON。 */
export function canonicalPayload(item: ContributionInput): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
  };
  return JSON.stringify({ t: item.contribution_type, p: sortKeys(item.payload) });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
