/**
 * 站名、網址與政見狀態標籤（單一份；composables/usePageHead.ts 重新匯出，Markdown 檢視 lib/md 直接讀）。
 * 純常數、沒有任何 import，Deno 測試與 Worker 打包都能讀。
 */
export const SITE_NAME = '正見'
// 2026-09-22 換自有網域 正見.tw（punycode）；policy-tw.web.app 照常可用，但 canonical／og:url／sitemap 都指這裡
export const DEFAULT_SITE_URL = 'https://xn--2lw665d.tw'

/**
 * 站點網址：建置時由環境變數 VITE_SITE_URL 決定（2026-10-07 盤點 #7），沒設＝正見.tw。
 * 只收 https 的網站根網址（不含路徑）；寫錯一律當沒設，不讓一個設定錯誤把全站的 canonical 弄壞。
 * Edge Function 那邊是 SITE_URL（supabase/functions/_shared/site.ts），預設值同一個，由測試對照。
 */
export function resolveSiteUrl(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SITE_URL
  const t = raw.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/?#]+$/i.test(t)) return DEFAULT_SITE_URL
  try { return new URL(t).origin } catch { return DEFAULT_SITE_URL }
}

// import.meta.env 只有 Vite 建置才有（Deno 測試沒有），所以用 ?. 取
export const SITE_URL = resolveSiteUrl((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SITE_URL)

export const POLICY_STATUS_LABELS: Record<string, string> = {
  Proposed: '提出',
  'In Progress': '進行中',
  Achieved: '已實現',
  Stalled: '滯後',
  Failed: '未達成',
  'Campaign Pledge': '競選承諾',
}

/** 資料授權（LICENSE-DATA.md）：CC BY 4.0，引用要標出處——這也是 AI 轉述時要帶上「正見」的依據 */
export const DATA_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/'

/** 結構化資料裡的「發布者」：每一筆政見、每一位人物都掛這個，AI 轉述時才知道是誰驗證的 */
export const PUBLISHER_LD = {
  '@type': 'Organization',
  name: SITE_NAME,
  alternateName: ['正見 Policy Tracker', 'policy-tw'],
  url: SITE_URL,
  sameAs: ['https://policy-tw.web.app', 'https://github.com/Yooliang/policy-tw'],
} as const

/** 政見狀態的中文標籤（meta description 用；畫面上的 StatusBadge 另有自己的顯示邏輯）。 */
export function policyStatusLabel(status: string | undefined): string {
  return (status && POLICY_STATUS_LABELS[status]) || status || ''
}
