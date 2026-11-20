/**
 * 政策脈絡主頁（pages/LineagePage.vue，#675 第三期）上所有的靜態文字，白名單在這一個檔。
 *
 * 規則（計畫書 5.1「讓資料自己說話」）：主頁除了標籤與出處，不放任何解釋規則、排序方式、方法論的句子，
 * 也不寫系統詞（表名、臂名、起跑日、派工）。模板裡不准有靜態中文，要字就從這裡取；
 * 這個檔每個字串都是標籤（短、沒有句號），`lib/lineage-page.test.ts` 逐一盯：多放一句說明就紅。
 * 沒有資料時寫白話標籤（「未調查」「尚無」），不寫「開發中」「第 N 期才有」。
 *
 * 零執行期依賴，可被 deno 直接測。
 */

export const PAGE_LABELS = {
  // 標題列
  hosted: '主辦',
  coverage: '涵蓋',
  belongsTo: '屬於',
  coverageMore: '另',
  coverageUnit: '處',
  back: '返回',
  // 現況
  status: '現況',
  statusEmpty: '尚無現況紀錄',
  asOf: '截至',
  source: '出處',
  archive: '存檔',
  // 這件事（摘要）
  summary: '這件事',
  // 各方立場
  stances: '各方立場',
  stancesEmpty: '尚無立場紀錄',
  derivedStance: '僅提出政見',
  changedStance: '立場曾變',
  // 有爭議的立場／事件：公開仍顯示，加這個標示
  disputed: '有爭議',
  // 大事記
  chronicle: '大事記',
  chronicleEmpty: '尚無',
  chronicleMore: '更多',
  handoverMissing: '尚無交接紀錄',
  handoverBasis: '依據',
  // 筆數列
  countPolicies: '政見',
  countHandovers: '交接',
  countEvents: '事件',
  countStances: '立場',
  unitPolicy: '條',
  unitItem: '筆',
  // 脈絡裡的政見
  policies: '脈絡裡的政見',
  policiesEmpty: '尚無',
  // 參與者與角色
  participants: '參與者與角色',
  participantsEmpty: '尚無',
  noOfficialRole: '尚無官方紀錄',
  // 上下級
  links: '上下級脈絡',
  upper: '上級',
  lower: '下級',
  linksEmpty: '尚無',
  // 載入中與找不到
  loading: '載入中',
  notFound: '找不到這條政策脈絡',
  allLineages: '所有政策脈絡',
  unnamed: '姓名待查',
  // 完整關係圖（#675 第四期，pages/LineageGraphPage.vue 與 components/LineageGraph*.vue 共用這一份白名單）
  viewGraph: '看完整關係圖 →',
  graph: '完整關係圖',
  graphBack: '返回脈絡主頁',
  graphLoadFailed: '關係圖資料',
  otherIdentity: '其他（身分待查）',
  eventsLane: '事件',
  foldedSuffix: '個職位',
  expand: '展開',
  collapse: '收合',
  afterVote: '開票後',
  today: '今天',
  handoverUnrecorded: '尚未記錄',
  termCurrent: '現任',
  termPast: '已卸任',
  termNext: '下一任',
  quote: '原文',
  locator: '出處位置',
  note: '備註',
  close: '關閉',
  condition: '條件',
  decidedBy: '決定機關',
  initiator: '推動者',
  policyPage: '政見頁',
  timeline: '時序清單',
  participantsLine: '參與者',
  filterAll: '全部',
  showOlder: '展開較舊的',
  hideOlder: '收合較舊的',
  undated: '日期未定',
  yearUnit: '年',
  person: '人物',
  contains: '包含',
  containsHeading: '大計畫與項目',
} as const

export type PageLabelKey = keyof typeof PAGE_LABELS

/** 現況階段標籤（跟後端 _shared/lineage.ts 的 STATUS_PHASE_LABEL 同一份，lib/lineage-page.test.ts 盯兩邊一致） */
export const STATUS_PHASE_LABEL: Readonly<Record<string, string>> = {
  proposed: '提案階段', planning: '規劃中', approved: '已核定', in_progress: '進行中', completed: '已完成', paused: '暫緩', cancelled: '已終止',
}

/** 標籤的長度上限：超過就不是標籤、是一句說明了 */
export const LABEL_MAX_LENGTH = 10
