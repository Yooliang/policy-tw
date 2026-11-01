/**
 * 有時效的記憶體快取＋請求去重（議題串聯用：同一個鍵 10 分鐘內不重打，同時進行中的共用同一個 Promise）。
 * - 載入失敗的不留（下次再試）。
 * - now 可注入，測試用假時鐘。
 * 跟 lib/async-cache.ts（不過期）分開：串聯的資料會變，不能整個工作階段都不重抓。
 */
export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>
  clear(): void
  readonly size: number
}

export function createTtlCache<T>(ttlMs: number, now: () => number = Date.now): TtlCache<T> {
  const store = new Map<string, { at: number; promise: Promise<T> }>()
  return {
    get(key, load) {
      const hit = store.get(key)
      if (hit && now() - hit.at < ttlMs) return hit.promise
      const promise = load()
      const entry = { at: now(), promise }
      store.set(key, entry)
      promise.catch(() => { if (store.get(key) === entry) store.delete(key) })
      return promise
    },
    clear: () => store.clear(),
    get size() { return store.size },
  }
}
