/**
 * 網站「問一句話」（citizen_questions）建立流程。純函式部分可測；碰 DB 的邏輯留在 ask/index.ts。
 * 判斷順序跟 request-task.ts 的 decideRequest 同一套精神：先擋額度，再擋內容品質，最後才建立。
 */

import { isDuplicateQuestion, isLowEffortQuestion } from "./question-guard.ts";

/**
 * 每個來源 IP 每日最多提幾題。
 *
 * 2026-09-14 從 5 調到 20，當時政見頁與人物頁的按鈕也走這個端點。
 * 2026-09-15 按鈕已搬回 request-task，這裡只剩民眾自己打字的提問；數字先不動，
 * 重複問題另有 24 小時的相似度檢查擋著。
 */
export const ASK_DAILY_LIMIT_PER_IP = 20;
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
