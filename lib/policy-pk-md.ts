/**
 * 政見 PK「PK 詳情」的 Markdown（2026-10-20 維護者回報：標題寫「第01選舉區：並排比較 8 位」，詳情卻列出全縣市的議員）。
 *
 * 原本詳情開的是預產的「縣市全部分類」.md——預產只到縣市（含各層級），沒有選區版本，所以範圍比標題大。
 * 現在詳情由畫面上同一張比較表（CompareMatrix：標題的人數、表格的欄與格子都是它）現場組成，範圍與標題必然一致：
 * 只列表上這幾位、只列這一場選舉的政見。純函式，不碰網路。
 */
import type { Policy } from '../types'
import type { CompareMatrix, ComparePerson } from './policy-compare'
import { policyBullet, politicianUrl, renderPage, latestTime, oneLine, type MdPage } from './md/format'

export interface PkMdPerson extends ComparePerson {
  party?: string
}

export interface PkMdInput<T extends PkMdPerson> {
  /** 範圍標題，例如「縣市議員・第01選舉區」（跟 PK 區塊標題同一個字串） */
  title: string
  /** 縣市名；全國的職位不給 */
  region?: string
  /** 屆別年份 */
  year: string | number
  electionName?: string
  matrix: CompareMatrix<T>
  /** 網頁版站內路徑，用於 front matter */
  htmlPath: string
}

export function buildPkMdPage<T extends PkMdPerson>(input: PkMdInput<T>): MdPage {
  const { matrix } = input
  const scopeName = `${input.region ? `${input.region} ` : ''}${input.title}`
  const body: string[] = ['## 概況', '']
  body.push(`- 範圍：${scopeName}（${input.year} 屆${input.electionName ? `・${input.electionName}` : ''}）`)
  body.push(`- 並排比較 ${matrix.columns.length} 位參選人、政見 ${matrix.policyCount} 筆`)

  const all: Policy[] = []
  matrix.columns.forEach((person, i) => {
    const mine = matrix.rows.flatMap((row) => row.cells[i] ?? [])
    all.push(...mine)
    body.push('', `## ${person.candNo ? `${person.candNo} 號 ` : ''}${oneLine(person.name)}${person.party ? `（${oneLine(person.party)}）` : ''}`, '')
    body.push(`- 人物頁：${politicianUrl(String(person.id))}`)
    if (mine.length === 0) { body.push('- 這一場選舉尚無政見資料'); return }
    body.push(`- 政見 ${mine.length} 筆：`)
    for (const row of matrix.rows) for (const p of row.cells[i] ?? []) body.push(...policyBullet(p, { descMax: 120 }).map((l) => `  ${l}`))
  })
  if (matrix.columns.length === 0) body.push('', '這一場沒有可並排的參選人。')

  return {
    title: `${scopeName} 政見 PK`,
    htmlPath: input.htmlPath,
    dataAsOf: latestTime(all.map((p) => p.updatedAt ?? p.lastUpdated)),
    scope: `${input.year} 屆 ${scopeName}；並排 ${matrix.columns.length} 位參選人、${matrix.policyCount} 筆政見`,
    preface: [],
    body,
    rowCount: matrix.policyCount,
  }
}

/** 整份 Markdown 原文（給 MdDrawer 的 text） */
export function renderPkMd<T extends PkMdPerson>(input: PkMdInput<T>, generatedAt: number): string {
  return renderPage(buildPkMdPage(input), input.htmlPath, generatedAt)
}
