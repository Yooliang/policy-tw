/**
 * 代表的號次單位改用選舉區（#464，migration 20261009050000_rep_district_ballot_unit.sql）。
 *
 * 真的 SQL 灌進 PGlite：兩個資料庫灌同一份資料——「舊」＝#452 的現行定義（20261008150000、20261006220000），「新」＝舊的再套這支 migration。
 *   ① 號次單位函式：代表改用選舉區（參選紀錄與交件兩邊算出同一個字串）；其餘選舉別在一整排輸入上新舊逐字相同
 *   ② 視圖與重複／跳號：代表按選舉區算，同鄉鎮不同選舉區的同號不算重複；只記到鄉鎮的照舊不檢查
 *   ③ 補號次臂：派工單位照舊是鄉鎮（不被選舉區拆成好幾件）；沒記選舉區的資料新舊輸出逐件相同
 *   ④ 補選區臂（region_gap）：新舊的差只有「代表只記到鄉鎮、名冊上找得到他、那一列有選舉區」的任務；議員、立委、縣市長的輸出逐件不變
 *   ⑤ 重複檢查（cand_no_dup_conflicts）：代表按選舉區比，payload 與參選紀錄兩邊對得上
 *   ⑥ 還原驗證：改壞 migration 一處，對應的守門必須紅
 * 只要 --allow-read。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { BALLOT_MIG, fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";
import { BASE_SCHEMA_SQL, SCHEMA_MIG } from "./cec-registrations-pglite.ts";

const NEW_MIG = "20261009050000_rep_district_ballot_unit.sql";
const GAP_MIG = "20261006220000_candidacy_read_side.sql";
const DUP_MIG = "20261008151000_cand_no_dup_check.sql";
const B = await readMig(BALLOT_MIG);
const N = await readMig(NEW_MIG);
const R = await readMig(GAP_MIG);
const DUP = await readMig(DUP_MIG);
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Db = PGlite;
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> => (await db.query<T>(sql, params)).rows;
const viewSql = (sql: string, name: string) => {
  const a = sql.indexOf(`CREATE OR REPLACE VIEW ${name} AS`);
  assert(a >= 0, `找不到視圖 ${name}`);
  return sql.slice(a, sql.indexOf(";\nCOMMENT ON VIEW", a) + 1);
};
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

// ---------- 資料 ----------
const REGIONS: Array<[number, string, string | null, string | null]> = [
  [1, "連江縣", "南竿鄉", null], [2, "連江縣", "北竿鄉", null], [3, "連江縣", "北竿鄉第02選舉區", null],
  [4, "彰化縣", "二林鎮", null], [5, "彰化縣", "二林鎮第01選舉區", null], [6, "彰化縣", "二林鎮第02選舉區", null],
  [7, "金門縣", "金城鎮", null], [8, "台北市", "第01選舉區", null], [9, "台中市", "和平區第01選舉區", null], [10, "台中市", "和平區", null],
  [11, "台北市", null, null], [12, "雲林縣", "臺西鄉", null], [13, "雲林縣", "臺西鄉第03選舉區", null],
];
// [pe id, 人物 id, 姓名, 人物縣市, 選舉別, region_id, 狀態, 號次]
type Pe = [number, number, string, string | null, string, number | null, string, number | null];
const PES: Pe[] = [
  // 號次單位：二林鎮 第01 有兩位同號（重複）、第02 有兩位 1、2（沒問題）；二林鎮只記到鄉鎮的丁不算進任何單位
  [1, 1, "甲", "彰化縣", "鄉鎮市民代表", 5, "filed", 1], [2, 2, "乙", "彰化縣", "鄉鎮市民代表", 5, "filed", 1],
  [3, 3, "丙", "彰化縣", "鄉鎮市民代表", 6, "filed", 1], [4, 4, "丁", "彰化縣", "鄉鎮市民代表", 4, "filed", 1],
  [5, 5, "戊", "彰化縣", "鄉鎮市民代表", 6, "filed", 2],
  // 區民代表：和平區第01 只有一位、號次 2（到齊卻不是 1..N）→ 跳號
  [6, 6, "己", "台中市", "直轄市山地原住民區民代表", 9, "filed", 2],
  // 議員：台北市第01 一位
  [7, 7, "庚", "台北市", "縣市議員", 8, "filed", 1],
  // 補選區：北竿鄉（連江縣）
  [10, 10, "林某", "連江縣", "鄉鎮市民代表", 2, "filed", null],            // 名冊有（第02選舉區）→ 派
  [11, 11, "張某", "連江縣", "鄉鎮市民代表", 2, "considering", null],      // 表態未登記 → 不派
  [12, 12, "陳某", "連江縣", "鄉鎮市民代表", 2, "withdrawn", null],        // 退選 → 不派
  [13, 13, "趙某", "連江縣", "鄉鎮市民代表", null, "filed", null],          // 沒有 region_id＝補鄉鎮（township_gap）的事 → 不派
  [14, 14, "王某", "連江縣", "鄉鎮市民代表", 3, "filed", null],            // 已經記了選舉區 → 不派
  [15, 15, "孫某", "金門縣", "鄉鎮市民代表", 7, "filed", null],            // 名冊那一列沒有選舉區（單一選區）→ 不派
  [16, 16, "周某", "連江縣", "鄉鎮市民代表", 1, "filed", null],            // 名冊找不到他 → 不派
  [17, 17, "吳某", "雲林縣", "鄉鎮市民代表", 12, "filed", null],           // 臺西鄉（regions 寫臺、名冊寫臺）→ 派
  [18, 18, "鄭某", "連江縣", "鄉鎮市民代表", 2, "filed", null],            // 只在被取代的舊版名冊上 → 不派
  [19, 19, "馮某", "彰化縣", "鄉鎮市民代表", 4, "filed", null],            // 二林鎮名冊同名兩位（第01、第02）→ 派，cec_matches＝2
  // 補號次：二林鎮有一位記了選舉區、一位只記到鄉鎮，都沒號次
  [30, 30, "巳某", "彰化縣", "鄉鎮市民代表", 5, "filed", null], [31, 31, "午某", "彰化縣", "鄉鎮市民代表", 4, "filed", null],
  // 議員／縣市長沒有地區：補選區臂照舊派
  [20, 20, "未某", "台北市", "縣市議員", 11, "filed", null], [21, 21, "申某", "台北市", "縣市長", null, "filed", null],
];
const SRC_NEW = "https://web.cec.gov.tw/api/file/11111111-1111-4111-8111-111111111111.pdf";
const SRC_OLD = "https://web.cec.gov.tw/api/file/22222222-2222-4222-8222-222222222222.pdf";
// [來源, 縣市, 鄉鎮, 選舉區, 姓名, 政黨]
const REGS: Array<[string, string, string, string | null, string, string]> = [
  [SRC_NEW, "連江縣", "北竿鄉", "第02選舉區", "林某", "無"], [SRC_NEW, "連江縣", "北竿鄉", "第02選舉區", "張某", "無"], [SRC_NEW, "連江縣", "北竿鄉", "第02選舉區", "陳某", "無"],
  [SRC_NEW, "金門縣", "金城鎮", null, "孫某", "無"], [SRC_NEW, "雲林縣", "臺西鄉", "第03選舉區", "吳某", "中國國民黨"],
  [SRC_OLD, "連江縣", "北竿鄉", "第02選舉區", "鄭某", "無"],
  [SRC_NEW, "彰化縣", "二林鎮", "第01選舉區", "馮某", "無"], [SRC_NEW, "彰化縣", "二林鎮", "第02選舉區", "馮某", "民主進步黨"],
  [SRC_NEW, "連江縣", "北竿鄉", "第02選舉區", "趙某", "無"], [SRC_NEW, "連江縣", "北竿鄉", "第02選舉區", "王某", "無"],
  [SRC_NEW, "連江縣", "南竿鄉", "第01選舉區", "林某", "無"], // 別的鄉鎮的同名者：北竿鄉的林某不能被算成兩位
];

async function build(kind: "old" | "new", mutateNew?: (s: string) => string): Promise<Db> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA_SQL);
  await db.exec(await latestFn("cec_name_norm"));
  await db.exec(await latestFn("cec_name_key"));
  await db.exec(await readMig(SCHEMA_MIG)); // cec_registrations、cec_registration_sources、candidacy_is_listed…（真的）
  await db.exec(`
    ALTER TABLE politician_elections ADD COLUMN cand_no integer, ADD COLUMN position text;
    ALTER TABLE politicians ADD COLUMN party text;
    CREATE TABLE elections (id integer PRIMARY KEY, election_date date);
    CREATE TABLE contributions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, contribution_type text, status text, payload jsonb, created_at timestamptz DEFAULT now());
    CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text, record_id text, field text, contribution_id uuid, applied_at timestamptz DEFAULT now());
    CREATE TABLE cec_candidates (id bigserial PRIMARY KEY, election_id integer, election_type text, name_norm text, region text, sub_region text, party text);
    CREATE TABLE election_milestones_all (election_id integer, kind text, election_type text, on_date date, status text);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql STABLE AS $$ SELECT date '2026-10-23' $$;
    CREATE FUNCTION candidacy_list_published(p_election_id integer, p_election_type text, p_on date) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    ${await latestFn("candidacy_protocol_status")}
    ${await latestFn("region_is_electoral_district")}`);
  // 舊的現行定義（#452 補號次＋05 的補選區臂）
  await db.exec(`${fnText(B, "ballot_number_unit")}\n${fnText(B, "ballot_number_dups")}\n${fnText(B, "ballot_number_missing")}\n${viewSql(B, "ballot_number_units")}\n${viewSql(B, "ballot_number_anomalies")}\n${fnText(B, "contribution_auto_tasks_ballot_numbers")}\n${fnText(R, "contribution_auto_tasks_region_gap")}`);
  if (kind === "new") await db.exec((mutateNew ?? ((s) => s))(N));
  await db.exec(`INSERT INTO elections VALUES (2026, '2026-11-28'), (2022, '2022-11-26')`);
  await db.exec(`INSERT INTO election_milestones_all VALUES (2026, 'draw', NULL, '2026-10-23', 'announced')`);
  for (const r of REGIONS) await db.query(`INSERT INTO regions VALUES ($1, $2, $3, $4)`, r);
  for (const [id, , name, region] of PES) await db.query(`INSERT INTO politicians VALUES ($1, $2, $3, NULL, NULL)`, [U(id), name, region]);
  for (const [id, pid, , , type, rid, status, no] of PES) {
    await db.query(`INSERT INTO politician_elections (id, election_id, election_type, politician_id, region_id, candidacy_status, cand_no) VALUES ($1, 2026, $2, $3, $4, $5, $6)`, [id, type, U(pid), rid, status, no]);
  }
  await db.query(`INSERT INTO cec_registration_sources VALUES ($1, 2026, '鄉鎮市民代表', '新版', 9, NULL, now()), ($2, 2026, '鄉鎮市民代表', '舊版', 1, $1, now())`, [SRC_NEW, SRC_OLD]);
  for (const [i, [src, region, town, district, name, party]] of REGS.entries()) {
    await db.query(`INSERT INTO cec_registrations (election_id, election_type, region, place, sub_region, district, name, party, row_no, source_url, parsed_at)
      VALUES (2026, '鄉鎮市民代表', $1, $2, $2, $3, $4, $5, $6, $7, now())`, [region, town, district, name, party, i + 1, src]);
  }
  return db;
}
const buildReady = build;

const j = (x: unknown) => JSON.stringify(x);
const gapRows = (db: Db) => rows<{ task_id: string; target: Record<string, any>; what_we_need: string; hint_sources: string[]; reward: number; region: string }>(db, `SELECT * FROM contribution_auto_tasks_region_gap() ORDER BY task_id COLLATE "C"`);
const armRows = (db: Db) => rows<{ task_id: string; target: Record<string, any>; what_we_need: string }>(db, `SELECT task_id, target, what_we_need FROM contribution_auto_tasks_ballot_numbers() ORDER BY task_id COLLATE "C"`);

// ---------- ① 號次單位函式 ----------
const UNIT_CASES: Array<[string, string | null, string | null, string | null, string | null, string | null]> = [
  // [選舉別, 縣市, district, town, village, 新版預期（代表以外的 = 舊版）]
  ["鄉鎮市民代表", "彰化縣", "二林鎮第01選舉區", "二林鎮第01選舉區", null, "彰化縣|二林鎮第01選舉區"], // 參選紀錄那一邊
  ["鄉鎮市民代表", "彰化縣", "第1選舉區", "二林鎮", null, "彰化縣|二林鎮第01選舉區"],                      // 交件那一邊（第1＝第01）
  ["鄉鎮市民代表", "彰化縣", "第 01 選舉區", "二林鎮", null, "彰化縣|二林鎮第01選舉區"],
  ["鄉鎮市民代表", "彰化縣", "二林鎮第2選舉區", "二林鎮", null, "彰化縣|二林鎮第02選舉區"],               // 整個寫在選舉區
  ["鄉鎮市民代表", "臺中市", "第01選舉區", "臺西鄉", null, "台中市|台西鄉第01選舉區"],                    // 臺→台
  ["直轄市山地原住民區民代表", "台中市", "和平區第03選舉區", "和平區第03選舉區", null, "台中市|和平區第03選舉區"],
  ["鄉鎮市民代表", "彰化縣", "二林鎮", "二林鎮", null, null],                                              // 只記到鄉鎮 → 不檢查
  ["鄉鎮市民代表", "彰化縣", null, "二林鎮", null, null],
  ["鄉鎮市民代表", "彰化縣", "第01選舉區", null, null, null],                                              // 沒有鄉鎮 → 不檢查
  ["鄉鎮市民代表", "彰化縣", "第00選舉區", "二林鎮", null, null],
  ["鄉鎮市民代表", "彰化縣", "蘭嶼鄉選舉區", "蘭嶼鄉", null, null],                                      // 單一選區的寫法沒有號碼 → 不猜
  ["鄉鎮市民代表", "彰化縣", "第一選舉區", "二林鎮", null, null],                                          // 中文數字 → 不猜（落庫端會先正規化）
  ["鄉鎮市民代表", null, "第01選舉區", "二林鎮", null, null],
  // 其餘選舉別：新舊逐字相同
  ["縣市長", "台北市", null, null, null, "台北市"], ["縣市長", "臺北市", null, null, null, "台北市"], ["縣市長", null, null, null, null, null],
  ["縣市議員", "台北市", "第01選舉區", "第01選舉區", null, "台北市|第01選舉區"], ["縣市議員", "台北市", "中山區", "中山區", null, null], ["縣市議員", "台北市", null, null, null, null],
  ["鄉鎮市長", "雲林縣", null, "臺西鄉", null, "雲林縣|台西鄉"], ["鄉鎮市長", "雲林縣", null, null, null, null],
  ["直轄市山地原住民區長", "台中市", null, "和平區", null, "台中市|和平區"],
  ["村里長", "台北市", null, "中山區", "新生里", "台北市|中山區|新生里"], ["村里長", "台北市", null, "中山區", null, null], ["村里長", "台北市", null, null, "新生里", null],
  ["立法委員", "台北市", "第01選區", "台北市", null, null], ["總統副總統", "全國", null, null, null, null], [null as unknown as string, "台北市", null, null, null, null],
];
async function unitGuards(db: Db): Promise<Record<string, boolean>> {
  const v: Record<string, boolean> = {};
  const got = async (c: typeof UNIT_CASES[number]) => (await rows<{ u: string | null }>(db, `SELECT ballot_number_unit($1, $2, $3, $4, $5) AS u`, [c[0], c[1], c[2], c[3], c[4]]))[0].u;
  const reps = UNIT_CASES.filter((c) => c[0] === "鄉鎮市民代表" || c[0] === "直轄市山地原住民區民代表");
  v.u_reps_by_district = (await Promise.all(reps.map(got))).every((u, i) => u === reps[i][5]);
  const others = UNIT_CASES.filter((c) => !reps.includes(c));
  v.u_others_unchanged = (await Promise.all(others.map(got))).every((u, i) => u === others[i][5]);
  // 參選紀錄（regions.sub_region）與交件（electoral_district＋sub_region）算出同一個單位
  const rec = (await rows<{ u: string }>(db, `SELECT ballot_number_unit('鄉鎮市民代表', '彰化縣', '二林鎮第01選舉區', '二林鎮第01選舉區', NULL) AS u`))[0].u;
  const pay = (await rows<{ u: string }>(db, `SELECT ballot_number_unit('鄉鎮市民代表', '彰化縣', '第1選舉區', '二林鎮', NULL) AS u`))[0].u;
  v.u_record_equals_payload = rec === pay && rec === "彰化縣|二林鎮第01選舉區";
  // 同鄉鎮不同選舉區、同選舉區不同鄉鎮是不同單位
  const a = (await rows<{ u: string }>(db, `SELECT ballot_number_unit('鄉鎮市民代表', '彰化縣', '第01選舉區', '二林鎮', NULL) AS u`))[0].u;
  const b2 = (await rows<{ u: string }>(db, `SELECT ballot_number_unit('鄉鎮市民代表', '彰化縣', '第02選舉區', '二林鎮', NULL) AS u`))[0].u;
  const c2 = (await rows<{ u: string }>(db, `SELECT ballot_number_unit('鄉鎮市民代表', '彰化縣', '第01選舉區', '大城鄉', NULL) AS u`))[0].u;
  v.u_distinct_units = new Set([a, b2, c2]).size === 3;
  return v;
}
const ALL_U = ["u_reps_by_district", "u_others_unchanged", "u_record_equals_payload", "u_distinct_units"];

Deno.test("U1 號次單位：代表＝縣市|鄉鎮第NN選舉區（參選紀錄與交件兩邊同一個字串、第4＝第04、臺→台）；沒有選舉區／鄉鎮／號碼的不檢查；其他選舉別新舊逐字相同", async () => {
  const dbN = await buildReady("new");
  const v = await unitGuards(dbN);
  assertEquals(ALL_U.filter((g) => v[g] !== true), []);
  // 舊版：代表一律 NULL（這就是 #452 的「不檢查」）
  const dbO = await buildReady("old");
  const old = await rows<{ u: string | null }>(dbO, `SELECT ballot_number_unit('鄉鎮市民代表', '彰化縣', '二林鎮第01選舉區', '二林鎮第01選舉區', NULL) AS u`);
  assertEquals(old[0].u, null);
  await dbN.close();
  await dbO.close();
});

// ---------- ② 視圖與重複／跳號 ----------
async function viewGuards(db: Db): Promise<Record<string, boolean>> {
  const v: Record<string, boolean> = {};
  const units = await rows<{ election_type: string; unit: string; town: string | null; district: string | null; registered: number; numbered: number; kind: string | null }>(db,
    `SELECT election_type, unit, town, district, registered, numbered, kind FROM ballot_number_units WHERE election_type <> '縣市議員' ORDER BY unit`);
  const by = (u: string) => units.find((x) => x.unit === u);
  v.v_dup_in_same_district = by("彰化縣|二林鎮第01選舉區")?.kind === "duplicate" && by("彰化縣|二林鎮第01選舉區")?.registered === 3; // 甲、乙同號，巳某還沒有號次
  v.v_same_no_other_district_ok = by("彰化縣|二林鎮第02選舉區")?.kind === null && by("彰化縣|二林鎮第02選舉區")?.registered === 2;
  v.v_gap_when_complete = by("台中市|和平區第01選舉區")?.kind === "gap";
  v.v_township_only_not_counted = !units.some((x) => x.unit === "彰化縣|二林鎮") && units.filter((x) => x.unit?.startsWith("彰化縣|二林鎮")).reduce((s, x) => s + x.registered, 0) === 5; // 3＋2；只記到鄉鎮的丁、馮某、午某不在裡面
  v.v_town_and_district_split = by("彰化縣|二林鎮第01選舉區")?.town === "二林鎮" && by("彰化縣|二林鎮第01選舉區")?.district === "第01選舉區";
  // 其他選舉別的 town／district 欄位照舊（議員 district＝選舉區、town 空）
  const council = (await rows<{ town: string | null; district: string | null }>(db, `SELECT town, district FROM ballot_number_units WHERE election_type = '縣市議員'`))[0];
  v.v_council_columns_unchanged = council.town === null && council.district === "第01選舉區";
  const anomalies = await rows<{ unit: string; kind: string }>(db, `SELECT unit, kind FROM ballot_number_anomalies WHERE election_type <> '縣市議員' ORDER BY unit`);
  v.v_anomalies = j(anomalies) === j([{ unit: "台中市|和平區第01選舉區", kind: "gap" }, { unit: "彰化縣|二林鎮第01選舉區", kind: "duplicate" }].sort((x, y) => (x.unit < y.unit ? -1 : 1)));
  return v;
}
const ALL_V = ["v_dup_in_same_district", "v_same_no_other_district_ok", "v_gap_when_complete", "v_township_only_not_counted", "v_town_and_district_split", "v_council_columns_unchanged", "v_anomalies"];

Deno.test("V1 視圖：代表按選舉區算——同選舉區同號＝重複、不同選舉區同號不算、到齊卻不連續＝跳號；只記到鄉鎮的不進任何單位；議員欄位不變", async () => {
  const db = await buildReady("new");
  const v = await viewGuards(db);
  assertEquals(ALL_V.filter((g) => v[g] !== true), []);
  // 舊版：代表一個單位都沒有（全部不檢查）
  const dbO = await buildReady("old");
  const old = await rows<{ n: number }>(dbO, `SELECT count(*)::int AS n FROM ballot_number_units WHERE election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')`);
  assertEquals(old[0].n, 0);
  await db.close();
  await dbO.close();
});

// ---------- ③ 補號次臂 ----------
async function armGuards(db: Db): Promise<Record<string, boolean>> {
  const v: Record<string, boolean> = {};
  const r = await armRows(db);
  const rep = r.filter((x) => x.target.kind === "cand_no" && x.target.election_type === "鄉鎮市民代表" && x.target.region === "彰化縣");
  v.a_dispatch_unit_is_township = rep.length === 1 && rep[0].task_id === "auto:candidacy_source_missing:cand_no:2026:鄉鎮市民代表:彰化縣:二林鎮" && rep[0].target.sub_region === "二林鎮";
  const items = (rep[0]?.target.items ?? []) as Array<Record<string, string>>;
  v.a_items_carry_district = items.length === 3 && items.find((i) => i.name === "巳某")?.electoral_district === "第01選舉區" && items.find((i) => i.name === "午某")?.electoral_district === undefined &&
    items.every((i) => i.sub_region === "二林鎮");
  v.a_text_tells_district = (rep[0]?.what_we_need ?? "").includes("items 裡有 electoral_district 的照填");
  // 重查：二林鎮第01 重複、和平區第01 跳號，各自成單位、標籤是選舉區
  const re = await rows<{ task_id: string; target: Record<string, any> }>(db, `SELECT task_id, target FROM contribution_auto_tasks_ballot_numbers() WHERE target->>'kind' = 'cand_no_recheck' ORDER BY task_id COLLATE "C"`);
  const ru: Array<Record<string, any>> = re.flatMap((x) => (x.target.units as Array<Record<string, any>>).map((u) => ({ id: x.task_id, ...u })));
  const u1 = ru.find((u) => u.unit === "二林鎮第01選舉區");
  v.a_recheck_by_district = !!u1 && u1.anomaly === "duplicate" && u1.sub_region === "二林鎮" && u1.electoral_district === "第01選舉區" && u1.duplicates.join() === "1" &&
    re.some((x) => x.task_id === "auto:candidacy_source_missing:cand_no_recheck:2026:鄉鎮市民代表:彰化縣:二林鎮") &&
    re.some((x) => x.task_id === "auto:candidacy_source_missing:cand_no_recheck:2026:直轄市山地原住民區民代表:台中市:和平區");
  return v;
}
const ALL_A = ["a_dispatch_unit_is_township", "a_items_carry_district", "a_text_tells_district", "a_recheck_by_district"];

Deno.test("A1 補號次臂：派工單位照舊是鄉鎮（記了選舉區的代表不會把 task_id、sub_region 變成「二林鎮第01選舉區」），items 帶 electoral_district，重查按選舉區成單位", async () => {
  const db = await buildReady("new");
  const v = await armGuards(db);
  assertEquals(ALL_A.filter((g) => v[g] !== true), []);
  await db.close();
});

Deno.test("A2 舊版的毛病還在證明：不改臂的話，記了選舉區的代表被拆成「二林鎮第01選舉區」另一件（這就是要改臂的理由）", async () => {
  const db = await buildReady("old");
  // 舊臂 ＋ 新視圖以外都是舊的：舊臂的 g_all 直接拿 regions.sub_region 當鄉鎮
  const r = await armRows(db);
  assert(r.some((x) => x.target.sub_region === "二林鎮第01選舉區"), "舊臂把選舉區當鄉鎮");
  await db.close();
});

Deno.test("A3 沒有記選舉區的資料，補號次臂新舊輸出逐件相同（機械替換不動別的）", async () => {
  // 拿掉有選舉區的紀錄（改指鄉鎮那一列），新舊兩邊臂的輸出必須逐字相同
  const flatten = async (kind: "old" | "new") => {
    const db = await buildReady(kind);
    await db.exec(`UPDATE politician_elections SET region_id = 4 WHERE region_id IN (5, 6); UPDATE politician_elections SET region_id = 10 WHERE region_id = 9; UPDATE politician_elections SET region_id = 2 WHERE region_id = 3; UPDATE politician_elections SET region_id = 12 WHERE region_id = 13`);
    const out = j(await rows(db, `SELECT * FROM contribution_auto_tasks_ballot_numbers() ORDER BY task_id COLLATE "C"`));
    await db.close();
    return out;
  };
  const a = await flatten("old");
  const b = await flatten("new");
  assert(a.length > 100, "有東西可比");
  assertEquals(b, a);
});

// ---------- ④ 補選區臂 ----------
async function gapGuards(dbOld: Db, dbNew: Db): Promise<Record<string, boolean>> {
  const v: Record<string, boolean> = {};
  const o = await gapRows(dbOld);
  const n = await gapRows(dbNew);
  const oldIds = new Set(o.map((x) => x.task_id));
  const extra = n.filter((x) => !oldIds.has(x.task_id));
  v.g_old_rows_unchanged = j(n.filter((x) => oldIds.has(x.task_id))) === j(o) && o.length === 2; // 議員沒有選區（20 號）、縣市長沒有縣市（21 號）
  v.g_extra_set = j(extra.map((x) => x.task_id)) === j(["auto:candidacy_source_missing:10", "auto:candidacy_source_missing:17", "auto:candidacy_source_missing:19"]);
  const t = (id: number) => extra.find((x) => x.task_id === `auto:candidacy_source_missing:${id}`)!;
  v.g_hint_carries_district = j(t(10)?.target.cec_districts) === j(["第02選舉區"]) && t(10)?.target.sub_region === "北竿鄉" && t(10)?.target.region === "連江縣" &&
    t(10)?.target.missing.join() === "electoral_district" && t(10)?.target.cec_source_url === SRC_NEW && t(10)?.target.cec_party === "無" && t(10)?.target.cec_matches === 1;
  v.g_text_names_district = t(10)?.what_we_need.includes("第02選舉區") && t(10)?.what_we_need.includes(SRC_NEW) && t(10)?.what_we_need.includes("electoral_district 填「第NN選舉區」") && t(10)?.reward === 1 && t(10)?.region === "連江縣";
  v.g_tai_variant_matches = j(t(17)?.target.cec_districts) === j(["第03選舉區"]);
  v.g_namesakes_listed = j(t(19)?.target.cec_districts) === j(["第01選舉區", "第02選舉區"]) && t(19)?.target.cec_matches === 2 && t(19)?.target.cec_party === null && t(19)?.what_we_need.includes("同名");
  // 不派的：表態未登記 11、退選 12、沒有 region_id 13、已有選舉區 14、名冊沒選舉區 15、名冊找不到 16、只在被取代的舊版 18
  v.g_not_dispatched = [11, 12, 13, 14, 15, 16, 18].every((id) => !extra.some((x) => x.task_id === `auto:candidacy_source_missing:${id}`));
  // 任務編號跟 township_gap／其他補選區的 pe id 編號法不衝突（同一個 pe 只會出現在一支）
  v.g_task_ids_unique = new Set(n.map((x) => x.task_id)).size === n.length;
  v.g_candidate_status = t(10)?.target.candidate_status === "registered";
  return v;
}
const ALL_G = ["g_old_rows_unchanged", "g_extra_set", "g_hint_carries_district", "g_text_names_district", "g_tai_variant_matches", "g_namesakes_listed", "g_not_dispatched", "g_task_ids_unique", "g_candidate_status"];

Deno.test("G1 補選區臂：新舊差只有「代表只記到鄉鎮、名冊上找得到他且那一列有選舉區」的任務；任務附名冊的選舉區與網址；表態未登記、退選、沒 region_id、已有選舉區、單一選區、名冊找不到、被取代的舊版都不派", async () => {
  const dbO = await buildReady("old");
  const dbN = await buildReady("new");
  const v = await gapGuards(dbO, dbN);
  assertEquals(ALL_G.filter((g) => v[g] !== true), []);
  await dbO.close();
  await dbN.close();
});

// ---------- ⑤ 重複檢查 ----------
Deno.test("D1 重複檢查：代表的號次按選舉區比（payload 與參選紀錄兩邊同一個單位）；別的選舉區同號不算；沒帶選舉區的交件不檢查", async () => {
  const dbN = await buildReady("new");
  await dbN.exec(`SELECT 1`);
  await dbN.exec(`CREATE TABLE jev_decisions (id bigserial PRIMARY KEY, subject_type text, subject_id text, question text, choice text, probability numeric, confidence numeric, probabilities jsonb, model text, state jsonb, cost_usd numeric);
    CREATE FUNCTION contribution_apply_consensus(p_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'pending'::text $$;
    CREATE SCHEMA cron; CREATE TABLE cron.job (jobname text);
    CREATE FUNCTION cron.unschedule(p text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION cron.schedule(p text, s text, c text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
  await dbN.exec(DUP);
  const C = (n: number) => `00000000-0000-4000-8000-1${String(n).padStart(11, "0")}`;
  const pay = (o: Record<string, unknown>) => ({ election_id: 2026, election_type: "鄉鎮市民代表", region: "彰化縣", sub_region: "二林鎮", ...o });
  const list: Array<[number, Record<string, unknown>]> = [
    [1, pay({ electoral_district: "第1選舉區", cand_no: 1, politician_id: U(50), name: "新甲" })],  // 二林鎮第01 已上線的甲是 1 號 → 衝突
    [2, pay({ electoral_district: "第02選舉區", cand_no: 3, politician_id: U(51), name: "新乙" })], // 二林鎮第02 沒有 3 號 → 沒衝突
    [3, pay({ electoral_district: "第02選舉區", cand_no: 1, politician_id: U(52), name: "新丙" })], // 二林鎮第02 已上線的丙是 1 號 → 衝突
    [4, pay({ cand_no: 1, politician_id: U(53), name: "新丁" })],                                    // 沒帶選舉區 → 不檢查
    [5, pay({ electoral_district: "第03選舉區", cand_no: 1, politician_id: U(54), name: "新戊" })], // 二林鎮第03 沒人 → 沒衝突
    [6, pay({ electoral_district: "第03選舉區", cand_no: 1, politician_id: U(55), name: "新己" })], // 跟 5 同單位同號（等票中）→ 兩邊都衝突
  ];
  for (const [n, payload] of list) await dbN.query(`INSERT INTO contributions (id, contribution_type, status, payload) VALUES ($1, 'candidacy', 'pending', $2::jsonb)`, [C(n), JSON.stringify(payload)]);
  const conflicts = async (n: number) => (await rows<{ r: { unit: string; conflicts: Array<{ name: string }> } | null }>(dbN, `SELECT cand_no_dup_conflicts($1) AS r`, [C(n)]))[0].r;
  assertEquals((await conflicts(1))?.conflicts.map((c) => c.name).sort(), ["乙", "甲"], "二林鎮第01 的甲、乙都是 1 號");
  assertEquals((await conflicts(1))?.unit, "彰化縣|二林鎮第01選舉區");
  assertEquals((await conflicts(2))?.conflicts, []);
  assertEquals((await conflicts(3))?.conflicts.map((c) => c.name), ["丙"]);
  assertEquals(await conflicts(4), null, "沒有選舉區＝單位算不出來＝不檢查（跟以前一樣）");
  assertEquals((await conflicts(5))?.conflicts.map((c) => c.name), ["新己"]);
  assertEquals((await conflicts(6))?.conflicts.map((c) => c.name), ["新戊"]);
  await dbN.close();
});

// ---------- ⑥ migration 的範圍 ----------
Deno.test("M1 migration 範圍：只重新定義這四樣；不寫任何人物／參選紀錄／regions／貢獻；不碰總表、活動名清單、規則、seed；沒有金鑰", () => {
  const c = code(N);
  const bare = c.replace(/'(?:[^']|'')*'/g, "''"); // 字串（任務說明、COMMENT）不算程式碼
  const defined = [...c.matchAll(/CREATE OR REPLACE (?:FUNCTION|VIEW) ([a-z_]+)/g)].map((m) => m[1]).sort();
  assertEquals(defined, ["ballot_number_unit", "ballot_number_units", "contribution_auto_tasks_ballot_numbers", "contribution_auto_tasks_region_gap"]);
  assert(!/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|CREATE\s+TABLE|DROP)\b/i.test(bare), "不寫任何資料、不改表");
  assert(!/contribution_auto_tasks_arms|activity_arm_names|activity_rules|seed_auto_task_queue|rebalance_queue/.test(bare), "不碰總表、活動名清單、規則、seed、rebalance");
  assert(!/eyJ[A-Za-z0-9_-]{20,}|sb_secret|service_role_key/i.test(N));
  // 新增的只有代表缺選舉區那一支，而且是接在原本補選區臂後面的 UNION ALL
  assertEquals(c.split("rep_gaps AS (").length - 1, 1);
  assertEquals(c.split("UNION ALL\n  SELECT 'auto:candidacy_source_missing:' || y.pe_id").length - 1, 1);
});

Deno.test("M2 機械替換：新臂＝舊臂（#452 現行）只動三處；新補選區臂＝舊的（現行）加一段 CTE 與一段 UNION ALL；號次單位函式與視圖＝舊的只多代表的分支", () => {
  const REPS = "('鄉鎮市民代表', '直轄市山地原住民區民代表')";
  // 補號次臂：g_all 的兩欄、grouped 多一欄 has_district、任務說明多代表的兩個分支——還原這三處就是舊的
  let arm = fnText(N, "contribution_auto_tasks_ballot_numbers");
  arm = mutate(
    arm,
    "           -- 代表的 regions.sub_region 可能是「麥寮鄉第04選舉區」（#464）：派工單位照舊是鄉鎮，選舉區放 district\n" +
      `           CASE WHEN pe.election_type IN ${REPS} THEN NULLIF(regexp_replace(r.sub_region, '(第[0-9]+)?選舉區$', ''), '')\n` +
      "                WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長') THEN r.sub_region END AS unit_town,\n" +
      "           -- 縣市議員的 regions.sub_region 存的是選舉區（第NN選舉區）；代表的選舉區取尾巴的「第NN選舉區」\n" +
      "           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region\n" +
      `                WHEN pe.election_type IN ${REPS} THEN substring(r.sub_region from '第[0-9]+選舉區$') END AS district,\n`,
    "           CASE WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN r.sub_region END AS unit_town,\n" +
      "           -- 縣市議員的 regions.sub_region 存的是選舉區（第NN選舉區）\n" +
      "           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region END AS district,\n",
  );
  arm = mutate(arm, "count(*) AS items_count, bool_or(n.district IS NOT NULL) AS has_district,\n", "count(*) AS items_count,\n");
  arm = mutate(
    arm,
    "WHEN '村里長' THEN '、village 照 target.items'\n" +
      "                                   WHEN '鄉鎮市民代表' THEN CASE WHEN u.has_district THEN '、items 裡有 electoral_district 的照填（代表的號次是按選舉區編的，沒有的不要自己加）' ELSE '' END\n" +
      "                                   WHEN '直轄市山地原住民區民代表' THEN CASE WHEN u.has_district THEN '、items 裡有 electoral_district 的照填（代表的號次是按選舉區編的，沒有的不要自己加）' ELSE '' END\n" +
      "                                   ELSE '' END\n",
    "WHEN '村里長' THEN '、village 照 target.items' ELSE '' END\n",
  );
  assertEquals(arm, fnText(B, "contribution_auto_tasks_ballot_numbers"), "還原三處就是 #452 的現行定義");
  // 視圖：town／district 兩欄
  let view = viewSql(N, "ballot_number_units");
  view = mutate(
    view,
    "           -- 代表的 regions.sub_region 是「麥寮鄉第04選舉區」：town 取鄉鎮、district 取「第04選舉區」（#464）；其他選舉別照舊\n" +
      "           CASE WHEN pe.election_type = '縣市議員' THEN NULL\n" +
      `                WHEN pe.election_type IN ${REPS} THEN NULLIF(regexp_replace(r.sub_region, '(第[0-9]+)?選舉區$', ''), '')\n` +
      "                ELSE r.sub_region END AS town,\n" +
      "           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region\n" +
      `                WHEN pe.election_type IN ${REPS} THEN substring(r.sub_region from '第[0-9]+選舉區$') END AS district,\n`,
    "           CASE WHEN pe.election_type <> '縣市議員' THEN r.sub_region END AS town,\n" +
      "           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region END AS district,\n",
  );
  assertEquals(view, viewSql(B, "ballot_number_units"), "還原兩欄就是 #452 的現行定義");
  // 補選區臂：加一段 CTE、加一段 UNION ALL
  const oldGap = fnText(R, "contribution_auto_tasks_region_gap");
  let gap = fnText(N, "contribution_auto_tasks_region_gap");
  const c0 = gap.indexOf("  -- 代表的選舉區（#464）");
  const c1 = gap.indexOf("  gaps AS (");
  assert(c0 > 0 && c1 > c0);
  gap = gap.slice(0, c0) + gap.slice(c1);
  const u0 = gap.indexOf("  UNION ALL\n  SELECT 'auto:candidacy_source_missing:' || y.pe_id");
  assert(u0 > 0);
  gap = gap.slice(0, u0) + "$$;";
  assertEquals(gap, oldGap, "拿掉 CTE 與 UNION ALL 就是現行定義（補選區臂原本的部分一字不差）");
  // 號次單位函式：ELSE NULL 前多一個分支
  const oldUnit = fnText(B, "ballot_number_unit");
  const newUnit = fnText(N, "ballot_number_unit");
  const b0 = newUnit.indexOf("    -- 鄉鎮市民代表、直轄市山地原住民區民代表（#464）");
  const b1 = newUnit.indexOf("    ELSE NULL");
  assert(b0 > 0 && b1 > b0);
  assertEquals(newUnit.slice(0, b0) + newUnit.slice(b1), oldUnit, "拿掉代表分支就是舊的");
});

// ---------- ⑦ 還原驗證 ----------
const MUT: Array<{ name: string; breaks: string[]; edit: (s: string) => string }> = [
  { name: "號次單位拿掉代表分支（回到不檢查）", breaks: ["u_reps_by_district", "u_record_equals_payload", "u_distinct_units", "v_dup_in_same_district", "v_gap_when_complete"],
    edit: (s) => mutate(s, "    WHEN p_election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN (", "    WHEN false THEN (") },
  { name: "選舉區數字不補兩位（第1≠第01）", breaks: ["u_reps_by_district", "u_record_equals_payload"],
    edit: (s) => mutate(s, "'第' || lpad(rd.num, 2, '0') || '選舉區'", "'第' || rd.num || '選舉區'") },
  { name: "號次單位不管鄉鎮（只有選舉區）", breaks: ["u_distinct_units", "v_dup_in_same_district"],
    edit: (s) => mutate(s, "replace(btrim(p_county), '臺', '台') || '|' || replace(rd.town, '臺', '台') || '第'", "replace(btrim(p_county), '臺', '台') || '|' || '第'") },
  { name: "視圖的 town 不去掉選舉區", breaks: ["v_town_and_district_split"],
    edit: (s) => mutate(s, "WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN NULLIF(regexp_replace(r.sub_region, '(第[0-9]+)?選舉區$', ''), '')\n                ELSE r.sub_region END AS town", "ELSE r.sub_region END AS town") },
  { name: "補號次臂的 unit_town 不去掉選舉區", breaks: ["a_dispatch_unit_is_township", "a_items_carry_district"],
    edit: (s) => mutate(s, "CASE WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN NULLIF(regexp_replace(r.sub_region, '(第[0-9]+)?選舉區$', ''), '')\n                WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長') THEN r.sub_region END AS unit_town", "CASE WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN r.sub_region END AS unit_town") },
  { name: "補選區臂把表態未登記／退選的也派", breaks: ["g_extra_set", "g_not_dispatched"],
    edit: (s) => mutate(s, "       AND candidacy_is_listed(pe.candidacy_status) AND reg.n > 0", "       AND reg.n > 0") },
  { name: "補選區臂不看名冊有沒有選舉區（金門縣單一選區也派）", breaks: ["g_extra_set", "g_not_dispatched"],
    edit: (s) => mutate(s, "AND c.region = replace(r.region, '臺', '台') AND c.district IS NOT NULL", "AND c.region = replace(r.region, '臺', '台')") },
  { name: "補選區臂把被取代的舊版名冊也算", breaks: ["g_extra_set", "g_not_dispatched"],
    edit: (s) => mutate(s, "JOIN cec_registration_sources s ON s.source_url = c.source_url AND s.superseded_by IS NULL", "JOIN cec_registration_sources s ON s.source_url = c.source_url") },
  { name: "補選區臂不比鄉鎮（只比縣市與姓名）", breaks: ["g_hint_carries_district"],
    edit: (s) => mutate(s, "           AND replace(c.sub_region, '臺', '台') = replace(r.sub_region, '臺', '台')\n", "") },
];
for (const m of MUT) {
  Deno.test(`X1 還原驗證：${m.name} → ${m.breaks.join("、")} 必須紅`, async () => {
    const dbO = await buildReady("old");
    const dbN = await buildReady("new", m.edit);
    const v = { ...(await unitGuards(dbN)), ...(await viewGuards(dbN)), ...(await armGuards(dbN)), ...(await gapGuards(dbO, dbN)) };
    const all = [...ALL_U, ...ALL_V, ...ALL_A, ...ALL_G];
    const red = all.filter((g) => v[g] !== true);
    for (const b of m.breaks) assert(red.includes(b), `改壞了「${m.name}」，守門 ${b} 卻沒紅（紅的：${red.join("、") || "無"}）`);
    await dbO.close();
    await dbN.close();
  });
}
