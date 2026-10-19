/**
 * 中選會比對得上由系統寫入，對不上才派代理（＋開票夜守門）（維護者 2026-10-19，#678；migration 20261019100000）的守門測試。
 *
 * PGlite 實跑：把整支 migration 原樣載進一個迷你資料庫（真的 election_result_cec_matches、cec_name_key、activity_today、
 * 審計觸發器；只有表是簡化的），在合成資料上驗：
 *   1. 唯一對上＋選區開完 → 寫入（結果＋政黨），每筆進 edit_history（cec-results-auto）、留證據、整次可還原；再跑一次不重寫
 *   2. 未開完（當選數沒到席次／超過席次／有空白）、席次沒登錄 → 不寫
 *   3. 同名多筆（中選會）→ 不寫、派逐位件；我們有兩筆對到同一位 → 不寫、留在批次
 *   4. 不一致（我們標的跟中選會相反）→ 不覆蓋、派 result_mismatch
 *   5. 投票日當天（台北日期）→ 不寫，隔天才寫
 *   6. 派工臂：被系統寫的不派、沒寫的照派；開關關掉就全派回代理（沒有洞）
 *   7. 系統票（election_results_compare／system_check）：選區沒開完 → unit_open 不投票；底定後可再核
 *   8. migration 本身不改任何正式資料
 *   9. 還原驗證：拿掉開完判斷、拿掉投票日檢查、拿掉重複對到的檢查、拿掉 unit_open 都要紅
 * TS 這邊：RESULT_SETTLE_DAYS 與 SQL 對齊、withoutUnsettledResults、cec-verify 開票後三天內不採用「沒標＝落選」。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, mutate, readMig } from "./arms-pglite.ts";
import { cecResultsSettled, normalizeCandidacies, RESULT_SETTLE_DAYS, taipeiDate, withoutFutureResults, withoutUnsettledResults } from "./cec-candidate.ts";
import { decideByCec } from "./cec-verify.ts";
import { COMPARE_STATUS_LABEL, COMPARE_STATUSES } from "./election-results.ts";

const MIG = "20261019100000_cec_results_auto_apply.sql";
const BASE_CLOCK = "2022-11-27"; // 2022 投票日（11-26）的隔天

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ── 迷你資料庫 ────────────────────────────────────────────────
const SCHEMA = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE elections (id integer PRIMARY KEY, election_key text, election_date date, election_reason text);
CREATE TABLE politicians (id uuid PRIMARY KEY, name text NOT NULL, birth_year integer, region text, sub_region text, village text, merged_into uuid, party text);
CREATE TABLE regions (id integer PRIMARY KEY, region text, sub_region text, village text);
CREATE TABLE politician_elections (id integer PRIMARY KEY, politician_id uuid NOT NULL, election_id integer NOT NULL, election_type text, region_id integer,
  candidacy_status text, party_id bigint, party_basis text, cand_no integer, source_note text, UNIQUE (politician_id, election_id));
ALTER TABLE politician_elections ADD CONSTRAINT politician_elections_party_basis_check CHECK (party_basis IN ('contribution', 'person_single'));
ALTER TABLE politician_elections ADD CONSTRAINT politician_elections_party_needs_basis CHECK (party_id IS NULL OR party_basis IS NOT NULL);
CREATE TABLE cec_candidates (id bigserial PRIMARY KEY, election_id integer NOT NULL, election_type text NOT NULL, region text NOT NULL, sub_region text, village text,
  name text NOT NULL, name_norm text NOT NULL, birth_year integer, cand_no integer, elected boolean, cec_theme_id text, cec_cand_id integer, party text, synced_at timestamptz DEFAULT now());
CREATE INDEX cec_candidates_name_idx ON cec_candidates (election_id, name_norm);
CREATE TABLE election_districts (id bigserial PRIMARY KEY, election_id integer NOT NULL, election_type text NOT NULL, region text NOT NULL, sub_region text, village text, seats integer);
CREATE TABLE parties (id bigint PRIMARY KEY, name text);
CREATE TABLE party_aliases (alias_key text PRIMARY KEY, party_id bigint, kind text);
CREATE TABLE edit_history (id bigserial PRIMARY KEY, table_name text NOT NULL, record_id text NOT NULL, field text NOT NULL, old_value jsonb, new_value jsonb,
  contribution_id uuid, agent_name text, applied_at timestamptz NOT NULL DEFAULT now(), reverted_at timestamptz, reverted_by text);
CREATE TABLE contributions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contribution_type text, status text, payload jsonb, task_id text, created_at timestamptz DEFAULT now());
CREATE TABLE jev_decisions (id bigserial PRIMARY KEY, subject_type text, subject_id text, question text, choice text, probability numeric, confidence numeric,
  probabilities jsonb, model text, state jsonb, cost_usd numeric, asked_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION contribution_apply_consensus(p uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE FUNCTION candidacy_protocol_status(s text, b boolean) RETURNS text LANGUAGE sql AS $$ SELECT s $$;
CREATE FUNCTION candidacy_list_published(a integer, b text, c date) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
`;

const CEC_ROWS: Array<{ name: string; type: string; region: string; sub?: string; village?: string; elected: boolean | null; party?: string; election?: number }> = [];
const cec = (name: string, region: string, elected: boolean | null, o: { type?: string; sub?: string; village?: string; party?: string; election?: number } = {}) => {
  CEC_ROWS.push({ name, type: o.type ?? "縣市長", region, sub: o.sub, village: o.village, elected, party: o.party ?? "甲黨", election: o.election });
};

interface PeSeed { id: number; who: number; name: string; election?: number; type?: string; county: string; sub?: string; village?: string; status: string | null; basis?: string }
const PES: PeSeed[] = [];
const pe = (id: number, who: number, name: string, county: string, status: string | null, o: { election?: number; type?: string; sub?: string; village?: string; basis?: string } = {}) => {
  PES.push({ id, who, name, county, status, ...o });
};
const DISTRICTS: Array<{ election: number; type: string; region: string; sub?: string; village?: string; seats: number }> = [];
const seats = (region: string, n: number, o: { election?: number; type?: string; sub?: string; village?: string } = {}) => {
  DISTRICTS.push({ election: o.election ?? 2022, type: o.type ?? "縣市長", region, sub: o.sub, village: o.village, seats: n });
};

// ── 情境 ─────────────────────────────────────────────────────
// A 台北市（1 席）：甲當選、乙落選（無黨籍）；我們都還空白 → 寫（結果＋政黨）
cec("甲A", "台北市", true); cec("乙A", "台北市", false, { party: "無黨籍及未經政黨推薦" }); seats("台北市", 1);
pe(1, 1, "甲A", "台北市", "filed"); pe(2, 2, "乙A", "台北市", null);
// B 新北市（1 席）：開票途中，一位當選都還沒標（兩位都 false）→ 不寫，留在批次
cec("丙B", "新北市", false); cec("丁B", "新北市", false); seats("新北市", 1);
pe(3, 3, "丙B", "新北市", "filed"); pe(4, 4, "丁B", "新北市", "filed");
// C 台中市：應選名額沒登錄 → 不算開完，不寫，留在批次
cec("戊C", "台中市", true); cec("己C", "台中市", false);
pe(5, 5, "戊C", "台中市", "filed"); pe(6, 6, "己C", "台中市", "filed");
// D 高雄市（1 席）：我們有兩位「庚D」都對到中選會同一位 → 不寫那兩筆（留在批次）；辛照寫
cec("庚D", "高雄市", true); cec("辛D", "高雄市", false); seats("高雄市", 1);
pe(7, 7, "庚D", "高雄市", "filed"); pe(8, 8, "庚D", "高雄市", "filed"); pe(9, 9, "辛D", "高雄市", "filed");
// E 桃園市（1 席）：中選會有兩位同名「壬E」→ 唯一對上不成立：不寫，派逐位件
cec("壬E", "桃園市", true); cec("壬E", "桃園市", false); seats("桃園市", 1);
pe(10, 10, "壬E", "桃園市", "filed");
// F 台南市（1 席）：我們標的跟中選會相反（癸標落選、子標當選）→ 不覆蓋，派 result_mismatch
cec("癸F", "台南市", true); cec("子F", "台南市", false); seats("台南市", 1);
pe(11, 11, "癸F", "台南市", "not_elected", { basis: "contribution" }); pe(12, 12, "子F", "台南市", "elected", { basis: "contribution" });
// G 嘉義縣（1 席）：一致 → 什麼都不做
cec("丑G", "嘉義縣", true); cec("寅G", "嘉義縣", false); seats("嘉義縣", 1);
pe(13, 13, "丑G", "嘉義縣", "elected", { basis: "contribution" }); pe(14, 14, "寅G", "嘉義縣", "not_elected", { basis: "contribution" });
// H 宜蘭縣（1 席）：中選會標了兩位當選（超過席次）→ 不算開完
cec("卯H", "宜蘭縣", true); cec("辰H", "宜蘭縣", true); seats("宜蘭縣", 1);
pe(15, 15, "卯H", "宜蘭縣", "filed"); pe(16, 16, "辰H", "宜蘭縣", "filed");
// I 花蓮縣（1 席）：有一位當選與否是空的 → 不算開完
cec("巳I", "花蓮縣", true); cec("午I", "花蓮縣", null); seats("花蓮縣", 1);
pe(17, 17, "巳I", "花蓮縣", "filed"); pe(18, 18, "午I", "花蓮縣", "filed");
// J 澎湖縣（1 席）：未表態退選（withdrawn）不寫；申照寫
cec("未J", "澎湖縣", true); cec("申J", "澎湖縣", false); seats("澎湖縣", 1);
pe(19, 19, "未J", "澎湖縣", "withdrawn", { basis: "contribution" }); pe(20, 20, "申J", "澎湖縣", null);
// K 村里長 台北市中山區一里（1 席，有村里）：酉當選、戌落選（無黨籍）→ 寫
cec("酉K", "台北市", true, { type: "村里長", sub: "中山區", village: "一里" }); cec("戌K", "台北市", false, { type: "村里長", sub: "中山區", village: "一里", party: "無黨籍及未經政黨推薦" });
seats("台北市", 1, { type: "村里長", sub: "中山區", village: "一里" });
pe(21, 21, "酉K", "台北市", "filed", { type: "村里長", sub: "中山區", village: "一里" }); pe(22, 22, "戌K", "台北市", "filed", { type: "村里長", sub: "中山區", village: "一里" });
// N 中選會名單查無（hits＝0）→ 逐位件
cec("路人N", "台北市", true, { type: "縣市議員", sub: "第01選舉區" });
pe(25, 25, "無此人N", "台北市", "filed");
// L 2026（投票日 2026-11-28）苗栗縣（1 席）：投票日當天不寫、隔天才寫
cec("亥L", "苗栗縣", true, { election: 2026 }); cec("丑丑L", "苗栗縣", false, { election: 2026 }); seats("苗栗縣", 1, { election: 2026 });
pe(23, 23, "亥L", "苗栗縣", "filed", { election: 2026 }); pe(24, 24, "丑丑L", "苗栗縣", "filed", { election: 2026 });

// Z 鄉鎮市長 雲林縣台西鄉：我們寫「臺西鄉」、中選會與名額表寫「台西鄉」→ 要對得上（臺／台一律當同字，#691 審查）
cec("甲Z", "雲林縣", true, { type: "鄉鎮市長", sub: "台西鄉" }); cec("乙Z", "雲林縣", false, { type: "鄉鎮市長", sub: "台西鄉" }); seats("雲林縣", 1, { type: "鄉鎮市長", sub: "台西鄉" });
pe(26, 26, "甲Z", "雲林縣", "filed", { type: "鄉鎮市長", sub: "臺西鄉" }); pe(27, 27, "乙Z", "雲林縣", "filed", { type: "鄉鎮市長", sub: "臺西鄉" });
// V 村里長 台北市中山區：我們寫「臺北里」、中選會寫「台北里」
cec("丙V", "台北市", true, { type: "村里長", sub: "中山區", village: "台北里" }); cec("丁V", "台北市", false, { type: "村里長", sub: "中山區", village: "台北里" });
seats("台北市", 1, { type: "村里長", sub: "中山區", village: "臺北里" }); // 名額表也可能是臺
pe(28, 28, "丙V", "台北市", "filed", { type: "村里長", sub: "中山區", village: "臺北里" }); pe(29, 29, "丁V", "台北市", "filed", { type: "村里長", sub: "中山區", village: "臺北里" });

const seedSql = (): string => {
  const out: string[] = [];
  out.push(`INSERT INTO elections VALUES (2022, '2022-11-26_local', '2022-11-26', 'regular'), (2026, '2026-11-28_local', '2026-11-28', 'regular');`);
  out.push(`INSERT INTO parties VALUES (7, '甲黨');`);
  out.push(`INSERT INTO party_aliases VALUES (party_alias_key('甲黨'), 7, 'name'), (party_alias_key('無黨籍及未經政黨推薦'), NULL, 'independent');`);
  for (const p of PES) {
    out.push(`INSERT INTO politicians (id, name, region) VALUES ('${U(p.who)}', '${p.name}', '${p.county}');`);
    out.push(`INSERT INTO regions VALUES (${p.id}, '${p.county}', ${p.sub ? `'${p.sub}'` : "NULL"}, ${p.village ? `'${p.village}'` : "NULL"});`);
    out.push(`INSERT INTO politician_elections (id, politician_id, election_id, election_type, region_id, candidacy_status, party_id, party_basis)
      VALUES (${p.id}, '${U(p.who)}', ${p.election ?? 2022}, '${p.type ?? "縣市長"}', ${p.id}, ${p.status ? `'${p.status}'` : "NULL"}, ${p.basis ? 9 : "NULL"}, ${p.basis ? `'${p.basis}'` : "NULL"});`);
  }
  let n = 0;
  for (const c of CEC_ROWS) {
    n++;
    out.push(`INSERT INTO cec_candidates (election_id, election_type, region, sub_region, village, name, name_norm, elected, cec_theme_id, cec_cand_id, party)
      VALUES (${c.election ?? 2022}, '${c.type}', '${c.region}', ${c.sub ? `'${c.sub}'` : "NULL"}, ${c.village ? `'${c.village}'` : "NULL"}, '${c.name}', cec_name_key('${c.name}'),
              ${c.elected === null ? "NULL" : c.elected}, 'theme-${c.type}', ${1000 + n}, '${c.party}');`);
  }
  for (const d of DISTRICTS) {
    out.push(`INSERT INTO election_districts (election_id, election_type, region, sub_region, village, seats)
      VALUES (${d.election}, '${d.type}', '${d.region}', ${d.sub ? `'${d.sub}'` : "NULL"}, ${d.village ? `'${d.village}'` : "NULL"}, ${d.seats});`);
  }
  return out.join("\n");
};
// parties 的 party_id＝9 只是讓「已有政黨依據」的列通過 CHECK（party_id 有值要有依據）；9 不存在於 parties 也沒關係（沒有外鍵）

interface Built { db: PGlite; before: string; after: string; migrationRows: number; defaultEnabled: boolean }
const snapshot = async (db: PGlite) =>
  JSON.stringify((await db.query(`SELECT id, candidacy_status, party_id, party_basis FROM politician_elections ORDER BY id`)).rows)
  + JSON.stringify((await db.query(`SELECT count(*)::int AS n FROM edit_history WHERE table_name = 'politician_elections'`)).rows);

async function build(edit: (sql: string) => string = (s) => s, clock: string | null = BASE_CLOCK): Promise<Built> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const n of ["activity_today", "activity_touch_updated_at", "activity_audit"]) {
    await db.exec(await latestFn(n));
  }
  for (const n of ["politician_name_is_placeholder", "cec_name_norm", "cec_name_key", "party_alias_key", "election_result_cec_matches"]) {
    await db.exec(await latestFn(n, MIG));
  }
  await db.exec(fnText(await readMig("20261006141500_election_results_batch.sql"), "election_results_system_check"));
  await db.exec(seedSql());
  const before = await snapshot(db);
  await db.exec(edit(await readMig(MIG)));
  const after = await snapshot(db);
  // 上線時開關預設關：先記下預設值，再打開（其餘測試都是「已打開」的情境）
  const defaultEnabled = (await db.query<{ enabled: boolean }>(`SELECT enabled FROM cec_results_auto_settings WHERE id = 1`)).rows[0].enabled;
  await db.exec(`UPDATE cec_results_auto_settings SET enabled = true WHERE id = 1`);
  if (clock) await db.exec(`SET app.activity_today = '${clock}'`);
  await db.exec(`SELECT cec_results_auto_refresh()`); // 快取：部署後由排程算第一次
  return { db, before, after, migrationRows: 0, defaultEnabled };
}
const clock = async (db: PGlite, d: string) => {
  await db.exec(`SET app.activity_today = '${d}'`);
  await db.exec(`SELECT cec_results_auto_refresh()`); // 日期換了鍵就變，重算一次（排程每 10 分鐘會做）
};
const rows = async <T = Record<string, unknown>>(db: PGlite, sql: string) => (await db.query<T>(sql)).rows;
const ids = async (db: PGlite, sql: string) => (await rows<{ id: number }>(db, sql)).map((r) => Number(r.id)).sort((a, b) => a - b);

type Obs = {
  writeResult: number[]; writeParty: number[]; mismatch: number[];
  afterWrite: Array<{ id: number; candidacy_status: string | null; party_id: string | null; party_basis: string | null }>;
  batchTasks: string[]; singleTasks: string[]; mismatchTasks: string[];
};

/** 一次觀察：計畫、寫入後的結果、派工臂輸出（寫入前後各一次，臂都不該派被系統寫的） */
async function observe(db: PGlite): Promise<Obs> {
  const plan = await rows<{ politician_election_id: number; write_result: boolean; write_party: boolean; mismatch: boolean }>(db,
    `SELECT politician_election_id, write_result, write_party, mismatch FROM cec_results_auto_plan() ORDER BY 1`);
  const arm = await rows<{ task_id: string; target: Record<string, unknown> }>(db, `SELECT task_id, target FROM contribution_auto_tasks_election_results() ORDER BY 1`);
  return {
    writeResult: plan.filter((p) => p.write_result).map((p) => Number(p.politician_election_id)),
    writeParty: plan.filter((p) => p.write_party).map((p) => Number(p.politician_election_id)),
    mismatch: plan.filter((p) => p.mismatch).map((p) => Number(p.politician_election_id)),
    afterWrite: [],
    batchTasks: arm.filter((a) => a.task_id.startsWith("auto:election_results_missing:")).map((a) => `${a.task_id}=${JSON.stringify([...(a.target.politician_election_ids as number[])].sort((x, y) => x - y))}`),
    singleTasks: arm.filter((a) => a.task_id.startsWith("auto:election_result_missing:") && a.target.kind !== "result_mismatch").map((a) => a.task_id),
    mismatchTasks: arm.filter((a) => a.target.kind === "result_mismatch").map((a) => a.task_id),
  };
}

// ── 1～6：計畫、寫入、派工臂 ───────────────────────────────────
const EXPECT_BEFORE = {
  writeResult: [1, 2, 9, 20, 21, 22, 26, 27, 28, 29],
  writeParty: [1, 2, 9, 20, 21, 22, 26, 27, 28, 29],
  mismatch: [11, 12],
  // 批次：新北（沒標當選）、台中（名額沒登錄）、高雄（庚D 兩筆對到同一位）、宜蘭（超過席次）、花蓮（有空白）；寫得了的（台北、高雄的辛、澎湖的申、村里長）都不在
  batchTasks: [
    "auto:election_results_missing:2022:縣市長:宜蘭縣=[15,16]",
    // 2026 苗栗縣：投票日還沒過，系統不寫；派工臂本身不比日期（窗口由規則「投票日 +1 起」管），所以總表過濾前它會在
    "auto:election_results_missing:2026:縣市長:苗栗縣=[23,24]",
    "auto:election_results_missing:2022:縣市長:新北市=[3,4]",
    "auto:election_results_missing:2022:縣市長:台中市=[5,6]",
    "auto:election_results_missing:2022:縣市長:花蓮縣=[17,18]",
    "auto:election_results_missing:2022:縣市長:高雄市=[7,8]",
  ].sort(),
  singleTasks: ["auto:election_result_missing:10", "auto:election_result_missing:25"],
  mismatchTasks: ["auto:election_result_missing:11", "auto:election_result_missing:12"],
};

function assertObservation(o: Obs, why: string): void {
  assertEquals(o.writeResult, EXPECT_BEFORE.writeResult, `${why}：寫得了的結果`);
  assertEquals(o.writeParty, EXPECT_BEFORE.writeParty, `${why}：寫得了的政黨`);
  assertEquals(o.mismatch, EXPECT_BEFORE.mismatch, `${why}：不一致`);
  assertEquals([...o.batchTasks].sort(), EXPECT_BEFORE.batchTasks, `${why}：批次只剩系統確認不了的`);
  assertEquals([...o.singleTasks].sort(), EXPECT_BEFORE.singleTasks, `${why}：逐位件只剩對不上（0 筆、同名多筆）的`);
  assertEquals([...o.mismatchTasks].sort(), EXPECT_BEFORE.mismatchTasks, `${why}：不一致派 result_mismatch`);
}

Deno.test("計畫與派工臂：唯一對上＋開完的由系統寫、其餘照派；不一致派 result_mismatch、不覆蓋", async () => {
  const { db } = await build();
  assertObservation(await observe(db), "寫入前");
  await db.close();
});

Deno.test("寫入：只補空白、結果與政黨一起、每筆進 edit_history、留證據、一個 run；再跑一次不重寫", async () => {
  const { db } = await build();
  const res = (await rows<{ r: Record<string, unknown> }>(db, `SELECT cec_results_auto_apply() AS r`))[0].r;
  assertEquals(res.results_written, 10);
  assertEquals(res.parties_written, 10);
  const state = await rows<{ id: number; candidacy_status: string | null; party_id: string | null; party_basis: string | null }>(db,
    `SELECT id, candidacy_status, party_id::text AS party_id, party_basis FROM politician_elections ORDER BY id`);
  const by = (id: number) => state.find((s) => s.id === id)!;
  assertEquals([by(1).candidacy_status, by(2).candidacy_status, by(9).candidacy_status, by(20).candidacy_status, by(21).candidacy_status, by(22).candidacy_status],
    ["elected", "not_elected", "not_elected", "not_elected", "elected", "not_elected"]);
  assertEquals([by(1).party_id, by(1).party_basis], ["7", "cec"], "推薦政黨照名冊");
  assertEquals([by(2).party_id, by(2).party_basis], [null, "cec"], "無黨籍那一族：party_id 空、依據 cec");
  // 寫不了的原封不動
  for (const id of [3, 4, 5, 6, 7, 8, 10, 15, 16, 17, 18, 25]) assertEquals(by(id).candidacy_status, "filed", `pe${id} 不該被寫`);
  assertEquals([by(11).candidacy_status, by(12).candidacy_status], ["not_elected", "elected"], "不一致的不覆蓋");
  assertEquals(by(19).candidacy_status, "withdrawn", "退選的不寫");
  assertEquals([by(23).candidacy_status, by(24).candidacy_status], ["filed", "filed"], "2026 還沒投票");
  // edit_history：每個真的改的欄位一筆、agent_name 是系統名
  const eh = await rows<{ record_id: string; field: string; old_value: unknown; new_value: unknown; agent_name: string; contribution_id: string | null }>(db,
    `SELECT record_id, field, old_value, new_value, agent_name, contribution_id FROM edit_history WHERE table_name = 'politician_elections' ORDER BY id`);
  assert(eh.every((e) => e.agent_name === "cec-results-auto" && e.contribution_id === null));
  assertEquals(eh.filter((e) => e.field === "candidacy_status").length, 10);
  assertEquals(eh.filter((e) => e.field === "party_basis").length, 10);
  assertEquals(eh.filter((e) => e.field === "party_id").length, 8, "party_id 只有真的有政黨的才記（無黨籍 NULL→NULL 不記）");
  const first = eh.find((e) => e.record_id === "1" && e.field === "candidacy_status")!;
  assertEquals([first.old_value, first.new_value], ["filed", "elected"]);
  // 證據與 run
  const logs = await rows<{ politician_election_id: number; evidence: { source: string; unit: { seats: number; cec_elected: number } } }>(db, `SELECT politician_election_id, evidence FROM cec_results_auto_log ORDER BY 1`);
  assertEquals(logs.map((l) => Number(l.politician_election_id)), [1, 2, 9, 20, 21, 22, 26, 27, 28, 29]);
  assertStringIncludes(logs[0].evidence.source, "中選會");
  assertEquals([logs[0].evidence.unit.seats, logs[0].evidence.unit.cec_elected], [1, 1]);
  const runs = await rows<{ results_written: number; parties_written: number; first_edit_id: string; last_edit_id: string }>(db, `SELECT * FROM cec_auto_apply_runs`);
  assertEquals(runs.length, 1);
  assertEquals([runs[0].results_written, runs[0].parties_written], [10, 10]);
  // 再跑一次：沒有東西可寫，不留空 run、不重複寫履歷
  const again = (await rows<{ r: Record<string, unknown> }>(db, `SELECT cec_results_auto_apply() AS r`))[0].r;
  assertEquals([again.results_written, again.parties_written], [0, 0]);
  assertEquals((await rows(db, `SELECT 1 FROM cec_auto_apply_runs`)).length, 1);
  assertEquals((await rows(db, `SELECT 1 FROM edit_history WHERE table_name = 'politician_elections'`)).length, eh.length);
  // 寫完以後：派工臂輸出不變（被寫的本來就不派），計畫也歸零
  const o = await observe(db);
  assertEquals(o.writeResult, []);
  assertEquals(o.writeParty, []);
  assertEquals([...o.batchTasks].sort(), EXPECT_BEFORE.batchTasks);
  assertEquals(o.mismatch, [11, 12]);
  await db.close();
});

Deno.test("batch_limit：一次最多寫這麼多位，分幾輪寫完", async () => {
  const { db } = await build();
  const first = (await rows<{ r: Record<string, unknown> }>(db, `SELECT cec_results_auto_apply(2) AS r`))[0].r;
  assertEquals(first.results_written, 2);
  assert(Number(first.parties_written) <= 2);
  let guard = 0;
  while (guard++ < 10) {
    const r = (await rows<{ r: Record<string, unknown> }>(db, `SELECT cec_results_auto_apply(2) AS r`))[0].r;
    if (r.results_written === 0 && r.parties_written === 0) break;
  }
  assertEquals((await ids(db, `SELECT id FROM politician_elections WHERE candidacy_status IN ('elected','not_elected') AND id IN (1,2,9,20,21,22)`)), [1, 2, 9, 20, 21, 22]);
  await db.close();
});

Deno.test("投票日當天（台北日期）不寫，隔天才寫：計畫、單位狀態、系統票三處各自守", async () => {
  const { db } = await build();
  // 2026 苗栗縣：投票日 2026-11-28。當天：計畫沒有它、單位不算開完
  await clock(db, "2026-11-28");
  const day0 = await rows<{ politician_election_id: number }>(db, `SELECT politician_election_id FROM cec_results_auto_plan() WHERE politician_election_id IN (23, 24)`);
  assertEquals(day0.length, 0, "投票日當天計畫不含 2026 的人");
  assertEquals((await rows<{ complete: boolean }>(db, `SELECT complete FROM cec_unit_status WHERE election_id = 2026`))[0].complete, false, "投票日當天單位不算開完（view 自己也守）");
  await clock(db, "2026-11-29");
  assertEquals((await ids(db, `SELECT politician_election_id AS id FROM cec_results_auto_plan() WHERE politician_election_id IN (23, 24) AND write_result`)), [23, 24]);
  assertEquals((await rows<{ complete: boolean }>(db, `SELECT complete FROM cec_unit_status WHERE election_id = 2026`))[0].complete, true);
  // 2022：投票日當天（2022-11-26）一筆都不寫
  await clock(db, "2022-11-26");
  assertEquals((await rows(db, `SELECT 1 FROM cec_results_auto_plan()`)).length, 0);
  assertEquals((await rows<{ r: Record<string, unknown> }>(db, `SELECT cec_results_auto_apply() AS r`))[0].r.results_written, 0);
  assertEquals((await rows(db, `SELECT 1 FROM politician_elections WHERE candidacy_status IN ('elected','not_elected') AND id IN (1,2,9,20,21,22)`)).length, 0);
  await db.close();
});

Deno.test("開關：關掉 enabled，計畫一列都不回、不寫，派工臂把這些人全派回給代理（沒有洞）", async () => {
  const { db } = await build();
  await db.exec(`UPDATE cec_results_auto_settings SET enabled = false WHERE id = 1`);
  assertEquals((await rows(db, `SELECT 1 FROM cec_results_auto_plan()`)).length, 0);
  assertEquals((await rows<{ r: Record<string, unknown> }>(db, `SELECT cec_results_auto_apply() AS r`))[0].r.skipped, "disabled");
  const arm = await rows<{ task_id: string; target: Record<string, unknown> }>(db, `SELECT task_id, target FROM contribution_auto_tasks_election_results()`);
  const inBatch = arm.filter((a) => a.task_id.startsWith("auto:election_results_missing:")).flatMap((a) => a.target.politician_election_ids as number[]).sort((a, b) => a - b);
  for (const id of [1, 2, 9, 20]) assert(inBatch.includes(id), `pe${id} 關掉開關後要回到批次`);
  assertEquals(arm.filter((a) => (a.target as { kind?: string }).kind === "result_mismatch").length, 0, "關掉開關連不一致的件也不派（計畫沒有就沒有）");
  // 設定表的修改進 edit_history（activity-audit）
  assert((await rows(db, `SELECT 1 FROM edit_history WHERE table_name = 'cec_results_auto_settings' AND agent_name = 'activity-audit'`)).length >= 1);
  await db.close();
});

Deno.test("政黨臂：系統寫得了的不派，其餘照派（只在選區開完時才排除）", async () => {
  const { db } = await build();
  const sqlParty = `SELECT task_id FROM contribution_auto_tasks_party_gap() ORDER BY 1`;
  const before = (await rows<{ task_id: string }>(db, sqlParty)).map((r) => r.task_id);
  // 開完的單位（台北、高雄的辛、澎湖的申、村里長）不在；沒開完或對不到的在（新北 3、4；台中 5、6）
  for (const id of [1, 2, 9, 20, 21, 22]) assert(!before.includes(`auto:candidacy_source_missing:party:${id}`), `pe${id} 系統會寫，不派`);
  for (const id of [3, 4, 5, 6]) assert(before.includes(`auto:candidacy_source_missing:party:${id}`), `pe${id} 系統寫不了，要派`);
  await db.exec(`UPDATE cec_results_auto_settings SET enabled = false WHERE id = 1`);
  const off = (await rows<{ task_id: string }>(db, sqlParty)).map((r) => r.task_id);
  for (const id of [1, 2, 9, 20, 21, 22]) assert(off.includes(`auto:candidacy_source_missing:party:${id}`), `關掉開關後 pe${id} 要回到派工`);
  await db.close();
});

Deno.test("還原：整個 run 倒回；現值被別人改過的不動（blocked）；已還原的不能再還原", async () => {
  const { db } = await build();
  const run = (await rows<{ r: { run_id: number } }>(db, `SELECT cec_results_auto_apply() AS r`))[0].r.run_id;
  await db.exec(`UPDATE politician_elections SET candidacy_status = 'elected' WHERE id = 2`); // 別人後來改過（系統寫的是 not_elected）
  const out = (await rows<{ r: { reverted: number; blocked: number } }>(db, `SELECT cec_results_auto_revert(${run}, 'tester') AS r`))[0].r;
  assertEquals([out.reverted, out.blocked], [9, 1]);
  assertEquals((out as unknown as { auto_disabled: boolean }).auto_disabled, true, "還原自動關開關");
  assertEquals((await rows<{ enabled: boolean }>(db, `SELECT enabled FROM cec_results_auto_settings WHERE id = 1`))[0].enabled, false, "不關的話下一輪排程會補回去");
  assertEquals((await rows(db, `SELECT 1 FROM edit_history WHERE table_name = 'cec_results_auto_settings' AND agent_name = 'activity-audit'`)).length >= 1, true);
  const st = await rows<{ id: number; candidacy_status: string | null; party_id: string | null; party_basis: string | null }>(db,
    `SELECT id, candidacy_status, party_id::text AS party_id, party_basis FROM politician_elections WHERE id IN (1,2,9,20,21,22) ORDER BY id`);
  assertEquals(st.map((s) => [s.id, s.candidacy_status, s.party_id, s.party_basis]), [
    [1, "filed", null, null], [2, "elected", null, "cec"], [9, "filed", null, null], [20, null, null, null], [21, "filed", null, null], [22, "filed", null, null],
  ]);
  assertEquals((await rows(db, `SELECT 1 FROM edit_history WHERE agent_name = 'cec-results-auto' AND reverted_at IS NOT NULL AND reverted_by = 'tester'`)).length > 0, true);
  let again = false;
  try { await db.query(`SELECT cec_results_auto_revert(${run})`); } catch { again = true; }
  assert(again, "同一個 run 不能還原兩次");
  await db.close();
});

// ── 7：系統票 ────────────────────────────────────────────────
async function addResults(db: PGlite, county: string, items: Array<[number, string]>): Promise<string> {
  const payload = { election_id: 2022, election_type: "縣市長", region: county, items: items.map(([id, r]) => ({ politician_election_id: id, election_result: r })) };
  return (await rows<{ id: string }>(db, `INSERT INTO contributions (contribution_type, status, payload) VALUES ('election_results', 'pending', '${JSON.stringify(payload)}'::jsonb) RETURNING id`))[0].id;
}
const statuses = async (db: PGlite, cid: string) =>
  (await rows<{ politician_election_id: number; status: string }>(db, `SELECT politician_election_id, status FROM election_results_compare('${cid}')`)).map((r) => `${r.politician_election_id}:${r.status}`);

Deno.test("系統票：選區開完才對得上（match）；沒開完 unit_open、不投；名額沒登錄的要等整場結算", async () => {
  const { db } = await build();
  const ok = await addResults(db, "台北市", [[1, "elected"], [2, "not_elected"]]);
  const mid = await addResults(db, "新北市", [[3, "not_elected"], [4, "not_elected"]]);
  const noSeats = await addResults(db, "台中市", [[5, "elected"], [6, "not_elected"]]);
  assertEquals(await statuses(db, ok), ["1:match", "2:match"]);
  assertEquals(await statuses(db, mid), ["3:unit_open", "4:unit_open"], "新北：當選數 0／席次 1，開票途中的 false 不是落選");
  assertEquals(await statuses(db, noSeats), ["5:unit_open", "6:unit_open"], "台中：名額沒登錄，結算天數以前也不算");
  assertEquals((await rows<{ c: string }>(db, `SELECT election_results_system_check('${ok}') AS c`))[0].c, "supported");
  assertEquals((await rows<{ c: string }>(db, `SELECT election_results_system_check('${mid}') AS c`))[0].c, "cannot_tell");
  const state = (await rows<{ state: { mismatches: Array<{ status: string }> } }>(db, `SELECT state FROM jev_decisions WHERE subject_id = '${mid}'`))[0].state;
  assertEquals(state.mismatches.map((m) => m.status), ["unit_open", "unit_open"], "只記錄、不動作：留下是哪幾位為什麼沒投");
  // 整場底定（投票日 + 3 天）：名額沒登錄的單位改看結算，照 cec 的標記比
  await clock(db, "2022-11-29");
  assertEquals(await statuses(db, noSeats), ["5:match", "6:match"]);
  assertEquals(await statuses(db, mid), ["3:match", "4:match"], "底定後 false 才算落選（那時中選會的標記已是最後的）");
  await db.close();
});

Deno.test("撿系統票：因 unit_open 沒投的，滿一小時再核；其他核過就不再核", async () => {
  const { db } = await build();
  const mid = await addResults(db, "新北市", [[3, "not_elected"], [4, "not_elected"]]);
  const ok = await addResults(db, "台北市", [[1, "elected"], [2, "not_elected"]]);
  const first = (await rows<{ r: { checked: number; supported: number } }>(db, `SELECT election_results_check_pending() AS r`))[0].r;
  assertEquals([first.checked, first.supported], [2, 1]);
  const second = (await rows<{ r: { checked: number } }>(db, `SELECT election_results_check_pending() AS r`))[0].r;
  assertEquals(second.checked, 0, "剛核過（一小時內）不重核");
  await db.exec(`UPDATE jev_decisions SET asked_at = now() - INTERVAL '2 hours'`);
  await clock(db, "2022-11-29"); // 底定
  const third = (await rows<{ r: { checked: number; supported: number } }>(db, `SELECT election_results_check_pending() AS r`))[0].r;
  assertEquals([third.checked, third.supported], [1, 1], "只有 unit_open 那一件重核，而且這次投得出來；台北那件（核過、已投）不重核");
  assertEquals((await rows(db, `SELECT 1 FROM jev_decisions WHERE subject_id = '${mid}' AND choice = 'supported'`)).length, 1);
  assertEquals((await rows(db, `SELECT 1 FROM jev_decisions WHERE subject_id = '${ok}'`)).length, 1);
  await db.close();
});

Deno.test("比對狀態：TS 清單、中文說明、SQL 都有 unit_open", async () => {
  assert((COMPARE_STATUSES as readonly string[]).includes("unit_open"));
  assert(COMPARE_STATUS_LABEL.unit_open.length > 10);
  assertStringIncludes(await readMig(MIG), "THEN 'unit_open'");
});

// ── 8：migration 本身不改正式資料 ──────────────────────────────
Deno.test("migration 只建函式、表、視圖、排程：載入前後，參選紀錄與其 edit_history 一個字不變", async () => {
  const { db, before, after } = await build();
  assertEquals(after, before);
  const text = await readMig(MIG);
  // 最上層（函式本體之外）沒有對正式表的 UPDATE／INSERT／DELETE：把 $$ 區段拿掉再找
  const outside = text.replace(/\$\$[\s\S]*?\$\$/g, "").replace(/--[^\n]*/g, "");
  assert(!/\b(UPDATE|DELETE FROM)\s+(politician_elections|politicians|cec_candidates)\b/i.test(outside), "migration 最上層不能直接改正式資料");
  assert(!/INSERT INTO\s+(politician_elections|politicians|edit_history)\b/i.test(outside));
  await db.close();
});

// ── 9：還原驗證（拿掉守門要紅） ─────────────────────────────────
async function redWhen(label: string, from: string, to: string, check: (db: PGlite) => Promise<void>): Promise<void> {
  // 先確認要改的字串剛好出現一次（改不到就是測試本身壞了，不能算「紅」）
  mutate(await readMig(MIG), from, to);
  // 對照組：沒改壞的原版，同一個檢查要是綠的（不然「紅」可能只是檢查本身壞了）
  const control = await build();
  try { await check(control.db); } finally { await control.db.close(); }
  let red = false;
  try {
    const { db } = await build((sql) => mutate(sql, from, to));
    try { await check(db); } finally { await db.close(); }
  } catch (_e) {
    red = true;
  }
  assert(red, `拿掉守門（${label}）後測試應該紅，結果還是綠——這個守門沒有被測試守住`);
}
const checkNothingWrittenEarly = async (db: PGlite) => {
  await clock(db, "2022-11-26"); // 投票日當天
  const p = await rows(db, `SELECT 1 FROM cec_results_auto_plan()`);
  assertEquals(p.length, 0, "投票日當天計畫要是空的");
  const c = await rows<{ complete: boolean }>(db, `SELECT complete FROM cec_unit_status WHERE election_type = '縣市長' AND region = '台北市'`);
  assertEquals(c[0].complete, false, "投票日當天單位不算開完");
};
const checkIncompleteNotWritten = async (db: PGlite) => {
  const o = await observe(db);
  for (const id of [3, 4, 15, 16, 17, 18]) assert(!o.writeResult.includes(id), `pe${id} 的選區沒開完，不能寫`);
  assertEquals(o.writeResult, EXPECT_BEFORE.writeResult);
};

const NL = (line: string) => `${line}\n`;
const SCOPE_DATE = ["       AND e.election_date < activity_today()", "       AND NOT politician_name_is_placeholder(p.name)"].join("\n");
const VIEW_DATE = " AND e.election_date < activity_today()) AS complete";

Deno.test("還原驗證：拿掉『投票日已過』（單位開完 cec_unit_status.complete）→ 投票日當天單位算開完 → 要紅", async () => {
  await redWhen("單位開完的投票日檢查", VIEW_DATE, ") AS complete", checkNothingWrittenEarly);
});
Deno.test("還原驗證：快取重算前、計畫範圍、單位開完三處的投票日檢查都拿掉 → 投票日當天會寫 → 要紅（三處互為備援，單拿掉一處計畫仍然是空的，所以各自只測得到自己那一層）", async () => {
  // 三處互為備援：快取重算前的「有投票日已過的名單才算」、計畫範圍、單位開完
  const GUARD = "JOIN elections e ON e.id = c.election_id WHERE e.election_date < activity_today()) THEN";
  const both = (s: string) => mutate(mutate(mutate(s, VIEW_DATE, ") AS complete"), SCOPE_DATE, "       AND NOT politician_name_is_placeholder(p.name)"), GUARD, "JOIN elections e ON e.id = c.election_id WHERE true) THEN");
  mutate(await readMig(MIG), VIEW_DATE, ") AS complete"); // 兩處字串都要剛好出現一次
  let red = false;
  try {
    const { db } = await build(both);
    try {
      await clock(db, "2022-11-26");
      assertEquals((await rows(db, `SELECT 1 FROM cec_results_auto_plan() WHERE write_result`)).length, 0, "投票日當天不能有寫得了的");
    } finally { await db.close(); }
  } catch (_e) { red = true; }
  assert(red, "兩處投票日檢查都拿掉以後測試應該紅");
});
Deno.test("還原驗證：拿掉『當選數＝應選席次』→ 開票途中、超過席次的選區會被寫 → 要紅", async () => {
  await redWhen("當選數＝席次", " AND u.cec_elected = d.seats", "", checkIncompleteNotWritten);
});
Deno.test("還原驗證：拿掉『沒有當選與否空白』→ 有空白的選區會被寫 → 要紅", async () => {
  await redWhen("沒有空白", "u.cec_unknown = 0 AND ", "", checkIncompleteNotWritten);
});
Deno.test("還原驗證：拿掉『同一位只被我們一筆對到』→ 重複的人會被寫成兩位當選 → 要紅", async () => {
  await redWhen("same_target_n",
    "AND j.c_elected IS NOT NULL AND COALESCE(j.unit_complete, false) AND j.same_target_n = 1) AS w_result",
    "AND j.c_elected IS NOT NULL AND COALESCE(j.unit_complete, false)) AS w_result",
    async (db) => assertEquals((await observe(db)).writeResult, EXPECT_BEFORE.writeResult));
});
Deno.test("還原驗證：拿掉系統票的 unit_open → 沒開完的選區會被當 match → 要紅", async () => {
  await redWhen("unit_open", NL("              WHEN NOT (COALESCE(us.complete, false) OR cec_results_settled(m.election_id)) THEN 'unit_open'"), "", async (db) => {
    const cid = await addResults(db, "新北市", [[3, "not_elected"], [4, "not_elected"]]);
    assertEquals(await statuses(db, cid), ["3:unit_open", "4:unit_open"]);
  });
});
Deno.test("還原驗證：拿掉派工臂對系統寫入的排除 → 寫得了的又被派給代理 → 要紅", async () => {
  await redWhen("結果臂排除", NL("       AND m.politician_election_id NOT IN (SELECT a.politician_election_id FROM auto a WHERE a.write_result)"), "",
    async (db) => assertObservation(await observe(db), "改壞後"));
  await redWhen("政黨臂排除", NL("       AND pe.id NOT IN (SELECT a.politician_election_id FROM cec_results_auto_plan() a WHERE a.write_party)"), "", async (db) => {
    const t = (await rows<{ task_id: string }>(db, `SELECT task_id FROM contribution_auto_tasks_party_gap()`)).map((r) => r.task_id);
    assert(!t.includes("auto:candidacy_source_missing:party:1"));
  });
});

// ── 快取：有新同步才重算 ─────────────────────────────────────────
const refreshed = async (db: PGlite) => (await rows<{ r: boolean }>(db, `SELECT cec_results_auto_refresh() AS r`))[0].r;
const stateRow = async (db: PGlite) => (await rows<{ computed_at: string; rows_count: number; recomputed: boolean }>(db, `SELECT computed_at::text, rows_count, recomputed FROM cec_results_auto_state WHERE id = 1`))[0];

const checkResyncRecomputes = async (db: PGlite) => {
  assertEquals(await refreshed(db), false, "沒有新同步：沿用上次的結果");
  await db.exec(`INSERT INTO cec_candidates (election_id, election_type, region, name, name_norm, elected, party) VALUES (2022, '縣市長', '新增縣', '新丁', cec_name_key('新丁'), false, '甲黨')`);
  assertEquals(await refreshed(db), true, "有新同步（synced_at 變新）才重算");
};

Deno.test("快取：沒有新同步沿用上次（不重算）；有新同步、日期換了、開關變了才重算", async () => {
  const { db } = await build();
  const first = await stateRow(db);
  assertEquals(first.recomputed, true);
  assert(first.rows_count > 0);
  assertEquals(await refreshed(db), false);
  assertEquals(await refreshed(db), false);
  assertEquals((await stateRow(db)).computed_at, first.computed_at, "沒重算：computed_at 不動");
  // 計畫函式只讀快取：寫完以後馬上變空，不用重算
  await db.exec(`SELECT cec_results_auto_apply()`);
  assertEquals((await rows(db, `SELECT 1 FROM cec_results_auto_plan() WHERE write_result OR write_party`)).length, 0);
  assertEquals((await rows(db, `SELECT 1 FROM cec_results_auto_plan() WHERE mismatch`)).length, 2, "不一致的還在，仍然不重算");
  assertEquals((await stateRow(db)).computed_at, first.computed_at);
  await checkResyncRecomputes(db);
  assertEquals(await refreshed(db), false, "重算完又是沿用");
  await clock(db, "2022-11-28"); // 日期換了
  assertEquals((await stateRow(db)).recomputed, true);
  assertEquals(await refreshed(db), false);
  await db.exec(`UPDATE cec_results_auto_settings SET enabled = false WHERE id = 1`);
  assertEquals(await refreshed(db), false, "開關不在鍵裡：重算本體不看開關，切換開關不用重算（計畫函式讀的時候才看）");
  await db.exec(`UPDATE cec_results_auto_settings SET enabled = true WHERE id = 1`);
  await db.exec(`UPDATE election_districts SET seats = 2 WHERE election_type = '縣市長' AND region = '新北市'`);
  assertEquals(await refreshed(db), true, "應選名額變了（代理補登／更正）要重算：不然要等到隔天才寫");
  assertEquals(await refreshed(db), false);
  await db.close();
});

Deno.test("快取：所有名單的投票日都還沒到（2026 投票前）：只記鍵、清空快取、完全不叫重算本體", async () => {
  const { db } = await build();
  await db.exec(`DELETE FROM cec_candidates WHERE election_id = 2022`); // 只剩 2026 的名單
  await clock(db, "2026-10-19");
  const st = await stateRow(db);
  assertEquals([st.recomputed, st.rows_count], [false, 0], "沒有投票日已過又有名單的單位：不重算");
  assertEquals((await rows(db, `SELECT 1 FROM cec_results_auto_plan_rows`)).length, 0);
  assertEquals((await rows(db, `SELECT 1 FROM cec_results_auto_plan()`)).length, 0);
  assertEquals((await rows<{ r: Record<string, unknown> }>(db, `SELECT cec_results_auto_apply() AS r`))[0].r.results_written, 0);
  // 投票日過了、名單進來才算
  await clock(db, "2026-11-29");
  assertEquals((await stateRow(db)).recomputed, true);
  assertEquals((await ids(db, `SELECT politician_election_id AS id FROM cec_results_auto_plan() WHERE write_result`)), [23, 24]);
  await db.close();
});

Deno.test("還原驗證：鍵拿掉『最新同步時間』→ 有新同步也不重算 → 要紅", async () => {
  await redWhen("鍵裡的同步時間", "COALESCE((SELECT max(c.synced_at)::TEXT FROM cec_candidates c), '') || '|' || ", "", checkResyncRecomputes);
});
Deno.test("還原驗證：重算前不先看鍵 → 沒有新同步也重算 → 要紅", async () => {
  await redWhen("先看鍵", "IF NOT p_force AND EXISTS (SELECT 1 FROM cec_results_auto_state s WHERE s.id = 1 AND s.state_key = v_key) THEN", "IF FALSE THEN", async (db) => {
    assertEquals(await refreshed(db), false, "沒有新同步：沿用上次的結果");
  });
});

const checkSeatsChangeRecomputes = async (db: PGlite) => {
  await db.exec(`UPDATE election_districts SET seats = 2 WHERE election_type = '縣市長' AND region = '新北市'`);
  assertEquals(await refreshed(db), true);
};
Deno.test("還原驗證：鍵拿掉『應選名額』→ 名額變了不重算 → 要紅", async () => {
  await redWhen("鍵裡的名額", SEAT_LINE, "", checkSeatsChangeRecomputes);
});

Deno.test("上線預設關：部署後先預熱快取、乾跑看得到數字（含按屆別×職位的分布）、排程與寫入都不動；小批試寫後才全開", async () => {
  const b = await build();
  assertEquals(b.defaultEnabled, false, "settings 預設 enabled＝false");
  const db = b.db;
  await db.exec(`UPDATE cec_results_auto_settings SET enabled = false WHERE id = 1`);
  assertEquals((await rows(db, `SELECT 1 FROM cec_results_auto_plan()`)).length, 0, "關著：派工臂看到的計畫是空的，照舊派給代理");
  assertEquals((await rows<{ r: Record<string, unknown> }>(db, `SELECT cec_results_auto_apply() AS r`))[0].r.skipped, "disabled");
  assertEquals((await rows(db, `SELECT 1 FROM cec_auto_apply_runs`)).length, 0);
  assertEquals((await rows(db, `SELECT 1 FROM politician_elections WHERE candidacy_status IN ('elected','not_elected') AND id IN (1,2)`)).length, 0);
  const dry = (await rows<{ r: { dry_run: boolean; would_write_results: number; would_write_parties: number; mismatches: number; by_unit: Array<{ election_id: number; election_type: string; results: number }> } }>(db, `SELECT cec_results_auto_apply(NULL, true) AS r`))[0].r;
  assertEquals([dry.dry_run, dry.would_write_results, dry.would_write_parties, dry.mismatches], [true, 10, 10, 2], "乾跑關著也能跑，數字＝打開後會寫的");
  assertEquals(dry.by_unit.reduce((n, u) => n + Number(u.results), 0), 10);
  assert(dry.by_unit.some((u) => u.election_type === "村里長" && Number(u.results) === 4));
  assertEquals((await rows<{ c: number }>(db, `SELECT pending_results AS c FROM cec_results_auto_status`))[0].c, 10, "狀態視圖關著也看得到若打開會寫多少");
  await db.exec(`UPDATE cec_results_auto_settings SET batch_limit = 3, enabled = true WHERE id = 1`);
  const small = (await rows<{ r: { results_written: number } }>(db, `SELECT cec_results_auto_apply() AS r`))[0].r;
  assertEquals(small.results_written, 3, "batch_limit 先調 100（測試用 3）小批試寫");
  await db.close();
});

Deno.test("臺／台：我們寫臺、中選會與名額表寫台，鄉鎮與村里照樣對上、單位算開完、系統寫入", async () => {
  const { db } = await build();
  await checkTaiwanChar(db);
  await db.close();
});
const checkTaiwanChar = async (db: PGlite) => {
  assertEquals((await ids(db, `SELECT politician_election_id AS id FROM cec_results_auto_plan() WHERE write_result AND politician_election_id IN (26, 27, 28, 29)`)), [26, 27, 28, 29]);
};
Deno.test("還原驗證：拿掉臺→台的正規化（單位鍵、比對的鄉鎮／村里）→ 對不上 → 要紅", async () => {
  await redWhen("單位鍵的鄉鎮村里", KEY_REPL, KEY_PLAIN, checkTaiwanChar);
  await redWhen("比對的鄉鎮", TOWN_REPL, TOWN_PLAIN, checkTaiwanChar);
  await redWhen("比對的村里", VIL_REPL, VIL_PLAIN, checkTaiwanChar);
});

const SEAT_LINE = "      || (SELECT count(*)::TEXT || ':' || COALESCE(sum(d.seats), 0)::TEXT FROM election_districts d) || '|'";
const KEY_REPL = "|| replace(COALESCE(p_sub_region, ''), '臺', '台') || '|' || replace(COALESCE(p_village, ''), '臺', '台')";
const KEY_PLAIN = "|| COALESCE(p_sub_region, '') || '|' || COALESCE(p_village, '')";
const TOWN_REPL = "THEN NULLIF(replace(regexp_replace(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.sub_region END, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '')";
const TOWN_PLAIN = "THEN NULLIF(regexp_replace(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.sub_region END, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '')";
const VIL_REPL = "THEN NULLIF(replace(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.village END, p.village, ''), '臺', '台'), '')";
const VIL_PLAIN = "THEN NULLIF(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.village END, p.village, ''), '')";

// ── TS 端 ────────────────────────────────────────────────────
Deno.test("RESULT_SETTLE_DAYS 與 SQL 的 cec_results_settle_days() 一致；cecResultsSettled 與 SQL cec_results_settled 逐日對得上", async () => {
  const { db } = await build();
  assertEquals((await rows<{ n: number }>(db, `SELECT cec_results_settle_days() AS n`))[0].n, RESULT_SETTLE_DAYS);
  for (const day of ["2022-11-25", "2022-11-26", "2022-11-27", "2022-11-28", "2022-11-29", "2022-11-30", "2023-01-01"]) {
    await clock(db, day);
    const sql = (await rows<{ s: boolean }>(db, `SELECT cec_results_settled(2022) AS s`))[0].s;
    const now = new Date(`${day}T04:00:00Z`); // 台北當天中午
    assertEquals(cecResultsSettled("2022-11-26", now), sql, `台北 ${day}`);
  }
  await db.close();
});

Deno.test("cecResultsSettled／withoutUnsettledResults：台北日界、投票日 + 3 天才底定；格式不對一律沒底定", () => {
  // 台北 2022-11-29 00:00 ＝ UTC 11-28 16:00
  assertEquals(cecResultsSettled("2022-11-26", new Date("2022-11-28T15:59:59Z")), false);
  assertEquals(cecResultsSettled("2022-11-26", new Date("2022-11-28T16:00:00Z")), true);
  assertEquals(cecResultsSettled("2022-11-26", new Date("2022-11-26T20:00:00Z")), false, "投票夜（台北 11-27 凌晨）還沒");
  assertEquals(cecResultsSettled(null), false);
  assertEquals(cecResultsSettled("不是日期"), false);
  assertEquals(taipeiDate(new Date("2022-11-26T16:30:00Z")), "2022-11-27", "UTC 16:00 以後台北已經是隔天");
  const list = normalizeCandidacies([
    { theme_id: "t", vote_date: "2022-11-26", cand_id: 1, cand_name: "甲", is_victor: "*" },
    { theme_id: "t", vote_date: "2022-11-26", cand_id: 2, cand_name: "乙" },
  ]);
  const mid = withoutUnsettledResults(list, new Date("2022-11-27T04:00:00Z"));
  assertEquals(mid.map((c) => c.election_result), [null, null], "開票後一天：沒標＝落選不能採用，連當選也先不採用（一律未知）");
  const done = withoutUnsettledResults(list, new Date("2022-11-29T04:00:00Z"));
  assertEquals(done.map((c) => c.election_result), ["elected", "not_elected"]);
  // 舊的 withoutFutureResults 在這一刻會把「沒標」當落選（UTC 日期：投票日當天不算未來）——正是這次要擋的洞
  assertEquals(withoutFutureResults(list, "2022-11-26").map((c) => c.election_result), ["elected", "not_elected"]);
});

Deno.test("cec-verify：開票後三天內不採用中選會的落選（skip），底定後照常上線／退件；三個呼叫端都換了", async () => {
  const raw = [{ theme_id: "t", vote_date: "2022-11-26", cand_id: 2, cand_name: "乙乙", party_name: "甲黨", area_data: { current_area: { area_name: "台北市" } } }];
  const claim = { contribution_type: "candidacy", payload: { name: "乙乙", election_id: 2022, election_result: "not_elected" }, politician: { name: "乙乙", region: "台北市" } };
  const elections = [{ id: 2022, election_date: "2022-11-26" }];
  const mid = decideByCec(claim, withoutUnsettledResults(normalizeCandidacies(raw, elections), new Date("2022-11-27T04:00:00Z")));
  assertEquals(mid.action, "skip");
  const done = decideByCec(claim, withoutUnsettledResults(normalizeCandidacies(raw, elections), new Date("2022-11-29T04:00:00Z")));
  assertEquals(done.action, "apply");
  for (const f of ["../cec-verify/index.ts", "../fetch-cec-data/index.ts", "./cec-check.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    assertStringIncludes(src, "withoutUnsettledResults(");
    assert(!src.includes("withoutFutureResults("), `${f} 不能再用只擋未來的版本`);
  }
});
