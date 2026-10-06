/**
 * 人物頁、政見頁的麵包屑（2026-10-05）：年 › 縣市 ›（鄉鎮）› 職位 › 人物 ›（政見）。
 *
 *   2026 九合一選舉 › 金門縣 › 縣市長候選人 › 梁文韜
 *   2026 九合一選舉 › 金門縣 › 縣市議員候選人（第01選舉區） › 戴德滿
 *   2022 九合一選舉 › 金門縣 › 金城鎮 › 村里長參選人（東門里） › 蔡祥坤
 *
 * 這支只管「年到職位」那幾層，人物與政見那兩層由頁面自己接在後面。
 * 純函式：預渲染、邊緣 SSR（Worker）、瀏覽器三邊共用同一份，輸出才會一致（hydrate 不會對不上）。
 * 頁面元件不再自己組——兩頁各組一份，遲早一頁加了層級、另一頁忘了。
 *
 * 規則：
 *   - 職位名稱從分層設定（lib/election-levels.ts 的 POSITIONS）取，這裡不另寫對照。
 *   - 還沒投票的屆寫「候選人」，已投票的屆寫「參選人」。投票當天還沒結束，仍是候選人。
 *   - 在鄉鎮之下的職位（鄉鎮市長、鄉鎮市民代表、原住民區長、區代表、村里長）多一層鄉鎮。
 *   - 分組顯示的職位（議員、區代表依選舉區；村里長依里）帶上組名，例如「（第01選舉區）」。
 *   - 職位那層連到「同選區、同職位」的區塊：該頁的頁內錨點（#縣市長、#縣市議員-第01選舉區），
 *     錨點由 lib/election-levels.ts 的 sectionAnchor 產生，選舉頁畫區塊時用的是同一個函式。
 *     網址仍是那一頁，不新增可收錄的頁面。
 */
import { positionSpec, sectionAnchor, type PositionSpec } from './election-levels'
import { electionRegionPath, electionTownshipPath, isCounty } from './election-regions'
import { townshipNameOf } from './township-directory'
import { isFormalDistrict } from './district-grouping'
import { pkGroupLabel, pkQuery } from './policy-compare'

/** 跟 composables/usePageHead 的 BreadcrumbItem 同形；這支要零依賴（deno 直接測），所以不 import 它 */
export interface Crumb {
  name: string
  path?: string
}

/** 一筆參選紀錄裡麵包屑用得到的欄位（跟 PoliticianElectionData 同名，可以直接傳） */
export interface CrumbRecord {
  electionId: number
  electionType?: string
  region?: string
  subRegion?: string
  village?: string
}

/** 那一屆選舉（跟 Election 同名的欄位）；找不到那一屆就傳 undefined */
export interface CrumbElection {
  name?: string
  shortName?: string
  /** 投票日，YYYY-MM-DD（台灣日期） */
  electionDate?: string
}

export const CANDIDATE_WORD = '候選人'
export const PARTICIPANT_WORD = '參選人'

/** 現在是台灣時間的哪一天（YYYY-MM-DD）。投票日是台灣的日期，不能拿 UTC 的日期去比 */
export function taiwanDate(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/**
 * 還沒投票寫「候選人」，投完票寫「參選人」。投票日當天算還沒投完（晚上才開票），隔天起才是參選人。
 * 查不到投票日時用「參選人」——那是不論有沒有投過都說得通的字。
 */
export function candidacyWord(electionDate: string | undefined, now: Date): string {
  const day = electionDate?.slice(0, 10)
  if (!day) return PARTICIPANT_WORD
  return taiwanDate(now) <= day ? CANDIDATE_WORD : PARTICIPANT_WORD
}

/** 分組顯示的職位帶的組名：key 用來對錨點（跟選舉頁分組的 key 同一個），shown 是括號裡的字 */
function groupOf(
  spec: PositionSpec,
  rec: CrumbRecord,
  county: string | undefined,
  township: string | undefined,
): { key: string; shown: string } | undefined {
  if (spec.display === 'district') {
    const key = rec.subRegion?.trim()
    // 不是這種選舉的正式選區（議員紀錄借到的「大雅區」「臺中市第03選區」）就當沒有：選舉頁把這種人收在「選區待補」，
    // 麵包屑不能寫出一個頁面上不存在的選區、也不能連到不存在的錨點（2026-10-05，lib/district-grouping.ts）
    if (!key || !isFormalDistrict(key, spec.type)) return undefined
    // 上面已經有一層的地名就不重複：區代表「那瑪夏區第01選舉區」→「第01選舉區」
    const prefix = [township, county].find((n): n is string => !!n && key.startsWith(n) && key.length > n.length)
    return { key, shown: prefix ? key.slice(prefix.length) : key }
  }
  if (spec.display === 'village') {
    const key = rec.village
    return key?.trim() ? { key, shown: key.trim() } : undefined
  }
  return undefined
}

/**
 * 年到職位那幾層。沒有選舉別的舊資料（不知道是什麼職位）只到縣市，不編一層出來。
 * 職位那層一定有連結：區塊的錨點在目標頁上才帶，目標頁定不出來（缺縣市、缺鄉鎮）就退到最深的那一頁、不帶錨點。
 */
export function candidacyCrumbs(rec: CrumbRecord, election: CrumbElection | undefined, now: Date): Crumb[] {
  const yearPath = `/election/${rec.electionId}`
  const crumbs: Crumb[] = [{ name: election?.shortName || election?.name || `選舉 ${rec.electionId}`, path: yearPath }]

  const region = rec.region?.trim()
  const county = isCounty(region) ? region : undefined
  const countyPath = county ? electionRegionPath(rec.electionId, county) : undefined
  if (county && countyPath) crumbs.push({ name: county, path: countyPath })

  const spec = positionSpec(rec.electionType ?? '')
  if (!spec) return crumbs

  // 鄉鎮層：職位在鄉鎮之下才有
  const belowCounty = spec.level === 'township' || spec.level === 'village'
  const township = county && belowCounty ? townshipNameOf(rec.subRegion?.trim()) : undefined
  const townshipPath = county && township ? electionTownshipPath(rec.electionId, county, township) : undefined
  if (township && townshipPath) crumbs.push({ name: township, path: townshipPath })

  // 職位的區塊畫在哪一頁（跟選舉頁的分層一致，見 election-levels.ts 檔頭的表）：
  // 全國層在年頁、縣市層在縣市頁、鄉鎮層與村里層在鄉鎮頁（村里長是鄉鎮頁的「下一層」）
  let page: { path: string; hasSection: boolean }
  if (spec.level === 'national') page = { path: yearPath, hasSection: true }
  else if (spec.level === 'county') page = countyPath ? { path: countyPath, hasSection: true } : { path: yearPath, hasSection: false }
  else page = townshipPath ? { path: townshipPath, hasSection: true } : { path: countyPath ?? yearPath, hasSection: false }

  const group = groupOf(spec, rec, county, township)
  const anchor = page.hasSection ? sectionAnchor(spec.type, group?.key) : undefined
  crumbs.push({
    name: `${spec.label}${candidacyWord(election?.electionDate, now)}${group ? `（${group.shown}）` : ''}`,
    path: anchor ? `${page.path}#${encodeURIComponent(anchor)}` : page.path,
  })
  return crumbs
}

/**
 * 政見頁「政見 PK」連結（2026-10-06）：到職位區塊所在的那一頁（麵包屑職位層那一格的網址，去掉頁內錨點），
 * 開「政見 PK」頁籤、選好這個職位與這一場（district），帶入這一組全部的參選人。
 * 目標頁定不出來（缺縣市、缺鄉鎮，職位層沒有錨點）、或不知道是哪一場（選區待補）就不給——連過去比的不會是同一場。
 */
export function pkLinkFor(
  rec: CrumbRecord & { position?: string },
  election: CrumbElection | undefined,
  now: Date,
): { path: string; query: Record<string, string>; name: string } | null {
  const spec = positionSpec(rec.electionType ?? '')
  if (!spec) return null
  const position = candidacyCrumbs(rec, election, now).at(-1)
  const hash = position?.path?.indexOf('#') ?? -1
  if (!position?.path || hash < 0) return null
  const district = pkGroupLabel(rec, spec.type)
  if (!district) return null
  return { path: position.path.slice(0, hash), query: pkQuery(spec.type, district), name: position.name }
}
