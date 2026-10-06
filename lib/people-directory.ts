/**
 * 人物一覽（#346 第一階段，2026-10-06）：一萬六千多位人物的總入口，依姓氏筆畫分組（台灣名冊的慣例）。
 *
 * 日本站是五十音索引；這裡用姓名第一個字的筆畫數分組——跟選舉公報、候選人名冊「依姓氏筆畫」同一個習慣。
 * 筆畫數不另外存一份字表：瀏覽器與 Node 內建的 ICU 有中文筆畫排序（zh-Hant 的預設排序就是筆畫），
 * 它在每個筆畫數的開頭放了一個索引標記（U+FDD0 加 U+2800＋筆畫數，ICU 的 AlphabeticIndex 用的就是這組），
 * 拿字去跟標記比大小就知道它幾畫——台灣的寫法（陳 11 畫、黃 12 畫），不是康熙部首算法。
 * 漢字以外的（原住民族語拼音、英文）歸「其他」。
 *
 * 一筆只帶三樣：id、姓名、一行說明。說明照職稱規則（只來自任期，lib/politician-office.ts），沒有現任公職的寫最近一次參選，
 * 同名的人才分得出來。全是純函式：建置端算好放進頁面快照，瀏覽器不必再算一次（hydrate 跟 HTML 一致）。
 */
import { candidacyNote, officeTitles, RESULT_PENDING } from './politician-office'
import { participationLabel } from './participation-label'
import type { Election, Politician } from '../types'

export interface DirectoryEntry {
  id: string
  name: string
  /** 一行說明：現任職稱，或最近一次參選（例：2022 台南市議員・落選）；都沒有就是空字串 */
  label: string
}

export interface DirectorySurname {
  char: string
  count: number
}

export interface DirectoryGroupSummary {
  /** 網址用的鍵：筆畫數（'11'），或 'other' */
  key: string
  label: string
  count: number
  surnames: DirectorySurname[]
}

export interface DirectoryGroup {
  key: string
  label: string
  entries: DirectoryEntry[]
}

/** zh-Hant 的預設排序就是筆畫（同筆畫再比部首／字碼），名冊排序用它 */
const STROKE_ORDER = new Intl.Collator('zh-Hant-TW')
const STROKE_MARKER = (n: number) => `﷐${String.fromCharCode(0x2800 + n)}`
const MAX_STROKES = 64
export const OTHER_GROUP = 'other'

/** 一個字的筆畫數（台灣寫法）；不是漢字回 null */
export function strokeCount(ch: string): number | null {
  if (!ch || !/^\p{Script=Han}$/u.test(ch)) return null
  // 標記照筆畫數遞增排列：找最後一個「不大於這個字」的標記
  let lo = 1
  let hi = MAX_STROKES
  let found: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (STROKE_ORDER.compare(STROKE_MARKER(mid), ch) <= 0) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** 姓名的第一個字（罕用字可能是兩個 UTF-16 單位，要照字算） */
export function firstChar(name: string): string {
  return Array.from(name.trim())[0] ?? ''
}

export function groupKeyOf(name: string): string {
  const n = strokeCount(firstChar(name))
  return n === null ? OTHER_GROUP : String(n)
}

const DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
/** 1～99 的中文數字：11→十一、20→二十、22→二十二 */
export function chineseNumber(n: number): string {
  if (n < 10) return DIGITS[n]
  const tens = Math.floor(n / 10)
  const ones = n % 10
  return `${tens === 1 ? '' : DIGITS[tens]}十${DIGITS[ones]}`
}

export function groupLabel(key: string): string {
  if (key === OTHER_GROUP) return '其他'
  const n = Number(key)
  return Number.isInteger(n) && n > 0 && n < 100 ? `${chineseNumber(n)}畫` : key
}

/**
 * 人物一覽左欄的筆畫標籤，一律兩個字：
 * 1～10 數字＋畫（一畫…九畫、十畫）；11～19 十＋個位（十一…十九，不加畫）；20、30… 整十（二十、三十）；
 * 21～29、31～39… 十位數字＋個位數字、省略「十」（二一、二二、三一）。
 */
export function strokeTag(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) return String(n)
  if (n <= 10) return n === 10 ? '十畫' : `${DIGITS[n]}畫`
  const tens = Math.floor(n / 10)
  const ones = n % 10
  if (tens === 1) return `十${DIGITS[ones]}`
  return ones === 0 ? `${DIGITS[tens]}十` : `${DIGITS[tens]}${DIGITS[ones]}`
}

/** 左欄用：組鍵 → 兩個字的標籤（其他照舊） */
export function groupTag(key: string): string {
  return key === OTHER_GROUP ? '其他' : strokeTag(Number(key))
}

/** 網址上的組名是不是認得的（筆畫數 1～64 或 other） */
export function isGroupKey(key: string): boolean {
  if (key === OTHER_GROUP) return true
  return /^[1-9]\d?$/.test(key) && Number(key) <= MAX_STROKES
}

/**
 * 一筆參選紀錄的狀態字（投完票只講結果、沒結果寫「結果待補」）跟人物頁、政黨頁同一份，
 * 規則在 lib/politician-office.ts 的 candidacyNote（2026-10-06 主線裁定三處統一）；這裡轉出去給既有的引用，不再自己寫一份。
 */
export { candidacyNote, RESULT_PENDING }

/**
 * 一行說明。職稱只來自任期（officeTitles）；沒有現任公職的寫最近一次參選：「2022 台南市議員・落選」，
 * 投完票但結果還沒補上的寫「2022 東港鎮內關帝里長參選人」。最近一次、年份都照投票日，不照 id——#344 之後新增的選舉 id 不是年份。
 * `today`（YYYY-MM-DD）判斷那一屆投完票了沒；建置端用快照的建置日。
 */
export function directoryLabel(pl: Politician, electionDates: ReadonlyMap<number, string>, today: string): string {
  const titles = officeTitles(pl.offices)
  if (titles.length > 0) return titles.join('、')
  const latest = [...(pl.elections ?? [])]
    .sort((a, b) => (electionDates.get(b.electionId) ?? '').localeCompare(electionDates.get(a.electionId) ?? '') || b.electionId - a.electionId)[0]
  if (!latest) return ''
  const what = participationLabel(latest)
  const date = electionDates.get(latest.electionId) ?? ''
  const note = candidacyNote(latest, date !== '' && date < today)
  if (!what || !note) return ''
  const year = date.slice(0, 4) || String(latest.electionId)
  return note === RESULT_PENDING ? `${year} ${what}參選人` : `${year} ${what}・${note}`
}

function compareEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  return STROKE_ORDER.compare(a.name, b.name) || STROKE_ORDER.compare(a.label, b.label) || a.id.localeCompare(b.id)
}

/** 整份名冊 → 索引（每組幾位、有哪些姓）＋每一組的名單。已合併的人不列（人物頁會轉走） */
export function buildDirectory(politicians: readonly Politician[], elections: readonly Election[], today: string): {
  index: DirectoryGroupSummary[]
  groups: Map<string, DirectoryGroup>
} {
  const dates = new Map(elections.map((e) => [e.id, e.electionDate]))
  const groups = new Map<string, DirectoryGroup>()
  for (const pl of politicians) {
    if (pl.mergedInto || !pl.name?.trim()) continue
    const key = groupKeyOf(pl.name)
    let g = groups.get(key)
    if (!g) {
      g = { key, label: groupLabel(key), entries: [] }
      groups.set(key, g)
    }
    g.entries.push({ id: String(pl.id), name: pl.name.trim(), label: directoryLabel(pl, dates, today) })
  }
  for (const g of groups.values()) g.entries.sort(compareEntries)
  const keys = [...groups.keys()].sort((a, b) => (a === OTHER_GROUP ? 1 : b === OTHER_GROUP ? -1 : Number(a) - Number(b)))
  const index = keys.map((key) => {
    const g = groups.get(key)!
    const counts = new Map<string, number>()
    for (const e of g.entries) counts.set(firstChar(e.name), (counts.get(firstChar(e.name)) ?? 0) + 1)
    const surnames = [...counts.entries()]
      .map(([char, count]) => ({ char, count }))
      .sort((a, b) => STROKE_ORDER.compare(a.char, b.char))
    return { key, label: g.label, count: g.entries.length, surnames }
  })
  return { index, groups: new Map(keys.map((k) => [k, groups.get(k)!])) }
}

/** 同一組裡依姓分段（頁面上一個姓一段、段首是錨點） */
export function sectionsBySurname(entries: readonly DirectoryEntry[]): Array<{ char: string; entries: DirectoryEntry[] }> {
  const out: Array<{ char: string; entries: DirectoryEntry[] }> = []
  for (const e of entries) {
    const c = firstChar(e.name)
    const last = out[out.length - 1]
    if (last && last.char === c) last.entries.push(e)
    else out.push({ char: c, entries: [e] })
  }
  return out
}

/** 頁內錨點：姓（id 不能有空白；中文直接當 id 沒問題） */
export function surnameAnchor(char: string): string {
  return `姓-${char}`
}
