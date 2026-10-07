/**
 * 文字查詢的解析：`/data?q=台南 育兒` → 縣市＋分類（docs/PLAN-markdown-views.md 第 5 節；維護者 2026-10-07 裁示：
 * 「主題」就用既有的分類 policies.category，不另建 16 個細主題，第二期取消）。
 *
 * 純規則、不靠即時 LLM：正規化（全形轉半形、臺→台、空白任意）→ 縣市最長比對（22 縣市全名＋簡稱）→ 分類比對（分類全名＋常見說法）。
 * 常見說法只給文字查詢用（網址路徑只認分類全名）：每個說法至少兩個字、只屬於一個分類、不等於任何分類全名（守門測試擋）。
 *
 * 這個檔刻意**沒有任何 import**：前端、Cloudflare Worker 的打包與 Deno 測試都能直接讀。
 */

/** 19 個分類全名（＝categories 表、supabase/functions/_shared/category-map.ts 的 POLICY_CATEGORIES；lib/data-query.test.ts 盯兩邊一致），順序＝網站分類順序 */
export const CATEGORIES: readonly string[] = [
  '交通建設', '都市發展與住宅', '社會福利', '醫療衛生', '教育文化', '經濟發展與產業', '農漁業',
  '環境保護', '能源', '治安消防與防災', '青年與勞工', '性別與人權', '原住民與族群', '體育休閒',
  '行政革新與數位治理', '財政與稅務', '公平正義', '政治議題', '其他',
]

/** 分類的常見說法（只給文字查詢用）：育兒／托育／長照 → 社會福利，捷運／公車 → 交通建設… */
export const CATEGORY_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  交通建設: ['交通', '捷運', '輕軌', '公車', '停車', '道路', '鐵路', '高鐵', '運輸'],
  都市發展與住宅: ['住宅', '社宅', '社會住宅', '租屋', '都更', '房價', '都市計畫', '居住'],
  社會福利: ['育兒', '托育', '托嬰', '長照', '福利', '津貼', '身障', '敬老', '長者', '老人', '少子化'],
  醫療衛生: ['醫療', '醫院', '健保', '防疫', '食安', '衛生', '急診'],
  教育文化: ['教育', '學校', '幼兒園', '文化', '藝術', '學童'],
  經濟發展與產業: ['經濟', '產業', '招商', '觀光', '商圈', '中小企業'],
  農漁業: ['農業', '漁業', '農民', '漁民'],
  環境保護: ['環保', '環境', '空污', '垃圾', '淨零', '減碳'],
  能源: ['電力', '綠能', '再生能源', '核能'],
  治安消防與防災: ['治安', '消防', '防災', '詐騙', '防洪', '淹水'],
  青年與勞工: ['青年', '勞工', '就業', '薪資', '創業'],
  性別與人權: ['性別', '人權', '性平', '平權'],
  原住民與族群: ['原住民', '客家', '新住民', '族群'],
  體育休閒: ['體育', '運動', '公園', '休閒'],
  行政革新與數位治理: ['行政', '數位', '廉政', '效能'],
  財政與稅務: ['財政', '稅制', '減稅', '預算'],
  公平正義: ['司法', '正義'],
  政治議題: ['選制', '兩岸', '國防', '外交'],
  其他: [],
}

/** 臺→台、全形→半形、去前後空白；比對與查詢一律先過這個 */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').replace(/臺/g, '台').trim()
}

/** 分類名稱（全名或常見說法）→ 分類全名；認不得回 undefined */
export function categoryByName(name: string | null | undefined): string | undefined {
  const n = normalizeText(name)
  if (!n) return undefined
  const full = CATEGORIES.find((c) => c === n)
  if (full) return full
  return CATEGORIES.find((c) => (CATEGORY_SYNONYMS[c] ?? []).some((s) => normalizeText(s) === n))
}

/** 22 縣市（與 lib/election-regions.ts 的 TAIWAN_COUNTIES 同順序；lib/data-query.test.ts 盯兩邊一致） */
export const REGIONS: readonly string[] = [
  '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
  '基隆市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義市',
  '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣',
]

/**
 * 縣市簡稱 → 縣市全名。「新竹」「嘉義」市縣都有、不猜，所以不在表裡（使用者要寫全名或「竹市」「嘉縣」）。
 * 全名本身另外算，不必列在這裡。
 */
export const REGION_ALIASES: Readonly<Record<string, string>> = {
  台北: '台北市', 北市: '台北市', 新北: '新北市', 桃園: '桃園市', 台中: '台中市', 台南: '台南市', 高雄: '高雄市',
  基隆: '基隆市', 竹市: '新竹市', 竹縣: '新竹縣', 苗栗: '苗栗縣', 彰化: '彰化縣', 南投: '南投縣', 雲林: '雲林縣',
  嘉市: '嘉義市', 嘉縣: '嘉義縣', 屏東: '屏東縣', 宜蘭: '宜蘭縣', 花蓮: '花蓮縣', 台東: '台東縣', 澎湖: '澎湖縣',
  金門: '金門縣', 連江: '連江縣', 馬祖: '連江縣',
}

/** 縣市名稱（全名、簡稱、「臺」寫法）→ 縣市全名（資料庫寫法）；認不得回 undefined */
export function regionByName(name: string | null | undefined): string | undefined {
  const n = normalizeText(name)
  if (!n) return undefined
  if (REGIONS.includes(n)) return n
  return REGION_ALIASES[n]
}

interface Alias { text: string; value: string }

/** 最長優先掃描：每命中一個就把那一段蓋掉，短的別名不會在長的裡面重複命中。回命中的別名（依出現順序；值相同的只留第一個） */
function scanMatches(text: string, aliases: Alias[]): Array<{ value: string; text: string }> {
  let rest = text
  const found: Array<{ at: number; value: string; text: string }> = []
  const sorted = [...aliases].sort((a, b) => b.text.length - a.text.length)
  for (const a of sorted) {
    let from = 0
    for (;;) {
      const at = rest.indexOf(a.text, from)
      if (at < 0) break
      found.push({ at, value: a.value, text: a.text })
      rest = rest.slice(0, at) + '\u0000'.repeat(a.text.length) + rest.slice(at + a.text.length)
      from = at + a.text.length
    }
  }
  const seen = new Set<string>()
  return found.sort((x, y) => x.at - y.at).filter((f) => !seen.has(f.value) && !!seen.add(f.value)).map(({ value, text }) => ({ value, text }))
}

const REGION_SCAN_ALIASES: Alias[] = [
  ...REGIONS.map((r) => ({ text: r, value: r })),
  ...Object.entries(REGION_ALIASES).map(([text, value]) => ({ text, value })),
]

const CATEGORY_SCAN_ALIASES: Alias[] = CATEGORIES.flatMap((c) => [
  { text: c, value: c },
  ...(CATEGORY_SYNONYMS[c] ?? []).map((s) => ({ text: normalizeText(s), value: c })),
])

/** 查詢文字裡的縣市（全名＋簡稱，最長優先，依出現順序、去重）。多於一個＝使用者問不清楚 */
export function findRegions(text: string): string[] {
  return scanMatches(normalizeText(text), REGION_SCAN_ALIASES).map((m) => m.value)
}

/** 查詢文字裡的分類（全名＋常見說法，最長優先，依出現順序、每個分類一筆）。多於一個＝問不清楚 */
export function findCategories(text: string): string[] {
  return scanMatches(normalizeText(text), CATEGORY_SCAN_ALIASES).map((m) => m.value)
}

/** 自由文字 → 縣市與分類：「台南 育兒」→ { region: '台南市', category: '社會福利' }；沒認出來的欄位不給。多個時取文字裡最先出現的 */
export function parseDataQuery(text: string): { region?: string; category?: string } {
  const out: { region?: string; category?: string } = {}
  const region = findRegions(text)[0]
  if (region) out.region = region
  const category = findCategories(text)[0]
  if (category) out.category = category
  return out
}
