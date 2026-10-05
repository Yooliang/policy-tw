/**
 * 選舉頁的分層：每一頁只管「這一層＋下一層」。
 *
 * 以前每一頁都把整個縣市所有層級的參選人撈回來，再在前端濾出要顯示的那幾個區塊。
 * 高雄市 2022 那是 1,769 位，而縣市頁真正要顯示的只有縣市長 4＋議員 124。
 * 改成依層級決定「要撈哪些職位」，查詢就小得多，頁面也不再出現跟這一層無關的區塊。
 *
 * 層級與職位的對應（2026-10-04）：
 *
 * | 頁面 | 這一層 | 下一層 |
 * |---|---|---|
 * | 全台 /election/:year | 總統副總統 | 各縣市長 |
 * | 縣市 /election/:year/嘉義縣 | 縣市長、立法委員、縣市議員 | 鄉鎮市長（直轄市：原住民區長） |
 * | 縣轄鄉鎮市 ?sub=大林鎮 | 鄉鎮市長、鄉鎮市民代表 | 村里長 |
 * | 直轄市一般區 ?sub=北區 | （區長官派，沒有這一層） | 里長 |
 * | 直轄市原住民區 ?sub=那瑪夏區 | 原住民區長、區代表 | 里長 |
 *
 * 兩個刻意的決定，都不是疏漏：
 *
 * 1. **立法委員放在縣市層，不放全台層。** 資料裡的立委全部是區域立委——2024 那 312 筆
 *    每一筆都掛在「XX第NN選區」底下。全國不分區、山地／平地原住民立委一筆都沒有，
 *    `regions` 表連可以掛的列都沒有。把 312 位區域立委全部列在全台頁，既不是「全國層級」，
 *    也跟縣市頁重複。資料哪天真的有了不分區立委，它會是 region='全國' 的那一列，
 *    到時候再把它加進 nationalPositions——而不是現在先放一個永遠空的區塊。
 *
 * 2. **要撈什麼不能問 wardKind。** 直轄市的區是一般區還是原住民區，判斷依據是
 *    「這個區有沒有原住民區長／區代表的候選人」（見 ward-classification.ts）——
 *    那要先把資料撈回來才知道。所以 positionsToLoad() 對直轄市的區一律把兩種原住民
 *    職位都撈，撈回來再由 planLevels() 決定顯示哪些。這兩件事分成兩個函式就是為了這個。
 */

/**
 * politician_elections.election_type 的值。
 *
 * 這裡寫成字串字面量而不是 import types.ts 的 ElectionType enum，是為了讓這個檔案
 * 零依賴、能被 deno 直接測。呼叫端傳 ElectionType 進來時 TypeScript 會比對字面量，
 * 所以 enum 的值哪天改了，這裡會在編譯期紅，不會靜靜地對不上。
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

/** 直轄市的區分兩種，縣轄鄉鎮市是第三種；見 ward-classification.ts */
export type WardKind = 'rural' | 'indigenous' | 'plain'

/** 選舉頁的三個層級 */
export type ElectionScope = 'national' | 'county' | 'township'

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
 * 不接 wardKind：直轄市的區要撈什麼不能問它（見檔頭第 2 點），所以一律把原住民區長、
 * 區代表、里長三種都撈——六個原住民區以外的區只會撈到里長，多撈的是零筆。
 */
export function positionsToLoad(input: ScopeInput & { isSpecialMunicipality: boolean }): readonly PositionType[] {
  const scope = scopeOf(input)
  if (scope === 'national') return ['總統副總統', '縣市長']
  if (scope === 'county') {
    return input.isSpecialMunicipality
      ? ['縣市長', '立法委員', '縣市議員', '直轄市山地原住民區長']
      : ['縣市長', '立法委員', '縣市議員', '鄉鎮市長']
  }
  return input.isSpecialMunicipality
    ? ['直轄市山地原住民區長', '直轄市山地原住民區民代表', '村里長']
    : ['鄉鎮市長', '鄉鎮市民代表', '村里長']
}

/** 這一頁要顯示哪些職位，分成「這一層」與「下一層」兩組。 */
export function planLevels(input: LevelInput): LevelPlan {
  const scope = scopeOf(input)

  if (scope === 'national') {
    return { scope, thisLevel: ['總統副總統'], nextLevel: ['縣市長'] }
  }

  if (scope === 'county') {
    return {
      scope,
      thisLevel: ['縣市長', '立法委員', '縣市議員'],
      nextLevel: input.isSpecialMunicipality ? ['直轄市山地原住民區長'] : ['鄉鎮市長'],
    }
  }

  // 鄉鎮市區層。下一層一律是村里長，差別只在「這一層」有沒有可選的職位。
  //
  // 分流依據一定要跟 positionsToLoad 同一個——isSpecialMunicipality。
  // 原本這裡只看 wardKind，於是 isSpecialMunicipality=true 配上 wardKind='rural'
  // （classifyWard 不會產生這個組合，但那是另一個檔案的保證）會顯示鄉鎮市長，
  // 而 positionsToLoad 對直轄市的區撈的是原住民區的職位——顯示一個沒撈的職位，
  // 畫面上就是一個永遠空的區塊，而空區塊看起來跟「這一屆沒人參選」一模一樣。
  // 單元測試抓到的就是這個。
  if (!input.isSpecialMunicipality) {
    return { scope, thisLevel: ['鄉鎮市長', '鄉鎮市民代表'], nextLevel: ['村里長'] }
  }
  // 直轄市的區：原住民區的區長與區代表都是民選，一般區區長官派（這一層是空的）
  return {
    scope,
    thisLevel: input.wardKind === 'indigenous' ? ['直轄市山地原住民區長', '直轄市山地原住民區民代表'] : [],
    nextLevel: ['村里長'],
  }
}

/** 這一頁總共會顯示的職位＝這一層＋下一層。 */
export function displayedPositions(plan: LevelPlan): readonly PositionType[] {
  return [...plan.thisLevel, ...plan.nextLevel]
}
