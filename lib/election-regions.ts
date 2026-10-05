/**
 * 縣市頁（/election/:electionId/:region，2026-09-30）共用的清單與網址。
 *
 * 以前縣市只存在於查詢字串（/election/2026?region=台北市），搜尋引擎通常不把它當獨立頁，
 * 於是議員、鄉鎮市長、村里長的人物頁幾乎沒有頁面連過去。改成路徑之後：
 * 選舉頁 → 縣市頁 → 人物頁 三層都是真連結，頁尾、首頁、人物頁的麵包屑也都連得到縣市頁。
 */

/** 22 縣市，順序同縣市選擇器（六都在前） */
export const SPECIAL_MUNICIPALITIES = ['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市'] as const
export const OTHER_COUNTIES = [
  '基隆市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義市',
  '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣',
] as const
export const TAIWAN_COUNTIES: readonly string[] = [...SPECIAL_MUNICIPALITIES, ...OTHER_COUNTIES]

/** 頁尾、首頁那排縣市連結指的屆別（下一場地方選舉） */
export const FEATURED_LOCAL_ELECTION_ID = 2026

export function isCounty(value: string | undefined | null): value is string {
  return !!value && TAIWAN_COUNTIES.includes(value)
}

/** 縣市頁網址（中文用 encodeURIComponent；sitemap、canonical 與站內連結都用同一種寫法） */
export function electionRegionPath(electionId: number | string, region: string): string {
  return `/election/${electionId}/${encodeURIComponent(region)}`
}

/**
 * 鄉鎮市區頁網址（2026-10-05）：/election/2022/嘉義縣/大林鎮，寫法同縣市頁。
 * **站內所有指向鄉鎮頁的連結都從這裡產生**（選舉頁右側鄉鎮、人物頁與政見頁的麵包屑 lib/election-breadcrumbs.ts）。
 * 以前鄉鎮只在查詢字串（/election/2022/嘉義縣?sub=大林鎮），canonical 指回縣市頁、搜尋引擎不當獨立頁；
 * 舊網址由正見.tw 的 Worker 301 過來（cloudflare/region-path.js），客戶端也會換成這個寫法。
 */
export function electionTownshipPath(electionId: number | string, region: string, township: string): string {
  return `${electionRegionPath(electionId, region)}/${encodeURIComponent(township)}`
}

/** 選舉頁網址：有縣市就是縣市頁，再有鄉鎮就是鄉鎮頁，否則是全台 */
export function electionPath(electionId: number | string, region?: string | null, township?: string | null): string {
  if (!isCounty(region)) return `/election/${electionId}`
  const t = township?.trim()
  return t && t !== 'All' ? electionTownshipPath(electionId, region, t) : electionRegionPath(electionId, region)
}
