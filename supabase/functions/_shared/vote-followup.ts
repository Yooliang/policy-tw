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

/** 開任務的機率門檻：跟 Jev 其他會產生動作的判定同一個水準 */
export const FOLLOWUP_MIN_PROBABILITY = 0.9;
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
