/**
 * 網站「問一句話」（citizen_questions）建立流程。純函式部分可測；碰 DB 的邏輯留在 ask/index.ts。
 * 判斷順序跟 request-task.ts 的 decideRequest 同一套精神：先擋額度，再擋內容品質，最後才建立。
 */

import { isDuplicateQuestion, isLowEffortQuestion } from "./question-guard.ts";

/** 同一個來源 IP 每日最多幾題；比 request-task 的 10 次低，因為每題會直接開一筆派工任務 */
export const ASK_DAILY_LIMIT_PER_IP = 5;
/** 跟 migration 20260912000014 的 citizen_questions.question CHECK (BETWEEN 8 AND 300) 一致 */
export const QUESTION_MIN_LEN = 8;
export const QUESTION_MAX_LEN = 300;
/** 任務標題只取問題前幾字；完整問題放 description，給代理看到全文 */
export const ASK_TITLE_PREVIEW_CHARS = 40;

export function isValidQuestionLength(v: unknown): v is string {
  return typeof v === "string" && v.trim().length >= QUESTION_MIN_LEN && v.trim().length <= QUESTION_MAX_LEN;
}

/** 任務標題：問題前 ASK_TITLE_PREVIEW_CHARS 字，超過加刪節號 */
export function buildAskTaskTitle(question: string): string {
  const trimmed = question.trim();
  const preview = trimmed.slice(0, ASK_TITLE_PREVIEW_CHARS);
  return `回答民眾提問：${preview}${trimmed.length > ASK_TITLE_PREVIEW_CHARS ? "…" : ""}`;
}

export interface AskDecisionInput {
  usedToday: number;
  question: string;
  /** 同一個 IP 近 24 小時內問過的原文（呼叫端先用時間篩過） */
  recentQuestions: readonly string[];
}

export type AskDecision =
  | { action: "rate_limited" }
  | { action: "rejected"; reason: "low_effort" | "duplicate" }
  | { action: "create" };

/** 純函式：限額 → 內容品質（無意義字串／灌水詞堆疊）→ 24 小時內重複提問 → 建立 */
export function decideAsk(input: AskDecisionInput): AskDecision {
  if (input.usedToday >= ASK_DAILY_LIMIT_PER_IP) return { action: "rate_limited" };
  if (isLowEffortQuestion(input.question)) return { action: "rejected", reason: "low_effort" };
  if (isDuplicateQuestion(input.question, input.recentQuestions)) return { action: "rejected", reason: "duplicate" };
  return { action: "create" };
}

/**
 * 從政見頁／人物頁的按鈕過來的提問，答案其實是一筆資料變更，不是一段文字。
 *
 * 2026-09-13 小良哥指出：「這不是政見？」那個按鈕問的是「該被移除、改分類，還是
 * 其實有效」——三個答案都是資料變更，但它建的是 question 任務，代理只會回一段文字
 * 貼在提問下面，那筆假政見不會被移除。他要的是「型別保留」：走同一個提問流程
 * （所以保有表態與公開的答案），但任務型別要能讓代理產出資料變更。
 *
 * kind 由前端按鈕帶上來；沒帶或帶了不認識的值就是一般提問。
 * 每一種都要求對應的目標存在，否則退回一般提問（不要產生一個查無對象的任務）。
 */
export const ASK_KINDS = {
  /** 政見頁「這不是政見？」：查證後移除／改分類／確認有效 */
  policy_validity: { task_type: "policy_validity", needs: "policy" },
  /** 政見頁「查進度」「查兌現情形」 */
  policy_progress: { task_type: "progress_stale", needs: "policy" },
  /** 人物頁「查政見」 */
  policy_missing: { task_type: "policy_missing", needs: "politician" },
  /** 人物頁「查簡介」 */
  profile_gap: { task_type: "profile_gap", needs: "politician" },
} as const;

export type AskKind = keyof typeof ASK_KINDS;

export function isAskKind(v: unknown): v is AskKind {
  return typeof v === "string" && Object.hasOwn(ASK_KINDS, v);
}

/** 決定這筆提問要建哪一種任務。條件不符就退回一般提問。 */
export function askTaskType(kind: unknown, policyId: string | null, politicianId: string | null): string {
  if (!isAskKind(kind)) return "question";
  const spec = ASK_KINDS[kind];
  if (spec.needs === "policy" && !policyId) return "question";
  if (spec.needs === "politician" && !politicianId && !policyId) return "question";
  return spec.task_type;
}
