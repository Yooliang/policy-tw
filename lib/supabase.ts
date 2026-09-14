import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

/**
 * 有登入狀態的 client。只給真的需要知道「現在是誰」的地方用：
 * useAuth、AuthCallback、後台頁面。
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/**
 * 公開資料專用的 client。它完全不建立 auth：沒有 session、沒有換發 token，
 * 也不會去搶 navigator lock。
 *
 * 2026-09-14 線上事故：使用者的 console 是這個樣子
 *
 *   Failed to load resource: 400          ← POST /auth/v1/token：Refresh token is not valid
 *   Failed to initialize auth: AbortError: signal is aborted without reason
 *   Failed to fetch data from Supabase: AbortError…
 *   [citizen-questions] 讀取提問列表失敗： AbortError…
 *   Failed to get total politician count: AbortError…
 *
 * 整站的資料一筆都載不出來。原因是所有查詢共用同一個 client，而
 * supabase-js 取 access token 的實作是：
 *
 *     if (this.accessToken) return await this.accessToken()
 *     const { data } = await this.auth.getSession()      // ← 這行要先拿到 navigator lock
 *
 * auth 初始化握著那把鎖（可能在換發一個永遠換不成的 token，也可能只是另一個
 * 分頁還佔著），後面每一個資料請求都卡在同一把鎖上，等到逾時就是 AbortError。
 * 第二份 trace 裡連 400 都沒有，純粹是鎖等不到——所以這不是「壞 token」的偶發，
 * 是共用一把鎖的結構問題。
 *
 * 但這個網站的資料**全部公開**，一筆都不需要登入就讀得到。讓「登入壞掉」
 * 有辦法把政見列表變成空白，本身就是錯的耦合。
 *
 * 解法是 supabase-js 的 accessToken 逃生口：給了它，建構式裡那段
 * `if (!settings.accessToken) { this.auth = ... }` 就整個跳過，這個 client
 * 連 auth 物件都不會有，自然也碰不到鎖。回傳 anon key 就是原本沒有 session
 * 時的行為（`?? this.supabaseKey`），所以 RLS 的判定完全沒變。
 *
 * 代價：這個 client 上不能呼叫 .auth.*（會是 undefined）。它只該用來讀公開資料。
 * 注意 persistSession:false 不能取代這個做法——那樣 getSession() 照樣會被呼叫、
 * 照樣會搶鎖，等於沒修。
 */
export const supabasePublic = createClient(supabaseUrl, supabaseAnonKey, {
  accessToken: async () => supabaseAnonKey,
})
