/**
 * 殼（web.app 的 /app.html）是哪一版：取它載入的 /assets/*.js 與 *.css 檔名（vite 每次建置內容一變檔名就變）。
 *
 * 用途（policy-ops#37，2026-10-09）：邊緣渲染的頁進了 Cache API，部署之後快取裡的舊頁還指著舊的 /assets 檔，
 * 而 Firebase 部署會把舊檔刪掉（回 404）——按鈕失靈、頁面互動壞掉。Worker 存頁時把殼的版本記在 X-Shell-Version，
 * 取出時跟現在的殼比，不一樣就當沒命中、當場重算，不再「先回舊的、背景重算」。
 * 拿不到版本（殼的寫法變了、沒有 /assets）回空字串；兩邊都是空字串視為同一版（不因為認不得就每次重算）。
 */
const ASSET_RE = /\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g

/** @param {string} html */
export function shellVersion(html) {
  const found = String(html ?? '').match(ASSET_RE)
  return found ? [...new Set(found)].sort().join(' ') : ''
}

/** 快取裡那一頁的殼版本跟現在的殼一樣嗎（cached＝存頁時記下的 X-Shell-Version，沒有這個標頭＝舊版 Worker 存的，一律當不同） */
export function sameShell(cached, current) {
  if (cached === null || cached === undefined) return false
  return cached === current
}

/**
 * 快取命中時要不要丟掉重算：只有「拿得到現在的殼、而且版本不同」才重算。
 * 拿不到殼（currentShell 是 null）＝沿用快取：丟掉完好的頁去重算，重算也拿不到殼，整頁就退回代理（主線審查 #540 第 1 點）。
 * @param {string|null|undefined} cachedVersion
 * @param {string|null} currentShell
 */
export function shouldRerender(cachedVersion, currentShell) {
  if (currentShell === null || currentShell === undefined) return false
  return !sameShell(cachedVersion, shellVersion(currentShell))
}

/**
 * 殼的抓取與快取（每個 isolate 一份）：成功的殼 ttlMs 內不重抓；抓失敗後 failCooldownMs 內也不重抓（上游抖動時不會每個請求都打 app.html，
 * 主線審查 #540 第 2 點），這段期間有上一份成功的殼就照用，沒有就丟錯。
 * @param {() => Promise<string>} fetchShell
 * @param {{ ttlMs?: number, failCooldownMs?: number, now?: () => number }} [o]
 */
export function createShellLoader(fetchShell, o = {}) {
  const ttlMs = o.ttlMs ?? 60_000
  const failCooldownMs = o.failCooldownMs ?? 10_000
  const now = o.now ?? (() => Date.now())
  let good = null // 最後一份成功的殼
  let goodAt = 0
  let inflight = null
  let failedAt = -Infinity
  let lastError = null
  return {
    /** 拿殼：可能是快取的；完全沒有殼可用就丟錯 */
    async load() {
      const t = now()
      if (good !== null && t - goodAt <= ttlMs) return good
      if (t - failedAt < failCooldownMs) {
        if (good !== null) return good
        throw lastError ?? new Error('shell unavailable')
      }
      if (!inflight) {
        inflight = fetchShell()
          .then((html) => { good = html; goodAt = now(); return html })
          .catch((e) => { failedAt = now(); lastError = e; throw e })
          .finally(() => { inflight = null })
      }
      try {
        return await inflight
      } catch (e) {
        if (good !== null) return good
        throw e
      }
    },
    /** 拿不到就回 null（只用來比版本，不丟錯） */
    async peek() {
      try { return await this.load() } catch { return null }
    },
  }
}
