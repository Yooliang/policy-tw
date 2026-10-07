/**
 * 分類、縣市×分類的 Markdown（docs/PLAN-markdown-views.md 2.1；維護者 2026-10-07：「主題」就用既有分類 policies.category，數字直接按 category 算）。
 *
 * 兩種都從同一份「收錄的人」（lib/md/scope.ts：最新一屆在選候選人）與他們名下沒被移除的政見出發，只差篩選條件：
 * `policies.category` 等於它。排序：縣市照網站縣市順序、人物依姓名筆畫、同人政見依提出日期再依 id。
 * 0 筆時寫「資料庫目前沒有收錄」，不是 404。網址：
 *   /data/<屆>/<分類>.md            全國、依縣市分組（/category/<分類>.md 是它的最新一屆短網址）
 *   /data/<屆>/<縣市>/<分類>.md     某縣市某分類
 */
import type { Election, Policy } from '../../types'
import { TAIWAN_COUNTIES } from '../election-regions'
import { NATIONAL, type ScopedPerson } from './scope'
import {
  abs, compareByName, comparePolicies, dataCategoryMdPath, dataRegionCategoryMdPath, electionYear, latestTime, policyBullet,
  politicianMdPath, politicianUrl, type MdPage,
} from './format'

export interface ListContext {
  election: Election
  /** 選舉網址那一段（electionSegment） */
  segment: string
  /** 收錄的人（scopePeople 的結果） */
  scoped: ScopedPerson[]
  /** 全部沒被移除的政見（不只收錄的人的；用來數「不在此列」） */
  policies: Policy[]
}

const REGION_ORDER = new Map<string, number>([...TAIWAN_COUNTIES, NATIONAL].map((r, i) => [r, i]))
export const regionRank = (r: string) => REGION_ORDER.get(r) ?? 99

interface Hit { person: ScopedPerson; policies: Policy[] }

function policiesByPerson(ctx: ListContext): Map<string, Policy[]> {
  const m = new Map<string, Policy[]>()
  for (const p of ctx.policies) m.set(p.politicianId, [...(m.get(p.politicianId) ?? []), p])
  return m
}

/** 收錄的人裡，有符合政見的人（依姓名筆畫） */
function hits(ctx: ListContext, region: string | null, category: string): Hit[] {
  const by = policiesByPerson(ctx)
  return ctx.scoped
    .filter((s) => region === null || s.region === region)
    .map((s) => ({ person: s, policies: (by.get(s.politician.id) ?? []).filter((p) => p.category === category).sort(comparePolicies) }))
    .filter((h) => h.policies.length > 0)
    .sort((a, b) => compareByName(a.person.politician, b.person.politician))
}

const count = (hs: Hit[]) => hs.reduce((n, h) => n + h.policies.length, 0)

/** 政見的說明在這兩種頁截到幾個字（給 NotebookLM 問答用，比縣市頁寬一些） */
const DESC_MAX = 300

function personBlock(h: Hit, heading: string): string[] {
  const { politician } = h.person
  const lines = ['', `${heading} ${politician.name}${politician.party ? `（${politician.party}）` : ''}`, '']
  lines.push(`- ${h.person.label}`)
  lines.push(`- 人物頁：${politicianUrl(politician.id)}｜摘要：${abs(politicianMdPath(politician.id))}`)
  lines.push(`- 政見 ${h.policies.length} 筆：`)
  for (const p of h.policies) lines.push(...policyBullet(p, { descMax: DESC_MAX }).map((l) => `  ${l}`))
  return lines
}

const EMPTY = '資料庫目前沒有收錄符合的政見。'

function scopeLine(ctx: ListContext, what: string, hs: Hit[]): string {
  return `${electionYear(ctx.election)} 屆（${ctx.election.name}）在選候選人名下的政見；${what}；${hs.length} 位、${count(hs)} 筆政見`
}

/** `/data/<屆>/<分類>.md`：全國、依縣市分組 */
export function buildCategoryPage(category: string, ctx: ListContext): MdPage {
  const all = hits(ctx, null, category)
  const regions = [...new Set(all.map((h) => h.person.region))].sort((a, b) => regionRank(a) - regionRank(b))
  const body: string[] = []
  for (const region of regions) {
    const rs = all.filter((h) => h.person.region === region)
    body.push('', `## ${region}（${rs.length} 位、${count(rs)} 筆）`)
    if (region !== NATIONAL) body.push('', `- 這個縣市的${category}政見：${abs(dataRegionCategoryMdPath(ctx.segment, region, category))}`)
    for (const h of rs) body.push(...personBlock(h, '###'))
  }
  if (all.length === 0) body.push(EMPTY)
  return {
    title: `${electionYear(ctx.election)} ${category}政見（依縣市分組）`,
    htmlPath: null,
    dataAsOf: latestTime(all.flatMap((h) => h.policies.map((p) => p.updatedAt ?? p.lastUpdated))),
    scope: scopeLine(ctx, `分類：${category}`, all),
    preface: [],
    body,
    rowCount: count(all),
  }
}

/** `/data/<屆>/<縣市>/<分類>.md` */
export function buildRegionCategoryPage(region: string, category: string, ctx: ListContext): MdPage {
  const hs = hits(ctx, region, category)
  const body: string[] = []
  for (const h of hs) body.push(...personBlock(h, '##'))
  if (hs.length === 0) body.push(EMPTY)
  return {
    title: `${region} ${electionYear(ctx.election)} ${category}政見`,
    htmlPath: null,
    dataAsOf: latestTime(hs.flatMap((h) => h.policies.map((p) => p.updatedAt ?? p.lastUpdated))),
    scope: scopeLine(ctx, `縣市：${region}；分類：${category}`, hs),
    preface: [`全國的${category}政見：${abs(dataCategoryMdPath(ctx.segment, category))}`],
    body,
    rowCount: count(hs),
  }
}

/** 矩陣的一格：縣市×分類的政見筆數（跟 buildRegionCategoryPage 的 rowCount 同一個算法） */
export function categoryCount(region: string, category: string, ctx: ListContext): number {
  return count(hits(ctx, region, category))
}
