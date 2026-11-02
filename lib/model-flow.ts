/**
 * /ai 頁分流圖（policy-ops#174）：把 model_flow_stats 的流量列組成桑基圖的節點與連線。
 * 交件 4 層：模型 → 任務類型 → 交件結果 → 退件原因（只有退件往下分）。
 * 投票 4 層：模型 → 投票 → 同意／不同意／不確定 → 事後證明投對／投錯。
 * 線寬不用件數：每個模型各自正規化成 100，往後各層是該模型在這條路徑的佔比（量大的模型不會把小模型擠沒）；
 * 件數另存在 raw，給提示與標籤顯示。
 */
import { CONTRIBUTION_TYPE_LABEL, type ContribStatsRow, type VoteStatsRow } from './model-quality.ts'

export interface FlowRow { layer: 'contrib' | 'reject' | 'vote'; model: string | null; key1: string | null; key2: string | null; n: number }

/** 色調：綠＝好、紅＝壞、灰＝未定／中性、藍灰＝模型與類型等分類節點 */
export type Tone = 'good' | 'bad' | 'neutral' | 'group'
export interface FlowNode { id: string; label: string; tone: Tone }
/** value＝佔比權重（每個模型出流量加總 100）；raw＝原始件數 */
export interface FlowLink { source: string; target: string; value: number; tone: Tone; raw: number }
export interface FlowGraph { nodes: FlowNode[]; links: FlowLink[] }

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

class Builder {
  nodes = new Map<string, FlowNode>()
  links = new Map<string, FlowLink>()
  node(id: string, label: string, tone: Tone) { if (!this.nodes.has(id)) this.nodes.set(id, { id, label, tone }) }
  link(source: string, target: string, raw: number, scale: number, tone: Tone) {
    if (raw <= 0) return
    const value = raw * scale
    const k = `${source}|${target}`
    const cur = this.links.get(k)
    if (cur) { cur.value += value; cur.raw += raw }
    else this.links.set(k, { source, target, value, tone, raw })
  }
  graph(): FlowGraph {
    const used = new Set<string>()
    for (const l of this.links.values()) { used.add(l.source); used.add(l.target) }
    return { nodes: [...this.nodes.values()].filter((n) => used.has(n.id)), links: [...this.links.values()] }
  }
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

export function buildContribFlow(rows: FlowRow[]): FlowGraph {
  const c = rows.filter((r) => r.layer === 'contrib' && r.model && r.key1 && r.key2)
  const models = topKeys(sumBy(c, (r) => r.model, (r) => r.n), MAX_MODELS)
  const types = topKeys(sumBy(c, (r) => r.key1, (r) => r.n), MAX_TYPES)
  const b = new Builder()
  const m2 = (m: string) => (models.has(m) ? m : OTHER_MODEL)
  const t2 = (t: string) => (types.has(t) ? t : OTHER_TYPE)
  const totals = sumBy(c, (r) => m2(r.model!), (r) => r.n)
  const scaleOf = (m: string) => 100 / (totals.get(m) || 1)
  for (const r of c) {
    const mid = `m:${m2(r.model!)}`
    const tid = `t:${t2(r.key1!)}`
    const res = RESULT[r.key2!] ?? RESULT.other
    const rid = `r:${r.key2! in RESULT ? r.key2 : 'other'}`
    b.node(mid, m2(r.model!), 'group')
    b.node(tid, types.has(r.key1!) ? (CONTRIBUTION_TYPE_LABEL[r.key1!] ?? r.key1!) : OTHER_TYPE, 'group')
    b.node(rid, res.label, res.tone)
    const sc = scaleOf(m2(r.model!))
    b.link(mid, tid, r.n, sc, 'group')
    b.link(tid, rid, r.n, sc, res.tone)
  }
  // 退件原因：有模型的照該模型正規化；沒帶模型的用「退件總佔比／退件總件數」的平均比例
  const rej = rows.filter((r) => r.layer === 'reject' && r.key1)
  const rejRaw = c.filter((r) => r.key2 === 'rejected').reduce((a, r) => a + r.n, 0)
  const rejWeight = c.filter((r) => r.key2 === 'rejected').reduce((a, r) => a + r.n * scaleOf(m2(r.model!)), 0)
  const avgScale = rejRaw > 0 ? rejWeight / rejRaw : 0
  for (const r of rej) {
    b.node('r:rejected', RESULT.rejected.label, 'bad')
    b.node(`x:${r.key1}`, REASON[r.key1!] ?? '其他原因', 'bad')
    const sc = r.model && totals.has(m2(r.model)) ? scaleOf(m2(r.model)) : avgScale
    b.link('r:rejected', `x:${r.key1}`, r.n, sc, 'bad')
  }
  return b.graph()
}

export function buildVoteFlow(rows: FlowRow[]): FlowGraph {
  const v = rows.filter((r) => r.layer === 'vote' && r.model && r.key1)
  const models = topKeys(sumBy(v, (r) => r.model, (r) => r.n), MAX_MODELS, (k) => k === '系統票（Jev）')
  const b = new Builder()
  const nameOf = (m: string) => (models.has(m) ? m : OTHER_MODEL)
  const valid = v.filter((r) => VERDICT[r.key1!])
  const totals = sumBy(valid, (r) => nameOf(r.model!), (r) => r.n)
  for (const r of valid) {
    const name = nameOf(r.model!)
    const ver = VERDICT[r.key1!]
    const sc = 100 / (totals.get(name) || 1)
    b.node(`m:${name}`, name, 'group')
    b.node('v', '投票', 'group')
    b.node(`d:${r.key1}`, ver.label, ver.tone)
    b.link(`m:${name}`, 'v', r.n, sc, 'group')
    b.link('v', `d:${r.key1}`, r.n, sc, ver.tone)
    if (r.key2 === 'right' || r.key2 === 'wrong') {
      b.node(`o:${r.key2}`, r.key2 === 'right' ? '投對' : '投錯', r.key2 === 'right' ? 'good' : 'bad')
      b.link(`d:${r.key1}`, `o:${r.key2}`, r.n, sc, r.key2 === 'right' ? 'good' : 'bad')
    }
  }
  return b.graph()
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
