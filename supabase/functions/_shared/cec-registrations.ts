/**
 * 中選會 115 年登記彙總表九份的資料表版（cec_registrations，2026-10-08，10-08 缺口盤點 R1）。
 *
 * 為什麼：roster_batch（system-one）每 10 分鐘讀名冊 PDF、在 Edge 上抽字逐位核對。村里長那份 7.5 MB 超過 Edge 的抽字上限
 * （ROSTER_MAX_BYTES＝3 MB，#440 加的保護），整份沒有系統票；全部名冊每輪都要重新下載、重新抽字。
 * 九份的內容是固定的（115/09/07 製表），所以由 scripts/gen-cec-registrations.ts 用同一個 parser（cec-roster.ts 的 parseRoster）
 * 與同一個抽字法（unpdf）解析一次，產生 migration 資料段；roster_batch 先查表，表裡有這份網址的資料就不下載 PDF，
 * 沒有的名冊照舊走 PDF 加大小保護。逐位核對的規則（checkBatch）一個字沒動。
 */
import type { RosterRow } from "./cec-roster.ts";
import { fetchAllRows } from "./fetch-all.ts";
import { chunksOf } from "./in-chunks.ts";

export const REGISTRATION_ELECTION_ID = 2026;

export interface RosterSource {
  /** 中選會頁面（web.cec.gov.tw/central/article/64709）掛的檔案網址；verification_sources 登錄的同一個 */
  url: string;
  election_type: string;
  label: string;
  /** PDF 裡「登記日期」的個數＝一列一位＝候選人數（cec-roster-nine.test.ts 的期望值） */
  expected: number;
  /** supabase/functions/_shared/fixtures/ 下，cecRosterText 對這個網址抽出來的原文 */
  fixture: string;
  /** 被哪個網址的新版取代（有值＝舊版：留在表裡讓引用舊網址的交件也查得到表，但算缺口、人數看新版） */
  superseded_by?: string;
}

/**
 * 九份現行版＋一份舊版（共十筆）。現行九份合計 19,695（ROSTER_TOTAL）。
 * 縣市議員（其餘 16 縣市）有兩版：我們登錄在 verification_sources 的 729644ff-…，與中選會頁面現在掛的 9ccb6224-…（檔案小 6 個字元）。
 * 2026-10-08 兩版都抽字逐列比對，只差一個字：彰化縣第 08 選舉區「洪健興」（729644ff）→「洪建興」（9ccb6224，中選會更正了姓名）。
 * 所以不是別名而是新舊兩版：兩版都進表（引用哪一版的交件 roster_batch 都查得到表），算缺口、人數看新版。
 */
export const ROSTER_SOURCES: readonly RosterSource[] = [
  { url: "https://web.cec.gov.tw/api/file/bb9a8d7a-9b8a-41ec-8e23-33efd009385a.pdf", election_type: "縣市長", label: "直轄市長", expected: 23, fixture: "cec-roster-2026-municipal-mayor.txt" },
  { url: "https://web.cec.gov.tw/api/file/370f3bbf-6408-4fdc-b8d8-9b9214913f74.pdf", election_type: "縣市長", label: "縣市長（其餘 16 縣市）", expected: 58, fixture: "cec-roster-2026-county-mayor.txt" },
  { url: "https://web.cec.gov.tw/api/file/ccd7e51a-5fd0-4ea0-a81b-a120cd550c9c.pdf", election_type: "縣市議員", label: "直轄市議員", expected: 610, fixture: "cec-roster-2026-municipal-council.txt" },
  { url: "https://web.cec.gov.tw/api/file/9ccb6224-20be-479e-931f-81aa6155f28a.pdf", election_type: "縣市議員", label: "縣市議員（其餘 16 縣市）", expected: 892, fixture: "cec-roster-2026-county-council-v2.txt" },
  { url: "https://web.cec.gov.tw/api/file/a7b4f3d3-dad3-4e61-9036-2cd21cf29d92.pdf", election_type: "鄉鎮市長", label: "鄉鎮市長", expected: 465, fixture: "cec-roster-2026-township-mayor.txt" },
  { url: "https://web.cec.gov.tw/api/file/437a9da7-eaa7-47b9-9571-789eeb48ed18.pdf", election_type: "鄉鎮市民代表", label: "鄉鎮市民代表", expected: 3437, fixture: "cec-roster-2026-township-rep.txt" },
  { url: "https://web.cec.gov.tw/api/file/1278f66e-1d15-4ecf-aeeb-9ea5cba61f00.pdf", election_type: "直轄市山地原住民區長", label: "直轄市山地原住民區長", expected: 16, fixture: "cec-roster-2026-indigenous-chief.txt" },
  { url: "https://web.cec.gov.tw/api/file/f3b665f2-6f0b-485f-a1eb-17d152849317.pdf", election_type: "直轄市山地原住民區民代表", label: "直轄市山地原住民區民代表", expected: 94, fixture: "cec-roster-2026-indigenous-rep.txt" },
  { url: "https://web.cec.gov.tw/api/file/f1abbda2-229b-4a02-8dfb-58beb3ceca61.pdf", election_type: "村里長", label: "村里長", expected: 14100, fixture: "cec-roster-2026-village.txt" },
  // 舊版（verification_sources 登錄的那個網址）
  { url: "https://web.cec.gov.tw/api/file/729644ff-cb01-42bb-a052-c9b3c55a1289.pdf", election_type: "縣市議員", label: "縣市議員（其餘 16 縣市，舊版）", expected: 892, fixture: "cec-roster-2026-county-council.txt", superseded_by: "https://web.cec.gov.tw/api/file/9ccb6224-20be-479e-931f-81aa6155f28a.pdf" },
] as const;

/** 現行九份的合計（舊版不算） */
export const ROSTER_TOTAL = ROSTER_SOURCES.filter((s) => !s.superseded_by).reduce((n, s) => n + s.expected, 0);

/** 資料表的一列（generator 產生、migration 灌入） */
export interface RegistrationRecord {
  election_id: number;
  election_type: string;
  region: string;
  place: string | null;
  sub_region: string | null;
  village: string | null;
  district: string | null;
  name: string;
  party: string;
  row_no: number;
  source_url: string;
  flags: string[];
}

/** 異常列的標記（照收、不丟，標出來讓人看得到） */
export const FLAG_NAME_EMPTY = "name_empty";
export const FLAG_PARTY_EMPTY = "party_empty";
export const FLAG_VILLAGE_EMPTY = "village_empty";
export const FLAG_PLACE_UNMATCHED = "place_unmatched";

/** 縣市 → 該縣市的鄉鎮市區（長的在前，取最長前綴）；來源是 admin_divisions（內政部官方行政區） */
export type TownIndex = ReadonlyMap<string, readonly string[]>;

/** 臺／台不分（parseRoster 的地名一律是「台」；官方名單有「臺西鄉」「臺東市」「霧臺鄉」） */
const normTai = (s: string) => s.replace(/臺/g, "台");

/** 地名在這一種選舉裡是「鄉鎮市區」還是「鄉鎮市區＋村里」 */
const TOWN_ONLY_TYPES = new Set(["鄉鎮市長", "鄉鎮市民代表", "直轄市山地原住民區長", "直轄市山地原住民區民代表"]);

/**
 * 逐列版面解出的地名（place，縣市以後）切成鄉鎮市區與村里。
 * 村里長的地名是「鄉鎮市區＋村里」連在一起（「板橋區鄉雲里」「平鎮區雙連里」——光看字尾切不準，鄉鎮名裡的「鄉」「區」也會出現在里名裡），
 * 所以拿官方鄉鎮名單取最長的前綴；其他有地名的選舉（鄉鎮市長、代表、區長）地名本身就是鄉鎮市區。
 * sub_region 存官方寫法（內政部：「臺西鄉」），place 與 village 是名冊抽字出來的原樣（「台西鄉」「台西村」）——
 * 臺／台的差別比對時一律抹平（roster_registration_gap、checkBatch 都是）。
 */
export function splitPlace(electionType: string, region: string, place: string | null, towns: TownIndex): { sub_region: string | null; village: string | null; unmatched: boolean } {
  if (!place) return { sub_region: null, village: null, unmatched: false };
  const list = towns.get(normTai(region)) ?? [];
  if (TOWN_ONLY_TYPES.has(electionType)) {
    const town = list.find((t) => normTai(t) === place);
    return { sub_region: town ?? place, village: null, unmatched: !town };
  }
  if (electionType === "村里長") {
    const town = list.find((t) => place.startsWith(normTai(t)));
    if (!town) return { sub_region: null, village: null, unmatched: true };
    return { sub_region: town, village: place.slice(normTai(town).length) || null, unmatched: false };
  }
  return { sub_region: null, village: null, unmatched: false };
}

/** parseRoster 的一份結果 → 資料表的列（row_no 從 1 起、照 PDF 的列序） */
export function toRegistrationRecords(source: RosterSource, rows: readonly RosterRow[], towns: TownIndex, electionId = REGISTRATION_ELECTION_ID): RegistrationRecord[] {
  return rows.map((r, i) => {
    if (!r.region) throw new Error(`${source.label} 第 ${i + 1} 列認不出縣市：${JSON.stringify(r)}`);
    const { sub_region, village, unmatched } = splitPlace(source.election_type, r.region, r.place ?? null, towns);
    const flags: string[] = [];
    if (!r.name) flags.push(FLAG_NAME_EMPTY);
    if (!r.party) flags.push(FLAG_PARTY_EMPTY);
    if (source.election_type === "村里長" && !unmatched && !village) flags.push(FLAG_VILLAGE_EMPTY);
    if (unmatched) flags.push(FLAG_PLACE_UNMATCHED);
    return {
      election_id: electionId, election_type: source.election_type, region: r.region,
      place: r.place ?? null, sub_region, village, district: r.district ?? null,
      name: r.name, party: r.party, row_no: i + 1, source_url: source.url, flags,
    };
  });
}

/** 資料表的列 → checkBatch 吃的 RosterRow（跟 parseRoster 的輸出同一個形狀） */
export function registrationToRosterRow(r: { name: string; party: string; region: string; district: string | null; place: string | null }): RosterRow {
  return { name: r.name, party: r.party, region: r.region, district: r.district, place: r.place };
}

// deno-lint-ignore no-explicit-any
type Client = any;

/**
 * roster_batch 先查這張表：這個網址在 cec_registration_sources 有登記、而且 cec_registrations 的列數等於登記的列數，
 * 就回傳列（照 PDF 列序）；沒登記、或列數對不上（灌到一半、被誤刪）回 null，呼叫端退回下載 PDF。
 * 對不上就退回 PDF 而不是用殘缺的表判案：殘缺的表會把對的人判成「名冊上找不到」。
 */
export async function loadRegistrationRows(supabase: Client, url: string): Promise<RosterRow[] | null> {
  const { data: src, error } = await supabase.from("cec_registration_sources").select("row_count").eq("source_url", url).maybeSingle();
  if (error || !src || typeof src.row_count !== "number") return null;
  const rows = await fetchAllRows<{ name: string; party: string; region: string; district: string | null; place: string | null }>(
    "cec_registrations by source",
    (from, to) => supabase.from("cec_registrations").select("name, party, region, district, place")
      .eq("source_url", url).order("row_no", { ascending: true }).range(from, to),
  );
  if (rows.length !== src.row_count) return null;
  return rows.map(registrationToRosterRow);
}

/** 交件關卡要核對的範圍：縣市，以及這批在該縣市出現的鄉鎮市區（null＝這批有一筆沒給鄉鎮，整個縣市都要） */
export interface RosterScope { region: string; towns: readonly string[] | null }

/**
 * 只撈這一批需要的範圍（2026-10-08，#455 審查）：交件時不能為了核對 150 筆把村里長 14,100 列整份拉回來（15 次往返、數 MB）。
 * 做法：先確認這份名冊登記過、而且表裡的列數等於登記的列數（一次 count，不拉資料；對不上＝殘缺，回 null），
 * 再依縣市（以及這批出現的鄉鎮市區，臺／台兩種寫法都查）撈那一塊，照 PDF 列序回傳。
 */
export async function loadRegistrationRowsScoped(supabase: Client, url: string, scopes: readonly RosterScope[]): Promise<RosterRow[] | null> {
  const { data: src, error } = await supabase.from("cec_registration_sources").select("row_count").eq("source_url", url).maybeSingle();
  if (error || !src || typeof src.row_count !== "number") return null;
  const { count, error: countErr } = await supabase.from("cec_registrations").select("row_no", { count: "exact", head: true }).eq("source_url", url);
  if (countErr || count !== src.row_count) return null;
  type Row = { row_no: number; name: string; party: string; region: string; district: string | null; place: string | null };
  const byRow = new Map<number, Row>();
  for (const scope of scopes) {
    const region = scope.region.replace(/臺/g, "台");
    const towns = scope.towns ? [...new Set(scope.towns.flatMap((t) => [t, t.replace(/臺/g, "台"), t.replace(/台/g, "臺")]))] : null;
    const queries = towns ? chunksOf(towns) : [null];
    for (const townChunk of queries) {
      const rows = await fetchAllRows<Row>(
        "cec_registrations scoped",
        (from, to) => townChunk
          ? supabase.from("cec_registrations").select("row_no, name, party, region, district, place").eq("source_url", url).eq("region", region)
            .in("sub_region", townChunk).order("row_no", { ascending: true }).range(from, to)
          : supabase.from("cec_registrations").select("row_no, name, party, region, district, place").eq("source_url", url).eq("region", region)
            .order("row_no", { ascending: true }).range(from, to),
      );
      for (const r of rows) byRow.set(r.row_no, r);
    }
  }
  return [...byRow.values()].sort((a, b) => a.row_no - b.row_no).map(registrationToRosterRow);
}
