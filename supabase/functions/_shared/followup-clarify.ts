/**
 * Jev 釐清模糊的「跟進」任務（2026-11-08，維護者核准）。
 *
 * 背景：system-one?action=followups 把驗證者備註／提交說明裡的範圍外線索開成 task_type=other 的任務，
 * 標題只有「核對這筆資料的參選紀錄（驗證者備註提到）」，target 只有 {followup_kind, followup_of_vote}：
 * 代理領到不知道是誰、要交什麼。2026-11-08 開著 2,000 多張，約 45% 最後真的有資料變動，也有大批是同一筆貢獻的重複。
 *
 * 做法（藍圖 §2-2：一個主體一次呼叫、同主體多題一起問）：每張任務一次呼叫問三題——
 *   clarify_kind（問題類型）、clarify_deliverable（要交什麼型別）、clarify_resolved（是否已被後續資料解決）。
 * state 放備註原文、底下那筆貢獻、這個人在資料庫現在的樣子、任務建立之後這個人又上線了哪些貢獻（藍圖 §2-1、§2-3）。
 *
 * 套用結果（只動 contribution_tasks，永遠不碰資料表）：
 *   - 已解決或其實沒問題，機率 ≥0.95 → 關掉，理由寫進 target.closed_reason 與說明
 *   - 問題類型有把握（≥0.85，跟開任務同一條線）→ 標題／說明改寫成具體指令，補 target.politician_id／politician_election_id
 *   - 其餘 → 不改字，只蓋「問過了」的章（target.clarify），不重問
 *   - 釐清之後做重複檢查（followup_duplicate_plan，SQL）：同人物＋同動作已有結構化任務／自動缺口／名冊分組任務／待驗貢獻就關掉
 * Jev 是選擇題模型、不產生文字：任務文字由這裡的樣板組出來，名字與數字都來自資料庫，不是模型寫的。
 */
import { toRecords, type DecisionRecord, type JevQuestion, type JevResponse } from "./system-one.ts";
import { submissionText, type SubmissionForFollowup } from "./vote-followup.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;
type Obj = Record<string, unknown>;

/** 關任務的機率線（藍圖 §2-1：0.95）；改寫的線與開任務同一條（FOLLOWUP_MIN_PROBABILITY） */
export const CLARIFY_CLOSE_PROBABILITY = 0.95;
export const CLARIFY_REWRITE_PROBABILITY = 0.85;
/** 每輪最多處理幾張（一張一次 Jev，約 $0.0002） */
export const CLARIFY_DEFAULT_LIMIT = 30;
export const CLARIFY_MAX_LIMIT = 100;

export const CLARIFY_QUESTION_NAMES = ["clarify_kind", "clarify_deliverable", "clarify_resolved"] as const;

export const CLARIFY_KINDS = {
  candidacy: "參選紀錄有誤或缺漏（參選狀態、號次、選區、有沒有登記、有沒有退選）",
  identity: "身分錯掛：姓名、出生年等基本資料錯，或資料掛在同名的另一個人名下",
  party: "政黨填錯或對不上來源",
  duplicate: "同一個人被建成兩筆（重複人物）",
  bio_gap: "簡介缺漏：學歷、經歷、出生年等欄位沒填",
  policy_content: "政見的標題、描述、數字、日期或進度有問題",
  election: "某筆資料標的選舉別（屆別、年份、選舉類型）錯了",
  no_issue: "仔細看 note 與目前資料，其實沒有需要處理的問題（note 只是在解釋本次驗證，或指出的事資料庫早已正確）",
  unclear: "資訊不足：從現有事實看不出要查什麼",
} as const;
export type ClarifyKind = keyof typeof CLARIFY_KINDS;

export const CLARIFY_DELIVERABLES = {
  correction: "改既有資料的某個欄位（交 correction）",
  reassign_candidacy: "把某筆參選紀錄改掛到另一個人（交 reassign_candidacy）",
  merge_politician: "兩個人物判為同一人併起來，或判為不同人（交 merge_politician）",
  candidacy: "新增或補齊一筆參選紀錄（交 candidacy）",
  politician: "新增人物或補人物基本資料（交 politician）",
  no_change: "要先查證，查過若沒問題就回報無異動（交 no_change）",
  none: "不需要任何交件",
} as const;
export type ClarifyDeliverable = keyof typeof CLARIFY_DELIVERABLES;

/** 每種問題類型能搭的交件型別：Jev 答了不搭的（例如「重複人物」配 candidacy）就當交件型別沒答出來，只用通用句型 */
export const ALLOWED_DELIVERABLES: Readonly<Record<ClarifyKind, readonly ClarifyDeliverable[]>> = {
  candidacy: ["candidacy", "correction", "reassign_candidacy", "no_change"],
  identity: ["reassign_candidacy", "correction", "merge_politician", "politician", "no_change"],
  party: ["correction", "politician", "no_change"],
  duplicate: ["merge_politician", "no_change"],
  bio_gap: ["politician", "correction"],
  policy_content: ["correction", "no_change"],
  election: ["correction", "no_change"],
  no_issue: [],
  unclear: [],
};

/**
 * 重複判斷用的「動作」。兩件事動作相同＝代理做出來的東西一樣：
 * 同一人補基本資料、同一人改欄位、同一筆參選紀錄補／改、改掛、合併。no_change／none 沒有動作（不比重複）。
 */
export type ClarifyAction = "add_profile" | "correct_politician" | "correct_candidacy" | "candidacy" | "reassign" | "merge" | "correct_policy";

export function actionOf(kind: ClarifyKind, deliverable: ClarifyDeliverable | null): ClarifyAction | null {
  if (!deliverable || deliverable === "none" || deliverable === "no_change") return null;
  switch (deliverable) {
    case "reassign_candidacy": return "reassign";
    case "merge_politician": return "merge";
    case "candidacy": return "candidacy";
    case "politician": return "add_profile";
    case "correction":
      if (kind === "candidacy") return "correct_candidacy";
      if (kind === "policy_content" || kind === "election") return "correct_policy";
      return "correct_politician";
  }
  return null;
}

export function clarifyQuestions(): Record<string, JevQuestion> {
  return {
    clarify_kind: {
      type: "choice",
      instructions:
        "note 是一位驗證者或提交者寫下的線索，underlying 是他當時處理的那筆貢獻，person 與 candidacies 是這個人現在在資料庫裡的樣子（不是 note 當時看到的）。" +
        "判斷 note 指出的問題屬於哪一類。拿 person／candidacies 對照 note：note 說的缺漏或錯誤，資料庫現在已經是對的，就選 no_issue；" +
        "note 只是在解釋本次驗證的理由、沒有指出別的待辦，也選 no_issue。實在看不出要查什麼選 unclear，不要猜。",
      criteria: { ...CLARIFY_KINDS },
    },
    clarify_deliverable: {
      type: "choice",
      instructions: "若 note 指出的問題屬實，代理最後要交哪一種貢獻才能修好它？只看修正動作本身，不看要不要先查證。完全沒有要做的事選 none。",
      criteria: { ...CLARIFY_DELIVERABLES },
    },
    clarify_resolved: {
      type: "choice",
      instructions:
        "later_contributions 是這張任務建立之後、同一個人上線的貢獻。note 指出的問題，是否已經被其中一筆（或 person／candidacies 現在的內容）解決了？" +
        "有明確對應的一筆才選 yes；沒有對應或只是同一個人別的欄位被改，選 no；資料不夠判斷選 unsure。",
      criteria: {
        yes: "已經被後續資料或目前的資料庫內容解決",
        no: "還沒有解決",
        unsure: "看不出來",
      },
    },
  };
}

// ---- 任務在講誰 ----

export interface ClarifySubject {
  politician_id: string | null;
  /** 第二位（duplicate_politician 的配對） */
  other_politician_id: string | null;
  pe_id: number | null;
  /** 沒有人物、只有一個單位（auto:candidacy_source_missing:cand_no:2026:村里長:台南市:官田區） */
  unit: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const posInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^[1-9]\d{0,9}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** 自動缺口的 arm 名稱 → id 第三段是人物 uuid */
const PERSON_ARMS = new Set(["profile_gap", "policy_missing", "term_policy_missing", "duplicate_policy"]);

/** 從缺口 id（貢獻的 task_id）看出是誰或哪個單位。看不出就全 null */
export function subjectFromGapId(taskId: string | null | undefined): ClarifySubject {
  const out: ClarifySubject = { politician_id: null, other_politician_id: null, pe_id: null, unit: null };
  const id = str(taskId);
  if (!id) return out;
  if (UUID_RE.test(id)) return out; // 手動任務 uuid：由 target 另外查
  if (!id.startsWith("auto:")) return out;
  const parts = id.split(":");
  const arm = parts[1];
  if (PERSON_ARMS.has(arm) && isUuid(parts[2])) out.politician_id = parts[2];
  else if (arm === "profile_detail_gap" && isUuid(parts[3])) out.politician_id = parts[3];
  else if (arm === "duplicate_politician" && parts[2]) {
    const [a, b] = parts[2].split("|");
    if (isUuid(a)) out.politician_id = a;
    if (isUuid(b)) out.other_politician_id = b;
  } else if (arm === "candidacy_owner_mismatch") out.pe_id = posInt(parts[2]);
  else if (arm === "candidacy_source_missing") {
    const peText = parts[2] === "party" ? parts[3] : parts[2];
    if (posInt(peText)) out.pe_id = posInt(peText);
    else if (parts[2] === "cand_no" || parts[2] === "cand_no_recheck") out.unit = parts.slice(3).join("").length > 0 ? parts.slice(3).join(" ") : null;
  } else if (arm === "roster_check") out.unit = parts.slice(2).join(" ");
  return out;
}

export interface ClarifyContribution {
  id: string;
  contribution_type: string;
  status?: string | null;
  payload: Obj | null;
  task_id?: string | null;
  note?: string | null;
  agent_name?: string | null;
  created_at?: string | null;
  applied_politician_id?: string | null;
}

/** 底下那筆貢獻在講誰：貢獻自己標的 > payload 裡的 id > 缺口 id */
export function subjectOfContribution(c: ClarifyContribution): ClarifySubject {
  const p = (c.payload ?? {}) as Obj;
  const fromGap = subjectFromGapId(c.task_id ?? str(p.task_id));
  const out: ClarifySubject = { ...fromGap };
  const pid = [c.applied_politician_id, p.politician_id, p.from_politician_id, p.target_table === "politicians" ? p.target_id : null, p.keep_id].find(isUuid);
  if (pid) out.politician_id = pid;
  if (isUuid(p.remove_id) && out.politician_id && p.remove_id !== out.politician_id) out.other_politician_id = p.remove_id;
  const pe = posInt(p.politician_election_id) ?? (p.target_table === "politician_elections" ? posInt(p.target_id) : null);
  if (pe) out.pe_id = pe;
  return out;
}

// ---- 資料庫現況 → state ----

export interface PersonFacts {
  id: string;
  name: string;
  birth_year: number | null;
  party: string | null;
  region: string | null;
  sub_region: string | null;
  village: string | null;
  current_position: string | null;
  merged_into: string | null;
}
export interface CandidacyFacts {
  id: number;
  election_id: number;
  election_type: string | null;
  position: string | null;
  cand_no: number | null;
  candidacy_status: string | null;
  withdrawn_after_filing: boolean | null;
}
export interface LaterContribution { type: string; status: string; created_at: string; fields: Obj }

export interface ClarifyInput {
  note: string;
  contribution: ClarifyContribution | null;
  subject: ClarifySubject;
  person: PersonFacts | null;
  other_person: PersonFacts | null;
  candidacies: CandidacyFacts[];
  later: LaterContribution[];
}

const PAYLOAD_KEYS = ["name", "politician_name", "subject_name", "title", "election_id", "election_type", "party", "region", "sub_region", "candidate_status", "cand_no", "target_table", "target_id", "field", "correct_value", "outcome", "status", "keep_id", "remove_id", "same_person", "to_politician_id", "from_politician_id", "politician_election_id"];
export function payloadDigest(p: Obj | null | undefined): Obj {
  const src = p ?? {};
  const out: Obj = {};
  for (const k of PAYLOAD_KEYS) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== "") out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  if (Array.isArray(src.changes)) out.changes = (src.changes as Obj[]).slice(0, 5).map((c) => ({ field: c.field, correct_value: typeof c.correct_value === "string" ? String(c.correct_value).slice(0, 100) : c.correct_value }));
  return out;
}

export function buildClarifyAsk(input: ClarifyInput): { state: Record<string, unknown>; questions: Record<string, JevQuestion> } {
  const state: Record<string, unknown> = { note: input.note.slice(0, 1500) };
  if (input.contribution) {
    state.underlying = { type: input.contribution.contribution_type, status: input.contribution.status ?? null, fields: payloadDigest(input.contribution.payload) };
  }
  if (input.person) state.person = input.person;
  if (input.other_person) state.other_person = input.other_person;
  if (input.candidacies.length > 0) state.candidacies = input.candidacies.slice(0, 12);
  if (input.subject.unit) state.place = input.subject.unit;
  state.later_contributions = input.later.slice(0, 8);
  return { state, questions: clarifyQuestions() };
}

// ---- 判定 → 動作 ----

export interface ClarifyAnswers {
  kind: ClarifyKind;
  kind_p: number;
  deliverable: ClarifyDeliverable;
  deliverable_p: number;
  resolved: "yes" | "no" | "unsure";
  resolved_p: number;
}

type RawAnswer = { choice?: string; probabilities?: Record<string, number> } | undefined;
const pOf = (a: RawAnswer): number => (a?.choice ? a.probabilities?.[a.choice] ?? 0 : 0);

export function parseAnswers(answers: Record<string, RawAnswer>): ClarifyAnswers {
  const k = answers.clarify_kind, d = answers.clarify_deliverable, r = answers.clarify_resolved;
  return {
    kind: (k?.choice && k.choice in CLARIFY_KINDS ? k.choice : "unclear") as ClarifyKind,
    kind_p: pOf(k),
    deliverable: (d?.choice && d.choice in CLARIFY_DELIVERABLES ? d.choice : "none") as ClarifyDeliverable,
    deliverable_p: pOf(d),
    resolved: (r?.choice === "yes" || r?.choice === "no" ? r.choice : "unsure"),
    resolved_p: pOf(r),
  };
}

export type ClarifyDecision =
  | { action: "close"; reason: "resolved" | "not_an_issue"; probability: number }
  | { action: "rewrite"; kind: ClarifyKind; deliverable: ClarifyDeliverable | null; act: ClarifyAction | null }
  | { action: "keep"; reason: "unclear" | "low_confidence" };

export function decide(a: ClarifyAnswers): ClarifyDecision {
  if (a.resolved === "yes" && a.resolved_p >= CLARIFY_CLOSE_PROBABILITY) return { action: "close", reason: "resolved", probability: a.resolved_p };
  if (a.kind === "no_issue" && a.kind_p >= CLARIFY_CLOSE_PROBABILITY) return { action: "close", reason: "not_an_issue", probability: a.kind_p };
  if (a.kind === "unclear" || a.kind === "no_issue") return { action: "keep", reason: "unclear" };
  if (a.kind_p < CLARIFY_REWRITE_PROBABILITY) return { action: "keep", reason: "low_confidence" };
  const okDel = a.deliverable_p >= CLARIFY_REWRITE_PROBABILITY && ALLOWED_DELIVERABLES[a.kind].includes(a.deliverable);
  const deliverable = okDel ? a.deliverable : null;
  return { action: "rewrite", kind: a.kind, deliverable, act: actionOf(a.kind, deliverable) };
}

// ---- 改寫（樣板，名字與數字來自資料庫） ----

const KIND_LABEL: Record<ClarifyKind, string> = {
  candidacy: "參選紀錄", identity: "身分（姓名、出生年或是否掛錯人）", party: "政黨", duplicate: "重複人物", bio_gap: "簡介缺漏",
  policy_content: "政見內容", election: "選舉別", no_issue: "（無問題）", unclear: "（待查）",
};
const VERB: Record<ClarifyAction, string> = {
  reassign: "核對參選紀錄是否掛錯人，查實交 reassign_candidacy 改掛",
  merge: "核對是否為重複人物，查實交 merge_politician",
  candidacy: "補／更正參選紀錄，交 candidacy",
  correct_candidacy: "更正參選紀錄欄位（參選狀態、號次、選區），交 correction",
  correct_politician: "更正人物資料，交 correction",
  add_profile: "補人物基本資料（出生年、學歷、經歷），交 politician",
  correct_policy: "更正政見或選舉別，交 correction",
};
const HOWTO: Record<ClarifyAction, string> = {
  reassign: "打開官方名冊，用出生年、推薦政黨、選舉區分辨這筆參選紀錄屬於哪一位；確定掛錯就交 reassign_candidacy（evidence 寫分辨依據）。",
  merge: "比對兩位的出生年、政黨、縣市與其他屆紀錄；確定同一人交 merge_politician（same_person=true），確定不同人也交一筆（same_person=false）並寫依據。",
  candidacy: "到中選會或選委會公告核對該場選舉有沒有這個人；有就交 candidacy（election_id、選舉類型、縣市、選區、號次照來源）。",
  correct_candidacy: "到中選會或選委會公告核對該筆參選紀錄的欄位；錯了就交 correction（target_table=politician_elections，target_id 用上面的參選紀錄 id）。",
  correct_politician: "查官方來源核對該欄位；錯了就交 correction（target_table=politicians，target_id 用上面的人物 id）。",
  add_profile: "查官方簡介或中選會資料補齊欄位，交 politician（帶 politician_id）。",
  correct_policy: "打開政見原始來源核對；錯了就交 correction（target_table=policies）。",
};

export interface SubjectNames { who: string; place: string | null }

export function describePerson(p: PersonFacts | null): string {
  if (!p) return "";
  const bits = [p.name, p.birth_year ? `${p.birth_year} 年生` : null, p.party, [p.region, p.sub_region, p.village].filter(Boolean).join("")].filter(Boolean);
  return bits.join("，");
}

function candidacyLine(c: CandidacyFacts): string {
  return `參選紀錄 ${c.id}：${c.election_id} ${c.election_type ?? ""}${c.cand_no ? ` ${c.cand_no} 號` : ""}（${c.candidacy_status ?? "狀態未填"}）`;
}

export interface RewriteInput {
  decision: Extract<ClarifyDecision, { action: "rewrite" }>;
  input: ClarifyInput;
  quote: string;
  fallbackName: string | null;
}

export function rewriteText(r: RewriteInput): { title: string; description: string } {
  const { decision, input } = r;
  const who = input.person?.name ?? r.fallbackName ?? input.subject.unit ?? "（人物待確認）";
  const area = input.person ? [input.person.region, input.person.sub_region, input.person.village].filter(Boolean).join("") : "";
  const placeBit = area ? `（${area}）` : !input.person && input.subject.unit && who !== input.subject.unit ? `（${input.subject.unit}）` : "";
  const pairBit = input.other_person ? `與${input.other_person.name}` : "";
  // 同一個動作在不同問題類型下講的欄位不同：標題把欄位點出來，代理一看就知道要查哪一欄
  const FIELD: Partial<Record<ClarifyKind, string>> = { party: "政黨", identity: "姓名、出生年等基本資料", election: "屆別", policy_content: "政見內容", bio_gap: "簡介缺漏的欄位" };
  const verb = decision.act === "correct_politician" || decision.act === "correct_policy" || decision.act === "add_profile"
    ? `${VERB[decision.act].replace(/，交 /, `（${FIELD[decision.kind] ?? KIND_LABEL[decision.kind]}），交 `)}`
    : decision.act
    ? VERB[decision.act]
    : decision.deliverable === "no_change"
      ? `查證${KIND_LABEL[decision.kind]}，沒問題就交 no_change`
      : `核對${KIND_LABEL[decision.kind]}（交件型別查證後決定）`;
  const title = `${who}${pairBit}${placeBit}：${verb}`.slice(0, 120);
  const facts: string[] = [];
  if (input.person) facts.push(`目前資料：${describePerson(input.person)}（人物 id ${input.person.id}）`);
  if (input.other_person) facts.push(`另一位：${describePerson(input.other_person)}（人物 id ${input.other_person.id}）`);
  if (input.candidacies.length > 0) facts.push(input.candidacies.slice(0, 6).map(candidacyLine).join("；"));
  if (input.subject.unit) facts.push(`單位：${input.subject.unit}`);
  const description = [
    `【釐清後的任務】問題類型：${KIND_LABEL[decision.kind]}。${decision.act ? HOWTO[decision.act] : "請先自己打開來源查證，依結果選擇交件型別；查過沒問題就用 no_change 回報你查了什麼。"}`,
    ...facts,
    `原始線索：「${r.quote.slice(0, 900)}」`,
    "這個任務是系統從備註／說明撿出來的線索，經 Jev 釐清成上述指令；線索不是結論，請以來源為準。",
  ].join("\n").slice(0, 1990);
  return { title, description };
}

/** 要補進 target 的欄位：只在原本沒有時才補，並蓋釐清的章 */
export function targetPatch(
  existing: Obj, subject: ClarifySubject, input: ClarifyInput, decision: ClarifyDecision | { action: "keep" }, a: ClarifyAnswers, model: string, now: string,
): Obj {
  const patch: Obj = {};
  const pid = subject.politician_id;
  if (pid && !existing.politician_id) patch.politician_id = pid;
  // 參選紀錄：有明確指向才補；只有一筆 2026 參選紀錄、而任務是參選類動作時，補那一筆
  let pe = subject.pe_id;
  if (!pe && decision.action === "rewrite" && decision.act && ["candidacy", "correct_candidacy", "reassign"].includes(decision.act)) {
    const cur = input.candidacies.filter((c) => c.election_id === 2026);
    if (cur.length === 1) pe = cur[0].id;
  }
  if (pe && !existing.politician_election_id) patch.politician_election_id = pe;
  patch.clarify = {
    at: now, model, kind: a.kind, kind_p: round(a.kind_p), deliverable: a.deliverable, deliverable_p: round(a.deliverable_p),
    resolved: a.resolved, resolved_p: round(a.resolved_p), status: decision.action === "rewrite" ? "rewritten" : decision.action === "close" ? "closed" : "kept",
    ...(decision.action === "rewrite" && decision.act ? { action: decision.act } : {}),
  };
  return patch;
}
const round = (n: number) => Math.round(n * 100) / 100;

export const CLOSE_REASON_TEXT: Record<string, string> = {
  resolved: "Jev 判定這條線索已被後續資料解決",
  not_an_issue: "Jev 判定這條線索其實沒有需要處理的問題",
  exact_duplicate: "同一筆貢獻、同一類問題的重複任務，保留最早的一張",
  duplicate: "同一人物、同一動作已有其他任務或待驗貢獻在處理",
};

// ---- 讀資料 ----

export function quoteOf(description: string | null | undefined): string {
  const d = description ?? "";
  const i = d.indexOf("「"), j = d.lastIndexOf("」");
  return i >= 0 && j > i ? d.slice(i + 1, j) : d.slice(0, 1400);
}

export interface FollowupTaskRow { id: string; title: string; description: string | null; target: Obj; created_at: string }

export interface LoadedTask { task: FollowupTaskRow; input: ClarifyInput; subjectType: "vote" | "contribution"; subjectId: string }

const PERSON_COLS = "id, name, birth_year, party, region, sub_region, village, current_position, merged_into";

/** 一張任務 → Jev 要看的全部事實。底下的貢獻找不到就回 null（不問） */
export async function loadClarifyInput(supabase: Sb, task: FollowupTaskRow): Promise<LoadedTask | null> {
  const tg = task.target ?? {};
  const voteId = str(tg.followup_of_vote);
  let cid = str(tg.followup_of_contribution);
  if (voteId) {
    const { data: v, error } = await supabase.from("contribution_votes").select("contribution_id").eq("id", voteId).maybeSingle();
    if (error) throw new Error(`clarify vote: ${error.message}`);
    cid = (v as { contribution_id?: string } | null)?.contribution_id ?? cid;
  }
  if (!cid) return null;
  const { data: c, error: cErr } = await supabase.from("contributions")
    .select("id, contribution_type, status, payload, task_id, note, agent_name, created_at, applied_politician_id").eq("id", cid).maybeSingle();
  if (cErr) throw new Error(`clarify contribution: ${cErr.message}`);
  if (!c) return null;
  const contribution = c as ClarifyContribution;
  const subject = subjectOfContribution(contribution);
  if (isUuid(tg.politician_id)) subject.politician_id = tg.politician_id as string;

  // 只有參選紀錄 id 沒有人：查那筆紀錄掛在誰身上
  if (subject.pe_id && !subject.politician_id) {
    const { data: pe } = await supabase.from("politician_elections").select("politician_id").eq("id", subject.pe_id).maybeSingle();
    const pid = (pe as { politician_id?: string } | null)?.politician_id;
    if (isUuid(pid)) subject.politician_id = pid;
  }
  let person: PersonFacts | null = null, other: PersonFacts | null = null;
  let candidacies: CandidacyFacts[] = [], later: LaterContribution[] = [];
  if (subject.politician_id) {
    const [pRes, eRes, lRes] = await Promise.all([
      supabase.from("politicians").select(PERSON_COLS).eq("id", subject.politician_id).maybeSingle(),
      // query-bounds: ok — 一個人的參選紀錄，最多十幾筆
      supabase.from("politician_elections").select("id, election_id, election_type, position, cand_no, candidacy_status, withdrawn_after_filing").eq("politician_id", subject.politician_id).order("election_id", { ascending: false }).limit(20),
      // query-bounds: ok — 單一人物、任務建立之後，limit 10
      supabase.from("contributions").select("contribution_type, status, created_at, payload").eq("applied_politician_id", subject.politician_id).gt("created_at", task.created_at).neq("id", cid).order("created_at", { ascending: false }).limit(10),
    ]);
    person = (pRes.data as PersonFacts | null) ?? null;
    candidacies = ((eRes.data ?? []) as CandidacyFacts[]);
    later = ((lRes.data ?? []) as Array<{ contribution_type: string; status: string; created_at: string; payload: Obj }>)
      .map((x) => ({ type: x.contribution_type, status: x.status, created_at: x.created_at, fields: payloadDigest(x.payload) }));
  }
  if (subject.other_politician_id) {
    const { data } = await supabase.from("politicians").select(PERSON_COLS).eq("id", subject.other_politician_id).maybeSingle();
    other = (data as PersonFacts | null) ?? null;
  }
  const note = quoteOf(task.description) || submissionText(contribution as SubmissionForFollowup);
  return {
    task,
    input: { note, contribution, subject, person, other_person: other, candidacies, later },
    subjectType: voteId ? "vote" : "contribution",
    subjectId: voteId ?? cid,
  };
}

// ---- 一張任務走完整個流程 ----

export interface ClarifyDeps {
  ask(state: Record<string, unknown>, questions: Record<string, JevQuestion>): Promise<JevResponse>;
  /** 寫 jev_decisions（只新增，同 state 同模型擋重骰） */
  record(rows: DecisionRecord[]): Promise<unknown>;
  now(): string;
}

export interface ClarifyOutcome {
  task_id: string;
  status: "closed" | "rewritten" | "kept" | "skipped";
  reason?: string;
  kind?: ClarifyKind;
  action?: ClarifyAction | null;
  deliverable?: ClarifyDeliverable | null;
  title?: string;
  probabilities?: { kind: number; deliverable: number; resolved: number };
  cost_usd?: number;
}

/**
 * 問 Jev 一次、套用結果。dry=true 只回結果，不寫 jev_decisions、不動任務。
 * Jev 或資料庫出錯會丟出去（呼叫端不蓋章，下一輪重試）；底下的貢獻找不到的蓋 skipped 章，不重問。
 */
export async function clarifyOne(supabase: Sb, deps: ClarifyDeps, task: FollowupTaskRow, dry: boolean): Promise<ClarifyOutcome> {
  const loaded = await loadClarifyInput(supabase, task);
  if (!loaded) {
    if (!dry) await stamp(supabase, task.id, { clarify: { at: deps.now(), status: "skipped", reason: "no_contribution" } });
    return { task_id: task.id, status: "skipped", reason: "no_contribution" };
  }
  const { state, questions } = buildClarifyAsk(loaded.input);
  const res = await deps.ask(state, questions);
  if (!dry) await deps.record(toRecords(loaded.subjectType, loaded.subjectId, state, res));
  const answers = parseAnswers(res.answers);
  const decision = decide(answers);
  const base = {
    task_id: task.id, kind: answers.kind, deliverable: answers.deliverable,
    probabilities: { kind: round(answers.kind_p), deliverable: round(answers.deliverable_p), resolved: round(answers.resolved_p) },
    cost_usd: Number(res.usage.cost.toFixed(8)),
  };
  const patch = targetPatch(task.target ?? {}, loaded.input.subject, loaded.input, decision, answers, res.model, deps.now());
  if (decision.action === "close") {
    const text = CLOSE_REASON_TEXT[decision.reason === "resolved" ? "resolved" : "not_an_issue"];
    if (!dry) await rpcOk(supabase, "followup_close", { p_task: task.id, p_reason: { code: decision.reason, text, probability: round(decision.probability), clarify: patch.clarify } });
    return { ...base, status: "closed", reason: decision.reason };
  }
  if (decision.action === "keep") {
    if (!dry) await rpcOk(supabase, "followup_rewrite", { p_task: task.id, p_title: null, p_description: null, p_patch: patch });
    return { ...base, status: "kept", reason: decision.reason };
  }
  const text = rewriteText({ decision, input: loaded.input, quote: loaded.input.note, fallbackName: nameFromContribution(loaded.input.contribution) });
  if (!dry) await rpcOk(supabase, "followup_rewrite", { p_task: task.id, p_title: text.title, p_description: text.description, p_patch: patch });
  return { ...base, status: "rewritten", action: decision.act, title: text.title };
}

function nameFromContribution(c: ClarifyContribution | null): string | null {
  const p = (c?.payload ?? {}) as Obj;
  return str(p.name) ?? str(p.politician_name) ?? str(p.subject_name);
}

async function stamp(supabase: Sb, taskId: string, patch: Obj) {
  await rpcOk(supabase, "followup_rewrite", { p_task: taskId, p_title: null, p_description: null, p_patch: patch });
}

async function rpcOk(supabase: Sb, fn: string, args: Obj) {
  const { error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
}

/** 重複：回關掉的張數。計畫來自 SQL（followup_exact_duplicates／followup_duplicate_plan），這裡只負責逐張關 */
export async function closeDuplicates(supabase: Sb, dry: boolean): Promise<{ exact: number; vs_existing: number; samples: Obj[] }> {
  const ex = await supabase.rpc("followup_exact_duplicates");
  if (ex.error) throw new Error(`followup_exact_duplicates: ${ex.error.message}`);
  const exact = (ex.data ?? []) as Array<{ task_id: string; keep_id: string }>;
  let plan: Array<{ task_id: string; keep_ref: string }> = [];
  const pl = await supabase.rpc("followup_duplicate_plan");
  if (pl.error) console.error("followup_duplicate_plan:", pl.error.message); // 計畫讀不到就只做精確重複，不擋釐清
  else plan = (pl.data ?? []) as typeof plan;
  const samples: Obj[] = [...exact.slice(0, 3).map((d) => ({ task_id: d.task_id, keep: `jev-followup:${d.keep_id}`, kind: "exact" })), ...plan.slice(0, 5).map((d) => ({ task_id: d.task_id, keep: d.keep_ref, kind: "vs_existing" }))];
  if (!dry) {
    for (const d of exact) await rpcOk(supabase, "followup_close", { p_task: d.task_id, p_reason: { code: "exact_duplicate", text: `${CLOSE_REASON_TEXT.exact_duplicate}（保留 ${d.keep_id}）`, keep: `jev-followup:${d.keep_id}` } });
    const done = new Set(exact.map((d) => d.task_id));
    for (const d of plan) {
      if (done.has(d.task_id)) continue;
      await rpcOk(supabase, "followup_close", { p_task: d.task_id, p_reason: { code: "duplicate", text: `${CLOSE_REASON_TEXT.duplicate}（${d.keep_ref}）`, keep: d.keep_ref } });
    }
  }
  return { exact: exact.length, vs_existing: plan.filter((d) => !exact.some((e) => e.task_id === d.task_id)).length, samples };
}
