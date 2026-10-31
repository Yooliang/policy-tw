/**
 * 桌面版延伸欄的「層級」「縣市」兩組清單——選舉頁與人物頁共用同一份（2026-11-01 小良哥）：
 * 選舉頁用按鈕（點了呼叫選舉頁自己的函式），人物頁用連結（點了到該屆選舉頁對應的分頁與縣市）。
 * 兩邊只差「每一項怎麼做出來」（make），層級順序、名稱、縣市清單都在這裡。
 */
import { ElectionType } from '../types'
import type { DeskGroup, DeskItem } from '../composables/useDeskNav'
import { positionSpec } from './election-levels'
import { SPECIAL_MUNICIPALITIES, TAIWAN_COUNTIES } from './election-regions'

/** 層級分頁（固定五個，順序＝選舉頁分頁條） */
export const LEVEL_TAB_TYPES: string[] = [ElectionType.MAYOR, ElectionType.COUNCILOR, ElectionType.TOWNSHIP_MAYOR, ElectionType.REPRESENTATIVE, ElectionType.CHIEF]

/** 顯示用名稱：鄉鎮市長→鄉鎮市區長、鄉鎮市民代表→鄉鎮市區民代表（只改畫面文字；資料庫值、錨點與比對一律用原名） */
const DISPLAY_LABELS: Record<string, string> = { 鄉鎮市長: '鄉鎮市區長', 鄉鎮市民代表: '鄉鎮市區民代表' }
export const displayLabel = (label: string) => DISPLAY_LABELS[label] ?? label

/** 分頁與區塊標題用的名稱；直轄市頁的「縣市長」「縣市議員」叫「直轄市長」「直轄市議員」 */
export function levelTabLabel(type: string, region: string): string {
  if (region !== 'All' && (SPECIAL_MUNICIPALITIES as readonly string[]).includes(region)) {
    if (type === ElectionType.MAYOR) return '直轄市長'
    if (type === ElectionType.COUNCILOR) return '直轄市議員'
  }
  return displayLabel(positionSpec(type)?.label ?? type)
}

export type DeskItemMaker = (kind: 'level' | 'county', key: string, label: string, active: boolean, dim?: boolean) => DeskItem

/** 層級＋縣市兩組；activeType／region（'All'＝全台）決定哪一項標成選中 */
export function levelCountyGroups(activeType: string, region: string, make: DeskItemMaker, levelDim: (type: string) => boolean = () => false): DeskGroup[] {
  return [
    { key: 'levels', title: '層級', blocks: [LEVEL_TAB_TYPES.map(t => make('level', t, levelTabLabel(t, region), t === activeType, levelDim(t)))] },
    { key: 'county', title: '縣市', blocks: [[
      make('county', 'All', '全台', region === 'All'),
      ...TAIWAN_COUNTIES.map(c => make('county', c, c, region === c)),
    ]] },
  ]
}
