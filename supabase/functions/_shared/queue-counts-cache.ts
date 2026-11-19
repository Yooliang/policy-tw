/**
 * /next 回應裡 open_tasks 用的佇列計數快取（2026-11-19）。
 *
 * contribution_queue_task_counts 要讀整個佇列，實測每次 1.0～1.5 秒；#988 之後 /next 每分鐘約 10 次，
 * 而這個數字一分鐘內不會有意義地變動，所以在 Deno isolate 的記憶體裡按 region（null 當 'ALL'）快取 60 秒。
 * 快取行為（TTL、過期重打、失敗沿用舊值、並發共用）在 ttl-cache.ts。
 */
import { type CachedResult, createTtlCache } from "./ttl-cache.ts";

export const QUEUE_COUNTS_TTL_MS = 60_000;

export type CountsResult = CachedResult;

const cache = createTtlCache(QUEUE_COUNTS_TTL_MS, "queue counts");

export function queueCountsKey(region: string | null | undefined): string {
  return region ? region : "ALL";
}

/** 只給測試用：清掉所有快取 */
export function resetQueueCountsCache(): void {
  cache.reset();
}

export function cachedQueueCounts(
  region: string | null | undefined,
  fetcher: () => PromiseLike<CountsResult>,
  now: number = Date.now(),
): Promise<CountsResult> {
  return cache.get(queueCountsKey(region), fetcher, now);
}
