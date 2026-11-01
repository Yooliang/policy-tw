/**
 * 議題串聯（/election/2026/高雄市?view=issues）的純邏輯：資料庫函式 issues_summary／issues_page 的回傳整理、分頁、層級小計。
 * 分組規則在資料庫端（migration 20261031130000：照 lib/issue-tags.ts 的 issueTagsOf）；前端不再撈整個縣市的參選人與政見再分組。
 */

/** 層級（由上到下），跟資料庫 issue_level_of 的輸出一致 */
export const ISSUE_LEVELS = ['縣市長', '議員', '鄉鎮市區長', '代表', '村里長'] as const
export type IssueLevel = typeof ISSUE_LEVELS[number]

export const ISSUE_PAGE_SIZE = 30
/** 串聯一次取回一個議題的全部承諾（資料庫函式單次上限 100；實測各縣市×議題最多 35 筆） */
export const ISSUE_FETCH_LIMIT = 100

/** 串聯只認縣市，快取鍵也只帶屆別與縣市（臺／台視為同一個） */
export const normRegion = (region: string) => region.replace(/臺/g, '台')

export interface IssueSummary {
  issue: string
  total: number
  byLevel: Partial<Record<IssueLevel, number>>
  samples: string[]
}

export interface IssueCard {
  policyId: string
  title: string
  category: string | null
  proposedDate: string | null
  lineageId: string | null
  level: IssueLevel
  politicianId: string
  name: string
  position: string | null
  candNo: number | null
  avatarUrl: string | null
  party: string | null
}

const isLevel = (v: unknown): v is IssueLevel => (ISSUE_LEVELS as readonly unknown[]).includes(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function mapSummaryRows(rows: unknown): IssueSummary[] {
  if (!Array.isArray(rows)) return []
  const out: IssueSummary[] = []
  for (const r of rows as Array<Record<string, unknown>>) {
    const issue = str(r?.issue)
    const total = Number(r?.total)
    if (!issue || !Number.isFinite(total) || total <= 0) continue
    const byLevel: Partial<Record<IssueLevel, number>> = {}
    const raw = (r.by_level ?? {}) as Record<string, unknown>
    for (const lv of ISSUE_LEVELS) {
      const n = Number(raw[lv])
      if (Number.isFinite(n) && n > 0) byLevel[lv] = n
    }
    out.push({ issue, total, byLevel, samples: Array.isArray(r.samples) ? (r.samples as unknown[]).filter((s): s is string => typeof s === 'string') : [] })
  }
  return out
}

export function mapPageRows(rows: unknown): { cards: IssueCard[]; total: number } {
  if (!Array.isArray(rows)) return { cards: [], total: 0 }
  const cards: IssueCard[] = []
  let total = 0
  for (const r of rows as Array<Record<string, unknown>>) {
    const policyId = str(r?.policy_id)
    const politicianId = str(r?.politician_id)
    if (!policyId || !politicianId || !isLevel(r.level)) continue
    total = Math.max(total, Number(r.total) || 0)
    cards.push({
      policyId, politicianId, level: r.level,
      title: str(r.title) ?? '',
      category: str(r.category),
      proposedDate: str(r.proposed_date),
      lineageId: str(r.lineage_id),
      name: str(r.name) ?? '',
      position: str(r.position_title),
      candNo: typeof r.cand_no === 'number' ? r.cand_no : null,
      avatarUrl: str(r.avatar_url),
      party: str(r.party),
    })
  }
  return { cards, total }
}

/** 層級篩選用：有筆數的層級，由上到下 */
export function levelCounts(s: Pick<IssueSummary, 'byLevel'>): Array<{ level: IssueLevel; count: number }> {
  return ISSUE_LEVELS.flatMap((level) => (s.byLevel[level] ? [{ level, count: s.byLevel[level] as number }] : []))
}

/** 接上下一頁：已經有的政見不重複加（分頁邊界重疊或重複點擊時） */
export function appendCards(prev: readonly IssueCard[], next: readonly IssueCard[]): IssueCard[] {
  const seen = new Set(prev.map((c) => c.policyId))
  return [...prev, ...next.filter((c) => !seen.has(c.policyId))]
}

export const hasMore = (loaded: number, total: number) => loaded < total

export const pageKey = (electionId: number, region: string, issue: string, level: IssueLevel | null, offset: number) =>
  `page|${electionId}|${normRegion(region)}|${issue}|${level ?? ''}|${offset}`
export const summaryKey = (electionId: number, region: string) => `summary|${electionId}|${normRegion(region)}`
