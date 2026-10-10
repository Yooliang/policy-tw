/**
 * 主控台時間軸：日常與當屆選舉拆開（policy-ops #69；migration 20261010140000_console_timeline_per_election.sql＝正見、
 * 20261010140100_policy_jp_console_timeline_per_election.sql＝日本站）。
 *
 * 正見（PGlite）：P0＋P1（buildArmsDb）＋主控台 #518＋時間軸 #63＋這支。派工列照 target 歸到選舉（election_id、election_key、
 * 參選紀錄），沒有選舉的算日常；選 2022 只算 2022 的件數，過了段還在派的標 stale（名單清查、開票結果紅、任內政見不紅）；權限。
 * 日本站（PGlite）：這支之前的全部 policy_jp migration＋這支，同樣的檢查。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { buildArmsDb, migrationNames, readMig } from "./arms-pglite.ts";

const TW_MIG = "20261010140000_console_timeline_per_election.sql";
const JP_MIG = "20261010140100_policy_jp_console_timeline_per_election.sql";

type ByType = { election_type: string | null; n: number; is_open: boolean; overridden: boolean };
type Arm = { arm: string; stage: number; election_count: number; daily_count: number; stage_end: string | null; stale: boolean; queue_count: number | null; by_type: ByType[] };
type Timeline = { today: string; election_total: number; daily_total: number; arms: Arm[] };

const MANUAL_STUB = `CREATE FUNCTION contribution_auto_tasks_manual(p_visitor boolean, p_id uuid DEFAULT NULL)
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$ SELECT NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text[], NULL::integer, NULL::text WHERE false $$;`;

async function twDb(): Promise<PGlite> {
  const d = await buildArmsDb({
    afterP1Sql: MANUAL_STUB + `
      ALTER TABLE elections ADD COLUMN IF NOT EXISTS name TEXT;
      CREATE TABLE IF NOT EXISTS politician_elections (id integer PRIMARY KEY, election_id integer, election_type text, politician_id uuid);
      CREATE TABLE IF NOT EXISTS policies (id serial PRIMARY KEY, politician_id uuid, removed_at timestamptz);`,
  });
  await d.exec(await readMig("20261009260000_console_admin.sql"));
  await d.exec(await readMig("20261010110000_console_arm_timeline.sql"));
  await d.exec(await readMig(TW_MIG));
  await d.exec("SET app.activity_today = '2026-10-10'");
  return d;
}

/** 一筆自動缺口派工列：arm＝opened_by.arm（null＝P1 之前回填的舊列，沒有 arm 鍵） */
async function dispatch(d: PGlite, id: string, arm: string | null, target: unknown, schema = "public") {
  await d.query(`INSERT INTO ${schema}.task_dispatches (task_id, task_type, target, opened_by) VALUES ($1, 'x', $2::jsonb, $3::jsonb)`, [
    `auto:${id}`,
    JSON.stringify(target),
    JSON.stringify(arm ? { arm } : { basis: "backfill" }),
  ]);
}
const tl = async (d: PGlite, id: string, schema = "public") =>
  (await d.query<{ t: Timeline }>(`SELECT ${schema}.console_timeline($1) AS t`, [id])).rows[0].t;
const arm = (t: Timeline, name: string) => {
  const a = t.arms.find((x) => x.arm === name);
  assert(a, `時間軸沒有 ${name}`);
  return a;
};

Deno.test("正見：派工列照 target 歸屆（election_id、election_key、參選紀錄），沒有選舉＝日常；認不出型別的舊列不計", async () => {
  const d = await twDb();
  const key26 = (await d.query<{ k: string }>("SELECT election_key AS k FROM elections WHERE id = 2026")).rows[0].k;
  await d.exec("INSERT INTO politician_elections VALUES (501, 2022, '縣市長', NULL), (502, 2026, '村里長', NULL)");
  await dispatch(d, "r1", "raw:roster_check", { election_id: 2022, region: "臺北市" });
  await dispatch(d, "r2", "raw:roster_check", { election_id: "2022", region: "新北市" });
  await dispatch(d, "r3", "raw:roster_check", { election_id: 2026 });
  await dispatch(d, "e1", "election_results", { election_key: key26 === null ? "x" : "2022-11-26_local", election_id: "" });
  await dispatch(d, "t1", "term_policies", { politician_election_id: 501 });
  await dispatch(d, "p1", "raw:policy_missing", { politician_election_ids: [502, 501] });
  await dispatch(d, "k1", "raw:policy_missing", { election_id: key26 });
  await dispatch(d, "g1", "dup", { politician_id: "00000000-0000-0000-0000-000000000001" });
  await dispatch(d, "o1", null, { election_id: 2022 });

  const counts = (await d.query<{ arm: string; election_id: number | null; n: number }>(
    "SELECT arm, election_id, sum(n)::int AS n FROM console_arm_election_counts() WHERE n > 0 GROUP BY 1, 2 ORDER BY arm, election_id NULLS FIRST",
  )).rows;
  const e22key = (await d.query<{ k: string }>("SELECT election_key AS k FROM elections WHERE id = 2022")).rows[0].k;
  assertEquals(counts, [
    { arm: "dup", election_id: null, n: 1 },
    ...(e22key === "2022-11-26_local" ? [{ arm: "election_results", election_id: 2022, n: 1 }] : [{ arm: "election_results", election_id: null, n: 1 }]),
    { arm: "raw:policy_missing", election_id: 2026, n: key26 ? 2 : 1 },
    ...(key26 ? [] : [{ arm: "raw:policy_missing", election_id: null, n: 1 }]),
    { arm: "raw:roster_check", election_id: 2022, n: 2 },
    { arm: "raw:roster_check", election_id: 2026, n: 1 },
    { arm: "term_policies", election_id: 2022, n: 1 },
  ]);
});

/** 沒有 opened_by.arm 的舊列（P1 之前回填），用真的 task_id 寫法 */
async function legacy(d: PGlite, taskId: string, taskType: string, target: unknown) {
  await d.query(`INSERT INTO task_dispatches (task_id, task_type, target, opened_by) VALUES ($1, $2, $3::jsonb, '{"basis":"backfill"}'::jsonb)`, [
    taskId,
    taskType,
    JSON.stringify(target),
  ]);
}

Deno.test("正見：沒有臂名的舊列照任務型別歸回臂，時間軸與 console_arm_status 都算得到（主線 10-10）", async () => {
  const d = await twDb();
  const withPolicy = "00000000-0000-0000-0000-0000000000b1";
  const noPolicy = "00000000-0000-0000-0000-0000000000b2";
  await d.exec(`INSERT INTO politician_elections VALUES (601, 2022, '縣市長', '${withPolicy}'), (602, 2022, '縣市長', '${noPolicy}')`);
  await d.query("INSERT INTO policies (politician_id) VALUES ($1)", [withPolicy]);
  await legacy(d, "auto:election_results_missing:2022:縣市長:臺北市", "election_results_missing", { election_id: 2022, election_type: "縣市長" });
  await legacy(d, "auto:election_results_missing:2022:縣市長:新北市", "election_results_missing", { election_id: 2022, election_type: "縣市長" });
  await legacy(d, "auto:election_result_missing:601", "election_result_missing", { politician_id: withPolicy, politician_election_id: 601 });
  await legacy(d, "auto:election_result_missing:602", "election_result_missing", { politician_id: noPolicy, politician_election_id: 602 });
  await legacy(d, "auto:election_result_missing:cec:2022:臺北市", "election_result_missing", { election_id: 2022 });
  await legacy(d, "auto:roster_check:2022:縣市長:臺北市", "roster_check", { election_id: 2022, election_type: "縣市長" });
  await legacy(d, "auto:no_such_type:1", "no_such_type", { election_id: 2022 });

  const counts = (await d.query<{ arm: string; n: number }>(
    "SELECT arm, sum(n)::int AS n FROM console_arm_election_counts() WHERE election_id = 2022 GROUP BY 1 ORDER BY 1",
  )).rows;
  assertEquals(counts, [
    { arm: "elected_missing", n: 1 },
    { arm: "election_results", n: 3 },
    { arm: "raw:election_result_missing", n: 1 },
    { arm: "raw:roster_check", n: 1 },
  ], "election_results_missing 兩件＋沒有政見的那一件；有政見的歸 raw；cec 歸 elected_missing；認不出的不算");

  const status = new Map((await d.query<{ arm: string; queue_count: number | null }>("SELECT arm, queue_count FROM console_arm_status()")).rows
    .map((r) => [r.arm, r.queue_count]));
  assertEquals(status.get("election_results"), 3, "以前沒有臂名就不算，顯示「—」");
  assertEquals(status.get("raw:election_result_missing"), 1);
  assertEquals(status.get("elected_missing"), 1);

  const t22 = await tl(d, "2022");
  assertEquals([arm(t22, "election_results").election_count, arm(t22, "election_results").stale], [3, true]);
  assertEquals(arm(t22, "election_results").queue_count, 3);
});

Deno.test("正見：選 2022 只算 2022；名單清查、開票結果過段標 stale，任內政見不標；日常另計、不隨屆別變", async () => {
  const d = await twDb();
  await d.exec("INSERT INTO politician_elections VALUES (501, 2022, '縣市長', NULL), (502, 2026, '村里長', NULL)");
  await dispatch(d, "r1", "raw:roster_check", { election_id: 2022 });
  await dispatch(d, "r2", "raw:roster_check", { election_id: 2022 });
  await dispatch(d, "r3", "raw:roster_check", { election_id: 2026 });
  await dispatch(d, "e1", "election_results", { election_id: 2022 });
  await dispatch(d, "t1", "term_policies", { politician_election_id: 501 });
  await dispatch(d, "g1", "dup", {});

  const t22 = await tl(d, "2022");
  assertEquals([t22.election_total, t22.daily_total], [4, 1]);
  const rc = arm(t22, "raw:roster_check");
  assertEquals([rc.stage, rc.election_count, rc.daily_count, rc.stale], [3, 2, 0, true], "名單清查在第 3 段（10-10），2022 投票日已過");
  const er = arm(t22, "election_results");
  assertEquals([er.stage, er.election_count, er.stale], [4, 1, true]);
  assertEquals(er.stage_end, "2022-12-25", "開票段到就職日");
  const tp = arm(t22, "term_policies");
  assertEquals([tp.election_count, tp.stale], [1, false], "任內政見整個任期都有效");
  assertEquals(tp.stage_end, "2026-12-24");
  assertEquals([arm(t22, "dup").daily_count, arm(t22, "dup").election_count, arm(t22, "dup").stale], [1, 0, false]);
  assertEquals(arm(t22, "raw:roster_check").queue_count, 3, "全站件數照舊");

  const t26 = await tl(d, "2026");
  assertEquals([t26.election_total, t26.daily_total], [1, 1]);
  // 名單清查在第 3 段，到 2026 投票日（11-28）為止，今天還沒過段
  assertEquals([arm(t26, "raw:roster_check").election_count, arm(t26, "raw:roster_check").stale], [1, false]);
  assertEquals(arm(t26, "election_results").election_count, 0);
  assertEquals(arm(t26, "dup").daily_count, 1, "日常不隨屆別變");

  // 段的結束日
  const end = async (id: number, s: number) =>
    (await d.query<{ d: string | null }>("SELECT console_stage_end($1, $2::smallint)::text AS d", [id, s])).rows[0].d;
  assertEquals(await end(2026, 3), "2026-11-28");
  assertEquals(await end(2026, 2), "2026-09-04", "登記截止（各職位取最晚）");
  assertEquals(await end(2022, 2), "2022-11-26", "沒有登記截止里程碑就退到投票日");
  assertEquals(await end(2024, 4), "2024-05-20", "就職日各職位取最晚");
  assertEquals(await end(2026, 1), null);
  assertEquals(await end(2026, 7), null);
});

Deno.test("正見：各職位件數（target 的 election_type、參選紀錄、人物＋選舉）與各職位開關、覆寫；這一屆的每個職位都列出來", async () => {
  const d = await twDb();
  await d.exec("INSERT INTO politician_elections VALUES (501, 2026, '縣市長', NULL), (502, 2026, '村里長', NULL), (503, 2026, '縣市議員', '00000000-0000-0000-0000-0000000000aa')");
  await dispatch(d, "a", "raw:roster_check", { election_id: 2026, election_type: "村里長" });
  await dispatch(d, "b", "raw:roster_check", { election_id: 2026, election_type: "村里長" });
  await dispatch(d, "c", "raw:roster_check", { election_id: 2026, election_type: "縣市長" });
  await dispatch(d, "e", "raw:roster_check", { election_id: 2026 });
  await dispatch(d, "f", "raw:policy_missing", { politician_election_ids: [501] });
  await dispatch(d, "g", "raw:progress_stale", { election_id: 2026, politician_id: "00000000-0000-0000-0000-0000000000aa" });
  await d.query("SELECT console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)", ["raw:roster_check", 2026, "村里長", "closed", null, null, "測試", null, "t@example.com"]);

  const t = await tl(d, "2026");
  const rc = arm(t, "raw:roster_check");
  assertEquals(rc.election_count, 4);
  const types26 = (await d.query<{ t: string[] }>("SELECT election_types AS t FROM elections WHERE id = 2026")).rows[0].t;
  // 這一屆的每個職位都列出來（件數 0 也列），照選舉的職位順序；不分職位的排最後
  assertEquals(rc.by_type.map((b) => b.election_type), [...types26, null]);
  const by = Object.fromEntries(rc.by_type.map((b) => [b.election_type ?? "", b]));
  assertEquals([by["村里長"].n, by["縣市長"].n, by[""].n], [2, 1, 1]);
  assertEquals(rc.by_type.reduce((n, b) => n + b.n, 0), rc.election_count, "各職位加起來等於這一屆");
  assertEquals([by["村里長"].is_open, by["村里長"].overridden], [false, true], "只關村里長");
  assertEquals([by["縣市長"].is_open, by["縣市長"].overridden], [true, false]);
  assertEquals(arm(t, "raw:policy_missing").by_type.find((b) => b.election_type === "縣市長")?.n, 1, "從參選紀錄補職位");
  assertEquals(arm(t, "raw:progress_stale").by_type.find((b) => b.election_type === "縣市議員")?.n, 1, "從人物＋選舉補職位");
});

Deno.test("正見：anon 能讀件數與段的結束日、不能直接呼叫 console_dispatch_election；回應不含帳號資料", async () => {
  const d = await twDb();
  await d.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE anon");
    await tx.query("SELECT * FROM console_arm_election_counts()");
    await tx.query("SELECT console_stage_end(2026, 3::smallint)");
    await tx.query("SELECT console_timeline('2026')");
  });
  await assertRejects(() =>
    d.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE anon");
      await tx.query(`SELECT console_dispatch_election('{"election_id":2026}'::jsonb)`);
    })
  );
  const t = JSON.stringify(await tl(d, "2026"));
  assert(!t.includes("created_by") && !t.includes("@"));
});

// ---------------------------------------------------------------------------------------------------------------------
// 日本站
// ---------------------------------------------------------------------------------------------------------------------
const ELECTION = "2028-07-09_national_lower_national";
const OLD = "2027-04-11_mayor_regular_131016";

async function jpDb(): Promise<PGlite> {
  const before = (await migrationNames()).filter((n) => n.includes("_policy_jp_") && n < JP_MIG);
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  for (const n of before) await db.exec(await readMig(n));
  await db.exec(await readMig(JP_MIG));
  await db.exec(`INSERT INTO policy_jp.elections (id, name, election_date, notice_date, election_type, election_reason, level, review_status)
    VALUES ('${ELECTION}', '衆議院議員総選挙', '2028-07-09', '2028-06-27', 'national_lower', 'regular', 'national', 'published')`);
  return db;
}

Deno.test("日本站：只算這一屆、日常另計；投票日 +30 後開票段過段；anon 能讀、不能直接呼叫 console_dispatch_election", async () => {
  const d = await jpDb();
  await dispatch(d, "j1", "roster_check", { election_id: ELECTION }, "policy_jp");
  await dispatch(d, "j2", "roster_check", { election_id: "nope" }, "policy_jp");
  await dispatch(d, "j3", "election_discovery", { lg_code: "131016" }, "policy_jp");

  await d.exec("SET app.activity_today = '2028-06-01'");
  let t = await tl(d, ELECTION, "policy_jp");
  assertEquals([t.election_total, t.daily_total], [1, 2], "election_id 指到不存在的選舉算日常");
  assertEquals([arm(t, "roster_check").election_count, arm(t, "roster_check").daily_count, arm(t, "roster_check").stale], [1, 1, false]);
  assertEquals(arm(t, "roster_check").by_type.map((b) => [b.election_type, b.n]), [["national_lower", 1]], "沒寫職位就用那場選舉的職位");
  const end = async (s: number) =>
    (await d.query<{ d: string | null }>("SELECT policy_jp.console_stage_end($1, $2::smallint)::text AS d", [ELECTION, s])).rows[0].d;
  assertEquals([await end(2), await end(3), await end(4), await end(5)], ["2028-06-27", "2028-07-09", "2028-08-08", null]);

  await d.exec("SET app.activity_today = '2028-07-01'");
  t = await tl(d, ELECTION, "policy_jp");
  assertEquals(arm(t, "roster_check").stale, arm(t, "roster_check").stage <= 2, "告示日過了，第 2 段的件數標紅");

  await d.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE anon");
    await tx.query("SELECT * FROM policy_jp.console_arm_election_counts()");
    await tx.query("SELECT policy_jp.console_timeline($1)", [ELECTION]);
  });
  await assertRejects(() =>
    d.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE anon");
      await tx.query(`SELECT policy_jp.console_dispatch_election('{}'::jsonb)`);
    })
  );
  void OLD;
});

Deno.test("日本站：這支 migration 只碰 policy_jp 的物件", async () => {
  const stripped = (await readMig(JP_MIG)).replace(/--[^\n]*/g, "");
  const objs = [...stripped.matchAll(/\b(?:FUNCTION|TABLE|VIEW|INTO|POLICY\s+"[^"]+"\s+ON)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([\w."]+)/gi)].map((m) => m[1]);
  assert(objs.length >= 8, `抽到的物件太少（${objs.length}），抽取壞了？`);
  assertEquals(objs.filter((n) => !n.startsWith("policy_jp.") && !/^v_\w+$/.test(n)), []);
});
