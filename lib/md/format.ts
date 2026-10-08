/**
 * Markdown 檢視的共用組字（docs/PLAN-markdown-views.md，2026-10-07）。
 *
 * 純函式、不碰 Worker／Supabase／Vue：人物（politician.ts）、縣市（region.ts）、分類與縣市×分類／主題（lists.ts）、索引（index-page.ts）
 * 都只呼叫這裡，所以固定中繼資料、政見一行的寫法、排序、網址只有一份。
 *
 * 原則（沿用主線守則「讓資料自己說話」）：只列事實、標籤（未說明／未調查／結果待補…）與出處，不評價、不排名，
 * 也不在內文講排序方式或方法論。例外只有一句：縣市×主題是關鍵字比對、尚未逐筆確認，那是資料本身的狀態，必須明講。
 */
import { SITE_URL, policyStatusLabel } from '../site'
import { compareRegionName } from '../region-name'
import type { Election, Policy, SourceRef } from '../../types'

export const FORMAT_VERSION = 1
export const LICENSE = 'CC BY 4.0'
export const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/'
/** 每份 .md 固定的 notice 欄 */
export const NOTICE = '收錄不代表認同，以中選會選舉公報為準'
/** 每份 .md 開頭固定的一行聲明（維護者 10-07 裁示：原始出處的權利歸原發布者） */
export const STATEMENT = '資料依 CC BY 4.0 授權，引用請標明「正見（正見.tw）」；原始出處的權利歸原發布者。'

/** 沒有出處的政見怎麼寫（不省略，CLAUDE.md「讓資料自己說話」：保留標籤與出處） */
export const NO_SOURCE = '出處待補'

// ───────────────────────── 網址 ─────────────────────────

const enc = encodeURIComponent

/** 人物 Markdown 的站內路徑 */
export const politicianMdPath = (id: string) => `/politician/${id}.md`
/** 縣市（某屆）Markdown 的站內路徑；segment 是選舉網址那一段（lib/election-route.ts 的 electionSegment） */
export const regionMdPath = (segment: string, region: string) => `/election/${segment}/${enc(region)}.md`
export const categoryMdPath = (category: string) => `/category/${enc(category)}.md`
/** 某一屆（網址那一段 segment）：縣市（全部分類）、分類（全部縣市）、縣市×分類；索引的 .md 與 .json */
export const dataRegionMdPath = (segment: string, region: string) => `/data/${segment}/${enc(region)}.md`
export const dataCategoryMdPath = (segment: string, category: string) => `/data/${segment}/${enc(category)}.md`
export const dataRegionCategoryMdPath = (segment: string, region: string, category: string) => `/data/${segment}/${enc(region)}/${enc(category)}.md`
export const dataIndexMdPath = (segment: string) => `/data/${segment}/index.md`
export const dataIndexJsonPath = (segment: string) => `/data/${segment}/index.json`
/** 最新一屆的短網址（轉到上面那些）：/data/<縣市>.md、/data/<縣市>/<分類>.md、/data/index.md */
export const DATA_INDEX_PATH = '/data/index.md'

/** 站內路徑 → 完整網址。路徑可以是解碼後的（含中文）：還沒編碼過才逐段 percent-encode（已經有 %XX 的原樣） */
export const encodePath = (path: string) => (/%[0-9A-Fa-f]{2}/.test(path) ? path : path.split('/').map(encodeURIComponent).join('/'))
export const abs = (path: string) => `${SITE_URL}${encodePath(path)}`
export const policyUrl = (id: string) => abs(`/policy/${id}`)
export const politicianUrl = (id: string) => abs(`/politician/${id}`)

// ───────────────────────── 時間 ─────────────────────────

const TAIPEI_MS = 8 * 3600 * 1000

/** epoch ms → 台北時間的 ISO 字串（+08:00，到秒） */
export function taipeiIso(ms: number): string {
  return `${new Date(ms + TAIPEI_MS).toISOString().replace(/\.\d+Z$/, '')}+08:00`
}

/** 時間字串（timestamptz 或 YYYY-MM-DD）→ 台北日期 YYYY-MM-DD；認不得回 null。純日期原樣回（不再換時區） */
export function taipeiDate(value: string | null | undefined): string | null {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? null : taipeiIso(t).slice(0, 10)
}

/** 一批時間字串裡最新的那個（ISO 字串，台北時間）；都沒有回 null。給 front matter 的 data_as_of */
export function latestTime(values: ReadonlyArray<string | null | undefined>): string | null {
  let best = -Infinity
  for (const v of values) {
    if (!v) continue
    const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00+08:00`).getTime() : new Date(v).getTime()
    if (!Number.isNaN(t) && t > best) best = t
  }
  return Number.isFinite(best) ? taipeiIso(best) : null
}

// ───────────────────────── 文字 ─────────────────────────

/** 壓成一行（換行、連續空白變一個空白） */
export function oneLine(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim()
}

/** 壓成一行並截斷；超過加「…」。照字（code point）算，不會把罕用字切成亂碼 */
export function truncate(s: string | null | undefined, max: number): string {
  const t = oneLine(s)
  const chars = Array.from(t)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : t
}

/** YAML 純量：安全字元直接寫，其餘用 JSON 字串（JSON 的雙引號字串是合法的 YAML） */
export function yamlScalar(v: string | number | null): string {
  if (v === null) return 'null'
  if (typeof v === 'number') return String(v)
  return /^[A-Za-z0-9][A-Za-z0-9_\-./:%+~=?&@#]*$/.test(v) && !v.includes(': ') && !v.includes(' #') ? v : JSON.stringify(v)
}

// ───────────────────────── 固定中繼資料與整份文件 ─────────────────────────

export interface MdMeta {
  /** 標題（也是本文的 H1） */
  title: string
  /** 這份 .md 的站內路徑（含 .md；解碼後或已 percent-encode 都可以，輸出一律編碼） */
  path: string
  /** 對應的 HTML 頁站內路徑；沒有對應網頁的（分類、縣市×分類／主題、索引）給 null */
  htmlPath: string | null
  /** 這份 .md 產生的時間（epoch ms） */
  generatedAt: number
  /** 收錄的資料裡最新一筆變動（取 policies.updated_at 的最大值，ISO）；沒有資料給 null */
  dataAsOf: string | null
  /** 範圍一句話：哪一屆、哪些職位、幾位、幾筆 */
  scope: string
}

/**
 * 每份 .md 開頭固定的中繼資料（YAML front matter，計畫 9.2）：欄位固定、不隨頁面種類增減，缺的填 null。
 * 欄位只增不改名、不刪；不相容的改動升 FORMAT_VERSION（穩定網址承諾）。
 */
export function frontMatter(m: MdMeta): string {
  const url = abs(m.path)
  const html = m.htmlPath ? abs(m.htmlPath) : null
  const asOf = taipeiDate(m.dataAsOf)
  // 引用格式沿用 llms.txt 與政見頁那一行：資料來源：正見（正見.tw）網址（資料更新：YYYY-MM-DD）
  const cite = `資料來源：正見（正見.tw）${html ?? url}${asOf ? ` （資料更新：${asOf}）` : ''}`
  const fields: Array<[string, string | number | null]> = [
    ['title', m.title],
    ['source', '正見.tw'],
    ['url', url],
    ['html_url', html],
    ['generated_at', taipeiIso(m.generatedAt)],
    ['data_as_of', m.dataAsOf],
    ['license', LICENSE],
    ['license_url', LICENSE_URL],
    ['cite', cite],
    ['scope', m.scope],
    ['notice', NOTICE],
    ['format_version', FORMAT_VERSION],
  ]
  return `---\n${fields.map(([k, v]) => `${k}: ${yamlScalar(v)}`).join('\n')}\n---`
}

/** 整份文件：front matter → H1 → 一行聲明 → 本文（行陣列，空行自己放）。結尾保證一個換行 */
export function renderDocument(meta: MdMeta, body: readonly string[], preface: readonly string[] = []): string {
  const parts = [frontMatter(meta), '', `# ${meta.title}`, '', `> ${STATEMENT}`]
  for (const line of preface) parts.push('', `> ${line}`)
  parts.push('', ...body)
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/**
 * 一份 .md 的「內容」（不含網址與產生時間）：預產快取（data_md_cache）存的就是這個，Worker 讀出來再用請求的網址與
 * 快取列的 generated_at 組成整份文件（renderPage）。這樣同一份內容可以用不同網址讀（主題的同義詞），產生時間也不必寫死在內文裡。
 */
export interface MdPage {
  title: string
  htmlPath: string | null
  dataAsOf: string | null
  scope: string
  /** 聲明那一行之後、本文之前的補充句（每句一個引用區塊），例：縣市×主題的「依關鍵字比對，尚未逐筆確認」 */
  preface: string[]
  body: string[]
  /** 這份裡有幾筆政見（矩陣的格子數字就是它） */
  rowCount: number
}

/** 內容 ＋ 這一次要用的網址與產生時間 → 整份 Markdown */
export function renderPage(page: MdPage, path: string, generatedAt: number): string {
  return renderDocument({
    title: page.title,
    path,
    htmlPath: page.htmlPath,
    generatedAt,
    dataAsOf: page.dataAsOf,
    scope: page.scope,
  }, page.body, page.preface)
}

// ───────────────────────── 排序 ─────────────────────────

/** 人物排序＝姓名筆畫（維護者 10-07 裁示）：跟網頁「姓名筆畫」同一個比較（lib/region-name.ts，先字數再筆畫），並列再依 id，輸出才穩定 */
export function compareByName(a: { name: string; id: string }, b: { name: string; id: string }): number {
  return compareRegionName(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** 同一個人的政見：提出日期新的在前，沒有日期的排後面，再依 id（輸出穩定） */
export function comparePolicies(a: Pick<Policy, 'id' | 'proposedDate'>, b: Pick<Policy, 'id' | 'proposedDate'>): number {
  const da = a.proposedDate ?? ''
  const db = b.proposedDate ?? ''
  if (da !== db) {
    if (!da) return 1
    if (!db) return -1
    return da < db ? 1 : -1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ───────────────────────── 選舉、政見 ─────────────────────────

/** 選舉的年份：看投票日，不從 id 推 */
export const electionYear = (e: Pick<Election, 'electionDate' | 'id'>): string => e.electionDate?.slice(0, 4) || String(e.id)

const SOURCE_LEVEL: Record<string, string> = { official: '官方', self: '本人', media: '媒體', other: '其他' }

/** 一個出處一行文字：網址（等級；標題；發布者；存檔網址） */
export function sourceText(s: SourceRef): string {
  const bits = [
    s.kind ? SOURCE_LEVEL[s.kind] ?? null : null,
    s.title ? oneLine(s.title) : null,
    s.publisher ? oneLine(s.publisher) : null,
    s.publishedDate ? taipeiDate(s.publishedDate) : null,
    s.archiveUrl ? `存檔 ${s.archiveUrl} ` : null,
  ].filter((x): x is string => !!x)
  return bits.length > 0 ? `${s.url} （${bits.join('；')}）` : s.url
}

/** 主要出處網址；沒有就 null */
export function primarySource(p: Pick<Policy, 'sourceUrl' | 'sources'>): string | null {
  return p.sourceUrl ?? p.sources?.find((s) => s.role === 'primary')?.url ?? p.sources?.[0]?.url ?? null
}

/** 政見的「最後更新」：updated_at（timestamptz）換成台北日期，快照沒帶才退回只有日期的 last_updated */
export function policyUpdated(p: Pick<Policy, 'updatedAt' | 'lastUpdated'>): string | null {
  return taipeiDate(p.updatedAt) ?? taipeiDate(p.lastUpdated)
}

/** 進度只在已經有執行狀態的政見才講：競選承諾的 0% 是預設值，不是「進度為零」，印出來會誤導 */
export function progressText(p: Pick<Policy, 'status' | 'progress'>): string | null {
  if (String(p.status) === 'Campaign Pledge') return null
  return typeof p.progress === 'number' ? `進度 ${p.progress}%` : null
}

export interface PolicyLineOptions {
  /** 說明截幾個字；0＝不印說明 */
  descMax: number
  /** 附在這筆政見後面的一小段（例：關鍵字比對到哪些詞） */
  note?: string
}

/**
 * 清單裡一筆政見：一個項目＋兩個子項（說明、出處與網址）。
 * 〈標題〉｜類別｜狀態｜進度｜提出日期｜最後更新
 */
export function policyBullet(p: Policy, opts: PolicyLineOptions): string[] {
  const head = [
    `〈${oneLine(p.title)}〉`,
    p.category || null,
    policyStatusLabel(String(p.status)) || null,
    progressText(p),
    p.proposedDate ? `提出 ${p.proposedDate}` : null,
    policyUpdated(p) ? `更新 ${policyUpdated(p)}` : null,
  ].filter((x): x is string => !!x)
  const lines = [`- ${head.join('｜')}`]
  const desc = opts.descMax > 0 ? truncate(p.description, opts.descMax) : ''
  if (desc && desc !== oneLine(p.title)) lines.push(`  - 說明：${desc}`)
  if (opts.note) lines.push(`  - ${opts.note}`)
  lines.push(`  - 出處：${primarySource(p) ?? NO_SOURCE} ｜ 正見：${policyUrl(p.id)}`)
  return lines
}

/** 「N 位」「N 筆」這類計數的小工具 */
export const people = (n: number) => `${n} 位`
export const items = (n: number) => `${n} 筆`
