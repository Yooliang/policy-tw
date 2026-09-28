/**
 * 選舉區文字正規化（2026-09-28，2026 議員選區名冊匯入的前置工作）。
 *
 * 代理交件、候選人登記資料（contributions.payload->>'position'）、公告文字裡的選舉區寫法很亂：
 * 「第4選區」「第四選區」「第4選舉區」「第 04 選舉區」「新北市第4選舉區」「臺北市第6選區(大安文山)」都是同一件事。
 * normalizeDistrict 只做純文字轉換，不接資料庫。
 *
 * 縣市名單與「臺→台」正規化沿用 cec-city-codes.ts 那份正本，不再各自抄一份。
 *
 * 2026-09-28 補（交件時自動統一寫法，第二步）：normalizeCandidacyDistrictField 接進
 * contribute-handler.ts，把縣市議員候選人 payload 的 electoral_district 統一寫法；名冊存不存在
 * 這個選區的查詢（要接資料庫）在 district-registry.ts，原住民保留議席的常數清單在本檔最下面。
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

/**
 * 交件時統一縣市議員候選人的選舉區寫法（2026-09-28，就地修改 payload）：
 * - payload.electoral_district 有給、正規化得出來 → 換成「第NN選舉區」
 * - payload.electoral_district 有給、正規化不出來（不是「第…選(舉)?區」樣式）→ 原樣留著，
 *   交給後面的名冊查詢去判斷（district-registry.ts）——normalizeDistrict 抓不到樣式不代表這筆一定是錯的，
 *   但也沒有辦法轉成標準寫法，不要在這裡吞掉原始內容
 * - payload.electoral_district 沒給，但 position 文字裡有「第N選舉區／選區」樣式 → 抽出來填進 electoral_district；
 *   position 本身不動
 * 只對 election_type==="縣市議員" 生效；其他選舉類型的候選人不會有這個欄位。
 */
export function normalizeCandidacyDistrictField(payload: Record<string, unknown>): void {
  if (payload.election_type !== "縣市議員") return;
  const existing = payload.electoral_district;
  if (typeof existing === "string" && existing.trim()) {
    const parsed = normalizeDistrict(existing);
    if (parsed) payload.electoral_district = parsed.district;
    return;
  }
  const position = payload.position;
  if (typeof position === "string" && position.trim()) {
    const parsed = normalizeDistrict(position);
    if (parsed) payload.electoral_district = parsed.district;
  }
}

/**
 * 縣市議員原住民保留選舉區（2026-09-28）。
 *
 * electoral_district_areas 只收「鄉鎮↔一般地理選舉區」對照；原住民保留議席不對應任何鄉鎮
 * （在籍原住民選民另外投票，全縣或跨鄉鎮圈出票源），名冊裡查不到，交件驗證選區存不存在時
 * 要另外對這份常數放行，不然真的登記在保留議席的候選人會被 unknown_electoral_district 誤擋。
 *
 * 逐縣市來源（2026-09-28 查證）：
 * - 新北市 12(平地)/13(山地)、桃園市 13(平地)/14(山地)、台南市 12(平地)/13(山地)、
 *   宜蘭縣 11(平地)/12(山地)/13(山地)：docs/DISTRICT-REGISTRY-2026.md（2022 屆已存在、一般選區
 *   2026 未變，這些縣市不在中選會第618次會議「選舉區變更」名單裡，沿用 2022 保留議席編號）。
 * - 高雄市 12–15（4 席保留議席，2022 屆已存在）：docs/DISTRICT-REGISTRY-2026.md，另以 2026
 *   候選人登記名冊 PDF 核對。
 * - 台北市 07(平地)/08(山地)：中選會選舉公報 PDF 直接核對
 *   （https://eebulletin.cec.gov.tw/111/02臺北市/02市議員/臺北市第08選舉區.pdf，
 *   內文「第7選舉區( 平地原住民)」字樣）。
 * - 南投縣 06(平地)/07(信義鄉山地)/08(仁愛鄉山地)：2022 候選人號次抽籤新聞逐字核對
 *   （中國時報「南投縣議員第1選區26人角逐10席」系列報導的抽籤名單）。
 * - 台中市 15(平地)/16(山地)：2022 當選人名單新聞核對（第15選區當選人吳建德、第16選區當選人古秀英）。
 * - 彰化縣 09(平地，2022 已有)/10(山地，2026 新增)、基隆市 08(平地，2022 已有)/09(山地，2026 新增)、
 *   新竹市 06(平地，2022 已有)/07(山地，2026 新增)：中選會第618次委員會議決議報導（中央社
 *   2026-07-18，<https://www.cna.com.tw/news/aipl/202507180239.aspx>）逐字寫「增設第10選舉區
 *   （彰化縣的山地原住民）」「增設第9選舉區（基隆市的山地原住民）」「增設第7選舉區（新竹市的
 *   山地原住民）」——這三縣市 2022 屆本來就各有一席「平地原住民」（分別是 09／08／06，另外查證
 *   確認），2026 是「加開山地原住民」，不是從零新增；docs/DISTRICT-REGISTRY-2026.md 只記了新增
 *   的那個號碼，這裡把既有那席也一併補上，不然既有的平地原住民候選人反而會被擋。
 * - 雲林縣 07(平地)/08(山地)：同一篇中央社報導，「增設第7選舉區（雲林縣的平地原住民）及第8選舉區
 *   （雲林縣的山地原住民）」——雲林縣 2022 屆確實沒有原住民保留議席，兩席都是 2026 新增。
 *
 * 還沒查證、暫不列入（有這幾縣市保留議席候選人交件時會被 unknown_electoral_district 擋下，
 * 之後查證確認再補；見任務回報「沒把握的地方」）：屏東縣、苗栗縣、台東縣、花蓮縣、嘉義縣——
 * 網路上查得到的號碼彼此衝突、拼湊不出跟上面幾縣市一樣逐字可核對的官方文件，寧可讓這幾縣市的
 * 保留議席候選人交件時多一步人工確認，也不要把猜的號碼當正式資料收進驗證常數。
 */
export const COUNCIL_ABORIGINAL_DISTRICTS: Readonly<Record<string, readonly string[]>> = {
  台北市: ["第07選舉區", "第08選舉區"],
  新北市: ["第12選舉區", "第13選舉區"],
  桃園市: ["第13選舉區", "第14選舉區"],
  台中市: ["第15選舉區", "第16選舉區"],
  台南市: ["第12選舉區", "第13選舉區"],
  高雄市: ["第12選舉區", "第13選舉區", "第14選舉區", "第15選舉區"],
  南投縣: ["第06選舉區", "第07選舉區", "第08選舉區"],
  彰化縣: ["第09選舉區", "第10選舉區"],
  雲林縣: ["第07選舉區", "第08選舉區"],
  基隆市: ["第08選舉區", "第09選舉區"],
  新竹市: ["第06選舉區", "第07選舉區"],
  宜蘭縣: ["第11選舉區", "第12選舉區", "第13選舉區"],
};

/** 縣市＋（已正規化的）選舉區號碼是不是該縣市的原住民保留議席 */
export function isCouncilAboriginalDistrict(region: string, district: string): boolean {
  return (COUNCIL_ABORIGINAL_DISTRICTS[region] ?? []).includes(district);
}
