/**
 * 拿掉 raw、mayor_policies 寫死的年份與職位（migration 20261011300000_campaign_election_arms.sql，2026-10-13 維護者「A B C」的 A）。
 *
 *   A. 文字層：兩支臂的新定義＝前一版加一串機械式替換。把替換倒回去必須一字不差回到前一版（前一版＝緊接在這支之前的定義）；
 *      新定義的程式（註解除外）不再有任何寫死的年份，mayor_policies 不再寫死「縣市長」與 5。
 *   B. PGlite：當屆（campaign_election_id）、年份文案（election_year_text、regular_election_years_text）在假日期下的行為；
 *      規則 mayor_policies 補上 params、缺參數時 migration 自己擋。
 *
 * 正式庫「今天輸出逐件不變」見 scripts/arms-parity-campaign.ts（不進 CI；PR 說明附結果）。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, migrationNames, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261011300000_campaign_election_arms.sql";
const MIG = await readMig(MIG_NAME);
type Rep = [string, string, number];
const RAW_REPS: Rep[] = [
  ["  WITH c2026 AS (\n    SELECT p.id,", "  WITH cur AS MATERIALIZED (\n    -- 當屆＝下一場還沒投票的定期選舉（都投完了就是最近投完的那一場）；由 elections 決定（campaign_election_id），不再寫死年份\n    SELECT ce.id, election_year_text(ce.id) AS year FROM (SELECT campaign_election_id() AS id) ce\n  ),\n  c_cur AS (\n    SELECT cur.id AS eid, cur.year AS eyear, p.id,", 1],
  ["    LEFT JOIN regions r ON r.id = pe.region_id\n    WHERE pe.election_id = 2026 AND pe.candidacy_status", "    LEFT JOIN regions r ON r.id = pe.region_id\n    JOIN cur ON cur.id = pe.election_id\n    WHERE pe.candidacy_status", 1],
  ["'election_id', 2026", "'election_id', c.eid", 3],
  ["' 2026 '", "' ' || c.eyear || ' '", 2],
  ["FROM c2026 c", "FROM c_cur c", 3],
  ["。2026 選舉政見優先；若只找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬的選舉（2022／2024／2026）並在 note 說明'", "。' || c.eyear || ' 選舉政見優先；若只找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬的選舉（' || regular_election_years_text() || '）並在 note 說明'", 1],
  ["已投票的屆別查得到；2026 尚未公告'", "已投票的屆別查得到；' || c.eyear || ' 尚未公告'", 1],
  ["'該縣市選舉委員會官網（2026 登記名單）'", "'該縣市選舉委員會官網（' || c.eyear || ' 登記名單）'", 1],
  ["|| '2026 的資料要等 12 月才會進去。", "|| election_year_text(s.election_id) || ' 的資料要等 ' || to_char((SELECT e.election_date + 7 FROM elections e WHERE e.id = s.election_id), 'FMMM') || ' 月才會進去。", 1],
  ["改成該選舉的年份（2022／2024／2026）。'", "改成該選舉的年份（' || regular_election_years_text() || '）。'", 1],
];
const MAYOR_REPS: Rep[] = [
  ["  WITH queued_by AS MATERIALIZED (", "  WITH cur AS MATERIALIZED (\n    -- 當屆＝下一場還沒投票的定期選舉（都投完了就是最近投完的那一場）；由 elections 決定（campaign_election_id），不再寫死年份\n    SELECT ce.id, election_year_text(ce.id) AS year FROM (SELECT campaign_election_id() AS id) ce\n  ),\n  -- 職位與「幾筆算夠」讀規則 mayor_policies 的 params（election_types、max_policies；跟日本站同名），主控台可改\n  cfg AS MATERIALIZED (\n    SELECT (r.params->>'max_policies')::INTEGER AS max_policies,\n           ARRAY(SELECT jsonb_array_elements_text(r.params->'election_types')) AS election_types\n      FROM activity_rules r\n     WHERE r.activity = 'mayor_policies' AND r.priority IS NULL\n     ORDER BY r.enabled DESC, r.id LIMIT 1  -- 停用了也照算（窗口由總表關，缺口收回記 window）\n  ),\n  queued_by AS MATERIALIZED (", 1],
  ["等票中的 2026 政見提交數", "等票中的當屆政見提交數", 1],
  ["COALESCE(NULLIF(c.payload->>'election_id', ''), '2026') = '2026'", "COALESCE(NULLIF(c.payload->>'election_id', ''), (SELECT cur.id::TEXT FROM cur)) = (SELECT cur.id::TEXT FROM cur)", 1],
  ["    SELECT p.id, p.name, p.party, p.region,\n", "    SELECT p.id, p.name, p.party, p.region,\n           (SELECT pe.election_type FROM politician_elections pe\n             WHERE pe.politician_id = p.id AND pe.election_id = (SELECT cur.id FROM cur)\n               AND pe.election_type = ANY ((SELECT cfg.election_types FROM cfg)::TEXT[]) AND pe.candidacy_status IN ('declared', 'filed')\n             ORDER BY pe.id LIMIT 1) AS etype,\n", 1],
  ["pl.election_id = 2026", "pl.election_id = (SELECT cur.id FROM cur)", 2],
  ["AS n2026,", "AS n_cur,", 1],
  ["AND pe.election_id = 2026 AND pe.election_type = '縣市長'", "AND pe.election_id = (SELECT cur.id FROM cur) AND pe.election_type = ANY ((SELECT cfg.election_types FROM cfg)::TEXT[])", 1],
  ["'election_id', 2026, 'election_type', '縣市長',", "'election_id', cur.id, 'election_type', m.etype,", 1],
  ["m.n2026", "m.n_cur", 6],
  ["' 2026 縣市長候選人）**2026 這一屆**的政見只有 '", "' ' || cur.year || ' ' || m.etype || '候選人）**' || cur.year || ' 這一屆**的政見只有 '", 1],
  ["'。縣市長是網站的主要內容，請補這一屆的政見：找有出處的具體 2026 競選政見，最多 5 筆、每筆一個 policy 型別、各附自己的出處，election_id 填 2026，優先補還沒有的類別。'", "'。' || array_to_string(cfg.election_types, '、') || '是網站的主要內容，請補這一屆的政見：找有出處的具體 ' || cur.year || ' 競選政見，最多 ' || cfg.max_policies || ' 筆、每筆一個 policy 型別、各附自己的出處，election_id 填 ' || cur.id || '，優先補還沒有的類別。'", 1],
  ["不要當 2026 交。'", "不要當 ' || cur.year || ' 交。'", 1],
  ["  FROM m\n", "  FROM m CROSS JOIN cur CROSS JOIN cfg\n", 1],
  ["AND m.n_cur + m.queued < 5", "AND m.n_cur + m.queued < cfg.max_policies", 1],
];

/** 新定義倒推回前一版：每一組替換倒過來做，次數要對 */
function undo(fn: string, reps: Rep[]): string {
  let s = fn;
  for (const [from, to, n] of [...reps].reverse()) {
    assertEquals(s.split(to).length - 1, n, `「${to.slice(0, 40)}」應出現 ${n} 次`);
    s = s.replaceAll(to, from);
  }
  return s;
}
/** 只留 $$ 本體、去掉註解行 */
const code = (fn: string) => fn.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

for (const [arm, reps, prevMig] of [
  ["contribution_auto_tasks_raw", RAW_REPS, "20261010170000_retire_single_election_result.sql"],
  ["contribution_auto_tasks_mayor_policies", MAYOR_REPS, "20261008180000_arms_perf.sql"],
] as const) {
  Deno.test(`A1 ${arm}：前一版是 ${prevMig}，中間沒有人插一版`, async () => {
    const defining: string[] = [];
    for (const n of await migrationNames()) if ((await readMig(n)).includes(`CREATE OR REPLACE FUNCTION ${arm}(`)) defining.push(n);
    const i = defining.indexOf(MIG_NAME);
    assert(i > 0);
    assertEquals(defining[i - 1], prevMig, "前一版變了：要以最新的為底重做替換");
  });

  Deno.test(`A2 ${arm}：新定義＝前一版加機械式替換，倒回去一字不差`, async () => {
    const prev = await latestFn(arm, MIG_NAME);
    const neu = fnText(MIG, arm);
    const body = (f: string) => f.slice(f.search(/AS \$[a-z]*\$/));
    assertEquals(undo(body(neu), reps), body(prev));
  });

  Deno.test(`A3 ${arm}：程式裡沒有寫死的年份`, () => {
    const c = code(fnText(MIG, arm));
    assertEquals([...c.matchAll(/\b20[0-9]{2}\b/g)].map((m) => m[0]), [], "年份要從 campaign_election_id／elections 來");
    assert(c.includes("campaign_election_id()"));
  });
}

Deno.test("A4 mayor_policies：職位與筆數讀規則 params，不寫死", () => {
  const c = code(fnText(MIG, "contribution_auto_tasks_mayor_policies"));
  assert(!c.includes("縣市長"), "職位讀 params.election_types");
  assert(!/<\s*5\b|最多 5 筆/.test(c), "筆數讀 params.max_policies");
  assert(c.includes("r.params->'election_types'") && c.includes("r.params->>'max_policies'"));
});

// ------------------------------------------------------------
// B. PGlite：當屆與年份
// ------------------------------------------------------------
const HELPERS = MIG.slice(MIG.indexOf("-- 1. 當屆與年份"), MIG.indexOf("-- 3. raw"));
const SELFCHECK = MIG.slice(MIG.indexOf("-- 5. 自我檢查"));

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE elections (id INTEGER PRIMARY KEY, election_date DATE, election_reason TEXT);
    INSERT INTO elections VALUES (2022, '2022-11-26', 'regular'), (4, '2022-12-18', 'rerun'), (2024, '2024-01-13', 'regular'), (2026, '2026-11-28', 'regular');
    CREATE FUNCTION activity_today() RETURNS DATE LANGUAGE sql STABLE AS $$ SELECT '2026-10-13'::DATE $$;
    CREATE TABLE activity_rules (id BIGSERIAL PRIMARY KEY, activity TEXT, priority INTEGER, enabled BOOLEAN DEFAULT true, params JSONB DEFAULT '{}');
    INSERT INTO activity_rules (activity, priority) VALUES ('mayor_policies', NULL), ('priority:mayor_policies', 1);
  `);
  await db.exec(HELPERS);
  return db;
}
const one = async (db: PGlite, sql: string) => Object.values((await db.query<Record<string, unknown>>(sql)).rows[0])[0];

Deno.test("B1 當屆＝下一場還沒投票的定期選舉；都投完了是最近投完的那一場；補選、重行選舉不算", async () => {
  const db = await freshDb();
  assertEquals(await one(db, "SELECT campaign_election_id()"), 2026, "今天（預設 activity_today）");
  assertEquals(await one(db, "SELECT campaign_election_id('2024-01-13')"), 2024, "投票日當天還是那一場");
  assertEquals(await one(db, "SELECT campaign_election_id('2024-01-14')"), 2026);
  assertEquals(await one(db, "SELECT campaign_election_id('2026-11-28')"), 2026);
  assertEquals(await one(db, "SELECT campaign_election_id('2027-06-01')"), 2026, "下一場還沒建：留在最近投完的那一場");
  await db.exec("INSERT INTO elections VALUES (5, '2027-03-01', 'by'), (6, '2028-01-15', 'regular')");
  assertEquals(await one(db, "SELECT campaign_election_id('2026-11-27')"), 2026, "2028 建好了，2026 投票前仍是 2026");
  assertEquals(await one(db, "SELECT campaign_election_id('2026-11-29')"), 6, "投票隔天換到下一場定期選舉（補選不算），id 不是年份也行");
});

Deno.test("B2 年份文案：選舉 id 不是年份也對；當屆以前的定期選舉年份", async () => {
  const db = await freshDb();
  assertEquals(await one(db, "SELECT election_year_text(2026)"), "2026");
  assertEquals(await one(db, "SELECT election_year_text(4)"), "2022");
  assertEquals(await one(db, "SELECT regular_election_years_text()"), "2022／2024／2026", "跟原本寫死的字一樣");
  await db.exec("INSERT INTO elections VALUES (6, '2028-01-15', 'regular'), (7, '2030-11-30', 'regular')");
  assertEquals(await one(db, "SELECT regular_election_years_text()"), "2022／2024／2026", "還沒輪到的不列");
  assertEquals(await one(db, "SELECT regular_election_years_text('2026-12-01')"), "2022／2024／2026／2028");
  assertEquals(await one(db, "SELECT election_year_text(6)"), "2028");
});

Deno.test("B3 規則 mayor_policies 補上現行參數（只補主規則、不動優先層規則、重跑不變）；缺參數 migration 擋", async () => {
  const db = await freshDb();
  const sec2 = MIG.slice(MIG.indexOf("-- 2. 規則 mayor_policies"), MIG.indexOf("-- 3. raw"));
  await db.exec(sec2);
  await db.exec(sec2);
  const rows = (await db.query<{ activity: string; params: unknown }>("SELECT activity, params FROM activity_rules ORDER BY id")).rows;
  assertEquals(rows, [
    { activity: "mayor_policies", params: { election_types: ["縣市長"], max_policies: 5 } },
    { activity: "priority:mayor_policies", params: {} },
  ]);
  await db.exec(SELFCHECK);
  await db.exec("UPDATE activity_rules SET params = params - 'max_policies' WHERE priority IS NULL");
  await assertRejects(() => db.exec(SELFCHECK), Error, "max_policies");
  await db.exec("DELETE FROM elections");
  await db.exec(`UPDATE activity_rules SET params = '{"election_types": ["縣市長"], "max_policies": 5}' WHERE priority IS NULL`);
  await assertRejects(() => db.exec(SELFCHECK), Error, "當屆選舉算不出來");
});
