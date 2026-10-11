/**
 * 當屆類 15 支臂補上起訖（migration 20261011030000；工作單 Yooliang/policy-ops#81）。
 *   - 規則：照里程碑開關的 12 支（含補舊屆政見投票日 +1 起、政見進度兩支就職日起不設迄日）、維持永遠開的 4 支
 *   - 名單清查兩支起點是登記截止（照登記彙總表核對），不是名單公告日
 *   - 補舊屆政見：2026 那屆的設定表開關打開，改由規則擋到投票隔天；去重只在 2026 還沒投票時生效
 *   - activity_open：規則 params.open_when_unknown＝屆別或職位查不到照開（政見進度兩支用）
 *   - 自我檢查：漏改一支整支停下
 *   還原驗證：名單清查起點換成名單公告日／拿掉 activity_open 那一段／去重拿掉投票日條件，都紅
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG = "20261011030000_arm_windows_13.sql";
const SQL = await readMig(MIG);
const strip = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

/** 規則與設定表那幾段（函式另外測）：去掉兩支 CREATE FUNCTION */
function rulesPart(sql: string): string {
  let out = sql;
  for (const name of ["activity_open", "contribution_auto_tasks_term_policies"]) out = out.replace(fnText(out, name), "");
  return out;
}
const RULES_SQL = rulesPart(SQL);

const SEED: Array<[number, string]> = [
  [3, "raw:policy_missing"], [31, "mayor_policies"], [14, "raw:roster_check"], [1, "roster_villages"], [28, "district_seats"],
  [19, "raw:candidacy_source_missing"], [27, "withdrawn_filing"], [21, "roster_cec_gap"], [30, "elected_missing"],
  [22, "handover_missing"], [6, "lineage_candidates"], [25, "lineage_links"], [26, "lineage_roles"],
  [5, "raw:progress_stale"], [24, "deadline_due"], [36, "term_policies"], [47, "term_policies"],
];

/**
 * 規則表照正式的定義建（P0 的 CREATE TABLE 與它所有的 CHECK，加上後來幾支 migration 的 ALTER TABLE），
 * 不是自己手寫一張寬鬆的表——#578 部署時 activity_rules_shape 擋下 event＋term_start，手寫的表沒有那條 CHECK，測試沒抓到。
 */
const P0 = await readMig("20261008001000_activity_windows_p0.sql");
const TABLE_DDL = (() => {
  const a = P0.indexOf("CREATE TABLE IF NOT EXISTS activity_rules (");
  const b = P0.indexOf("\n);\n", a) + 4;
  assert(a >= 0 && b > a);
  return P0.slice(a, b);
})();
const LATER_ALTERS = (await Promise.all(["20261008090000_queue_priority_tiers.sql", "20261008160000_roster_milestones.sql", "20261009010000_village_chief_progress_cooling.sql"]
  .map(readMig))).flatMap((sql) => [...strip(sql).matchAll(/ALTER TABLE activity_rules [^;]*;/g)].map((m) => m[0]));

async function db(sql = RULES_SQL): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`CREATE TABLE task_priority_tiers (id smallint PRIMARY KEY); INSERT INTO task_priority_tiers VALUES (1), (2), (3);`);
  await d.exec(TABLE_DDL);
  for (const a of LATER_ALTERS) await d.exec(a);
  await d.exec(`CREATE TABLE election_task_config (election_id int PRIMARY KEY, enabled boolean, note text, updated_at timestamptz);
    INSERT INTO election_task_config VALUES (2022, true, '', now()), (2026, false, '', now());`);
  for (const [id, act] of SEED) {
    const village = id === 47;
    const exceptVillage = [5, 24, 36].includes(id);
    await d.query(
      `INSERT INTO activity_rules (id, activity, window_kind, note, election_types, except_election_types, requires_traffic)
       VALUES ($1, $2, 'always', 'P1 種子：永遠開', $3, $4, $5)`,
      [id, act, village ? ["村里長"] : null, exceptVillage ? ["村里長"] : null, village],
    );
  }
  await d.exec(sql);
  return d;
}

type Row = { activity: string; window_kind: string; from_kind: string | null; from_offset: number; until_kind: string | null; until_offset: number };
async function rules(d: PGlite): Promise<Record<string, string>> {
  const { rows } = await d.query<Row & { id: number }>(`SELECT id::int, activity, window_kind, from_kind, from_offset, until_kind, until_offset FROM activity_rules`);
  return Object.fromEntries(rows.map((r) => [r.activity === "term_policies" ? `term_policies#${r.id}` : r.activity,
    r.window_kind === "always" ? "always" : `${r.from_kind ?? "-"}+${r.from_offset}..${r.until_kind ?? "-"}+${r.until_offset}`]));
}

Deno.test("規則：12 支照里程碑、4 支維持永遠開；2026 補舊屆政見開關打開", async () => {
  const d = await db();
  assertEquals(await rules(d), {
    "raw:policy_missing": "-+0..polling+0",
    "mayor_policies": "-+0..polling+0",
    "raw:roster_check": "registration_close+0..polling+0",
    "roster_villages": "registration_close+0..polling+0",
    "district_seats": "-+0..polling+0",
    "raw:candidacy_source_missing": "-+0..polling+0",
    "withdrawn_filing": "registration_close+0..list_published+0",
    "roster_cec_gap": "polling+1..-+0",
    "elected_missing": "polling+1..-+0",
    "term_policies#36": "polling+1..-+0",
    "term_policies#47": "polling+1..-+0",
    "raw:progress_stale": "term_start+0..-+0",
    "deadline_due": "term_start+0..-+0",
    "handover_missing": "always",
    "lineage_candidates": "always",
    "lineage_links": "always",
    "lineage_roles": "always",
  });
  const { rows } = await d.query<{ p: Record<string, unknown> }>(`SELECT params AS p FROM activity_rules WHERE id IN (5, 24) ORDER BY id`);
  assertEquals(rows.map((r) => r.p.open_when_unknown), [true, true]);
  assertEquals((await d.query<{ e: boolean }>(`SELECT enabled AS e FROM election_task_config WHERE election_id = 2026`)).rows[0].e, true);
  await d.close();
});

Deno.test("還原驗證：名單清查起點換成名單公告日，結果就不同", async () => {
  const broken = RULES_SQL.replace(
    "from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0,\n       note = '當屆類（OPS #81）：登記截止起、到投票日為止（照登記彙總表",
    "from_kind = 'list_published', from_offset = 0, until_kind = 'polling', until_offset = 0,\n       note = '當屆類（OPS #81）：登記截止起、到投票日為止（照登記彙總表",
  );
  assert(broken !== RULES_SQL);
  const d = await db(broken);
  assertEquals((await rules(d))["raw:roster_check"], "list_published+0..polling+0");
  await d.close();
});

Deno.test("自我檢查：少改一支、沒打開 2026 補舊屆政見、或補舊屆政見有一條沒照投票日 +1 起，整支停下", async () => {
  const a = RULES_SQL.replace(/UPDATE activity_rules SET window_kind = 'event'[^;]*WHERE id = 30 AND activity = 'elected_missing';/, "");
  assert(a !== RULES_SQL);
  await assertRejects(() => db(a));
  const b = RULES_SQL.replace(/UPDATE election_task_config[^;]*;/, "");
  assert(b !== RULES_SQL);
  await assertRejects(() => db(b));
  // 還原驗證：村里長那條（rule 47）不改，2026 設定表打開後投票前會被派 → 停下
  const c = RULES_SQL.replace(/UPDATE activity_rules SET window_kind = 'event'[^;]*WHERE id = 47 AND activity = 'term_policies';/, "");
  assert(c !== RULES_SQL);
  await assertRejects(() => db(c));
});

Deno.test("只動這 17 列規則、一列設定與兩支函式：不建表、不刪資料", () => {
  const code = strip(RULES_SQL);
  assert(!/CREATE|DROP|DELETE|INSERT|ALTER/.test(code.replace(/RAISE EXCEPTION[^;]*;/g, "")));
  assertEquals([...strip(SQL).matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]).sort(), ["activity_open", "contribution_auto_tasks_term_policies"]);
  const ids = [...code.matchAll(/WHERE id (?:= (\d+)|IN \(([\d, ]+)\))/g)].flatMap((m) => (m[1] ?? m[2]).split(",").map((s) => Number(s.trim())));
  assertEquals([...new Set(ids)].sort((a, b) => a - b), SEED.map(([id]) => id).sort((a, b) => a - b));
});

// ── 補舊屆政見：前一版只改去重那一行 ──
Deno.test("補舊屆政見＝前一版只把去重改成「2026 還沒投票時才去重」", async () => {
  const prev = await latestFn("contribution_auto_tasks_term_policies", MIG);
  const now = fnText(SQL, "contribution_auto_tasks_term_policies");
  const old = "       AND (NOT EXISTS (SELECT 1 FROM politician_elections c WHERE c.politician_id = i0.politician_id AND c.election_id = 2026 AND c.candidacy_status IS DISTINCT FROM 'withdrawn')\n";
  assertEquals(prev.split(old).length - 1, 1);
  const rebuilt = prev.replace(old,
    "       -- 只在 2026 還沒投票時去重（OPS #81）：當屆缺政見投票日就收，投票隔天起零政見的 2026 參選人改由這支接手，不然兩邊都不派\n" +
      "       AND (NOT EXISTS (SELECT 1 FROM politician_elections c JOIN elections ce ON ce.id = c.election_id WHERE c.politician_id = i0.politician_id AND c.election_id = 2026 AND ce.election_date >= activity_today() AND c.candidacy_status IS DISTINCT FROM 'withdrawn')\n");
  assertEquals(now, rebuilt);
  assert(!now.includes(old), "還原驗證：舊的去重（不看投票日）不能留著");
});

// ── activity_open：屆別或職位查不到時照開（params.open_when_unknown） ──
const AO = fnText(SQL, "activity_open");
async function aoDb(fn = AO): Promise<PGlite> {
  const d = new PGlite();
  await d.exec(`
    CREATE TABLE elections (id int PRIMARY KEY, election_reason text);
    INSERT INTO elections VALUES (2024, 'regular'), (2026, 'regular');
    CREATE TABLE activity_overrides (id bigint, activity text, election_id int, election_type text, "force" text, open_from date, open_until date, expires_at date);
    CREATE TABLE activity_rules (id bigint, activity text, window_kind text, from_kind text, from_offset int DEFAULT 0, until_kind text, until_offset int DEFAULT 0,
      min_status text DEFAULT 'announced', recur_months int4range, reasons text[], levels text[], election_types text[], except_election_types text[],
      jurisdictions text[], params jsonb NOT NULL DEFAULT '{}', enabled boolean DEFAULT true, priority smallint);
    CREATE TABLE election_milestones_all (election_id int, kind text, election_type text, on_date date, status text);
    INSERT INTO election_milestones_all VALUES (2024, 'term_start', '立法委員', '2024-02-01', 'done'), (2026, 'term_start', '縣市長', '2026-12-25', 'announced');
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql AS $$ SELECT DATE '2026-10-11' $$;
    CREATE FUNCTION activity_status_rank(t text) RETURNS int LANGUAGE sql AS $$ SELECT CASE t WHEN 'expected' THEN 1 WHEN 'announced' THEN 2 WHEN 'done' THEN 3 ELSE 0 END $$;
    CREATE FUNCTION activity_level(t text) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
    CREATE FUNCTION activity_jurisdiction(i int) RETURNS text LANGUAGE sql AS $$ SELECT 'tw'::text $$;
    INSERT INTO activity_rules (id, activity, window_kind, from_kind, params) VALUES
      (5, 'raw:progress_stale', 'event', 'term_start', '{"open_when_unknown": true}'),
      (9, 'plain', 'event', 'term_start', '{}');
  `);
  await d.exec(fn);
  return d;
}
const open = async (d: PGlite, act: string, eid: number | null, et: string | null, day: string) =>
  (await d.query(`SELECT 1 FROM activity_open($1, $2::int, $3::text, $4::date)`, [act, eid, et, day])).rows.length > 0;

Deno.test("activity_open：設了 open_when_unknown 的規則，屆別或職位查不到照開；查得到的照里程碑、不設迄日", async () => {
  const d = await aoDb();
  assertEquals(await open(d, "raw:progress_stale", null, null, "2026-10-11"), true, "沒有屆別");
  assertEquals(await open(d, "raw:progress_stale", 2024, null, "2026-10-11"), true, "有屆別、職位查不到");
  assertEquals(await open(d, "raw:progress_stale", 2024, "立法委員", "2030-10-11"), true, "已就職、任期過了也照開");
  assertEquals(await open(d, "raw:progress_stale", 2026, "縣市長", "2026-10-11"), false, "還沒就職");
  assertEquals(await open(d, "raw:progress_stale", 2026, "縣市長", "2026-12-25"), true, "就職日起");
  assertEquals(await open(d, "plain", null, null, "2026-10-11"), false, "沒設旗標的規則照舊：查不到就關");
  await d.close();
});

Deno.test("還原驗證：拿掉 activity_open 那一段，查不到的就被關掉", async () => {
  const cut = AO.replace(/         -- 查不到屆別或職位時照開[\s\S]*?p_today <= u\.on_date \+ r\.until_offset\)\)\n/, "");
  assert(cut !== AO);
  const d = await aoDb(cut);
  assertEquals(await open(d, "raw:progress_stale", null, null, "2026-10-11"), false);
  await d.close();
});

Deno.test("activity_open＝前一版只多那一段 OR（其餘一字不動）", async () => {
  const prev = await latestFn("activity_open", MIG);
  const cut = AO.replace(/         -- 查不到屆別或職位時照開[\s\S]*?p_today <= u\.on_date \+ r\.until_offset\)\)\n/, "");
  assertEquals(cut, prev);
});

Deno.test("規則表吃得到正式的 CHECK：任期起訖用 event 會被 activity_rules_shape 擋下（還原驗證：#578 部署失敗的那個寫法）", async () => {
  const bad = RULES_SQL.replace(/(UPDATE activity_rules SET window_kind = )'term'(, from_kind = 'term_start'[^;]*WHERE id = 5 AND activity = 'raw:progress_stale';)/, "$1'event'$2");
  assert(bad !== RULES_SQL, "替換要真的換到 rule 5 那一句");
  await assertRejects(() => db(bad), Error, "activity_rules_shape");
});

Deno.test("activity_open：term＋只有起點（就職日、不設迄日）跟 event 一樣算——就職前關、就職後一直開", async () => {
  const d = await aoDb();
  await d.exec(`UPDATE activity_rules SET window_kind = 'term' WHERE id = 5`);
  assertEquals(await open(d, "raw:progress_stale", 2026, "縣市長", "2026-12-24"), false);
  assertEquals(await open(d, "raw:progress_stale", 2026, "縣市長", "2026-12-25"), true);
  assertEquals(await open(d, "raw:progress_stale", 2024, "立法委員", "2035-01-01"), true);
  assertEquals(await open(d, "raw:progress_stale", null, null, "2026-10-11"), true, "查不到照開");
  await d.close();
});
