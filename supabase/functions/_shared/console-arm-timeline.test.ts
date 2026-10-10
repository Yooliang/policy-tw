/**
 * 主控台派工開關的選舉時間軸（policy-ops #63；migration 20261010110000_console_arm_timeline.sql＝正見、
 * 20261010110100_policy_jp_console_arm_timeline.sql＝日本站）。
 *
 * 一、文字層：兩站最新的 activity_arm_names() 每支臂都在對照表 console_arm_stage_map 的種子裡、種子沒有不存在的臂
 *     （新增派工臂忘了登記時期就紅）。
 * 二、PGlite（正見）：P0＋P1（buildArmsDb）＋主控台 #518（20261009260000）＋這支。段的計算（規則自動歸段、對照表、預設）、
 *     時間軸的區間、找不到選舉回 NULL、權限。
 * 三、PGlite（日本站）：這支之前的全部 policy_jp migration ＋這支，同樣的檢查。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildArmsDb, latestFn, migrationNames as listMigrations, readMig } from "./arms-pglite.ts";

const TW_MIG = "20261010110000_console_arm_timeline.sql";
const JP_MIG = "20261010110100_policy_jp_console_arm_timeline.sql";
const TW_SQL = await readMig(TW_MIG);
const JP_SQL = await readMig(JP_MIG);

/** 種子 INSERT 裡的臂名 */
function seededArms(sql: string, table: string): string[] {
  const a = sql.indexOf(`INSERT INTO ${table} (arm, stage, note) VALUES`);
  assert(a >= 0, `找不到 ${table} 的種子`);
  const b = sql.indexOf("ON CONFLICT", a);
  return [...sql.slice(a, b).matchAll(/^\s*\('([^']+)',\s*([1-7]),/gm)].map((m) => m[1]);
}
/** 函式本體 ARRAY[...] 裡的臂名 */
const armNames = (fnSql: string) => [...fnSql.slice(fnSql.indexOf("ARRAY[")).matchAll(/'([^']+)'/g)].map((m) => m[1]);

/** 最新一版的 policy_jp.activity_arm_names()（latestFn 只找 public 的寫法，這裡自己掃 _policy_jp_ 的 migration） */
async function latestJpArmNames(): Promise<string[]> {
  let last = "";
  for (const n of await listMigrations()) {
    if (!n.includes("_policy_jp_")) continue;
    const sql = await readMig(n);
    const i = sql.lastIndexOf("CREATE OR REPLACE FUNCTION policy_jp.activity_arm_names()");
    if (i >= 0) last = sql.slice(i, sql.indexOf("$$;", sql.indexOf("$$", i) + 2));
  }
  assert(last, "找不到 policy_jp.activity_arm_names()");
  return armNames(last);
}

Deno.test("文字層：正見每支派工臂都登記了時期，種子沒有不存在的臂", async () => {
  const arms = armNames(await latestFn("activity_arm_names"));
  assert(arms.length >= 35, `抓到的臂太少（${arms.length}），抽取壞了？`);
  // 之後的 migration 收掉的臂（DELETE FROM console_arm_stage_map WHERE arm = '…'，例：20261010170000 收掉 raw:election_result_missing）不算種子
  const removed: string[] = [];
  for (const n of await listMigrations()) if (n > TW_MIG) removed.push(...[...(await readMig(n)).matchAll(/DELETE FROM console_arm_stage_map WHERE arm = '([^']+)'/g)].map((m) => m[1]));
  const seeded = seededArms(TW_SQL, "console_arm_stage_map").filter((a) => !removed.includes(a));
  assertEquals(new Set(seeded).size, seeded.length, "對照表種子重複");
  assertEquals(arms.filter((a) => !seeded.includes(a)), [], "新增的派工臂要在 console_arm_stage_map 登記時期（新 migration 補一列）");
  assertEquals(seeded.filter((a) => !arms.includes(a)), [], "對照表裡有 activity_arm_names() 沒有的臂");
});

Deno.test("文字層：日本站每支派工臂都登記了時期，種子沒有不存在的臂", async () => {
  const arms = await latestJpArmNames();
  assert(arms.includes("policy_missing") && arms.includes("election_discovery"), "日本站臂名抽取壞了？");
  const seeded = seededArms(JP_SQL, "policy_jp.console_arm_stage_map");
  assertEquals(new Set(seeded).size, seeded.length, "對照表種子重複");
  assertEquals(arms.filter((a) => !seeded.includes(a)), [], "新增的派工臂要在 policy_jp.console_arm_stage_map 登記時期");
  assertEquals(seeded.filter((a) => !arms.includes(a)), [], "對照表裡有 policy_jp.activity_arm_names() 沒有的臂");
});

// ---------------------------------------------------------------------------------------------------------------------
// 正見（PGlite）
// ---------------------------------------------------------------------------------------------------------------------
const MANUAL_STUB = `CREATE FUNCTION contribution_auto_tasks_manual(p_visitor boolean, p_id uuid DEFAULT NULL)
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$ SELECT NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text[], NULL::integer, NULL::text WHERE false $$;`;

async function twDb(): Promise<PGlite> {
  const d = await buildArmsDb({ afterP1Sql: MANUAL_STUB + "\nALTER TABLE elections ADD COLUMN IF NOT EXISTS name TEXT;" });
  await d.exec(await readMig("20261009260000_console_admin.sql"));
  await d.exec(TW_SQL);
  return d;
}
type Stage = { arm: string; stage: number; stage_source: string };
type Win = { rule_id: number; window_kind: string; from: string | null; until: string | null; missing_milestone: boolean };
type TArm = { arm: string; stage: number; stage_source: string; is_open: boolean; overridden: boolean; windows: Win[] };
type Timeline = { today: string; election: { id: string; date: string }; milestones: { kind: string; on_date: string }[]; arms: TArm[] };

Deno.test("正見：console_stage_of_kind 起點與迄點對到 7 段", async () => {
  const d = await twDb();
  const cases: [string, number, boolean, number][] = [
    ["announced", 0, false, 2], ["registration_open", 0, false, 2], ["registration_close", 0, false, 3], ["draw", 0, false, 3],
    ["bulletin_published", 0, false, 3], ["polling", -3, false, 3], ["polling", 1, false, 4], ["result_announced", 0, false, 4],
    ["certified", 0, false, 5], ["term_start", -30, false, 5], ["term_start", 0, false, 6], ["term_end", -90, false, 7],
    ["registration_close", 0, true, 2], ["polling", 0, true, 3], ["polling", 7, true, 4], ["term_start", 0, true, 5], ["term_end", 0, true, 6],
  ];
  for (const [k, off, until, want] of cases) {
    const r = (await d.query<{ s: number }>("SELECT console_stage_of_kind($1, $2, $3) AS s", [k, off, until])).rows[0];
    assertEquals(r.s, want, `${k}${off >= 0 ? "+" : ""}${off}${until ? "（迄點）" : ""}`);
  }
});

Deno.test("正見：真實規則下，有日期規則的臂照規則歸段，而且對照表的後備值跟規則算出的一樣（審查 #565：以規則為準）", async () => {
  // twDb 只有 P0＋P1（規則全是 always）；把之後各支 migration 搬日期條件的規則改寫（UPDATE／新臂的 INSERT）照順序套上，
  // activity_arm_names() 換成最新一版，才是正式庫現在的規則
  const d = await twDb();
  await d.exec(await latestFn("activity_arm_names", TW_MIG));
  const ruleStmt = /^(?:UPDATE activity_rules\s+SET window_kind\b|INSERT INTO activity_rules \(activity, window_kind, from_kind\b)[\s\S]*?;\s*$/gm;
  let applied = 0;
  for (const n of await listMigrations()) {
    if (n <= "20261008060000" || n >= TW_MIG || n.includes("_policy_jp_")) continue;
    for (const m of (await readMig(n)).matchAll(ruleStmt)) {
      if (/'priority:/.test(m[0]) || /\bpriority\b/.test(m[0].split("SELECT")[0])) continue; // 優先層規則只管排序
      await d.exec(m[0]);
      applied++;
    }
  }
  assert(applied >= 6, `套上的規則改寫太少（${applied}），抽取的寫法可能失效`);
  const rows = (await d.query<Stage>("SELECT * FROM console_arm_stages()")).rows;
  const map = new Map((await d.query<{ arm: string; stage: number }>("SELECT arm, stage FROM console_arm_stage_map")).rows.map((r) => [r.arm, r.stage]));
  const ruled = Object.fromEntries(rows.filter((r) => r.stage_source === "rule").map((r) => [r.arm, r.stage]));
  // 主線規劃原把參選狀態、政黨名冊放 2、政黨補齊放 5；規則實際是登記截止起、到投票日為止、投票日隔天起
  const expected: Record<string, number> = {
    "raw:candidate_status_stale": 3,
    party_roster: 3,
    party_gap: 4,
    not_running: 3,
    ballot_numbers: 3,
    election_results: 4,
    "raw:election_result_missing": 4,
  };
  for (const [arm, stage] of Object.entries(expected)) assertEquals(ruled[arm], stage, `${arm} 照規則應在第 ${stage} 段`);
  for (const [arm, stage] of Object.entries(ruled)) assertEquals(map.get(arm), stage, `${arm} 的對照表後備值要跟規則算出的段一樣`);
});

Deno.test("正見：console_arm_stages 每支臂一列、都有登記（沒有 default）；有日期規則的臂照規則歸段、蓋過對照表", async () => {
  const d = await twDb();
  const names = (await d.query<{ a: string[] }>("SELECT activity_arm_names() AS a")).rows[0].a;
  let rows = (await d.query<Stage>("SELECT * FROM console_arm_stages()")).rows;
  assertEquals(rows.map((r) => r.arm).sort(), [...names].sort());
  assertEquals(rows.filter((r) => r.stage_source === "default").map((r) => r.arm), []);
  assertEquals(rows.find((r) => r.arm === "mayor_policies"), { arm: "mayor_policies", stage: 3, stage_source: "map" });

  // 對照表說 3（縣市長政見），規則改成抽籤日起 → 仍 3 但來源是規則；改成投票日隔天起 → 4
  await d.exec("UPDATE activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1 WHERE activity = 'mayor_policies'");
  rows = (await d.query<Stage>("SELECT * FROM console_arm_stages()")).rows;
  assertEquals(rows.find((r) => r.arm === "mayor_policies"), { arm: "mayor_policies", stage: 4, stage_source: "rule" });
  // 只有迄點（到投票日為止）→ 3；任期中（term 窗口、就任日起）→ 6
  await d.exec("UPDATE activity_rules SET window_kind = 'event', from_kind = NULL, until_kind = 'polling', until_offset = 0 WHERE activity = 'dup'");
  await d.exec("UPDATE activity_rules SET window_kind = 'term', from_kind = 'term_start', from_offset = 0 WHERE activity = 'legacy'");
  rows = (await d.query<Stage>("SELECT * FROM console_arm_stages()")).rows;
  assertEquals(rows.find((r) => r.arm === "dup")?.stage, 3);
  assertEquals(rows.find((r) => r.arm === "legacy")?.stage, 6);
  // 停用的規則不算：退回對照表
  await d.exec("UPDATE activity_rules SET enabled = false WHERE activity = 'legacy'");
  rows = (await d.query<Stage>("SELECT * FROM console_arm_stages()")).rows;
  assertEquals(rows.find((r) => r.arm === "legacy"), { arm: "legacy", stage: 1, stage_source: "map" });
});

Deno.test("正見：console_timeline 回里程碑、每支臂、規則在這場選舉的開放區間；缺里程碑標出來；找不到選舉回 NULL", async () => {
  const d = await twDb();
  await d.exec("SET app.activity_today = '2026-10-10'");
  await d.exec(`INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status) VALUES (2026, 'draw', NULL, '2026-10-23', 'statutory', 'announced')`);
  await d.exec("UPDATE activity_rules SET window_kind = 'event', from_kind = 'draw', from_offset = 0, until_kind = 'polling', until_offset = 0 WHERE activity = 'mayor_policies'");

  const t = (await d.query<{ t: Timeline }>("SELECT console_timeline('2026') AS t")).rows[0].t;
  assertEquals(t.today, "2026-10-10");
  assertEquals(t.election.id, "2026");
  assert(t.milestones.some((m) => m.kind === "polling" && m.on_date === "2026-11-28"), "投票日要在里程碑裡");
  assert(t.milestones.some((m) => m.kind === "draw" && m.on_date === "2026-10-23"), "抽籤日要在里程碑裡");
  const names = (await d.query<{ a: string[] }>("SELECT activity_arm_names() AS a")).rows[0].a;
  assertEquals(t.arms.map((a) => a.arm).sort(), [...names].sort());
  // 依段排序
  assertEquals(t.arms.map((a) => a.stage), [...t.arms.map((a) => a.stage)].sort((x, y) => x - y));

  const mp = t.arms.find((a) => a.arm === "mayor_policies")!;
  assertEquals(mp.stage, 3);
  assertEquals(mp.windows.map((w) => [w.window_kind, w.from, w.until, w.missing_milestone]), [["event", "2026-10-23", "2026-11-28", false]]);
  assertEquals(mp.is_open, false, "今天 10-10 還沒到抽籤日");
  const always = t.arms.find((a) => a.arm === "dup")!;
  assertEquals(always.windows.map((w) => [w.window_kind, w.from, w.until]), [["always", null, null]]);
  assertEquals(always.is_open, true);

  // 2022 沒有抽籤里程碑：區間起點空、標 missing_milestone
  const t22 = (await d.query<{ t: Timeline }>("SELECT console_timeline('2022') AS t")).rows[0].t;
  const mp22 = t22.arms.find((a) => a.arm === "mayor_policies")!;
  assertEquals(mp22.windows.map((w) => [w.from, w.until, w.missing_milestone]), [[null, "2022-11-26", true]]);

  for (const bad of ["9999", "abc", "", null]) {
    assertEquals((await d.query<{ t: unknown }>("SELECT console_timeline($1) AS t", [bad])).rows[0].t, null, `${bad} 應回 NULL`);
  }
});

Deno.test("正見：覆寫蓋到這場（或不限選舉）時 overridden=true，撤銷（過期）後消失", async () => {
  const d = await twDb();
  await d.exec("SET app.activity_today = '2026-10-10'");
  await d.query("SELECT console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)", ["dup", 2026, null, "closed", null, null, "測試", null, "t@example.com"]);
  let t = (await d.query<{ t: Timeline }>("SELECT console_timeline('2026') AS t")).rows[0].t;
  assertEquals(t.arms.find((a) => a.arm === "dup")!.overridden, true);
  assertEquals(t.arms.find((a) => a.arm === "dup")!.is_open, false);
  t = (await d.query<{ t: Timeline }>("SELECT console_timeline('2022') AS t")).rows[0].t;
  assertEquals(t.arms.find((a) => a.arm === "dup")!.overridden, false, "只蓋 2026 的覆寫不該標到 2022");
  await d.exec("UPDATE activity_overrides SET expires_at = '2026-10-09'");
  t = (await d.query<{ t: Timeline }>("SELECT console_timeline('2026') AS t")).rows[0].t;
  assertEquals(t.arms.find((a) => a.arm === "dup")!.overridden, false);
});

Deno.test("正見：console_timeline_elections 列出選舉（新到舊），回應不含帳號資料", async () => {
  const d = await twDb();
  const rows = (await d.query<{ election_id: string; election_date: string }>("SELECT * FROM console_timeline_elections()")).rows;
  assertEquals(rows.map((r) => r.election_id), ["2026", "2024", "4", "2022"]);
  const t = JSON.stringify((await d.query<{ t: unknown }>("SELECT console_timeline('2026') AS t")).rows[0].t);
  assert(!t.includes("created_by") && !t.includes("@"), "時間軸不回 created_by 或 email");
});

Deno.test("正見：anon 能讀（四支函式、對照表），不能寫對照表", async () => {
  const d = await twDb();
  await d.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE anon");
    await tx.query("SELECT console_timeline('2026')");
    await tx.query("SELECT * FROM console_arm_stages()");
    await tx.query("SELECT * FROM console_timeline_elections()");
    await tx.query("SELECT console_stage_of_kind('draw', 0, false)");
    const n = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM console_arm_stage_map")).rows[0].n;
    assert(n >= 40);
  });
  await assertRejects(() =>
    d.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE anon");
      await tx.exec("INSERT INTO console_arm_stage_map (arm, stage) VALUES ('x', 1)");
    })
  );
  await assertRejects(() =>
    d.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE anon");
      await tx.exec("UPDATE console_arm_stage_map SET stage = 7");
    })
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// 日本站（PGlite）
// ---------------------------------------------------------------------------------------------------------------------
const ELECTION = "2028-07-09_national_lower_national";

async function jpDb(): Promise<PGlite> {
  const before = (await listMigrations()).filter((n) => n.includes("_policy_jp_") && n < JP_MIG);
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  for (const n of before) await db.exec(await readMig(n));
  await db.exec(JP_SQL);
  await db.exec(`INSERT INTO policy_jp.elections (id, name, election_date, notice_date, election_type, election_reason, level, review_status)
    VALUES ('${ELECTION}', '衆議院議員総選挙', '2028-07-09', '2028-06-27', 'national_lower', 'regular', 'national', 'published')`);
  return db;
}

Deno.test("日本站：每支臂一列、都有登記；告示日起算第 3 段；時間軸有告示日與投票日；找不到回 NULL；anon 能讀不能寫", async () => {
  const d = await jpDb();
  const names = (await d.query<{ a: string[] }>("SELECT policy_jp.activity_arm_names() AS a")).rows[0].a;
  let rows = (await d.query<Stage>("SELECT * FROM policy_jp.console_arm_stages()")).rows;
  assertEquals(rows.map((r) => r.arm).sort(), [...names].sort());
  assertEquals(rows.filter((r) => r.stage_source === "default").map((r) => r.arm), []);

  assertEquals((await d.query<{ s: number }>("SELECT policy_jp.console_stage_of_kind('announced', 0, false) AS s")).rows[0].s, 3);
  assertEquals((await d.query<{ s: number }>("SELECT policy_jp.console_stage_of_kind('polling', 1, false) AS s")).rows[0].s, 4);

  await d.exec("UPDATE policy_jp.activity_rules SET window_kind = 'event', from_kind = 'polling', from_offset = 1 WHERE activity = 'manual_open'");
  rows = (await d.query<Stage>("SELECT * FROM policy_jp.console_arm_stages()")).rows;
  assertEquals(rows.find((r) => r.arm === "manual_open"), { arm: "manual_open", stage: 4, stage_source: "rule" });

  await d.exec("SET app.activity_today = '2028-06-01'");
  const t = (await d.query<{ t: Timeline }>("SELECT policy_jp.console_timeline($1) AS t", [ELECTION])).rows[0].t;
  assertEquals(t.election.id, ELECTION);
  assert(t.milestones.some((m) => m.kind === "announced" && m.on_date === "2028-06-27"), "告示日要在里程碑裡");
  assert(t.milestones.some((m) => m.kind === "polling" && m.on_date === "2028-07-09"), "投票日要在里程碑裡");
  assertEquals(t.arms.map((a) => a.arm).sort(), [...names].sort());
  const mo = t.arms.find((a) => a.arm === "manual_open")!;
  assert(mo.windows.some((w) => w.from === "2028-07-10" && w.until === null), "投票日 +1 起、無迄日");
  assertEquals((await d.query<{ t: unknown }>("SELECT policy_jp.console_timeline('nope') AS t")).rows[0].t, null);

  const els = (await d.query<{ election_id: string }>("SELECT * FROM policy_jp.console_timeline_elections()")).rows;
  assertEquals(els.map((e) => e.election_id), [ELECTION]);

  await d.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE anon");
    await tx.query("SELECT policy_jp.console_timeline($1)", [ELECTION]);
    await tx.query("SELECT * FROM policy_jp.console_arm_stages()");
    await tx.query("SELECT * FROM policy_jp.console_timeline_elections()");
    await tx.query("SELECT count(*) FROM policy_jp.console_arm_stage_map");
  });
  await assertRejects(() =>
    d.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE anon");
      await tx.exec("INSERT INTO policy_jp.console_arm_stage_map (arm, stage) VALUES ('x', 1)");
    })
  );
});

Deno.test("日本站：public 沒有被這支日本站 migration 動到（正見那半在另一支）", () => {
  const stripped = JP_SQL.replace(/--[^\n]*/g, "");
  const objs = [...stripped.matchAll(/\b(?:FUNCTION|TABLE|VIEW|INTO|POLICY\s+"[^"]+"\s+ON)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([\w."]+)/gi)].map((m) => m[1]);
  assert(objs.length > 20, `抽到的物件太少（${objs.length}），抽取壞了？`);
  assertEquals(objs.filter((n) => !n.startsWith("policy_jp.") && !/^v_\w+$/.test(n)), [], "日本站 migration 只能碰 policy_jp 的物件");
});
