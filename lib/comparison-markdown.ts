/**
 * 選舉頁「政見 PK」比較表的 Markdown 複製（全畫面模式的「複製 Markdown」按鈕）。
 *
 * 純函式：只吃已經整理好的純文字資料，不碰 Vue／Supabase。引用與授權的寫法沿用 lib/md/format.ts
 * （「資料來源：正見（正見.tw）網址 （資料更新：日期）」＋ CC BY 4.0 聲明），跟 .md 摘要一致。
 * 只並排、不排名：欄的順序由呼叫端照號次／筆畫排好，這裡不重排。
 */
import { LICENSE, LICENSE_URL, STATEMENT, taipeiDate } from './md/format.ts'

export interface ComparisonMdCandidate {
  /** 號次；沒有就不印 */
  candNo?: number | string | null
  name: string
  party?: string | null
}

export interface ComparisonMdRow {
  label: string
  /** 跟 candidates 同一個順序；格子內的換行會轉成 <br> */
  cells: ReadonlyArray<string | null | undefined>
}

export interface ComparisonMdInput {
  /** 例如「縣市長」「縣市議員・第08選舉區」 */
  title: string
  /** 選舉年份（投票日的年） */
  year: string | number
  /** 縣市（全國的職位可空） */
  region?: string | null
  /** 職位，例如「縣市長」；已經在 title 裡就不用另外給 */
  office?: string | null
  /** 這一頁的完整網址 */
  pageUrl: string
  /** 資料更新時間（YYYY-MM-DD 或 timestamptz）；沒有就不印 */
  dataDate?: string | null
  candidates: readonly ComparisonMdCandidate[]
  rows: readonly ComparisonMdRow[]
}

/** 表格儲存格：`|` 跳脫、換行變 <br>、空白變「—」 */
export function escapeCell(text: string | null | undefined): string {
  const t = (text ?? '')
    .trim()
    .replace(/\r\n?|\n/g, '<br>')
    .replace(/\|/g, '\\|')
  return t === '' ? '—' : t
}

function header(c: ComparisonMdCandidate): string {
  const no = c.candNo !== null && c.candNo !== undefined && String(c.candNo).trim() !== '' ? `${String(c.candNo).trim()}號 ` : ''
  const party = c.party && c.party.trim() ? `（${c.party.trim()}）` : ''
  return escapeCell(`${no}${c.name}${party}`)
}

export function comparisonMarkdown(input: ComparisonMdInput): string {
  const scope = [input.region, input.office].filter((s): s is string => !!s && !input.title.includes(s))
  const heading = `${input.year} 年${scope.length ? ` ${scope.join(' ')}` : ''} ${input.title}：政見並排比較`.replace(/\s+/g, ' ')
  const cols = ['類別', ...input.candidates.map(header)]
  const lines = [
    `# ${heading}`,
    '',
    `| ${cols.join(' | ')} |`,
    `| ${cols.map(() => '---').join(' | ')} |`,
  ]
  for (const row of input.rows) {
    const cells = input.candidates.map((_, i) => escapeCell(row.cells[i]))
    lines.push(`| ${[escapeCell(row.label), ...cells].join(' | ')} |`)
  }
  const asOf = taipeiDate(input.dataDate)
  lines.push(
    '',
    `資料來源：正見（正見.tw）${input.pageUrl}${asOf ? ` （資料更新：${asOf}）` : ''}`,
    '',
    `> ${STATEMENT}授權：[${LICENSE}](${LICENSE_URL})`,
  )
  return `${lines.join('\n')}\n`
}
