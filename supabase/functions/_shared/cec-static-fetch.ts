/**
 * 中選會「靜態 JSON」選舉資料庫的共用邏輯：URL 規則、HTTP 抓取、候選人列的地區解析。
 * fetch-cec-data（代理查單一選區用）與 cec-sync（整批同步用）都靠這份，改路徑規則兩邊要一起動。
 * 詳見 fetch-cec-data/index.ts 開頭的說明（2026-09 中選會改版後的路徑規則）。
 */

import { CITY_NAME_BY_CODE, normalizeCityName } from "./cec-city-codes.ts";

export const CEC_BASE = "https://db.cec.gov.tw/static/elections";
export const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 PolicyTracker/1.0";

/** 選舉類型對應（內部代碼，沿用舊版、與 AdminScraper 一致） */
export const SUBJECT_MAP: Record<string, { subjectId: string; legisId: string; defaultLevel: string }> = {
  President: { subjectId: "P0", legisId: "00", defaultLevel: "N" },
  Legislator: { subjectId: "L0", legisId: "L1", defaultLevel: "A" },
  Mayor: { subjectId: "C1", legisId: "00", defaultLevel: "C" },
  CountyMayor: { subjectId: "C2", legisId: "00", defaultLevel: "C" },
  CouncilMember: { subjectId: "T1", legisId: "T1", defaultLevel: "A" },
  CountyCouncilMember: { subjectId: "T2", legisId: "T1", defaultLevel: "A" },
  CityMayor: { subjectId: "D2", legisId: "00", defaultLevel: "D" },
  DistrictExecutive: { subjectId: "D1", legisId: "00", defaultLevel: "D" },
  CityRepresentatives: { subjectId: "R2", legisId: "R1", defaultLevel: "A" },
  DistrictRepresentatives: { subjectId: "R1", legisId: "R3", defaultLevel: "A" },
  Village: { subjectId: "V0", legisId: "00", defaultLevel: "L" },
};

export interface CecRow {
  cand_id?: number;
  cand_name?: string;
  cand_no?: number;
  party_name?: string;
  party_code?: number;
  cand_sex?: string;
  cand_birthday?: string;
  cand_birthyear?: string | number;
  cand_edu?: string;
  is_current?: string;
  is_victor?: string;
  is_vice?: string;
  area_name?: string;
  prv_code?: string;
  city_code?: string;
  area_code?: string;
  dept_code?: string;
  li_code?: string;
  ticket_num?: number;
  ticket_percent?: number;
}

export type FetchOutcome =
  | { kind: "ok"; rows: CecRow[]; url: string }
  | { kind: "nodata"; url: string }
  | { kind: "error"; url: string; message: string; preview?: string };

/** 抓一個靜態 JSON 檔；回 HTML／非 JSON 一律當錯誤回報，不靜默。 */
export async function fetchCecJson(url: string): Promise<FetchOutcome> {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json, */*",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "User-Agent": USER_AGENT,
      "Referer": "https://db.cec.gov.tw/ElecTable/Election",
    },
  });
  if (response.status === 404) return { kind: "nodata", url };
  const text = await response.text();
  if (!response.ok) return { kind: "error", url, message: `CEC 回應 HTTP ${response.status}`, preview: text.slice(0, 200) };
  const contentType = response.headers.get("content-type") || "";
  if (text.trimStart().startsWith("<") || (!contentType.includes("json") && !text.trimStart().startsWith("{") && !text.trimStart().startsWith("["))) {
    console.error("CEC 回傳 HTML 而非 JSON:", url, text.slice(0, 300));
    return { kind: "error", url, message: "CEC 回傳非 JSON 格式（路徑改版、被阻擋或維護中）", preview: text.slice(0, 200) };
  }
  try {
    const data = JSON.parse(text);
    // 資料檔是 { "<scope>": [rows] }，可能多個 key；清單檔是陣列
    const rows: CecRow[] = Array.isArray(data)
      ? data
      : Object.values(data).flatMap((v) => (Array.isArray(v) ? v : []));
    return { kind: "ok", rows, url };
  } catch (e) {
    return { kind: "error", url, message: `無法解析 CEC JSON: ${(e as Error).message}`, preview: text.slice(0, 200) };
  }
}

export function parseBirthYear(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let year = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (Number.isNaN(year)) return undefined;
  if (year < 1000) year += 1911; // 民國轉西元
  return year;
}

export function normalizeParty(raw: string | undefined): string {
  const p = (raw || "").trim();
  if (!p || p === "無" || p === "無黨籍及未經政黨推薦" || p === "無黨籍及未經政黨推薦者") return "無黨籍";
  return p;
}

export interface LocatedRow {
  region: string;
  subRegion?: string;
  village?: string;
}

/** 依選舉層級決定 region / subRegion / village 怎麼從 area_name 與代碼取（electionType 是 SUBJECT_MAP 的內部代碼） */
export function locateRow(
  row: CecRow,
  electionType: string,
  requestedCity: string | undefined,
  deptNames: ReadonlyMap<string, string> = new Map(),
): LocatedRow {
  const codeCity = normalizeCityName(CITY_NAME_BY_CODE.get(`${row.prv_code}_${row.city_code}`));
  const areaName = normalizeCityName(row.area_name);
  const isNationalScope = row.prv_code === "00" && row.city_code === "000";

  if (electionType === "President") return { region: "全國" };
  if (electionType === "Mayor" || electionType === "CountyMayor") {
    // 縣市長：area_name 就是縣市
    return { region: areaName || codeCity || requestedCity || "未知" };
  }
  const region = (isNationalScope ? undefined : codeCity) || requestedCity || (electionType === "Legislator" && areaName ? areaName.replace(/第\d+選區.*$/, "") : undefined) || "未知";
  if (electionType === "Village") {
    return { region, village: areaName, subRegion: row.dept_code ? deptNames.get(row.dept_code) : undefined };
  }
  return { region, subRegion: areaName };
}
