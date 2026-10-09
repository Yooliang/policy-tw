/**
 * 日本站自治體清單由總務省表一次建入（migration 20261009265000_policy_jp_lg_seed.sql；policy-jp #69）。
 *
 * 只要 --allow-read。PGlite 上套日本站整條 migration（到 210100）＋250000／250100（團體碼表與資料）再跑這支。
 *   a. 空庫：1,965 團體全部進來、47 都道府県、slug 照 local_government_slug、pref_code／kind 取自團體碼表；
 *      每列一筆主要出處（團體碼表的 source_id）、中核市另掛佐證（中核市一覧）、每列一筆 edit_history（soumu-seed、old 空、new＝整列）
 *   b. 冪等：重跑不新增任何列、出處、履歷
 *   c. 不動既有列：已經在庫裡的團體（交件落庫的）名稱、時間戳、出處、履歷原封不動，也不補寫履歷；總數仍是 1,965
 *   d. 自我檢查（還原驗證）：團體碼表少灌，這支會失敗，不留半套
 *   e. 文字守門：沒有 public./ditrust 引用、沒有 DROP／DELETE／UPDATE
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const CHAIN = [
  "20261008195000_policy_jp_schema.sql", "20261009000000_policy_jp_tables.sql", "20261009130000_policy_jp_dispatch.sql",
  "20261009130100_policy_jp_election_discovery.sql", "20261009130200_policy_jp_term_expirations_r08.sql", "20261009150100_policy_jp_rebalance_anchor.sql",
  "20261009200000_policy_jp_public_stats.sql", "20261009210000_policy_jp_apply.sql", "20261009210100_policy_jp_gap_arms.sql",
  "20261009250000_policy_jp_lg_registry.sql", "20261009250100_policy_jp_lg_registry_data.sql",
];
const SEED_FILE = "20261009265000_policy_jp_lg_seed.sql";
const CHAIN_SQL = await Promise.all(CHAIN.map(read));
const SEED_SQL = await read(SEED_FILE);

const ROLES = `CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`;
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES);
  for (const sql of CHAIN_SQL) await db.exec(sql);
  return db;
}
const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const count = async (db: PGlite, sql: string) => Number((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM (${sql}) q`)).n);
const counts = async (db: PGlite) => ({
  lg: await count(db, `SELECT 1 FROM policy_jp.local_governments`),
  refs: await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'local_governments'`),
  history: await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'local_governments'`),
});

// =============================================================================================
// a. 空庫
// =============================================================================================
const seeded = await freshDb();
await seeded.exec(SEED_SQL);

Deno.test("建入：1,965 團體全進來，47 都道府県，pref_code／種類／名稱／讀音取自團體碼表", async () => {
  assertEquals(await counts(seeded), { lg: 1965, refs: 1965 + 62, history: 1965 });
  assertEquals(await count(seeded, `SELECT 1 FROM policy_jp.local_governments WHERE kind = 'prefecture'`), 47);
  assertEquals(await count(seeded, `
    SELECT 1 FROM policy_jp.lg_code_registry r JOIN policy_jp.local_governments g USING (lg_code)
     WHERE (g.kind, g.pref_code, g.name, g.kana) IS DISTINCT FROM (r.kind, r.pref_code, r.name, r.kana)`), 0);
  const g = await one<{ kind: string; pref_code: string; name: string; assembly_seats: number | null; valid_from: string | null }>(seeded,
    `SELECT kind, pref_code, name, assembly_seats, valid_from FROM policy_jp.local_governments WHERE lg_code = '011002'`);
  assertEquals([g.kind, g.pref_code, g.name, g.assembly_seats, g.valid_from], ["designated_city", "010006", "札幌市", null, null]);
});

Deno.test("建入：slug 照 local_government_slug（都道府県羅馬字、其他用團體碼）", async () => {
  assertEquals(await count(seeded, `SELECT 1 FROM policy_jp.local_governments WHERE slug IS DISTINCT FROM policy_jp.local_government_slug(lg_code)`), 0);
  assertEquals((await one<{ slug: string }>(seeded, `SELECT slug FROM policy_jp.local_governments WHERE lg_code = '130001'`)).slug, "tokyo");
  assertEquals((await one<{ slug: string }>(seeded, `SELECT slug FROM policy_jp.local_governments WHERE lg_code = '131130'`)).slug, "131130");
});

Deno.test("出處：每列一筆主要出處（團體碼表的 source_id）、中核市 62 列另掛中核市一覧當佐證", async () => {
  assertEquals(await count(seeded, `
    SELECT 1 FROM policy_jp.local_governments g
     WHERE (SELECT count(*) FROM policy_jp.source_refs s WHERE s.target_table = 'local_governments' AND s.target_id = g.lg_code AND s.role = 'primary') <> 1`), 0);
  assertEquals(await count(seeded, `
    SELECT 1 FROM policy_jp.source_refs s JOIN policy_jp.lg_code_registry r ON r.lg_code = s.target_id
     WHERE s.target_table = 'local_governments' AND s.role = 'primary' AND s.source_id <> r.source_id`), 0);
  assertEquals(await count(seeded, `
    SELECT 1 FROM policy_jp.source_refs s JOIN policy_jp.lg_code_registry r ON r.lg_code = s.target_id
     WHERE s.target_table = 'local_governments' AND s.role = 'supporting' AND s.source_id = r.kind_source_id AND r.kind = 'core_city'`), 62);
  assertEquals(await count(seeded, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'local_governments' AND origin <> 'soumu-seed'`), 0);
  // 指到的 sources 都是總務省的官方出處
  assertEquals(await count(seeded, `
    SELECT 1 FROM policy_jp.source_refs s JOIN policy_jp.sources x ON x.id = s.source_id
     WHERE s.target_table = 'local_governments' AND (x.url NOT LIKE 'https://www.soumu.go.jp/%' OR x.source_kind <> 'official')`), 0);
});

Deno.test("履歷：每列一筆 edit_history（field=*、old 空、new＝整列、agent_name=soumu-seed、不掛交件）", async () => {
  assertEquals(await count(seeded, `
    SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'local_governments' AND field = '*' AND old_value IS NULL
       AND agent_name = 'soumu-seed' AND contribution_id IS NULL AND new_value->>'lg_code' = record_id`), 1965);
  const h = await one<{ new_value: Record<string, unknown> }>(seeded, `SELECT new_value FROM policy_jp.edit_history WHERE record_id = '011002'`);
  assertEquals([h.new_value.name, h.new_value.kind, h.new_value.slug], ["札幌市", "designated_city", "011002"]);
});

// =============================================================================================
// b. 冪等
// =============================================================================================
Deno.test("冪等：重跑不新增團體、出處、履歷", async () => {
  const before = await counts(seeded);
  await seeded.exec(SEED_SQL);
  assertEquals(await counts(seeded), before);
});

// =============================================================================================
// c. 不動既有列
// =============================================================================================
Deno.test("不動既有列：已經在庫裡的團體（交件落庫的）原封不動，不補出處與履歷；其餘照建，總數 1,965", async () => {
  const db = await freshDb();
  // 模擬交件落庫的兩列：札幌市故意用不同的讀音（落庫時的內容不該被覆蓋）
  await db.exec(`
    INSERT INTO policy_jp.local_governments (lg_code, kind, pref_code, name, kana, slug, created_at, updated_at)
    VALUES ('010006', 'prefecture', '010006', '北海道', 'ほっかいどう', 'hokkaido', TIMESTAMPTZ '2026-10-01 00:00:00+00', TIMESTAMPTZ '2026-10-01 00:00:00+00'),
           ('011002', 'designated_city', '010006', '札幌市', 'さつぽろし', '011002', TIMESTAMPTZ '2026-10-01 00:00:00+00', TIMESTAMPTZ '2026-10-01 00:00:00+00')`);
  await db.exec(SEED_SQL);
  const kept = await db.query<{ lg_code: string; kana: string; created_at: string }>(
    `SELECT lg_code, kana, created_at::TEXT FROM policy_jp.local_governments WHERE lg_code IN ('010006', '011002') ORDER BY lg_code`);
  assertEquals(kept.rows.map((r) => [r.lg_code, r.kana]), [["010006", "ほっかいどう"], ["011002", "さつぽろし"]]);
  assert(kept.rows.every((r) => r.created_at.startsWith("2026-10-01")));
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.source_refs WHERE target_table = 'local_governments' AND target_id IN ('010006', '011002')`), 0);
  assertEquals(await count(db, `SELECT 1 FROM policy_jp.edit_history WHERE table_name = 'local_governments' AND record_id IN ('010006', '011002')`), 0);
  const c = await counts(db);
  assertEquals([c.lg, c.history], [1965, 1963]);
  await db.close();
});

// =============================================================================================
// d. 自我檢查（還原驗證）
// =============================================================================================
Deno.test("自我檢查：團體碼表少灌，這支會失敗，也不會留下半套", async () => {
  const db = await freshDb();
  await db.exec(`DELETE FROM policy_jp.lg_code_registry WHERE lg_code = (SELECT max(lg_code) FROM policy_jp.lg_code_registry)`);
  await assertRejects(() => db.exec(SEED_SQL), Error, "應有 1965 列");
  assertEquals(await counts(db), { lg: 0, refs: 0, history: 0 });
  await db.close();
});

// =============================================================================================
// e. 文字守門
// =============================================================================================
Deno.test("文字守門：只在 policy_jp 動手，不碰 public／ditrust；不 DROP、不改不刪既有列；留著 NOT EXISTS 冪等條件", () => {
  const code = SEED_SQL.replace(/--[^\n]*/g, "");
  assert(!/\bpublic\./.test(code), "提到 public.");
  assert(!/ditrust/i.test(code), "提到 ditrust");
  assert(!/\bDROP\b/i.test(code), "有 DROP");
  assert(!/\b(UPDATE|DELETE\s+FROM|TRUNCATE)\b/i.test(code), "有改或刪既有列的語句");
  assert(/WHERE NOT EXISTS \(SELECT 1 FROM policy_jp\.local_governments g WHERE g\.lg_code = r\.lg_code\)/.test(code), "沒有 NOT EXISTS 冪等條件");
});
