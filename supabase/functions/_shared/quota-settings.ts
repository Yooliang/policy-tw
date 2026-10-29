/**
 * 額度的四個數字從資料表 quota_settings 讀（2026-10-29，#769；migration 20261029080000）。
 *
 * - 正見讀 public.quota_settings（site='tw'）、日本站讀 policy_jp.quota_settings（site='jp'）：兩邊都用各自 client 的預設 schema，
 *   日本站端點不碰 public（維護者 2026-10-29 裁示）。
 * - 模組級快取 60 秒（每個 site 一份）；查不到、表不存在、查詢丟錯、值不合法（非整數或超出 CHECK 上下限）的欄位，
 *   一律退回呼叫端給的常數（CONTRIBUTE_DAILY_LIMIT_PER_IP 等），行為與沒有這張表時一樣。
 * - 退回的結果也快取 60 秒，避免表壞掉時每個請求都去敲資料庫。
 */

export interface QuotaLimits {
  per_ip_submit: number;
  per_ip_verify: number;
  per_ditrust_submit: number;
  per_ditrust_verify: number;
}

/** 與 migration 的 CHECK 上下限相同（測試比對） */
export const QUOTA_BOUNDS: Record<keyof QuotaLimits, readonly [number, number]> = {
  per_ip_submit: [10, 2000],
  per_ip_verify: [10, 5000],
  per_ditrust_submit: [10, 5000],
  per_ditrust_verify: [10, 10000],
};

export const QUOTA_CACHE_MS = 60_000;

export type QuotaSite = "tw" | "jp";

const KEYS = Object.keys(QUOTA_BOUNDS) as Array<keyof QuotaLimits>;
const cache = new Map<QuotaSite, { at: number; limits: QuotaLimits }>();

/** 測試用：清掉快取 */
export function resetQuotaCache(): void {
  cache.clear();
}

export function isValidQuotaValue(key: keyof QuotaLimits, v: unknown): v is number {
  const [lo, hi] = QUOTA_BOUNDS[key];
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

/**
 * 目前生效的額度。defaults 是呼叫端的常數（站別各自的）。now 給測試用的假時鐘（毫秒）。
 * 永遠不丟錯。
 */
export async function loadQuotaLimits(supabase: SupabaseLike, site: QuotaSite, defaults: QuotaLimits, now: number = Date.now()): Promise<QuotaLimits> {
  const hit = cache.get(site);
  if (hit && now - hit.at < QUOTA_CACHE_MS && now >= hit.at) return hit.limits;
  let row: Record<string, unknown> | null = null;
  try {
    const { data, error } = await supabase.from("quota_settings").select("per_ip_submit,per_ip_verify,per_ditrust_submit,per_ditrust_verify").eq("site", site).limit(1);
    if (!error && Array.isArray(data) && data.length > 0 && data[0] && typeof data[0] === "object") row = data[0] as Record<string, unknown>;
  } catch { /* 表不存在、網路錯、假 client 不支援：退回常數 */ }
  const limits = { ...defaults };
  if (row) for (const k of KEYS) if (isValidQuotaValue(k, row[k])) limits[k] = row[k] as number;
  cache.set(site, { at: now, limits });
  return limits;
}

/** 名冊批次上限：min(常數上限, 目前生效的網段提交額度)；不低於一般批次上限 maxBatch（額度比 maxBatch 還小時，名冊批次就不放寬） */
export function effectiveRosterBatchCap(constCap: number, perIpSubmit: number, maxBatch: number): number {
  return Math.max(maxBatch, Math.min(constCap, perIpSubmit));
}
