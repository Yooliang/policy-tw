/**
 * 人物的 Markdown：`/politician/<id>.md`（HTML 人物頁網址加 .md；docs/PLAN-markdown-views.md 2.1、4）。
 *
 * 內容：姓名、政黨、現任公職（只來自任期，lib/politician-office.ts）、參選紀錄、政見清單（類別、標題、狀態、進度、提出日期、
 * 最後更新、說明、三要素、出處）。政見依屆別分組，屆別新的在前；同屆內依提出日期、再依 id。
 */
import type { Election, Policy, Politician, PoliticianElectionData } from '../../types'
import { candidacyNote, officeTitles } from '../politician-office'
import { participationLabel } from '../participation-label'
import { newerFirst } from '../election-route'
import { elementCells } from '../policy-elements'
import { policyStatusLabel } from '../site'
import {
  NO_SOURCE, abs, comparePolicies, electionYear, latestTime, oneLine,
  policyUpdated, politicianMdPath, politicianUrl, primarySource, progressText, renderPage, sourceText, truncate, type MdPage,
} from './format'

export interface PoliticianMdInput {
  politician: Politician
  /** 這個人名下沒被移除的政見 */
  policies: Policy[]
  elections: Election[]
  /** 今天（台北，YYYY-MM-DD）：判斷某一屆投完票了沒 */
  today: string
  generatedAt: number
}

const BIO_MAX = 300

function electionName(elections: readonly Election[], id: number): string {
  const e = elections.find((x) => x.id === id)
  return e ? `${electionYear(e)} ${e.name}` : `選舉 ${id}`
}

/** 一筆參選紀錄一行：2026 台南市長（115年地方公職人員選舉）：已登記｜號次 3｜口號 … */
function participationLine(rec: PoliticianElectionData, elections: readonly Election[], today: string): string {
  const e = elections.find((x) => x.id === rec.electionId)
  const date = rec.electionDate ?? e?.electionDate ?? ''
  const voted = date !== '' && date < today
  const status = candidacyNote(rec, voted)
  const what = participationLabel(rec) || rec.position || '參選'
  const year = date.slice(0, 4) || String(rec.electionId)
  const bits = [
    status || '狀態未標',
    rec.candNo ? `號次 ${rec.candNo}` : null,
    rec.slogan ? `口號 ${oneLine(rec.slogan)}` : null,
  ].filter((x): x is string => !!x)
  return `- ${year} ${what}${e ? `（${e.name}）` : ''}：${bits.join('｜')}`
}

function policyBlock(p: Policy): string[] {
  const head = [
    p.category || null,
    policyStatusLabel(String(p.status)) || null,
    progressText(p),
    p.proposedDate ? `提出 ${p.proposedDate}` : '提出日期未註明',
    policyUpdated(p) ? `最後更新 ${policyUpdated(p)}` : null,
  ].filter((x): x is string => !!x)
  const lines = [`#### 〈${oneLine(p.title)}〉`, '', `- ${head.join('｜')}`]
  const desc = truncate(p.description, 400)
  if (desc && desc !== oneLine(p.title)) lines.push(`- 說明：${desc}`)
  // 三要素（#364）：沒有那一列＝未調查、有而 stated=false＝未說明，兩者不混用（lib/policy-elements.ts）
  const cells = elementCells(p.elements).map((c) => {
    if (c.state === 'unchecked') return `${c.label}：未調查`
    if (c.state === 'not_stated') return `${c.label}：未說明`
    return `${c.label}：${oneLine(c.text)}${c.deadlineDate ? `（${c.deadlineDate}）` : ''}`
  })
  lines.push(`- 三要素：${cells.join('｜')}`)
  const sources = p.sources?.length ? p.sources : primarySource(p) ? [{ url: primarySource(p) as string, role: 'primary' as const }] : []
  if (sources.length === 0) lines.push(`- 出處：${NO_SOURCE}`)
  else sources.forEach((s, i) => lines.push(`- ${i === 0 ? '出處' : '佐證'}：${sourceText(s)}`))
  lines.push(`- 正見網址：${abs(`/policy/${p.id}`)}`)
  return lines
}

/** 人物的 Markdown 內容；Worker 讀時產生（人物一萬六千位，不預產，維護者 10-07） */
export function buildPoliticianPage(input: PoliticianMdInput): MdPage {
  const { politician: pl, elections, today } = input
  const policies = input.policies
  const titles = officeTitles(pl.offices)
  const recs = [...(pl.elections ?? [])].sort(newerFirst)
  const bits = [pl.party || null, titles.length > 0 ? titles.join('、') : null].filter((x): x is string => !!x)
  const title = `${pl.name}${bits.length > 0 ? `（${bits.join('，')}）` : ''}的政見與參選紀錄`

  const body: string[] = ['## 基本資料', '']
  body.push(`- 姓名：${pl.name}`)
  if (pl.party) body.push(`- 政黨：${pl.party}`)
  if (titles.length > 0) body.push(`- 現任公職：${titles.join('、')}`)
  if (pl.birthYear) body.push(`- 出生年：${pl.birthYear}`)
  if (pl.educationLevel) body.push(`- 最高學歷：${pl.educationLevel}`)
  if (pl.bio) body.push(`- 簡介：${truncate(pl.bio, BIO_MAX)}`)
  body.push(`- 網頁：${politicianUrl(pl.id)}`)
  if (pl.education?.length) body.push('', '學歷：', ...pl.education.map((x) => `- ${oneLine(x)}`))
  if (pl.experience?.length) body.push('', '經歷：', ...pl.experience.map((x) => `- ${oneLine(x)}`))

  body.push('', '## 參選紀錄', '')
  if (recs.length === 0) body.push('- 資料庫目前沒有收錄參選紀錄')
  else for (const r of recs) body.push(participationLine(r, elections, today))

  body.push('', `## 政見（${policies.length} 筆）`, '')
  if (policies.length === 0) {
    body.push('資料庫目前沒有收錄這位人物的政見。')
  } else {
    // 依屆別分組：投票日新的在前；沒有屆別的放最後
    const byElection = new Map<number | null, Policy[]>()
    for (const p of policies) {
      const k = p.electionId ?? null
      byElection.set(k, [...(byElection.get(k) ?? []), p])
    }
    const dateOf = (id: number | null) => (id === null ? '' : elections.find((e) => e.id === id)?.electionDate ?? '')
    const keys = [...byElection.keys()].sort((a, b) => {
      if (a === null) return 1
      if (b === null) return -1
      return dateOf(b).localeCompare(dateOf(a)) || b - a
    })
    for (const k of keys) {
      const list = (byElection.get(k) ?? []).sort(comparePolicies)
      body.push(`### ${k === null ? '未標屆別' : electionName(elections, k)}（${list.length} 筆）`, '')
      for (const p of list) body.push(...policyBlock(p), '')
    }
  }

  return {
    title,
    htmlPath: `/politician/${pl.id}`,
    dataAsOf: latestTime(policies.map((p) => p.updatedAt ?? p.lastUpdated)),
    scope: `人物；參選紀錄 ${recs.length} 筆、政見 ${policies.length} 筆`,
    preface: [],
    body,
    rowCount: policies.length,
  }
}

export function renderPoliticianMd(input: PoliticianMdInput): string {
  return renderPage(buildPoliticianPage(input), politicianMdPath(input.politician.id), input.generatedAt)
}

