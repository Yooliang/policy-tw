import { shallowReactive } from 'vue'
import { supabasePublic as supabase } from '../lib/supabase'
import { buildThumb, createThumbLoader, isThumbCandidate, type Thumb, type ThumbRow } from '../lib/avatar-thumb'

// 原圖網址 → 縮圖列（null＝查過、沒有縮圖）。模組層共用：同一個頭像出現在多處只查一次。
const known = shallowReactive(new Map<string, ThumbRow | null>())
const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''

const loader = createThumbLoader({
  fetchRows: async (urls) => {
    const { data, error } = await supabase.rpc('avatar_thumbs_lookup', { p_urls: urls })
    if (error) throw error
    return (data ?? []) as ThumbRow[]
  },
  onResolved: (rows) => { for (const [u, r] of rows) known.set(u, r) },
})

/**
 * 原圖網址 → 縮圖（有就回，沒有或還沒查到回 null，呼叫端用原圖）。
 * 在 computed／render 裡呼叫：第一次看到某網址時登記批次查詢，查完 known 變動、使用處自動重算。
 * 預渲染（SSR）不查：HTML 裡先放原圖，瀏覽器掛載後才換成縮圖，水合不會對不上。
 */
export function thumbFor(url: string | null | undefined): Thumb | null {
  if (import.meta.env.SSR || !isThumbCandidate(url, supabaseUrl)) return null
  if (!known.has(url)) { loader.request(url); return null }
  return buildThumb(known.get(url), supabaseUrl)
}
