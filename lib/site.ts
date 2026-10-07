/**
 * 站名、網址與政見狀態標籤（單一份；composables/usePageHead.ts 重新匯出，Markdown 檢視 lib/md 直接讀）。
 * 純常數、沒有任何 import，Deno 測試與 Worker 打包都能讀。
 */
export const SITE_NAME = '正見'
// 2026-09-22 換自有網域 正見.tw（punycode）；policy-tw.web.app 照常可用，但 canonical／og:url／sitemap 都指這裡
export const SITE_URL = 'https://xn--2lw665d.tw'

export const POLICY_STATUS_LABELS: Record<string, string> = {
  Proposed: '提出',
  'In Progress': '進行中',
  Achieved: '已實現',
  Stalled: '滯後',
  Failed: '未達成',
  'Campaign Pledge': '競選承諾',
}

/** 政見狀態的中文標籤（meta description 用；畫面上的 StatusBadge 另有自己的顯示邏輯）。 */
export function policyStatusLabel(status: string | undefined): string {
  return (status && POLICY_STATUS_LABELS[status]) || status || ''
}
