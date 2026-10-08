/**
 * SEO 呈現的純函式（#461）：社群分享圖、頁面摘要、結構化資料（JSON-LD）。
 *
 * 預渲染（vite-ssg）與邊緣渲染（Worker）跑的是同一份 Vue 元件，所以 head 的內容只要都從這裡組，兩條路徑就不會各說各話。
 * 沒有 Vue、沒有 DOM，Deno 測試直接讀（lib/seo.test.ts）。
 *
 * 摘要一律用資料組句（有幾位候選人、收了幾項政見、哪個狀態），不放固定的說明套話：
 * 套話每一頁都一樣，搜尋引擎會把它們當重複，讀的人也看不出差別。
 */
import { compareBallotNo } from './ballot-number'
import { DATA_LICENSE_URL, PUBLISHER_LD, SITE_NAME, SITE_URL } from './site'

/* ───────────────────────────── 社群分享圖 ───────────────────────────── */

/** 站內預設分享圖（public/brand/og-cover.png，1200×630）。沒有合適照片的頁面都用這張。 */
export const SHARE_IMAGE_PATH = '/brand/og-cover.png'
export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 } as const

export interface ShareImage {
  /** 絕對網址（https） */
  url: string
  /** 替代文字（純中文） */
  alt: string
  /**
   * twitter:card：預設的橫幅圖用 summary_large_image；人物照片多半是方形或直幅，
   * 拉成大圖會被裁到只剩額頭，用 summary（小圖在左、文字在右）。
   */
  card: 'summary' | 'summary_large_image'
  /** 只有已知尺寸的圖（站內預設圖）才給；其他圖不猜 */
  width?: number
  height?: number
}

export function defaultShareImage(siteUrl: string = SITE_URL): ShareImage {
  return {
    url: `${siteUrl}${SHARE_IMAGE_PATH}`,
    alt: `${SITE_NAME}：台灣政見追蹤平台`,
    card: 'summary_large_image',
    ...SHARE_IMAGE_SIZE,
  }
}

/** 簽名網址（會過期、離開網站就失效）常見的查詢參數名；有就不能當分享圖 */
const SIGNED_QUERY_KEYS = /^(token|sig|signature|expires|x-amz-signature|x-amz-security-token|x-goog-signature)$/i
/** 社群爬蟲收不下來的格式 */
const UNSUPPORTED_IMAGE_PATH = /\.(svg|pdf|html?)$/i

/**
 * 資料庫裡的圖片網址 → 能放進 og:image 的公開網址；不行就回 undefined。
 *
 * 「可公開」的判準（只看網址本身，不發請求）：
 *   - 只收 https（`//host/x` 補成 https；`/x` 當站內路徑補上站名網域）
 *   - 不帶帳密、不是 IP 位址、不是 localhost／內網主機名（單一標籤或 .local／.internal）
 *   - 不是簽名網址（Supabase 的 /object/sign/、查詢字串帶 token／signature／expires 這類）
 *   - 不是 svg／pdf／html（Facebook、LINE 都不收）
 * 輸出經 URL 正規化：路徑裡的中文與空白會被 percent-encode（原本就編碼過的不會重複編碼），去掉 #片段。
 */
export function publicImageUrl(raw: unknown, siteUrl: string = SITE_URL): string | undefined {
  if (typeof raw !== 'string') return undefined
  let s = raw.trim()
  if (!s || s.length > 2000) return undefined
  if (s.startsWith('//')) s = `https:${s}`
  else if (s.startsWith('/')) s = `${siteUrl}${s}`
  let u: URL
  try { u = new URL(s) } catch { return undefined }
  if (u.protocol !== 'https:') return undefined
  if (u.username || u.password) return undefined
  const host = u.hostname.toLowerCase()
  if (!host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return undefined
  if (/(^|\.)(localhost|local|internal|localdomain)$/.test(host)) return undefined
  if (/\/storage\/v1\/object\/sign\//.test(u.pathname)) return undefined
  for (const key of u.searchParams.keys()) if (SIGNED_QUERY_KEYS.test(key)) return undefined
  if (UNSUPPORTED_IMAGE_PATH.test(u.pathname)) return undefined
  u.hash = ''
  return u.href
}

/** 人物的分享圖：照片是公開網址就用照片，否則站內預設圖 */
export function personShareImage(avatarUrl: unknown, name: string | undefined, siteUrl: string = SITE_URL): ShareImage {
  const url = publicImageUrl(avatarUrl, siteUrl)
  if (!url) return defaultShareImage(siteUrl)
  return { url, alt: name ? `${name}的照片` : '候選人照片', card: 'summary' }
}

// type 別名而不是 interface：unhead 的 meta 型別帶 data-* 索引簽名，interface 沒有隱含索引簽名會對不上
export type MetaTag = { property?: string; name?: string; content: string }

/** 分享圖 → <meta> 清單：og:image、og:image:alt（、尺寸）、twitter:card、twitter:image、twitter:image:alt */
export function shareImageMeta(image: ShareImage): MetaTag[] {
  return [
    { property: 'og:image', content: image.url },
    { property: 'og:image:alt', content: image.alt },
    ...(image.width && image.height
      ? [
          { property: 'og:image:width', content: String(image.width) },
          { property: 'og:image:height', content: String(image.height) },
        ]
      : []),
    { name: 'twitter:card', content: image.card },
    { name: 'twitter:image', content: image.url },
    { name: 'twitter:image:alt', content: image.alt },
  ]
}

/* ───────────────────────────── 摘要（meta description） ───────────────────────────── */

export interface LevelCount { label: string; n: number }

/** 「縣市長 8 位、縣市議員 120 位」；0 位的職位不列 */
export function levelCountsText(levels: readonly LevelCount[]): string {
  return levels.filter((l) => l.n > 0).map((l) => `${l.label} ${l.n} 位`).join('、')
}

export interface RegionDescriptionInput {
  /** 選舉年份（投票日的西元年） */
  year: number | string
  /** 地名：「台中市」「嘉義縣大林鎮」 */
  place: string
  /** 各職位的候選人數（只放這一頁畫得出來的職位） */
  levels: readonly LevelCount[]
  /** 這些候選人名下這一屆的政見數 */
  policyCount: number
  /** 首長職位的候選人姓名（縣市頁的縣市長）：好找「某某市長候選人」的人才放 */
  heads?: { label: string; names: readonly string[] }
  /** 補一句事實（例：區長由市政府指派，不是選舉產生） */
  note?: string
}

/** 首長候選人姓名最多列幾位；超過就不列（一串人名沒有資訊量，名單在頁面上） */
export const MAX_HEAD_NAMES = 8

/**
 * 縣市頁、鄉鎮頁的摘要：
 *   一個職位：「2026 台中市縣市議員候選人 120 位，已收錄政見 35 項。」
 *   多個職位：「2026 台中市候選人 128 位：縣市長 8 位、縣市議員 120 位，已收錄政見 35 項。縣市長候選人：甲、乙。」
 *   沒有候選人：「2026 台中市：目前沒有候選人資料。」
 */
export function regionDescription(input: RegionDescriptionInput): string {
  const shown = input.levels.filter((l) => l.n > 0)
  const total = shown.reduce((sum, l) => sum + l.n, 0)
  const tail = [headNamesText(input.heads), input.note].filter(Boolean).join('')
  if (total === 0) return `${input.year} ${input.place}：目前沒有候選人資料。${tail}`
  const policies = input.policyCount > 0 ? `已收錄政見 ${input.policyCount} 項` : '尚未收錄政見'
  const body = shown.length === 1
    ? `${input.year} ${input.place}${shown[0].label}候選人 ${total} 位，${policies}。`
    : `${input.year} ${input.place}候選人 ${total} 位：${levelCountsText(shown)}，${policies}。`
  return `${body}${tail}`
}

function headNamesText(heads: RegionDescriptionInput['heads']): string {
  if (!heads || heads.names.length === 0 || heads.names.length > MAX_HEAD_NAMES) return ''
  return `${heads.label}候選人：${heads.names.join('、')}。`
}

export interface PolicyDescriptionInput {
  title: string
  /** 政見本文 */
  body?: string
  /** 提出者 */
  personName?: string
  party?: string
  /** 屆別簡稱：「2026 九合一」 */
  electionLabel?: string
  category?: string
  /** 競選承諾（還沒當選前提出的）；其餘是施政或任內政見 */
  isPledge: boolean
  /** 狀態中文標籤；競選承諾的狀態就是「競選承諾」，不重複寫 */
  statusLabel?: string
  progress?: number
}

/** 兩段文字拿掉空白與標點後比較用 */
function squashed(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 政見本文去掉重複標題的開頭。本文就是標題（或只是標題加標點）整段不要；本文以標題開頭就切掉那一段。
 * 回傳壓成一行的文字，沒有可用內容回空字串。
 */
export function policyBodyForSummary(title: string, body: string | undefined): string {
  const one = (body ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return ''
  if (squashed(one) === squashed(title)) return ''
  if (one.startsWith(title)) {
    const rest = one.slice(title.length).replace(/^[\s:：,，.。;；、\-—]+/, '')
    return squashed(rest) ? rest : ''
  }
  return one
}

/**
 * 政見頁的摘要：「王小明（民進黨）競選承諾「增設托嬰中心」，類別：社會福利，2026 九合一。<本文>」。
 * 競選承諾沒有進度可說，不寫「進度 0%」；其餘寫狀態與進度。
 */
export function policyDescription(input: PolicyDescriptionInput): string {
  const who = input.personName ? `${input.personName}${input.party ? `（${input.party}）` : ''}` : ''
  const lead = `${who}${input.isPledge ? '競選承諾' : '政見'}「${input.title}」`
  // 進度 0% 沒有資訊量（還沒開始就是 0），只在有進度時寫
  const progress = !input.isPledge && input.statusLabel
    ? `${input.statusLabel}${input.progress && input.progress > 0 ? `，進度 ${input.progress}%` : ''}`
    : ''
  const facts = [
    input.category ? `類別：${input.category}` : '',
    input.electionLabel ?? '',
    progress,
  ].filter(Boolean)
  const head = `${[lead, ...facts].join('，')}。`
  const body = policyBodyForSummary(input.title, input.body)
  return body ? `${head}${body}` : head
}

/**
 * 人物頁摘要最後一句：「正見已收錄其競選承諾 3 項、過往政績 2 項。」
 * 兩種都沒有就不寫（以前寫「追蹤其競選承諾 0 項、過往政績 0 項」，一萬多位候選人的摘要結尾都一樣）。
 */
export function personTrackingText(pledges: number, history: number): string {
  const parts = [pledges > 0 ? `競選承諾 ${pledges} 項` : '', history > 0 ? `過往政績 ${history} 項` : ''].filter(Boolean)
  return parts.length ? `正見已收錄其${parts.join('、')}。` : ''
}

/* ───────────────────────────── 結構化資料（schema.org JSON-LD） ───────────────────────────── */

/**
 * 日期 → schema.org 的 Date／DateTime 寫法（ISO 8601）。認不得的回 undefined，不把亂字串放進 JSON-LD。
 * 資料庫的 timestamptz 可能是「2026-10-08 12:34:56.123456+00」這種空白分隔的寫法，換成 T。
 */
export function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/.test(s)) return undefined
  // 時間後面的「+00」補成「+00:00」，JSON-LD 與 Date.parse 都認得（只動有時間的；純日期結尾的 -08 是日，不是時區）
  const fixed = s.includes('T') ? s.replace(/([+-]\d{2})$/, '$1:00') : s
  return Number.isNaN(Date.parse(fixed)) ? undefined : fixed
}

export interface ListedCandidate {
  id: string
  name: string
  /** 職位的先後（POSITIONS 的順序）；小的在前 */
  rank: number
  candNo?: number
}

/** ItemList 最多放幾位：縣市議員一個縣市上百位，整份放進去 JSON-LD 會比頁面還大；總數另外用 numberOfItems 講 */
export const MAX_LIST_ITEMS = 100

/** 縣市頁的候選人 → ItemList 的項目：職位在前，同職位依號次（沒有的排後面）、再依姓名，順序只由資料決定 */
export function candidateListItems(
  candidates: readonly ListedCandidate[],
  opts: { siteUrl?: string; cap?: number } = {},
): Array<{ name: string; url: string }> {
  const siteUrl = opts.siteUrl ?? SITE_URL
  return [...candidates]
    .sort((a, b) =>
      (a.rank - b.rank)
      || compareBallotNo(a.candNo, b.candNo)
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, opts.cap ?? MAX_LIST_ITEMS)
    .map((c) => ({ name: c.name, url: `${siteUrl}/politician/${c.id}` }))
}

/** schema.org ItemList（縣市頁的候選人清單）；total 是完整人數，items 可能被截斷 */
export function itemListLd(input: {
  name: string
  url: string
  items: ReadonlyArray<{ name: string; url: string }>
  total?: number
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: input.name,
    url: input.url,
    numberOfItems: input.total ?? input.items.length,
    itemListElement: input.items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      url: it.url,
    })),
  }
}

export interface PolicyLdInput {
  id: string
  title: string
  description?: string
  category?: string
  isPledge: boolean
  statusLabel?: string
  /** 提出日（YYYY-MM-DD）；多數政見沒有，沒有就不放 datePublished（不拿別的日期充數） */
  proposedDate?: string | null
  /** 內容最後變動時間（timestamptz）；lastUpdated 只有日期，updatedAt 沒有時退回 */
  updatedAt?: string | null
  lastUpdated?: string | null
  sourceUrl?: string
  /** 所屬選舉的投票年份 */
  electionYear?: string
  person: { id: string; name: string; party?: string }
}

/** 一句 150 字內的描述（JSON-LD 的 description 可以比 meta 長，但不放整篇） */
function clip(text: string | undefined, max: number): string | undefined {
  const one = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return undefined
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * 政見頁的 schema.org：CreativeWork。
 * 提出者同時放在 author（誰主張的）與 about（講的是誰），datePublished 只在有提出日時放，
 * dateModified 用政見的更新時間（資料庫觸發器維護，每筆都有）。
 */
export function policyLd(input: PolicyLdInput, siteUrl: string = SITE_URL): Record<string, unknown> {
  const person = {
    '@type': 'Person',
    name: input.person.name,
    url: `${siteUrl}/politician/${input.person.id}`,
    ...(input.person.party ? { affiliation: { '@type': 'Organization', name: input.person.party } } : {}),
  }
  const published = isoDate(input.proposedDate)
  const modified = isoDate(input.updatedAt) ?? isoDate(input.lastUpdated)
  const description = clip(input.description, 300)
  return {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    additionalType: input.isPledge ? '競選承諾' : '政見',
    name: input.title,
    headline: input.title,
    ...(description ? { description } : {}),
    url: `${siteUrl}/policy/${input.id}`,
    inLanguage: 'zh-TW',
    ...(input.category ? { genre: input.category } : {}),
    ...(input.statusLabel ? { creativeWorkStatus: input.statusLabel } : {}),
    ...(published ? { datePublished: published } : {}),
    ...(modified ? { dateModified: modified } : {}),
    author: person,
    about: person,
    ...(input.sourceUrl ? { citation: input.sourceUrl, isBasedOn: input.sourceUrl } : {}),
    ...(input.electionYear ? { temporalCoverage: input.electionYear } : {}),
    publisher: PUBLISHER_LD,
    license: DATA_LICENSE_URL,
    isAccessibleForFree: true,
  }
}
