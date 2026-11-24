import { hostOf } from './url'

/**
 * 時間軸條目內文的純顯示層處理（資料庫內容不動）：
 * 長內文預設收合、依序號與換行分段、內文網址只顯示網域並可點擊。
 */

/** 內文（網址縮成網域之後）超過這個字數就預設收合；約等於 12px 字級下的 6 行 */
export const COLLAPSE_CHAR_THRESHOLD = 300

/** 條目內文超過門檻就該收合。字數以畫面上看到的字為準（網址只算網域） */
export function needsCollapse(text: string | null | undefined): boolean {
  if (!text) return false
  const visible = segmentText(text).map((s) => (s.type === 'link' ? s.label : s.text)).join('')
  return visible.length > COLLAPSE_CHAR_THRESHOLD
}

// 序號起頭：「一、」～「十、」、「1)」「1）」、「(1)」「（1）」
const MARKER = String.raw`(?:[一二三四五六七八九十]{1,3}、|\d{1,2}[)）]|[（(]\d{1,2}[)）])`
// 序號前面要是句末標點、冒號或右括號，才算新一段的開頭（避免把「共 2)」這類字串中間切開）
const BREAK_BEFORE_MARKER = new RegExp(String.raw`([。；;！？!?：:）)])(?=${MARKER})`, 'g')

/** 依原始換行與序號起頭分段；空段落丟掉、每段去頭尾空白 */
export function splitParagraphs(text: string | null | undefined): string[] {
  if (!text) return []
  return text
    .replace(/\r\n?/g, '\n')
    .replace(BREAK_BEFORE_MARKER, '$1\n')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

export type TextSegment =
  | { type: 'text'; text: string }
  | { type: 'link'; href: string; label: string }

const URL_RE = /https?:\/\/[^\s<>"'）)】」》\]。，、；：！？]+/g
const TRAILING_PUNCT = /[.,;:!?]+$/

/** 把一段文字切成純文字與網址；網址的顯示字是網域（去 www.），href 保留原址 */
export function segmentText(text: string | null | undefined): TextSegment[] {
  if (!text) return []
  const out: TextSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    const url = m[0].replace(TRAILING_PUNCT, '')
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) })
    out.push({ type: 'link', href: url, label: hostOf(url) })
    last = start + url.length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}
