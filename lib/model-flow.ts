/**
 * /ai 頁分流圖（policy-ops#174）：把 model_flow_paths 的「完整路徑」計數組成桑基圖的節點與連線。
 * 維度可以由使用者重排（?dims=、?vdims=），所以先有完整元組、再依順序逐層連起來：
 *   交件 4 維：模型、任務類型、結果、退件原因（預設 模型 → 結果 → 退件原因 → 任務類型）
 *   投票 3 維：模型、投票意見、事後對錯（預設 模型 → 事後對錯 → 投票意見）
 * 「退件原因」只有退件才有：其餘路徑在這一層歸到灰色的「非退件」節點，每條線都走滿所有層，層與層之間加總永遠一致。
 * 線寬不用件數：每個模型各自正規化成 100（量大的模型不會把小模型擠沒）；件數另存在 raw，數量模式與提示用。
 */
import { CONTRIBUTION_TYPE_LABEL, type ContribStatsRow, type VoteStatsRow } from './model-quality.ts'

/** key3＝退件原因（交件、且只有退件才有）；舊資料或退路沒有時為 null／缺 */
export interface FlowRow { layer: 'contrib' | 'vote'; model: string | null; key1: string | null; key2: string | null; key3?: string | null; n: number }

/** 色調：綠＝好、紅＝壞、灰＝未定／中性、藍灰＝模型與類型等分類節點 */
export type Tone = 'good' | 'bad' | 'neutral' | 'group'
export interface FlowNode { id: string; label: string; tone: Tone }
/** value＝佔比權重（每個模型出流量加總 100）；raw＝原始件數 */
export interface FlowLink { source: string; target: string; value: number; tone: Tone; raw: number }
/** 一條完整路徑：依目前維度順序走過的節點 id、原始件數、佔比權重（同 FlowLink.value 的算法） */
export interface FlowPath { ids: string[]; n: number; w: number }
export interface FlowGraph { nodes: FlowNode[]; links: FlowLink[]; paths: FlowPath[] }

const MAX_MODELS = 8
const MAX_TYPES = 7
const OTHER_MODEL = '其餘模型'
const OTHER_TYPE = '其他型別'

const RESULT: Record<string, { label: string; tone: Tone }> = {
  applied: { label: '上線', tone: 'good' },
  pending: { label: '等票中', tone: 'neutral' },
  rejected: { label: '退件', tone: 'bad' },
  superseded: { label: '已被取代', tone: 'neutral' },
  withdrawn: { label: '撤回', tone: 'neutral' },
  other: { label: '寫入失敗或還原', tone: 'neutral' },
}
const REASON: Record<string, string> = {
  data: '資料錯', timeout: '逾時', duplicate: '重複', no_change_missing: '無異動查無', score: '同儕票退件',
}
const VERDICT: Record<string, { label: string; tone: Tone }> = {
  agree: { label: '同意', tone: 'good' },
  disagree: { label: '不同意', tone: 'bad' },
  unsure: { label: '不確定', tone: 'neutral' },
}

/** 依總量挑前 N 名，其餘歸一個「其餘」 */
function topKeys(totals: Map<string, number>, max: number, keep: (k: string) => boolean = () => false): Set<string> {
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  const top = new Set(sorted.slice(0, max))
  for (const k of sorted) if (keep(k)) top.add(k)
  return top
}
function sumBy<T>(rows: T[], key: (r: T) => string | null, n: (r: T) => number) {
  const m = new Map<string, number>()
  for (const r of rows) { const k = key(r); if (k != null) m.set(k, (m.get(k) ?? 0) + n(r)) }
  return m
}

export interface DimDef { id: string; label: string }
export const CONTRIB_DIMS: readonly DimDef[] = [
  { id: 'model', label: '模型' }, { id: 'type', label: '任務類型' }, { id: 'result', label: '結果' }, { id: 'reason', label: '退件原因' },
]
export const VOTE_DIMS: readonly DimDef[] = [
  { id: 'model', label: '模型' }, { id: 'verdict', label: '投票意見' }, { id: 'outcome', label: '事後對錯' },
]
/** 預設：模型先，接著是最能看出誰錯得多的維度，任務類型（把各模型的線混在一起）放最後 */
export const DEFAULT_CONTRIB_ORDER = ['model', 'result', 'reason', 'type']
export const DEFAULT_VOTE_ORDER = ['model', 'outcome', 'verdict']

/** 網址上的順序字串（逗號分隔）；不是這些維度的完整排列就退回預設 */
export function parseDimOrder(v: unknown, dims: readonly DimDef[], fallback: readonly string[]): string[] {
  const raw = Array.isArray(v) ? v[0] : v
  if (typeof raw !== 'string') return [...fallback]
  const parts = raw.split(',')
  const ids = dims.map((d) => d.id)
  if (parts.length !== ids.length || new Set(parts).size !== ids.length || !parts.every((p) => ids.includes(p))) return [...fallback]
  return parts
}

interface Cell { id: string; label: string; tone: Tone }
interface Tuple { model: string; n: number; cells: Record<string, Cell> }

function toneOfLink(s: Tone, t: Tone): Tone {
  if (t === 'good' || t === 'bad') return t
  if (s === 'good' || s === 'bad') return s
  return t === 'group' ? s : t
}

/** 依 order 逐層連起來；每個元組走滿所有層，線寬＝件數 × 100／該模型總件數 */
function assemble(tuples: Tuple[], order: readonly string[]): FlowGraph {
  const totals = sumBy(tuples, (t) => t.model, (t) => t.n)
  const nodes = new Map<string, FlowNode>()
  const links = new Map<string, FlowLink>()
  const paths: FlowPath[] = []
  for (const t of tuples) {
    if (t.n <= 0) continue
    const sc = 100 / (totals.get(t.model) || 1)
    paths.push({ ids: order.map((d) => t.cells[d].id), n: t.n, w: t.n * sc })
    let prev: Cell | null = null
    for (const dim of order) {
      const cell = t.cells[dim]
      if (!nodes.has(cell.id)) nodes.set(cell.id, { id: cell.id, label: cell.label, tone: cell.tone })
      if (prev) {
        const k = `${prev.id}|${cell.id}`
        const cur = links.get(k)
        if (cur) { cur.value += t.n * sc; cur.raw += t.n }
        else links.set(k, { source: prev.id, target: cell.id, value: t.n * sc, tone: toneOfLink(prev.tone, cell.tone), raw: t.n })
      }
      prev = cell
    }
  }
  return { nodes: [...nodes.values()], links: [...links.values()], paths }
}

export function buildContribFlow(rows: FlowRow[], order: readonly string[] = DEFAULT_CONTRIB_ORDER): FlowGraph {
  const c = rows.filter((r) => r.layer === 'contrib' && r.model && r.key1 && r.key2)
  const models = topKeys(sumBy(c, (r) => r.model, (r) => r.n), MAX_MODELS)
  const types = topKeys(sumBy(c, (r) => r.key1, (r) => r.n), MAX_TYPES)
  const tuples: Tuple[] = c.map((r) => {
    const model = models.has(r.model!) ? r.model! : OTHER_MODEL
    const res = RESULT[r.key2!] ?? RESULT.other
    const resKey = r.key2! in RESULT ? r.key2! : 'other'
    const typeLabel = types.has(r.key1!) ? (CONTRIBUTION_TYPE_LABEL[r.key1!] ?? '其他型別') : OTHER_TYPE
    const rejected = resKey === 'rejected'
    const reasonKey = rejected ? (r.key3 ?? 'unknown') : 'none'
    return {
      model, n: r.n,
      cells: {
        model: { id: `model:${model}`, label: model, tone: 'group' },
        type: { id: `type:${typeLabel}`, label: typeLabel, tone: 'group' },
        result: { id: `result:${resKey}`, label: res.label, tone: res.tone },
        reason: rejected
          ? { id: `reason:${reasonKey}`, label: REASON[reasonKey] ?? '原因不明', tone: 'bad' }
          : { id: 'reason:none', label: '非退件', tone: 'neutral' },
      },
    }
  })
  return assemble(tuples, order)
}

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  right: { label: '投對', tone: 'good' },
  wrong: { label: '投錯', tone: 'bad' },
  none: { label: '不計對錯', tone: 'neutral' },
}

export function buildVoteFlow(rows: FlowRow[], order: readonly string[] = DEFAULT_VOTE_ORDER): FlowGraph {
  const v = rows.filter((r) => r.layer === 'vote' && r.model && r.key1 && VERDICT[r.key1])
  const models = topKeys(sumBy(v, (r) => r.model, (r) => r.n), MAX_MODELS, (k) => k === '系統票（Jev）')
  const tuples: Tuple[] = v.map((r) => {
    const model = models.has(r.model!) ? r.model! : OTHER_MODEL
    const ver = VERDICT[r.key1!]
    const out = OUTCOME[r.key2 ?? 'none'] ?? OUTCOME.none
    return {
      model, n: r.n,
      cells: {
        model: { id: `model:${model}`, label: model, tone: 'group' },
        verdict: { id: `verdict:${r.key1}`, label: ver.label, tone: ver.tone },
        outcome: { id: `outcome:${r.key2 ?? 'none'}`, label: out.label, tone: out.tone },
      },
    }
  })
  return assemble(tuples, order)
}

const SMALL_SAMPLE_N = 10
const pct1 = (v: number) => `${(Math.round(v * 10) / 10).toFixed(1)}%`

/** 節點／連線的標籤文字。比例模式只有百分比（不帶件數、不提示樣本少）；數量模式才顯示件數 */
export function nodeText(mode: 'pct' | 'count' | undefined, o: { label: string; raw: number; share: number; hideShare?: boolean }): string {
  if (mode === 'count') {
    const c = o.raw < SMALL_SAMPLE_N ? `僅 ${o.raw.toLocaleString()} 件` : `${o.raw.toLocaleString()} 件`
    return `${o.label}（${c}）`
  }
  return o.hideShare ? o.label : `${o.label} ${pct1(o.share)}`
}
export function linkText(mode: 'pct' | 'count' | undefined, o: { from: string; to: string; raw: number; share: number }): string {
  return mode === 'count' ? `${o.from} → ${o.to}：${o.raw.toLocaleString()} 件` : `${o.from} → ${o.to}：${pct1(o.share)}`
}

export interface SelStat { raw: number; share: number }
/**
 * 選中某節點後，每個節點在「選中子集合」裡的值：只取經過選中節點的完整路徑重新彙總。
 * share＝子集合內流經該節點的權重佔子集合總權重（%）；沒經過的節點為 0。
 */
export function selectionStats(graph: FlowGraph, selId: string): Map<string, SelStat> {
  const sub = graph.paths.filter((p) => p.ids.includes(selId))
  const total = sub.reduce((a, p) => a + p.w, 0) || 1
  const out = new Map<string, SelStat>()
  for (const n of graph.nodes) out.set(n.id, { raw: 0, share: 0 })
  for (const p of sub) for (const id of p.ids) { const s = out.get(id)!; s.raw += p.n; s.share += (p.w / total) * 100 }
  return out
}

/** 選中時的節點標籤：比例模式「名稱 子集佔比%（全體 x%）」，數量模式「名稱（子集件數）」 */
export function selNodeText(mode: 'pct' | 'count' | undefined, o: { label: string; raw: number; share: number; allShare: number; hideShare?: boolean; withAll?: boolean }): string {
  if (mode === 'count') return `${o.label}（${o.raw.toLocaleString()} 件）`
  if (o.hideShare) return o.label
  return o.withAll === false ? `${o.label} ${pct1(o.share)}` : `${o.label} ${pct1(o.share)}（全體 ${pct1(o.allShare)}）`
}

/** 分流函式還沒上線時的退路：用現有兩支 stats 組出前 3 層（沒有退件原因、沒有投對投錯） */
export function fallbackFlowRows(contrib: ContribStatsRow[], votes: VoteStatsRow[]): FlowRow[] {
  const out: FlowRow[] = []
  for (const r of contrib) {
    if (!r.contribution_type) continue
    const add = (key2: string, n: number) => { if (n > 0) out.push({ layer: 'contrib', model: r.model, key1: r.contribution_type, key2, n }) }
    add('applied', r.applied); add('rejected', r.rejected); add('pending', r.pending + r.verified + r.disputed)
    add('superseded', r.superseded); add('withdrawn', r.withdrawn); add('other', r.other_status)
  }
  for (const r of votes) {
    for (const [k, n] of [['agree', r.agree], ['disagree', r.disagree], ['unsure', r.unsure]] as const) {
      if (n > 0) out.push({ layer: 'vote', model: r.model, key1: k, key2: 'none', n })
    }
  }
  return out
}
