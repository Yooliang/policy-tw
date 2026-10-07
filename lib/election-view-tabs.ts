import { electionPath } from './election-regions'

/**
 * 選舉頁 Hero 的檢視頁籤，選舉頁與政見矩陣頁共用（維護者 2026-10-07：矩陣頁進去要像第五個頁籤，頁首一致）。
 * VIEW_MODES 是網址參數 ?view= 的合法值；VIEW_TABS 是頁籤的文字（圖示在 components/ElectionHero.vue）。
 * short 是手機版用的兩字短標（使用者 2026-09-19：四顆要放進一排）。
 */
export const VIEW_MODES = ['politicians', 'pledges', 'issues', 'comparison'] as const
export type ElectionViewMode = typeof VIEW_MODES[number]

export const VIEW_TABS: ReadonlyArray<{ key: ElectionViewMode; label: string; short: string }> = [
  { key: 'politicians', label: '候選人', short: '候選人' },
  { key: 'pledges', label: '競選承諾', short: '承諾' },
  { key: 'issues', label: '議題串聯', short: '串聯' },
  { key: 'comparison', label: '政見 PK', short: 'PK' },
]

/**
 * 從別的頁回到選舉頁開某個檢視：預設的「候選人」不帶參數（跟 useRegionQuerySync 寫網址的規則一致）；
 * 給了縣市就回那個縣市頁（/election/2026/台南市?view=pledges），沒給或是「全台」就回全台頁。
 */
export function electionViewLink(segment: number | string, view: ElectionViewMode, region?: string | null): { path: string; query?: { view: ElectionViewMode } } {
  const path = electionPath(segment, region)
  return view === 'politicians' ? { path } : { path, query: { view } }
}
