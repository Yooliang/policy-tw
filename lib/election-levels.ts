/**
 * 選舉頁的分層設定：每一頁只管「這一層＋下一層」（2026-10-04 #342 定的規則，2026-10-05 #348 收成設定）。
 *
 * 以前規則散在三個地方：這支檔案的 positionsToLoad／planLevels 各寫一份職位清單、ElectionPage.vue 的模板
 * 三個層級各寫死一串區塊、lib/ssg/page-data.ts 再抄一份全台層的職位。加一個職位要改四處，漏一處就是
 * 「撈了沒畫」或「畫了沒撈」——後者在畫面上是一個永遠空的區塊，看起來跟「這一屆沒人參選」一樣。
 * 日本站（政策の系譜）的做法是寫成一份層級設定、頁面照設定畫；這裡照做：
 *
 *   POSITIONS（下面那張表）是唯一的職位清單。每個職位寫：在哪一層、是首長還是民代、只在哪種鄉鎮市區有、
 *   畫面上叫什麼、區塊怎麼排。其餘全部從這張表推：
 *     - positionsToLoad   這一頁要向資料庫撈哪些職位（useSupabase、預渲染切片都讀它）
 *     - planLevels        這一頁要顯示哪些職位，分「這一層」「下一層」（ElectionPage.vue 照它畫區塊）
 *     - DIRECTORY_POSITIONS 縣市頁「鄉鎮市區參選人名錄」收哪些職位（lib/township-directory.ts）
 *   加一個職位＝在表裡加一列；排版跟既有的一樣（卡片、依選區分組、依村里分組）就不用改頁面。
 *
 * 分層規則（從表推出來，2026-10-04 定的表照舊）：
 *
 * | 頁面 | 這一層 | 下一層 |
 * |---|---|---|
 * | 全台 /election/:year | 總統副總統 | 各縣市長 |
 * | 縣市 /election/:year/嘉義縣 | 縣市長、縣市議員、立法委員 | 鄉鎮市長（直轄市：原住民區長） |
 * | 縣轄鄉鎮市 ?sub=大林鎮 | 鄉鎮市長、鄉鎮市民代表 | 村里長 |
 * | 直轄市一般區 ?sub=北區 | （區長官派，沒有這一層） | 里長 |
 * | 直轄市原住民區 ?sub=那瑪夏區 | 原住民區長、區代表 | 里長 |
 *
 *   - 「這一層」＝這一層的所有職位；「下一層」只帶首長（role: 'head'）——那是帶使用者往下走的入口，
 *     下一層的民代（鄉鎮市民代表、區代表）到了那一頁才列。
 *   - 鄉鎮市區分三種（見 ward-classification.ts）：縣轄鄉鎮市（rural）、直轄市原住民區（indigenous）、
 *     直轄市一般區（plain）。鄉鎮層的職位用 wards 標「只在哪幾種有」。
 *   - 同一層裡的順序就是表的順序，也是畫面上區塊的順序。
 *
 * 兩個刻意的決定，都不是疏漏：
 *
 * 1. **立法委員放在縣市層，不放全台層。** 資料裡的立委原本全部是區域立委——2024 那 312 筆每一筆都掛在
 *    「XX第NN選區」底下，屬縣市層。把區域立委列在全台頁既不是「全國層級」，也跟縣市頁重複。
 *    不分區與原住民立委的參選紀錄補進來之後（#357）會指到 region＝全國，到時候要讓全台頁列他們，
 *    得先能分辨同一個職位（立法委員）的兩種選區——那是 #344 選舉區表的事。
 *
 * 2. **要撈什麼不能問 wardKind。** 直轄市的區是一般區還是原住民區，判斷依據是「這個區有沒有原住民區長／
 *    區代表的候選人」（見 ward-classification.ts）——那要先把資料撈回來才知道。所以 positionsToLoad 對
 *    直轄市的區一律把那個縣市「可能有」的鄉鎮層職位都撈（原住民區的兩種），撈回來再由 planLevels 照實際的
 *    wardKind 決定顯示哪些。這兩件事分成兩個函式就是為了這個。
 *
 * 這個檔案零依賴，能被 deno 直接測。
 */

/**
 * politician_elections.election_type 的值。
 *
 * 寫成字串字面量而不是 import types.ts 的 ElectionType enum，是為了讓這個檔案零依賴、能被 deno 直接測。
 * 呼叫端傳 ElectionType 進來時 TypeScript 會比對字面量，enum 的值哪天改了，這裡會在編譯期紅。
 */
export type PositionType =
  | '總統副總統'
  | '立法委員'
  | '縣市長'
  | '縣市議員'
  | '鄉鎮市長'
  | '鄉鎮市民代表'
  | '村里長'
  | '直轄市山地原住民區長'
  | '直轄市山地原住民區民代表'

/** 鄉鎮市區的三種：縣轄鄉鎮市、直轄市原住民區、直轄市一般區（見 ward-classification.ts） */
export type WardKind = 'rural' | 'indigenous' | 'plain'

/** 選舉頁的三個層級 */
export type ElectionScope = 'national' | 'county' | 'township'

/** 職位所在的行政層級 */
export type AdminLevel = 'national' | 'county' | 'township' | 'village'

export interface PositionSpec {
  type: PositionType
  level: AdminLevel
  /** 首長或民意代表。「下一層」只帶首長 */
  role: 'head' | 'council'
  /** 只在這幾種鄉鎮市區有；不寫＝哪裡都有（只有鄉鎮層的職位需要寫） */
  wards?: readonly WardKind[]
  /** 畫面上的名稱：區塊標題是「〔label〕參選人」，名錄與分組區塊用 label 本身 */
  label: string
  /** 區塊怎麼排：grid＝卡片；district＝依選舉區分組＋快篩；village＝依村里分組＋快篩 */
  display: 'grid' | 'district' | 'village'
  /** 區塊標題的圖示（lucide 圖示名稱）與顏色；頁面照名稱取元件 */
  icon: string
  iconClass: string
}

/** 唯一的職位清單。同一層裡的順序＝畫面上區塊的順序 */
export const POSITIONS: readonly PositionSpec[] = [
  { type: '總統副總統', level: 'national', role: 'head', label: '總統副總統', display: 'grid', icon: 'Crown', iconClass: 'text-amber-500' },
  { type: '縣市長', level: 'county', role: 'head', label: '縣市長', display: 'grid', icon: 'Flag', iconClass: 'text-red-500' },
  // 議員一個縣市上百位，攤平了找不到自己那一區，所以依選舉區分組
  { type: '縣市議員', level: 'county', role: 'council', label: '縣市議員', display: 'district', icon: 'Users', iconClass: 'text-blue-500' },
  { type: '立法委員', level: 'county', role: 'council', label: '立法委員', display: 'grid', icon: 'ScrollText', iconClass: 'text-purple-500' },
  { type: '鄉鎮市長', level: 'township', role: 'head', wards: ['rural'], label: '鄉鎮市長', display: 'grid', icon: 'Building2', iconClass: 'text-indigo-500' },
  { type: '鄉鎮市民代表', level: 'township', role: 'council', wards: ['rural'], label: '鄉鎮市民代表', display: 'grid', icon: 'Landmark', iconClass: 'text-green-500' },
  { type: '直轄市山地原住民區長', level: 'township', role: 'head', wards: ['indigenous'], label: '原住民區長', display: 'grid', icon: 'Mountain', iconClass: 'text-emerald-600' },
  // 區代表的選區是「那瑪夏區第01選舉區」，一個區分好幾個選區
  { type: '直轄市山地原住民區民代表', level: 'township', role: 'council', wards: ['indigenous'], label: '原住民區代表', display: 'district', icon: 'MessageCircle', iconClass: 'text-teal-500' },
  { type: '村里長', level: 'village', role: 'head', label: '村里長', display: 'village', icon: 'MapPin', iconClass: 'text-amber-500' },
]

const BY_TYPE = new Map(POSITIONS.map(p => [p.type, p]))

/** 職位的設定；表裡沒有的職位回 undefined（頁面就不畫它） */
export function positionSpec(type: string): PositionSpec | undefined {
  return BY_TYPE.get(type as PositionType)
}

/**
 * 選舉頁區塊的頁內錨點 id（2026-10-05）：人物頁麵包屑的職位層連到這裡（/election/2026/金門縣#縣市長）。
 * 頁面畫區塊（pages/ElectionPage.vue）與麵包屑（lib/election-breadcrumbs.ts）都只從這個函式拿 id，
 * 兩邊不會各寫各的——連到一個頁面上不存在的 id，瀏覽器只會安靜地不捲動，沒有任何錯誤。
 *
 *   整個職位的區塊      ＝職位名稱（POSITIONS 的 label）：#縣市長、#鄉鎮市長
 *   有分組的職位再分組  ＝職位名稱-組名：議員的選舉區 #縣市議員-第01選舉區、村里長的里 #村里長-東門里
 *
 * 職位不在表裡回 undefined。組名裡的空白拿掉（id 不能有空白）。
 */
export function sectionAnchor(type: string, group?: string): string | undefined {
  const spec = positionSpec(type)
  if (!spec) return undefined
  const name = group?.replace(/\s+/g, '')
  return name ? `${spec.label}-${name}` : spec.label
}

/** 每個層級的頁面：這一層是哪一級、下一層是哪一級 */
const SCOPE_LEVELS: Record<ElectionScope, { own: AdminLevel; next: AdminLevel }> = {
  national: { own: 'national', next: 'county' },
  county: { own: 'county', next: 'township' },
  township: { own: 'township', next: 'village' },
}

/** 這個縣市底下可能有哪幾種鄉鎮市區：直轄市是原住民區與一般區，縣（市）是縣轄鄉鎮市 */
function wardsIn(isSpecialMunicipality: boolean): readonly WardKind[] {
  return isSpecialMunicipality ? ['indigenous', 'plain'] : ['rural']
}

function appliesTo(spec: PositionSpec, wards: readonly WardKind[]): boolean {
  return !spec.wards || spec.wards.some(w => wards.includes(w))
}

/** 某一級、在這幾種鄉鎮市區有的職位（照表的順序）；onlyHeads＝只要首長 */
function positionsAt(level: AdminLevel, wards: readonly WardKind[], onlyHeads = false): PositionType[] {
  return POSITIONS
    .filter(p => p.level === level && appliesTo(p, wards) && (!onlyHeads || p.role === 'head'))
    .map(p => p.type)
}

export interface ScopeInput {
  /** 選到的縣市，'All' ＝全台 */
  region: string
  /** 選到的鄉鎮市區，'All' ＝整個縣市 */
  subRegion: string
}

export interface LevelInput extends ScopeInput {
  /** 這個縣市是不是直轄市（六都） */
  isSpecialMunicipality: boolean
  /** 這個區是哪一種；只有 township 層用得到，由撈回來的資料判定 */
  wardKind: WardKind
}

export interface LevelPlan {
  scope: ElectionScope
  /** 這一層的職位：這一頁的主角。直轄市一般區是空的（區長官派）。 */
  thisLevel: readonly PositionType[]
  /** 下一層的職位：這一頁要帶使用者去的下一站 */
  nextLevel: readonly PositionType[]
}

export function scopeOf({ region, subRegion }: ScopeInput): ElectionScope {
  if (region === 'All') return 'national'
  return subRegion === 'All' ? 'county' : 'township'
}

/**
 * 這一頁要向資料庫撈哪些職位。
 *
 * 不接 wardKind（見檔頭第 2 點）：直轄市的區一律把原住民區長、區代表、里長三種都撈——
 * 六個原住民區以外的區只會撈到里長，多撈的是零筆。
 */
export function positionsToLoad(input: ScopeInput & { isSpecialMunicipality: boolean }): readonly PositionType[] {
  const { own, next } = SCOPE_LEVELS[scopeOf(input)]
  const wards = wardsIn(input.isSpecialMunicipality)
  return [...positionsAt(own, wards), ...positionsAt(next, wards, true)]
}

/** 這一頁要顯示哪些職位，分成「這一層」與「下一層」兩組。 */
export function planLevels(input: LevelInput): LevelPlan {
  const scope = scopeOf(input)
  const { own, next } = SCOPE_LEVELS[scope]
  const possible = wardsIn(input.isSpecialMunicipality)
  // 鄉鎮市區層的「這一層」要看這個區實際是哪一種（一般區沒有民選的區長與區代表）。
  // 分流依據跟 positionsToLoad 同一個——isSpecialMunicipality 決定可能有哪幾種，wardKind 只在那幾種裡挑：
  // 傳進來的 wardKind 不在可能的範圍裡（例：直轄市配 rural，classifyWard 不會產生，但那是另一個檔案的保證）
  // 就當成沒有這一層，不會顯示一個沒撈的職位——那在畫面上是一個永遠空的區塊。
  const actual = scope === 'township'
    ? (input.isSpecialMunicipality ? possible.filter(w => w === input.wardKind) : possible)
    : possible
  return {
    scope,
    thisLevel: positionsAt(own, actual),
    nextLevel: positionsAt(next, possible, true),
  }
}

/** 這一頁總共會顯示的職位＝這一層＋下一層。 */
export function displayedPositions(plan: LevelPlan): readonly PositionType[] {
  return [...plan.thisLevel, ...plan.nextLevel]
}

const LEVEL_ORDER: readonly AdminLevel[] = ['national', 'county', 'township', 'village']

/**
 * 縣市頁「鄉鎮市區參選人名錄」收的職位：鄉鎮層與村里層的全部職位，同一級裡首長在前。
 * （鄉鎮市長、原住民區長、鄉鎮市民代表、原住民區代表、村里長）
 */
export const DIRECTORY_POSITIONS: readonly PositionSpec[] = POSITIONS
  .filter(p => p.level === 'township' || p.level === 'village')
  .map((p, i) => ({ p, i }))
  .sort((a, b) =>
    LEVEL_ORDER.indexOf(a.p.level) - LEVEL_ORDER.indexOf(b.p.level)
    || (a.p.role === b.p.role ? 0 : a.p.role === 'head' ? -1 : 1)
    || a.i - b.i)
  .map(x => x.p)
