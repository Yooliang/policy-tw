/**
 * /next 回應裡 open_tasks 用的佇列計數快取（2026-11-19）。
 *
 * contribution_queue_task_counts 要讀整個佇列，實測每次 1.0～1.5 秒；#988 之後 /next 每分鐘約 10 次，
 * 而這個數字一分鐘內不會有意義地變動，所以在 Deno isolate 的記憶體裡按 region（null 當 'ALL'）快取 60 秒。
 *
 * - TTL 內同一個 region 只打一次資料庫；不同 region 各自一份。
 * - 過期後重打；重打失敗（回 error 或丟例外）時若有舊值就沿用舊值並 console.warn，沒有舊值才把錯誤原樣回給呼叫端。
 * - 同一個 region 同時有多個請求遇到過期時共用同一個進行中的查詢，不一起打。
 * - 回傳形狀與 supabase.rpc 相同（{ data, error }），呼叫端不用改。
 */

export const QUEUE_COUNTS_TTL_MS = 60_000;

export interface CountsResult {
  data: unknown;
  error: { message: string } | null;
}

interface Entry {
  at: number;
  data: unknown;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<CountsResult>>();

export function queueCountsKey(region: string | null | undefined): string {
  return region ? region : "ALL";
}

/** 只給測試用：清掉所有快取 */
export function resetQueueCountsCache(): void {
  entries.clear();
  inflight.clear();
}

export function cachedQueueCounts(
  region: string | null | undefined,
  fetcher: () => PromiseLike<CountsResult>,
  now: number = Date.now(),
): Promise<CountsResult> {
  const key = queueCountsKey(region);
  const hit = entries.get(key);
  if (hit && now - hit.at < QUEUE_COUNTS_TTL_MS) {
    return Promise.resolve({ data: hit.data, error: null });
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async (): Promise<CountsResult> => {
    let res: CountsResult;
    try {
      res = await fetcher();
    } catch (e) {
      res = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
    if (!res.error) {
      entries.set(key, { at: now, data: res.data });
      return res;
    }
    if (hit) {
      console.warn(`queue counts refresh failed (${key}), using stale value:`, res.error.message);
      return { data: hit.data, error: null };
    }
    return res;
  })().finally(() => { inflight.delete(key); });
  inflight.set(key, run);
  return run;
}
