/**
 * 通用的模組層 TTL 快取（2026-11-19，從 queue-counts-cache.ts 泛化）。
 *
 * - TTL 內同一個鍵只打一次資料來源；不同鍵各自一份。
 * - 過期後重打；重打失敗（回 error 或丟例外）時若有舊值就沿用舊值並 console.warn，沒有舊值才把錯誤原樣回給呼叫端。
 * - 同一個鍵同時有多個請求遇到過期時共用同一個進行中的查詢，不一起打。
 * - 回傳形狀與 supabase.rpc 相同（{ data, error }），呼叫端不用改。
 */

export interface CachedResult {
  data: unknown;
  error: { message: string } | null;
}

interface Entry {
  at: number;
  data: unknown;
}

export interface TtlCache {
  get(key: string, fetcher: () => PromiseLike<CachedResult>, now?: number): Promise<CachedResult>;
  /** 只給測試用：清掉所有快取 */
  reset(): void;
}

export function createTtlCache(ttlMs: number, label: string): TtlCache {
  const entries = new Map<string, Entry>();
  const inflight = new Map<string, Promise<CachedResult>>();

  return {
    reset() {
      entries.clear();
      inflight.clear();
    },
    get(key, fetcher, now = Date.now()) {
      const hit = entries.get(key);
      if (hit && now - hit.at < ttlMs) {
        return Promise.resolve({ data: hit.data, error: null });
      }
      const pending = inflight.get(key);
      if (pending) return pending;

      const run = (async (): Promise<CachedResult> => {
        let res: CachedResult;
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
          console.warn(`${label} refresh failed (${key}), using stale value:`, res.error.message);
          return { data: hit.data, error: null };
        }
        return res;
      })().finally(() => { inflight.delete(key); });
      inflight.set(key, run);
      return run;
    },
  };
}
