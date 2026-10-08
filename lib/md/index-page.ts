/**
 * `/data/<屆>/index.md`（全站概況＋入口清單）與「認不出來」的 404 Markdown（計畫 5、9.1）。
 * 清單部分是靜態的（22 縣市、19 分類固定），所以 404 不必查資料庫：給 AI 讀的，寫得機械、完整。
 * 清單裡的網址是最新一屆的短網址（/data/<縣市>.md、/category/<分類>.md），不必知道屆別。
 */
import { TAIWAN_COUNTIES } from '../election-regions'
import { CATEGORIES, CATEGORY_SYNONYMS } from '../data-query'
import { SITE_URL } from '../site'
import { abs, dataIndexJsonPath, dataIndexMdPath, electionYear, type MdPage } from './format'
import type { ListContext } from './lists'
import type { Matrix } from './dataset'

const enc = encodeURIComponent

/** 入口清單（index 與 404 共用） */
export function listingLines(): string[] {
  const lines: string[] = ['## 縣市（最新一屆的候選人與競選承諾）', '']
  for (const r of TAIWAN_COUNTIES) lines.push(`- ${r}：${abs(`/data/${enc(r)}.md`)}`)
  lines.push('', '## 分類（全國，依縣市分組）', '')
  for (const c of CATEGORIES) {
    const words = CATEGORY_SYNONYMS[c] ?? []
    lines.push(`- ${c}：${abs(`/category/${enc(c)}.md`)}${words.length > 0 ? ` ｜ 查詢常見說法：${words.join('、')}` : ''}`)
  }
  lines.push('', '## 縣市×分類', '')
  lines.push(`- 路徑式：${SITE_URL}/data/<縣市>/<分類>.md （最新一屆；轉到 /data/<屆>/<縣市>/<分類>.md），例：${abs(`/data/${enc('台南市')}/${enc('交通建設')}.md`)}`)
  lines.push(`- 查詢式（轉到路徑式）：${SITE_URL}/data?q=台南 育兒`)
  return lines
}

export interface IndexInput {
  ctx: ListContext
  matrix: Matrix
  dataAsOf: string | null
}

export function buildIndexPage(input: IndexInput): MdPage {
  const { ctx, matrix } = input
  const year = electionYear(ctx.election)
  const seg = ctx.segment
  const body = [
    '## 概況', '',
    `- 最新一屆：${ctx.election.name}（投票日 ${ctx.election.electionDate}）`,
    `- 資料庫目前收錄的政見 ${ctx.policies.length} 筆；${year} 屆競選承諾 ${matrix.total} 筆（本索引的範圍）`,
    `- 機器可讀索引（JSON）：${abs(dataIndexJsonPath(seg))}`,
    `- 縣市×分類矩陣（網頁）：${abs(`/election/${seg}/matrix`)}`,
    '',
    ...listingLines(),
  ]
  return {
    title: `${year} 競選承諾資料索引`,
    htmlPath: null,
    dataAsOf: input.dataAsOf,
    scope: `${year} 屆（${ctx.election.name}）競選承諾；22 縣市、19 分類；${matrix.total} 筆`,
    preface: [`本頁網址 ${abs(dataIndexMdPath(seg))} ；全部檔案與筆數見 ${abs(dataIndexJsonPath(seg))} 。`],
    body,
    rowCount: matrix.total,
  }
}

/** 認不出來時的 404 內容：說沒認出什麼，再把能用的全部列出來 */
export function buildNotFoundPage(what: string): MdPage {
  return {
    title: '沒有這一頁',
    htmlPath: null,
    dataAsOf: null,
    scope: '404；下面列出可以用的縣市與分類',
    preface: [],
    body: [`沒認出來：${what}`, '', ...listingLines()],
    rowCount: 0,
  }
}
