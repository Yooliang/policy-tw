/**
 * 日本站貢獻請求的格式與驗證（只收 no_change、task_suggestion、correction 三種）。
 *
 * 複製自 ../contribution-schema.ts：validateContributionRequest／validateVerifyRequest／canonicalPayload，
 * 以及 validatePayload 裡 no_change、task_suggestion、correction 三段的欄位規則（欄位名、字數、錯誤文字都照抄）。
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

export { ENCODING_INVALID_MESSAGE, sha256Hex };

export const JP_CONTRIBUTION_TYPES = ["no_change", "task_suggestion", "correction"] as const;
export type JpContributionType = (typeof JP_CONTRIBUTION_TYPES)[number];

/** 【待定】日本站已建的資料表（20261009000000_policy_jp_tables.sql）裡可以被更正的；落庫（apply）定案時一併收斂 */
export const JP_CORRECTION_TABLES = ["politicians", "politician_elections", "politician_offices", "policies", "parties", "elections", "lineages"] as const;
/** 欄位名只擋亂寫（小寫英數底線） */
export const JP_FIELD_RE = /^[a-z][a-z0-9_]{0,49}$/;
export const JP_TASK_TYPE_RE = /^[a-z][a-z0-9_]{0,59}$/;

/** /next 給的 task_id 只有兩種形狀：手動任務 uuid、自動缺口 auto:<型別>:<對象>（同正見 isTaskIdShape） */
export const isTaskIdShape = (v: unknown): boolean =>
  typeof v === "string" && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^auto:[a-z0-9_]+:\S+$/.test(v));

export const NO_CHANGE_OUTCOMES = ["confirmed", "unreachable", "not_found"] as const;
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
      if (p.target_politician_id !== undefined && !isUuid(p.target_politician_id)) push("payload.target_politician_id", "要是 uuid");
      if (p.target_policy_id !== undefined && !isUuid(p.target_policy_id)) push("payload.target_policy_id", "要是 uuid");
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
