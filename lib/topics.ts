/**
 * 政見「主題」詞彙表（docs/PLAN-markdown-views.md 第 3 節，2026-10-07）。**單一份**：
 *   - 縣市×主題的 Markdown（`/data/<縣市>/<主題或同義詞>.md`，第三期關鍵字版）
 *   - 自由文字查詢（`/data?q=台南 育兒` → 302 到路徑式）
 *   - 第二期的候選挑選與派工（`policy_topic` 任務）
 *   - 守門測試（lib/topics.test.ts）
 * 都讀這一份，不抄兩份。
 *
 * 主題是固定詞彙，粒度比 `policies.category`（19 類）細、能用日常說法指名。一筆政見可有 0～2 個主題；
 * 0＝不屬於任何已定義主題，不強迫歸類。**關鍵字比對只能當「候選」**（實測育兒命中的前 8 筆有 1 筆不相干），
 * 不是答案；答案要走貢獻＋投票（第二期）。
 *
 * 這個檔刻意**沒有任何 import**：前端、Cloudflare Worker 的打包、Deno 測試與 Edge Function 都能直接讀。
 * 同義詞規則（守門測試擋）：每個至少兩個字；不得同時屬於兩個主題；不得等於任何主題名稱或分類名稱
 * （`/data/<縣市>/<名稱>.md` 的第二段要先認分類、再認主題，名稱不能歧義）。
 */

export interface Topic {
  /** 穩定識別（ASCII，不改名；第二期寫進資料庫的就是這個） */
  key: string
  /** 顯示名稱（主題全名）；改名時舊名要留作同義詞 */
  label: string
  /** 同義詞：日常說法，≥2 字，比對時「臺」＝「台」 */
  synonyms: string[]
  /** 主要落在的分類（19 類的正規值） */
  categories: string[]
}

export const TOPICS: Topic[] = [
  {
    key: 'childcare',
    label: '少子化與育兒',
    synonyms: ['育兒', '托育', '托嬰', '生育補助', '育兒津貼', '幼兒園', '準公共', '少子化', '生育', '保母', '育嬰', '嬰幼兒', '新生兒', '教保', '婚育'],
    categories: ['社會福利', '都市發展與住宅', '醫療衛生', '教育文化'],
  },
  {
    key: 'elderly',
    label: '長照與高齡',
    synonyms: ['長照', '長者', '敬老', '日照', '失智', '樂齡', '高齡', '老人', '銀髮', '長輩'],
    categories: ['社會福利', '醫療衛生'],
  },
  {
    key: 'school',
    label: '兒少與教育現場',
    synonyms: ['營養午餐', '課後照顧', '校園', '學童', '學校', '國小', '國中', '教師', '老師', '教育', '兒少', '學生'],
    categories: ['教育文化'],
  },
  {
    key: 'housing',
    label: '居住與社會住宅',
    synonyms: ['社宅', '社會住宅', '租屋', '租金補貼', '都更', '房價', '包租代管', '危老', '住宅', '居住正義', '都市更新'],
    categories: ['都市發展與住宅'],
  },
  {
    key: 'transit',
    label: '大眾運輸',
    synonyms: ['捷運', '輕軌', '公車', '轉運站', '票價', '大眾運輸', '公共運輸', '高鐵', '台鐵', '鐵路', '客運', '通勤'],
    categories: ['交通建設'],
  },
  {
    key: 'roads',
    label: '道路與停車',
    synonyms: ['停車', '道路', '號誌', '人行道', '橋梁', '交通安全', '塞車', '壅塞', '拓寬', '人本交通', '紅綠燈'],
    categories: ['交通建設'],
  },
  {
    key: 'health',
    label: '醫療與健康',
    synonyms: ['醫院', '急診', '健保', '心理健康', '醫療', '診所', '疫苗', '防疫', '健檢', '病床', '食安', '公衛'],
    categories: ['醫療衛生'],
  },
  {
    key: 'welfare',
    label: '弱勢與身障',
    synonyms: ['身障', '低收', '急難', '津貼', '身心障礙', '弱勢', '中低收入', '低收入戶', '社福'],
    categories: ['社會福利'],
  },
  {
    key: 'youthwork',
    label: '青年與就業',
    synonyms: ['青年創業', '薪資', '就業', '職訓', '青年', '勞工', '勞動', '工會', '失業', '創業', '基本工資', '職業訓練'],
    categories: ['青年與勞工', '經濟發展與產業'],
  },
  {
    key: 'industry',
    label: '產業與招商',
    synonyms: ['招商', '園區', '中小企業', '觀光', '商圈', '產業', '投資', '企業', '工業區', '半導體', '夜市'],
    categories: ['經濟發展與產業'],
  },
  {
    key: 'environment',
    label: '環境與淨零',
    synonyms: ['空污', '淨零', '減碳', '廢棄物', '綠能', '空氣品質', '污染', '回收', '垃圾', '再生能源', '太陽能', '碳排', '氣候', '生態', '節能'],
    categories: ['環境保護', '能源'],
  },
  {
    key: 'parks',
    label: '公園綠地與休閒',
    synonyms: ['公園', '綠地', '運動場', '共融遊戲場', '遊戲場', '體育', '運動', '球場', '休閒', '自行車道', '綠帶', '運動中心'],
    categories: ['體育休閒', '都市發展與住宅'],
  },
  {
    key: 'safety',
    label: '治安與防災',
    synonyms: ['詐騙', '毒品', '淹水', '防洪', '消防', '治安', '警察', '警政', '防災', '地震', '颱風', '滯洪', '水患', '監視器'],
    categories: ['治安消防與防災'],
  },
  {
    key: 'agri',
    label: '農漁與原民客家',
    synonyms: ['農民', '漁民', '原鄉', '客家', '農業', '漁業', '農地', '原住民', '部落', '畜牧', '農產', '新住民', '農會'],
    categories: ['農漁業', '原住民與族群'],
  },
  {
    key: 'admin',
    label: '行政與財政',
    synonyms: ['數位服務', '預算', '減稅', '稅制', '稅收', '廉政', '財政', '債務', '公務員', '行政效率', '開放資料', '智慧城市'],
    categories: ['行政革新與數位治理', '財政與稅務'],
  },
  {
    key: 'rights',
    // 計畫草案叫「性別與人權」，跟分類同名（守門測試擋），改稱「性平與司法」；草案名留作同義詞不需要（它就是分類名，路由先認分類）
    label: '性平與司法',
    synonyms: ['性平', '婚姻平權', '司法', '性別', '人權', '平權', '同婚', '轉型正義', '家暴', '性騷擾', '司法改革'],
    categories: ['性別與人權', '公平正義'],
  },
]

export const TOPIC_BY_KEY: ReadonlyMap<string, Topic> = new Map(TOPICS.map((t) => [t.key, t]))

/** 臺→台、全形→半形、去前後空白；比對與查詢一律先過這個 */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').replace(/臺/g, '台').trim()
}

/** 主題名稱（全名或同義詞）→ 主題；認不得回 undefined。`/data/<縣市>/<名稱>.md` 的第二段用 */
export function topicByName(name: string | null | undefined): Topic | undefined {
  const n = normalizeText(name)
  if (!n) return undefined
  return TOPICS.find((t) => normalizeText(t.label) === n || t.synonyms.some((s) => normalizeText(s) === n))
}

/**
 * 一筆政見的候選主題 key。**只是候選，不是結論。**
 * 規則：標題或說明裡出現主題的任何同義詞才算（只靠分類不算——社會福利整類都算「育兒」會把候選灌爆）；
 * 排序：標題命中的同義詞數×2＋說明命中的同義詞數＋（政見分類落在主題的對應分類時 +1.5），高的在前、同分照 TOPICS 順序。
 * 回傳全部命中的候選（不截斷）；第二期派工要「0～2 個」的呼叫端自己 `.slice(0, 2)`。
 */
export function topicCandidates(policy: { title?: string | null; description?: string | null; category?: string | null }): string[] {
  const title = normalizeText(policy.title)
  const description = normalizeText(policy.description)
  const category = normalizeText(policy.category)
  const scored: Array<{ key: string; score: number; order: number }> = []
  TOPICS.forEach((t, order) => {
    let hits = 0
    let score = 0
    for (const syn of t.synonyms) {
      const s = normalizeText(syn)
      const inTitle = title.includes(s)
      const inDesc = description.includes(s)
      if (inTitle) { hits++; score += 2 }
      if (inDesc) { hits++; score += 1 }
    }
    if (hits === 0) return
    if (category && t.categories.some((c) => normalizeText(c) === category)) score += 1.5
    scored.push({ key: t.key, score, order })
  })
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((x) => x.key)
}

/** 22 縣市（與 lib/election-regions.ts 的 TAIWAN_COUNTIES 同順序；topics.test.ts 盯兩邊一致） */
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

/** 最長優先掃描：每命中一個就把那一段蓋掉，短的別名不會在長的裡面重複命中。回命中的值（依出現順序、去重） */
function scan(text: string, aliases: Alias[]): string[] {
  let rest = text
  const found: Array<{ at: number; value: string }> = []
  const sorted = [...aliases].sort((a, b) => b.text.length - a.text.length)
  for (const a of sorted) {
    let from = 0
    for (;;) {
      const at = rest.indexOf(a.text, from)
      if (at < 0) break
      found.push({ at, value: a.value })
      rest = rest.slice(0, at) + '\u0000'.repeat(a.text.length) + rest.slice(at + a.text.length)
      from = at + a.text.length
    }
  }
  const seen = new Set<string>()
  return found.sort((x, y) => x.at - y.at).map((f) => f.value).filter((v) => !seen.has(v) && !!seen.add(v))
}

const REGION_SCAN_ALIASES: Alias[] = [
  ...REGIONS.map((r) => ({ text: r, value: r })),
  ...Object.entries(REGION_ALIASES).map(([text, value]) => ({ text, value })),
]

/** 查詢文字裡的縣市（全名＋簡稱，最長優先，依出現順序、去重）。多於一個＝使用者問不清楚 */
export function findRegions(text: string): string[] {
  return scan(normalizeText(text), REGION_SCAN_ALIASES)
}

/** 查詢文字裡的主題（全名＋同義詞，最長優先，依出現順序、去重），回主題 key */
export function findTopics(text: string): string[] {
  const aliases: Alias[] = []
  for (const t of TOPICS) {
    aliases.push({ text: normalizeText(t.label), value: t.key })
    for (const s of t.synonyms) aliases.push({ text: normalizeText(s), value: t.key })
  }
  return scan(normalizeText(text), aliases)
}

/**
 * 自由文字 → 縣市與主題（純規則、不靠 LLM）：「台南 育兒」→ { region: '台南市', topic: 'childcare' }。
 * 正規化（全形轉半形、臺→台、空白任意）→ 縣市最長比對 → 主題最長比對；剩下的字丟掉。
 * 縣市或主題有多個時，取文字裡最先出現的那一個（要判斷「問不清楚」的呼叫端用 findRegions／findTopics 看長度）。
 * `topic` 是主題 key（不是顯示名稱）；只寫分類名稱（例「交通建設」）的由路由那一層另外認，這裡不管。
 */
export function parseTopicQuery(text: string): { region?: string; topic?: string } {
  const out: { region?: string; topic?: string } = {}
  const region = findRegions(text)[0]
  if (region) out.region = region
  const topic = findTopics(text)[0]
  if (topic) out.topic = topic
  return out
}
