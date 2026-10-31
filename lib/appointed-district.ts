/**
 * 直轄市一般區（非山地原住民區）的區長由市政府派任、沒有區民代表選舉：
 * 「鄉鎮市區長」「鄉鎮市區民代表」分頁在這些區要變灰，內容區寫「市政府派任，無此類選舉」。
 * 判斷不維護名單：看選區資料（data/tw-districts 的區代表選區）與候選人資料有沒有這個區。
 */
export const APPOINTED_EMPTY_TEXT = '市政府派任，無此類選舉'

export interface IndigenousInput {
  /** 直轄市（有選縣市、不是全台） */
  isSpecialMunicipality: boolean
  /** 目前選的鄉鎮市區（'All'＝縣市層級） */
  sub: string
  /** 候選人資料裡該縣市的原民區長／區代表所在區 */
  indigenousDistricts: string[]
  /** 選區資料裡區代表選區的鄉鎮代碼 */
  repKeys: string[]
  countyCode?: string | null
  townCode?: string | null
  sameName: (a: string, b: string) => boolean
}

/** 目前地區是否為「有」區長／區代表選舉的原住民區（縣市層級：該市有任一原民區即 true） */
export function hasIndigenousElection(i: IndigenousInput): boolean {
  if (i.sub === 'All') return i.indigenousDistricts.length > 0 || (!!i.countyCode && i.repKeys.some(k => k.startsWith(i.countyCode!)))
  return i.indigenousDistricts.some(d => i.sameName(d, i.sub)) || (!!i.townCode && i.repKeys.includes(i.townCode))
}

/** 直轄市、已選到某一區、且不是原民區 → 區長派任、無區民代表 */
export function isAppointedDistrict(i: IndigenousInput): boolean {
  return i.isSpecialMunicipality && i.sub !== 'All' && !hasIndigenousElection(i)
}
