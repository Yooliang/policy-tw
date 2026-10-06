/**
 * 選舉的網址識別與先後（#344 第二階段 A，2026-10-07）。
 *
 * 選舉頁的網址 `/election/:electionId` 裡那一段（segment）有兩種寫法：
 *   - 舊三屆（2022、2024、2026，elections.id 剛好等於投票年份）：照舊用 id，`/election/2022`——網址保持（維護者 10-05），
 *     搜尋引擎累積的收錄與外部連結都不動；
 *   - 之後新增的選舉（補選、罷免投票、重行選舉，id 照序號拿、不是年份）：用 election_key，
 *     例如 `/election/2022-12-18_rerun_10020`。
 * 舊三屆的 key 寫法（`/election/2022-11-26_local`）也能開：Worker 與 Firebase 301 到年份寫法，頁面自己也會換掉，canonical 只指年份寫法。
 * 要不要把三屆也改成 key 寫法（301 方向反過來）是維護者的事，這裡只留一個地方（electionSegment）決定。
 *
 * 先後與年份一律用 election_date，不從 id 推：新增的選舉 id 不保證是年份、也不保證越大越新。
 */

export interface ElectionRouteRef {
  id: number
  /** 沒給（舊快取、測試的假資料）就當舊三屆用 id 當網址 */
  electionKey?: string
  electionDate: string
}

/**
 * 舊三屆：id 就是年份、網址用 id。固定這份清單，不用「id 等於年份」去推：
 * 之後新增的選舉就算 id 碰巧像年份，也不該悄悄換一種網址。
 * （Worker 的 301 清單在 cloudflare/region-path.js 的 LEGACY_ELECTION_KEYS，election-route.test.ts 盯兩邊一致）
 */
export const LEGACY_ELECTION_KEYS: Readonly<Record<string, number>> = {
  '2022-11-26_local': 2022,
  '2024-01-13_national': 2024,
  '2026-11-28_local': 2026,
}

/** 網址上這場選舉那一段；舊三屆是 id、其他是 election_key */
export function electionSegment(e: ElectionRouteRef): string {
  if (!e.electionKey) return String(e.id)
  return LEGACY_ELECTION_KEYS[e.electionKey] === e.id ? String(e.id) : e.electionKey
}

/** 網址上的一段 → 選舉；數字找 id、其餘找 election_key（舊三屆的 key 寫法也找得到）。找不到回 undefined */
export function findElectionBySegment<T extends ElectionRouteRef>(elections: readonly T[], segment: unknown): T | undefined {
  const s = Array.isArray(segment) ? segment[0] : segment
  if (typeof s !== 'string' || s === '') return undefined
  if (/^\d+$/.test(s)) return elections.find((e) => e.id === Number(s))
  return elections.find((e) => e.electionKey === s)
}

/** 這一段是不是「舊三屆的 key 寫法」；是的話回應該換成的年份寫法（301／replace 用） */
export function legacyKeySegmentTarget(segment: unknown): string | undefined {
  const s = Array.isArray(segment) ? segment[0] : segment
  if (typeof s !== 'string') return undefined
  const id = LEGACY_ELECTION_KEYS[s]
  return id === undefined ? undefined : String(id)
}

/** 選舉 id → 網址那一段；清單裡找不到（還沒載入）就退回 id 本身 */
export function segmentOfId(elections: readonly ElectionRouteRef[], id: number | null | undefined): string {
  if (id === null || id === undefined) return ''
  const e = elections.find((x) => x.id === id)
  return e ? electionSegment(e) : String(id)
}

/** 投票日的年份；沒有日期回 undefined（顯示用，不拿來當 id） */
export function electionYearOfDate(electionDate: string | null | undefined): number | undefined {
  const y = Number(String(electionDate ?? '').slice(0, 4))
  return Number.isInteger(y) && y > 1900 ? y : undefined
}

/** 兩筆參選紀錄／任期，新的在前：有投票日就比投票日，沒有（舊視圖、舊快取）才退回 id */
export function newerFirst(
  a: { electionId: number; electionDate?: string },
  b: { electionId: number; electionDate?: string },
): number {
  if (a.electionDate && b.electionDate && a.electionDate !== b.electionDate) return a.electionDate < b.electionDate ? 1 : -1
  return b.electionId - a.electionId
}
