/**
 * 以鍵快取非同步載入的結果（記憶體、不過期）。
 * - 同一個鍵第二次起不再呼叫載入函式；同時進行中的同一個鍵共用同一個 Promise（不並發重複打）。
 * - 載入失敗的不留（下次再試）。
 * - clear() 才會重抓（按重新整理、換屆別時呼叫）。
 * 單例放在模組層（lib/map-data-cache.ts），所以離開參選地圖頁再回來也不用重撈。
 */
export interface AsyncCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>
  has(key: string): boolean
  clear(): void
  readonly size: number
}

export function createAsyncCache<T>(): AsyncCache<T> {
  const store = new Map<string, Promise<T>>()
  return {
    get(key, load) {
      const hit = store.get(key)
      if (hit) return hit
      const p = load()
      store.set(key, p)
      p.catch(() => { if (store.get(key) === p) store.delete(key) })
      return p
    },
    has: (key) => store.has(key),
    clear: () => store.clear(),
    get size() { return store.size },
  }
}
