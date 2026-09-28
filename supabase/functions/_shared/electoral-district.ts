/**
 * 選舉區文字正規化（2026-09-28，2026 議員選區名冊匯入的前置工作）。
 *
 * 代理交件、候選人登記資料（contributions.payload->>'position'）、公告文字裡的選舉區寫法很亂：
 * 「第4選區」「第四選區」「第4選舉區」「第 04 選舉區」「新北市第4選舉區」「臺北市第6選區(大安文山)」都是同一件事。
 * 這支只做純文字轉換，不接資料庫、不接任何 handler；之後交件守門要用同一套邏輯時再接進去。
 *
 * 縣市名單與「臺→台」正規化沿用 cec-city-codes.ts 那份正本，不再各自抄一份。
 */
import { ALL_REGIONS, normalizeCityName } from "./cec-city-codes.ts";

export interface NormalizedDistrict {
  /** 縣市名（已轉台/臺），文字裡沒寫縣市就是 null */
  region: string | null;
  /** 兩位數格式，例如「第04選舉區」 */
  district: string;
}

const DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文數字轉阿拉伯數字，支援到三十幾（十、十一、二十、二十一、三十、三十九…） */
function chineseToNumber(s: string): number | null {
  if (s === "十") return 10;
  const tenIdx = s.indexOf("十");
  if (tenIdx === -1) {
    if (s.length !== 1 || !(s in DIGIT)) return null;
    return DIGIT[s];
  }
  const tensPart = s.slice(0, tenIdx);
  const onesPart = s.slice(tenIdx + 1);
  const tens = tensPart === "" ? 1 : DIGIT[tensPart];
  const ones = onesPart === "" ? 0 : DIGIT[onesPart];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

/** 數字字串（阿拉伯或中文）轉整數；阿拉伯數字允許前後空白與前導零 */
function parseDistrictNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return chineseToNumber(trimmed);
}

const DISTRICT_RE = /第\s*([0-9零一二三四五六七八九十]+)\s*選舉?區/;

/**
 * 把選舉區文字轉成「第NN選舉區」（兩位數）；抓得到縣市名就一併回傳（已正規化台/臺）。
 * 抓不到「第…選區／選舉區」的樣式就回傳 null——呼叫端自行決定要不要當成錯誤。
 */
export function normalizeDistrict(text: string): NormalizedDistrict | null {
  if (!text) return null;
  const normalizedText = normalizeCityName(text) ?? text;
  const match = DISTRICT_RE.exec(normalizedText);
  if (!match) return null;
  const num = parseDistrictNumber(match[1]);
  if (num === null || num <= 0) return null;
  const district = `第${String(num).padStart(2, "0")}選舉區`;
  const region = ALL_REGIONS.find((r) => normalizedText.includes(r)) ?? null;
  return { region, district };
}
