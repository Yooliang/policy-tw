/**
 * 鄉鎮頁（/election/:年/:縣市/:鄉鎮，2026-10-05）：哪些參選紀錄算在某個鄉鎮市區、哪些鄉鎮要出一頁。
 *
 * 以前鄉鎮層只是縣市頁上的 ?sub= 篩選：客戶端渲染、canonical 指回縣市頁，搜尋引擎不當獨立頁。
 * 維護者 10-05 點頭改成路徑，讓約一千個鄉鎮頁可被收錄；舊的 ?sub= 由正見.tw 的 Worker 301 過來
 * （cloudflare/region-path.js）。
 *
 * 這裡的規則有三個讀者，必須是同一份：
 *   lib/ssg/page-data.ts     預渲染鄉鎮頁的資料切片（inTownship）
 *   lib/ssg/server-data.ts   要預渲染哪些鄉鎮頁、網站地圖收哪些（townshipPagesOf）
 *   get_politicians_by_level 瀏覽器端撈鄉鎮頁的 RPC（SQL，migration 20261005000001）——inTownship 照它寫
 * 預渲染帶的人跟瀏覽器撈的人對不上的話，hydrate 之後畫面會先有人再消失（或反過來）。
 *
 * 零依賴（只用同樣零依賴的 election-levels／region-name／township-directory），能被 deno 直接測。
 */
import { positionsToLoad, type PositionType } from './election-levels'
import { normalizeRegionName } from './region-name'
import { townshipNameOf } from './township-directory'

/**
 * 參選紀錄的 sub_region 屬於這個鄉鎮市區嗎？跟 get_politicians_by_level 的 p_sub_region 同一套規則：
 *   等值（里長、鄉鎮市長、代表：「那瑪夏區」）
 *   或「鄉鎮名＋第…選舉區」（原住民區代表：「那瑪夏區第01選舉區」）
 * 兩邊都先把「臺」換成「台」（lib/region-name.ts）。只做等值的話，原住民區那一層整個會漏掉。
 */
export function inTownship(subRegion: string | null | undefined, township: string): boolean {
  const sub = normalizeRegionName(subRegion)
  const t = normalizeRegionName(township)
  if (!sub || !t) return false
  if (sub === t) return true
  // SQL 是 LIKE t || '第%選舉區'：% 可以是空字串，所以長度只要求放得下「第」與「選舉區」
  return sub.startsWith(`${t}第`) && sub.endsWith('選舉區') && sub.length >= t.length + '第選舉區'.length
}

/**
 * 參選紀錄的 sub_region → 它屬於哪個鄉鎮市區（原住民區代表的「那瑪夏區第01選舉區」→「那瑪夏區」）。
 * 去掉選舉區後是空的（縣市議員的「第01選舉區」）或還帶著「選區」字樣（立委的「臺北市第01選區」）就不是鄉鎮，回 null。
 */
export function townshipOfSubRegion(subRegion: string | null | undefined): string | null {
  // 去掉選舉區的規則跟名錄、麵包屑同一條（lib/township-directory.ts 的 townshipNameOf）
  const township = townshipNameOf(subRegion?.trim())
  if (!township || /選區/.test(township)) return null
  return township
}

/** 判斷鄉鎮頁內容要用到的參選紀錄欄位（PoliticianElectionData 的子集） */
export interface TownshipRecord {
  electionId: number
  region: string
  subRegion?: string | null
  electionType?: string | null
}

/** 這個縣市的鄉鎮頁要列哪些職位：跟瀏覽器端同一份（lib/election-levels.ts 的 positionsToLoad，鄉鎮層） */
export function townshipPositions(isSpecialMunicipality: boolean): readonly PositionType[] {
  return positionsToLoad({ region: '縣市', subRegion: '鄉鎮', isSpecialMunicipality })
}

export interface TownshipPage {
  electionId: number
  region: string
  township: string
}

/**
 * 要出頁的鄉鎮：某一屆、某縣市、某鄉鎮市區裡，至少有一位「鄉鎮頁會列出來的職位」的參選人。
 * 一位都沒有的鄉鎮（例如 2026 還沒登記的）不出頁也不進網站地圖——空頁被收錄只是佔位；
 * 舊網址轉過去照樣打得開（firebase.json 讓沒預渲染的鄉鎮頁回 app 殼、客戶端渲染、noindex）。
 *
 * records 只要傳「在選的」參選紀錄（not_running 先濾掉，跟頁面一致）；isCounty／isSpecialMunicipality 由呼叫端給，
 * 這支檔案不依賴縣市清單。同一個鄉鎮的「臺」「台」兩種寫法算同一頁，網址用先看到的寫法（資料裡目前沒有兩種並存）。
 */
export function townshipPagesOf(
  records: Iterable<TownshipRecord>,
  isCounty: (region: string) => boolean,
  isSpecialMunicipality: (region: string) => boolean,
): TownshipPage[] {
  const pages = new Map<string, TownshipPage>()
  for (const r of records) {
    if (!isCounty(r.region)) continue
    if (!r.electionType || !townshipPositions(isSpecialMunicipality(r.region)).includes(r.electionType as PositionType)) continue
    const township = townshipOfSubRegion(r.subRegion)
    if (!township) continue
    const key = `${r.electionId}|${normalizeRegionName(r.region)}|${normalizeRegionName(township)}`
    if (!pages.has(key)) pages.set(key, { electionId: r.electionId, region: r.region, township })
  }
  // 順序只求每次建置都一樣（網站地圖另外排過），用字碼比，不依賴執行環境的中文排序規則
  const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return [...pages.values()].sort((a, b) =>
    a.electionId - b.electionId || byCode(a.region, b.region) || byCode(a.township, b.township))
}
