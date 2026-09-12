/**
 * 讀者對提問表態（贊同／不贊同這題值得被回答）。純函式：合法值判斷與 DB 欄位映射，避免魔術數字散在端點裡。
 * question_stances.stance 在 DB 是 SMALLINT（1／-1，見 migration 20260912000014）。
 */

export const STANCES = ["up", "down"] as const;
export type Stance = (typeof STANCES)[number];

/** 同一個來源 IP 每日最多表態幾次 */
export const STANCE_DAILY_LIMIT_PER_IP = 20;

export function isStance(v: unknown): v is Stance {
  return typeof v === "string" && (STANCES as readonly string[]).includes(v);
}

export function stanceValue(stance: Stance): 1 | -1 {
  return stance === "up" ? 1 : -1;
}
