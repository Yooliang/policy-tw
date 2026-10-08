/**
 * 全国地方公共団体コード（6 碼）的檢查碼與日期範圍——SQL policy_jp.lg_code_valid／lg_pref_code 的 TS 版。
 *
 * 公式（總務省代碼表 1,965 筆全部吻合）：前 5 碼乘 6,5,4,3,2，總和除以 11 的餘數 r，檢查碼＝(11−r) mod 10。
 * 跟 SQL（20261009000000_policy_jp_tables.sql 的 lg_code_valid、20261009210000_policy_jp_apply.sql 的 lg_pref_code）是同一條公式；
 * 對齊測試（policy-jp-apply.test.ts）用 PGlite 對一批代碼逐一比對，改一邊會紅。
 */

const WEIGHTS = [6, 5, 4, 3, 2] as const;

/** 前 5 碼算出的檢查碼（0～9） */
function checkDigitOf(first5: string): number {
  let sum = 0;
  for (let i = 0; i < 5; i++) sum += Number(first5[i]) * WEIGHTS[i];
  return (11 - (sum % 11)) % 10;
}

/** 6 碼數字而且檢查碼對（跟 SQL 的 lg_code_valid 同義；不是字串或格式不對一律 false） */
export function lgCodeValid(code: unknown): code is string {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  return checkDigitOf(code.slice(0, 5)) === Number(code[5]);
}

/** 所屬都道府県的團體碼：前 2 碼＋000＋檢查碼（格式不對回 null；跟 SQL 的 lg_pref_code 同義） */
export function lgPrefCode(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  const head = `${code.slice(0, 2)}000`;
  return `${head}${checkDigitOf(head)}`;
}

/** 都道府県自己的團體碼（第 3～5 碼是 000） */
export const isPrefectureCode = (code: string): boolean => code.slice(2, 5) === "000";

/**
 * 日期的合理年份範圍：1947（日本國憲法・地方自治法施行）～2100。
 * 為什麼要擋：JS 的 Date 收 0000-01-01，PostgreSQL 的 DATE 不收 0000 年（也不該有 0001 年的選舉），資料庫會在落庫才炸。
 */
export const JP_DATE_MIN_YEAR = 1947;
export const JP_DATE_MAX_YEAR = 2100;

/** YYYY-MM-DD、真的有這一天（2027-02-30 不算）、年份在 1947～2100 */
export function isJpDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const year = Number(v.slice(0, 4));
  if (year < JP_DATE_MIN_YEAR || year > JP_DATE_MAX_YEAR) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
