/**
 * 邊緣 Worker 的營運參數（盤點 #7、#8，2026-10-07 維護者同意）：快取時間與上游網址從環境變數讀，給預設值（＝改之前寫死的值）。
 *
 * 為什麼：流量高峰、選舉夜想把快取調長調短，或換上游，不該為此發版——改 wrangler.toml 的 [vars] 後 `wrangler deploy`，
 * 或在 Cloudflare 主控台直接改 Variables 就生效。純函式、沒有 import，Deno 測試與 Worker 都能讀。
 *
 * 值寫壞（不是整數、超出範圍、網址不是 https 的網站根）一律退回預設，不讓一個設定錯誤把整個站弄壞。
 * 範圍是故意卡的：快取太短＝每個請求都打 Supabase；太長＝內容改了很久才更新（人物頁改了要等）。
 */

export const DEFAULTS = Object.freeze({
  /** 頁面快取多久之後背景重新渲染（秒） */
  cacheTtlS: 600,
  /** 邊緣快取最長保存（s-maxage，秒）：重新渲染失敗時，舊頁最多再撐這麼久 */
  staleTtlS: 3600,
  /** 基礎資料（選舉／分類／地區）每個 isolate 多久重撈一次（秒） */
  baseTtlS: 600,
  /** 上游（Firebase Hosting）網址：預渲染頁、工具頁、靜態資源、客戶端殼都在那 */
  origin: 'https://policy-tw.web.app',
})

/** 環境變數名稱 → 設定（給文件與測試對照用） */
export const ENV_NAMES = Object.freeze({
  cacheTtlS: 'SSR_CACHE_TTL_S',
  staleTtlS: 'SSR_STALE_TTL_S',
  baseTtlS: 'SSR_BASE_TTL_S',
  origin: 'ORIGIN',
})

const BOUNDS = Object.freeze({
  cacheTtlS: [10, 86400],
  staleTtlS: [60, 604800],
  baseTtlS: [10, 86400],
})

/** 整數秒；不是整數或超出範圍回 null */
export function parseSeconds(raw, min, max) {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  if (!/^\d{1,9}$/.test(s)) return null
  const n = Number(s)
  return n >= min && n <= max ? n : null
}

/** https 的網站根網址（不含路徑、查詢）；結尾斜線去掉；其餘回 null */
export function parseOrigin(raw) {
  if (typeof raw !== 'string') return null
  const t = raw.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/?#]+$/i.test(t)) return null
  try { return new URL(t).origin } catch { return null }
}

/** Worker 的 env → 設定。每個值各自退回預設，互不牽連 */
export function readWorkerConfig(env) {
  const e = env ?? {}
  const num = (key) => {
    const [min, max] = BOUNDS[key]
    return parseSeconds(e[ENV_NAMES[key]], min, max) ?? DEFAULTS[key]
  }
  const origin = parseOrigin(e[ENV_NAMES.origin]) ?? DEFAULTS.origin
  return {
    cacheTtlS: num('cacheTtlS'),
    staleTtlS: num('staleTtlS'),
    baseTtlMs: num('baseTtlS') * 1000,
    origin,
    originHost: new URL(origin).host,
  }
}
