// /trace 重播頁的純函式：事件長相、事件走哪條線、節點計數、最活躍排行、時間顯示。
// 資料來自 SQL 函式 trace_events()（migration 20261111140000）；這裡不碰網路、不碰 DOM，方便測試。

/** 流程圖上的節點代號（版面在 lib/trace-layout.ts） */
export type NodeId =
  | 'official' | 'detector' | 'card' | 'queue' | 'dispatcher' | 'vote' | 'applied' | 'visitor'
  | 'suggest' | 'jevSort' | 'jevVote' | 'submit' | 'notfound' | 'cooldown' | 'dispute' | 'strongLane' | 'rejected'

export interface TraceEvent {
  at: string
  kind: string
  task_id: string | null
  work_key: string | null
  contribution_id: string | null
  politician_id: string | null
  agent_name: string | null
  detail: Record<string, unknown>
}

/** 事件加上解析好的毫秒時間，排序與重播都用它 */
export interface TraceItem extends TraceEvent {
  ms: number
  /** 同一毫秒時保持穩定順序用 */
  seq: number
}

export type KindGroup = 'gap' | 'lease' | 'request' | 'submit' | 'verify' | 'apply' | 'reject' | 'check' | 'dispute'

interface KindInfo {
  group: KindGroup
  /** 圓點走過的節點；只有一個節點＝在那個節點閃一下 */
  route: NodeId[]
}

const KINDS: Record<string, KindInfo> = {
  gap_opened: { group: 'gap', route: ['detector', 'card', 'queue'] },
  gap_reopened: { group: 'gap', route: ['detector', 'card', 'queue'] },
  gap_closed: { group: 'gap', route: ['queue'] },
  lease_issued: { group: 'lease', route: ['queue', 'dispatcher'] },
  lease_reported: { group: 'lease', route: ['dispatcher', 'submit'] },
  lease_released: { group: 'lease', route: ['dispatcher', 'queue'] },
  lease_expired: { group: 'lease', route: ['dispatcher', 'queue'] },
  task_created: { group: 'request', route: ['queue'] },
  task_closed: { group: 'request', route: ['queue'] },
  request_merged: { group: 'request', route: ['visitor', 'card'] },
  submitted: { group: 'submit', route: ['dispatcher', 'submit', 'jevSort', 'queue'] },
  verify_dispatched: { group: 'verify', route: ['dispatcher', 'vote'] },
  vote: { group: 'verify', route: ['vote'] },
  system_vote: { group: 'verify', route: ['jevVote', 'vote'] },
  system_check: { group: 'verify', route: ['jevSort'] },
  disputed: { group: 'dispute', route: ['vote', 'dispute'] },
  strong_claim: { group: 'dispute', route: ['dispute', 'strongLane'] },
  strong_finalized: { group: 'dispute', route: ['strongLane', 'applied'] },
  verified: { group: 'verify', route: ['vote'] },
  applied: { group: 'apply', route: ['vote', 'applied'] },
  rejected: { group: 'reject', route: ['vote', 'rejected'] },
  check: { group: 'check', route: ['submit', 'notfound', 'cooldown'] },
}

export const GROUP_COLOR: Record<KindGroup, string> = {
  gap: '#64748b',
  lease: '#0891b2',
  request: '#6366f1',
  submit: '#2563eb',
  verify: '#7c3aed',
  apply: '#16a34a',
  reject: '#dc2626',
  check: '#d97706',
  dispute: '#be185d',
}

export const GROUP_LABEL: Record<KindGroup, string> = {
  gap: '缺口',
  lease: '認領',
  request: '請求',
  submit: '交件',
  verify: '驗證',
  apply: '落庫',
  reject: '退件',
  check: '查核',
  dispute: '爭議',
}

const detail_bool = (e: TraceEvent, key: string): boolean => e.detail?.[key] === true

const detailText = (e: TraceEvent, key: string): string => {
  const v = e.detail?.[key]
  return typeof v === 'string' ? v : ''
}

export function groupOf(kind: string): KindGroup {
  return KINDS[kind]?.group ?? 'gap'
}

/** 這個事件的圓點要走過哪些節點 */
export function eventRoute(e: TraceEvent): NodeId[] {
  if (e.kind === 'submitted') {
    const type = detailText(e, 'type')
    if (type === 'task_suggestion') return ['dispatcher', 'submit', 'jevSort', 'suggest', 'card']
    if (type === 'no_change') return ['dispatcher', 'submit']
    return ['dispatcher', 'submit', 'jevSort', 'queue']
  }
  if (e.kind === 'task_created') return detailText(e, 'source') === 'web_request' ? ['visitor', 'card', 'queue'] : ['queue']
  // 強模型定案：維持原貢獻（uphold）走落庫，駁回（reject）走退件／結案
  if (e.kind === 'strong_finalized') return detailText(e, 'verdict') === 'reject' ? ['strongLane', 'rejected'] : ['strongLane', 'applied']
  if (e.kind === 'check') return detailText(e, 'outcome') === 'not_found' ? ['submit', 'notfound', 'cooldown'] : ['submit']
  return KINDS[e.kind]?.route ?? ['queue']
}

const GAP_REASON: Record<string, string> = { filled: '缺口已補完', window: '不在開放期間' }
const CHECK_OUTCOME: Record<string, string> = { not_found: '查無', confirmed: '確認沒有變動', unreachable: '連不上來源' }
const CLOSE_REASON: Record<string, string> = { applied: '落庫後結案', expired: '到期結案', manual: '維護者結案', merged: '併入別件', rejected: '退件後結案' }
const SOURCE_CHOICE: Record<string, string> = { supported: '來源撐得住', not_supported: '來源撐不住', cannot_tell: '無法判斷' }
const STRONG_VERDICT: Record<string, string> = { uphold: '維持原交件', uphold_with_correction: '維持並更正', reject: '駁回' }
const CHECK_QUESTION: Record<string, string> = { followup: '追問判定', new_person: '新人物判定', second_source: '第二來源判定', clarify_kind: '釐清分類' }
const VERDICT: Record<string, string> = { agree: '同意', disagree: '反對', unsure: '不確定', not_supported: '不成立' }
const CONTRIBUTION_TYPE: Record<string, string> = {
  policy: '政見', politician: '人物資料', candidacy: '參選紀錄', no_change: '查無回報', task_suggestion: '任務提議',
  adjudication: '裁決', correction: '更正', policy_progress: '進度', merge_politician: '合併人物', party_info: '政黨資料',
}

/** 給人看的一句話；不寫表名、函式名、任務編號 */
export function eventText(e: TraceEvent): string {
  const who = e.agent_name ? `「${e.agent_name}」` : ''
  const type = CONTRIBUTION_TYPE[detailText(e, 'type')] ?? ''
  switch (e.kind) {
    case 'gap_opened': return detailText(e, 'rekey_of') ? '換了新編號，缺口重新排進佇列' : '缺口出現，排進佇列'
    case 'gap_reopened': return '缺口重新打開，回到佇列'
    case 'gap_closed': {
      const via = detailText(e, 'via') === 'drop_applied' ? '有交件落庫，缺口收回' : (GAP_REASON[detailText(e, 'reason')] ?? '缺口收回')
      return via
    }
    case 'lease_issued': return `${who || '有代理'}領走這件任務`
    case 'lease_reported': return `${who || '領走的代理'}交件了`
    case 'lease_released': return `${who || '領走的代理'}放回這件任務`
    case 'lease_expired': return `${who || '領走的代理'}逾時沒交，任務收回`
    case 'task_created': return detailText(e, 'source') === 'web_request' ? '訪客請求建立任務' : '手動任務建立'
    case 'task_closed': return CLOSE_REASON[detailText(e, 'closed_reason')] ? `手動任務${CLOSE_REASON[detailText(e, 'closed_reason')]}` : '手動任務結案'
    case 'request_merged': return '訪客請求併入既有缺口'
    case 'submitted': return `${who || '有代理'}交件${type ? `（${type}）` : ''}`
    case 'verified': return '同意票夠了，等待落庫'
    case 'verify_dispatched': return `驗證票派給${who || '一位代理'}`
    case 'vote': return `${who || '有代理'}投了「${VERDICT[detailText(e, 'verdict')] ?? '一票'}」`
    case 'system_vote': {
      const n = e.detail?.supported_sources
      return `SystemOne 系統票：${SOURCE_CHOICE[detailText(e, 'choice')] ?? '已判定'}${typeof n === 'number' ? `（核得過 ${n} 個獨立來源）` : ''}`
    }
    case 'system_check': return `SystemOne ${CHECK_QUESTION[detailText(e, 'question')] ?? '系統判定'}${SOURCE_CHOICE[detailText(e, 'choice')] ? `：${SOURCE_CHOICE[detailText(e, 'choice')]}` : ''}`
    case 'disputed': return detail_bool(e, 'strong') ? '轉為爭議，交強模型通道裁決' : detail_bool(e, 'overvoted') ? '投太多輪，停止派驗證、轉為爭議' : '轉為爭議，等待裁決'
    case 'strong_claim': return `${who || '強模型'}領走強模型裁決`
    case 'strong_finalized': return `強模型定案：${STRONG_VERDICT[detailText(e, 'verdict')] ?? '已裁決'}`
    case 'applied': return '落庫上線'
    case 'rejected': return '退件，不上線'
    case 'check': {
      const o = CHECK_OUTCOME[detailText(e, 'outcome')] ?? '查核'
      return `${who || '有代理'}回報${o}${o === '查無' ? '，進入冷卻' : ''}`
    }
    default: return '其他事件'
  }
}

/** 補充說明（理由、備註），沒有就空字串 */
export function eventNote(e: TraceEvent): string {
  const n = detailText(e, 'note')
  return n.length > 0 ? n : ''
}

// ---- 解析與排序 ----

export function toItems(rows: readonly TraceEvent[]): TraceItem[] {
  const items: TraceItem[] = []
  rows.forEach((r, i) => {
    const ms = Date.parse(r.at)
    if (Number.isFinite(ms)) items.push({ ...r, detail: r.detail ?? {}, ms, seq: i })
  })
  // 先照時間，同一毫秒再照「流程先後」，最後照原順序，結果穩定
  const order = (k: string) => {
    const i = Object.keys(KINDS).indexOf(k)
    return i < 0 ? 99 : i
  }
  return items.sort((a, b) => a.ms - b.ms || order(a.kind) - order(b.kind) || a.seq - b.seq)
}

/** 去掉重複（切段查詢在交界處可能多拿到同一筆） */
export function dedupe(rows: readonly TraceEvent[]): TraceEvent[] {
  const seen = new Set<string>()
  const out: TraceEvent[] = []
  for (const r of rows) {
    const key = [r.at, r.kind, r.task_id, r.contribution_id, r.agent_name, r.politician_id, r.detail?.verdict ?? ''].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

// ---- 節點計數 ----

export const COUNT_LABEL: Partial<Record<NodeId, string>> = {
  detector: '新缺口', dispute: '爭議', strongLane: '認領', queue: '收回', dispatcher: '派出', submit: '交件', vote: '投票', applied: '落庫', rejected: '退件', jevVote: '系統票', notfound: '查無', visitor: '請求', suggest: '提議',
}

/** 這個事件算在哪個節點的計數上；不計數回 null */
export function countNode(e: TraceEvent): NodeId | null {
  switch (e.kind) {
    case 'gap_opened': case 'gap_reopened': return 'detector'
    case 'gap_closed': return 'queue'
    // 強模型專線的認領也是一筆租約事件，所以同時算進一般「派出」；strong_claim 另算在強模型通道格
    case 'lease_issued': case 'verify_dispatched': return 'dispatcher'
    case 'submitted': return detailText(e, 'type') === 'task_suggestion' ? 'suggest' : 'submit'
    case 'vote': return 'vote'
    case 'system_vote': return 'jevVote'
    case 'disputed': return 'dispute'
    case 'strong_claim': return 'strongLane'
    case 'applied': return 'applied'
    case 'rejected': return 'rejected'
    case 'check': return detailText(e, 'outcome') === 'not_found' ? 'notfound' : null
    case 'request_merged': return 'visitor'
    case 'task_created': return detailText(e, 'source') === 'web_request' ? 'visitor' : null
    default: return null
  }
}

export type NodeCounts = Partial<Record<NodeId, number>>

/** 強模型通道：認領與定案各幾件（定案再分維持／駁回） */
export function strongBreakdown(items: readonly TraceItem[], upTo: number = items.length - 1): { claim: number; finalized: number; rejected: number } {
  const out = { claim: 0, finalized: 0, rejected: 0 }
  const last = Math.min(upTo, items.length - 1)
  for (let i = 0; i <= last; i++) {
    if (items[i].kind === 'strong_claim') out.claim++
    else if (items[i].kind === 'strong_finalized') {
      out.finalized++
      if (items[i].detail?.verdict === 'reject') out.rejected++
    }
  }
  return out
}

/** 前 upTo 筆事件裡系統票各選項的數量（支持／不支持／無法判斷） */
export function systemVoteBreakdown(items: readonly TraceItem[], upTo: number = items.length - 1): { supported: number; notSupported: number; other: number } {
  const out = { supported: 0, notSupported: 0, other: 0 }
  const last = Math.min(upTo, items.length - 1)
  for (let i = 0; i <= last; i++) {
    if (items[i].kind !== 'system_vote') continue
    const c = typeof items[i].detail?.choice === 'string' ? items[i].detail.choice : ''
    if (c === 'supported') out.supported++
    else if (c === 'not_supported') out.notSupported++
    else out.other++
  }
  return out
}

/** 前 upTo 筆事件（含）的各節點計數；items 須已排序 */
export function nodeCounts(items: readonly TraceItem[], upTo: number = items.length - 1): NodeCounts {
  const out: NodeCounts = {}
  const last = Math.min(upTo, items.length - 1)
  for (let i = 0; i <= last; i++) {
    const n = countNode(items[i])
    if (n) out[n] = (out[n] ?? 0) + 1
  }
  return out
}

/** 時間 t（毫秒）以前（含）有幾筆事件；二分搜尋，items 須已排序 */
export function indexAtOrBefore(items: readonly TraceItem[], t: number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].ms <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

// ---- 最活躍 ----

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
export const isUuid = (s: string): boolean => new RegExp(`^${UUID_RE.source}$`, 'i').test(s.trim())

/** 事件屬於哪個人物：優先用事件上的人物，再從缺口編號裡找 */
export function personOf(e: TraceEvent): string | null {
  if (e.politician_id) return e.politician_id.toLowerCase()
  return e.task_id ? personFromTaskId(e.task_id) : null
}

/** 缺口編號裡的人物 id（沒有回 null） */
export function personFromTaskId(taskId: string): string | null {
  const m = taskId.startsWith('auto:') ? UUID_RE.exec(taskId) : null
  return m ? m[0].toLowerCase() : null
}

/** 缺口編號 auto:<任務型別>:… 的任務型別；不是缺口回 null */
export function taskTypeOfId(taskId: string): string | null {
  if (!taskId.startsWith('auto:')) return null
  return taskId.split(':')[1] ?? null
}

export interface Active {
  kind: 'task' | 'person'
  id: string
  count: number
}

/** 事件數最多的任務與人物各 perKind 個 */
export function topActive(items: readonly TraceItem[], perKind = 10): Active[] {
  const tasks = new Map<string, number>()
  const people = new Map<string, number>()
  for (const e of items) {
    if (e.task_id) tasks.set(e.task_id, (tasks.get(e.task_id) ?? 0) + 1)
    const p = personOf(e)
    if (p) people.set(p, (people.get(p) ?? 0) + 1)
  }
  const top = (m: Map<string, number>, kind: Active['kind']): Active[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, perKind).map(([id, count]) => ({ kind, id, count }))
  return [...top(tasks, 'task'), ...top(people, 'person')]
}

// ---- 輸入 ----

export type Target =
  | { type: 'none' }
  | { type: 'task'; id: string }
  | { type: 'uuid'; id: string }
  | { type: 'name'; text: string }

/** 使用者貼的字：auto: 開頭是任務編號、uuid 可能是任務／交件／人物、其餘當人名 */
export function parseTarget(raw: string): Target {
  const s = raw.trim()
  if (!s) return { type: 'none' }
  if (s.toLowerCase().startsWith('auto:')) return { type: 'task', id: s }
  if (isUuid(s)) return { type: 'uuid', id: s.toLowerCase() }
  return { type: 'name', text: s }
}

// ---- 時間顯示（台北） ----

const TPE = 'Asia/Taipei'
const fmtFull = new Intl.DateTimeFormat('zh-TW', { timeZone: TPE, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const fmtClock = new Intl.DateTimeFormat('zh-TW', { timeZone: TPE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export const taipeiFull = (ms: number): string => fmtFull.format(ms)
export const taipeiClock = (ms: number): string => fmtClock.format(ms)

/** 兩個事件相隔多久：45 秒、12 分、3 小時 10 分、2 天 4 小時 */
export function gapText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 1) return '同時'
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小時${m % 60 ? ` ${m % 60} 分` : ''}`
  const d = Math.floor(h / 24)
  return `${d} 天${h % 24 ? ` ${h % 24} 小時` : ''}`
}

/** 時間段落：把 [from, to) 切成每段 stepMs 的小段（PostgREST 單次最多 1000 列，所以分段取） */
export function timeSlices(from: number, to: number, stepMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let a = from; a < to; a += stepMs) out.push([a, Math.min(a + stepMs, to)])
  return out
}
