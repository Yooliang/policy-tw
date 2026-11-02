/** 桌面版延伸欄的資料形狀（獨立成檔：純函式 lib 與測試不必經過 composables 的瀏覽器 API） */
export interface DeskItem {
  key: string
  label: string
  active: boolean
  /** 有 to 就是連結（預渲染也走得到）；沒有就是按鈕，點了呼叫 select */
  to?: string
  select?: () => void
  /** 淡色（仍可點）：例如直轄市一般區沒有的選舉類別 */
  dim?: boolean
}
export interface DeskGroup {
  key: string
  title: string
  /** 同一組內再分塊（內容類型：候選人｜承諾｜PK ‖ 串聯｜矩陣），塊與塊之間畫分隔線 */
  blocks: DeskItem[][]
}
export interface DeskNavModel {
  title: string
  groups: DeskGroup[]
}
