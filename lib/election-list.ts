/**
 * 選舉的先後與「今後／過去」（#344 第一階段，2026-10-05）。
 *
 * 一律看投票日（`electionDate`＝`elections.election_date`），不看 id、不看 `endDate`：
 * - id 只有舊的三筆剛好是年份，之後新增的選舉（補選、罷免投票）不是，拿它排先後會錯
 * - `endDate` 名不副實（三筆存的是投票日，新建時卻寫 12-31），以前「目前的選舉」用 startDate ≤ 今天 ≤ endDate，
 *   投票隔天就找不到進行中的選舉、退回清單第一筆（2022）
 *
 * 「今天」是台灣的日期（UTC+8）。投票日當天還算「今後」。
 * 這個檔案零依賴，能被 deno 直接測（lib/election-list.test.ts）。
 */

/** 只用到投票日的最小形狀；Election 本身符合 */
export interface DatedElection {
  electionDate: string
}

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000

/** epoch 毫秒 → 台灣日期 YYYY-MM-DD */
export function taipeiDay(ms: number): string {
  return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
}

/** 投票日由近到遠的「今後的選舉」（含今天投票的）與由近到遠的「過去的選舉」 */
export function splitElections<T extends DatedElection>(elections: readonly T[], today: string): { upcoming: T[]; past: T[] } {
  const dated = elections.filter((e) => !!e.electionDate)
  const upcoming = dated.filter((e) => e.electionDate >= today).sort((a, b) => a.electionDate.localeCompare(b.electionDate))
  const past = dated.filter((e) => e.electionDate < today).sort((a, b) => b.electionDate.localeCompare(a.electionDate))
  return { upcoming, past }
}

/**
 * 「目前的選舉」：還沒投票（含今天）裡最近的一場；都投完了就是最近投完的那場。
 * 導覽列、頁尾、全站搜尋的預設選舉都用它。沒有任何選舉時回 undefined。
 */
export function currentElection<T extends DatedElection>(elections: readonly T[], today: string): T | undefined {
  const { upcoming, past } = splitElections(elections, today)
  return upcoming[0] ?? past[0]
}

/** 距離投票日幾天（今天投票是 0；已經投完是負數） */
export function daysUntil(electionDate: string, today: string): number {
  const ms = Date.parse(`${electionDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)
  return Math.round(ms / 86400000)
}
