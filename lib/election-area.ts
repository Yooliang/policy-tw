/**
 * 某一屆參選的地區（縣市／鄉鎮或選區／村里）要從哪裡來（2026-10-05）。
 *
 * 縣市長、縣市議員、立委、總統：只看那一屆參選紀錄自己指的地區，**不借人物的鄉鎮村里**。
 * 以前沒有選區的議員紀錄會退回人物的地區——陳映辰 2026 議員那一筆借到她 2022 當里長的「大雅區 上雅里」、
 * 張烱春借到他 2024 參選立委的「臺中市第03選區」——縣市頁就冒出「縣市議員・大雅區」這種假選區；
 * 借到的如果剛好是上一屆的議員選區，看起來像真的，其實沒人查過（楊寶楨顯示第03、名冊是第11）。
 * 沒有就是沒有：畫面列「選區待補」，等補選區任務補上。
 *
 * 鄉鎮層級五種（鄉鎮市長、代表、村里長、原住民區長與區代表）照舊可以退回人物的鄉鎮村里：
 * 那幾種的地區本來就在鄉鎮村里，參選紀錄沒有地區時退回人物的是既有行為（township_gap 任務補上之後就不再退）。
 *
 * 視圖 politicians_with_elections 的 elections[].subRegion／village 也照同一條規則（migration 20261005004100）；
 * 這裡再守一次，是因為前端還會在「這一屆沒給」時拿人物層的值補（withElectionData、withCurrentElectionData）。
 */

import { isFormalDistrict } from './district-grouping'

export const COUNTY_LEVEL_ELECTION_TYPES: readonly string[] = ['總統副總統', '縣市長', '縣市議員', '立法委員']

export interface AreaLike {
  region?: string
  subRegion?: string
  village?: string
}

export function electionArea(
  electionType: string | undefined,
  election: AreaLike | undefined,
  person: AreaLike,
): { region: string; subRegion: string | undefined; village: string | undefined } {
  const ownOnly = !!electionType && COUNTY_LEVEL_ELECTION_TYPES.includes(electionType)
  if (ownOnly) {
    // 議員、立委只認自己這一屆的正式選區寫法；縣市長、總統沒有縣市以下的地區。
    // 視圖改好之前（或舊快照裡）這一屆的 subRegion 可能還是借來的「大雅區」，這裡也不收
    const own = election?.subRegion?.trim()
    return {
      region: election?.region || person.region || '',
      subRegion: own && isFormalDistrict(own, electionType) ? own : undefined,
      village: undefined,
    }
  }
  return {
    region: election?.region || person.region || '',
    subRegion: election?.subRegion || person.subRegion || undefined,
    village: election?.village || person.village || undefined,
  }
}
