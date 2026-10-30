/**
 * 頭像縮圖（2026-10-31，方案 B）。
 * 原圖多是外部熱連結（ws.moi.gov.tw 單張最大 8.8 MB）。aegis 定時工作把它縮成 160／330／660 寬 WebP 放進公開儲存桶 avatar-thumbs，
 * 並寫進對照表 avatar_thumbs。這裡是純函式＋批次載入器（不依賴 Vue、supabase，方便測）：
 *   - buildThumb：對照表的一列 → 縮圖網址與 srcset；
 *   - createThumbLoader：頁面上各處的頭像各自 request(url)，合併成一批 RPC，已查過的（含「沒有縮圖」）不再查。
 * 查不到、查詢失敗、縮圖載入失敗，一律退回原圖——縮圖只是加速，不能讓頭像消失。
 */

export const THUMB_BUCKET = 'avatar-thumbs'
export const THUMB_WIDTHS = [160, 330, 660] as const
export type ThumbWidth = (typeof THUMB_WIDTHS)[number]

/** avatar_thumbs_lookup 回傳的一列（路徑欄位沒做就是 null） */
export interface ThumbRow {
  src_url: string
  w160: string | null
  w330: string | null
  w660: string | null
}

export interface Thumb {
  /** 沒有 srcset 能用時的預設圖（優先 330） */
  src: string
  /** 例：「https://…/160.webp 160w, https://…/330.webp 330w」 */
  srcset: string
}

export function thumbPublicUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${THUMB_BUCKET}/${path}`
}

export function buildThumb(row: ThumbRow | null | undefined, supabaseUrl: string): Thumb | null {
  if (!row || !supabaseUrl) return null
  const paths: Array<[ThumbWidth, string | null]> = [[160, row.w160], [330, row.w330], [660, row.w660]]
  const have = paths.filter((p): p is [ThumbWidth, string] => !!p[1])
  if (have.length === 0) return null
  const srcset = have.map(([w, p]) => `${thumbPublicUrl(supabaseUrl, p)} ${w}w`).join(', ')
  const pick = have.find(([w]) => w === 330) ?? have[have.length - 1]
  return { src: thumbPublicUrl(supabaseUrl, pick[1]), srcset }
}

/** 值得去查縮圖的網址：外部 http(s) 圖。儲存桶自己的網址與 data:／相對路徑都不查。 */
export function isThumbCandidate(url: string | null | undefined, supabaseUrl = ''): url is string {
  if (!url || !/^https?:\/\//i.test(url)) return false
  if (supabaseUrl && url.startsWith(supabaseUrl)) return false
  if (url.startsWith('https://api.dicebear.com/')) return false
  return true
}

export interface ThumbLoaderOptions {
  /** 一次問一批網址，回有縮圖的那幾列 */
  fetchRows: (urls: string[]) => Promise<ThumbRow[]>
  /** 查到結果（含「這批裡沒有縮圖的網址」＝ null）時通知 */
  onResolved: (rows: Map<string, ThumbRow | null>) => void
  /** 合併多久內的 request（毫秒） */
  delayMs?: number
  /** 一個 RPC 最多帶幾個網址（SQL 函式上限 500） */
  chunkSize?: number
  /** 測試用：換掉 setTimeout */
  schedule?: (fn: () => void, ms: number) => void
}

export function createThumbLoader(opts: ThumbLoaderOptions) {
  const delayMs = opts.delayMs ?? 40
  const chunkSize = Math.min(opts.chunkSize ?? 300, 500)
  const schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms) })
  const seen = new Set<string>()      // 已排入或查過的網址，不重複問
  let queue: string[] = []
  let armed = false

  async function flush() {
    armed = false
    const batch = queue
    queue = []
    for (let i = 0; i < batch.length; i += chunkSize) {
      const part = batch.slice(i, i + chunkSize)
      try {
        const rows = await opts.fetchRows(part)
        const out = new Map<string, ThumbRow | null>(part.map((u) => [u, null]))
        for (const r of rows) out.set(r.src_url, r)
        opts.onResolved(out)
      } catch {
        // 查詢失敗：允許之後重問，這一批先用原圖
        for (const u of part) seen.delete(u)
      }
    }
  }

  return {
    request(url: string) {
      if (seen.has(url)) return
      seen.add(url)
      queue.push(url)
      if (!armed) { armed = true; schedule(() => { void flush() }, delayMs) }
    },
  }
}

/** 頭像框的邊長（px），給 <img sizes>；Avatar.vue 的 size 對照 */
export const AVATAR_PX: Record<string, number> = { xs: 24, sm: 40, md: 48, lg: 64, xl: 80, '2xl': 160 }
