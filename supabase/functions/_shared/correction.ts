/**
 * correction 的 payload 正規化：舊格式 {field, current_value, correct_value} 與新格式 {changes: [{field, current_value, correct_value}]} 都收，
 * 內部一律用 changes 陣列。schema 驗證、門檻、落庫、摘要、派工現況都從這裡拿，避免各處自己解析。
 */

type Obj = Record<string, unknown>;

export interface CorrectionChange { field: string; current_value?: unknown; correct_value: unknown }
export interface NormalizedCorrection { target_table: string | null; target_id: string | null; changes: CorrectionChange[]; reason: string | null }

export const MAX_CORRECTION_CHANGES = 10;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function normalizeCorrection(payload: unknown): NormalizedCorrection {
  const p = (payload && typeof payload === "object" ? payload : {}) as Obj;
  let changes: CorrectionChange[] = [];
  if (Array.isArray(p.changes)) {
    changes = p.changes
      .filter((c): c is Obj => !!c && typeof c === "object")
      .map((c) => ({ field: typeof c.field === "string" ? c.field : "", current_value: c.current_value, correct_value: c.correct_value }));
  } else if (typeof p.field === "string") {
    changes = [{ field: p.field, current_value: p.current_value, correct_value: p.correct_value }];
  }
  return { target_table: str(p.target_table), target_id: str(p.target_id), changes, reason: str(p.reason) };
}

/** 有沒有動到高風險欄位（加減參選人） */
export function correctionTouches(payload: unknown, field: string): boolean {
  return normalizeCorrection(payload).changes.some((c) => c.field === field);
}

/**
 * 這筆 correction 動 candidate_status，而且動的**全部**是「傳聞參選／可能參選」（rumored／likely）？
 * 2026-09-20 審查建議 12：把傳聞改成 registered 是補強、改成 not_running 抹掉的是一則傳聞，不是一筆已登記的參選——
 * 不該走加減參選人的 4／6／8 票（63 筆 candidate_status_stale 清不完）。真正要 4／6／8 的是 registered／confirmed → not_running。
 * current_value 是代理自報的，但驗證項把 db_current 並排顯示，謊報會被看見。
 */
export function correctionOnlyFromRumor(payload: unknown): boolean {
  const changes = normalizeCorrection(payload).changes.filter((c) => c.field === "candidate_status");
  if (changes.length === 0) return false;
  return changes.every((c) => c.current_value === "rumored" || c.current_value === "likely");
}
