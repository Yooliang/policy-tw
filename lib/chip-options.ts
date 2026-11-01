/**
 * 晶片列的選項與「淡灰」標記（2026-10-31 正式站 bug：手機的地區晶片列有時整排不見、很慢才出來）。
 *
 * 原則：晶片列的全部選項一律來自打包進頁面的地區快取（data/tw-raster-index、data/tw-districts、點陣檔），
 * 完全不依賴參選人資料——參選人還在讀、或讀回來是空的，晶片列都照樣畫全部選項。
 * 參選人讀完之後，才把「該分頁沒有任何參選人的地區」標成淡灰（仍可按，按下去顯示空狀態）；
 * 讀取中（populated 給 null）不灰，維持一般樣式。
 * 純函式，不依賴 Vue，deno 直接測。
 */
export interface ChipOption {
  value: string
  /** 該分頁在這個地區沒有任何參選人（只有參選人讀完才會 true） */
  dim: boolean
}

/**
 * @param options 全部選項（來自地區快取，順序照快取）
 * @param populated 有參選人的地區名稱集合；null＝還在讀取（不標灰）
 * @param norm 名稱正規化（臺／台）
 */
export function chipOptions(
  options: readonly string[],
  populated: ReadonlySet<string> | null,
  norm: (name: string) => string = (n) => n,
): ChipOption[] {
  return options.map((value) => ({ value, dim: populated !== null && !populated.has(norm(value)) }))
}

/**
 * 縣市晶片列的「有參選人縣市」集合。populatedPeople 只含目前縣市的參選人，
 * 所以只有 selectedRegion === 'All'（全台資料已讀）時才能依參選人標灰；選了某縣市時回 null（不標灰）。
 * @param mayorRegions 市長參選人的縣市名稱（已正規化）
 */
export function countyPopulatedSet(
  selectedRegion: string,
  ready: boolean,
  mayorRegions: () => Iterable<string>,
): ReadonlySet<string> | null {
  return ready && selectedRegion === 'All' ? new Set(mayorRegions()) : null
}

/**
 * 建置期人數快取（data/tw-chip-counts/<屆>.json，scripts/build-tw-chip-counts.ts 產生）：
 * 晶片一出來就能決定灰／亮，不用等參選人讀完。
 *   county / town：{ 官方碼: { 選舉類型: 人數 } }；village：{ 鄉鎮碼: [沒有登記者的村里名] }
 */
export interface ChipCountCache {
  election: number
  county: Record<string, Record<string, number>>
  town: Record<string, Record<string, number>>
  village: Record<string, string[]>
}
interface CodeNames { codes: readonly string[]; names: readonly string[] }

/** 即時資料讀完（live 非 null）以即時為準；還沒讀完就用快取（可能也是 null＝都不灰） */
export function resolvePopulated(live: ReadonlySet<string> | null, cached: ReadonlySet<string> | null): ReadonlySet<string> | null {
  return live ?? cached
}

/** 快取裡「這些職位任一有人」的地區名稱集合（名稱已正規化）；quota 為單位表（縣市或鄉鎮） */
function populatedByType(
  table: Record<string, Record<string, number>>,
  list: CodeNames,
  types: readonly string[],
  norm: (n: string) => string,
): ReadonlySet<string> {
  const out = new Set<string>()
  list.codes.forEach((code, i) => {
    const row = table[code]
    if (row && types.some((t) => (row[t] ?? 0) > 0)) out.add(norm(list.names[i]!))
  })
  return out
}

/** 縣市層：快取沒有（或不是這一屆）回 null */
export function cachedCountySet(cache: ChipCountCache | null, counties: CodeNames, types: readonly string[], norm: (n: string) => string = (n) => n): ReadonlySet<string> | null {
  return cache ? populatedByType(cache.county, counties, types, norm) : null
}

/** 鄉鎮層：快取沒有、或該縣市的鄉鎮一個都不在快取裡回 null（不下判斷） */
export function cachedTownSet(cache: ChipCountCache | null, towns: CodeNames | null, types: readonly string[], norm: (n: string) => string = (n) => n): ReadonlySet<string> | null {
  if (!cache || !towns || !towns.codes.some((c) => cache.town[c])) return null
  return populatedByType(cache.town, towns, types, norm)
}

/** 村里層：快取沒有這個鄉鎮回 null；否則「選項裡不在灰名單的」就是有人 */
export function cachedVillageSet(cache: ChipCountCache | null, townCode: string | null, options: readonly string[], norm: (n: string) => string = (n) => n): ReadonlySet<string> | null {
  const zero = cache && townCode ? cache.village[townCode] : undefined
  if (!zero) return null
  const z = new Set(zero.map(norm))
  return new Set(options.map(norm).filter((n) => !z.has(n)))
}
