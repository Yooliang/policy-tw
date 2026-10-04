/**
 * 直轄市的「區」分兩種，選舉頁（ElectionPage.vue）選到鄉鎮市區層級時要分流顯示：
 * - 一般區：區長由市政府指派，沒有區長／區代表選舉，只有里長選舉。
 * - 原住民區（山地原住民區）：區長、區代表都是民選，另外還有里長選舉。
 * 縣轄鄉鎮市（非直轄市）則是另一套（鄉鎮市長、代表、村里長都是民選），不屬於這裡要分的兩種。
 *
 * 判斷依據是資料本身：這個區的參選人裡有沒有「直轄市山地原住民區長／區代表」這兩種候選人。
 * 不維護「哪個直轄市有哪些原住民區」的名單——現有山地原住民區只有新北烏來、桃園復興、
 * 台中和平、高雄那瑪夏／桃源／茂林六個，但這份名單不該由前端硬編：
 * 行政區劃或選制调整時，資料（politician_elections.election_type）會先變，程式不用跟著改。
 */
export type WardKind = 'rural' | 'indigenous' | 'plain'

export interface WardClassificationInput {
  /** 選定的縣市是不是六都（直轄市）；不是的話一律是縣轄鄉鎮市 */
  isSpecialMunicipality: boolean
  /** 這個區裡有沒有原住民區長或區代表的候選人紀錄 */
  hasIndigenousRace: boolean
}

export function classifyWard({ isSpecialMunicipality, hasIndigenousRace }: WardClassificationInput): WardKind {
  if (!isSpecialMunicipality) return 'rural'
  return hasIndigenousRace ? 'indigenous' : 'plain'
}
