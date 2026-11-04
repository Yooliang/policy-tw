/**
 * 政黨分流圖（/parties/flow，policy-ops#193）：中選會名冊 政黨 → 縣市 → 鄉鎮 的人數。純函式。
 *
 * 資料是資料庫 party_flow_counts() 回的分組列（鍵 p 政黨、c 縣市、t 鄉鎮、e 選舉別、n 人數），沒有姓名。
 * 規則：
 * - 政黨照名稱筆畫排（跟政黨一覽同一把尺），不依人數、不併「其他」；「無黨籍」不是政黨，排最後。
 * - 縣市照縣市選擇器順序（六都在前）；鄉鎮在縣市內照筆畫。
 * - 預設只畫政黨 → 縣市；點開某縣市才多一層鄉鎮。沒有鄉鎮的選舉（縣市長、縣市議員）只算到縣市。
 * - 篩選（選舉別、政黨）與展開的縣市都寫進網址。
 */
import { TAIWAN_COUNTIES } from './election-regions.ts'
import type { FlowGraph, FlowLink, FlowNode } from './model-flow.ts'

export interface PartyFlowRow { p: string; c: string; t: string; e: string; n: number }

export const NO_PARTY = '無黨籍'
/** 名冊裡有的七種選舉別，照層級由大到小（畫面上的篩選鈕順序） */
export const ELECTION_TYPES = ['縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長'] as const

const STROKE_ORDER = new Intl.Collator('zh-Hant-TW')

/** 「臺」「台」混寫一律用「台」 */
export const normalizeTai = (s: string): string => s.replaceAll('臺', '台')

/** 把資料庫回的 jsonb 整理成乾淨的列：型別不對、人數非正整數的丟掉 */
export function parseRows(raw: unknown): PartyFlowRow[] {
  if (!Array.isArray(raw)) return []
  const out: PartyFlowRow[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const { p, c, t, e, n } = r as Record<string, unknown>
    if (typeof p !== 'string' || typeof c !== 'string' || typeof e !== 'string') continue
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) continue
    out.push({ p: normalizeTai(p), c: normalizeTai(c), t: typeof t === 'string' ? normalizeTai(t) : '', e, n })
  }
  return out
}

export interface PartyFlowFilter {
  /** 空＝不篩（全部選舉別） */
  types: readonly string[]
  /** 空＝不篩（全部政黨） */
  parties: readonly string[]
}

export function filterRows(rows: readonly PartyFlowRow[], f: PartyFlowFilter): PartyFlowRow[] {
  const types = f.types.length ? new Set(f.types) : null
  const parties = f.parties.length ? new Set(f.parties) : null
  return rows.filter((r) => (!types || types.has(r.e)) && (!parties || parties.has(r.p)))
}

export const sumRows = (rows: readonly PartyFlowRow[]): number => rows.reduce((a, r) => a + r.n, 0)

/** 政黨清單：筆畫順序、無黨籍最後 */
export function partyOrder(rows: readonly PartyFlowRow[]): string[] {
  const set = new Set(rows.map((r) => r.p))
  const named = [...set].filter((p) => p !== NO_PARTY).sort((a, b) => STROKE_ORDER.compare(a, b))
  return set.has(NO_PARTY) ? [...named, NO_PARTY] : named
}

/** 縣市清單：縣市選擇器順序，名冊裡有但清單外的排後面（筆畫） */
export function countyOrder(rows: readonly PartyFlowRow[]): string[] {
  const set = new Set(rows.map((r) => r.c))
  const known = TAIWAN_COUNTIES.filter((c) => set.has(c))
  const extra = [...set].filter((c) => !TAIWAN_COUNTIES.includes(c)).sort((a, b) => STROKE_ORDER.compare(a, b))
  return [...known, ...extra]
}

export const partyId = (p: string) => `p:${p}`
export const countyId = (c: string) => `c:${c}`
export const townId = (c: string, t: string) => `t:${c}/${t}`

export interface PartyFlowGraph extends FlowGraph {
  /** 目前篩選後的總人數 */
  total: number
  /** 各層人數合計：政黨、縣市、已展開縣市底下的鄉鎮（只含有鄉鎮的選舉） */
  layerTotals: { party: number; county: number; town: number }
}

/**
 * 組桑基圖：政黨 → 縣市（→ 展開的縣市的鄉鎮）。
 * 節點與連線的順序＝畫面順序（圖表以輸入順序排列）；人數放在 raw，value 同 raw。
 */
export function buildPartyFlow(rows: readonly PartyFlowRow[], expanded: readonly string[] = []): PartyFlowGraph {
  const open = new Set(expanded)
  const parties = partyOrder(rows)
  const counties = countyOrder(rows)
  const pc = new Map<string, number>()
  const ct = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const k = `${r.p}\u0000${r.c}`
    pc.set(k, (pc.get(k) ?? 0) + r.n)
    if (open.has(r.c) && r.t) {
      const m = ct.get(r.c) ?? new Map<string, number>()
      m.set(r.t, (m.get(r.t) ?? 0) + r.n)
      ct.set(r.c, m)
    }
  }
  const nodes: FlowNode[] = []
  const links: FlowLink[] = []
  for (const p of parties) nodes.push({ id: partyId(p), label: p, tone: 'group' })
  for (const c of counties) nodes.push({ id: countyId(c), label: c, tone: 'neutral' })
  for (const p of parties) {
    for (const c of counties) {
      const n = pc.get(`${p}\u0000${c}`)
      if (n) links.push({ source: partyId(p), target: countyId(c), value: n, raw: n, tone: 'group' })
    }
  }
  let town = 0
  for (const c of counties) {
    const m = ct.get(c)
    if (!m) continue
    for (const t of [...m.keys()].sort((a, b) => STROKE_ORDER.compare(a, b))) {
      const n = m.get(t)!
      nodes.push({ id: townId(c, t), label: t, tone: 'group' })
      links.push({ source: countyId(c), target: townId(c, t), value: n, raw: n, tone: 'neutral' })
      town += n
    }
  }
  const total = sumRows(rows)
  return { nodes, links, paths: [], total, layerTotals: { party: total, county: total, town } }
}

/** 網址參數 ←→ 狀態。逗號分隔；不認得的值丟掉 */
export interface PartyFlowQuery { types: string[]; parties: string[]; open: string[] }

const list = (v: unknown): string[] => {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s.split(',').map((x) => normalizeTai(x.trim())).filter(Boolean) : []
}

export function parseQuery(q: Record<string, unknown>, known: { types?: readonly string[]; parties?: readonly string[]; counties?: readonly string[] } = {}): PartyFlowQuery {
  const keep = (xs: string[], ok?: readonly string[]) => [...new Set(ok ? xs.filter((x) => ok.includes(x)) : xs)]
  return { types: keep(list(q.type), known.types), parties: keep(list(q.party), known.parties), open: keep(list(q.open), known.counties) }
}

export function toQuery(s: { types: readonly string[]; parties: readonly string[]; open: readonly string[] }): Record<string, string> {
  const q: Record<string, string> = {}
  if (s.types.length) q.type = s.types.join(',')
  if (s.parties.length) q.party = s.parties.join(',')
  if (s.open.length) q.open = s.open.join(',')
  return q
}

/** 加入或移除（切換）一個值，保持原順序 */
export const toggle = (xs: readonly string[], x: string): string[] => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])
