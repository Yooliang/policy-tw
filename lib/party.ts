import { PARTY_EMBLEMS } from './party-emblems'

/**
 * 政黨的顯示規則：黨徽優先，沒有黨徽才退回彩色圓圈加一個字。
 *
 * 2026-09-16 小良哥：「這個黨的小字我想換成圖片，用黨徽來作」。
 * 同時修掉一個舊 bug：四個頁面各自寫 `party === '國民黨' ? 藍 : …`，
 * 但資料庫存的是全名「中國國民黨」，所以每一個政黨都落到灰色，
 * 而字取 `party[0]` 就變成「中」——那正是他截圖裡看到的。
 */

/** 資料庫裡同一個政黨有好幾種寫法（簡稱、臺／台），先收斂成黨徽表用的正式名稱 */
const ALIASES: Readonly<Record<string, string>> = {
  國民黨: '中國國民黨',
  民進黨: '民主進步黨',
  民眾黨: '台灣民眾黨',
  綠黨: '台灣綠黨',
  台聯: '台灣團結聯盟',
}

export function canonicalParty(party: string | null | undefined): string {
  const name = (party ?? '').replace(/臺/g, '台').trim()
  return ALIASES[name] ?? name
}

/** 沒有黨徽時圓圈的底色；比對用正式名稱，不要再各頁自己寫一份 */
const PARTY_COLORS: ReadonlyArray<{ match: string; color: string }> = [
  { match: '中國國民黨', color: 'bg-blue-600' },
  { match: '民主進步黨', color: 'bg-green-600' },
  { match: '台灣民眾黨', color: 'bg-cyan-600' },
  { match: '時代力量', color: 'bg-yellow-500' },
  { match: '台灣基進', color: 'bg-red-600' },
  { match: '親民黨', color: 'bg-orange-500' },
  { match: '新黨', color: 'bg-amber-600' },
]

export function partyColor(party: string | null | undefined): string {
  const name = canonicalParty(party)
  return PARTY_COLORS.find(p => p.match === name)?.color ?? 'bg-slate-500'
}

/**
 * 圓圈裡的字。取第一個字在多數情況下沒有辨識度（「中國國民黨」「中華統一促進黨」都是「中」），
 * 所以無黨籍直接寫「無」，其餘取黨名裡「黨」之前的最後一個字，例如
 * 「台灣基進」→ 進、「小民參政歐巴桑聯盟」→ 盟、「時代力量」→ 量。
 */
export function partyInitial(party: string | null | undefined): string {
  const name = canonicalParty(party)
  if (!name) return '—'
  if (name.startsWith('無黨')) return '無'
  const trimmed = name.replace(/[（(].*$/, '')
  const core = trimmed.endsWith('黨') ? trimmed.slice(0, -1) : trimmed
  return (core.slice(-1) || trimmed.slice(0, 1)) || '—'
}

/** 黨徽圖檔路徑；沒有就回 null，由呼叫端退回彩色圓圈 */
export function partyEmblem(party: string | null | undefined): string | null {
  return PARTY_EMBLEMS[canonicalParty(party)] ?? null
}
