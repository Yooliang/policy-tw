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

import type { CecRow, FetchOutcome, LocatedRow } from "./cec-static-fetch.ts";
import { CEC_BASE, LEGISLATOR_AT_LARGE_SUBJECTS, locateRow, parseBirthYear, SUBJECT_MAP } from "./cec-static-fetch.ts";
import { ALL_REGIONS, CITY_CODES, DIRECT_CITIES } from "./cec-city-codes.ts";

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
    .replace(/[\s·．.・‧•]/g, ""); // NFKC 會把全形「．」變成半形「.」，兩個都去（SQL 版 cec_name_norm 同步）
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
  LegislatorPlainIndigenous: "立法委員",
  LegislatorMountainIndigenous: "立法委員",
  LegislatorParty: "立法委員",
  Mayor: "縣市長",
  CountyMayor: "縣市長",
  CouncilMember: "縣市議員",
  CountyCouncilMember: "縣市議員",
  CityMayor: "鄉鎮市長",
  DistrictExecutive: "直轄市山地原住民區長",
  CityRepresentatives: "鄉鎮市民代表",
  DistrictRepresentatives: "直轄市山地原住民區民代表",
  Village: "村里長",
  // 原住民選區（2026-10-05）：選舉別跟一般選區相同，只是中選會另開一筆場次
  CouncilMemberPlainIndigenous: "縣市議員",
  CouncilMemberMountainIndigenous: "縣市議員",
  CountyCouncilMemberPlainIndigenous: "縣市議員",
  CountyCouncilMemberMountainIndigenous: "縣市議員",
  CityRepresentativesPlainIndigenous: "鄉鎮市民代表",
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
  /**
   * 同一個（屆別, 選舉別, 縣市）底下還要再分的範圍：不分區／平地原住民／山地原住民立委都是
   * region＝「全國」，同步是「整個範圍先刪再寫」，不再分一層的話三種會互相刪掉對方（2026-10-05）。
   */
  subRegion?: string;
  /**
   * 同一個同步範圍裡要一起抓的其他科目：議員、鄉鎮市民代表的原住民選區（2026-10-05）。
   * 原住民選區跟一般選區同一個縣市、選區號碼接在後面（台北市一般 01～06、原住民 07／08），
   * sub_region 是各個選區、沒辦法像全國立委那樣拿來分範圍——拆成兩個單位的話後跑的會把先跑的刪掉，
   * 所以併進同一個單位：全部科目都抓成功才在同一次「先刪再寫」裡一起寫。
   */
  extraCecTypes?: readonly string[];
}

/** 議員的原住民選區：直轄市（科目 T1）與縣市（科目 T2）各有平地、山地兩筆場次 */
const COUNCIL_INDIGENOUS_DIRECT: readonly string[] = ["CouncilMemberPlainIndigenous", "CouncilMemberMountainIndigenous"];
const COUNCIL_INDIGENOUS_COUNTY: readonly string[] = ["CountyCouncilMemberPlainIndigenous", "CountyCouncilMemberMountainIndigenous"];
/** 鄉鎮市民代表的原住民選區：中選會清單（ELC_R2）2022 只有「區域」與「平地原住民」兩筆 */
const REPRESENTATIVES_INDIGENOUS: readonly string[] = ["CityRepresentativesPlainIndigenous"];

/** 全國一個選區的立委（cec_candidates.sub_region 的值），順序就是同步順序 */
export const LEGISLATOR_AT_LARGE_UNITS: readonly SyncUnitPlan[] = [
  { region: "全國", cecType: "LegislatorParty", subRegion: "不分區" },
  { region: "全國", cecType: "LegislatorPlainIndigenous", subRegion: "平地原住民" },
  { region: "全國", cecType: "LegislatorMountainIndigenous", subRegion: "山地原住民" },
];

const NON_DIRECT_REGIONS = ALL_REGIONS.filter((r) => !DIRECT_CITIES.has(r));

/** 某個我們的 election_type，該去打中選會哪些（縣市, 內部代碼）組合 */
export function planUnits(type: OurElectionType | string): SyncUnitPlan[] {
  switch (type) {
    case "總統副總統":
      return [{ region: "全國", cecType: "President" }];
    case "立法委員":
      return [...ALL_REGIONS.map((region) => ({ region, cecType: "Legislator" })), ...LEGISLATOR_AT_LARGE_UNITS];
    case "縣市長":
      return [
        ...[...DIRECT_CITIES].map((region) => ({ region, cecType: "Mayor" })),
        ...NON_DIRECT_REGIONS.map((region) => ({ region, cecType: "CountyMayor" })),
      ];
    case "縣市議員":
      return [
        ...[...DIRECT_CITIES].map((region) => ({ region, cecType: "CouncilMember", extraCecTypes: COUNCIL_INDIGENOUS_DIRECT })),
        ...NON_DIRECT_REGIONS.map((region) => ({ region, cecType: "CountyCouncilMember", extraCecTypes: COUNCIL_INDIGENOUS_COUNTY })),
      ];
    case "鄉鎮市長":
      return NON_DIRECT_REGIONS.map((region) => ({ region, cecType: "CityMayor" }));
    case "直轄市山地原住民區長":
      return DISTRICT_REP_CITIES.map((region) => ({ region, cecType: "DistrictExecutive" }));
    case "鄉鎮市民代表":
      return NON_DIRECT_REGIONS.map((region) => ({ region, cecType: "CityRepresentatives", extraCecTypes: REPRESENTATIVES_INDIGENOUS }));
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

// ── 挑場次（theme） ─────────────────────────────────────────────
export interface ThemeInfo {
  themeId: string;
  themeName: string;
  voteDate?: string;
  year?: number;
  /**
   * 同一份清單裡的哪一種（中選會的 legislator_type_id）：立委 L1 區域／L2 平地原住民／L3 山地原住民／L4 不分區政黨；
   * 議員 T1 區域／T2 平地原住民／T3 山地原住民；鄉鎮市民代表 R1 區域／R2 平地原住民；只有一種的科目是「00」或該科目自己的代碼。
   */
  legislatorTypeId?: string;
}

/** 清單檔（ELC_<科目>.json）攤平成場次：列是「地區＋該地區的 theme_items」，不是候選人列 */
export function themesFromList(rows: readonly unknown[]): ThemeInfo[] {
  return (rows as Array<{ theme_items?: Array<Record<string, unknown>> }>).flatMap((area) =>
    (area?.theme_items ?? []).map((t) => ({
      themeId: String(t.theme_id ?? ""),
      themeName: String(t.theme_name ?? ""),
      voteDate: t.vote_date ? String(t.vote_date) : undefined,
      year: t.vote_date ? parseInt(String(t.vote_date).slice(0, 4), 10) : undefined,
      legislatorTypeId: t.legislator_type_id ? String(t.legislator_type_id) : undefined,
    }))
  );
}

type SubjectKey = { subjectId: string; legisId: string };

/** 這筆場次是不是這個科目要的那一種（legislator_type_id 對上 SUBJECT_MAP 的 legisId） */
function themeMatchesSubject(t: ThemeInfo, subject?: SubjectKey): boolean {
  if (!subject) return true;
  // 立委四種同一份清單、同一個投票日，清單沒標種類的就不收（#332 第 2b 項：不能退回去拿區域那筆）
  if (subject.subjectId === "L0") return t.legislatorTypeId === subject.legisId;
  // 其他科目：清單有標種類就要對上（議員、代表的原住民選區跟一般選區同屆同日，2026-10-05）
  return t.legislatorTypeId === undefined || t.legislatorTypeId === subject.legisId;
}

/**
 * 該屆可用的場次，依優先順序：先「不是重行選舉」的、再重行選舉的。
 *
 * 同年可能不只一筆：嘉義市 2022 縣市長原訂 11-26 因候選人過世延到 12-18「重行選舉」，中選會另開一筆場次，
 * 而 11-26 那筆的全國檔裡根本沒有嘉義市。呼叫端（collectPart）依序試，哪一筆有這個縣市的人就用哪一筆；
 * 2026-10-05 前只取第一筆，嘉義市長 2022 一位都沒進 cec_candidates。
 *
 * 種類（legislator_type_id）要對上科目的 legisId：立委、議員、代表的區域與原住民選區同屆同日、同在一份清單，
 * 2026-10-05 前只有立委有對（#357），議員與代表照舊挑「第一筆」——剛好是區域那筆，原住民選區從來沒被抓過。
 */
export function pickThemes(themes: readonly ThemeInfo[], electionId: number, subject?: SubjectKey): ThemeInfo[] {
  const matches = themes.filter((t) => t.year === electionId && themeMatchesSubject(t, subject));
  const isRedo = (t: ThemeInfo) => t.themeName.includes("重行選舉");
  return [...matches.filter((t) => !isRedo(t)), ...matches.filter(isRedo)];
}

/** pickThemes 的第一順位（舊介面，給只要一筆的呼叫端） */
export function pickTheme(themes: readonly ThemeInfo[], electionId: number, subject?: SubjectKey): ThemeInfo | undefined {
  return pickThemes(themes, electionId, subject)[0];
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

// ── 一個同步單位要抓的東西（2026-10-05 從 cec-sync/index.ts 搬來，好讓「試哪幾筆場次、併哪幾個科目」有測試） ──

/** 縣市長／總統／全國一個選區的立委只有全國範圍的檔（縣市範圍會 404），要抓全國檔再依縣市過濾 */
export function isNationalOnly(cecType: string): boolean {
  return cecType === "President" || cecType === "Mayor" || cecType === "CountyMayor" || cecType in LEGISLATOR_AT_LARGE_SUBJECTS;
}

export function scopeFor(cecType: string, region: string): { prv: string; city: string } {
  if (isNationalOnly(cecType)) return { prv: "00", city: "000" };
  const codes = CITY_CODES[region];
  return { prv: codes?.prv ?? "00", city: codes?.city ?? "000" };
}

/** 抓中選會的外部依賴：呼叫端負責請求間隔與快取（測試塞假資料） */
export interface CecFetchDeps {
  /** 這個科目的場次清單（ELC_<科目>.json 攤平） */
  themes: (cecType: string) => Promise<ThemeInfo[]>;
  /** 抓一個靜態 JSON 檔 */
  fetchJson: (url: string) => Promise<FetchOutcome>;
}

export interface PartResult {
  cecType: string;
  themeId: string;
  /** 中選會檔案裡的列數（過濾縣市之前） */
  fetched: number;
  rows: CecCandidateRow[];
}

/** 用某一筆場次抓這個縣市的名單（候選人檔＋得票檔；村里長另抓鄉鎮名對照） */
async function fetchThemeRows(
  electionId: number,
  ourType: string,
  cecType: string,
  region: string,
  theme: ThemeInfo,
  deps: CecFetchDeps,
): Promise<PartResult> {
  const subject = SUBJECT_MAP[cecType];
  const { prv, city } = scopeFor(cecType, region);
  const scope = `${prv}_${city}_00_000_0000`;
  const pathTail = `ELC/${subject.subjectId}/${subject.legisId}/${theme.themeId}/${subject.defaultLevel}/${scope}.json`;
  const candOutcome = await deps.fetchJson(`${CEC_BASE}/data/candidates/${pathTail}`);
  const ticketOutcome = await deps.fetchJson(`${CEC_BASE}/data/tickets/${pathTail}`);
  if (candOutcome.kind === "error") throw new Error(`candidates: ${candOutcome.message}`);
  if (ticketOutcome.kind === "error") throw new Error(`tickets: ${ticketOutcome.message}`);

  // 村里長：area_name 是里名，鄉鎮市區名要另抓 areas 檔用 dept_code 對
  const deptNames = new Map<string, string>();
  if (cecType === "Village") {
    const areasOutcome = await deps.fetchJson(`${CEC_BASE}/data/areas/ELC/${subject.subjectId}/${subject.legisId}/${theme.themeId}/D/${scope}.json`);
    if (areasOutcome.kind === "ok") {
      for (const a of areasOutcome.rows) if (a.dept_code && a.area_name) deptNames.set(a.dept_code, a.area_name);
    }
    // areas 抓不到不算致命：subRegion 會是空的，候選人本身還是抓得到
  }

  const ticketsById = new Map<number, CecRow>();
  if (ticketOutcome.kind === "ok") {
    for (const t of ticketOutcome.rows) if (t.cand_id !== undefined) ticketsById.set(t.cand_id, t);
  }
  // 候選人檔為主；候選人檔不存在（404）時只用得票檔（得票檔也有姓名／政黨／出生年，村里長、代表的原住民選區就是這種情況）
  const baseRows = candOutcome.kind === "ok" ? candOutcome.rows : [...ticketsById.values()];
  const requestedRegion = region === "全國" ? undefined : region;
  const rows = baseRows
    .filter((row) => row.cand_name)
    .map((row) => {
      const ticket = row.cand_id !== undefined ? ticketsById.get(row.cand_id) : undefined;
      return toCecCandidateRow(row, ticket, { electionId, ourType, cecType, themeId: theme.themeId, requestedRegion, deptNames });
    })
    .filter((r): r is CecCandidateRow => r !== null)
    // 全國範圍的檔（總統／縣市長／全國一個選區的立委）要再依縣市過濾；用轉換後的 region 比對，跟 fetch-cec-data 一致
    .filter((r) => !isNationalOnly(cecType) || region === "全國" || r.region === region);
  return { cecType, themeId: theme.themeId, fetched: baseRows.length, rows };
}

/**
 * 一個科目：依 pickThemes 的順序試場次，第一個抓得到這個縣市的人的就用它；都抓不到人就回第一順位的空結果。
 * 找不到場次、或任何一個檔抓失敗（不是 404）就丟錯——呼叫端整個單位跳過、保留舊資料，不能當成「這裡沒有人」去刪。
 */
export async function collectPart(electionId: number, ourType: string, cecType: string, region: string, deps: CecFetchDeps): Promise<PartResult> {
  const subject = SUBJECT_MAP[cecType];
  if (!subject) throw new Error(`不認得的中選會科目 ${cecType}`);
  const candidates = pickThemes(await deps.themes(cecType), electionId, subject);
  if (candidates.length === 0) throw new Error(`找不到 ${electionId} 年的 theme（cecType=${cecType}）`);
  let first: PartResult | undefined;
  for (const theme of candidates) {
    const got = await fetchThemeRows(electionId, ourType, cecType, region, theme, deps);
    if (got.rows.length > 0) return got;
    first ??= got;
  }
  return first!;
}

/** 一個同步單位（屆別×選舉別×縣市）：主科目＋同範圍的其他科目（原住民選區）全部抓成功才回傳 */
export async function collectUnitRows(
  electionId: number,
  ourType: string,
  plan: SyncUnitPlan,
  deps: CecFetchDeps,
): Promise<{ fetched: number; rows: CecCandidateRow[]; parts: PartResult[] }> {
  const parts: PartResult[] = [];
  for (const cecType of [plan.cecType, ...(plan.extraCecTypes ?? [])]) {
    parts.push(await collectPart(electionId, ourType, cecType, plan.region, deps));
  }
  return {
    fetched: parts.reduce((n, p) => n + p.fetched, 0),
    rows: parts.flatMap((p) => p.rows),
    parts,
  };
}
