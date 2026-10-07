import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useHead } from '@unhead/vue'
import { useRoute } from 'vue-router'

import { SITE_NAME, SITE_URL, policyStatusLabel } from '../lib/site'

// 站名、網址、政見狀態標籤放在 lib/site.ts（純常數，Markdown 檢視 lib/md 也要用；單一份）
export { SITE_NAME, SITE_URL, policyStatusLabel }
export const SITE_TAGLINE = '智能政見追蹤平台'
export const DEFAULT_DESCRIPTION =
  '正見是超越黨派色彩的政策歷史追蹤平台，記錄全台政治人物政見的提出與執行進度，並以 AI 進行客觀分析。'

interface PageHeadOptions {
  /** 頁面標題（不含站名，會自動補「| 正見」）。給 undefined 時退回站名。 */
  title: MaybeRefOrGetter<string | undefined>
  description?: MaybeRefOrGetter<string | undefined>
  /** 工具頁／後台：不讓搜尋引擎索引。內容頁可給 getter，資料確定不存在時翻成 true（避免 soft 404 被收錄）。 */
  noindex?: MaybeRefOrGetter<boolean | undefined>
  /** og:type，內容頁用 article，其餘 website。 */
  type?: 'website' | 'article'
  /** schema.org 結構化資料（JSON-LD）。搜尋引擎與 AI 讀得懂「這是誰的政見、出處在哪、由誰驗證、怎麼引用」。 */
  jsonLd?: MaybeRefOrGetter<Record<string, unknown> | undefined>
  /** 麵包屑（2026-09-30）：輸出 schema.org BreadcrumbList；畫面上的麵包屑用 components/Breadcrumbs.vue */
  breadcrumbs?: MaybeRefOrGetter<BreadcrumbItem[] | undefined>
  /**
   * 這一頁有 Markdown 版（本頁網址加 .md，docs/PLAN-markdown-views.md）：輸出 <link rel="alternate" type="text/markdown">。
   * 只有人物頁與縣市頁有；資料還沒到、確定沒資料時給 false，免得指向一份 404。
   */
  markdown?: MaybeRefOrGetter<boolean | undefined>
}

/** 麵包屑 → schema.org BreadcrumbList（最後一層沒給 path 就用本頁網址） */
export function breadcrumbJsonLd(items: BreadcrumbItem[], pageUrl: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.path ? `${SITE_URL}${canonicalPath(item.path)}` : pageUrl,
    })),
  }
}

/** 資料授權（LICENSE-DATA.md）：CC BY 4.0，引用要標出處——這也是 AI 轉述時要帶上「正見」的依據 */
export const DATA_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/'

/** 結構化資料裡的「發布者」：每一筆政見、每一位人物都掛這個，AI 轉述時才知道是誰驗證的 */
export const PUBLISHER_LD = {
  '@type': 'Organization',
  name: SITE_NAME,
  alternateName: ['正見 Policy Tracker', 'policy-tw'],
  url: SITE_URL,
  sameAs: ['https://policy-tw.web.app', 'https://github.com/Yooliang/policy-tw'],
} as const

/** JSON-LD 放進 <script> 前要擋 `</script>` 截斷：把 `<` 換成 <（JSON 仍然合法） */
export function jsonLdText(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c')
}

/**
 * 引用字串：「〈標題〉，某某的政見。正見，網址（資料更新 日期）」。畫面上的「引用這筆資料」與 llms.txt 講的是同一個格式，
 * AI 轉述時照抄就帶上出處（資料是 CC BY 4.0，本來就要標）。
 */
export function citationText(opts: { title: string; who?: string; url: string; updated?: string | null }): string {
  const who = opts.who ? `，${opts.who}的政見` : ''
  const updated = opts.updated ? `（資料更新：${opts.updated.slice(0, 10)}）` : ''
  return `〈${opts.title}〉${who}。資料來源：${SITE_NAME}（正見.tw）${opts.url}${updated}`
}

/** 把多行文字壓成一行、截到 meta description 合理長度。 */
export function summarize(text: string | undefined | null, max = 150): string {
  if (!text) return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** 路由 path → canonical 用的路徑：去尾斜線、非 ASCII 字元 percent-encode（已編碼的不重複編碼） */
export function canonicalPath(path: string): string {
  if (path === '/' || path === '') return '/'
  let decoded = path
  try { decoded = decodeURI(path) } catch { /* 原樣 */ }
  return encodeURI(decoded).replace(/\/$/, '')
}

export interface BreadcrumbItem {
  /** 顯示文字 */
  name: string
  /** 站內路徑；最後一層（本頁）可以不給 */
  path?: string
}

/** 每頁統一的 <title>／description／robots／Open Graph。輸入可為 ref／getter，資料到位後會自動更新。 */
export function usePageHead(options: PageHeadOptions): void {
  const title = computed(() => {
    const t = toValue(options.title)
    return t ? `${t} | ${SITE_NAME}` : `${SITE_NAME} | ${SITE_TAGLINE}`
  })
  const description = computed(() => summarize(toValue(options.description)) || DEFAULT_DESCRIPTION)
  // 每頁自己的 canonical／og:url（2026-09-23）：以前只有 index.html 寫死的首頁 og:url，每一頁分享出去都指首頁。
  // 用路由的 path（不含 query）：選舉頁的 ?region= 那些篩選不該各自成一個 canonical。
  const route = useRoute()
  // 中文路徑（縣市頁 /election/2026/台北市）一律寫成 percent-encoded：預渲染時 route.path 是原字、瀏覽器裡是編碼過的，兩邊要一致
  const pageUrl = computed(() => `${SITE_URL}${canonicalPath(route.path)}`)

  useHead({
    title,
    link: computed(() => [
      { rel: 'canonical', href: pageUrl.value },
      ...(toValue(options.markdown) ? [{ rel: 'alternate', type: 'text/markdown', href: `${pageUrl.value}.md` }] : []),
    ]),
    meta: computed(() => [
      { name: 'description', content: description.value },
      { property: 'og:site_name', content: SITE_NAME },
      { property: 'og:type', content: options.type ?? 'website' },
      { property: 'og:title', content: title.value },
      { property: 'og:description', content: description.value },
      { property: 'og:url', content: pageUrl.value },
      ...(toValue(options.noindex) ? [{ name: 'robots', content: 'noindex' }] : []),
    ]),
    script: computed(() => {
      const ld = toValue(options.jsonLd)
      const crumbs = toValue(options.breadcrumbs)
      return [
        ...(ld ? [{ key: 'page-jsonld', type: 'application/ld+json', innerHTML: jsonLdText(ld) }] : []),
        ...(crumbs && crumbs.length > 1 ? [{ key: 'breadcrumb-jsonld', type: 'application/ld+json', innerHTML: jsonLdText(breadcrumbJsonLd(crumbs, pageUrl.value)) }] : []),
      ]
    }),
  })
}

