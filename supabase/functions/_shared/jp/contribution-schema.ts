/**
 * 日本站貢獻請求的格式與驗證（收 no_change、task_suggestion、correction、election、local_government、regional_stat、candidacy 七種）。
 *
 * 複製自 ../contribution-schema.ts：validateContributionRequest／validateVerifyRequest／canonicalPayload，
 * 以及 validatePayload 裡 no_change、task_suggestion、correction 三段的欄位規則（欄位名、字數、錯誤文字都照抄）。
 * 日本站自己的：election（查到的選舉日程，policy-jp #41 ③、PR②；對應派工臂 election_discovery）——正見沒有這個型別，
 *   欄位照 policy_jp.elections 的 CHECK 寫（election_type／election_reason 的列舉、國政不帶 lg_code、補欠・増員只限議員選舉、
 *   告示日不晚於投票日）。共識後由 SQL policy_jp.apply_contribution 落庫（20261009210000）。#503：lg_code 驗檢查碼、日期限 1947～2100、
 *   帶 task_id 時 payload 的 lg_code（與 election 的職位種類）要跟 task_id 一致。
 * 日本站自己的：local_government（地方公共団体，對應派工臂 local_government_missing）與 regional_stat（地域統計，對應 regional_stats_missing）——
 *   欄位照 policy_jp.local_governments／regional_stats 的 CHECK 寫；source_urls 至少要有一個公的出典（総務省・e-Stat・*.go.jp・*.lg.jp・団体の公式サイト）。
 * 日本站自己的：candidacy（選舉鏈第 2 步，對應派工臂 roster_check；欄位照 policy_jp.politician_elections 的 CHECK：六個 candidacy_status、district_kind、status_date；
 *   人物用 politician_id 或 name＋kana；得票數・得票率的欄位名一律 400；claimKey 併票型別，不進 same_claim 登記表）。落庫 SQL policy_jp.apply_candidacy（20261010040000）。
 * 日本站自己的：policy_elements（政見三要素，對應派工臂 policy_elements；欄位與規則照正見 contribution-schema.ts 的 policy_elements、共用 ../policy-elements.ts 的上限與日期範圍；
 *   同一件事登記表的型別〔鍵＝政見 id ＋ 要素〕，所以 resolved_claim 必填）。落庫 SQL policy_jp.apply_policy_elements（20261011140000）。
 * 日本站自己的：district_seats（議員定数，對應派工臂 district_seats；議会議員選挙 1 件の定数合計 seats_total と選挙区ごとの定数 districts[]；at_large と district は混ぜない、合計一致；
 *   同一件事の登記表の型別〔鍵＝選挙 id〕，所以 resolved_claim 必填）。落庫 SQL policy_jp.apply_district_seats（20261011170000）。
 * 日本站自己的：removal（重複政見の清査 duplicate_policy の答え：政見 1 件の軟移除〔review_status=rejected〕。target_table は policies だけ、reason ≥20 字、keep_id 任意；
 *   claimKey 併票の型別〔duplicate-claim.ts、鍵＝target_id〕，不進 same_claim 登記表，所以 resolved_claim 不要）。落庫 SQL policy_jp.apply_removal（20261011180000）。
 * 拿掉的：其他十八種貢獻型別、選舉 id／election_key 解析（resolveElectionKeys）、中選會名冊大批次（MAX_BATCH_ROSTER）、
 * 出處等級 source_details（正見 #347 的 sources 表，日本站有自己的 sources，本 PR 不接）、
 * 驗證請求裡的 resolved_politician_id／cec_hits／cec_people（身份指認與中選會筆數，日本站沒有）。
 * 改動的：
 *   - correction 的 target_table 白名單與欄位規則是正見資料表專屬的；日本站的白名單 JP_CORRECTION_TABLES 先放日本站已建的表，
 *     欄位名只檢查「是個合理的欄位名」（見 JP_FIELD_RE），不逐表列出——落庫（apply）本 PR 不做，欄位白名單等落庫時再補。【待定】
 *   - task_suggestion 的 task_type：日本站的任務型別還沒定，只檢查形狀（JP_TASK_TYPE_RE）。【待定】
 *   - target_id 的形狀（正見：參選紀錄是整數、其他是 uuid）：日本站 id 型別不一，只要求 1～64 字的非空字串。【待定】
 * 純工具（normalizeCorrection、sha256Hex、checkSourceSet）從正見的模組直接 import，不複製。
 */

import { checkSourceSet } from "../source-priority.ts";
import { isValidAgentName, isValidAgentTool, type Verdict } from "../consensus.ts";
import { MAX_CORRECTION_CHANGES, normalizeCorrection } from "../correction.ts";
import { ENCODING_INVALID_MESSAGE, findEncodingProblems, sha256Hex } from "../contribution-schema.ts";
import { isJpDate, lgCodeValid, lgPrefCode } from "./lg-code.ts";
import { isJpOfficialSource, jpSourceKind } from "./source-kind.ts";
import { isSameClaimType, parseResolvedClaim, RESOLVED_CLAIM_HELP } from "../same-claims.ts";
import { charLength, DEADLINE_YEAR_MAX, DEADLINE_YEAR_MIN, isRealDate, POLICY_ELEMENT_KINDS, POLICY_ELEMENT_LOCATOR_MAX, POLICY_ELEMENT_TEXT_MAX } from "../policy-elements.ts";

export { ENCODING_INVALID_MESSAGE, sha256Hex };

export const JP_CONTRIBUTION_TYPES = ["no_change", "task_suggestion", "correction", "election", "local_government", "regional_stat", "candidacy", "politician", "policy", "policy_elements", "district_seats", "removal"] as const;
/** district_seats の上限・列挙（SQL policy_jp.district_seats_normalize と同じ値） */
export const DISTRICT_SEATS_MAX = 200;
export const DISTRICT_SEATS_MAX_DISTRICTS = 100;
export const DISTRICT_SEATS_BASES = ["law", "notice"] as const;
export const DISTRICT_SEATS_KINDS = ["at_large", "district"] as const;
export type JpContributionType = (typeof JP_CONTRIBUTION_TYPES)[number];

/** election 的列舉：跟 policy_jp.elections 的 CHECK（election_type／election_reason）同一份；改一邊要改另一邊 */
export const JP_ELECTION_TYPES = ["governor", "mayor", "ward_mayor", "town_mayor", "national_lower", "national_upper", "pref_assembly", "muni_assembly"] as const;
export const JP_ELECTION_REASONS = ["regular", "resignation", "death", "recall", "dissolution", "by_election", "increase", "rerun"] as const;
/** 國政選舉沒有 lg_code（elections_national_no_lg：level = national 才是 NULL） */
export const JP_NATIONAL_ELECTION_TYPES = ["national_lower", "national_upper"] as const;
/** 補欠選挙・増員選挙只有議員選舉（elections_by_election_assembly） */
export const JP_ASSEMBLY_ELECTION_TYPES = ["pref_assembly", "muni_assembly", "national_lower", "national_upper"] as const;
export const JP_LG_CODE_RE = /^\d{6}$/;

/** local_governments.kind 的列舉（policy_jp.local_governments 的 CHECK；對齊測試守著） */
export const JP_LG_KINDS = ["prefecture", "designated_city", "core_city", "city", "special_ward", "admin_ward", "town", "village"] as const;
/** 團體名稱的結尾要跟 kind 對得上（北海道・東京都・大阪府・京都府・○○県／○○市／○○区／○○町／○○村） */
export const JP_LG_NAME_SUFFIX: Record<(typeof JP_LG_KINDS)[number], RegExp> = {
  prefecture: /[都道府県]$/, designated_city: /市$/, core_city: /市$/, city: /市$/, special_ward: /区$/, admin_ward: /区$/, town: /町$/, village: /村$/,
};
const JP_LG_NAME_SUFFIX_HINT: Record<(typeof JP_LG_KINDS)[number], string> = {
  prefecture: "都道府県要以 都／道／府／県 結尾", designated_city: "市要以 市 結尾", core_city: "市要以 市 結尾", city: "市要以 市 結尾",
  special_ward: "區要以 区 結尾", admin_ward: "區要以 区 結尾", town: "町要以 町 結尾", village: "村要以 村 結尾",
};
/** kana 是「ひらがな」（五十音排序用；総務省コード表の半角カナは全部ひらがなに直して交件） */
export const JP_KANA_RE = /^[ぁ-ゖー]+$/;

/** regional_stats.stat_key 與單位（policy_jp.regional_stat_unit；一個 stat_key 只有一種單位，對齊測試守著） */
export const JP_STAT_KEYS = ["population", "area_km2", "budget_expenditure", "aging_rate"] as const;
export const JP_STAT_UNITS: Record<(typeof JP_STAT_KEYS)[number], string> = { population: "人", area_km2: "km2", budget_expenditure: "千円", aging_rate: "%" };

/** candidacy（第 2 步）：參選狀態的六個值（policy_jp.politician_elections 的 CHECK）與選舉區種類 */
export const JP_CANDIDACY_STATUSES = ["considering", "declared", "filed", "withdrawn", "elected", "not_elected"] as const;
export const JP_DISTRICT_KINDS = ["district", "proportional", "at_large"] as const;
/** elections.id 的形狀（投票日_種類_團體碼；國政是 national） */
export const JP_ELECTION_ID_RE = /^\d{4}-\d{2}-\d{2}_[a-z_]+_(\d{6}|national)$/;
/** 得票數・得票率不收（CLAUDE.md：不存、不顯示）。這些欄位名出現在 candidacy 的 payload 就整筆 400 */
export const JP_VOTE_FIELDS = ["votes", "vote_count", "votes_received", "vote_percentage", "vote_rate", "vote_share", "turnout"] as const;

/** 【待定】日本站已建的資料表（20261009000000_policy_jp_tables.sql）裡可以被更正的；落庫（apply）定案時一併收斂 */
export const JP_CORRECTION_TABLES = ["politicians", "politician_elections", "politician_offices", "policies", "parties", "elections", "lineages"] as const;
/** 欄位名只擋亂寫（小寫英數底線） */
export const JP_FIELD_RE = /^[a-z][a-z0-9_]{0,49}$/;
export const JP_TASK_TYPE_RE = /^[a-z][a-z0-9_]{0,59}$/;

/** /next 給的 task_id 只有兩種形狀：手動任務 uuid、自動缺口 auto:<型別>:<對象>（同正見 isTaskIdShape） */
export const isTaskIdShape = (v: unknown): boolean =>
  typeof v === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^auto:[a-z0-9_]+:\S+$/.test(v));

/** 政見の題名の正規化（同一件事の鍵）：NFKC・小文字・空白（全角も）を全部除く。SQL policy_jp.policy_title_key と同じ（對齊テスト） */
/** 前後の空白を落とす（全角空白 U+3000 も）。SQL policy_jp.policy_trim と同じ集合（ASCII の空白類＋U+3000；對齊テスト） */
export const jpTrim = (v: string): string => v.replace(/^[ \t\r\n\f\v\u3000]+|[ \t\r\n\f\v\u3000]+$/g, "");
const cpLen = (v: string): number => Array.from(v).length;

export const policyTitleKey = (v: unknown): string => String(v ?? "").normalize("NFKC").toLowerCase().replace(/[\s　]+/g, "");

export const NO_CHANGE_OUTCOMES =["confirmed", "unreachable", "not_found"] as const;
export const MAX_BATCH = 20;
export const MAX_SOURCE_URLS = 10;

export interface ContributionInput {
  contribution_type: JpContributionType;
  payload: Record<string, unknown>;
  source_urls: string[];
  note?: string;
  task_id?: string;
}

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
}

export interface VerifyValidation {
  ok: boolean;
  errors: Array<{ path: string; message: string; code?: "encoding_invalid" }>;
  input: VerifyInput | null;
}

export interface ValidationError {
  index: number;
  path: string;
  message: string;
  code?: "encoding_invalid";
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  items: ContributionInput[];
  contributor: Contributor;
}

const AGENT_NAME_MSG = "agent_name 必填：使用者代號（GitHub 帳號或暱稱），2～64 字，只能字母數字與 ._-，不要放模型名（模型名放 agent_tool）";
const AGENT_TOOL_MSG = "agent_tool 要是 1～64 字的字串（例：<工具>/<模型>）";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, min = 1, max = 2000): v is string => typeof v === "string" && v.trim().length >= min && v.length <= max;
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);
/**
 * 任務與交件對得上（#503 b）：自動缺口任務的 task_id 是 auto:<臂>:<對象>，三種資料型交件各有對應的臂，
 * 帶了 task_id 就要確認「這筆交件講的是那個任務問的團體」——不然代理拿錯 task_id（或亂填）交進來，通過驗證後會落庫成別的團體的資料。
 *   election_discovery 任務      → 只收 election；task_id 裡的 lg_code 與職位（head＝長、assembly＝議會）要跟 payload 一致
 *   local_government_missing 任務 → 只收 local_government；lg_code 一致
 *   regional_stats_missing 任務   → 只收 regional_stat；lg_code 一致
 * 手動任務（uuid）與其他自動缺口任務不比對（no_change／task_suggestion／correction 也不在這裡管）。
 */
export const JP_TASK_ARMS = {
  election_discovery: "election",
  local_government_missing: "local_government",
  regional_stats_missing: "regional_stat",
  // 選舉鏈第 2 步：名簿任務收 candidacy（完成的合図は no_change なので、no_change は型の比對に入らない）
  roster_check: "candidacy",
  // 選舉鏈第 3 步：建檔任務收 politician（生年・学歴・経歴）
  profile_gap: "politician",
  profile_detail_gap: "politician",
  // 選舉鏈第 4 步：政見任務收 policy（公約）
  policy_missing: "policy",
  // 政見三要素（policy-ops#95、規則は預設關）：政見 1 件につき要素 1～3 個を policy_elements で答える
  policy_elements_missing: "policy_elements",
  // 議員定数（policy-ops#95）：議会議員選挙 1 件につき district_seats で答える
  district_seats_missing: "district_seats",
  // 重複政見の清査（policy-ops#95、規則は預設關）：同じ約束の二重記録は removal（あいまいな方を取り除く）、なければ no_change（confirmed）
  duplicate_policy: "removal",
  // A 期（policy-ops#95）：候補者の状態を確かめる三つの任務型別も candidacy（filed／withdrawn／同じ状態で選管の出典を足す）。
  // not_running_recheck は「照合」（task_id に filing が付かない）だと no_change／task_suggestion で答える：下の checkTaskAgreement で candidacy を断る
  candidate_status_stale: "candidacy",
  not_running_recheck: "candidacy",
  candidacy_source_missing: "candidacy",
  // B 期（policy-ops#95）：開票結果の任務も candidacy（当落：一人一件／記録にない当選者：一選挙一件で何人分でも）
  election_result_missing: "candidacy",
} as const satisfies Record<string, JpContributionType>;
const DATA_TYPES = ["election", "local_government", "regional_stat", "candidacy", "politician", "policy", "policy_elements", "district_seats", "removal"] as const;
const TASK_ID_RE = /^auto:(election_discovery|local_government_missing|regional_stats_missing|roster_check|profile_gap|profile_detail_gap|policy_missing|policy_elements_missing|district_seats_missing|duplicate_policy|candidate_status_stale|not_running_recheck|candidacy_source_missing|election_result_missing):(.+)$/;
/** 参選紀錄 id（policy_jp.politician_elections.id＝<人物 id>:<選挙 id>:<district_kind>）。選挙 id は日付_種類_団体碼 */
const JP_PE_ID_RE = /^[^\s:]{1,64}:\d{4}-\d{2}-\d{2}_[a-z_]+_\d{6}:(district|proportional|at_large)$/;
/** duplicate_policy の task_id 末尾：<参選紀錄 id>:<清單指紋（md5 32 字）> */
const DUP_POLICY_REST_RE = /^([^\s:]{1,64}:\d{4}-\d{2}-\d{2}_[a-z_]+_(?:\d{6}|national):(?:district|proportional|at_large)):([0-9a-f]{32})$/;
const DISCOVERY_REST_RE = /^\d{4}-\d{2}-\d{2}:(\d{6}):(head|assembly)$/;
const HEAD_ELECTION_TYPES = ["governor", "mayor", "ward_mayor", "town_mayor"] as const;
const ASSEMBLY_ELECTION_TYPES = ["pref_assembly", "muni_assembly"] as const;

export function checkTaskAgreement(type: JpContributionType, payload: Obj, taskId: unknown, push: (path: string, message: string) => void): void {
  if (typeof taskId !== "string" || !oneOf(DATA_TYPES, type)) return;
  const m = TASK_ID_RE.exec(taskId);
  if (!m) return;
  const arm = m[1] as keyof typeof JP_TASK_ARMS;
  if (JP_TASK_ARMS[arm] !== type) {
    push("task_id", `這個 task_id 是 ${arm} 的任務，要用 contribution_type=${JP_TASK_ARMS[arm]} 回報（你交的是 ${type}）；查不到請改交 no_change`);
    return;
  }
  // roster_check：task_id の末尾は選挙 id（auto:roster_check:<election_id>）。1 つのタスクは 1 つの選挙だけ
  if (arm === "roster_check") {
    if (!JP_ELECTION_ID_RE.test(m[2])) { push("task_id", "task_id 的格式不對：要照抄 jp-next 給的值（auto:roster_check:<選舉 id>）"); return; }
    if (payload.election_id !== m[2]) push("payload.election_id", `payload.election_id（${String(payload.election_id ?? "未填")}）跟這個任務問的選舉（${m[2]}）不一致：一個任務只回報它問的那場選舉的立候補者`);
    return;
  }
  // profile_gap／profile_detail_gap：task_id の末尾は人物 id（profile_detail_gap は sources:<人物 id> の形もある）。1 つの任務は 1 人だけ
  if (arm === "profile_gap" || arm === "profile_detail_gap") {
    const pid = arm === "profile_detail_gap" && m[2].startsWith("sources:") ? m[2].slice("sources:".length) : m[2];
    if (!pid || /\s/.test(pid)) { push("task_id", `task_id 的格式不對：要照抄 jp-next 給的值（auto:${arm}:<人物 id>）`); return; }
    if (payload.politician_id !== pid) push("payload.politician_id", `payload.politician_id（${String(payload.politician_id ?? "未填")}）跟這個任務問的人物（${pid}）不一致：一個任務只回報它問的那一位`);
    return;
  }
  // candidate_status_stale／not_running_recheck／candidacy_source_missing：task_id の末尾は参選紀錄 id（<人物 id>:<選挙 id>:<district_kind>）。
  // 1 つの任務は 1 人の 1 回の参選だけ。not_running_recheck は filing が付くものだけ candidacy で答える（付かない「照合」は no_change／correction）
  if (arm === "candidate_status_stale" || arm === "not_running_recheck" || arm === "candidacy_source_missing") {
    const filing = arm === "not_running_recheck" && m[2].startsWith("filing:");
    const peId = filing ? m[2].slice("filing:".length) : m[2];
    if (arm === "not_running_recheck" && !filing) {
      push("task_id", "この任務（不出馬の照合）は candidacy では答えられません：名簿に載っていなければ no_change（outcome=confirmed）、載っていれば task_suggestion で報告してください");
      return;
    }
    if (!JP_PE_ID_RE.test(peId)) { push("task_id", `task_id 的格式不對：要照抄 jp-next 給的值（auto:${arm}:${filing ? "filing:" : ""}<参選紀錄 id>）`); return; }
    const mine = `${String(payload.politician_id ?? "")}:${String(payload.election_id ?? "")}:${String(payload.district_kind ?? "")}`;
    if (mine !== peId) push("payload", `payload の politician_id・election_id・district_kind（${mine}）が、この任務が問う参選（${peId}）と一致しません：一つの任務は、その参選の分だけを回報します（politician_id は必須）`);
    return;
  }
  // election_result_missing（B 期）：task_id の末尾が参選紀錄 id なら当落（その参選だけ、elected／not_elected／withdrawn）、
  // elected:<選挙 id> なら記録にない当選者（その選挙の elected だけ、一人一件で何件でも）
  if (arm === "election_result_missing") {
    if (m[2].startsWith("elected:")) {
      const eid = m[2].slice("elected:".length);
      if (!JP_ELECTION_ID_RE.test(eid)) { push("task_id", "task_id 的格式不對：要照抄 jp-next 給的值（auto:election_result_missing:elected:<選舉 id>）"); return; }
      if (payload.election_id !== eid) push("payload.election_id", `payload.election_id（${String(payload.election_id ?? "未填")}）跟這個任務問的選舉（${eid}）不一致：一個任務只回報它問的那場選舉的當選者`);
      if (payload.candidacy_status !== "elected") push("payload.candidacy_status", "この任務（記録にない当選者）で出せるのは当選者（candidacy_status=elected）だけです。落選者は足さない；全員記録にあれば no_change（outcome=confirmed）");
      return;
    }
    if (!JP_PE_ID_RE.test(m[2])) { push("task_id", "task_id 的格式不對：要照抄 jp-next 給的值（auto:election_result_missing:<参選紀錄 id>）"); return; }
    const mine = `${String(payload.politician_id ?? "")}:${String(payload.election_id ?? "")}:${String(payload.district_kind ?? "")}`;
    if (mine !== m[2]) push("payload", `payload の politician_id・election_id・district_kind（${mine}）が、この任務が問う参選（${m[2]}）と一致しません：一つの任務は、その参選の分だけを回報します（politician_id は必須）`);
    else if (!oneOf(["elected", "not_elected", "withdrawn"] as const, payload.candidacy_status)) push("payload.candidacy_status", "この任務（当落）で出せる candidacy_status は elected（当選）／not_elected（落選）／withdrawn（届出していない・辞退）のどれかです");
    return;
  }
  // policy_missing：task_id の末尾は参選紀錄 id。1 つの任務は 1 人の 1 回の参選だけ
  if (arm === "policy_missing") {
    if (payload.politician_election_id !== m[2]) push("payload.politician_election_id", `payload.politician_election_id（${String(payload.politician_election_id ?? "未填")}）跟這個任務問的參選（${m[2]}）不一致：一個任務只回報它問的那一位的公約`);
    return;
  }
  // policy_elements_missing：task_id の末尾は政見 id。1 つの任務は 1 つの政見だけ
  if (arm === "policy_elements_missing") {
    if (!m[2] || /\s/.test(m[2])) { push("task_id", "task_id 的格式不對：要照抄 jp-next 給的值（auto:policy_elements_missing:<政見 id>）"); return; }
    if (payload.policy_id !== m[2]) push("payload.policy_id", `payload.policy_id（${String(payload.policy_id ?? "未填")}）跟這個任務問的政見（${m[2]}）不一致：一個任務只回報它問的那一條政見的三要素`);
    return;
  }
  // district_seats_missing：task_id の末尾は選挙 id。1 つの任務は 1 つの選挙だけ
  if (arm === "district_seats_missing") {
    if (!JP_ELECTION_ID_RE.test(m[2])) { push("task_id", "task_id 的格式不對：要照抄 jp-next 給的值（auto:district_seats_missing:<選挙 id>）"); return; }
    if (payload.election_id !== m[2]) push("payload.election_id", `payload.election_id（${String(payload.election_id ?? "未填")}）跟這個任務問的選舉（${m[2]}）不一致：一個任務只回報它問的那場選舉的議員定数`);
    return;
  }
  // duplicate_policy：task_id の末尾は <参選紀錄 id>:<清單指紋>。removal の target_id が清單の政見かは DB を見ないと分からない（落庫側が政見の存在・公開済みを確かめる）ので、ここは形だけ
  if (arm === "duplicate_policy") {
    if (!DUP_POLICY_REST_RE.test(m[2])) push("task_id", "task_id 的格式不對：要照抄 jp-next 給的值（auto:duplicate_policy:<参選紀錄 id>:<清單指紋>）");
    return;
  }
  let taskLg: string;
  let officeKind: string | null = null;
  if (arm === "election_discovery") {
    const d = DISCOVERY_REST_RE.exec(m[2]);
    if (!d) { push("task_id", "task_id 的格式不對：要照抄 jp-next 給的值（auto:election_discovery:<満了日>:<團體碼>:<head|assembly>）"); return; }
    taskLg = d[1];
    officeKind = d[2];
  } else {
    if (!/^\d{6}$/.test(m[2])) { push("task_id", `task_id 的格式不對：要照抄 jp-next 給的值（auto:${arm}:<團體碼>）`); return; }
    taskLg = m[2];
  }
  if (payload.lg_code !== taskLg) push("payload.lg_code", `payload.lg_code（${String(payload.lg_code ?? "未填")}）跟這個任務問的團體（${taskLg}）不一致：一個任務只回報它問的那個團體`);
  if (officeKind === "head" && !oneOf(HEAD_ELECTION_TYPES, payload.election_type)) push("payload.election_type", `這個任務問的是「長」的選舉，election_type 要是 ${HEAD_ELECTION_TYPES.join("／")} 之一`);
  if (officeKind === "assembly" && !oneOf(ASSEMBLY_ELECTION_TYPES, payload.election_type)) push("payload.election_type", `這個任務問的是「議会議員」的選舉，election_type 要是 ${ASSEMBLY_ELECTION_TYPES.join("／")} 之一`);
}

function validatePayload(type: JpContributionType, p: Obj, push: (path: string, message: string) => void): void {
  switch (type) {
    case "no_change": {
      // 查完發現與資料庫一致：只關任務、不改資料；checked_urls 就是驗證者要核對的來源
      if (!isStr(p.task_id, 1, 160)) push("payload.task_id", "task_id 必填（/next 給的 task_id）");
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
      if (p.task_type !== undefined && !(typeof p.task_type === "string" && JP_TASK_TYPE_RE.test(p.task_type))) push("payload.task_type", "task_type 要是小寫英數與底線組成的任務型別（例：policy_missing）");
      // 日本站的人物、政見 id 是 TEXT（不是正見的 uuid）：跟 correction 的 target_id 一樣，只要求 1～64 字的非空字串
      if (p.target_politician_id !== undefined && !isStr(p.target_politician_id, 1, 64)) push("payload.target_politician_id", "要是 1～64 字的 id 字串");
      if (p.target_policy_id !== undefined && !isStr(p.target_policy_id, 1, 64)) push("payload.target_policy_id", "要是 1～64 字的 id 字串");
      if (p.region !== undefined && !isStr(p.region, 2, 20)) push("payload.region", "地區名要是字串");
      if (p.hint_sources !== undefined && !(Array.isArray(p.hint_sources) && (p.hint_sources as unknown[]).every((s) => isStr(s, 1, 300)))) push("payload.hint_sources", "要是字串陣列");
      break;
    }
    case "correction": {
      // 舊格式 {field, correct_value} 與新格式 {changes:[{field, current_value, correct_value}]} 都收（normalizeCorrection）
      if (!oneOf(JP_CORRECTION_TABLES, p.target_table)) push("payload.target_table", `要是 ${JP_CORRECTION_TABLES.join("／")} 之一`);
      if (!isStr(p.target_id, 1, 64)) push("payload.target_id", "target_id 必填（該筆資料的 id）");
      const { changes } = normalizeCorrection(p);
      const usesChanges = Array.isArray(p.changes);
      if (changes.length === 0) push(usesChanges ? "payload.changes" : "payload.field", "至少要一個要更正的欄位：changes:[{field, current_value, correct_value}]（或舊格式 field＋correct_value）");
      else if (changes.length > MAX_CORRECTION_CHANGES) push("payload.changes", `一筆最多更正 ${MAX_CORRECTION_CHANGES} 個欄位`);
      const seen = new Set<string>();
      changes.forEach((c, i) => {
        const at = usesChanges ? `payload.changes[${i}]` : "payload";
        if (!isStr(c.field, 1, 50)) push(`${at}.field`, "field 必填");
        else if (!JP_FIELD_RE.test(c.field)) push(`${at}.field`, "field 要是資料表的欄位名（小寫英數與底線）");
        else if (seen.has(c.field)) push(`${at}.field`, `欄位 ${c.field} 重複`);
        seen.add(c.field);
        const empty = c.correct_value === undefined || c.correct_value === null || c.correct_value === "";
        if (empty) push(`${at}.correct_value`, "correct_value 必填");
      });
      if (!isStr(p.reason, 10, 2000)) push("payload.reason", "reason 必填（至少 10 字，只放判斷依據；事實請放進 changes 的欄位）");
      break;
    }
    case "removal": {
      // 重複政見の軟移除（正見 removal の日本版）：政見だけ。取り除くのは行を消すことではなく review_status=rejected（画面から消えるが行は残り、履歴から戻せる）。
      // 取り除く理由が本体なので reason は 20 字以上。source_urls は全型別共通で必須（確かめたページ）。keep_id は残す方の政見 id（任意、取り除く方とは別）
      if (p.target_table !== "policies") push("payload.target_table", "removal で取り除けるのは policies（政見）だけ");
      if (!isStr(p.target_id, 1, 64) || /\s/.test(p.target_id)) push("payload.target_id", "target_id 必填（取り除く政見の id）");
      if (!isStr(p.reason, 20, 2000)) push("payload.reason", "reason 必填（≥20 字：なぜ取り除くか。重複なら残す政見の id と、同じ約束だと言える理由）");
      if (p.keep_id !== undefined) {
        if (!isStr(p.keep_id, 1, 64) || /\s/.test(p.keep_id)) push("payload.keep_id", "keep_id は残す政見の id（1～64 字）");
        else if (p.keep_id === p.target_id) push("payload.keep_id", "keep_id と target_id が同じ：残す政見と取り除く政見は別のもの");
      }
      break;
    }
    case "election": {
      // 查到的選舉日程（選管的告示）：欄位照 policy_jp.elections 的 CHECK；出處（選管告示）走頂層 source_urls
      const national = oneOf(JP_NATIONAL_ELECTION_TYPES, p.election_type);
      if (!oneOf(JP_ELECTION_TYPES, p.election_type)) push("payload.election_type", `election_type 必填：${JP_ELECTION_TYPES.join("／")} 之一`);
      if (!oneOf(JP_ELECTION_REASONS, p.election_reason)) push("payload.election_reason", `election_reason 必填：${JP_ELECTION_REASONS.join("／")} 之一（任期満了＝regular）`);
      else if ((p.election_reason === "by_election" || p.election_reason === "increase") && oneOf(JP_ELECTION_TYPES, p.election_type) && !oneOf(JP_ASSEMBLY_ELECTION_TYPES, p.election_type)) {
        push("payload.election_reason", `${p.election_reason} 只有議員選舉才有（election_type 要是 ${JP_ASSEMBLY_ELECTION_TYPES.join("／")} 之一）`);
      }
      // 國政選舉不帶 lg_code、地方選舉一定要帶（lg_code＝全国地方公共団体コード 6 碼；election_type 填錯時不重複報 lg_code 的錯）
      if (national) {
        if (p.lg_code !== undefined && p.lg_code !== null) push("payload.lg_code", "國政選舉（national_lower／national_upper）不帶 lg_code，請拿掉這個欄位");
      } else if (oneOf(JP_ELECTION_TYPES, p.election_type)) {
        if (!(typeof p.lg_code === "string" && JP_LG_CODE_RE.test(p.lg_code))) push("payload.lg_code", "lg_code 必填：全国地方公共団体コード 6 碼數字（例：131130）");
        else if (!lgCodeValid(p.lg_code)) push("payload.lg_code", "lg_code 的檢查碼不對（第 6 碼）：請照總務省「全国地方公共団体コード」抄正確的 6 碼");
      }
      if (!isJpDate(p.election_date)) push("payload.election_date", "election_date 必填：投票日，YYYY-MM-DD，要是真的有這一天，年份在 1947～2100");
      if (p.notice_date !== undefined) {
        if (!isJpDate(p.notice_date)) push("payload.notice_date", "notice_date 要是 YYYY-MM-DD（告示日，年份 1947～2100）；不知道就不要填");
        else if (isJpDate(p.election_date) && p.notice_date > p.election_date) push("payload.notice_date", "notice_date（告示日）不能晚於 election_date（投票日）");
      }
      if (p.name !== undefined && !isStr(p.name, 1, 100)) push("payload.name", "name 要是 1～100 字（選舉的名稱，例：○○市長選挙）；不知道就不要填");
      break;
    }
    case "local_government": {
      // 地方公共団体（總務省「全国地方公共団体コード」）：欄位照 policy_jp.local_governments 的 CHECK；網址用的 slug 由落庫端決定，不必交
      const codeOk = lgCodeValid(p.lg_code);
      if (!codeOk) push("payload.lg_code", "lg_code 必填：全国地方公共団体コード 6 碼數字，檢查碼（第 6 碼）要對，請照總務省的團體碼表抄");
      const kindOk = oneOf(JP_LG_KINDS, p.kind);
      if (!kindOk) push("payload.kind", `kind 必填：${JP_LG_KINDS.join("／")} 之一（政令指定都市 designated_city、中核市 core_city、東京23区 special_ward、政令市的行政区 admin_ward）`);
      if (!(typeof p.pref_code === "string" && lgCodeValid(p.pref_code))) push("payload.pref_code", "pref_code 必填：所屬都道府県的團體碼（6 碼，檢查碼要對；都道府県自己填自己的 lg_code）");
      else if (codeOk) {
        if (p.pref_code !== lgPrefCode(p.lg_code as string)) push("payload.pref_code", `pref_code 要是 lg_code 前 2 碼＋000＋檢查碼（這個 lg_code 的都道府県是 ${lgPrefCode(p.lg_code as string)}）`);
        else if (kindOk && (p.kind === "prefecture") !== (p.lg_code === p.pref_code)) {
          push("payload.kind", p.kind === "prefecture"
            ? "kind=prefecture 的 lg_code 要是都道府県的團體碼（前 2 碼＋000＋檢查碼，例：230006）；這個 lg_code 是市区町村"
            : "這個 lg_code 是都道府県的團體碼（第 3～5 碼是 000），kind 要填 prefecture");
        }
      }
      if (!isStr(p.name, 1, 40)) push("payload.name", "name 必填（1～40 字，總務省團體碼表的正式名稱，例：一宮市）");
      else if (kindOk && !JP_LG_NAME_SUFFIX[p.kind as (typeof JP_LG_KINDS)[number]].test((p.name as string).trim())) {
        push("payload.name", `name「${p.name}」的結尾跟 kind=${p.kind} 對不上（${JP_LG_NAME_SUFFIX_HINT[p.kind as (typeof JP_LG_KINDS)[number]]}）：kind 是不是填錯了`);
      }
      if (!isStr(p.kana, 1, 80)) push("payload.kana", "kana 必填（團體名稱的讀音）");
      else if (!JP_KANA_RE.test((p.kana as string).trim())) push("payload.kana", "kana 要全部是ひらがな（總務省團體碼表的半角カナ請改成ひらがな，例：いちのみやし；不含空白與括號）");
      break;
    }
    case "candidacy": {
      // 參選人（選舉鏈第 2 步）：欄位照 policy_jp.politician_elections 的 CHECK；人物用 politician_id（已在庫）或 name＋kana（新的人）。
      // 得票數・得票率は受け付けない（欄位名が出たら整筆 400，payload にも残さない）。政黨・推薦・合区はこの型では扱わない。
      for (const k of JP_VOTE_FIELDS) if (k in p) push(`payload.${k}`, "得票數・得票率不收（站上不存、不顯示）：請把這個欄位拿掉");
      const hasId = p.politician_id !== undefined && p.politician_id !== null;
      if (hasId && !isStr(p.politician_id, 1, 64)) push("payload.politician_id", "politician_id 要是 1～64 字的 id（/next 的 target.ours 裡的值）");
      if (!hasId || p.name !== undefined) {
        if (!isStr(p.name, 1, 40)) push("payload.name", "name 必填（1～40 字，候選人的姓名，漢字）；已在庫的人改帶 politician_id");
      }
      // kana（工作單 policy-ops#60）：告示前選填、告示日起必填。有沒有過告示日要查庫（election 的 announced 里程碑），這裡只擋「帶了但格式不對」；
      // 「告示日起沒帶」由 contribute-handler 查庫後回 400、SQL apply_candidacy 再擋一次。帶 politician_id（已在庫的人）不需要 kana。
      if (p.kana !== undefined && p.kana !== null) {
        if (!isStr(p.kana, 1, 80)) push("payload.kana", "kana 要是 1～80 字（候選人姓名的讀音，ひらがな）；告示前不知道就不要填");
        else if (!JP_KANA_RE.test((p.kana as string).trim())) push("payload.kana", "kana 要全部是ひらがな（不含空白與括號）");
      }
      if (!(typeof p.election_id === "string" && JP_ELECTION_ID_RE.test(p.election_id))) push("payload.election_id", "election_id 必填：這場選舉的 id（投票日_種類_團體碼，例：2027-04-25_mayor_232033，照任務 target.election_id 抄）");
      if (!oneOf(JP_CANDIDACY_STATUSES, p.candidacy_status)) push("payload.candidacy_status", `candidacy_status 必填：${JP_CANDIDACY_STATUSES.join("／")} 之一（告示前只有 considering／declared，filed 是告示日以後的届出）`);
      if (!isJpDate(p.status_date)) push("payload.status_date", "status_date 必填：這個狀態的日期（表態日、届出日、投票日），YYYY-MM-DD，年份 1947～2100");
      const kindOk = oneOf(JP_DISTRICT_KINDS, p.district_kind);
      if (!kindOk) push("payload.district_kind", `district_kind 必填：${JP_DISTRICT_KINDS.join("／")} 之一（首長選舉 at_large，議員選舉依選挙区 district，比例代表 proportional）`);
      if (p.district_name !== undefined && p.district_name !== null && !isStr(p.district_name, 1, 60)) push("payload.district_name", "district_name 要是 1～60 字（選挙区名）");
      else if (kindOk) {
        const named = typeof p.district_name === "string" && p.district_name.trim() !== "";
        if (p.district_kind === "at_large" && named) push("payload.district_name", "district_kind=at_large 不帶 district_name（首長選舉・全域一區）");
        if (p.district_kind !== "at_large" && !named) push("payload.district_name", `district_kind=${p.district_kind} 要帶 district_name（選挙区名，例：北区、四国ブロック）`);
      }
      if (p.district_lg_code !== undefined && p.district_lg_code !== null) {
        if (!lgCodeValid(p.district_lg_code)) push("payload.district_lg_code", "district_lg_code 要是團體碼 6 碼（檢查碼要對）");
        else if (p.district_kind !== "district") push("payload.district_lg_code", "district_lg_code 只有 district_kind=district 才帶");
      }
      if (p.list_rank !== undefined && p.list_rank !== null) {
        if (!(typeof p.list_rank === "number" && Number.isInteger(p.list_rank) && p.list_rank >= 1)) push("payload.list_rank", "list_rank（名簿順位）要是 1 以上的整數");
        else if (p.district_kind !== "proportional") push("payload.list_rank", "list_rank 只有 district_kind=proportional 才帶");
      }
      if (p.withdrawn_after_filing !== undefined && p.withdrawn_after_filing !== null) {
        if (typeof p.withdrawn_after_filing !== "boolean") push("payload.withdrawn_after_filing", "withdrawn_after_filing 要是 true（届出後に辞退）或 false（届出前に取りやめ）");
        else if (p.candidacy_status !== "withdrawn") push("payload.withdrawn_after_filing", "withdrawn_after_filing 只有 candidacy_status=withdrawn 才帶");
      }
      if (p.birth_year !== undefined && p.birth_year !== null && !(typeof p.birth_year === "number" && Number.isInteger(p.birth_year) && p.birth_year >= 1900 && p.birth_year <= new Date().getUTCFullYear())) {
        push("payload.birth_year", "birth_year 要是西曆四位數整數（例：1975）；不知道就不要填");
      }
      break;
    }
    case "politician": {
      // 既存の人物に生年・読み（kana、空欄だけ）・学歴・経歴を足す（選舉鏈第 3 步）：人物は candidacy でだけ作る。name は直さない（correction）。
      // 学歴・経歴は一条一項の配列（日本站は politician_careers の一列一項目。kind=career が正見の experience）。落庫は SQL policy_jp.apply_politician（20261010050000）
      // 名前は直さない。読み（kana）は空欄を埋めるだけ（工作單 policy-ops#60）：庫に読みがあって違う値＝落庫で差し戻し（読みの訂正は correction）
      if (p.name !== undefined) push("payload.name", "politician では名前は直さない（改名は correction）：この欄位を拿掉");
      if (p.kana !== undefined) {
        if (!isStr(p.kana, 1, 80)) push("payload.kana", "kana 要是 1～80 字（人物姓名的讀音，ひらがな）");
        else if (!JP_KANA_RE.test((p.kana as string).trim())) push("payload.kana", "kana 要全部是ひらがな（不含空白與括號）");
      }
      if (!isStr(p.politician_id, 1, 64)) push("payload.politician_id", "politician_id 必填（任務 target.politician_id の値）。新しい人は candidacy で作る");
      const hasBirth = p.birth_year !== undefined && p.birth_year !== null;
      if (hasBirth && !(typeof p.birth_year === "number" && Number.isInteger(p.birth_year) && p.birth_year >= 1900 && p.birth_year <= new Date().getUTCFullYear())) {
        push("payload.birth_year", "birth_year 要是西曆四位數整數（1900～今年，例：1975），不是和曆也不是文字");
      }
      let facts = (hasBirth ? 1 : 0) + (p.kana !== undefined ? 1 : 0);
      for (const k of ["education", "career"] as const) {
        const v = p[k];
        if (v === undefined) continue;
        if (!(Array.isArray(v) && v.length >= 1 && v.length <= 30 && v.every((s) => isStr(s, 1, 200)))) push(`payload.${k}`, `${k} 要是 1～30 項的字串陣列，一項一個字串（每項 1～200 字；不要把多項寫成一段文章）`);
        else facts++;
      }
      if (facts === 0) push("payload.birth_year", "birth_year・kana・education・career 至少要有一個（這一筆要補什麼事實）");
      break;
    }
    case "policy": {
      // 公約（選舉鏈第 4 步）：origin は常に pledge、status は not_started（サーバーが入れる）。欄位照 policy_jp.policies の CHECK。落庫は SQL policy_jp.apply_policy（20261010060000）
      if (!isStr(p.politician_election_id, 1, 200)) push("payload.politician_election_id", "politician_election_id 必填（任務 target.politician_election_id 的值）");
      // 字數は前後の空白（全角も）を落としてからコードポイントで数える（SQL の policy_trim＋char_length と同じ）
      const len = (v: unknown): number => (typeof v === "string" ? cpLen(jpTrim(v)) : 0);
      if (len(p.title) < 4 || len(p.title) > 100) push("payload.title", "title 必填（4～100 字：公約的題名）");
      if (len(p.description) < 10 || len(p.description) > 120) push("payload.description", "description 必填（10～120 字的要約：只寫事實，不抄原文的修辭）");
      if (len(p.category) < 1 || len(p.category) > 30) push("payload.category", "category 必填（1～30 字，分野，例：子育て）");
      if (len(p.source_locator) < 1 || len(p.source_locator) > 200) push("payload.source_locator", "source_locator 必填（1～200 字：原文的哪裡，例：選挙公報 2 頁「子育て」）");
      if (p.proposed_date !== undefined && p.proposed_date !== null) {
        if (!isJpDate(p.proposed_date)) push("payload.proposed_date", "proposed_date 要是 YYYY-MM-DD（年份 1947～2100）；不知道就不要填");
        else if (p.proposed_date > new Date().toISOString().slice(0, 10)) push("payload.proposed_date", "proposed_date 不能是未來的日期");
        else {
          // 参選紀錄 id＝<人物 id>:<選挙 id>:<district_kind>、選挙 id の頭が投票日：公約は投票日より後に出ない（SQL apply_policy と同じ規則）
          const m = /:(\d{4}-\d{2}-\d{2})_[a-z_]+_(?:\d{6}|national):/.exec(String(p.politician_election_id ?? ""));
          if (m && p.proposed_date > m[1]) push("payload.proposed_date", `proposed_date 不能晚於這場選舉的投票日（${m[1]}）`);
        }
      }
      for (const k of ["origin", "status"]) if (p[k] !== undefined) push(`payload.${k}`, "這一步只收公約（origin=pledge、status=not_started 由伺服器填）：把這個欄位拿掉");
      break;
    }
    case "policy_elements": {
      // 政見三要素（正見 1.50.0 の日本版）：政見 1 件の要素 1～3 個。stated=false（原文を調べたが書いていない）も答え——画面は「未説明」、行がない（未調査）と分ける。
      // 補わない・換算しない・評価しない：text は原文の事実だけ。落庫は SQL policy_jp.apply_policy_elements（policy_element_normalize が同じ規則）
      if (!isStr(p.policy_id, 1, 64) || /\s/.test(p.policy_id)) push("payload.policy_id", "policy_id 必填（任務 target.policy_id の値）");
      if (!Array.isArray(p.elements) || p.elements.length === 0 || p.elements.length > POLICY_ELEMENT_KINDS.length) {
        push("payload.elements", "elements 必填：1～3 個、それぞれオブジェクト（target 数値目標／deadline 達成期限／funding 財源）");
        break;
      }
      const seenKinds = new Set<string>();
      (p.elements as unknown[]).forEach((raw, i) => {
        const at = `payload.elements[${i}]`;
        if (!isObj(raw)) { push(at, "各要素はオブジェクト：{element, stated, text, deadline_date, source_locator, source_url}"); return; }
        const e = raw;
        for (const k of ["text", "deadline_date", "source_locator", "source_url"]) {
          if (e[k] !== undefined && e[k] !== null && typeof e[k] !== "string") push(`${at}.${k}`, "要是字串");
        }
        if (!oneOf(POLICY_ELEMENT_KINDS, e.element)) push(`${at}.element`, "element 要是 target（数値目標）／deadline（達成期限）／funding（財源）之一");
        else if (seenKinds.has(e.element)) push(`${at}.element`, `${e.element} 重複：同じ政見の同じ要素は 1 回だけ`);
        else seenKinds.add(e.element);
        if (typeof e.stated !== "boolean") {
          push(`${at}.stated`, "stated 必填：true＝原文に書いてある／false＝原文を調べたが書いていない（画面は「未説明」）");
        } else if (e.stated) {
          const text = typeof e.text === "string" ? jpTrim(e.text) : "";
          if (!text) { if (e.text === undefined || e.text === null || typeof e.text === "string") push(`${at}.text`, "原文に書いてある（stated=true）なら text 必填：原文のとおり、言い換えない・数字を補わない"); }
          else if (charLength(text) > POLICY_ELEMENT_TEXT_MAX) push(`${at}.text`, `text 最多 ${POLICY_ELEMENT_TEXT_MAX} 字：この要素だけを書く（原文が長いときは数字・期限・財源が書かれた部分だけ）`);
        } else if (typeof e.text === "string" && jpTrim(e.text)) {
          push(`${at}.text`, "stated=false（原文に書いていない）のときは text を付けない：書いていないものを補ったり「未説明」と書いたりしない");
        }
        if (e.deadline_date !== undefined && e.deadline_date !== null && e.deadline_date !== "") {
          if (e.element !== "deadline" || e.stated !== true) {
            push(`${at}.deadline_date`, "deadline_date は、原文に書いてある達成期限（element=deadline、stated=true）のときだけ付ける");
          } else if (!isRealDate(e.deadline_date) || Number(e.deadline_date.slice(0, 4)) < DEADLINE_YEAR_MIN || Number(e.deadline_date.slice(0, 4)) > DEADLINE_YEAR_MAX) {
            push(`${at}.deadline_date`, "西暦 YYYY-MM-DD の実在する日付。会計年度は 4/1～3/31：「2028 年度まで」は 2029-03-31、暦年の書き方「2028 年末まで」は 2028-12-31。日付にできない書き方（「早期に」など）は付けない");
          }
        }
        const locator = typeof e.source_locator === "string" ? jpTrim(e.source_locator) : "";
        if (!locator || charLength(locator) > POLICY_ELEMENT_LOCATOR_MAX) {
          push(`${at}.source_locator`, `source_locator 必填（1～${POLICY_ELEMENT_LOCATOR_MAX} 字）：原文のどこか（例：選挙公報 2 頁「子育て」第 3 項）。stated=false でも、どの部分を調べたかを書く`);
        }
        if (e.source_url !== undefined && e.source_url !== null && e.source_url !== "" && !(typeof e.source_url === "string" && /^https?:\/\/\S+$/i.test(e.source_url))) {
          push(`${at}.source_url`, "source_url は http(s) の URL（この交件の source_urls のどれか：この要素の原文）");
        }
      });
      break;
    }
    case "district_seats": {
      // 議員定数（正見 district_seats の日本版）：議会議員選挙 1 件の定数合計と選挙区ごとの定数。落庫は SQL policy_jp.apply_district_seats（district_seats_normalize が同じ規則）
      if (!isStr(p.election_id, 1, 64) || /\s/.test(p.election_id)) push("payload.election_id", "election_id 必填（任務 target.election_id の値）");
      const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
      if (!intIn(p.seats_total, 1, DISTRICT_SEATS_MAX)) push("payload.seats_total", `seats_total 必填：1～${DISTRICT_SEATS_MAX} の整数（その選挙の議員定数の合計）`);
      if (!oneOf(DISTRICT_SEATS_BASES, p.seats_basis)) push("payload.seats_basis", "seats_basis 必填：law（議員定数条例）か notice（選挙管理委員会の告示）");
      if (!Array.isArray(p.districts) || p.districts.length === 0 || p.districts.length > DISTRICT_SEATS_MAX_DISTRICTS) {
        push("payload.districts", `districts 必填：1～${DISTRICT_SEATS_MAX_DISTRICTS} 件の配列（選挙区がなければ at_large を 1 件）`);
        break;
      }
      const seenKeys = new Set<string>();
      const kinds = new Set<string>();
      let sum = 0;
      let sumOk = true;
      (p.districts as unknown[]).forEach((raw, i) => {
        const at = `payload.districts[${i}]`;
        if (!isObj(raw)) { push(at, "各件はオブジェクト：{district_kind, district_name, district_lg_code, seats}"); sumOk = false; return; }
        const kind = raw.district_kind;
        if (!oneOf(DISTRICT_SEATS_KINDS, kind)) push(`${at}.district_kind`, "district_kind は at_large（選挙区なし・全域で一つ）か district（選挙区）");
        else kinds.add(kind);
        const name = typeof raw.district_name === "string" ? jpTrim(raw.district_name) : "";
        if (raw.district_name !== undefined && raw.district_name !== null && typeof raw.district_name !== "string") push(`${at}.district_name`, "要是字串");
        else if (kind === "district" && (!name || name.length > 50)) push(`${at}.district_name`, "district_kind=district のときは district_name 必須（選挙区の名前、50 字まで）");
        else if (kind === "at_large" && name) push(`${at}.district_name`, "district_kind=at_large のときは district_name を付けない");
        const lg = typeof raw.district_lg_code === "string" ? jpTrim(raw.district_lg_code) : "";
        if (raw.district_lg_code !== undefined && raw.district_lg_code !== null && raw.district_lg_code !== "") {
          if (typeof raw.district_lg_code !== "string" || !/^\d{6}$/.test(lg)) push(`${at}.district_lg_code`, "district_lg_code は団体コード 6 桁");
          else if (kind !== "district") push(`${at}.district_lg_code`, "district_lg_code は district_kind=district のときだけ付けられる");
          else if (!lgCodeValid(lg)) push(`${at}.district_lg_code`, "district_lg_code の検査コード（第 6 桁）が合わない：総務省「全国地方公共団体コード」を確かめる");
        }
        if (!intIn(raw.seats, 1, DISTRICT_SEATS_MAX)) { push(`${at}.seats`, `seats は 1～${DISTRICT_SEATS_MAX} の整数（その選挙区の定数）`); sumOk = false; }
        else sum += raw.seats;
        const key = `${String(kind)}|${name}`;
        if (seenKeys.has(key)) push(`${at}.district_name`, `選挙区が重複している：${name || "（at_large）"}`);
        seenKeys.add(key);
      });
      if (kinds.size > 1) push("payload.districts", "at_large と district を一つの交件に混ぜない（選挙区がなければ at_large を 1 件、あれば district だけ）");
      else if (kinds.has("at_large") && p.districts.length !== 1) push("payload.districts", "at_large は 1 件だけ");
      if (sumOk && intIn(p.seats_total, 1, DISTRICT_SEATS_MAX) && sum !== p.seats_total) push("payload.seats_total", `districts の seats の合計（${sum}）が seats_total（${p.seats_total}）と合わない`);
      break;
    }
    case "regional_stat": {
      // 地域統計：欄位照 policy_jp.regional_stats 的 CHECK；單位固定（一個 stat_key 一種單位），交件要明寫，讓驗證者一眼看出有沒有搞錯千円／円
      if (!lgCodeValid(p.lg_code)) push("payload.lg_code", "lg_code 必填：全国地方公共団体コード 6 碼數字，檢查碼（第 6 碼）要對");
      const keyOk = oneOf(JP_STAT_KEYS, p.stat_key);
      if (!keyOk) push("payload.stat_key", `stat_key 必填：${JP_STAT_KEYS.join("／")} 之一`);
      if (!(typeof p.year === "number" && Number.isInteger(p.year) && p.year >= 1900 && p.year <= 2100)) push("payload.year", "year 必填：西暦的整數（1900～2100；歳出是会計年度的開始年，例：令和5年度＝2023）");
      if (!(typeof p.value === "number" && Number.isFinite(p.value))) push("payload.value", "value 必填：數字（不要帶單位、逗號或文字）");
      else if (keyOk) {
        const v = p.value as number;
        const k = p.stat_key as (typeof JP_STAT_KEYS)[number];
        if (v < 0) push("payload.value", "value 不能是負數");
        else if (k === "aging_rate" && v > 100) push("payload.value", "aging_rate 是百分比，要在 0～100 之間（例：29.6）");
        else if (k === "area_km2" && v <= 0) push("payload.value", "area_km2 要大於 0（單位 km2）");
        else if ((k === "population" || k === "budget_expenditure") && !Number.isInteger(v)) push("payload.value", `${k} 要是整數（population 單位「人」、budget_expenditure 單位「千円」）`);
      }
      if (keyOk) {
        const want = JP_STAT_UNITS[p.stat_key as (typeof JP_STAT_KEYS)[number]];
        if (p.unit !== want) push("payload.unit", `${p.stat_key} 的 unit 要是「${want}」（值也要換算成這個單位）`);
      } else if (!isStr(p.unit, 1, 20)) push("payload.unit", "unit 必填");
      if (p.as_of !== undefined && !isJpDate(p.as_of)) push("payload.as_of", "as_of 要是 YYYY-MM-DD（基準日，年份 1947～2100，例：國勢調査 2020-10-01）；不知道就不要填");
      break;
    }
  }
}

/** 把請求 body 正規化成清單並逐筆驗證；有任何錯就整批不收（讓 AI 一次修完再送）。 */
export function validateContributionRequest(body: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const items: ContributionInput[] = [];
  const contributor: Contributor = { agent_name: "" };

  if (!isObj(body)) return { ok: false, errors: [{ index: -1, path: "body", message: "body 要是 JSON 物件" }], items, contributor };

  const encodingProblems = findEncodingProblems(body);
  if (encodingProblems.length > 0) {
    return {
      ok: false,
      errors: encodingProblems.map((p) => ({ index: -1, path: p, message: ENCODING_INVALID_MESSAGE, code: "encoding_invalid" as const })),
      items,
      contributor,
    };
  }

  if (!isValidAgentName(body.agent_name)) errors.push({ index: -1, path: "agent_name", message: AGENT_NAME_MSG });
  else contributor.agent_name = body.agent_name;
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
    const push = (path: string, message: string) => errors.push({ index, path, message });
    if (!isObj(raw)) { push("", "每筆要是物件"); return; }
    if (!oneOf(JP_CONTRIBUTION_TYPES, raw.contribution_type)) { push("contribution_type", `要是 ${JP_CONTRIBUTION_TYPES.join("／")} 之一`); return; }
    if (!isObj(raw.payload)) { push("payload", "payload 要是物件"); return; }
    // no_change 沒給 source_urls 時，用 payload.checked_urls 當來源（驗證者照那些網址核對）
    const usesChecked = raw.contribution_type === "no_change";
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
    // no_change 的 task_id：how_to 教代理放頂層，schema 只認 payload.task_id；頂層有、payload 沒有 → 灌進去再驗
    if (raw.contribution_type === "no_change" && isObj(raw.payload) && !raw.payload.task_id && typeof raw.task_id === "string" && raw.task_id) {
      raw.payload.task_id = raw.task_id;
    }
    validatePayload(raw.contribution_type, raw.payload, push);
    // 同一件事（#521，協議 0.7.0）：登記在 same-claims.ts 的型別，交件前要先看 item.current.same_claims 並宣告 resolved_claim
    if (isSameClaimType("jp", raw.contribution_type)) {
      const resolved = parseResolvedClaim(raw.payload.resolved_claim);
      if (!resolved) push("payload.resolved_claim", RESOLVED_CLAIM_HELP);
      else if (resolved.kind === "differs" && !isStr(raw.note, 10, 2000)) push("note", "resolved_claim 是 differs:<id> 時 note 必填（≥10 字）：跟那一筆差在哪、你的出典是哪一頁");
    }
    // 同一個欄位前面已經報過錯就不重複報（例：lg_code 格式不對，已經有一條了）
    checkTaskAgreement(raw.contribution_type, raw.payload, raw.task_id, (path, message) => {
      if (!errors.some((e) => e.index === index && e.path === path)) push(path, message);
    });
    // 地方公共団体・地域統計：出典は公的なもの——總務省・e-Stat・*.go.jp・*.lg.jp・団体の公式サイトを最低 1 つ（媒體・社群だけの交件は收不進來）
    if ((raw.contribution_type === "local_government" || raw.contribution_type === "regional_stat") && Array.isArray(sourceUrls)
        && sourceUrls.every((u) => typeof u === "string") && sourceUrls.length > 0
        && !(sourceUrls as string[]).some((u) => isJpOfficialSource(u, raw.contribution_type as string))) {
      push("source_urls", raw.contribution_type === "local_government"
        ? "source_urls 至少要有一個公的出典：總務省「全国地方公共団体コード」（soumu.go.jp）或該団体的公式サイト（*.lg.jp、city.／town.／vill.／pref. 開頭的 .jp 網域）"
        : "source_urls 至少要有一個公的統計出典：e-Stat（e-stat.go.jp）、總務省・統計局（soumu.go.jp、stat.go.jp）或該団体的公式サイト（*.lg.jp 等）");
    }
    // candidacy_source_missing（#589 審查の後続）：この任務は「選管の公表ページ（official 等級）を足す」こと。報道だけの candidacy は
    // 同じ状態の unchanged で落庫され派工は収回されるが、official の出典は付かないので次の seed で同じ任務がまた開く（無限に再派工）。入口で断る
    if (raw.contribution_type === "candidacy" && typeof raw.task_id === "string" && raw.task_id.startsWith("auto:candidacy_source_missing:")
        && Array.isArray(sourceUrls) && sourceUrls.every((u) => typeof u === "string") && sourceUrls.length > 0
        && !(sourceUrls as string[]).some((u) => jpSourceKind(u, "candidacy") === "official")) {
      push("source_urls", "この任務は選挙管理委員会の公表ページを足すためのものです：source_urls に official 等級の網址（*.go.jp・*.lg.jp、city.／town.／vill.／pref.／ward. で始まる .jp の自治体公式サイト）を最低 1 つ入れてください。選管のページが見つからなければ candidacy ではなく no_change（outcome=not_found）で報告します");
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
const isHttp = (s: string) => /^https?:\/\/\S+$/.test(s);

/** POST /report{kind:verify} 的請求驗證：disagree 一定要有 evidence_url（http(s)）與 note。 */
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
    if (!isStr(body.evidence_url, 8, 2000) || !isHttp(body.evidence_url)) errors.push({ path: "evidence_url", message: "evidence_url 要是可打開的 http(s) 網址" });
  } else if (body.verdict === "disagree") {
    errors.push({ path: "evidence_url", message: "投 disagree 一定要附 evidence_url（反證網址；來源打不開時可附原 source_url）與 note 說明哪裡不對" });
  }
  if (body.verdict === "disagree" && !isStr(body.note, 5, 2000)) errors.push({ path: "note", message: "投 disagree 要寫 note（至少 5 字）說明依據" });
  else if (body.note !== undefined && !isStr(body.note, 1, 2000)) errors.push({ path: "note", message: "要是 1～2000 字" });
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
    },
  };
}

/** 去重用：型別＋payload（鍵排序後）的穩定 JSON（同正見 canonicalPayload；雜湊相同＝內容相同）。 */
export function canonicalPayload(item: ContributionInput): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
  };
  return JSON.stringify({ t: item.contribution_type, p: sortKeys(item.payload) });
}
