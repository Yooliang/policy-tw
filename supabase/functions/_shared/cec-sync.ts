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

/**
 * cec_candidates.party：中選會名冊上這一筆的推薦政黨，原字照存（快照；「無黨籍及未經政黨推薦」也照存），只解回罕見字。
 * 對到哪個政黨由資料庫的 party_aliases 決定（party_alias_key），不在這裡正規化——對不到的寫法會出現在 party_alias_gaps。
 * 空的回 null（2026-10-06，#346 第二階段：補參選紀錄那一次的政黨）。
 */
export function cecPartyText(raw: string | null | undefined): string | null {
  const s = decodeCecEscapes(String(raw ?? "")).trim();
  return s === "" ? null : s;
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

// ── 選舉由 elections 表驅動（#344 第二階段 A）─────────────────────────
// 原本這裡寫死三屆（KNOWN_ELECTIONS）、用年份對中選會的場次；補選、重行選舉的 id 不是年份，年份也分不開同年的兩場。
// 現在呼叫端（cec-sync/index.ts）查 elections 表，場次用投票日對（中選會清單每個場次的 vote_date 跟 elections.election_date 一致，
// 2022／2024 全部科目 10-06 實抓核對過）。

/** cec-sync 用到的選舉欄位（elections 表的子集） */
export interface SyncElection {
  id: number;
  /** 投票日 YYYY-MM-DD */
  election_date: string;
  election_key: string;
  election_reason: string;
  /** 這次選哪些職位（九種之一）；空的＝不知道，同步所有職位 */
  election_types: readonly string[];
}

/** 同一個同步單位預設 24 小時內同步過就空轉（防止重複打中選會） */
export const DEFAULT_MIN_INTERVAL_HOURS = 24;
/** 呼叫端可以調短的下限：開票當晚要每小時更新一次結果，但不能短到變成連續轟炸中選會 */
export const MIN_INTERVAL_HOURS_FLOOR = 0.25;

/**
 * 請求 body 的 min_interval_hours：這個單位多久內同步過就空轉。沒給＝24 小時；開票當晚的排程給 1（每小時重抓一次結果）。
 * 只允許 0.25～24：比 24 長沒意義（預設就是 24）、比 0.25 短等於沒有防重入。不是數字就回錯誤，不靜默改回預設。
 */
export function parseMinIntervalHours(raw: unknown): { ok: true; hours: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, hours: DEFAULT_MIN_INTERVAL_HOURS };
  const n = typeof raw === "number" ? raw : /^\d+(\.\d+)?$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
  if (!Number.isFinite(n) || n < MIN_INTERVAL_HOURS_FLOOR || n > DEFAULT_MIN_INTERVAL_HOURS) {
    return { ok: false, error: `min_interval_hours 要是 ${MIN_INTERVAL_HOURS_FLOOR}～${DEFAULT_MIN_INTERVAL_HOURS} 之間的數字（收到 ${JSON.stringify(raw)}）` };
  }
  return { ok: true, hours: n };
}

/** 已經投票的選舉（投票日當天起算）；罷免投票不選人、沒有候選人名單，不算 */
export function votedElections<T extends Pick<SyncElection, "election_date" | "election_reason">>(elections: readonly T[], today: Date = new Date()): T[] {
  const todayStr = today.toISOString().slice(0, 10);
  return elections.filter((e) => e.election_date <= todayStr && e.election_reason !== "recall");
}

/**
 * 不是全國同日的選舉（補選、重行選舉）的 election_key 最後一段是內政部行政區代碼（嘉義市＝10020），
 * 對到縣市名；全國同日的（local／national）回 null。內政部代碼＝中選會的 prv＋city（63000 台北市、10020 嘉義市）。
 */
export function electionAreaRegion(election: Pick<SyncElection, "election_key">): string | null {
  const code = election.election_key.split("_")[2];
  if (!code) return null;
  for (const [name, c] of Object.entries(CITY_CODES)) if (`${c.prv}${c.city}` === code) return name;
  return null;
}

/** 這場選舉要同步的職位（elections.election_types ∩ 九種）；沒有職位清單就全部 */
export function electionOurTypes(election: Pick<SyncElection, "election_types">): string[] {
  const own = (OUR_ELECTION_TYPES as readonly string[]).filter((t) => election.election_types.includes(t));
  return own.length > 0 ? own : [...OUR_ELECTION_TYPES];
}

/** 這場選舉的同步單位（職位 × 縣市）：補選、重行選舉只含它的那個縣市 */
export function planElectionUnits(election: SyncElection, ourTypes?: readonly string[]): Array<{ ourType: string; plan: SyncUnitPlan }> {
  const area = electionAreaRegion(election);
  const out: Array<{ ourType: string; plan: SyncUnitPlan }> = [];
  for (const ourType of ourTypes ?? electionOurTypes(election)) {
    for (const plan of planUnits(ourType)) {
      if (area && plan.region !== area) continue;
      out.push({ ourType, plan });
    }
  }
  return out;
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
 * 這場選舉可用的場次：投票日（vote_date）等於 elections.election_date 的那幾筆（#344 第二階段 A；原本用年份對、再把重行選舉排後面）。
 *
 * 同年不只一場時（嘉義市 2022 縣市長原訂 11-26 因候選人過世延到 12-18 重行選舉，中選會另開一筆場次、11-26 那筆的全國檔裡沒有嘉義市）
 * 現在是兩場選舉各自一個投票日（2022-11-26_local 與 2022-12-18_rerun_10020），各自挑到自己的場次，不用再靠名稱排順序、依序試。
 *
 * 種類（legislator_type_id）要對上科目的 legisId：立委、議員、代表的區域與原住民選區同屆同日、同在一份清單（2026-10-05）。
 */
export function pickThemes(themes: readonly ThemeInfo[], electionDate: string, subject?: SubjectKey): ThemeInfo[] {
  return themes.filter((t) => t.voteDate === electionDate && themeMatchesSubject(t, subject));
}

/** pickThemes 的第一順位（舊介面，給只要一筆的呼叫端） */
export function pickTheme(themes: readonly ThemeInfo[], electionDate: string, subject?: SubjectKey): ThemeInfo | undefined {
  return pickThemes(themes, electionDate, subject)[0];
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
  /** 推薦政黨（中選會原字；見 cecPartyText） */
  party: string | null;
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
    // 候選人檔與得票檔都有政黨；merged 以候選人檔為準
    party: cecPartyText(merged.party_name),
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

/** 選舉的 id（寫進 cec_candidates.election_id）與投票日（對中選會場次的 vote_date） */
export type SyncElectionRef = Pick<SyncElection, "id" | "election_date">;

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
export async function collectPart(election: SyncElectionRef, ourType: string, cecType: string, region: string, deps: CecFetchDeps): Promise<PartResult> {
  const subject = SUBJECT_MAP[cecType];
  if (!subject) throw new Error(`不認得的中選會科目 ${cecType}`);
  const candidates = pickThemes(await deps.themes(cecType), election.election_date, subject);
  if (candidates.length === 0) throw new Error(`找不到投票日 ${election.election_date} 的 theme（cecType=${cecType}）`);
  let first: PartResult | undefined;
  for (const theme of candidates) {
    const got = await fetchThemeRows(election.id, ourType, cecType, region, theme, deps);
    if (got.rows.length > 0) return got;
    first ??= got;
  }
  return first!;
}

/** 一個同步單位（屆別×選舉別×縣市）：主科目＋同範圍的其他科目（原住民選區）全部抓成功才回傳 */
export async function collectUnitRows(
  election: SyncElectionRef,
  ourType: string,
  plan: SyncUnitPlan,
  deps: CecFetchDeps,
): Promise<{ fetched: number; rows: CecCandidateRow[]; parts: PartResult[] }> {
  const parts: PartResult[] = [];
  for (const cecType of [plan.cecType, ...(plan.extraCecTypes ?? [])]) {
    parts.push(await collectPart(election, ourType, cecType, plan.region, deps));
  }
  return {
    fetched: parts.reduce((n, p) => n + p.fetched, 0),
    rows: parts.flatMap((p) => p.rows),
    parts,
  };
}

// ── 選舉區與投票率（#344，2026-10-06）：同步完一個單位，順手把中選會名單上的選舉區記進 election_districts ──
//
// 代表、村里長、議員原住民選舉區的名稱只在中選會名單上（選舉區對照表只收議員一般選舉區），
// migration 讀 cec_candidates 會撞上同步中途（先刪後寫），所以由同步自己寫：只新增、不改既有的列
// （upsert ignoreDuplicates），名額照舊留空走任務（district_seats_missing）——只有法律定死的一席（首長、
// 區域立委）與憲法定的立委全國三區直接寫。投票率抓中選會的投票概況（profiles 檔的 vote_to_elect 那一組數字）。

/** 首長與立委：名額法律定死，寫進 seats（seats_basis=law）；其他選舉的名額看公告，同步不寫 */
const LAW_SEATS: Readonly<Record<string, { seats: number; source: string }>> = {
  總統副總統: { seats: 1, source: "中華民國憲法增修條文第 2 條：總統、副總統候選人聯名登記，以得票最多之一組為當選" },
  縣市長: { seats: 1, source: "地方制度法：直轄市、縣（市）置市長／縣長一人" },
  鄉鎮市長: { seats: 1, source: "地方制度法：鄉（鎮、市）置鄉（鎮、市）長一人" },
  直轄市山地原住民區長: { seats: 1, source: "地方制度法：直轄市山地原住民區置區長一人" },
  村里長: { seats: 1, source: "地方制度法：村（里）置村（里）長一人" },
  "立法委員|district": { seats: 1, source: "中華民國憲法增修條文第 4 條：區域立委依人口比例分配，按應選名額劃分同額選舉區（每區一席）" },
  "立法委員|不分區": { seats: 34, source: "中華民國憲法增修條文第 4 條：全國不分區及僑居國外國民共 34 人" },
  "立法委員|平地原住民": { seats: 3, source: "中華民國憲法增修條文第 4 條：自由地區平地原住民 3 人" },
  "立法委員|山地原住民": { seats: 3, source: "中華民國憲法增修條文第 4 條：自由地區山地原住民 3 人" },
};

/** 以整個行政區為一區的選舉（跟 election_districts 的 CHECK election_districts_kind_matches_type 同一份） */
export const AT_LARGE_ELECTION_TYPES: readonly string[] = ["總統副總統", "縣市長", "鄉鎮市長", "直轄市山地原住民區長", "村里長"];

/** 中選會科目 → 選舉區種類（沒列的：首長是 at_large，其他是一般選舉區） */
export const DISTRICT_KIND_BY_CEC_TYPE: Readonly<Record<string, string>> = {
  LegislatorParty: "proportional",
  LegislatorPlainIndigenous: "indigenous_plain",
  LegislatorMountainIndigenous: "indigenous_mountain",
  CouncilMemberPlainIndigenous: "indigenous_plain",
  CouncilMemberMountainIndigenous: "indigenous_mountain",
  CountyCouncilMemberPlainIndigenous: "indigenous_plain",
  CountyCouncilMemberMountainIndigenous: "indigenous_mountain",
  CityRepresentativesPlainIndigenous: "indigenous_plain",
};

export interface ElectionDistrictRow {
  election_id: number;
  election_type: string;
  district_kind: string;
  region: string;
  sub_region: string | null;
  village: string | null;
  seats: number | null;
  seats_basis: string | null;
  seats_source: string | null;
}

/** 一個同步單位抓到的名單 → 該有的選舉區（去重；縣市認不出來、村里長缺鄉鎮或村里的列不收） */
export function electionDistrictRows(electionId: number, ourType: string, parts: readonly Pick<PartResult, "cecType" | "rows">[]): ElectionDistrictRow[] {
  const out = new Map<string, ElectionDistrictRow>();
  const atLarge = AT_LARGE_ELECTION_TYPES.includes(ourType);
  for (const part of parts) {
    const kind = atLarge ? "at_large" : (DISTRICT_KIND_BY_CEC_TYPE[part.cecType] ?? "district");
    for (const r of part.rows) {
      if (!r.region || r.region === "未知") continue;
      if (ourType === "村里長" && (!r.sub_region || !r.village)) continue;
      // 首長：一個行政區一區——縣市長只看縣市、鄉鎮市長看到鄉鎮、村里長看到村里；總統只有全國一區
      const sub = ourType === "總統副總統" || ourType === "縣市長" ? null : r.sub_region;
      const village = ourType === "村里長" ? r.village : null;
      if (!atLarge && !sub) continue;
      const law = LAW_SEATS[ourType] ??
        (ourType === "立法委員" ? LAW_SEATS[`立法委員|${kind === "district" ? "district" : sub}`] : undefined);
      const row: ElectionDistrictRow = {
        election_id: electionId, election_type: ourType, district_kind: kind,
        region: r.region, sub_region: sub, village,
        seats: law?.seats ?? null, seats_basis: law ? "law" : null, seats_source: law?.source ?? null,
      };
      out.set(`${row.region}|${row.sub_region ?? ""}|${row.village ?? ""}`, row);
    }
  }
  return [...out.values()];
}

/** 投票率要看哪幾個科目：總統副總統的那一場；地方選舉是直轄市長＋縣市長兩場加總（每位選舉人只在其中一場） */
export const HEADLINE_TURNOUT_CEC_TYPES: Readonly<Record<string, readonly string[]>> = {
  總統副總統: ["President"],
  縣市長: ["Mayor", "CountyMayor"],
};

/** 中選會投票概況（全國層級）網址 */
export function profilesUrl(cecType: string, themeId: string): string {
  const subject = SUBJECT_MAP[cecType];
  return `${CEC_BASE}/data/profiles/ELC/${subject.subjectId}/${subject.legisId}/${themeId}/N/00_000_00_000_0000.json`;
}

/** 投票數 ÷ 選舉人數（多場加總），百分比、兩位小數；任何一場缺數字或選舉人數是 0 就回 null */
export function turnoutFromProfiles(rows: ReadonlyArray<{ vote_ticket?: unknown; votable_population?: unknown }>): number | null {
  if (rows.length === 0) return null;
  let votes = 0, votable = 0;
  for (const r of rows) {
    const v = Number(r.vote_ticket), p = Number(r.votable_population);
    if (r.vote_ticket === undefined || r.vote_ticket === null || !Number.isFinite(v) || !Number.isFinite(p) || p <= 0) return null;
    votes += v;
    votable += p;
  }
  return Math.round((votes / votable) * 10000) / 100;
}

/**
 * 某一場選舉的投票率：依 HEADLINE_TURNOUT_CEC_TYPES 的順序找第一種這場選舉有場次的，抓那幾場的全國投票概況加總。
 * 場次用投票日對（同年的重行選舉是另一個投票日、另一場選舉，不會混進來）。補選、重行選舉只在一個縣市舉行，沒有全國投票率，不寫。
 * 抓不到或缺一場就回 null（不寫）。
 */
export async function headlineTurnout(election: SyncElectionRef & Pick<SyncElection, "election_key">, deps: CecFetchDeps): Promise<{ value: number; election_type: string; themes: string[] } | null> {
  if (electionAreaRegion(election)) return null;
  const voteDate = election.election_date;
  for (const [ourType, cecTypes] of Object.entries(HEADLINE_TURNOUT_CEC_TYPES)) {
    const rows: Array<{ vote_ticket?: unknown; votable_population?: unknown }> = [];
    const themes: string[] = [];
    for (const cecType of cecTypes) {
      const theme = pickThemes(await deps.themes(cecType), voteDate, SUBJECT_MAP[cecType])[0];
      if (!theme) continue;
      const outcome = await deps.fetchJson(profilesUrl(cecType, theme.themeId));
      if (outcome.kind !== "ok" || outcome.rows.length === 0) return null;
      rows.push(outcome.rows[0] as { vote_ticket?: unknown; votable_population?: unknown });
      themes.push(`${cecType}:${theme.themeId}`);
    }
    if (rows.length === 0) continue;
    if (rows.length < cecTypes.length) return null;
    const value = turnoutFromProfiles(rows);
    return value === null ? null : { value, election_type: ourType, themes };
  }
  return null;
}
