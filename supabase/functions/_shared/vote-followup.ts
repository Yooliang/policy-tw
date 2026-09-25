/**
 * Jev 讀投票備註，找「範圍外的問題」開成任務（小良哥 2026-09-23）。
 *
 * 協議 §2 第 10a 條叫驗證者把範圍外的缺陷另提 task_suggestion，但實際上多半只寫在 note 裡——
 * 7 天 5,056 張票裡約 65 張寫了「欄位外／留給之後處理」，沒有一張有下游接手。
 * 實例：陳泓維的政見驗證票寫「原文是親民黨提名，DB 是無黨籍，留給之後的 correction」，沒人處理。
 *
 * Jev 是選擇題模型、不產生文字，所以它只判「有沒有、是哪個欄位」；任務內容直接引用驗證者原話。
 * 開出來的任務照樣要代理查證、交件、投票——Jev 只負責把被埋在備註裡的線索撿起來。
 */
import type { JevQuestion } from "./system-one.ts";
import type { TaskInput } from "./task-admin.ts";

/** Jev 的選項：none＝沒有範圍外問題；其餘是問題落在哪個欄位 */
export const FOLLOWUP_CHOICES = {
  none: "備註只談這次被驗證的東西本身（同意或反對它的理由），沒有指出別的欄位或別筆資料有問題",
  party: "指出這個人的政黨在資料庫裡可能填錯（例如來源寫某黨提名、資料庫是無黨籍）",
  identity: "指出姓名、出生年、性別、縣市、現職等人物基本資料可能有錯，或疑似跟另一位同名者混在一起",
  election: "指出某條政見或參選紀錄的屆別（選舉年份）可能標錯",
  candidacy: "指出參選狀態、選區、號次、當選與否等參選紀錄的其他欄位可能有錯",
  policy_content: "指出另一條政見的標題、描述、數字、來源網址、提出日期或進度有問題（不是這次被驗證的那條）",
  duplicate: "指出資料庫裡有重複的人物或重複的政見",
  not_policy: "指出某條已上線的政見其實不是政見（標語、個人表態、別人的政績）",
} as const;
export type FollowupChoice = keyof typeof FOLLOWUP_CHOICES;

/**
 * 開任務的機率門檻。原本 0.9（跟 Jev 其他會產生動作的判定同一個水準）；2026-09-25 小良哥改 0.85：
 * Jev 判「該開」時多半沒把握（86 張只有 11 張到 0.9），0.85–0.9 那 3 張都是具體可查的事（同名不同人兩張、缺屆一張）。
 */
export const FOLLOWUP_MIN_PROBABILITY = 0.85;
/** 太短的備註不問：講不出範圍外的事 */
export const FOLLOWUP_MIN_NOTE = 30;

export interface FollowupVote {
  id: string;
  verdict: string;
  note: string | null;
  agent_name: string | null;
  created_at: string;
}
export interface FollowupContribution {
  id: string;
  contribution_type: string;
  payload: Record<string, unknown>;
  applied_politician_id?: string | null;
  applied_policy_id?: string | null;
}

export function worthAsking(v: FollowupVote): boolean {
  return typeof v.note === "string" && v.note.trim().length >= FOLLOWUP_MIN_NOTE;
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 這張票驗的是什麼（給 Jev 分辨「範圍內」與「範圍外」） */
export function scopeOf(c: FollowupContribution): Record<string, unknown> {
  const p = c.payload ?? {};
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => p[k] !== undefined && p[k] !== null).map((k) => [k, typeof p[k] === "string" ? String(p[k]).slice(0, 200) : p[k]]));
  return {
    contribution_type: c.contribution_type,
    fields: pick(["name", "politician_name", "title", "election_id", "party", "region", "candidate_status", "target_table", "field", "correct_value", "status"]),
  };
}

export function buildFollowupAsk(v: FollowupVote, c: FollowupContribution): { state: Record<string, unknown>; questions: Record<string, JevQuestion> } {
  return {
    state: {
      being_verified: scopeOf(c),
      vote: { verdict: v.verdict, note: String(v.note ?? "").slice(0, 1500) },
    },
    questions: {
      followup: {
        type: "choice",
        instructions:
          "vote.note 是一位驗證者對 being_verified 這筆資料投票時寫的理由。" +
          "判斷 note 有沒有**另外**指出一個不屬於這次驗證範圍的問題（別的欄位、別的人物、別條政見），而且這個問題值得有人去查。" +
          "note 只是在解釋為什麼同意或反對 being_verified 本身 → none。note 提到範圍外問題 → 選問題落在的那一類。",
        criteria: { ...FOLLOWUP_CHOICES },
      },
    },
  };
}

const LABEL: Record<Exclude<FollowupChoice, "none">, string> = {
  party: "政黨",
  identity: "人物基本資料",
  election: "屆別",
  candidacy: "參選紀錄",
  policy_content: "政見內容",
  duplicate: "重複資料",
  not_policy: "是不是政見",
};

/** Jev 判「有」→ 任務內容。標題與描述都引用驗證者原話，不讓 Jev 寫字 */
export function followupTask(v: FollowupVote, c: FollowupContribution, choice: Exclude<FollowupChoice, "none">, subjectName: string | null): TaskInput {
  const p = c.payload ?? {};
  const politicianId = s(c.applied_politician_id) ?? s(p.politician_id) ?? (p.target_table === "politicians" ? s(p.target_id) : null);
  const policyId = s(c.applied_policy_id) ?? s(p.policy_id) ?? (p.target_table === "policies" ? s(p.target_id) : null);
  const who = subjectName ?? s(p.name) ?? s(p.politician_name) ?? "這筆資料";
  const title = `核對${who}的${LABEL[choice]}（驗證者備註提到）`.slice(0, 120);
  const description = [
    `驗證者 ${v.agent_name ?? "（未具名）"} 在 ${v.created_at.slice(0, 10)} 驗證另一筆資料（${c.contribution_type}，${c.id}）時順手寫下：`,
    `「${String(v.note ?? "").trim().slice(0, 1400)}」`,
    "這是系統從備註裡撿出來的線索，不是結論。請自己打開來源查證：真的有錯就用 correction／removal 等對應型別提交；查過發現沒問題就用 no_change 回報你查了什麼。",
  ].join("\n");
  return {
    title,
    description,
    task_type: "other",
    target_politician_id: politicianId && policyId ? null : politicianId,
    target_policy_id: policyId,
    ...(policyId && politicianId ? { target_extra: { politician_id: politicianId, followup_of_vote: v.id, followup_kind: choice } } : { target_extra: { followup_of_vote: v.id, followup_kind: choice } }),
  };
}

/**
 * 提交本身的說明（2026-09-26 小良哥：「這個當初不是有做嗎，補上吧」）。
 * 上面那套只讀投票備註；交件的 note、無異動的 finding、更正的 reason 裡也常順手寫到範圍外的事——
 * 7 天約 2,500 筆有文字的提交，粗篩就有 65 筆（例：游智彬那筆的來源其實說他已棄選桃園、轉戰台北）。
 * 不另外問 Jev：併進票數預算那一次呼叫（每筆待驗的提交本來就問一次），同一套選項與門檻。
 */
export interface SubmissionForFollowup extends FollowupContribution {
  note?: string | null;
  agent_name?: string | null;
  created_at?: string | null;
}

export function submissionText(c: SubmissionForFollowup): string {
  const p = c.payload ?? {};
  return [c.note, p.finding, p.reason, p.note].map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i).join("\n").slice(0, 1500);
}

export const worthAskingSubmission = (c: SubmissionForFollowup): boolean => submissionText(c).length >= FOLLOWUP_MIN_NOTE;

/** 放進票數預算那次呼叫的第 N 題；state 另外帶 submission_text */
export const SUBMISSION_FOLLOWUP_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "submission_text 是提交者交這筆資料（target）時自己寫的說明。" +
    "判斷它有沒有**另外**指出一個不屬於這筆提交本身的問題（別的欄位、別的人物、別條政見、別屆的紀錄），而且值得有人去查。" +
    "說明只是在解釋這筆提交本身（查了哪裡、為什麼這樣填）→ none。提到範圍外問題 → 選問題落在的那一類。",
  criteria: { ...FOLLOWUP_CHOICES },
};

export function submissionFollowupTask(c: SubmissionForFollowup, choice: Exclude<FollowupChoice, "none">, subjectName: string | null): TaskInput {
  const base = followupTask({ id: c.id, verdict: "", note: submissionText(c), agent_name: c.agent_name ?? null, created_at: c.created_at ?? new Date().toISOString() }, c, choice, subjectName);
  const who = subjectName ?? s(c.payload?.name) ?? s(c.payload?.politician_name) ?? "這筆資料";
  const { followup_of_vote: _drop, ...extra } = (base.target_extra ?? {}) as Record<string, unknown>;
  return {
    ...base,
    title: `核對${who}的${LABEL[choice]}（提交說明提到）`.slice(0, 120),
    description: [
      `提交者 ${c.agent_name ?? "（未具名）"} 交這筆資料（${c.contribution_type}，${c.id}）時在說明裡順手寫下：`,
      `「${submissionText(c).slice(0, 1400)}」`,
      "這是系統從說明裡撿出來的線索，不是結論。請自己打開來源查證：真的有錯就用 correction 等對應型別提交；查過發現沒問題就用 no_change 回報你查了什麼。",
    ].join("\n"),
    target_extra: { ...extra, followup_of_contribution: c.id, followup_kind: choice },
  };
}
