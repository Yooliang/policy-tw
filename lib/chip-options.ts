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
