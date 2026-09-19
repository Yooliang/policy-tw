/**
 * Jev（TypeSafe System One）的共用邏輯：怎麼組 state、怎麼問、怎麼驗紀錄。純函式＋一個 HTTP 呼叫。
 * 設計理由與實測數字見 docs/BLUEPRINT-jev-decisions.md；這裡的每個常數都對得到那份文件的某一節。
 *
 * 三條使用規則（每一條都是踩到才知道的，藍圖 §2）：
 *   1. 事實放 state，選項放 criteria。放錯邊會答錯。
 *   2. 一次呼叫只處理一個主體；同一主體問幾題都可以。
 *   3. 我們已經知道的答案要放進 state 當參考（already_labelled 讓斷年度從 5/8 變 8/8）。
 */

export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
/** 釘版本，不用 ~typesafe/jev-latest：alias 換版不通知，而我們要能回答「當初為什麼這樣定案」 */
export const JEV_MODEL = "typesafe/jev-1.13";
/** 門檻 0.95：同題重問只有機率 ≤0.55 會換答案，兩次都 ≥0.95 的 155 題全數一致（藍圖 §8-1） */
export const MIN_PROBABILITY = 0.95;

export const SUBJECT_TYPES = ["policy", "identity_review", "politician_pair"] as const;
export const QUESTIONS = ["is_policy", "duplicate_of", "election", "identity", "same_person"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type Question = (typeof QUESTIONS)[number];

/** 帶日期的完整版本才收（typesafe/jev-1.13-20260917）。收了 alias，半年後沒人知道那個 latest 是哪一版 */
export const MODEL_RE = /^[a-z0-9~._-]+\/[a-z0-9._-]+-\d{8}$/i;

// ---- 政見三判定的 state 與題目 ----

export interface PolicyLite {
  id: string;
  title: string;
  description: string | null;
  election_id: number | null;
}
export interface ElectionLite {
  election_id: number;
  election_type: string | null;
  candidate_status: string | null;
  election_result: string | null;
}
export interface JevQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

const TARGET_DESC_MAX = 800;
const OTHER_DESC_MAX = 200;

/**
 * 組一筆政見的 state 與三題。跟 2026-09-19 全量掃描用的組法一致（藍圖 §4-3 的「需要放進 state 的資料」）。
 * 沒有兄弟政見就不問排重；沒有參選紀錄就不問屆別——criteria 只剩一個選項的題目沒有意義。
 */
export function buildPolicyAsk(target: PolicyLite, siblings: PolicyLite[], elections: ElectionLite[]): {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
} {
  const sib = siblings.filter((q) => q.id !== target.id);
  const state: Record<string, unknown> = {
    target: { title: target.title, description: (target.description ?? "").slice(0, TARGET_DESC_MAX) },
  };
  const questions: Record<string, JevQuestion> = {
    is_policy: {
      type: "choice",
      instructions: "target 是一條具體政見，還是口號／願景／包裹式標題？政見＝當選後要做的具體事情，看得出做什麼、給誰、做到什麼程度。",
      criteria: { policy: "具體政見", not_policy: "口號、願景、或把好幾條政見包起來的標題，本身沒有具體內容" },
    },
  };
  if (sib.length > 0) {
    state.others = Object.fromEntries(sib.map((q) => [shortId(q.id), { title: q.title, description: (q.description ?? "").slice(0, OTHER_DESC_MAX) }]));
    const criteria: Record<string, string> = Object.fromEntries(sib.map((q) => [shortId(q.id), q.title]));
    criteria.none = "跟其他每一筆都不是同一個承諾";
    questions.duplicate_of = {
      type: "choice",
      instructions: "target 跟 others 裡的哪一筆是同一個承諾換句話說（同一件事、同一個對象、同樣的程度）？只是主題相近、對象不同、或一筆是把好幾條包起來的總稱，都不算重複。",
      criteria,
    };
  }
  if (elections.length > 0) {
    state.elections = elections;
    const labelled = sib.filter((q) => q.election_id != null).map((q) => ({ title: q.title, election_id: q.election_id }));
    if (labelled.length > 0) state.already_labelled = labelled;
    const criteria: Record<string, string> = Object.fromEntries(elections.map((e) => [
      String(e.election_id),
      `${e.election_id}年${e.election_type ?? ""}（${e.election_result ?? e.candidate_status ?? ""}）`,
    ]));
    criteria.unknown = "從文字判斷不出來";
    questions.election = {
      type: "choice",
      instructions: "target 這條承諾屬於 elections 裡的哪一場選舉？依 target 的文字判斷它承諾的職權範圍（「當選新北市長後」＝縣市長那場）。already_labelled 是同一個人已標好屆別的政見，可當參考。看不出來選 unknown。",
      criteria,
    };
  }
  return { state, questions };
}

/** criteria 的 key 用 uuid 前 8 碼：全量掃描時就是這樣寫的，寫進 jev_decisions.choice 的也是這個 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

// ---- 呼叫 ----

export interface JevAnswer {
  type: string;
  choice: string;
  probabilities: Record<string, number>;
  confidence?: number;
}
export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost: number };
}

export async function askJev(
  apiKey: string,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
  fetchImpl: typeof fetch = fetch,
): Promise<JevResponse> {
  const res = await fetchImpl(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: JEV_MODEL, state, questions }),
  });
  if (!res.ok) throw new Error(`openrouter decisions ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json() as JevResponse;
  if (!body?.answers || !body?.model) throw new Error("openrouter decisions 回應缺 answers 或 model");
  return body;
}

// ---- 紀錄 ----

export interface DecisionRecord {
  subject_type: SubjectType;
  subject_id: string;
  question: Question;
  choice: string;
  probability: number;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  model: string;
  state: Record<string, unknown>;
  cost_usd: number | null;
}

/** 把一次回應攤成每題一列。cost 平均分到每題——OpenRouter 只給整次的成本 */
export function toRecords(
  subjectType: SubjectType,
  subjectId: string,
  state: Record<string, unknown>,
  res: JevResponse,
): DecisionRecord[] {
  const names = Object.keys(res.answers);
  const perQuestion = names.length > 0 ? res.usage.cost / names.length : null;
  return names.map((name) => {
    const a = res.answers[name];
    return {
      subject_type: subjectType,
      subject_id: subjectId,
      question: name as Question,
      choice: a.choice,
      probability: round4(a.probabilities?.[a.choice] ?? 0),
      confidence: a.confidence == null ? null : round4(a.confidence),
      probabilities: a.probabilities ?? null,
      model: res.model,
      state,
      cost_usd: perQuestion == null ? null : Number(perQuestion.toFixed(8)),
    };
  });
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 回傳錯誤訊息；null 表示這筆沒問題。system-one 的 record 動作靠它擋外面送進來的東西 */
export function validateRecord(r: Partial<DecisionRecord> | null | undefined): string | null {
  if (!r || typeof r !== "object") return "不是物件";
  if (!(SUBJECT_TYPES as readonly string[]).includes(r.subject_type ?? "")) return `subject_type 必須是 ${SUBJECT_TYPES.join("／")}`;
  if (!r.subject_id || typeof r.subject_id !== "string") return "subject_id 必填";
  if (!(QUESTIONS as readonly string[]).includes(r.question ?? "")) return `question 必須是 ${QUESTIONS.join("／")}`;
  if (!r.choice || typeof r.choice !== "string") return "choice 必填";
  if (typeof r.probability !== "number" || r.probability < 0 || r.probability > 1) return "probability 要是 0～1 的數字";
  if (r.confidence != null && (typeof r.confidence !== "number" || r.confidence < 0 || r.confidence > 1)) return "confidence 要是 0～1 的數字";
  if (!r.model || !MODEL_RE.test(r.model)) return "model 要用回應裡帶日期的完整版本（例如 typesafe/jev-1.13-20260917），不收 alias";
  if (r.state == null || typeof r.state !== "object" || Object.keys(r.state).length === 0) return "state 必填且不能是空物件——少了它事後無法重現";
  return null;
}

// ---- 系統來源票：抓提交的來源，問 Jev 支不支持這筆宣稱 ----
// 2026-09-19 回測 74 筆已定案貢獻：因來源有問題被拒的 3 筆全判 not_supported（機率 0.45～0.70）、
// applied 的 37 筆 supported、1 筆誤判、18 筆 cannot_tell（多是抓不到正文：中選會索引頁、JS 渲染頁）。
// 弱點在抓取不在判斷；Jev 在文字不夠時會選 cannot_tell 而不是硬猜，那正是要的行為。

/**
 * 按型別只留「來源該證明的欄位」。2026-09-19 第一批 precheck 三筆自由時報全 cannot_tell，原因是 claim 帶了
 * birth_year 這種新聞不會寫的欄位、而題目又要求每個欄位都對得上——那是題目出錯，不是來源不支持。
 * 參選紀錄要證的是「這個人在這場選舉登記／參選」；出生年、學歷是 politician 型別的事。
 */
const CLAIM_FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  candidacy: ["name", "party", "region", "election_id", "election_type", "candidate_status", "electoral_district"],
  politician: ["name", "party", "region", "birth_year", "current_position", "education_level"],
  policy: ["name", "politician_name", "title", "description", "election_id", "category"],
  policy_progress: ["policy_title", "status", "progress", "description"],
  // correction 走 flattenCorrection：攤成「<欄位>＝新值」＋ subject_name，不問 target_table／reason 這種頁面證明不了的東西
  correction: ["subject_name"],
};
const CLAIM_FIELDS_DEFAULT = ["name", "title", "description", "election_id"];
const PAGE_TEXT_MAX = 6000;
const FOCUS_BEFORE = 700;
const FOCUS_WINDOW = 1400;

export function claimOf(contributionType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const fields = CLAIM_FIELDS_BY_TYPE[contributionType] ?? CLAIM_FIELDS_DEFAULT;
  const base = Object.fromEntries(Object.entries(payload).filter(([k, v]) => fields.includes(k) && v != null && v !== ""));
  return contributionType === "correction" ? { ...base, ...flattenCorrection(payload) } : base;
}

/**
 * 更正的 claim：每個要改的欄位一題「<欄位>＝新值」。2026-09-19 第一批把 target_table／reason 當欄位問，
 * Jev 回 target_table contradicted 0.63——頁面本來就證明不了資料表名稱，那是題目出錯。
 * 舊格式 {field, correct_value} 與新格式 {changes:[…]} 都收（correction.ts 同一套）。
 */
export function flattenCorrection(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const changes = Array.isArray(payload.changes) ? payload.changes : (payload.field ? [payload] : []);
  for (const ch of changes as Array<Record<string, unknown>>) {
    const f = typeof ch?.field === "string" ? ch.field : null;
    if (f && ch.correct_value != null && ch.correct_value !== "") out[f] = ch.correct_value;
  }
  return out;
}

/**
 * 新聞站多半把整篇正文放在 JSON-LD 的 articleBody（自由時報、中央社、聯合都是），而那個在 <script> 裡，
 * 一般去標籤會把它連 script 一起丟掉——2026-09-19 第一批 precheck 三筆自由時報全 cannot_tell 就是這樣。
 * 有 articleBody 就用它當正文開頭，再接一般抽字的結果當補充。
 */
export function articleBodyFromJsonLd(html: string): string {
  const out: string[] = [];
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let data: unknown;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const items = Array.isArray(data) ? data : [data];
    for (const it of items) {
      if (it && typeof it === "object") {
        const o = it as Record<string, unknown>;
        for (const k of ["headline", "articleBody", "description"]) {
          if (typeof o[k] === "string" && (o[k] as string).trim()) out.push((o[k] as string).trim());
        }
      }
    }
  }
  return out.join("\n");
}

/** 粗抽正文：JSON-LD 的 articleBody 優先，再接去標籤的頁面文字。不求完美，求可重現 */
export function htmlToText(html: string): string {
  const body = articleBodyFromJsonLd(html);
  const stripped = stripHtml(html);
  return body ? `${body}\n\n${stripped}` : stripped;
}

function stripHtml(html: string): string {
  let s = html.replace(/<(script|style|noscript|svg|header|footer|nav)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  s = s.replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n");
  return s.trim();
}

/** 名字附近的段落優先；沒命中就取開頭。上限 PAGE_TEXT_MAX（Jev context 32k，留餘裕） */
export function focusText(text: string, names: Array<string | null | undefined>, limit = PAGE_TEXT_MAX): string {
  if (!text) return "";
  const starts = new Set<number>();
  for (const n of names) {
    if (!n || n.length < 2) continue;
    let i = text.indexOf(n);
    while (i >= 0 && starts.size < 6) { starts.add(Math.max(0, i - FOCUS_BEFORE)); i = text.indexOf(n, i + n.length); }
  }
  if (starts.size === 0) return text.slice(0, limit);
  const chunks: string[] = [];
  let used = 0;
  for (const st of [...starts].sort((a, b) => a - b)) {
    const c = text.slice(st, st + FOCUS_WINDOW);
    chunks.push(c); used += c.length;
    if (used >= limit) break;
  }
  return chunks.join("\n…\n").slice(0, limit);
}

export const SOURCE_SUPPORT_CHOICES = ["supported", "not_supported", "cannot_tell"] as const;
export type SourceSupport = (typeof SOURCE_SUPPORT_CHOICES)[number];
export const FIELD_VERDICTS = ["confirmed", "contradicted", "absent"] as const;
export type FieldVerdict = (typeof FIELD_VERDICTS)[number];

/**
 * 每個型別「來源一定要證明」的核心欄位；其他欄位（政黨簡稱、分類…）可以不在來源裡，但不能矛盾。
 * 2026-09-19 使用者：「每一欄一個可信度，拆細會不會比較好」——會。整筆一個分數會被一個不確定的欄位拖低，
 * 而且代理看不出是哪一欄沒被證明。拆開之後 Jev 輸出免費、成本不變。
 */
const CORE_FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  candidacy: ["name", "election_id", "election_type", "region", "candidate_status"],
  politician: ["name"],
  policy: ["title"],
  policy_progress: ["policy_title", "status"],
  correction: ["*changes"], // 特殊記號：所有攤平出來的「<欄位>＝新值」都是核心
};

const FIELD_INSTRUCTIONS =
  "claim 是一筆要寫進台灣政治資料庫的宣稱，page 是提交者附的來源網頁文字。這一題只問 claim 裡的一個欄位：這段文字有沒有證明它？" +
  "判準：來源必須證明「這個人說過或做過這件事」，不是只證明「這件事存在」。同義寫法算一致：政黨簡稱（國民黨＝中國國民黨、民進黨＝民主進步黨、民眾黨＝台灣民眾黨、無黨籍＝無黨籍及未經政黨推薦）、" +
  "「完成登記／登記參選」＝candidate_status registered、「2026 九合一／年底選舉」＝election_id 2026、縣市議員＝市議員／縣議員、「現任某市議員」可推得 region 與職位。" +
  "文字寫的跟這個欄位對得上選 confirmed；文字明確寫了不一樣的值、或講的是別人／前任選 contradicted；文字沒提到這個欄位選 absent。";

/** 一份 state、每個 claim 欄位一題。題名 field:<欄位> */
export function buildSourceSupportAsk(claim: Record<string, unknown>, url: string, pageText: string): {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
} {
  const questions: Record<string, JevQuestion> = {};
  for (const [k, v] of Object.entries(claim)) {
    const shown = typeof v === "string" ? v : JSON.stringify(v);
    questions[`field:${k}`] = {
      type: "choice",
      instructions: `${FIELD_INSTRUCTIONS} 這一題的欄位：${k}＝${shown}`,
      criteria: { confirmed: `文字證明 ${k} 就是 ${shown}（含同義寫法）`, contradicted: `文字寫了不同的值、或這件事是別人的`, absent: `文字沒提到這個欄位` },
    };
  }
  return { state: { claim, page: { url, text: pageText } }, questions };
}

export interface FieldResult { verdict: FieldVerdict; p: number }

/**
 * 把每欄的答案收斂成一票。規則（跟 SQL 的門檻一起看）：
 *   任一欄 contradicted 且機率 ≥ 門檻 → not_supported，probability = 那欄的機率
 *   核心欄位全部 confirmed → supported，probability = 核心欄位裡最低的 confirmed 機率（最弱的一欄決定信心）
 *   其他 → cannot_tell，probability = 0（棄權；細節留在 fields 給人看）
 * 非核心欄位 absent 不影響；非核心欄位 contradicted 一樣算反對——來源寫了不同的政黨就是有問題。
 */
export function aggregateFieldVerdicts(
  contributionType: string,
  claim: Record<string, unknown>,
  answers: Record<string, JevAnswer>,
  minProbability = MIN_PROBABILITY,
): { choice: SourceSupport; probability: number; fields: Record<string, FieldResult> } {
  const fields: Record<string, FieldResult> = {};
  for (const k of Object.keys(claim)) {
    const a = answers[`field:${k}`];
    if (!a) continue;
    fields[k] = { verdict: a.choice as FieldVerdict, p: Math.round((a.probabilities?.[a.choice] ?? 0) * 10000) / 10000 };
  }
  const contradicted = Object.values(fields).filter((f) => f.verdict === "contradicted" && f.p >= minProbability);
  if (contradicted.length > 0) {
    return { choice: "not_supported", probability: Math.max(...contradicted.map((f) => f.p)), fields };
  }
  const coreSpec = CORE_FIELDS_BY_TYPE[contributionType] ?? ["name"];
  const core = coreSpec.includes("*changes")
    ? Object.keys(fields).filter((k) => k !== "subject_name")
    : coreSpec.filter((k) => k in fields);
  if (core.length > 0 && core.every((k) => fields[k].verdict === "confirmed")) {
    return { choice: "supported", probability: Math.min(...core.map((k) => fields[k].p)), fields };
  }
  return { choice: "cannot_tell", probability: 0, fields };
}

/** PDF 抽字：unpdf 是給 serverless／edge 用的 pdf.js 包裝，不需要 canvas。動態載入，HTML 路徑不付這個成本 */
async function pdfText(buf: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("https://esm.sh/unpdf@0.12.1");
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  return typeof text === "string" ? text : (text as string[]).join("\n");
}

const FETCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

/**
 * 抓來源。回 { kind: "html", text } 或 { kind: "pdf" | "error", text: "" }。
 * PDF 這一版不抽字（沒有輕量的 Deno 方案）；回 pdf 讓呼叫端記成 cannot_tell 棄權，不要假裝看過。
 * 帶瀏覽器 UA：skill.md 實測多數媒體的 403 是擋沒有 UA 的程式。
 */
export async function fetchSource(url: string, fetchImpl: typeof fetch = fetch): Promise<{ kind: "html" | "pdf" | "error"; text: string; note: string }> {
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": FETCH_UA, "Accept-Language": "zh-TW,zh;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok) return { kind: "error", text: "", note: `http ${res.status}` };
    if (ct.includes("pdf") || url.toLowerCase().endsWith(".pdf")) {
      // 中選會的公告多半是 PDF（回測 90 筆有 15 筆），不抽字等於參選紀錄的來源票一半棄權
      try {
        const buf = new Uint8Array(await res.arrayBuffer());
        const text = await pdfText(buf);
        if (text.trim().length < 50) return { kind: "pdf", text: "", note: "pdf 抽不到文字（掃描檔？）" };
        return { kind: "html", text: text.replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n").trim(), note: "pdf" };
      } catch (e) {
        return { kind: "pdf", text: "", note: `pdf 抽字失敗：${e instanceof Error ? e.message : String(e)}`.slice(0, 120) };
      }
    }
    const raw = await res.text();
    return { kind: "html", text: htmlToText(raw.slice(0, 1_500_000)), note: ct };
  } catch (e) {
    return { kind: "error", text: "", note: e instanceof Error ? e.name : String(e) };
  }
}
