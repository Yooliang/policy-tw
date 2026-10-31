/**
 * 跨重新整理的短期查詢快取（IndexedDB，2026-10-31）：key＝查詢參數字串，TTL 10 分鐘，最多留最近 30 筆。
 * 用法是 stale-while-revalidate：開頁先拿快取畫，背景再抓新的寫回（下一次開頁就是新的）。
 * 讀寫全包 try/catch——無痕、被封鎖、容量滿、舊瀏覽器都當作沒有快取，不影響原本的載入流程。
 */
const DB_NAME = 'zj-query-cache'
const STORE = 'q'
export const IDB_CACHE_TTL_MS = 10 * 60 * 1000
export const IDB_CACHE_MAX_ENTRIES = 30

interface Entry { key: string; t: number; v: unknown }

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'key' }) }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
}

/** 取快取；過期或沒有回 undefined。過期的順手刪掉 */
export async function idbGet<T>(key: string, ttlMs = IDB_CACHE_TTL_MS): Promise<T | undefined> {
  try {
    const db = await open()
    if (!db) return undefined
    return await new Promise<T | undefined>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const req = store.get(key)
      req.onsuccess = () => {
        const e = req.result as Entry | undefined
        if (!e) return resolve(undefined)
        if (Date.now() - e.t > ttlMs) { store.delete(key); return resolve(undefined) }
        resolve(e.v as T)
      }
      req.onerror = () => resolve(undefined)
      tx.oncomplete = () => db.close()
    })
  } catch { return undefined }
}

/** 寫快取；超過上限就刪最舊的 */
export async function idbPut(key: string, value: unknown): Promise<void> {
  try {
    const db = await open()
    if (!db) return
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      store.put({ key, t: Date.now(), v: value } satisfies Entry)
      const all = store.getAll()
      all.onsuccess = () => {
        const rows = (all.result as Entry[]).sort((a, b) => a.t - b.t)
        for (const r of rows.slice(0, Math.max(0, rows.length - IDB_CACHE_MAX_ENTRIES))) store.delete(r.key)
      }
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); resolve() }
    })
  } catch { /* 寫不進去就算了 */ }
}
