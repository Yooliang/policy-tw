/**
 * 政黨分流圖的顏色（policy-ops#193）。純資料與純函式。
 *
 * 規則：線條與第一欄節點依「最左邊那個維度」的值上色，整條路徑同色；其他欄的節點用中性灰。
 * - 政黨：沿用 lib/party.ts 的政黨對應色（Tailwind 色名換成 hex，測試逐一比對）；沒有專屬色的小黨與無黨籍用中性灰。
 * - 年齡：單一色相（藍）六階深淺，年輕淺、年長深（深色模式反過來，仍是年長較醒目）。
 * - 其他維度（選舉類別、性別、縣市、結果）：dataviz 的八色類別色盤，依節點順序固定指派；超過八個循環，相鄰仍可辨。
 * - 「未提供」一律中性灰。
 * 每個顏色都有淺色與深色兩版（網站深色模式是 html.dark）。檢查結果見 PR 說明（validate_palette.js）。
 */
export interface FlowColor { color: string; colorDark: string }

export const NEUTRAL: FlowColor = { color: '#94a3b8', colorDark: '#64748b' }

/** party.ts 用的 Tailwind 底色 class → 同色 hex（Tailwind 預設色盤） */
export const TAILWIND_HEX: Readonly<Record<string, string>> = {
  'bg-blue-600': '#2563eb', 'bg-green-600': '#16a34a', 'bg-cyan-600': '#0891b2', 'bg-yellow-500': '#eab308',
  'bg-red-600': '#dc2626', 'bg-orange-500': '#f97316', 'bg-amber-600': '#d97706',
}
/** 政黨正式名稱 → 顏色；要跟 lib/party.ts 的 PARTY_COLORS 一致（lib/party-flow-colors.test.ts 比對原始碼） */
export const PARTY_HEX: Readonly<Record<string, string>> = {
  中國國民黨: TAILWIND_HEX['bg-blue-600'], 民主進步黨: TAILWIND_HEX['bg-green-600'], 台灣民眾黨: TAILWIND_HEX['bg-cyan-600'],
  時代力量: TAILWIND_HEX['bg-yellow-500'], 台灣基進: TAILWIND_HEX['bg-red-600'], 親民黨: TAILWIND_HEX['bg-orange-500'], 新黨: TAILWIND_HEX['bg-amber-600'],
}
export function partyColorOf(name: string): FlowColor {
  const hex = PARTY_HEX[name]
  return hex ? { color: hex, colorDark: hex } : NEUTRAL
}

export const AGE_RAMP_LIGHT = ['#7cb4fc', '#639be1', '#4c82c6', '#346aac', '#1c5293', '#003b7a'] as const
export const AGE_RAMP_DARK = ['#225899', '#386db0', '#4d83c8', '#6299e0', '#78b0f8', '#8ec7ff'] as const
/** 20、30…70 歲組 → 第 0～5 階 */
export function ageColorOf(a: number): FlowColor {
  const i = Math.min(5, Math.max(0, Math.floor(a / 10) - 2))
  return { color: AGE_RAMP_LIGHT[i], colorDark: AGE_RAMP_DARK[i] }
}

/** dataviz 參考色盤的八個類別色（固定順序：藍、橙、青綠、黃、洋紅、綠、紫、紅） */
export const CATEGORICAL: readonly FlowColor[] = [
  { color: '#2a78d6', colorDark: '#3987e5' }, { color: '#eb6834', colorDark: '#d95926' },
  { color: '#1baf7a', colorDark: '#199e70' }, { color: '#eda100', colorDark: '#c98500' },
  { color: '#e87ba4', colorDark: '#d55181' }, { color: '#008300', colorDark: '#008300' },
  { color: '#6250d6', colorDark: '#9085e9' }, { color: '#e34948', colorDark: '#e66767' },
]
export const categoricalColorAt = (i: number): FlowColor => CATEGORICAL[((i % CATEGORICAL.length) + CATEGORICAL.length) % CATEGORICAL.length]
