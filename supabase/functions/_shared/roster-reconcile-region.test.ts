/**
 * 名冊對帳「補地區」動作（#731，migration 20261021050000_roster_reconcile_region.sql）。
 *
 * 三層：
 *   * resolveCandidacyRegion（apply-contribution.ts，跟 applyCandidacy 同一套找法、只讀不建）：記憶體假 supabase，對 regions 的各層級與對不到的原因；
 *   * runRosterReconcile 的補地區那一段（roster-reconcile.ts）：actions 沒有 region 不做、對得到的呼叫 roster_reconcile_set_region、對不到的記 unresolved 與原因；
 *   * 資料庫（PGlite 跑真的 migration）：挑人（both、region 空、沒處理過）、只補空白、edit_history、還原與還原保護、settings 多收 region 但預設不變。
 * 最後一支是還原驗證：把 migration 改壞，指定的情境必須轉紅。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createFakeSupabase } from "./test-fake-supabase.ts";
import { resolveCandidacyRegion } from "./apply-contribution.ts";
import { mutate, readMig } from "./arms-pglite.ts";
import { type RegionCandidate, runRosterReconcile } from "./roster-reconcile.ts";
import { addOurs, buildReconcileDb, loadRegs, section } from "./roster-reconcile-pglite.ts";

const AGENT = "system:roster-reconcile";
const URL_ = "https://web.cec.gov.tw/api/file/x.pdf";
const REGION_MIG = "20261021050000_roster_reconcile_region.sql";

// ── 1. resolveCandidacyRegion ─────────────────────────────────────────────────
const REGIONS = [
  { id: 1, region: "台中市", sub_region: null, village: null },
  { id: 2, region: "台中市", sub_region: "大安區", village: null },
  { id: 3, region: "台中市", sub_region: "大安區", village: "龜壳里" },
  { id: 4, region: "台北市", sub_region: null, village: null },
  { id: 5, region: "台北市", sub_region: "第02選舉區", village: null },
  { id: 6, region: "新北市", sub_region: "板橋區", village: null },
  { id: 7, region: "新北市", sub_region: "板橋區第02選舉區", village: null },
];
const fakeRegions = () => createFakeSupabase({ regions: REGIONS.map((r) => ({ ...r })) });
const P = (over: Record<string, unknown>) => ({ election_id: 2026, ...over });

Deno.test("G1 對 regions：村里、鄉鎮、議員選舉區、代表選舉區、縣市長各對到自己那一層", async () => {
  const { client } = fakeRegions();
  assertEquals(await resolveCandidacyRegion(client, "村里長", P({ region: "台中市", sub_region: "大安區", village: "龜壳里" })), { ok: true, region_id: 3, level: "village" });
  assertEquals(await resolveCandidacyRegion(client, "鄉鎮市長", P({ region: "台中市", sub_region: "大安區" })), { ok: true, region_id: 2, level: "town" });
  assertEquals(await resolveCandidacyRegion(client, "縣市議員", P({ region: "台北市", electoral_district: "第02選舉區" })), { ok: true, region_id: 5, level: "district" });
  assertEquals(await resolveCandidacyRegion(client, "鄉鎮市民代表", P({ region: "新北市", sub_region: "板橋區", electoral_district: "第02選舉區" })), { ok: true, region_id: 7, level: "district" });
  assertEquals(await resolveCandidacyRegion(client, "縣市長", P({ region: "台中市" })), { ok: true, region_id: 1, level: "county" });
});

Deno.test("G2 對不到唯一一列：講出原因、不新建 regions、不退回上一層", async () => {
  const { client, db } = fakeRegions();
  const reason = async (type: string, p: Record<string, unknown>) => {
    const r = await resolveCandidacyRegion(client, type, P(p));
    assert(!r.ok, `${type} 應該對不到`);
    return r.ok ? "" : r.reason;
  };
  assertEquals(await reason("村里長", { region: "台中市", sub_region: "大安區" }), "village_empty", "名冊村里欄空白（village_empty 旗標）");
  assertEquals(await reason("村里長", { region: "台中市", sub_region: "大安區", village: "不存在里" }), "village_row_missing", "不退回鄉鎮那一列");
  assertEquals(await reason("鄉鎮市長", { region: "台中市", sub_region: "不存在區" }), "town_row_missing");
  assertEquals(await reason("鄉鎮市長", { region: "台中市" }), "no_town");
  assertEquals(await reason("縣市議員", { region: "台北市", electoral_district: "第09選舉區" }), "district_row_missing", "有縣市列也不退回縣市（會把缺口藏起來）");
  assertEquals(await reason("鄉鎮市民代表", { region: "新北市", sub_region: "板橋區", electoral_district: "第09選舉區" }), "district_row_missing", "有鄉鎮列也不退回鄉鎮");
  assertEquals(await reason("縣市長", { region: "火星市" }), "county_row_missing");
  assertEquals(db.regions.length, REGIONS.length, "只讀不建：applyCandidacy 會新建的情境（選舉區有官方根據）這裡一列都不建");
});

// ── 2. runRosterReconcile 的補地區段 ─────────────────────────────────────────────
const rc = (over: Partial<RegionCandidate> = {}): RegionCandidate => ({
  reg_id: 11, pe_id: 501, politician_id: "pid-1", election_id: 2026, election_type: "鄉鎮市長", county: "台中市", sub_region: "大安區", village: null, district: null,
  name: "甲", source_url: URL_, row_no: 4, ...over,
});

function regionRunnerDb(opts: { actions?: string[]; rows: RegionCandidate[]; setRegion?: (args: Record<string, unknown>) => boolean }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const regionLogs: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table === "roster_reconcile_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { enabled: true, batch_limit: 100, agent_name: AGENT, actions: opts.actions ?? ["new"] }, error: null }) }) }) };
      }
      if (table === "roster_reconcile_region_log") return { insert: (e: Record<string, unknown>) => { regionLogs.push(e); return Promise.resolve({ error: null }); } };
      throw new Error(`補地區不該碰 ${table}`);
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      if (name === "roster_reconcile_lock") return Promise.resolve({ data: true, error: null });
      if (name === "roster_reconcile_region_next") return Promise.resolve({ data: opts.rows, error: null });
      if (name === "roster_reconcile_set_region") return Promise.resolve({ data: opts.setRegion ? opts.setRegion(args) : true, error: null });
      return Promise.resolve({ data: [], error: null });
    },
  };
  return { client, calls, regionLogs };
}
const resolverBy = (map: Record<string, { ok: true; region_id: number; level: "town" } | { ok: false; reason: string; message: string }>) =>
  (_s: unknown, _t: string, p: Record<string, unknown>) => Promise.resolve(map[String(p.name)] as never);

Deno.test("G3 settings.actions 沒有 region 就不做補地區（預設 {new}）：不挑人、不寫", async () => {
  for (const actions of [undefined, ["new"], ["new", "attach"]]) {
    const { client, calls, regionLogs } = regionRunnerDb({ actions, rows: [rc()] });
    const s = await runRosterReconcile(client, { resolveRegion: resolverBy({ "甲": { ok: true, region_id: 2, level: "town" } }) });
    assert(!calls.some((c) => c.name === "roster_reconcile_region_next" || c.name === "roster_reconcile_set_region"), JSON.stringify(actions));
    assertEquals([s.region.picked, s.region.applied, regionLogs.length], [0, 0, 0]);
  }
});

Deno.test("G4 有 region：對得到的呼叫 set_region（帶來源、層級、system 代號）；對不到的記 unresolved 與原因、不呼叫寫入；resolver 丟例外記 error 不中斷", async () => {
  const { client, calls, regionLogs } = regionRunnerDb({ actions: ["region"], rows: [rc({ reg_id: 1, name: "甲" }), rc({ reg_id: 2, name: "乙", pe_id: 502 }), rc({ reg_id: 3, name: "丙", pe_id: 503 }), rc({ reg_id: 4, name: "丁", pe_id: 504 })] });
  const s = await runRosterReconcile(client, {
    runId: "run-9",
    resolveRegion: (_s, _t, p) => {
      if (p.name === "丙") return Promise.reject(new Error("boom"));
      return Promise.resolve(p.name === "甲" || p.name === "丁"
        ? { ok: true as const, region_id: 2, level: "town" as const }
        : { ok: false as const, reason: "village_empty" as const, message: "名冊這一列的村里欄是空的" });
    },
  });
  assertEquals([s.region.picked, s.region.applied, s.region.unresolved, s.region.errors], [4, 2, 1, 1]);
  const sets = calls.filter((c) => c.name === "roster_reconcile_set_region").map((c) => c.args);
  assertEquals(sets.map((a) => [a.p_reg_id, a.p_pe_id, a.p_region_id, a.p_run, a.p_agent, a.p_source_url, a.p_row_no, a.p_level]), [
    [1, 501, 2, "run-9", AGENT, URL_, 4, "town"], [4, 504, 2, "run-9", AGENT, URL_, 4, "town"],
  ]);
  assertEquals(regionLogs.map((l) => [l.reg_id, l.outcome, l.reason, l.politician_election_id, l.agent_name]), [
    [2, "unresolved", "village_empty", 502, AGENT], [3, "error", "exception", 503, AGENT],
  ]);
  assertStringIncludes(String(regionLogs[0].message), "村里欄");
});

Deno.test("G5 挑出來之後那筆已經有地區（set_region 回 false）記為對不到、不算寫入；補地區也尊重時間預算", async () => {
  const a = regionRunnerDb({ actions: ["region"], rows: [rc()], setRegion: () => false });
  const s = await runRosterReconcile(a.client, { resolveRegion: resolverBy({ "甲": { ok: true, region_id: 2, level: "town" } }) });
  assertEquals([s.region.applied, s.region.unresolved], [0, 1]);
  let t = 0;
  const b = regionRunnerDb({ actions: ["region"], rows: [rc({ reg_id: 1 }), rc({ reg_id: 2 }), rc({ reg_id: 3 })] });
  const s2 = await runRosterReconcile(b.client, { resolveRegion: resolverBy({ "甲": { ok: true, region_id: 2, level: "town" } }), now: () => (t += 40), budgetMs: 100 });
  assert(s2.stopped_by_budget && s2.region.applied < 3, JSON.stringify(s2.region));
});

// ── 3. 資料庫（PGlite 跑真的 migration）─────────────────────────────────────────
type Db = Awaited<ReturnType<typeof buildReconcileDb>>["db"];
const stripGrants = (sql: string) => sql.replace(/^(REVOKE|GRANT)\b[^;]*;\s*$/gm, "");

async function regionDb(edit: (m: string) => string = (s) => s): Promise<{ db: Db; reg: Record<string, string>; pe: Record<string, number> }> {
  const { db } = await buildReconcileDb();
  const mig = edit(await readMig(REGION_MIG));
  for (const s of ["tables", "run"]) await db.exec(stripGrants(section(mig, s)));
  await loadRegs(db, [
    { type: "縣市議員", region: "台北市", name: "甲一", district: "第01選舉區" },
    { type: "縣市議員", region: "台北市", name: "乙二", district: "第01選舉區" },
    { type: "縣市議員", region: "台北市", name: "丙三", district: "第01選舉區" },
    { type: "縣市議員", region: "花蓮縣", name: "新四" },   // 我們沒有 → missing_creatable，不是 both
    { type: "縣市議員", region: "台北市", name: "丁五", district: "第01選舉區" },
  ]);
  const pe: Record<string, number> = {};
  for (const name of ["甲一", "乙二", "丙三", "丁五"]) pe[name] = (await addOurs(db, { name, type: "縣市議員", status: "filed", region: "台北市", sub: "第01選舉區" })).peId;
  await db.exec(`UPDATE politician_elections SET region_id = NULL WHERE id IN (${pe["甲一"]}, ${pe["乙二"]}, ${pe["丙三"]})`);   // 丁五 已有地區
  const reg: Record<string, string> = {};
  for (const r of (await db.query<{ name: string; id: string }>(`SELECT name, id::text FROM cec_registrations`)).rows) reg[r.name] = r.id;
  return { db, reg, pe };
}
const setRegion = (db: Db, regId: string, peId: number, regionId: number, run: string, agent = AGENT) =>
  db.query<{ ok: boolean }>(`SELECT roster_reconcile_set_region($1::bigint, $2, $3, $4::uuid, $5, 'https://example.test/x.pdf', 3, 'district') AS ok`, [regId, peId, regionId, run, agent]);
const regionOf = async (db: Db, peId: number) => (await db.query<{ region_id: number | null }>(`SELECT region_id FROM politician_elections WHERE id = $1`, [peId])).rows[0].region_id;
const revert = async (db: Db, run: string) => (await db.query<{ r: Record<string, number> }>(`SELECT roster_reconcile_revert($1::uuid, NULL, 'test') AS r`, [run])).rows[0].r;

Deno.test("G6 挑人：category＝both 且我們那筆 region_id 為空；已有地區的、我們沒有的、處理過的都不挑", async () => {
  const { db, reg } = await regionDb();
  const names = async () => (await db.query<{ name: string }>(`SELECT name FROM roster_reconcile_region_next(500) ORDER BY name`)).rows.map((r) => r.name);
  assertEquals(await names(), ["丙三", "乙二", "甲一"]);
  const { rows: [row] } = await db.query<Record<string, unknown>>(`SELECT * FROM roster_reconcile_region_next(500) WHERE name = '甲一'`);
  assertEquals([row.election_type, row.county, row.district, row.source_url !== null, row.politician_id !== null], ["縣市議員", "台北市", "第01選舉區", true, true]);
  assertEquals((await db.query(`SELECT 1 FROM roster_reconcile_region_next(2)`)).rows.length, 2, "p_limit 有效");
  await setRegion(db, reg["甲一"], (await db.query<{ id: number }>(`SELECT pe_id AS id FROM roster_reconcile WHERE name = '甲一'`)).rows[0].id, 1, crypto.randomUUID());
  assertEquals(await names(), ["丙三", "乙二"], "寫過的不再挑（也沒有地區了所以本來就不會挑）");
  // 對不到而記了 unresolved 的也不再挑（不重試）
  await db.query(`INSERT INTO roster_reconcile_region_log (reg_id, run_id, outcome, reason, source_url, row_no, politician_election_id, agent_name) VALUES ($1, gen_random_uuid(), 'unresolved', 'district_row_missing', 'u', 1, 1, $2)`, [reg["乙二"], AGENT]);
  assertEquals(await names(), ["丙三"]);
  await db.close();
});

Deno.test("G7 只補空白：寫 region_id、同交易記 edit_history（system 代號、contribution_id 空、舊值空）與 log；已有地區的不覆蓋、記 unresolved；agent_name 必須 system:", async () => {
  const { db, reg, pe } = await regionDb();
  const run = crypto.randomUUID();
  assertEquals((await setRegion(db, reg["甲一"], pe["甲一"], 999, run)).rows[0].ok, true);
  assertEquals(await regionOf(db, pe["甲一"]), 999);
  const { rows: eh } = await db.query<Record<string, unknown>>(`SELECT * FROM edit_history WHERE table_name = 'politician_elections' AND record_id = $1`, [String(pe["甲一"])]);
  assertEquals(eh.length, 1);
  assertEquals([eh[0].field, eh[0].old_value, eh[0].new_value, eh[0].contribution_id, eh[0].agent_name], ["region_id", null, 999, null, AGENT]);
  const { rows: [lg] } = await db.query<Record<string, unknown>>(`SELECT * FROM roster_reconcile_region_log WHERE reg_id = $1`, [reg["甲一"]]);
  assertEquals([lg.outcome, lg.region_id, lg.level, lg.politician_election_id, lg.agent_name, lg.row_no], ["applied", 999, "district", pe["甲一"], AGENT, 3]);
  // 丁五本來就有地區：不覆蓋、log 記 unresolved
  const before = await regionOf(db, pe["丁五"]);
  assertEquals((await setRegion(db, reg["丁五"], pe["丁五"], 888, run)).rows[0].ok, false);
  assertEquals(await regionOf(db, pe["丁五"]), before, "不覆蓋");
  const { rows: [lg2] } = await db.query<Record<string, unknown>>(`SELECT outcome, reason FROM roster_reconcile_region_log WHERE reg_id = $1`, [reg["丁五"]]);
  assertEquals([lg2.outcome, lg2.reason], ["unresolved", "region_already_set"]);
  assertEquals((await db.query(`SELECT 1 FROM edit_history WHERE record_id = $1 AND field = 'region_id'`, [String(pe["丁五"])])).rows.length, 0, "沒寫就沒有履歷");
  // 同一位登記者只處理一次；非 system 代號擋掉且整筆回滾
  let dup = false;
  try { await setRegion(db, reg["甲一"], pe["甲一"], 1, run); } catch { dup = true; }
  assert(dup, "region log 的 reg_id 要唯一");
  let notSystem = false;
  try { await setRegion(db, reg["乙二"], pe["乙二"], 5, run, "maintainer"); } catch { notSystem = true; }
  assert(notSystem && (await regionOf(db, pe["乙二"])) === null, "冒用代理名字寫履歷要擋");
  await db.close();
});

Deno.test("G8 還原：整輪或逐筆把 region_id 改回 NULL、履歷與 log 標已還原、不再被挑；沒範圍要報錯；冪等", async () => {
  const { db, reg, pe } = await regionDb();
  const run = crypto.randomUUID();
  await setRegion(db, reg["甲一"], pe["甲一"], 999, run);
  await setRegion(db, reg["乙二"], pe["乙二"], 999, run);
  const res = await revert(db, run);
  assertEquals([res.regions_reverted, res.regions_skipped_touched, res.politician_elections_deleted], [2, 0, 0], "只還原地區、不刪參選紀錄");
  assertEquals([await regionOf(db, pe["甲一"]), await regionOf(db, pe["乙二"])], [null, null]);
  assertEquals((await db.query(`SELECT 1 FROM edit_history WHERE field = 'region_id' AND reverted_at IS NULL`)).rows.length, 0);
  assertEquals((await db.query(`SELECT 1 FROM roster_reconcile_region_log WHERE reverted_at IS NOT NULL`)).rows.length, 2);
  assert(!(await db.query<{ name: string }>(`SELECT name FROM roster_reconcile_region_next(500)`)).rows.some((r) => r.name === "甲一"), "還原過的不再被系統補（尊重還原）");
  assertEquals((await revert(db, run)).regions_reverted, 0, "再還原一次沒東西");
  // 逐筆
  const run2 = crypto.randomUUID();
  await setRegion(db, reg["丙三"], pe["丙三"], 777, run2);
  const r2 = (await db.query<{ r: Record<string, number> }>(`SELECT roster_reconcile_revert(NULL, ARRAY[$1::bigint], 'test') AS r`, [reg["丙三"]])).rows[0].r;
  assertEquals(r2.regions_reverted, 1);
  assertEquals(await regionOf(db, pe["丙三"]), null);
  let threw = false;
  try { await db.query(`SELECT roster_reconcile_revert()`); } catch { threw = true; }
  assert(threw);
  await db.close();
});

Deno.test("G9 還原保護：之後有別人動過 region_id（履歷有別的代號、或現值已經不是它寫的）就不還原，回報 regions_skipped_touched", async () => {
  const { db, reg, pe } = await regionDb();
  const run = crypto.randomUUID();
  await setRegion(db, reg["甲一"], pe["甲一"], 999, run);
  await setRegion(db, reg["乙二"], pe["乙二"], 999, run);
  await setRegion(db, reg["丙三"], pe["丙三"], 999, run);
  // 甲一：別的代理之後又把 region_id 設成同一個值（履歷有、現值沒變）
  await db.query(`INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name) VALUES ('politician_elections', $1, 'region_id', '999', '999', 'some-agent')`, [String(pe["甲一"])]);
  // 乙二：現值被改成別的（不管履歷）
  await db.query(`UPDATE politician_elections SET region_id = 555 WHERE id = $1`, [pe["乙二"]]);
  // 丙三：別人動的是別的欄位（狀態）：不影響地區的還原
  await db.query(`INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name) VALUES ('politician_elections', $1, 'candidacy_status', '"filed"', '"declared"', 'some-agent')`, [String(pe["丙三"])]);
  const res = await revert(db, run);
  assertEquals([res.regions_reverted, res.regions_skipped_touched], [1, 2]);
  assertEquals([await regionOf(db, pe["甲一"]), await regionOf(db, pe["乙二"]), await regionOf(db, pe["丙三"])], [999, 555, null]);
  await db.close();
});

Deno.test("G10 settings：actions 多收 region，預設仍只 {new}，其他值照擋", async () => {
  const { db } = await regionDb();
  assertEquals((await db.query<{ actions: string[] }>(`SELECT actions FROM roster_reconcile_settings`)).rows[0].actions, ["new"]);
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['new', 'region']`);
  let bad = false;
  try { await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['delete']`); } catch { bad = true; }
  assert(bad);
  // 既有的 new／attach 挑人不受 region 影響
  await db.exec(`UPDATE roster_reconcile_settings SET actions = ARRAY['region']`);
  assertEquals((await db.query(`SELECT 1 FROM roster_reconcile_next(500)`)).rows.length, 0, "只開 region 不會建人物");
  await db.close();
});

// ── 還原驗證：把 migration 改壞，指定的情境必須轉紅 ────────────────────────────────
Deno.test("G11 還原驗證：把補地區的守門條件拿掉（5 種），指定的情境必須轉紅", async () => {
  const MUTATIONS: Array<{ name: string; edit: (m: string) => string; red: (db: Db, reg: Record<string, string>, pe: Record<string, number>) => Promise<boolean> }> = [
    { name: "拿掉「只補空白」（WHERE region_id IS NULL）",
      edit: (m) => mutate(m, "UPDATE politician_elections SET region_id = p_region_id WHERE id = p_pe_id AND region_id IS NULL;", "UPDATE politician_elections SET region_id = p_region_id WHERE id = p_pe_id;"),
      red: async (db, reg, pe) => { await setRegion(db, reg["丁五"], pe["丁五"], 888, crypto.randomUUID()); return (await regionOf(db, pe["丁五"])) === 888; } },
    { name: "挑人不看 region_id 為空",
      edit: (m) => mutate(m, "     AND pe.region_id IS NULL\n", ""),
      red: async (db) => (await db.query(`SELECT 1 FROM roster_reconcile_region_next(500) WHERE name = '丁五'`)).rows.length > 0 },
    { name: "挑人不排除處理過的",
      edit: (m) => mutate(m, "     AND NOT EXISTS (SELECT 1 FROM roster_reconcile_region_log l WHERE l.reg_id = r.reg_id)\n", ""),
      red: async (db, reg) => { await db.query(`INSERT INTO roster_reconcile_region_log (reg_id, run_id, outcome, reason, source_url, row_no, politician_election_id, agent_name) VALUES ($1, gen_random_uuid(), 'unresolved', 'x', 'u', 1, 1, $2)`, [reg["乙二"], AGENT]); return (await db.query(`SELECT 1 FROM roster_reconcile_region_next(500) WHERE name = '乙二'`)).rows.length > 0; } },
    { name: "還原不看之後有沒有別人改過 region_id（履歷）",
      edit: (m) => mutate(m, "                     AND h.id > v_eh AND h.reverted_at IS NULL)", "                     AND h.id > v_eh AND h.reverted_at IS NULL AND FALSE)"),
      red: async (db, reg, pe) => {
        const run = crypto.randomUUID(); await setRegion(db, reg["甲一"], pe["甲一"], 999, run);
        await db.query(`INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name) VALUES ('politician_elections', $1, 'region_id', '999', '999', 'some-agent')`, [String(pe["甲一"])]);
        return (await revert(db, run)).regions_reverted === 1;
      } },
    { name: "還原不看現值是不是它寫的",
      edit: (m) => mutate(m, "       OR NOT EXISTS (SELECT 1 FROM politician_elections x WHERE x.id = g.politician_election_id AND x.region_id = g.region_id) THEN", "       OR FALSE THEN"),
      red: async (db, reg, pe) => {
        const run = crypto.randomUUID(); await setRegion(db, reg["乙二"], pe["乙二"], 999, run);
        await db.query(`UPDATE politician_elections SET region_id = 555 WHERE id = $1`, [pe["乙二"]]);
        return (await revert(db, run)).regions_reverted === 1;
      } },
  ];
  for (const m of MUTATIONS) {
    const { db, reg, pe } = await regionDb(m.edit);
    assert(await m.red(db, reg, pe), `改壞「${m.name}」之後情境沒有轉紅——守門測試沒守到它`);
    await db.close();
  }
});
