/**
 * 動態牆每一列的「最近變動」文字（2026-09-18）。
 *
 * 排序改成最近有變動的在最上面之後，讀者第一個想知道的是「它剛剛發生什麼事」，
 * 而不是這筆貢獻原本在做哪個任務。所以每一列講一句：什麼時候、變成什麼樣。
 */

/** 後端 contributions.last_activity 的值：投票的 verdict、status:<新狀態>、或 created */
export type ActivityCode = string

const STATUS_TEXT: Record<string, string> = {
  applied: '已上線',
  verified: '通過驗證，正在上線',
  disputed: '有爭議，轉交裁決',
  rejected: '已退件',
  reverted: '已還原',
  apply_failed: '上線失敗，系統會自動重試',
  superseded: '同一宣稱已由別筆上線，這筆收編',
  pending: '重新回到等待驗證',
}

const VOTE_TEXT: Record<string, string> = {
  agree: '有人投了同意',
  disagree: '有人投了反對',
  unsure: '有人投了存疑',
}

/**
 * 變動內容講成一句話。投票要帶上目前票數，不然「有人投了同意」看不出離通過還有多遠。
 * 看不懂的代碼回 null——寧可不顯示，也不要編一句話出來。
 */
export function activityText(code: ActivityCode | null | undefined, votes?: { agree: number; required: number }): string | null {
  if (!code) return null
  if (code === 'created') return '剛提交，等待驗證'
  if (code.startsWith('status:')) return STATUS_TEXT[code.slice(7)] ?? null
  const vote = VOTE_TEXT[code]
  if (!vote) return null
  if (!votes || votes.required <= 0) return vote
  const left = Math.max(0, votes.required - votes.agree)
  return left > 0 ? `${vote}（${votes.agree}/${votes.required} 票，還差 ${left} 票）` : `${vote}（${votes.agree}/${votes.required} 票）`
}

/**
 * 相對時間。只講到「天」為止，再久就沒有「最近有變動」的意味了，改回日期。
 * 未來時間（機器時鐘有偏差）當成剛剛，不要顯示「-3 分鐘前」。
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const diffSec = Math.floor((now - t) / 1000)
  if (diffSec < 60) return '剛剛'
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min} 分鐘前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小時前`
  const day = Math.floor(hour / 24)
  if (day <= 7) return `${day} 天前`
  return new Date(t).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })
}
