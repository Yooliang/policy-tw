/**
 * 議題頁的標籤過濾（2026-09-22）。
 * 政見的 tags 是代理／AI 抽取時自由填的，2026 屆 92 個相異標籤裡一堆不是議題：候選人名字、年份、「2026新北市長」、
 * 「中央社RSS」這種來源、「務實施政」「民生優先」這種口號。議題頁只該出現「講什麼事」的標籤。
 * 這裡是規則過濾（當天就能上）；把自由標籤正規化成固定詞彙是 Jev 的事，另案。
 */

/** 口號、立場、來源：不是議題 */
const STOP_TAGS = new Set([
  '民生優先', '務實施政', '行政經驗', '治理能力', '承擔責任', '實踐承諾', '穩定發展', '選戰策略', '選舉', '政見', '競選承諾',
  '其他', '未分類', '無', '待補',
])
const STOP_PATTERNS: RegExp[] = [
  /^\d{4}$/, // 年份
  /^\d{4}.*(市長|縣長|議員|立委|立法委員|總統|選舉|選戰)/, // 2026新北市長
  /(市長|縣長|議員|立委|總統)(候選人|選舉|選戰)?$/, // 桃園市長、高雄市長候選人
  /(RSS|rss|中央社|新聞|報導|媒體|來源|網站|官網|臉書|Facebook|粉專)/, // 來源、平台
  /^(台|臺)?(北|新北|桃園|台中|臺中|台南|臺南|高雄|基隆|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|連江)(市|縣)?$/, // 縣市名
]

export function isJunkTag(tag: string, politicianNames: ReadonlySet<string>): boolean {
  const t = tag.trim()
  if (t.length < 2) return true
  if (STOP_TAGS.has(t)) return true
  if (politicianNames.has(t)) return true
  return STOP_PATTERNS.some((re) => re.test(t))
}

/** 一筆政見在議題頁用的標籤：去掉垃圾；一個都不剩就退回它的類別（每筆政見都有類別，177／223 筆 2026 政見完全沒 tags） */
export function issueTagsOf(policy: { tags?: readonly string[] | null; category?: string | null }, politicianNames: ReadonlySet<string>): string[] {
  const kept = (policy.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0 && !isJunkTag(t, politicianNames))
  const uniq = Array.from(new Set(kept))
  if (uniq.length > 0) return uniq
  const cat = (policy.category ?? '').trim()
  return cat && cat !== '其他' ? [cat] : []
}
