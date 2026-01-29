// IndexedDB cache for politicians data
const DB_NAME = 'zhengjian_cache'
const DB_VERSION = 2 // Incremented to invalidate old cache on schema change
const STORE_NAME = 'politicians'
const CACHE_DURATION = 24 * 60 * 60 * 1000 // 24 hours in milliseconds

// Schema version for data structure validation
// Increment this when the Politician interface changes
const SCHEMA_VERSION = 2

interface CacheEntry<T> {
  data: T
  timestamp: number
  schemaVersion?: number // Track data schema version
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      const oldVersion = event.oldVersion

      // Delete old object store if upgrading from previous version
      if (oldVersion < DB_VERSION && db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME)
        console.log('Cleared old IndexedDB cache due to schema upgrade')
      }

      // Create object stores if they don't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
  })

  return dbPromise
}

async function getFromCache<T>(key: string): Promise<T | null> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(key)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const result = request.result as CacheEntry<T> | undefined
        if (!result) {
          resolve(null)
          return
        }

        // Check if schema version matches (invalidate on mismatch)
        if (result.schemaVersion !== SCHEMA_VERSION) {
          console.log('Cache schema version mismatch, invalidating cache')
          resolve(null)
          return
        }

        // Check if cache is still valid
        const now = Date.now()
        if (now - result.timestamp > CACHE_DURATION) {
          resolve(null) // Cache expired
          return
        }

        resolve(result.data)
      }
    })
  } catch (err) {
    console.warn('IndexedDB read failed:', err)
    return null
  }
}

async function setToCache<T>(key: string, data: T): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)

      const entry: CacheEntry<T> & { key: string } = {
        key,
        data,
        timestamp: Date.now(),
        schemaVersion: SCHEMA_VERSION,
      }

      const request = store.put(entry)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (err) {
    console.warn('IndexedDB write failed:', err)
  }
}

async function clearCache(): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.clear()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (err) {
    console.warn('IndexedDB clear failed:', err)
  }
}

async function getCacheTimestamp(key: string): Promise<number | null> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(key)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const result = request.result as CacheEntry<any> | undefined
        resolve(result?.timestamp || null)
      }
    })
  } catch (err) {
    console.warn('IndexedDB read failed:', err)
    return null
  }
}

export function useIndexedDB() {
  return {
    getFromCache,
    setToCache,
    clearCache,
    getCacheTimestamp,
    CACHE_DURATION,
  }
}
