/**
 * 外部貢獻（contribute／report Edge Function）的請求格式與驗證。手寫、無依賴，Deno／Node 都能跑。
 * public/skill.md 描述的就是這份 schema，改欄位要兩處一起改。
 */

import { checkSourceSet, isHttpUrl } from "./source-priority.ts";
import { isValidAgentName, isValidAgentTool, type Verdict } from "./consensus.ts";
import { MAX_CORRECTION_CHANGES, normalizeCorrection } from "./correction.ts";

export const CONTRIBUTION_TYPES = ["politician", "candidacy", "policy", "policy_progress", "correction", "task_suggestion", "no_change", "adjudication", "question_answer"] as const;
export const TASK_TYPES = ["policy_missing", "profile_gap", "policy_source_missing", "progress_stale", "candidacy_source_missing", "audit", "adjudicate", "question", "other"] as const;
/** citizen_questions.answer／question_answers.answer 的長度界線（跟 migration 20260912000014 的 CHECK 一致） */
export const QUESTION_ANSWER_MIN = 30;
export const QUESTION_ANSWER_MAX = 4000;
export const ADJUDICATION_VERDICTS = ["uphold", "reject"] as const;
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
export const CORRECTION_TABLES = ["politicians", "politician_elections", "policies"] as const;

/** correction 可改的欄位（其他欄位一律拒收，避免任意 UPDATE） */
export const CORRECTION_FIELDS: Record<(typeof CORRECTION_TABLES)[number], readonly string[]> = {
  politicians: ["name", "party", "birth_year", "current_position", "region", "sub_region", "education_level", "bio", "avatar_url"],
  politician_elections: ["candidate_status", "position", "election_type"],
  policies: ["title", "description", "category", "status", "proposed_date", "source_url", "election_id"],
};

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
function validateProposedDate(value: unknown, electionId: unknown, push: (path: string, message: string) => void): void {
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
  // election_id 就是選舉年份，政見不會在那屆選完之後才提出。
  if (isInt(electionId) && Number(value.slice(0, 4)) > electionId) {
    push("payload.proposed_date", `這筆掛在 ${electionId} 年那屆選舉，提出日期不會晚於 ${electionId} 年；查不到就別填`);
  }
}
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => typeof v === "string" && (list as readonly string[]).includes(v);

function validateHints(p: Obj, push: (path: string, message: string) => void): void {
  if (p.politician_id !== undefined && !isUuid(p.politician_id)) push("payload.politician_id", "要是 uuid");
  if (p.birth_year !== undefined && !(isInt(p.birth_year) && p.birth_year >= 1900 && p.birth_year <= 2010)) push("payload.birth_year", "要是 1900～2010 的整數（西元）");
  if (p.party !== undefined && !isStr(p.party, 1, 50)) push("payload.party", "政黨要是非空字串");
  if (p.region !== undefined && !isStr(p.region, 2, 20)) push("payload.region", "縣市名要是字串（例：彰化縣）");
  if (p.current_position !== undefined && !isStr(p.current_position, 1, 200)) push("payload.current_position", "現職要是非空字串");
  if (p.election_type !== undefined && !oneOf(ELECTION_TYPES, p.election_type)) push("payload.election_type", `要是 ${ELECTION_TYPES.join("／")} 之一`);
}

function validatePayload(type: ContributionType, p: Obj, push: (path: string, message: string, code?: ValidationCode) => void): void {
  switch (type) {
    case "politician": {
      if (!isStr(p.name, 2, 30)) push("payload.name", "姓名必填（2～30 字）");
      validateHints(p, push);
      const optional = ["position", "sub_region", "education_level", "bio", "avatar_url", "slogan"];
      for (const k of optional) if (p[k] !== undefined && !isStr(p[k], 1, 5000)) push(`payload.${k}`, "要是非空字串");
      if (p.avatar_url !== undefined && !/^https:\/\//.test(String(p.avatar_url))) push("payload.avatar_url", "要是 https 網址");
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
      if (p.cand_no !== undefined && !(isInt(p.cand_no) && p.cand_no > 0)) push("payload.cand_no", "號次要是正整數");
      break;
    }
    case "policy": {
      if (!isUuid(p.politician_id) && !isStr(p.name, 2, 30)) push("payload.name", "要給 politician_id 或政治人物姓名");
      if (!isStr(p.title, 4, 200)) push("payload.title", "政見標題必填（4～200 字）");
      if (!isStr(p.description, MIN_POLICY_DESCRIPTION, 5000)) push("payload.description", `政見內容必填（至少 ${MIN_POLICY_DESCRIPTION} 字，寫清楚承諾了什麼）`);
      if (!isCanonicalCategory(p.category)) push("payload.category", categoryErrorMessage(p.category), "category_invalid");
      if (p.status !== undefined && !oneOf(POLICY_STATUSES, p.status)) push("payload.status", `要是 ${POLICY_STATUSES.join("／")} 之一`);
      if (p.election_id !== undefined && !(isInt(p.election_id) && KNOWN_ELECTION_IDS.includes(p.election_id))) push("payload.election_id", `要是 ${KNOWN_ELECTION_IDS.join("／")}`);
      validateProposedDate(p.proposed_date, p.election_id, push);
      validateHints(p, push);
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
    case "adjudication": {
      // 裁決一筆 disputed 的貢獻：uphold＝原貢獻正確、reject＝原貢獻有誤；4 票同向定案
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
        else if (table === "policies" && c.field === "category" && !isCanonicalCategory(c.correct_value)) push(`${at}.correct_value`, categoryErrorMessage(c.correct_value), "category_invalid");
        else if (table === "policies" && c.field === "proposed_date") validateProposedDate(c.correct_value, undefined, (_path, message) => push(`${at}.correct_value`, message));
        else if (table === "policies" && c.field === "election_id" && !(isInt(c.correct_value) && KNOWN_ELECTION_IDS.includes(c.correct_value))) push(`${at}.correct_value`, `要是 ${KNOWN_ELECTION_IDS.join("／")}（就是選舉年份）`);
      });
      if (table === "policies") {
        // 同一筆裡同時改屆別與提出日期時，兩者要對得上
        const newElection = changes.find((c) => c.field === "election_id")?.correct_value;
        const newDate = changes.find((c) => c.field === "proposed_date")?.correct_value;
        if (isInt(newElection) && typeof newDate === "string" && isDate(newDate) && Number(newDate.slice(0, 4)) > newElection) {
          push(usesChanges ? "payload.changes" : "payload", `提出日期 ${newDate} 晚於你要改成的 ${newElection} 年那屆選舉，兩者對不上`);
        }
      }
      if (!isStr(p.reason, 10, 2000)) push("payload.reason", "reason 必填（至少 10 字，只放判斷依據；事實請放進 changes 的欄位）");
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
    validatePayload(raw.contribution_type, raw.payload, push);
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
