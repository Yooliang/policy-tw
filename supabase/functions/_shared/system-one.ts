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

export const SUBJECT_TYPES = ["policy", "identity_review", "politician_pair", "contribution", "politician_election"] as const;
export const QUESTIONS = ["is_policy", "duplicate_of", "election", "identity", "same_person", "source_support", "second_source", "extract", "vote_budget"] as const;
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
  /** judge 動作的呼叫端來源 IP 雜湊（配額用）；系統自己的判定不帶 */
  requester_ip_hash?: string | null;
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
  "「完成登記／登記參選」＝candidate_status registered、「2026 九合一／年底選舉／民國 115 年／115 年地方公職人員選舉」＝election_id 2026、" +
  "election_type 縣市議員＝直轄市議員／縣（市）議員／市議員／縣議員，縣市長＝直轄市長／縣（市）長，鄉鎮市長＝鄉（鎮、市）長；「臺」＝「台」（臺南市＝台南市）；" +
  "中選會「候選人登記情形一覽表／登記名冊」裡列出「某選舉區 某人」，就證明那個人在該縣市那場選舉 candidate_status registered，選舉區前綴的縣市就是 region。" +
  "文字寫的跟這個欄位對得上選 confirmed；文字明確寫了不一樣的值、或講的是別人／前任選 contradicted；文字沒提到這個欄位選 absent。";

/** 一份 state、每個 claim 欄位一題。題名 field:<欄位> */
/**
 * 多個來源各取一段（名字附近優先），拼成一份 page.text，每段前面標來源網域。
 * 2026-09-19：很多參選紀錄的第一個來源是中選會的「附件索引頁」（只有 PDF 連結清單，681 字），
 * 名單在 PDF 或第二、三個來源裡；只看第一個來源等於什麼都沒看到。含有人名的來源排前面。
 */
/**
 * 這一頁的文字算不算「有正文」：200 字以上，或雖短但點到了主角的名字。
 * 200 字門檻是擋空殼頁（JS 渲染、cookie 牆）；連江縣選委會的縣市長登記彙總表抽出來只有 171 字、
 * 兩個人名都在裡面，被門檻擋掉就等於那一縣永遠棄權（2026-09-19 線上實測）。
 */
export function hasUsableText(text: string, names: (string | null | undefined)[]): boolean {
  if (text.length >= 200) return true;
  if (text.trim().length < 20) return false;
  return names.some((n) => !!n && n.length >= 2 && text.includes(n));
}

/** 名字比對前的正規化：全形／半形間隔號一律拿掉（卡伊．馬賴＝卡伊‧馬賴＝卡伊·馬賴）、臺→台、去空白 */
export function normalizeName(s: string): string {
  return s.replace(/[．·‧・•\.]/g, "").replace(/臺/g, "台").replace(/\s+/g, "");
}
/**
 * 文本裡有沒有主角。2026-09-19：卡伊．馬賴的系統票在一段沒有她那一列的文字上判「region 矛盾」（PDF 沒接進來），
 * 一張錯的 not_supported 把 4 張人票推進裁決——主角不在文本裡，Jev 只能說看不到，不能說矛盾。
 */
export function nameHit(text: string, names: Array<string | null | undefined>): boolean {
  const t = normalizeName(text);
  return names.some((n) => !!n && normalizeName(n).length >= 2 && t.includes(normalizeName(n)));
}

export function combineSources(
  pages: Array<{ url: string; text: string }>,
  names: Array<string | null | undefined>,
  perSource = 2200,
  total = PAGE_TEXT_MAX,
): string {
  const scored = pages
    .filter((p) => p.text && p.text.trim())
    .map((p) => ({ ...p, hit: nameHit(p.text, names) }))
    .sort((a, b) => Number(b.hit) - Number(a.hit));
  const parts: string[] = [];
  let used = 0;
  for (const p of scored) {
    let host = p.url;
    try { host = new URL(p.url).hostname; } catch { /* 原樣 */ }
    const piece = `【來源 ${host}】\n${focusText(p.text, names, perSource)}`;
    if (used + piece.length > total && parts.length > 0) break;
    parts.push(piece); used += piece.length;
  }
  return parts.join("\n\n").slice(0, total);
}

// ---- 同名配對：兩筆人物資料是不是同一個人（影子期已判 164 對；現在接回流程當 merge_politician 的系統票）----
export interface PairSide { id: string; name: string; party?: string | null; region?: string | null; birth_year?: number | null; current_position?: string | null; elections?: string[] }

export function buildPairAsk(a: PairSide, b: PairSide): { state: Record<string, unknown>; questions: Record<string, JevQuestion> } {
  const state = { a: { ...a }, b: { ...b } };
  const questions: Record<string, JevQuestion> = {
    same_person: {
      type: "choice",
      instructions: "a 與 b 是資料庫裡兩筆同名的政治人物。判斷是不是同一個人：政黨同義寫法算相同（國民黨＝中國國民黨、無黨籍＝無黨籍及未經政黨推薦、無＝無黨籍）；同縣市不同屆別（例如 2022 選鄉鎮市長、2026 登記縣市長）常是同一人往上選；出生年不同、或同一屆同一種選舉在不同縣市，就是不同人。資料不夠就選 unclear，不要猜。",
      criteria: { same: "同一個人（縣市或選區對得上、出生年不衝突、經歷連得起來）", diff: "不同的人（出生年不同、同一屆分別在兩個縣市參選、或政黨與經歷明顯是兩個人）", unclear: "資料太少看不出來" },
    },
  };
  return { state, questions };
}

// ---- extract：代理找到「第一來源」後，讓 Jev 從頁面裡選值 ----
//
// 使用者 2026-09-19：「它應該是收到任務之後，分析關鍵字自己找來源，不一定要去看既有的那個」。
// Jev 是選擇題模型，不會生成文字，所以只有「值在有限集合裡」的任務能這樣填：
//   election_result_missing → election_result ∈ elected／not_elected
//   candidate_status_stale  → candidate_status ∈ registered／not_running
// 政見標題、簡介這種自由文字還是得靠會抽字的模型；Jev 只能當上傳前的自檢（judge）。

export const EXTRACT_TASK_TYPES = ["election_result_missing", "candidate_status_stale"] as const;
export type ExtractTaskType = (typeof EXTRACT_TASK_TYPES)[number];

export interface ExtractSubject {
  name: string;
  party?: string | null;
  region?: string | null;
  election_id: number;
  election_type?: string | null;
}

/** auto:<task_type>:<politician_elections.id> → 型別與紀錄 id；不是這兩種任務就 null */
export function parseExtractTask(taskId: string): { task_type: ExtractTaskType; pe_id: number } | null {
  const m = /^auto:(election_result_missing|candidate_status_stale):(\d+)$/.exec(taskId.trim());
  if (!m) return null;
  return { task_type: m[1] as ExtractTaskType, pe_id: Number(m[2]) };
}

const EXTRACT_QUESTIONS: Record<ExtractTaskType, { field: string; instructions: string; criteria: Record<string, string> }> = {
  election_result_missing: {
    field: "election_result",
    instructions: "subject 是一個人的一場選舉，page 是代理找到的網頁文字。這一題問：這段文字有沒有講他「這一場」選舉的結果？只看 subject 那一屆、那一種選舉；別的屆別、別的職位、初選都不算。",
    criteria: {
      elected: "文字說他當選、勝選、連任成功、或當選人名單裡有他",
      not_elected: "文字說他落選、未當選、敗選、或得票未達當選",
      absent: "文字沒講這一場選舉的結果、或講的是別場選舉",
    },
  },
  candidate_status_stale: {
    field: "candidate_status",
    instructions: "subject 是一個人的一場選舉，page 是代理找到的網頁文字（多半是登記名單或選委會公告）。這一題問：登記截止後，他到底有沒有登記參選這一場？",
    criteria: {
      registered: "文字證明他完成登記、或在該選區的登記名單／候選人名單上",
      not_running: "文字明確說他沒登記、退出、改選別的職位；或名單是完整的而裡面沒有他",
      absent: "文字看不出來：沒有名單、名單不完整、或講的是別場選舉",
    },
  },
};

export function buildExtractAsk(taskType: ExtractTaskType, subject: ExtractSubject, url: string, pageText: string): {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  field: string;
} {
  const q = EXTRACT_QUESTIONS[taskType];
  const who = `${subject.name}（${subject.region ?? ""} ${subject.election_id} ${subject.election_type ?? ""}${subject.party ? "，" + subject.party : ""}）`;
  const state = { subject: { ...subject }, page: { url, text: pageText } };
  const questions: Record<string, JevQuestion> = {
    // 先問是不是同一個人：同名不同縣市的人很多（金門也有一個曹爾章），值對了人錯了更糟
    same_person: {
      type: "choice",
      instructions: `page 裡講的是不是 subject 這個人？同名而且縣市或選區對得上才算。subject＝${who}。`,
      criteria: {
        same_person: "文字講的就是這個人（同名，縣市或選區對得上）",
        different_person: "同名但縣市／選舉對不上，或根本沒提到這個人",
        unclear: "有這個名字但看不出是不是同一個人",
      },
    },
    [q.field]: { type: "choice", instructions: `${q.instructions} subject＝${who}。`, criteria: q.criteria },
  };
  return { state, questions, field: q.field };
}

export interface ExtractVerdict {
  field: string;
  person: { choice: string; probability: number };
  /** Jev 選出來的值；absent 時為 null */
  value: string | null;
  /** 兩題取較弱的一題 */
  probability: number;
  /** 同一個人且值不是 absent，兩題都過門檻才算數 */
  counts: boolean;
}

export function aggregateExtract(
  taskType: ExtractTaskType,
  answers: Record<string, { choice: string; probabilities: Record<string, number> }>,
  minProbability = MIN_PROBABILITY,
): ExtractVerdict {
  const field = EXTRACT_QUESTIONS[taskType].field;
  const pick = (a?: { choice: string; probabilities: Record<string, number> }) =>
    a ? { choice: a.choice, probability: Number((a.probabilities?.[a.choice] ?? 0).toFixed(4)) } : { choice: "unclear", probability: 0 };
  const person = pick(answers.same_person);
  const picked = pick(answers[field]);
  const value = picked.choice === "absent" ? null : picked.choice;
  const probability = Math.min(person.probability, picked.probability);
  const counts = person.choice === "same_person" && value !== null && person.probability >= minProbability && picked.probability >= minProbability;
  return { field, person, value, probability, counts };
}

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
): { choice: SourceSupport; probability: number; fields: Record<string, FieldResult>; core_fields: string[]; contradicted_core: boolean } {
  const fields: Record<string, FieldResult> = {};
  for (const k of Object.keys(claim)) {
    const a = answers[`field:${k}`];
    if (!a) continue;
    fields[k] = { verdict: a.choice as FieldVerdict, p: Math.round((a.probabilities?.[a.choice] ?? 0) * 10000) / 10000 };
  }
  const coreSpec = CORE_FIELDS_BY_TYPE[contributionType] ?? ["name"];
  const core = coreSpec.includes("*changes")
    ? Object.keys(fields).filter((k) => k !== "subject_name")
    : coreSpec.filter((k) => k in fields);
  const contradicted = Object.values(fields).filter((f) => f.verdict === "contradicted" && f.p >= minProbability);
  // 哪一欄矛盾要讓代理知道：政黨簡稱、上一屆選區這種非核心欄對不上，不該變成帶反證的反對票（審查建議 8）
  const contradictedCore = core.some((k) => fields[k]?.verdict === "contradicted" && fields[k].p >= minProbability);
  if (contradicted.length > 0) {
    return { choice: "not_supported", probability: Math.max(...contradicted.map((f) => f.p)), fields, core_fields: core, contradicted_core: contradictedCore };
  }
  if (core.length > 0 && core.every((k) => fields[k].verdict === "confirmed")) {
    return { choice: "supported", probability: Math.min(...core.map((k) => fields[k].p)), fields, core_fields: core, contradicted_core: false };
  }
  return { choice: "cannot_tell", probability: 0, fields, core_fields: core, contradicted_core: false };
}

/**
 * 兩段正文像不像（審查建議 7）：中央社的稿會原文出現在 Yahoo、LINE TODAY、地方新聞網，網域不同、文字幾乎一樣。
 * 正規化後取 3-gram 算 Jaccard；只看開頭 2000 字（轉載通常整段照抄）。
 */
export function textSimilarity(a: string, b: string): number {
  const norm = (t: string) => t.replace(/\s+/g, "").replace(/[，。、：；！？「」『』（）()\[\]【】《》〈〉"'“”‘’—\-–·．]/g, "").slice(0, 2000);
  const grams = (t: string) => { const g = new Set<string>(); for (let i = 0; i + 3 <= t.length; i++) g.add(t.slice(i, i + 3)); return g; };
  const ga = grams(norm(a)), gb = grams(norm(b));
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0; for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}
export const SAME_CONTENT_THRESHOLD = 0.5;

const FETCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

/**
 * 抓來源。回 { kind: "html", text } 或 { kind: "pdf" | "error", text: "" }。
 * PDF／試算表不解析（使用者 2026-09-20 裁決：系統不該提供 PDF／Excel 解析能力）：回 pdf 讓呼叫端記成 cannot_tell 棄權，
 * 不假裝看過。參選紀錄的系統票改問中選會的結構化資料（cec-check.ts），不靠附件。
 * 帶瀏覽器 UA：skill.md 實測多數媒體的 403 是擋沒有 UA 的程式。
 */
export async function fetchSource(url: string, fetchImpl: typeof fetch = fetch): Promise<{ kind: "html" | "pdf" | "error"; text: string; note: string }> {
  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": FETCH_UA, "Accept-Language": "zh-TW,zh;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    // 2026-09-22 candlefish 第三次探測：活頁 404（udn 6316823 有 2022 快照）沒有回退、只回 fetch_failed。抓不到（4xx／5xx／逾時）也去找快照。
    if (!res.ok) return await archiveOrError(url, `http ${res.status}`, fetchImpl);
    if (ct.includes("pdf") || url.toLowerCase().endsWith(".pdf")) return { kind: "pdf", text: "", note: "pdf 不解析（系統只讀網頁；參選紀錄走中選會資料庫）" };
    if (ct.includes("ms-excel") || ct.includes("spreadsheetml") || /\.(xlsx?|ods)(\?|$)/i.test(url)) return { kind: "pdf", text: "", note: "試算表不解析（系統只讀網頁）" };
    const raw = await res.text();
    const text = htmlToText(raw.slice(0, 1_500_000));
    // 2026-09-21：媒體頁面從雲端 IP 抓回 200 但正文是空的（軟封鎖：body 空或只剩腳本），24 小時內 144 筆
    // 系統票因此棄權；同一支程式從住宅 IP 抓同一頁有 1,600～5,100 字。正文太短就改抓 archive.org 的快照
    // （直接打 /web/2026/<url>，不用 availability API——那支會 429；302 由 redirect: follow 跟過去）。
    // note 記三個長度：每一層都只回報自己看到的、沒有人回報自己沒看到什麼，這三個整數就是在補這件事。
    if (text.length >= ARCHIVE_FALLBACK_MIN_CHARS) return { kind: "html", text, note: `raw:${raw.length} | text:${text.length} | ${ct}` };
    const archived = await fetchArchive(url, fetchImpl);
    if (archived.text.length > text.length) {
      return { kind: "html", text: archived.text, note: `raw:${raw.length} | archive:${archived.raw} | text:${archived.text.length} | ${ct}` };
    }
    return { kind: "html", text, note: `raw:${raw.length} | archive:${archived.raw} | text:${text.length} | ${ct}` };
  } catch (e) {
    return await archiveOrError(url, e instanceof Error ? e.name : String(e), fetchImpl);
  }
}

/** 活頁抓不到（4xx／5xx／逾時）→ 找 archive.org 快照；快照有正文就當 html 用，沒有就照原因回 error（note 一樣留 archive 長度） */
async function archiveOrError(url: string, reason: string, fetchImpl: typeof fetch): Promise<{ kind: "html" | "error"; text: string; note: string }> {
  const archived = await fetchArchive(url, fetchImpl);
  if (archived.text.length >= ARCHIVE_FALLBACK_MIN_CHARS) {
    return { kind: "html", text: archived.text, note: `${reason} | archive:${archived.raw} | text:${archived.text.length}` };
  }
  return { kind: "error", text: "", note: `${reason} | archive:${archived.raw}` };
}

/** 正文短於這個就當「沒抓到」去找快照：一篇新聞正文再短也有幾百字，200 以下多半是空殼或挑戰頁 */
export const ARCHIVE_FALLBACK_MIN_CHARS = 200;

/** archive.org 最近的快照。抓不到就回空，不丟錯——呼叫端拿原本那份（可能也是空的）繼續走。 */
export async function fetchArchive(url: string, fetchImpl: typeof fetch = fetch): Promise<{ raw: number; text: string }> {
  try {
    const res = await fetchImpl(`https://web.archive.org/web/2026/${url}`, { headers: { "User-Agent": FETCH_UA }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { raw: 0, text: "" };
    const raw = await res.text();
    return { raw: raw.length, text: htmlToText(raw.slice(0, 1_500_000)) };
  } catch {
    return { raw: 0, text: "" };
  }
}

/**
 * 貢獻的主角要去哪張表查名字（2026-09-22，candlefish 第二次探測）。
 * judge／precheck 原本只在 correction 回查 target_table／target_id；candidacy／policy_progress 的 payload 只有
 * politician_id／policy_id、沒有 name，主角名單就是空的 → 每一頁都判「主角名字不在文本裡」棄權（bd1a0cd5 對
 * cw、archive、維基三頁全棄權，同一頁對有 name 的貢獻正常）。payload 已有名字就不查。
 */
export function subjectRef(payload: Record<string, unknown>): { table: "politicians" | "policies" | "politician_elections"; id: string } | null {
  const str = (k: string) => typeof payload[k] === "string" && (payload[k] as string).length > 0 ? payload[k] as string : null;
  if (str("name") || str("politician_name")) return null;
  const table = str("target_table"), tid = str("target_id");
  // politician_elections 的更正（屆別、參選狀態）主角是那筆參選紀錄的人（candlefish 第三次探測：游智彬 7fd8787f 回查不到）
  if (table && tid) return table === "politicians" || table === "policies" || table === "politician_elections" ? { table, id: tid } : null;
  const pol = str("politician_id");
  if (pol) return { table: "politicians", id: pol };
  const pid = str("policy_id");
  if (pid) return { table: "policies", id: pid };
  return null;
}

// deno-lint-ignore no-explicit-any
type SubjectDb = any;
/** 回查主角名字：人物 → 姓名；政見 → 標題＋提出者姓名（正文通常寫人名不寫政見標題） */
export async function subjectNamesOf(supabase: SubjectDb, payload: Record<string, unknown>): Promise<string[]> {
  const ref = subjectRef(payload);
  if (!ref) return [];
  const cols = ref.table === "policies" ? "title, politician_id" : ref.table === "politician_elections" ? "politician_id" : "name";
  const { data } = await supabase.from(ref.table).select(cols).eq("id", ref.id).maybeSingle();
  const row = (data ?? null) as Record<string, unknown> | null;
  if (!row) return [];
  const out: string[] = [];
  const own = ref.table === "politician_elections" ? null : row[ref.table === "policies" ? "title" : "name"];
  if (typeof own === "string" && own) out.push(own);
  if ((ref.table === "policies" || ref.table === "politician_elections") && typeof row.politician_id === "string") {
    const { data: p } = await supabase.from("politicians").select("name").eq("id", row.politician_id).maybeSingle();
    const name = (p as { name?: unknown } | null)?.name;
    if (typeof name === "string" && name) out.push(name);
  }
  return out;
}
