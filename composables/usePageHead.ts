import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import { useHead } from '@unhead/vue'
import { useRoute } from 'vue-router'

export const SITE_NAME = '正見'
export const SITE_TAGLINE = '智能政見追蹤平台'
// 2026-09-22 換自有網域 正見.tw（punycode）；policy-tw.web.app 照常可用，但 canonical／og:url／sitemap 都指這裡
export const SITE_URL = 'https://xn--2lw665d.tw'
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
  const pageUrl = computed(() => `${SITE_URL}${route.path === '/' ? '/' : route.path.replace(/\/$/, '')}`)

  useHead({
    title,
    link: computed(() => [{ rel: 'canonical', href: pageUrl.value }]),
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
      return ld ? [{ key: 'page-jsonld', type: 'application/ld+json', innerHTML: jsonLdText(ld) }] : []
    }),
  })
}

const POLICY_STATUS_LABELS: Record<string, string> = {
  Proposed: '提出',
  'In Progress': '進行中',
  Achieved: '已實現',
  Stalled: '滯後',
  Failed: '未達成',
  'Campaign Pledge': '競選承諾',
}

/** 政見狀態的中文標籤（meta description 用；畫面上的 StatusBadge 另有自己的顯示邏輯）。 */
export function policyStatusLabel(status: string | undefined): string {
  return (status && POLICY_STATUS_LABELS[status]) || status || ''
}
