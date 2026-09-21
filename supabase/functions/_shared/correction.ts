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

/**
 * 空操作的更正：改完之後值跟現在一樣。
 *
 * 兩隻跑任務的代理各自獨立回報同一件事（2026-09-21）：
 * - 「`db_current` 已經是 2024、`correct_value` 也是 2024——這筆改完等於沒改」
 * - 「我用 REST 重讀發現 election_id 本來就已經是 2024，提交者卻寫 claimed_current=null」
 *
 * 這種提交照樣佔一個驗證名額、要好幾票、通過還會寫一筆 edit_history。
 * 而驗證票是這個系統最稀缺的資源——實查全站 1,400+ 筆待驗證。
 *
 * 成因多半是資料新鮮度：提交者看到的是舊的，別人已經修好了。
 * 所以擋在提交端、而且訊息要講清楚「資料已經是對的」，不是罵它。
 */
export interface NoOpCheck {
  /** 每一欄都跟現值相同＝整筆是空操作 */
  allNoOp: boolean;
  /** 逐欄：現值、提交者主張的正確值、是不是一樣 */
  fields: Array<{ field: string; db_current: unknown; correct_value: unknown; same: boolean }>;
}

/** 值相不相同：數字與字串的 2024／"2024" 算同一個，空字串與 null 也算同一個。 */
/**
 * 落庫前把更正拆成「真的會改的欄位」與「改完跟現值一樣的欄位」（#3／#6，2026-09-22）。
 * 提交當下的 no_op_correction 只擋得住提交那一刻；等票期間別人先修好了，落庫時再比一次，
 * 全部一樣就標 superseded（同一宣稱已由別筆上線），不寫假的 edit_history（實例 6d3fafc8：not_running → not_running 落成 applied）。
 */
export function splitNoOpChanges(patch: Record<string, unknown>, current: Record<string, unknown>): { changed: Record<string, unknown>; noop: string[] } {
  const changed: Record<string, unknown> = {};
  const noop: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (sameValue(current[field], value)) noop.push(field);
    else changed[field] = value;
  }
  return { changed, noop };
}

export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v).trim());
  return norm(a) === norm(b);
}

export function checkNoOp(payload: unknown, dbRow: Record<string, unknown> | null): NoOpCheck {
  const { changes } = normalizeCorrection(payload);
  if (!dbRow || changes.length === 0) return { allNoOp: false, fields: [] };
  const fields = changes.map((c) => ({
    field: c.field,
    db_current: dbRow[c.field],
    correct_value: c.correct_value,
    same: sameValue(dbRow[c.field], c.correct_value),
  }));
  return { allNoOp: fields.length > 0 && fields.every((f) => f.same), fields };
}
