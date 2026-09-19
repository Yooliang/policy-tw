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
