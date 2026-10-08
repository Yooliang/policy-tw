/**
 * 縣市（某屆）的 Markdown：`/election/<屆>/<縣市>.md`（HTML 縣市頁網址加 .md；docs/PLAN-markdown-views.md 2.1）。
 *
 * 內容跟縣市頁同一批人：那一屆在這個縣市在選的候選人（退選的不算），職位與分組照 lib/election-levels.ts 的職位表
 * （縣市長、縣市議員依選舉區、立法委員、鄉鎮市長依鄉鎮…），再接各人名下「這一屆的競選承諾」（lib/md/pledge.ts；維護者 10-07：範圍由人改為政見；
 * 落選者的承諾保留、標「未當選」）。人物排序＝姓名筆畫，同組政見依提出日期、再依 id。
 * 沒有政見的候選人不展開，一組一行列名字。
 */
import type { Election, Policy, Politician } from '../../types'
import { POSITIONS, positionSpec } from '../election-levels'
import { compareRegionName } from '../region-name'
import { participationLabel } from '../participation-label'
import { mdCandidacyNote, runningRecord } from './scope'
import { pledgesOf } from './pledge'
import {
  abs, compareByName, comparePolicies, electionYear, latestTime, oneLine, policyBullet, politicianMdPath, politicianUrl,
  type MdPage,
} from './format'

export interface RegionMdInput {
  election: Election
  /** 選舉網址那一段（electionSegment） */
  segment: string
  region: string
  /** 這一屆在這個縣市的候選人（含沒有政見的；退選的由這裡再濾一次） */
  candidates: Politician[]
  /** 這些候選人名下沒被移除的政見 */
  policies: Policy[]
  today: string
  /** 名單撈不完（分頁到上限）時給 true，講一句 */
  truncated?: boolean
}

const TYPE_ORDER = new Map(POSITIONS.map((p, i) => [p.type as string, i]))
const typeRank = (t: string | undefined) => (t && TYPE_ORDER.has(t) ? (TYPE_ORDER.get(t) as number) : 99)

interface Row { person: Politician; type: string; sub: string; line: string; policies: Policy[] }

export function buildRegionPage(input: RegionMdInput): MdPage {
  const { election, region } = input
  const year = electionYear(election)
  const byPerson = new Map<string, Policy[]>()
  for (const p of pledgesOf(input.policies, election)) byPerson.set(p.politicianId, [...(byPerson.get(p.politicianId) ?? []), p])

  const rows: Row[] = []
  const seen = new Set<string>()
  for (const person of input.candidates) {
    if (seen.has(person.id) || person.mergedInto) continue
    const rec = runningRecord(person, election.id)
    if (!rec) continue
    seen.add(person.id)
    const note = mdCandidacyNote(rec, election.electionDate < input.today)
    const what = participationLabel(rec) || rec.position || '參選'
    rows.push({
      person,
      type: rec.electionType ?? '',
      sub: rec.electionType === '縣市長' ? '' : (rec.subRegion ?? ''),
      line: `${what}${note ? `・${note}` : ''}${rec.candNo ? `｜號次 ${rec.candNo}` : ''}`,
      policies: (byPerson.get(person.id) ?? []).sort(comparePolicies),
    })
  }

  const types = [...new Set(rows.map((r) => r.type))].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b))
  const withPolicies = rows.filter((r) => r.policies.length > 0)
  const policyCount = withPolicies.reduce((n, r) => n + r.policies.length, 0)

  const body: string[] = ['## 概況', '']
  body.push(`- 選舉：${election.name}（投票日 ${election.electionDate}）`)
  body.push(`- 縣市：${region}`)
  body.push(`- 候選人 ${rows.length} 位；有政見資料的 ${withPolicies.length} 位、政見 ${policyCount} 筆`)
  body.push(`- 網頁版：${abs(`/election/${input.segment}/${encodeURIComponent(region)}`)}`)
  if (input.truncated) body.push('- 候選人名單撈取沒有完成，這一份可能不完整')

  for (const type of types) {
    const label = positionSpec(type)?.label ?? type
    const inType = rows.filter((r) => r.type === type)
    const typePolicies = inType.reduce((n, r) => n + r.policies.length, 0)
    body.push('', `## ${label}（候選人 ${inType.length} 位，有政見 ${inType.filter((r) => r.policies.length > 0).length} 位、政見 ${typePolicies} 筆）`)
    const subs = [...new Set(inType.map((r) => r.sub))].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : compareRegionName(a, b)))
    for (const sub of subs) {
      const group = inType.filter((r) => r.sub === sub).sort((a, b) => compareByName(a.person, b.person))
      const level = sub ? '####' : '###'
      if (sub) body.push('', `### ${sub}`)
      const noPolicy = group.filter((r) => r.policies.length === 0)
      for (const r of group.filter((x) => x.policies.length > 0)) {
        body.push('', `${level} ${r.person.name}${r.person.party ? `（${r.person.party}）` : ''}`, '')
        body.push(`- 參選：${r.line}`)
        body.push(`- 人物頁：${politicianUrl(r.person.id)} ｜ 摘要：${abs(politicianMdPath(r.person.id))}`)
        body.push(`- 政見 ${r.policies.length} 筆：`)
        for (const p of r.policies) body.push(...policyBullet(p, { descMax: 120 }).map((l) => `  ${l}`))
      }
      if (noPolicy.length > 0) {
        body.push('', `尚無政見資料（${noPolicy.length} 位）：${noPolicy.map((r) => `${r.person.name}${r.person.party ? `（${oneLine(r.person.party)}）` : ''}`).join('、')}`)
      }
    }
  }
  if (rows.length === 0) body.push('', '資料庫目前沒有收錄這一屆這個縣市的候選人。')

  const typeLabels = types.map((t) => positionSpec(t)?.label ?? t)
  return {
    title: `${region} ${year} 候選人與競選承諾`,
    htmlPath: `/election/${input.segment}/${encodeURIComponent(region)}`,
    dataAsOf: latestTime(input.policies.map((p) => p.updatedAt ?? p.lastUpdated)),
    scope: `${year} 屆（${election.name}）競選承諾；${region}${typeLabels.length ? `；${typeLabels.join('、')}` : ''}；共 ${withPolicies.length} 位有政見的候選人、${policyCount} 筆政見（候選人 ${rows.length} 位）`,
    preface: [],
    body,
    rowCount: policyCount,
  }
}
