/**
 * 統計頁「各模型表現」的計算（2026-10-03）。彙總在資料庫做（model_contribution_stats／model_vote_stats，
 * migration 20261003000003），這裡只把件數換成比例、排序、挑出細表要列的型別。
 *
 * 上線率、退件率的分母是 applied＋rejected（維護者 2026-10-03）：撤回（例如 9/18 整批撤回）、被取代（被更新資料蓋過）
 * 跟品質無關，拿全部交件當分母會把比例拉低。那些狀態另外分欄列件數，加總對得回交件數。
 */

export interface RawTool { tool: string | null; n: number }

export interface ContribStatsRow {
  model: string
  contribution_type: string | null
  submitted: number
  applied: number
  rejected: number
  pending: number
  verified: number
  disputed: number
  superseded: number
  withdrawn: number
  other_status: number
  no_change: number
  no_change_missing: number
  data_decided: number
  data_rejected: number
  raw_tools: RawTool[] | null
}

export interface VoteStatsRow {
  model: string
  votes: number
  agree: number
  disagree: number
  unsure: number
  wrong: number
  raw_tools: RawTool[] | null
}

/** 一個比例：分子、分母（畫面上分母要跟著顯示，樣本少的淡色） */
export interface Ratio { num: number; den: number }

/** 細表只列 n ≥ 這個數的模型×型別 */
export const MIN_TYPE_N = 10
/** 分母小於這個數的比例淡色標示 */
export const SMALL_SAMPLE = 30
/** 期間選項（天），預設 14 */
export const MODEL_STATS_DAYS = [7, 14, 30] as const
export const DEFAULT_MODEL_STATS_DAYS = 14

/** 排在最後的兩列：不是一個模型 */
const TAIL = ['其他', '未填']

export const CONTRIBUTION_TYPE_LABEL: Readonly<Record<string, string>> = {
  policy: '新增政見',
  no_change: '無異動',
  politician: '人物資料',
  candidacy: '參選紀錄',
  policy_progress: '政見進度',
  correction: '資料更正',
  task_suggestion: '任務提議',
  roster_check: '名單清查',
  district_seats: '應選名額',
  election_results: '整批選舉結果',
  reassign_candidacy: '參選紀錄改掛',
  question_answer: '提問回答',
  removal: '建議移除',
  merge_politician: '人物合併',
  adjudication: '裁決',
  policy_elements: '政見三要素',
  lineage: '政策脈絡',
  lineage_participants: '脈絡參與角色',
  lineage_handover: '脈絡交接',
  lineage_link: '脈絡上下級',
  party_info: '政黨資訊',
}

const n = (v: unknown): number => Number(v ?? 0) || 0
const ratio = (num: unknown, den: unknown): Ratio => ({ num: n(num), den: n(den) })

export interface ContribTypeSummary {
  type: string
  label: string
  submitted: number
  applied: Ratio
  rejected: Ratio
  waiting: number
}

export interface ContribModelSummary {
  model: string
  submitted: number
  applied: Ratio
  rejected: Ratio
  waiting: number
  superseded: number
  withdrawn: number
  other: number
  noChangeMissing: Ratio
  dataRejected: Ratio
  rawTools: RawTool[]
}

function byVolume<T extends { model: string }>(size: (x: T) => number) {
  // 一般模型 0、其他 1、未填 2；同一級依量由多到少
  const rank = (m: string) => TAIL.indexOf(m) + 1
  return (a: T, b: T) => rank(a.model) - rank(b.model) || size(b) - size(a) || a.model.localeCompare(b.model)
}

export function summarizeContributions(rows: readonly ContribStatsRow[]): { models: ContribModelSummary[]; byType: Map<string, ContribTypeSummary[]> } {
  const models: ContribModelSummary[] = []
  const byType = new Map<string, ContribTypeSummary[]>()
  for (const r of rows) {
    const decided = n(r.applied) + n(r.rejected)
    const waiting = n(r.pending) + n(r.verified) + n(r.disputed)
    if (r.contribution_type === null) {
      models.push({
        model: r.model,
        submitted: n(r.submitted),
        applied: ratio(r.applied, decided),
        rejected: ratio(r.rejected, decided),
        waiting,
        superseded: n(r.superseded),
        withdrawn: n(r.withdrawn),
        other: n(r.other_status),
        noChangeMissing: ratio(r.no_change_missing, r.no_change),
        dataRejected: ratio(r.data_rejected, r.data_decided),
        rawTools: (r.raw_tools ?? []).map((t) => ({ tool: t.tool, n: n(t.n) })),
      })
    } else if (n(r.submitted) >= MIN_TYPE_N) {
      const list = byType.get(r.model) ?? []
      list.push({
        type: r.contribution_type,
        label: CONTRIBUTION_TYPE_LABEL[r.contribution_type] ?? r.contribution_type,
        submitted: n(r.submitted),
        applied: ratio(r.applied, decided),
        rejected: ratio(r.rejected, decided),
        waiting,
      })
      byType.set(r.model, list)
    }
  }
  models.sort(byVolume((m) => m.submitted))
  for (const list of byType.values()) list.sort((a, b) => b.submitted - a.submitted)
  return { models, byType }
}

export interface VoteModelSummary {
  model: string
  votes: number
  agree: Ratio
  unsure: Ratio
  /** 事後證明投錯：(同意但退件＋反對但上線) ÷ (同意＋反對) */
  wrong: Ratio
  rawTools: RawTool[]
}

export const SYSTEM_VOTE_MODEL = '系統票（Jev）'

export function summarizeVotes(rows: readonly VoteStatsRow[]): { models: VoteModelSummary[]; system: VoteModelSummary | null } {
  const all = rows.map((r): VoteModelSummary => ({
    model: r.model,
    votes: n(r.votes),
    agree: ratio(r.agree, r.votes),
    unsure: ratio(r.unsure, r.votes),
    wrong: ratio(r.wrong, n(r.agree) + n(r.disagree)),
    rawTools: (r.raw_tools ?? []).map((t) => ({ tool: t.tool, n: n(t.n) })),
  }))
  return {
    models: all.filter((m) => m.model !== SYSTEM_VOTE_MODEL).sort(byVolume((m) => m.votes)),
    system: all.find((m) => m.model === SYSTEM_VOTE_MODEL) ?? null,
  }
}

/** 10% 以下留一位小數（投錯率多在 1～3%，整數看不出差別）；分母 0 顯示破折號 */
export function formatPct(r: Ratio): string {
  if (r.den <= 0) return '—'
  const pct = (r.num / r.den) * 100
  // 9.95 而不是 10：9.98% 四捨五入是「10.0%」，那就直接寫 10%
  return pct > 0 && pct < 9.95 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`
}

export const isSmallSample = (r: Ratio): boolean => r.den < SMALL_SAMPLE
