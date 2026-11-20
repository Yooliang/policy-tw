/**
 * 完整關係圖（#675 第四期）的型別與版面常數。排版在 lib/lineage-graph.ts（純函式），元件只負責畫。
 * 零執行期依賴（只有型別），deno 直接測。
 */
import type { DatePrecision, HandoverType, Lineage, LineageEventType, LineageLevel, LineageSource, Policy, StanceKind } from '../types'

/** 視圖 lineage_terms 的一列（#675 第一期）：脈絡涉及的人的任期＋單席首長職位的歷任 */
export interface GraphTermRow {
  politicianId: string
  name: string
  electionType: string
  region: string | null
  subRegion: string | null
  startDate: string | null
  scheduledEndDate: string | null
  endDate: string | null
  /** 這一任的人本身涉及這條脈絡（不是只為了讓單席職位的歷任連得起來才帶進來） */
  involved: boolean
}

export interface GraphInput {
  lineage: Pick<Lineage, 'id' | 'title' | 'stances' | 'events' | 'handovers' | 'policyIds' | 'participants'>
  policies: ReadonlyArray<Pick<Policy, 'id' | 'title' | 'politicianId' | 'status' | 'proposedDate' | 'electionId'>>
  terms: readonly GraphTermRow[]
  electionDates: ReadonlyMap<number, string>
  nameOf: (politicianId: string) => string | undefined
  /** 台北今天（YYYY-MM-DD），函式本身不讀時鐘 */
  today: string
  /** 還沒開票的下一場選舉的投票日；沒有就不畫「下一任」虛線框 */
  upcomingElectionDate?: string | null
  /** 泳道上限，預設 16，其餘折成「另 N 個職位」 */
  maxLanes?: number
  /** 展開被折起來的職位 */
  expandLanes?: boolean
  /** 展開較舊的事件與立場（超過 60 筆時預設只留最新 60 筆） */
  expandOld?: boolean
}

export type LaneKind = 'events' | 'position' | 'folded' | 'other'
export type MarkKind = 'policy' | 'stance' | 'event' | 'handover' | 'gap'
export type TermStatus = 'current' | 'past' | 'next'
/** 政見點的顏色鍵：推動中藍、已實現綠、滯後琥珀、跳票紅，其餘（提出、承諾）灰 */
export type PolicyTone = 'progress' | 'achieved' | 'stalled' | 'failed' | 'proposed'
/** 標籤的顏色鍵：立場、事件、政見進度、交接型態，沒有紀錄的交接是 unrecorded */
export type MarkTone = StanceKind | LineageEventType | PolicyTone | HandoverType | 'unrecorded'

export interface GraphLane {
  key: string
  kind: LaneKind
  /** 單席首長職位（縣市長、鄉鎮市長、區長、總統）：一條泳道依序排任期；其餘多席職位依人堆疊 */
  single: boolean
  label: string
  /** 地方（全國／台中市／台中市大雅區）；事件、其他、折疊泳道是空字串 */
  place: string
  level: LineageLevel | null
  y: number
  h: number
  /** 任期條佔幾列 */
  barRows: number
}

export interface GraphBar {
  id: string
  laneKey: string
  politicianId: string
  name: string
  /** 任期起訖（顯示用，已裁掉跟下一任重疊的部分）；虛線框的迄是 null */
  start: string
  end: string | null
  status: TermStatus
  x: number
  w: number
  y: number
  h: number
  /** 虛線框上寫的字（例：「11/28 開票後」）；其餘是空字串 */
  caption: string
}

export interface GraphMark {
  id: string
  kind: MarkKind
  laneKey: string
  /** 這一筆實際的日期（清單排序用） */
  date: string
  x: number
  y: number
  tone: MarkTone
  label: string
  disputed: boolean
}

export interface GraphArrow {
  id: string
  eventId: string
  x1: number
  y1: number
  x2: number
  y2: number
  note: string | null
}

export interface GraphTick { x: number; label: string }

/** 抽屜與清單用的詳情（原文摘句、出處、日期、備註） */
export interface ItemDetail {
  date: string | null
  datePrecision: DatePrecision
  quote: string | null
  text: string | null
  note: string | null
  condition: string | null
  decidedBy: string | null
  person: { id: string; name: string } | null
  toPerson: { id: string; name: string } | null
  initiator: { id: string; name: string; note: string | null } | null
  source: LineageSource | null
  sourceUrl: string
  sourceLocator: string
  policyId: string | null
  disputed: boolean
}

/** 時序清單的一筆（手機版主體、桌機版給讀屏）：與圖上的標籤一對一，id 相同 */
export interface GraphItem {
  id: string
  kind: MarkKind
  date: string | null
  laneKey: string
  place: string
  person: string
  label: string
  text: string
  tone: MarkTone
  disputed: boolean
  detail: ItemDetail
}

export interface YearGroup { year: string; items: GraphItem[] }
export interface PlaceChip { key: string; label: string; count: number }

export interface GraphModel {
  width: number
  height: number
  /** 左邊泳道名稱欄的寬度（圖的 x 從這裡開始） */
  labelWidth: number
  lanes: GraphLane[]
  bars: GraphBar[]
  marks: GraphMark[]
  arrows: GraphArrow[]
  ticks: GraphTick[]
  /** 「今天」線；不在時間範圍內是 null */
  todayX: number | null
  /** 被折起來的職位數（已展開是 0） */
  foldedLanes: number
  /** 預設收合掉的較舊事件、立場筆數 */
  collapsed: { stances: number; events: number }
  items: GraphItem[]
  participantNames: string[]
  /** 沒有任期、沒有任何標籤：頁面顯示「尚無」 */
  empty: boolean
}

export const LAYOUT = {
  labelWidth: 148,
  rightPad: 24,
  axisHeight: 30,
  barHeight: 22,
  barGap: 6,
  markHeight: 22,
  lanePad: 8,
  pxPerYear: 110,
  minWidth: 640,
  /** 標籤佔的寬度（疊列用）：政見點、立場、交接、事件 */
  markWidth: { policy: 16, stance: 72, handover: 76, gap: 76, event: 84 },
  maxLanes: 16,
  /** 超過這麼多筆事件或立場，預設只留最新的這麼多筆 */
  historyLimit: 60,
} as const

export const OTHER_LANE_KEY = '__other__'
export const EVENTS_LANE_KEY = '__events__'
export const FOLDED_LANE_KEY = '__folded__'

/** SVG 與文字版用的顏色（hex）：立場支持綠、反對紅、有條件琥珀；交接照舊做綠、改做法藍、縮小黃、停掉紅、重新開始紫 */
export const TONE_COLOR: Readonly<Record<string, string>> = {
  support: '#059669', oppose: '#dc2626', conditional: '#d97706',
  progress: '#2563eb', achieved: '#059669', stalled: '#d97706', failed: '#dc2626', proposed: '#64748b',
  keep: '#059669', pivot: '#2563eb', shrink: '#d97706', stop: '#dc2626', resume: '#7c3aed', unrecorded: '#94a3b8',
}
export const EVENT_COLOR = '#475569'
