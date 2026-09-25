/**
 * 中選會靜態 JSON 路徑用的縣市代碼（prv/city），與縣市名正規化。
 *
 * 原本這份對照抄在 fetch-cec-data 與 AdminScraper.vue 兩處（後者 2026-09-23 下架），
 * cec-sync 也要用同一份，所以搬來這裡當唯一的正本；fetch-cec-data 與 cec-sync 都從這裡 import。
 * 2026-09-21 曾把金門／連江配反過（見 cec-city-codes.test.ts 的說明），代碼是中選會定的、不會變。
 */

export interface CityCode {
  prv: string;
  city: string;
}

export const CITY_CODES: Record<string, CityCode> = {
  "全國": { prv: "00", city: "000" },
  "台北市": { prv: "63", city: "000" }, "新北市": { prv: "65", city: "000" }, "桃園市": { prv: "68", city: "000" },
  "台中市": { prv: "66", city: "000" }, "台南市": { prv: "67", city: "000" }, "高雄市": { prv: "64", city: "000" },
  "宜蘭縣": { prv: "10", city: "002" }, "新竹縣": { prv: "10", city: "004" }, "苗栗縣": { prv: "10", city: "005" },
  "彰化縣": { prv: "10", city: "007" }, "南投縣": { prv: "10", city: "008" }, "雲林縣": { prv: "10", city: "009" },
  "嘉義縣": { prv: "10", city: "010" }, "屏東縣": { prv: "10", city: "013" }, "台東縣": { prv: "10", city: "014" },
  "花蓮縣": { prv: "10", city: "015" }, "澎湖縣": { prv: "10", city: "016" }, "基隆市": { prv: "10", city: "017" },
  "新竹市": { prv: "10", city: "018" }, "嘉義市": { prv: "10", city: "020" },
  // 2026-09-21：這兩個代碼原本配反（金門 007／連江 020），整批 2022 金門議員被存成連江、連江存成金門，
  // electoral_district_areas 也對調。證據是這支自己抓回來的鄉鎮：007 回南竿北竿莒光東引（馬祖）、020 回金城金寧金沙金湖烈嶼烏坵（金門）。
  // 正確對應：09_007＝連江縣、09_020＝金門縣。cec-city-codes.test.ts 盯著這兩行。
  "連江縣": { prv: "09", city: "007" }, "金門縣": { prv: "09", city: "020" },
};

export const CITY_NAME_BY_CODE = new Map(Object.entries(CITY_CODES).map(([name, c]) => [`${c.prv}_${c.city}`, name]));

/** 六都（直轄市）：中選會有些選舉別（市長／議員）要用不同的科目代碼 */
export const DIRECT_CITIES: ReadonlySet<string> = new Set(["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市"]);

/** 全部 22 縣市（不含「全國」） */
export const ALL_REGIONS: readonly string[] = Object.keys(CITY_CODES).filter((r) => r !== "全國");

export function normalizeCityName(name: string | undefined): string | undefined {
  return name ? name.replace(/臺/g, "台").trim() : undefined;
}
