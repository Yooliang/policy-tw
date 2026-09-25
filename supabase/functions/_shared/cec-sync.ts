/**
 * cec-sync 的純函式部分：姓名解碼／正規化、選舉別對照、同步單位規劃、CEC 列 → cec_candidates 列。
 *
 * 姓名這幾個坑是上一輪子代理（scripts_2022/match.mjs）逐筆比對 2022 名冊時踩出來的，這裡原樣沿用：
 *   ① 中選會罕見字寫成 "@十六進位碼位@"（如 "林@2C9F7@昌"），要先解碼成實際字元，否則永遠比對不上
 *   ② 有些罕見字解碼後是「CJK 相容表意文字」，跟我們資料庫存的一般統一表意文字視覺相同、碼位不同，
 *      要 NFKC 正規化收斂成同一碼位
 *   ③ 中選會「黃」姓常整批寫成異體字「黄」（非 NFKC 分解能解決的），是資料庫本身的系統性寫法
 *   ④ 原住民姓名常有間隔號（．·・‧•）分隔族名/教名，中選會姓名欄有時還附註英文拼音
 *   ⑤ 「臺」「台」混用
 *
 * name_norm 的核心規則（NFKC → 臺→台、黄→黃 → 去空白與間隔號）要跟 migration 裡的 SQL 函式
 * cec_name_norm 逐字一致（見 20260926000001_cec_candidates.sql）；「去掉尾端拉丁拼音」是額外加的
 * 一步，因為只有中選會的原始姓名欄會夾英文拼音，我們自己資料庫的姓名不會，所以 SQL 那份不用管這步、
 * 但這裡的 name_norm 要先去掉才能跟 SQL 版對上。
 */

import type { CecRow, LocatedRow } from "./cec-static-fetch.ts";
import { locateRow, parseBirthYear } from "./cec-static-fetch.ts";
import { ALL_REGIONS, DIRECT_CITIES } from "./cec-city-codes.ts";

/** 中選會罕見字逸出寫法：@十六進位碼位@ */
const CEC_ESCAPE_RE = /@([0-9A-Fa-f]{4,5})@/g;

export function decodeCecEscapes(s: string): string {
  return s.replace(CEC_ESCAPE_RE, (whole, hex) => {
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch {
      return whole;
    }
  });
}

/** cec_candidates.name：只解回罕見字，不做其他改動（保留原字、間隔號、附註拼音） */
export function cecCandidateName(raw: string | null | undefined): string {
  return decodeCecEscapes(String(raw ?? "")).trim();
}

/** 去掉尾端附註的拉丁拼音（原住民姓名常見，如「谷辣斯．尤達卡 Kolas Yotaka」） */
function stripTrailingLatin(s: string): string {
  return s.replace(/[A-Za-z]+$/, "");
}

/**
 * cec_candidates.name_norm：跟 SQL 函式 cec_name_norm 一致的部分是
 * 「NFKC → 臺→台、黄→黃 → 去空白與間隔號」；再多做一步「去尾端拉丁拼音」。
 */
export function cecNameNorm(raw: string | null | undefined): string {
  const decoded = decodeCecEscapes(String(raw ?? ""));
  const collapsed = decoded
    .normalize("NFKC")
    .replace(/臺/g, "台")
    .replace(/黄/g, "黃")
    .replace(/[\s·．・‧•]/g, "");
  return stripTrailingLatin(collapsed);
}

// ── 選舉別對照：中選會內部代碼 → 我們的九種 election_type ───────────────
// 中選會的「直轄市長」「直轄市議員」在我們這裡併成「縣市長」「縣市議員」
// （跟 fetch-cec-data 的 ELECTION_TYPE_MAP 不同：那份是給代理看的候選人職稱標籤，
// 這份是要寫進 cec_candidates.election_type、要跟 politician_elections.election_type 對得上）。
export const OUR_ELECTION_TYPES = [
  "總統副總統",
  "立法委員",
  "縣市長",
  "縣市議員",
  "鄉鎮市長",
  "直轄市山地原住民區長",
  "鄉鎮市民代表",
  "直轄市山地原住民區民代表",
  "村里長",
] as const;

export type OurElectionType = typeof OUR_ELECTION_TYPES[number];

const CEC_TYPE_TO_OUR: Record<string, OurElectionType> = {
  President: "總統副總統",
  Legislator: "立法委員",
  Mayor: "縣市長",
  CountyMayor: "縣市長",
  CouncilMember: "縣市議員",
  CountyCouncilMember: "縣市議員",
  CityMayor: "鄉鎮市長",
  DistrictExecutive: "直轄市山地原住民區長",
  CityRepresentatives: "鄉鎮市民代表",
  DistrictRepresentatives: "直轄市山地原住民區民代表",
  Village: "村里長",
};

export function ourElectionType(cecType: string): OurElectionType | null {
  return CEC_TYPE_TO_OUR[cecType] ?? null;
}

// ── 同步單位規劃：屆別（呼叫端決定）× 選舉別 × 縣市 ───────────────────
// 直轄市山地原住民區長／區民代表只存在於這幾個直轄市（有山地原住民區的六都子集）
export const DISTRICT_REP_CITIES: readonly string[] = ["新北市", "桃園市", "台中市", "高雄市"];

export interface SyncUnitPlan {
  /** 縣市（cec_candidates.region 用這個） */
  region: string;
  /** 中選會內部代碼（SUBJECT_MAP 的 key），決定要打哪個科目 */
  cecType: string;
}

const NON_DIRECT_REGIONS = ALL_REGIONS.filter((r) => !DIRECT_CITIES.has(r));

/** 某個我們的 election_type，該去打中選會哪些（縣市, 內部代碼）組合 */
export function planUnits(type: OurElectionType | string): SyncUnitPlan[] {
  switch (type) {
    case "總統副總統":
      return [{ region: "全國", cecType: "President" }];
    case "立法委員":
      return ALL_REGIONS.map((region) => ({ region, cecType: "Legislator" }));
    case "縣市長":
      return [
        ...[...DIRECT_CITIES].map((region) => ({ region, cecType: "Mayor" })),
        ...NON_DIRECT_REGIONS.map((region) => ({ region, cecType: "CountyMayor" })),
      ];
    case "縣市議員":
      return [
        ...[...DIRECT_CITIES].map((region) => ({ region, cecType: "CouncilMember" })),
        ...NON_DIRECT_REGIONS.map((region) => ({ region, cecType: "CountyCouncilMember" })),
      ];
    case "鄉鎮市長":
      return NON_DIRECT_REGIONS.map((region) => ({ region, cecType: "CityMayor" }));
    case "直轄市山地原住民區長":
      return DISTRICT_REP_CITIES.map((region) => ({ region, cecType: "DistrictExecutive" }));
    case "鄉鎮市民代表":
      return NON_DIRECT_REGIONS.map((region) => ({ region, cecType: "CityRepresentatives" }));
    case "直轄市山地原住民區民代表":
      return DISTRICT_REP_CITIES.map((region) => ({ region, cecType: "DistrictRepresentatives" }));
    case "村里長":
      return ALL_REGIONS.map((region) => ({ region, cecType: "Village" }));
    default:
      return [];
  }
}

// ── 已投票的屆別 ──────────────────────────────────────────────────
interface KnownElection {
  electionId: number;
  voteDate: string; // YYYY-MM-DD
}

// 2026 屆投票日是 2026-11-28（公告的九合一選舉日）；沒到那天之前不算「已投票」
const KNOWN_ELECTIONS: readonly KnownElection[] = [
  { electionId: 2022, voteDate: "2022-11-26" },
  { electionId: 2024, voteDate: "2024-01-13" },
  { electionId: 2026, voteDate: "2026-11-28" },
];

/** 已經投票的屆別（year）；預設用今天判斷 */
export function votedElectionIds(today: Date = new Date()): number[] {
  const todayStr = today.toISOString().slice(0, 10);
  return KNOWN_ELECTIONS.filter((e) => e.voteDate <= todayStr).map((e) => e.electionId);
}

// ── CEC 列 → cec_candidates 列 ───────────────────────────────────
export interface CecCandidateRow {
  election_id: number;
  election_type: string;
  region: string;
  sub_region: string | null;
  village: string | null;
  name: string;
  name_norm: string;
  birth_year: number | null;
  cand_no: number | null;
  elected: boolean;
  cec_theme_id: string | null;
  cec_cand_id: number | null;
}

export interface RowContext {
  electionId: number;
  /** 我們的九種之一，寫進 election_type */
  ourType: string;
  /** 中選會內部代碼，給 locateRow 判斷 region/subRegion/village 怎麼取 */
  cecType: string;
  themeId: string;
  requestedRegion?: string;
  deptNames?: ReadonlyMap<string, string>;
}

/**
 * 候選人檔一列（可能已與得票檔合併）＋得票檔對應那列（可能沒有，例如候選人檔 404 時整批來自得票檔，
 * 這時 row 本身就是 ticket，呼叫端可以把同一個物件傳兩次)。姓名是空的就回 null（呼叫端跳過該列）。
 */
export function toCecCandidateRow(row: CecRow, ticket: CecRow | undefined, ctx: RowContext): CecCandidateRow | null {
  const rawName = row.cand_name ?? ticket?.cand_name;
  if (!rawName || !rawName.trim()) return null;
  const merged: CecRow = { ...(ticket ?? {}), ...row };
  const located: LocatedRow = locateRow(merged, ctx.cecType, ctx.requestedRegion, ctx.deptNames);
  const elected = ((ticket?.is_victor ?? merged.is_victor) ?? "").trim() === "*";
  return {
    election_id: ctx.electionId,
    election_type: ctx.ourType,
    region: located.region,
    sub_region: located.subRegion ?? null,
    village: located.village ?? null,
    name: cecCandidateName(rawName),
    name_norm: cecNameNorm(rawName),
    birth_year: parseBirthYear(merged.cand_birthyear) ?? null,
    cand_no: merged.cand_no ?? null,
    elected,
    cec_theme_id: ctx.themeId,
    cec_cand_id: merged.cand_id ?? null,
  };
}
