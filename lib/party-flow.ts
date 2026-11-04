/**
 * 政黨分流圖（/parties/flow，policy-ops#193）：某一屆中選會名單的人數，依可開關、可排序的維度連成桑基圖。純函式。
 *
 * 資料是資料庫 party_flow_rows(p_election_id) 回的分組列（鍵 p 政黨、c 縣市、t 鄉鎮、e 選舉別、a 年齡組、g 性別、r 結果、n 人數），沒有姓名。
 * 規則：
 * - 維度：政黨、選舉類別、縣市、年齡、性別，該屆有結果的再加結果（當選／未當選）。預設只畫「政黨 → 縣市」，其他維度可開關、可排順序，至少留兩個。
 * - 鄉鎮不是維度：縣市開著時，點縣市才展開，鄉鎮接在縣市後面；沒有鄉鎮的選舉（縣市長、縣市議員、立委、總統）直接接下一個維度。
 * - 政黨照名稱筆畫排（跟政黨一覽同一把尺），不依人數、不併「其他」；「無黨籍」排最後。縣市照縣市選擇器順序（全國在最前）。
 * - 缺值（年齡、性別、結果沒有資料，或性別不是男女）一律標「未提供」，排在該維度最後，不會丟人。
 * - 每個節點 id 帶維度前綴（party:、county: …），同名跨維度不會混；不同縣市同名的鄉鎮是不同節點（town:縣市/鄉鎮）。
 * - 篩選（選屆、選舉別、政黨）、維度開關與順序、展開的縣市都寫進網址。
 */
import { TAIWAN_COUNTIES } from './election-regions.ts'
import type { DimDef, FlowGraph, FlowLink, FlowNode, Tone } from './model-flow.ts'
import { ageColorOf, categoricalColorAt, NEUTRAL, partyColorOf, type FlowColor } from './party-flow-colors.ts'

export interface PartyFlowRow {
  p: string
  c: string
  t: string
  e: string
  /** 年齡組：20、30…70（70＝70 歲以上）；沒有資料為 null */
  a: number | null
  /** 性別：只有「男」「女」，其餘為 null */
  g: string | null
  /** 結果：「當選」「未當選」；還沒投票或沒有資料為 null */
  r: string | null
  n: number
}

export const NO_PARTY = '無黨籍'
export const MISSING = '未提供'
/** 地方選舉名冊裡的七種選舉別，照層級由大到小 */
export const ELECTION_TYPES = ['縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長'] as const
/** 篩選鈕的完整順序（2024 的總統副總統、立法委員排最前） */
export const ALL_TYPES: readonly string[] = ['總統副總統', '立法委員', ...ELECTION_TYPES]

/** 沒指定選舉別時的預設篩選；該屆一個都沒有時視同全部。網址 type=all 才是明確全部 */
export const DEFAULT_TYPES: readonly string[] = ['縣市長', '縣市議員']
export const typesAreDefault = (xs: readonly string[]): boolean => xs.length === DEFAULT_TYPES.length && DEFAULT_TYPES.every((t) => xs.includes(t))

/** 可選的屆別（網址 election=）；2022 含 2022-12 重行選舉 */
export const ELECTIONS: readonly { id: number; label: string }[] = [
  { id: 2026, label: '2026' }, { id: 2024, label: '2024' }, { id: 2022, label: '2022' },
]
export const DEFAULT_ELECTION = 2026

export const FLOW_DIMS: readonly DimDef[] = [
  { id: 'party', label: '政黨' }, { id: 'type', label: '選舉類別' }, { id: 'county', label: '縣市' },
  { id: 'age', label: '年齡' }, { id: 'gender', label: '性別' }, { id: 'result', label: '結果' },
]
export const DEFAULT_DIMS: readonly string[] = ['party', 'county']
export const MIN_DIMS = 2

const STROKE_ORDER = new Intl.Collator('zh-Hant-TW')
const GENDERS = ['男', '女'] as const
const RESULTS = ['當選', '未當選'] as const

/** 「臺」「台」混寫一律用「台」 */
export const normalizeTai = (s: string): string => s.replaceAll('臺', '台')

/** 年齡組標籤：40～49 歲、70 歲以上 */
export const ageLabel = (a: number): string => (a >= 70 ? '70 歲以上' : `${a}～${a + 9} 歲`)

/** 把資料庫回的 jsonb 整理成乾淨的列：型別不對、人數非正整數的丟掉；缺值留 null，不丟人 */
export function parseRows(raw: unknown): PartyFlowRow[] {
  if (!Array.isArray(raw)) return []
  const out: PartyFlowRow[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const { p, c, t, e, a, g, r: res, n } = r as Record<string, unknown>
    if (typeof p !== 'string' || typeof c !== 'string' || typeof e !== 'string') continue
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) continue
    out.push({
      p: normalizeTai(p), c: normalizeTai(c), t: typeof t === 'string' ? normalizeTai(t) : '', e,
      a: typeof a === 'number' && Number.isFinite(a) && a >= 0 ? Math.min(70, Math.floor(a / 10) * 10) : null,
      g: typeof g === 'string' && (GENDERS as readonly string[]).includes(g) ? g : null,
      r: typeof res === 'string' && (RESULTS as readonly string[]).includes(res) ? res : null,
      n,
    })
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

/** 該屆預設的選舉別篩選：有縣市長或縣市議員就是這兩類，一個都沒有（2024）就是全部（空陣列） */
export function defaultTypesFor(rows: readonly PartyFlowRow[]): string[] {
  return rows.some((r) => DEFAULT_TYPES.includes(r.e)) ? [...DEFAULT_TYPES] : []
}
/** 網址沒指定（null）用該屆預設，否則照指定 */
export const resolveTypes = (rows: readonly PartyFlowRow[], requested: readonly string[] | null): string[] => (requested === null ? defaultTypesFor(rows) : [...requested])

/** 該屆有結果資料才有「結果」維度 */
export function availableDims(rows: readonly PartyFlowRow[]): DimDef[] {
  const hasResult = rows.some((r) => r.r !== null)
  return FLOW_DIMS.filter((d) => d.id !== 'result' || hasResult)
}

/** 政黨清單：筆畫順序、無黨籍最後 */
export function partyOrder(rows: readonly PartyFlowRow[]): string[] {
  const set = new Set(rows.map((r) => r.p))
  const named = [...set].filter((p) => p !== NO_PARTY).sort((a, b) => STROKE_ORDER.compare(a, b))
  return set.has(NO_PARTY) ? [...named, NO_PARTY] : named
}

/** 縣市清單：全國在最前，其次縣市選擇器順序（六都在前），名冊裡有但清單外的排後面（筆畫） */
export function countyOrder(rows: readonly PartyFlowRow[]): string[] {
  const set = new Set(rows.map((r) => r.c))
  const nation = set.has('全國') ? ['全國'] : []
  const known = TAIWAN_COUNTIES.filter((c) => set.has(c))
  const extra = [...set].filter((c) => c !== '全國' && !TAIWAN_COUNTIES.includes(c)).sort((a, b) => STROKE_ORDER.compare(a, b))
  return [...nation, ...known, ...extra]
}

/** 選舉別清單：總統副總統、立法委員、再地方七種（層級由大到小），其餘排最後 */
export function typeOrder(rows: readonly PartyFlowRow[]): string[] {
  const set = new Set(rows.map((r) => r.e))
  const known = ALL_TYPES.filter((t) => set.has(t))
  const extra = [...set].filter((t) => !ALL_TYPES.includes(t)).sort((a, b) => STROKE_ORDER.compare(a, b))
  return [...known, ...extra]
}

export const dimNodeId = (dim: string, key: string) => `${dim}:${key}`
export const townId = (c: string, t: string) => `town:${c}/${t}`

interface Cell { id: string; label: string; tone: Tone }
function cellOf(dim: string, r: PartyFlowRow): Cell {
  switch (dim) {
    case 'party': return { id: dimNodeId('party', r.p), label: r.p, tone: 'group' }
    case 'type': return { id: dimNodeId('type', r.e), label: r.e, tone: 'group' }
    case 'county': return { id: dimNodeId('county', r.c), label: r.c, tone: 'neutral' }
    case 'age': return r.a === null ? { id: 'age:none', label: MISSING, tone: 'neutral' } : { id: dimNodeId('age', String(r.a)), label: ageLabel(r.a), tone: 'group' }
    case 'gender': return r.g === null ? { id: 'gender:none', label: MISSING, tone: 'neutral' } : { id: dimNodeId('gender', r.g), label: r.g, tone: 'group' }
    case 'result': return r.r === null ? { id: 'result:none', label: MISSING, tone: 'neutral' } : { id: dimNodeId('result', r.r), label: r.r, tone: r.r === '當選' ? 'good' : 'neutral' }
    default: throw new Error(`不認得的維度 ${dim}`)
  }
}

/** 某維度的節點順序（畫面由上到下）：政黨筆畫、縣市選擇器、選舉別層級、年齡遞增、男女；「未提供」一律最後 */
function dimOrder(dim: string, rows: readonly PartyFlowRow[]): string[] {
  const ids = new Set(rows.map((r) => cellOf(dim, r).id))
  const ordered: string[] = []
  const add = (id: string) => { if (ids.has(id)) ordered.push(id) }
  switch (dim) {
    case 'party': partyOrder(rows).forEach((p) => add(dimNodeId('party', p))); break
    case 'type': typeOrder(rows).forEach((e) => add(dimNodeId('type', e))); break
    case 'county': countyOrder(rows).forEach((c) => add(dimNodeId('county', c))); break
    case 'age': [20, 30, 40, 50, 60, 70].forEach((a) => add(dimNodeId('age', String(a)))); break
    case 'gender': GENDERS.forEach((g) => add(dimNodeId('gender', g))); break
    case 'result': RESULTS.forEach((r) => add(dimNodeId('result', r))); break
  }
  // 預期之外的值（例如年齡不是 10 的倍數）不丟人：補在最後、未提供之前
  for (const id of [...ids].sort()) if (!ordered.includes(id) && id !== `${dim}:none`) ordered.push(id)
  add(`${dim}:none`)
  return ordered
}

/** 第一維度各節點的顏色：政黨用政黨色、年齡用單色相深淺、其餘用類別色（依節點順序）；「未提供」與小黨是灰 */
function firstDimColors(dim: string, order: readonly string[], cells: ReadonlyMap<string, Cell>): Map<string, FlowColor> {
  const out = new Map<string, FlowColor>()
  let k = 0
  for (const id of order) {
    const cell = cells.get(id)!
    if (id === `${dim}:none`) out.set(id, NEUTRAL)
    else if (dim === 'party') out.set(id, partyColorOf(cell.label))
    else if (dim === 'age') out.set(id, ageColorOf(Number(id.slice('age:'.length))))
    else out.set(id, categoricalColorAt(k++))
  }
  return out
}

export interface PartyFlowGraph extends FlowGraph {
  /** 目前篩選後的總人數 */
  total: number
  /** 每個維度那一欄的人數合計（＝總人數） */
  columns: { dim: string; total: number }[]
  /** 已展開縣市底下鄉鎮那一欄的人數合計（只含有鄉鎮的選舉） */
  townTotal: number
}

/** 規範化維度清單：只留認得的、去重；少於兩個退回預設 */
export function normalizeDims(dims: readonly string[], allowed: readonly string[] = FLOW_DIMS.map((d) => d.id)): string[] {
  const seen = [...new Set(dims.filter((d) => allowed.includes(d)))]
  return seen.length >= MIN_DIMS ? seen : [...DEFAULT_DIMS].filter((d) => allowed.includes(d))
}

/**
 * 組桑基圖。dims 的順序就是畫面由左到右的順序；縣市開著且有展開的縣市時，鄉鎮接在縣市後面
 * （有鄉鎮的人走 縣市 → 鄉鎮 → 下一個維度，沒有鄉鎮的人直接 縣市 → 下一個維度），縣市之後的維度整體右移一欄。
 * 節點與連線的順序＝畫面順序（圖表以輸入順序排列）；人數放在 raw，value 同 raw。
 */
export function buildPartyFlow(rows: readonly PartyFlowRow[], dims: readonly string[] = DEFAULT_DIMS, expanded: readonly string[] = []): PartyFlowGraph {
  const open = new Set(dims.includes('county') ? expanded : [])
  const countyAt = dims.indexOf('county')
  const hasTowns = rows.some((r) => open.has(r.c) && r.t !== '')
  const colOf = (i: number) => i + (hasTowns && countyAt >= 0 && i > countyAt ? 1 : 0)
  const nodeCount = new Map<string, number>()
  const linkCount = new Map<string, number>()
  const pathCount = new Map<string, { ids: string[]; n: number }>()
  const cells = new Map<string, Cell>()
  const townNodes = new Map<string, { county: string; label: string }>()
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n)
  for (const r of rows) {
    const path: string[] = []
    dims.forEach((d) => {
      const cell = cellOf(d, r)
      cells.set(cell.id, cell)
      path.push(cell.id)
      bump(nodeCount, cell.id, r.n)
      if (d === 'county' && open.has(r.c) && r.t) {
        const tid = townId(r.c, r.t)
        townNodes.set(tid, { county: r.c, label: r.t })
        bump(nodeCount, tid, r.n)
        path.push(tid)
      }
    })
    // 第一欄出來的線不用拆；之後的線依第一維度的值拆開（同一組 source→target 可有多條，各帶自己的人數）
    for (let i = 1; i < path.length; i++) bump(linkCount, `${i === 1 ? '' : path[0]}\u0000${path[i - 1]}\u0000${path[i]}`, r.n)
    // 完整路徑（選中某節點時，其他節點顯示經過它的人數）：同一條路徑的列併在一起
    const pk = path.join('\u0000')
    const cur = pathCount.get(pk)
    if (cur) cur.n += r.n
    else pathCount.set(pk, { ids: path, n: r.n })
  }
  const nodes: FlowNode[] = []
  const colTotals: number[] = []
  const firstOrder = dims.length ? dimOrder(dims[0], rows) : []
  const firstColors = dims.length ? firstDimColors(dims[0], firstOrder, cells) : new Map<string, FlowColor>()
  dims.forEach((d, i) => {
    let total = 0
    for (const id of dimOrder(d, rows)) {
      const cell = cells.get(id)!
      const c = i === 0 ? firstColors.get(id)! : NEUTRAL
      nodes.push({ id, label: cell.label, tone: cell.tone, col: colOf(i), color: c.color, colorDark: c.colorDark })
      total += nodeCount.get(id) ?? 0
    }
    colTotals.push(total)
  })
  let townTotal = 0
  if (hasTowns) {
    const order = countyOrder(rows)
    const list = [...townNodes.entries()].sort((a, b) => order.indexOf(a[1].county) - order.indexOf(b[1].county) || STROKE_ORDER.compare(a[1].label, b[1].label))
    for (const [id, t] of list) {
      nodes.push({ id, label: t.label, tone: 'group', col: colOf(countyAt) + 1, color: NEUTRAL.color, colorDark: NEUTRAL.colorDark })
      townTotal += nodeCount.get(id) ?? 0
    }
  }
  const rank = new Map(nodes.map((n, i) => [n.id, i]))
  const links: FlowLink[] = [...linkCount.entries()]
    .map(([k, n]) => {
      const [series, source, target] = k.split('\u0000')
      // 顏色跟著第一維度：第一欄出來的線取來源節點的色，其餘取它所屬的第一維度值的色
      const c = firstColors.get(series || source) ?? NEUTRAL
      const link: FlowLink = { source, target, value: n, raw: n, tone: (target.startsWith('town:') ? 'neutral' : 'group') as Tone, color: c.color, colorDark: c.colorDark, series: cells.get(series || source)?.label }
      return { link, order: series ? firstOrder.indexOf(series) : -1 }
    })
    .sort((a, b) => rank.get(a.link.source)! - rank.get(b.link.source)! || rank.get(a.link.target)! - rank.get(b.link.target)! || a.order - b.order)
    .map((x) => x.link)
  const paths = [...pathCount.values()].map((p) => ({ ids: p.ids, n: p.n, w: p.n }))
  return { nodes, links, paths, total: sumRows(rows), columns: dims.map((d, i) => ({ dim: d, total: colTotals[i] })), townTotal }
}

/** 網址參數 ←→ 狀態。逗號分隔；不認得的值丟掉 */
export interface PartyFlowQuery {
  election: number
  /** null＝網址沒指定，用該屆預設；空陣列＝全部 */
  types: string[] | null
  parties: string[]
  open: string[]
  dims: string[]
}

const list = (v: unknown): string[] => {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s.split(',').map((x) => normalizeTai(x.trim())).filter(Boolean) : []
}

export function parseQuery(q: Record<string, unknown>, known: { types?: readonly string[]; parties?: readonly string[]; counties?: readonly string[]; dims?: readonly string[] } = {}): PartyFlowQuery {
  const keep = (xs: string[], ok?: readonly string[]) => [...new Set(ok ? xs.filter((x) => ok.includes(x)) : xs)]
  const el = Number(Array.isArray(q.election) ? q.election[0] : q.election)
  const election = ELECTIONS.some((e) => e.id === el) ? el : DEFAULT_ELECTION
  const types = q.type === undefined ? null : q.type === 'all' ? [] : keep(list(q.type), known.types)
  return {
    election, types, parties: keep(list(q.party), known.parties), open: keep(list(q.open), known.counties),
    dims: normalizeDims(list(q.dims), known.dims),
  }
}

export function toQuery(s: { election: number; types: readonly string[] | null; parties: readonly string[]; open: readonly string[]; dims: readonly string[] }, defaultTypes: readonly string[] = DEFAULT_TYPES): Record<string, string> {
  const q: Record<string, string> = {}
  if (s.election !== DEFAULT_ELECTION) q.election = String(s.election)
  if (s.types !== null) {
    const same = s.types.length === defaultTypes.length && defaultTypes.every((t) => s.types!.includes(t))
    if (!same) q.type = s.types.length === 0 ? 'all' : s.types.join(',')
  }
  if (s.parties.length) q.party = s.parties.join(',')
  if (s.dims.length !== DEFAULT_DIMS.length || !DEFAULT_DIMS.every((d, i) => s.dims[i] === d)) q.dims = s.dims.join(',')
  if (s.open.length && s.dims.includes('county')) q.open = s.open.join(',')
  return q
}

/** 加入或移除（切換）一個值，保持原順序 */
export const toggle = (xs: readonly string[], x: string): string[] => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])

/**
 * 選中某節點後要亮哪些節點與線（政黨分流圖用）。只看「經過選中節點的完整路徑」：
 * 節點＝這些路徑經過的節點；線＝這些路徑上連續的 source→target，而且屬於同一個第一維度的值（link.series 等於該路徑第一個節點的名稱）。
 * 這樣點「國民黨」只亮國民黨的線，不會因為共用同一個縣市就把別黨的線一起點亮。回傳的線是輸入 links 的索引。
 */
export function litByPaths(
  graph: { nodes: readonly { id: string; label: string }[]; paths: readonly { ids: readonly string[] }[] },
  links: readonly { source: string; target: string; series?: string }[],
  sel: string,
): { nodes: Set<string>; links: Set<number> } {
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]))
  const nodes = new Set<string>()
  const keys = new Set<string>()
  for (const p of graph.paths) {
    if (!p.ids.includes(sel)) continue
    const series = label.get(p.ids[0]) ?? ''
    for (let k = 0; k < p.ids.length; k++) {
      nodes.add(p.ids[k])
      if (k > 0) keys.add(`${series}\u0000${p.ids[k - 1]}\u0000${p.ids[k]}`)
    }
  }
  const out = new Set<number>()
  links.forEach((l, i) => {
    if (l.series !== undefined ? keys.has(`${l.series}\u0000${l.source}\u0000${l.target}`) : [...keys].some((k) => k.endsWith(`\u0000${l.source}\u0000${l.target}`))) out.add(i)
  })
  return { nodes, links: out }
}
