import { Marked } from 'marked'
import { taipeiDate } from './format'

/**
 * 政見矩陣抽屜裡的 .md 預覽：Markdown → HTML，內容來自資料庫（政見標題、人物名稱都是代理交的），所以不信任。
 * 不另外引入 DOMPurify，改在 marked 的 renderer 上收緊（只產這幾種標籤，沒有任何一條路能放出使用者的原始 HTML）：
 *   - 原始 HTML（區塊與行內）一律當文字跳脫
 *   - 圖片不載入，只留替代文字
 *   - 連結只放 http／https／mailto 與站內相對路徑，其他協定（javascript: 等）只留連結文字；一律新分頁開
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 可以放進 href 的網址：http／https／mailto、站內相對路徑（/、#）；其他回 null */
export function safeHref(href: string | null | undefined): string | null {
  const h = (href ?? '').trim()
  // 控制字元與空白夾在協定中間可以繞過判斷（java\tscript:），先擋掉
  if (!h || /[\u0000-\u001f\u007f\s]/.test(h)) return null
  if (/^(https?:\/\/|mailto:)/i.test(h)) return h
  if (h.startsWith('/') && !h.startsWith('//')) return h
  if (h.startsWith('#')) return h
  return null
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text),
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens)
      const safe = safeHref(href)
      if (!safe) return inner
      const t = title ? ` title="${escapeHtml(title)}"` : ''
      return `<a href="${escapeHtml(safe)}"${t} target="_blank" rel="noopener noreferrer">${inner}</a>`
    },
  },
})

export interface MdPreview {
  /** 資料更新日（front matter 的 data_as_of，台北日期）；沒有就是 null */
  dataAsOf: string | null
  /** 本文轉好的 HTML（已收緊，可以直接 v-html） */
  html: string
}

/** 把 .md 開頭的 YAML front matter（--- 包起來）拆掉：回傳欄位表與本文；沒有 front matter 就整份當本文 */
export function splitFrontMatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if (value.startsWith('"')) {
      try { value = JSON.parse(value) as string } catch { /* 留原字串 */ }
    }
    fields[key] = value
  }
  return { fields, body: text.slice(m[0].length) }
}

/** 抽屜裡看的版本：front matter 不當正文（只取資料更新日）、開頭的 H1 拿掉（標題在抽屜頂端），其餘轉成 HTML */
export function renderMdPreview(text: string): MdPreview {
  const { fields, body } = splitFrontMatter(text)
  const asOf = fields.data_as_of && fields.data_as_of !== 'null' ? taipeiDate(fields.data_as_of) : null
  const withoutTitle = body.replace(/^\s*# [^\n]*\n/, '')
  return { dataAsOf: asOf, html: marked.parse(withoutTitle, { async: false }) as string }
}
