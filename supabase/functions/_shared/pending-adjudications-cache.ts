/**
 * /next 排除「已有人交裁決、在等票」用的未定案裁決清單快取（2026-11-19）。
 *
 * 每次 /next 都用 fetchAllRows 翻完全站 pending／verified 的 adjudication；資料全站共用、短時間內變動小，
 * 所以在 Deno isolate 的記憶體裡快取 60 秒（單一鍵，沒有 region 之分）。
 * 用途見 dispatch.ts 的 filterAdjudicateTasks：只影響 adjudicate 任務會不會派出。
 * 最壞情況：剛交出的裁決 60 秒內，另一隻代理還可能被派到同一筆爭議的裁決任務、多做一次。
 * 重打失敗有舊值就沿用（console.warn），沒有舊值就丟出例外，走 /next 原本的錯誤路徑。
 */
import { createTtlCache } from "./ttl-cache.ts";

export const PENDING_ADJUDICATIONS_TTL_MS = 60_000;

export type AdjudicationRow = { payload: Record<string, unknown> };

const cache = createTtlCache(PENDING_ADJUDICATIONS_TTL_MS, "pending adjudications");
const KEY = "ALL";

/** 只給測試用：清掉快取 */
export function resetPendingAdjudicationsCache(): void {
  cache.reset();
}

export async function cachedPendingAdjudications(
  fetcher: () => Promise<AdjudicationRow[]>,
  now: number = Date.now(),
): Promise<AdjudicationRow[]> {
  const res = await cache.get(KEY, async () => {
    try {
      return { data: await fetcher(), error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }, now);
  if (res.error) throw new Error(res.error.message);
  return res.data as AdjudicationRow[];
}
