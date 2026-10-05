/**
 * 縣市頁的「鄉鎮市區參選人名錄」（2026-10-05 抽成純函式）。
 *
 * 這份名錄是預渲染的縣市頁裡**唯一**通往村里長人物頁的連結（2026-09-30 加的，
 * 當時 Search Console 整站內部連結只剩 28 個）。村里長有 13,338 位，是資料庫裡
 * 最大的一群，而他們的頁面只能從這裡被爬到。
 *
 * 2026-10-05 分層之後，卡片區塊只撈「這一層＋下一層」（高雄市縣市頁 128 位而不是
 * 1,769 位），所以名錄不能再從卡片的資料推出來——它改由一支只取四個欄位的輕量查詢
 * 單獨撈（姓名、職位、鄉鎮、村里），每位約是完整人物物件的十分之一。
 * 這就是「卡片輕、SEO 入口照舊」的做法。
 */
import { compareRegionName } from './region-name'
import { DIRECTORY_POSITIONS } from './election-levels'

/** 名錄只需要這幾個欄位：連結要 politicianId，顯示要 name／village，分組要 electionType／subRegion */
export interface DirectoryPerson {
  politicianId: string
  name: string
  electionType: string
  subRegion?: string | null
  village?: string | null
}

/** 名錄裡的層級（鄉鎮市長、村里長…），順序照呼叫端給的 levels */
export interface DirectoryLevel<T> {
  label: string
  people: T[]
}

export interface DirectoryTownship<T> {
  township: string
  total: number
  groups: DirectoryLevel<T>[]
}

export interface DirectoryLevelSpec {
  /** politician_elections.election_type 的值 */
  type: string
  /** 畫面上的字（比 election_type 短，例如「原住民區長」） */
  label: string
}

/**
 * 名錄收哪些層級，以及畫面上怎麼叫它們。**單一來源**，三個地方都讀這一份：
 *   composables/useSupabase.ts  輕量查詢的 election_type 篩選
 *   lib/ssg/page-data.ts        預渲染縣市頁的切片
 *   pages/ElectionPage.vue      畫面分組
 * 三處各寫一份的話，預渲染帶的人跟畫面要顯示的人會對不上——而對不上的樣子是
 * 名錄少一塊，看起來跟「這個縣市沒有那個層級」一樣。
 *
 * 清單本身從分層設定推（lib/election-levels.ts 的 DIRECTORY_POSITIONS，2026-10-05 #348）：
 * 鄉鎮層與村里層的全部職位，同一級首長在前——鄉鎮市長、原住民區長、鄉鎮市民代表、原住民區代表、村里長。
 * 加職位只要改那張表，這裡跟著變。
 */
export const DIRECTORY_LEVELS: readonly DirectoryLevelSpec[] = DIRECTORY_POSITIONS.map(p => ({ type: p.type, label: p.label }))

/** 名錄要撈的 election_type 清單 */
export const DIRECTORY_POSITION_TYPES: readonly string[] = DIRECTORY_LEVELS.map(l => l.type)

/** 鄉鎮歸屬未知的人收在這裡，不要濾掉——濾掉就等於那些人的頁面沒有任何連結指過去 */
const UNKNOWN_TOWNSHIP = '其他'

/** politician_elections 帶嵌入關聯撈回來的原始列 */
export interface RawDirectoryRow {
  politician_id: string
  election_type: string
  politicians: { name: string } | Array<{ name: string }> | null
  regions: { sub_region: string | null; village: string | null } | Array<{ sub_region: string | null; village: string | null }> | null
}

/**
 * PostgREST 對 many-to-one 的嵌入（politician_elections → politicians）回的是**單一物件**，
 * 但 supabase-js 在沒有產生型別的情況下會把它推斷成陣列。
 *
 * 兩種形狀都接，因為猜錯的代價不對稱：猜錯就是整份名錄變空，而空名錄在畫面上
 * 跟「這個縣市沒有鄉鎮層級參選人」長得一模一樣，不會有任何錯誤。
 */
function embedded<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** 把一列原始資料整理成名錄要的形狀；沒有姓名的列回 null（連結沒有字可以點） */
export function toDirectoryPerson(row: RawDirectoryRow): DirectoryPerson | null {
  const person = embedded(row.politicians)
  if (!person?.name) return null
  const region = embedded(row.regions)
  return {
    politicianId: String(row.politician_id),
    name: person.name,
    electionType: row.election_type,
    subRegion: region?.sub_region ?? null,
    village: region?.village ?? null,
  }
}

/**
 * 這筆參選紀錄的 subRegion 屬於哪個鄉鎮市區；填不出來（空的、或整串只是選舉區）回 undefined。
 * 原住民區代表的選區是「那瑪夏區第01選舉區」，要歸到「那瑪夏區」底下；
 * 其餘層級的 subRegion 本身就是鄉鎮市區名。名錄與人物頁麵包屑（lib/election-breadcrumbs.ts）共用這一條規則。
 */
export function townshipNameOf(subRegion: string | null | undefined): string | undefined {
  return (subRegion || '').replace(/第.+選舉區$/, '') || undefined
}

export function townshipOf(subRegion: string | null | undefined): string {
  return townshipNameOf(subRegion) ?? UNKNOWN_TOWNSHIP
}

export function buildTownshipDirectory<T extends DirectoryPerson>(
  people: readonly T[],
  levels: readonly DirectoryLevelSpec[],
): DirectoryTownship<T>[] {
  const byTownship = new Map<string, Map<string, T[]>>()
  for (const person of people) {
    const level = levels.find(l => l.type === person.electionType)
    if (!level) continue
    const township = townshipOf(person.subRegion)
    const groups = byTownship.get(township) ?? new Map<string, T[]>()
    groups.set(level.label, [...(groups.get(level.label) ?? []), person])
    byTownship.set(township, groups)
  }

  return [...byTownship.entries()]
    .sort(([a], [b]) => compareRegionName(a, b))
    .map(([township, groups]) => ({
      township,
      total: [...groups.values()].reduce((n, list) => n + list.length, 0),
      groups: levels
        .filter(l => groups.has(l.label))
        .map(l => ({ label: l.label, people: groups.get(l.label)! })),
    }))
}

export function directoryTotal<T>(directory: readonly DirectoryTownship<T>[]): number {
  return directory.reduce((n, t) => n + t.total, 0)
}
