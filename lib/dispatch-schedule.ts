/**
 * 派工日程（/dispatch，#703）的型別、名稱表與分組。
 * 資料來源是三支 anon 可執行的唯讀函式：console_timeline_elections()、console_timeline(選舉)、console_passive()
 * （migration 20261010110000／20261010140000／20261010200000／20261010230000），主控台「派工」頁讀的是同一份。
 * 名稱與歸類照主控台（policy-console src/lib/armLabels.ts、armGroups.ts）搬過來；只有台灣站。
 */

export interface TimelineElection {
  election_id: string
  election_date: string
  election_reason: string | null
  election_types: string[] | null
  name: string | null
}
export interface TimelineWindow {
  rule_id: number
  window_kind: 'always' | 'event' | 'term' | 'recurring'
  election_types: string[] | null
  from_kind: string | null
  until_kind: string | null
  from: string | null
  until: string | null
  /** 規則要的里程碑這場選舉還沒有日期 */
  missing_milestone: boolean
}
export interface TimelineArm {
  arm: string
  /** 1 常時、2 參選期、3 登記後到投票、4 開票、5 就任、6 任期中、7 卸任交接 */
  stage: number
  is_open: boolean
  queue_count: number | null
  election_count?: number
  daily_count?: number
  stage_end?: string | null
  /** 這一屆還有件數，而且這一段已經結束 */
  stale?: boolean
  by_type?: { election_type: string | null; n: number; is_open: boolean }[]
  windows: TimelineWindow[]
}
export interface TimelineMilestone {
  kind: string
  election_type: string | null
  on_date: string
  status: string
}
export interface Timeline {
  today: string
  election: { id: string; date: string; reason: string | null; types: string[] | null; name: string | null }
  milestones: TimelineMilestone[]
  arms: TimelineArm[]
  election_total?: number
  daily_total?: number
}
export interface Passive {
  verify_pending: Record<string, number>
  news_tasks: Record<string, { open: number; closed_7d: number }>
  news_queued: number
  news_7d: Record<string, number> | null
}
/** 規則的排除職位與流量條件（rule id 為鍵） */
export interface RuleFlags { except: string[]; traffic: boolean }

/** 時間軸上的里程碑名稱 */
const MILESTONE_LABEL: Record<string, string> = {
  announced: '選舉公告',
  registration_open: '登記開始',
  registration_close: '登記截止',
  list_published: '名單公告',
  qualification_review: '資格審查',
  draw: '抽籤',
  bulletin_published: '公報上網',
  polling: '投票日',
  result_announced: '結果公告',
  certified: '當選證書',
  term_start: '就職',
  term_end: '卸任',
}
export const milestoneLabel = (kind: string) => MILESTONE_LABEL[kind] ?? kind

/** 七段（不帶編號）；hint 說這一段裡放哪些任務 */
export const STAGE_META: Record<number, { label: string; hint: string }> = {
  1: { label: '常時', hint: '人物資料、出處、重複清理、網站請求' },
  2: { label: '參選期', hint: '表態到登記截止：名冊缺口、參選紀錄出處' },
  3: { label: '登記後到投票', hint: '名單清查、參選狀態、不參選核對、政黨名冊、號次、補政見、選區名額、退選查核' },
  4: { label: '開票', hint: '投票日隔天起：選舉結果、當選缺漏、政黨補齊' },
  5: { label: '就任', hint: '當選到就職：任內政見' },
  6: { label: '任期中', hint: '進度追蹤、到期檢查、政策脈絡' },
  7: { label: '卸任交接', hint: '卸任前後的交接紀錄' },
}

/** 派工臂（任務種類）的中文名；查不到就原樣顯示代號 */
const ARM_LABEL: Readonly<Record<string, string>> = {
  'raw:policy_missing': '當屆缺政見',
  'raw:profile_gap': '缺人物資料',
  'raw:policy_validity': '疑似不是政見',
  'raw:progress_stale': '進度停滯',
  'raw:candidacy_source_missing': '參選紀錄待補',
  'raw:roster_check': '名單清查',
  'raw:policy_election_missing': '政見缺屆別',
  'raw:candidate_status_stale': '參選狀態待確認',
  'raw:election_result_missing': '缺選舉結果',
  dup: '同名人物確認',
  legacy: '早期匯入核對',
  mismatch: '政見屆別對不上',
  policy_dup: '政見重複清查',
  not_running: '不參選待核對',
  mayor_policies: '縣市長政見補齊',
  term_policies: '補舊屆政見',
  roster_villages: '村里名單清查',
  township_gap: '補鄉鎮資料',
  region_gap: '補選舉區',
  elected_missing: '補選舉結果（當選）',
  roster_cec_gap: '名冊缺口核對',
  district_seats: '補應選名額',
  policy_elements: '拆政見三要素',
  deadline_due: '期限到了查進度',
  lineage_candidates: '找同一件事的政見',
  handover_missing: '記前後任交接',
  lineage_roles: '標參與角色',
  lineage_links: '找上下級脈絡',
  career_sources: '補學經歷出處',
  withdrawn_filing: '退選狀態待核對',
  party_gap: '補黨籍（已投票的屆別）',
  party_roster: '政黨名冊核對',
  party_info: '補政黨資訊',
  placeholder_politicians: '疑似測試資料或空殼人物',
  election_results: '補選舉結果',
  owner_mismatch: '參選紀錄疑似掛錯人',
  ballot_numbers: '補號次',
  regional_stats_missing: '補區域統計',
  manual_visitor: '網站請求／公民提問',
  manual_open: '其他手動任務',
  'traffic:progress_stale': '有人看才追：進度停滯',
  'traffic:deadline_due': '有人看才追：期限到了查進度',
  'traffic:term_policies': '有人看才追：補舊屆政見',
}
export const armLabel = (arm: string) => ARM_LABEL[arm] ?? arm

export type ArmGroup = 'passive' | 'cleanup' | 'backlog' | 'election' | 'unclassified'
const GROUP: Record<string, ArmGroup> = {
  manual_visitor: 'passive',
  policy_dup: 'cleanup', 'raw:policy_election_missing': 'cleanup', mismatch: 'cleanup', 'raw:policy_validity': 'cleanup',
  owner_mismatch: 'cleanup', dup: 'cleanup', placeholder_politicians: 'cleanup', manual_open: 'cleanup',
  'raw:profile_gap': 'backlog', regional_stats_missing: 'backlog', legacy: 'backlog', township_gap: 'backlog',
  region_gap: 'backlog', career_sources: 'backlog', party_info: 'backlog',
  'raw:candidacy_source_missing': 'election', roster_cec_gap: 'election', 'raw:policy_missing': 'election',
  'raw:roster_check': 'election', policy_elements: 'election', party_roster: 'election', district_seats: 'election',
  roster_villages: 'election', not_running: 'election', mayor_policies: 'election', ballot_numbers: 'election',
  'raw:candidate_status_stale': 'election', withdrawn_filing: 'election', party_gap: 'election',
  election_results: 'election', elected_missing: 'election', term_policies: 'election', lineage_candidates: 'election',
  'raw:progress_stale': 'election', deadline_due: 'election', lineage_links: 'election', lineage_roles: 'election',
  handover_missing: 'election',
  'traffic:progress_stale': 'election', 'traffic:deadline_due': 'election', 'traffic:term_policies': 'election',
}
export const armGroup = (arm: string): ArmGroup => GROUP[arm] ?? 'unclassified'

export const DAILY_GROUPS: { key: 'cleanup' | 'backlog' | 'unclassified'; label: string; hint: string }[] = [
  { key: 'cleanup', label: '資料清理', hint: '交件之後系統比對自己的資料才發現的問題（重複、對不上、歸錯）' },
  { key: 'backlog', label: '存量補洞', hint: '資料本來就缺、慢慢補' },
  { key: 'unclassified', label: '未歸類', hint: '還沒有歸類的任務種類' },
]

// ---- 時間比例尺（純函式，給頁面與測試用） ----

const DAY = 86_400_000
export const toDay = (s: string) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY)
export const fromDay = (d: number) => new Date(d * DAY).toISOString().slice(0, 10)

/**
 * 分段比例尺：相鄰兩個錨點（各里程碑與今天，頭尾各留 30 天）之間的寬度跟天數的平方根成正比，
 * 登記到投票這幾週不會被四年任期擠成一條線。回傳「日期 → 0～100」的函式。
 */
export function makeScale(days: number[]): (day: number) => number {
  const sorted = [...new Set(days)].sort((a, b) => a - b)
  const a = [sorted[0] - 30, ...sorted, sorted[sorted.length - 1] + 30]
  const c = [0]
  for (let i = 1; i < a.length; i++) c.push(c[i - 1] + Math.sqrt(Math.max(a[i] - a[i - 1], 1)))
  const total = c[c.length - 1]
  return (day: number) => {
    if (day <= a[0]) return 0
    if (day >= a[a.length - 1]) return 100
    let i = 1
    while (a[i] < day) i++
    const t = (day - a[i - 1]) / (a[i] - a[i - 1])
    return ((c[i - 1] + t * (c[i] - c[i - 1])) / total) * 100
  }
}
