/**
 * 日本站派工與交件 SQL（policy-jp PR①a；migration 20261009130000_policy_jp_dispatch.sql）的行為測試。
 *
 * 只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。PGlite 上只套 #479 的空 schema、tables migration、這支 migration——
 * 資料庫裡沒有任何正見（public）的派工物件，所以任何漏了 policy_jp. 前綴、悄悄退回 public 的引用都會在這裡直接壞掉（獨立性證明）。
 * 逐字走樣（跟正見的函式本體一致）不在這裡，在 policy-jp-dispatch-drift.test.ts。
 *
 *   1. 套用：只用 policy_jp、public 一個物件都沒有；套兩次都成功；三個角色用 CREATE ROLE 模擬
 *   2. 權限：新表全開 RLS；anon／authenticated 讀寫都被擋、也不能執行函式；service_role 全權
 *   3. 手動任務臂：新建 open 任務觸發器即時入列（網站請求 1970、維護者建 1980），gap_events 有 opened；contribution_queue_tasks 讀得到；關閉立刻收回
 *   4. 時間窗：activity_open 在假時鐘（SET app.activity_today）下含頭含尾；seed 在窗口外收回（reason=window）、窗口內補回（reopened）
 *   5. 共識：no_change 兩票（分數 2）verified、兩張反對 rejected、correction 要 3；系統票（照正見實際規則：correction 3→2／4，no_change 不吃一般系統票）
 *   6. 派工紀錄清理（抄正見 #485；policy-jp #498 審查補上）：超過保留天數的 verify_dispatches／contribution_task_skips 被刪、沒到期的不動（含派工綁定的 7 天內）、
 *      清理前後驗證池與派工綁定查詢逐筆相同、只動 policy_jp（同名的 public 表原封不動）、CHECK 下限擋掉太小的保留天數、分批／停用／審計／權限
 *   7. 其他：驗證池、seed 可重跑、cron 有就排程沒有就略過、自我檢查（還原驗證）
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const SCHEMA_SQL = await read("20261008195000_policy_jp_schema.sql");
const TABLES_SQL = await read("20261009000000_policy_jp_tables.sql");
const MIG = "20261009130000_policy_jp_dispatch.sql";
const MIG_SQL = await read(MIG);

const NEW_TABLES = [
  "task_priority_tiers", "contributions", "contribution_votes", "edit_history", "contribution_tasks", "contribution_task_leases",
  "contribution_task_skips", "verify_dispatches", "task_checks", "jev_decisions", "task_dispatches", "gap_events",
  "election_milestones", "activity_rules", "activity_overrides", "dispatch_records_settings",
];

function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `還原驗證：要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 60)}`);
  return sql.replace(from, () => to);
}

async function freshDb(mig = MIG_SQL, pre = ""): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  if (pre) await db.exec(pre);
  await db.exec(SCHEMA_SQL);
  await db.exec(TABLES_SQL);
  await db.exec(mig);
  return db;
}

async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}

const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

const ELECTION = "2028-07-09_national_lower_national";
async function addElection(db: PGlite) {
  await db.exec(`INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, review_status)
    VALUES ('${ELECTION}', '衆議院議員総選挙', '2028-07-09', 'national_lower', 'regular', 'national', 'published')`);
}
async function addTask(db: PGlite, source: string, title: string, target = "{}"): Promise<string> {
  const r = await one<{ id: string }>(db, `INSERT INTO policy_jp.contribution_tasks (title, task_type, source, target) VALUES ($1, 'policy_missing', $2, $3::jsonb) RETURNING id`, [title, source, target]);
  return r.id;
}

Deno.test("套用：public 一個派工物件都沒有、套兩次都成功、新表全開 RLS", async () => {
  const db = await freshDb();
  await db.exec(MIG_SQL); // 第二次
  const pubT = await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM pg_tables WHERE schemaname = 'public'`);
  assertEquals(pubT.n, 0, "public 不該有任何表");
  const pubF = await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'`);
  assertEquals(pubF.n, 0, "public 不該有任何函式");
  const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'policy_jp' AND c.relkind = 'r'`);
  for (const t of NEW_TABLES) assert(rls.rows.find((r) => r.relname === t)?.relrowsecurity, `${t} 沒開 RLS`);
  // 種子：三層優先層、兩支臂的規則、白名單
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_priority_tiers`)).n, 3);
  const rules = await db.query<{ activity: string }>(`SELECT activity FROM policy_jp.activity_rules ORDER BY activity`);
  assertEquals(rules.rows.map((r) => r.activity), ["manual_open", "manual_visitor", "priority:manual_visitor"]);
  assertEquals((await db.query(`SELECT * FROM policy_jp.activity_health`)).rows.length, 0, "健康檢查正常是空的");
  await db.close();
});

Deno.test("函式：沒有一個提到 public.；plpgsql 都釘 search_path；SECURITY DEFINER 恰好是正見那六支", async () => {
  const db = await freshDb();
  const bad = await db.query<{ proname: string }>(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'policy_jp' AND p.prosrc ~ 'public\\.'`);
  assertEquals(bad.rows, []);
  const unpinned = await db.query<{ proname: string }>(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'policy_jp' AND l.lanname = 'plpgsql' AND NOT (COALESCE(p.proconfig, '{}') @> ARRAY['search_path=policy_jp, pg_temp'])`);
  assertEquals(unpinned.rows, []);
  const definers = await db.query<{ proname: string }>(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'policy_jp' AND p.prosecdef ORDER BY 1`);
  assertEquals(definers.rows.map((r) => r.proname), [
    "contribution_tasks_drop_dispatch", "contribution_tasks_insert_dispatch", "task_dispatches_drop_applied",
    "task_dispatches_gap_after_delete", "task_dispatches_gap_after_insert", "task_dispatches_gap_before_insert",
  ]);
  await db.close();
});

Deno.test("權限：anon／authenticated 讀寫新表、執行函式都被擋；service_role 全權", async () => {
  const db = await freshDb();
  await addElection(db);
  for (const role of ["anon", "authenticated"]) {
    for (const t of NEW_TABLES) {
      await assertRejects(() => asRole(db, role, `SELECT * FROM policy_jp.${t}`), Error, "permission denied", `${role} 不該讀 ${t}`);
    }
    await assertRejects(() => asRole(db, role, `INSERT INTO policy_jp.contribution_tasks (title, task_type) VALUES ('x', 'y')`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT * FROM policy_jp.activity_health`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.queue_now()`), Error, "permission denied");
    await assertRejects(() => asRole(db, role, `SELECT policy_jp.seed_auto_task_queue()`), Error, "permission denied");
    // tables migration 給的兩支函式沒被這支收走
    assertEquals((await asRole<{ x: string }>(db, role, `SELECT policy_jp.election_level('governor') AS x`))[0].x, "regional");
  }
  // service_role：讀寫、跑 seed
  await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE service_role`);
    await tx.exec(`INSERT INTO policy_jp.contribution_tasks (title, task_type, source) VALUES ('t', 'policy_missing', 'manual')`);
  });
  // 觸發器（SECURITY DEFINER）替 service_role 入列；seed 本身用到暫存表，PGlite 的 template1 沒給 service_role TEMP 權限，所以由擁有者跑（其他測試）
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches`)).n, 1);
  await db.close();
});

Deno.test("手動任務臂：新任務即時入列（觸發器）、seed 對帳、讀得到、關閉立刻收回、gap_events 有紀錄", async () => {
  const db = await freshDb();
  const web = await addTask(db, "web_request", "網站請求");
  const manual = await addTask(db, "manual", "維護者任務");
  const sug = await addTask(db, "suggested", "外部提議");
  const rows = await db.query<{ task_id: string; queue_at: string; priority: number | null; opened_by: Record<string, unknown> }>(
    `SELECT task_id, queue_at::TEXT, priority, opened_by FROM policy_jp.task_dispatches ORDER BY task_id`);
  assertEquals(rows.rows.length, 3);
  const by = Object.fromEntries(rows.rows.map((r) => [r.task_id, r]));
  assert(by[web].queue_at.startsWith("1970-01-01"), "網站請求 1970");
  assert(by[manual].queue_at.startsWith("1980-01-01"), "維護者建的 1980");
  assert(!by[sug].queue_at.startsWith("19"), "外部提議排隊尾");
  assertEquals(by[web].priority, 1, "網站請求在前段");
  assertEquals(by[manual].opened_by.basis, "task_insert");
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE event = 'opened'`)).n, 3);

  // seed：總表也算得出這三筆（規則永遠開），不新增、不報錯；可重跑
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches`)).n, 3);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events`)).n, 3, "seed 沒有重複寫出生紀錄");

  const q = await db.query<{ task_id: string; task_type: string; queue_at: string }>(`SELECT task_id, task_type, queue_at::TEXT FROM policy_jp.contribution_queue_tasks(NULL, NULL, 10, '')`);
  assertEquals(q.rows.length, 3);
  assertEquals(q.rows[0].task_id, web, "1970 的在最前");
  const counts = await db.query<{ task_type: string; total: number }>(`SELECT task_type, total::INT AS total FROM policy_jp.contribution_queue_task_counts()`);
  assertEquals(counts.rows, [{ task_type: "policy_missing", total: 3 }]);
  // /tasks 用的 contribution_auto_tasks 只回 auto: 列
  assertEquals((await db.query(`SELECT * FROM policy_jp.contribution_auto_tasks(NULL, NULL, 10, '')`)).rows.length, 0);

  // 派出：回隊尾
  await db.query(`SELECT policy_jp.task_dispatched($1)`, [web]);
  const after = await one<{ queue_at: string; dispatch_count: number }>(db, `SELECT queue_at::TEXT, dispatch_count FROM policy_jp.task_dispatches WHERE task_id = $1`, [web]);
  assert(!after.queue_at.startsWith("19"));
  assertEquals(after.dispatch_count, 1);

  // 關閉任務：立刻收回，gap_events 寫 closed（filled）
  await db.query(`UPDATE policy_jp.contribution_tasks SET status = 'closed' WHERE id = $1`, [manual]);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches WHERE task_id = $1`, [manual])).n, 0);
  const closed = await one<{ reason: string; detail: Record<string, unknown> }>(db, `SELECT reason, detail FROM policy_jp.gap_events WHERE task_id = $1 AND event = 'closed'`, [manual]);
  assertEquals(closed.reason, "filled");
  assertEquals(closed.detail.via, "task_closed");
  // 重開：reopened
  await db.query(`UPDATE policy_jp.contribution_tasks SET status = 'open' WHERE id = $1`, [manual]);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE task_id = $1 AND event = 'reopened'`, [manual])).n, 1);
  // gap_events 只增不刪
  await assertRejects(() => db.query(`DELETE FROM policy_jp.gap_events`), Error, "只增不刪");
  await assertRejects(() => db.query(`UPDATE policy_jp.gap_events SET reason = 'window'`), Error, "只增不刪");

  // 貢獻上線（applied）：補完就關的手動任務收回派工列
  const c = await one<{ id: string }>(db, `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash)
    VALUES ('correction', '{}', ARRAY['https://example.jp/a'], $1, 'agent-a', 'ip-a', 'h1') RETURNING id`, [sug]);
  await db.query(`UPDATE policy_jp.contributions SET status = 'applied' WHERE id = $1`, [c.id]);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches WHERE task_id = $1`, [sug])).n, 0);
  await db.close();
});

Deno.test("時間窗：activity_open 假時鐘含頭含尾；seed 窗口外收回（window）、窗口內補回（reopened）", async () => {
  const db = await freshDb();
  await addElection(db);
  await db.exec(`INSERT INTO policy_jp.election_milestones (election_id, kind, on_date, basis, status) VALUES ('${ELECTION}', 'registration_close', '2028-06-22', 'official', 'announced')`);
  // 里程碑的審計進 edit_history
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.edit_history WHERE table_name = 'election_milestones'`)).n, 1);
  await db.exec(`INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, until_kind, levels, election_types) VALUES
    ('test_arm', 'event', 'registration_close', 'polling', ARRAY['national'], ARRAY['national_lower'])`);
  const open = async (day: string, type: string | null = "national_lower") => {
    await db.exec(`SET app.activity_today = '${day}'`);
    return (await db.query(`SELECT o.*, o.expected_open_on::TEXT AS xo FROM policy_jp.activity_open('test_arm', '${ELECTION}', ${type ? `'${type}'` : "NULL"}) o`)).rows;
  };
  assertEquals((await open("2028-06-21")).length, 0, "起日前一天關");
  const first = (await open("2028-06-22"))[0] as Record<string, unknown>;
  assert(first, "起日當天開");
  assertEquals(first.milestone_kind, "registration_close");
  assertEquals(first.xo, "2028-06-22");
  assertEquals((await open("2028-07-09")).length, 1, "迄日（投票日）當天還開");
  assertEquals((await open("2028-07-10")).length, 0, "迄日隔天關");
  assertEquals((await open("2028-07-01", "governor")).length, 0, "職位不符（levels／election_types）關");
  assertEquals((await open("2028-07-01", null)).length, 0, "職位未知，有限定職位的規則比對不到");
  // 缺里程碑＝關
  await db.exec(`DELETE FROM policy_jp.election_milestones`);
  assertEquals((await open("2028-07-01")).length, 0, "缺里程碑 fail closed");
  await db.exec(`INSERT INTO policy_jp.election_milestones (election_id, kind, on_date, basis, status) VALUES ('${ELECTION}', 'registration_close', '2028-06-22', 'official', 'announced')`);
  // 覆寫：closed 優先
  await db.exec(`INSERT INTO policy_jp.activity_overrides (activity, "force", reason) VALUES ('test_arm', 'closed', '測試')`);
  assertEquals((await open("2028-07-01")).length, 0, "覆寫 closed 優先");
  await db.exec(`DELETE FROM policy_jp.activity_overrides`);
  // 時鐘被覆寫時，健康檢查看得到
  const health = await db.query<{ check_name: string }>(`SELECT check_name FROM policy_jp.activity_health`);
  assertEquals(health.rows.map((r) => r.check_name), ["clock_overridden"]);
  await db.exec(`RESET app.activity_today`);

  // 端到端：manual_open 臂改成窗口規則（登記截止起、投票日止），任務 target 帶這場選舉
  await db.exec(`UPDATE policy_jp.activity_rules SET window_kind = 'event', from_kind = 'registration_close', until_kind = 'polling' WHERE activity = 'manual_open'`);
  const t = await addTask(db, "manual", "選舉任務", JSON.stringify({ election_id: ELECTION, election_type: "national_lower" }));
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches WHERE task_id = $1`, [t])).n, 1, "觸發器即時入列（不過窗口，seed 對帳）");
  await db.exec(`SET app.activity_today = '2028-06-01'`);
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches WHERE task_id = $1`, [t])).n, 0, "窗口外：seed 收回");
  const closed = await one<{ reason: string }>(db, `SELECT reason FROM policy_jp.gap_events WHERE task_id = $1 AND event = 'closed'`, [t]);
  assertEquals(closed.reason, "window", "臂還算得出來、窗口關了＝window");
  await db.exec(`SET app.activity_today = '2028-06-22'`);
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  const back = await one<{ opened_by: Record<string, unknown> }>(db, `SELECT opened_by FROM policy_jp.task_dispatches WHERE task_id = $1`, [t]);
  assertEquals(back.opened_by.rule_id !== undefined, true);
  assertEquals(back.opened_by.milestone_kind, "registration_close");
  assertEquals(back.opened_by.election_id, ELECTION);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.gap_events WHERE task_id = $1 AND event = 'reopened'`, [t])).n, 1);
  // 窗口結束後再收回
  await db.exec(`SET app.activity_today = '2028-07-10'`);
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches WHERE task_id = $1`, [t])).n, 0);
  await db.close();
});

Deno.test("固定時段插隊：台北改 Asia/Tokyo 時區的整點時段（假時鐘 app.queue_now）", async () => {
  const db = await freshDb();
  const web = await addTask(db, "web_request", "網站請求");
  await db.query(`SELECT policy_jp.task_dispatched($1)`, [web]); // 派過，回隊尾
  assert(!(await one<{ q: string }>(db, `SELECT queue_at::TEXT AS q FROM policy_jp.task_dispatches WHERE task_id = $1`, [web])).q.startsWith("19"));
  // 東京 12:05 = UTC 03:05，在時段內（每 6 小時的前 20 分鐘）；派出時間早於時段開始
  await db.exec(`SET app.queue_now = '2099-01-01 03:05:00+00'`);
  assertEquals((await one<{ s: string }>(db, `SELECT policy_jp.visitor_front_slot_start()::TEXT AS s`)).s, "2099-01-01 03:00:00+00");
  await db.exec(`UPDATE policy_jp.task_dispatches SET last_dispatched_at = '2098-12-31 00:00:00+00'`);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.manual_front_pull() AS n`)).n, 1);
  assert((await one<{ q: string }>(db, `SELECT queue_at::TEXT AS q FROM policy_jp.task_dispatches WHERE task_id = $1`, [web])).q.startsWith("1970-01-01"));
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.manual_front_pull() AS n`)).n, 0, "第二次冪等");
  // 時段外什麼都不做
  await db.exec(`SET app.queue_now = '2099-01-01 03:30:00+00'`);
  assertEquals((await one<{ s: string | null }>(db, `SELECT policy_jp.visitor_front_slot_start()::TEXT AS s`)).s, null);
  assert((await db.query<{ check_name: string }>(`SELECT check_name FROM policy_jp.activity_health`)).rows.some((r) => r.check_name === "queue_clock_overridden"));
  await db.close();
});

async function addContribution(db: PGlite, type: string, n: number): Promise<string> {
  const r = await one<{ id: string }>(db, `INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, agent_name, contributor_ip_hash, payload_hash)
    VALUES ($1, '{}', ARRAY['https://example.jp/a'], 'author-' || $2::TEXT, 'author-ip-' || $2::TEXT, 'h' || $2::TEXT) RETURNING id`, [type, n]);
  return r.id;
}
async function vote(db: PGlite, id: string, who: string, verdict: string) {
  await db.query(`INSERT INTO policy_jp.contribution_votes (contribution_id, verdict, agent_name, verifier_ip_hash) VALUES ($1, $2, $3, 'ip-' || $3)`, [id, verdict, who]);
}
const status = async (db: PGlite, id: string) => await one<{ status: string; score: number; target_score: number }>(db, `SELECT status, score, target_score FROM policy_jp.contributions WHERE id = $1`, [id]);

Deno.test("共識：no_change 分數 2 verified、兩張反對 rejected、correction 要 3；一人一票以最新為準", async () => {
  const db = await freshDb();
  const nc = await addContribution(db, "no_change", 1);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.contribution_required_agree('no_change', '{}', ARRAY[]::TEXT[]) AS n`)).n, 2);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.contribution_required_agree('task_suggestion', '{}', ARRAY[]::TEXT[]) AS n`)).n, 2);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.contribution_required_agree('correction', '{}', ARRAY[]::TEXT[]) AS n`)).n, 3);
  await vote(db, nc, "v1", "agree");
  assertEquals((await status(db, nc)).status, "pending");
  await vote(db, nc, "v2", "agree");
  const s = await status(db, nc);
  assertEquals([s.status, s.score, s.target_score], ["verified", 2, 2]);

  const rej = await addContribution(db, "no_change", 2);
  await vote(db, rej, "v1", "disagree");
  assertEquals((await status(db, rej)).status, "pending");
  await vote(db, rej, "v2", "disagree");
  assertEquals((await status(db, rej)).status, "rejected");

  const co = await addContribution(db, "correction", 3);
  await vote(db, co, "v1", "agree");
  await vote(db, co, "v2", "agree");
  assertEquals((await status(db, co)).status, "pending", "correction 兩票不夠");
  await vote(db, co, "v3", "agree");
  assertEquals((await status(db, co)).status, "verified");
  // 驗證列：pending 進來就有 verify:，離開 pending 後 seed 收掉
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%'`)).n, 3);
  await db.query(`SELECT policy_jp.seed_auto_task_queue()`);
  assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%'`)).n, 0);
  // 類型 CHECK：日本版只收三種
  await assertRejects(() => addContribution(db, "candidacy", 9), Error, "contributions_contribution_type_check");
  await db.close();
});

Deno.test("系統票（照正見的實際規則）：correction supported 目標 3→2、not_supported 升到 4、機率不到門檻不算；no_change／task_suggestion 不吃一般系統票", async () => {
  const db = await freshDb();
  const target = async (id: string) => (await one<{ n: number }>(db, `SELECT policy_jp.contribution_effective_agree($1) AS n`, [id])).n;
  const decide = async (id: string, choice: string, p: number, model = "typesafe/jev-1.13-20260917") =>
    await db.query(`INSERT INTO policy_jp.jev_decisions (subject_type, subject_id, question, choice, probability, model, state)
      VALUES ('contribution', $1, 'source_support', $2, $3, $4, '{}')`, [id, choice, p, model]);

  assertEquals((await one<{ n: number | null }>(db, `SELECT policy_jp.contribution_effective_agree($1) AS n`, ["00000000-0000-0000-0000-000000000000"])).n, null);
  const co0 = await addContribution(db, "correction", 1);
  assertEquals(await target(co0), 3, "沒有系統票＝3");

  const sup = await addContribution(db, "correction", 2);
  await decide(sup, "supported", 0.99);
  assertEquals(await target(sup), 2, "supported：3 → 2");
  await vote(db, sup, "v1", "agree");
  assertEquals((await status(db, sup)).status, "pending");
  await vote(db, sup, "v2", "agree");
  const s = await status(db, sup);
  assertEquals([s.status, s.target_score], ["verified", 2], "有系統票，兩票就上線");

  const nsup = await addContribution(db, "correction", 3);
  await decide(nsup, "not_supported", 0.99);
  assertEquals(await target(nsup), 4, "not_supported：3 → 4");
  for (const v of ["v1", "v2", "v3"]) await vote(db, nsup, v, "agree");
  assertEquals((await status(db, nsup)).status, "pending", "三票不夠");
  await vote(db, nsup, "v4", "agree");
  assertEquals((await status(db, nsup)).status, "verified");

  const low = await addContribution(db, "correction", 4);
  await decide(low, "supported", 0.5);
  assertEquals(await target(low), 3, "機率 0.5 < 門檻 0.95，不算系統票");

  // no_change（2）與 task_suggestion 不在 system_vote_eligible 內：一般 Jev 判決不調它們的門檻
  const nc = await addContribution(db, "no_change", 5);
  await decide(nc, "supported", 0.99);
  assertEquals(await target(nc), 2, "no_change 不吃一般系統票");
  const ts = await addContribution(db, "task_suggestion", 6);
  await decide(ts, "supported", 0.99);
  assertEquals(await target(ts), 2);
  // 例外（正見原樣）：model 以 policy-tw/moi-check 開頭的判決任何型別都算（內政部名冊核對；日本站目前沒人寫這種判決）
  const moi = await addContribution(db, "no_change", 7);
  await decide(moi, "supported", 0.99, "policy-tw/moi-check-test");
  assertEquals(await target(moi), 1);
  assertEquals((await one<{ p: string }>(db, `SELECT policy_jp.system_one_min_probability()::TEXT AS p`)).p, "0.95");
  // 同 state 同模型只能一列（不能重骰）
  await assertRejects(() => decide(sup, "supported", 0.99), Error, "jev_decisions_once_per_state");
  await db.close();
});

Deno.test("驗證池：別人的待驗證才派給你、自己交的不派、已投過的不派", async () => {
  const db = await freshDb();
  const a = await addContribution(db, "no_change", 1); // 作者 ip：author-ip-1
  const pool = async (ip: string) => (await db.query<{ id: string; effective_required: number }>(`SELECT id, effective_required FROM policy_jp.contribution_verify_pool($1, NULL, 30, NULL)`, [ip])).rows;
  assertEquals((await pool("author-ip-1")).length, 0, "自己交的不派給自己");
  const p = await pool("ip-other");
  assertEquals(p.map((r) => r.id), [a]);
  assertEquals(p[0].effective_required, 2);
  await vote(db, a, "other", "agree");
  assertEquals((await pool("ip-other")).length, 0, "已投過的不再派");
  await db.close();
});

Deno.test("refresh_dispatch_blocked／leases：飽和與冷卻標記、過期租約清掉", async () => {
  const db = await freshDb();
  const t = await addTask(db, "manual", "t");
  // 派工列手動造一筆 auto: 缺口，標記冷卻（task_checks 14 天內）與飽和（5 筆在途貢獻）
  await db.exec(`INSERT INTO policy_jp.task_dispatches (task_id, dispatch_count, queue_at, task_type, target, what_we_need) VALUES ('auto:x:1', 0, now(), 'policy_missing', '{}', 'x'), ('auto:x:2', 0, now(), 'policy_missing', '{}', 'y')`);
  await db.exec(`INSERT INTO policy_jp.task_checks (task_id, outcome) VALUES ('auto:x:1', 'not_found')`);
  for (let i = 0; i < 5; i++) await db.query(`INSERT INTO policy_jp.contributions (contribution_type, payload, source_urls, task_id, agent_name, contributor_ip_hash, payload_hash) VALUES ('correction', '{}', ARRAY['https://example.jp/a'], 'auto:x:2', 'ag-' || $1::TEXT, 'ip' || $1::TEXT, 'hh' || $1::TEXT)`, [i]);
  await db.query(`SELECT policy_jp.refresh_dispatch_blocked()`);
  const r = await db.query<{ task_id: string; blocked: boolean; cooling: boolean }>(`SELECT task_id, blocked, cooling FROM policy_jp.task_dispatches WHERE task_id LIKE 'auto:%' ORDER BY 1`);
  assertEquals(r.rows, [{ task_id: "auto:x:1", blocked: false, cooling: true }, { task_id: "auto:x:2", blocked: true, cooling: false }]);
  assertEquals((await db.query<{ task_id: string }>(`SELECT * FROM policy_jp.contribution_queue_tasks(NULL, NULL, 10, '')`)).rows.filter((x) => x.task_id.startsWith("auto:")).length, 0, "冷卻中與飽和的不派");
  await db.exec(`INSERT INTO policy_jp.contribution_task_leases (task_id, target_key, agent_name, ip_hash, leased_until) VALUES ('old', 'task:old', 'a', 'i', now() - interval '1 hour')`);
  assertEquals((await one<{ n: number }>(db, `SELECT policy_jp.contribution_task_leases_purge() AS n`)).n, 1);
  assert(t);
  await db.close();
});

/**
 * 派工紀錄清理的情境：各種年紀的 verify_dispatches 與 contribution_task_skips，外加 public 的同名假表（證明只動 policy_jp）。
 * 回傳哪裡不對（空＝沒問題）。mig 可以是改壞的 migration（還原驗證）。
 */
async function purgeScenario(mig = MIG_SQL): Promise<string[]> {
  const problems: string[] = [];
  const db = await freshDb(mig);
  try {
    // 同名的 public 假表：清理若跑錯 schema，這裡的舊列會被刪（設定表停用＝若讀到它，policy_jp 的清理就什麼都不刪，筆數檢查會紅）
    await db.exec(`
      CREATE TABLE public.verify_dispatches (contribution_id UUID, ip_hash TEXT, agent_name TEXT, dispatched_at TIMESTAMPTZ);
      CREATE TABLE public.contribution_task_skips (task_id TEXT, ip_hash TEXT, agent_name TEXT, skipped_at TIMESTAMPTZ);
      CREATE TABLE public.dispatch_records_settings (id SMALLINT PRIMARY KEY, enabled BOOLEAN, verify_dispatches_days INT, task_skips_days INT, batch_size INT, max_batches INT);
      INSERT INTO public.verify_dispatches VALUES (gen_random_uuid(), 'A', 'pub', now() - interval '90 days');
      INSERT INTO public.contribution_task_skips VALUES ('auto:pub', 'A', 'pub', now() - interval '90 days');
      INSERT INTO public.dispatch_records_settings VALUES (1, false, 8, 2, 100, 1);`);
    // 6 筆別人交的待驗證貢獻，各派給 A 一次，年紀不同（邊界附近留 1 小時以上的空隙）；B 台機器再派兩筆
    const ages = ["5 minutes", "6 days", "8 days", "13 days", "15 days", "40 days"];
    const ids: string[] = [];
    for (const [i, age] of ages.entries()) {
      const id = await addContribution(db, "no_change", i + 1);
      ids.push(id);
      await db.query(`INSERT INTO policy_jp.verify_dispatches (contribution_id, ip_hash, agent_name, dispatched_at) VALUES ($1, 'A', 'agent-a', now() - interval '${age}')`, [id]);
    }
    await db.query(`INSERT INTO policy_jp.verify_dispatches (contribution_id, ip_hash, agent_name, dispatched_at) VALUES ($1, 'B', 'agent-b', now() - interval '1 hour'), ($2, 'B', 'agent-b', now() - interval '30 days')`, [ids[0], ids[5]]);
    for (const [i, age] of ["1 hour", "3 days", "6 days 23 hours", "8 days", "30 days"].entries()) {
      await db.query(`INSERT INTO policy_jp.contribution_task_skips (task_id, ip_hash, agent_name, skipped_at) VALUES ($1, 'A', 'agent-a', now() - interval '${age}')`, [`auto:t${i}`]);
    }
    // 程式讀這兩張表的方式：驗證池（剛派的 15 分鐘）、日本版 verify-handler 的派工綁定（7 天）、jp-next 每台機器 2:1（3 小時）
    const snapshot = async () => ({
      pool: (await db.query<{ id: string }>(`SELECT id FROM policy_jp.contribution_verify_pool('A', NULL, 200, NULL) ORDER BY queue_at, id`)).rows.map((r) => r.id),
      binding: await Promise.all(ids.map(async (id) => (await db.query(`SELECT 1 FROM policy_jp.verify_dispatches WHERE contribution_id = $1 AND ip_hash = 'A' AND dispatched_at >= now() - make_interval(days => 7)`, [id])).rows.length > 0)),
      machine: (await db.query(`SELECT dispatched_at::TEXT FROM policy_jp.verify_dispatches WHERE ip_hash = 'A' AND dispatched_at >= now() - make_interval(hours => 3) ORDER BY dispatched_at DESC LIMIT 3`)).rows,
    });
    const count = async (t: string) => (await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.${t}`)).n;
    const before = await snapshot();
    const [vd0, sk0] = [await count("verify_dispatches"), await count("contribution_task_skips")];
    const res = (await one<{ r: Record<string, unknown> }>(db, `SELECT policy_jp.dispatch_records_purge() AS r`)).r;
    const after = await snapshot();
    const [vd1, sk1] = [await count("verify_dispatches"), await count("contribution_task_skips")];

    if (JSON.stringify(before) !== JSON.stringify(after)) problems.push("清理前後驗證池／派工綁定／每台機器 2:1 的查詢結果不同");
    // 不是空轉：A 的 15 天、40 天 ＋ B 的 30 天 ＝ 3 筆；skips 的 8 天、30 天 ＝ 2 筆；其餘（含派工綁定 7 天內的 6 天前、超過 7 天但沒滿 14 天的 8 天與 13 天）都留著
    if (vd0 - vd1 !== 3) problems.push(`verify_dispatches 該刪 3 筆，實際 ${vd0 - vd1}`);
    if (sk0 - sk1 !== 2) problems.push(`contribution_task_skips 該刪 2 筆，實際 ${sk0 - sk1}`);
    if (res.verify_dispatches !== 3 || res.contribution_task_skips !== 2 || res.enabled !== true) problems.push(`回傳的刪除筆數不對：${JSON.stringify(res)}`);
    if ((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.verify_dispatches WHERE dispatched_at < now() - interval '14 days'`)).n !== 0) problems.push("還有超過 14 天的 verify_dispatches");
    if ((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.verify_dispatches WHERE dispatched_at > now() - interval '14 days'`)).n !== 5) problems.push("沒到期的 verify_dispatches 應剩 5 筆");
    // 情境要真的有東西可比：池子排除剛派的、機器查詢有東西、綁定有真有假
    if ((before.pool as string[]).includes(ids[0]) || !(before.pool as string[]).includes(ids[1])) problems.push("情境沒造好：驗證池應排除 5 分鐘前派的、保留 6 天前派的");
    if (before.machine.length !== 1) problems.push("情境沒造好：機器查詢應有 1 筆（3 小時內只有 5 分鐘前那筆）");
    if (JSON.stringify(before.binding) !== JSON.stringify([true, true, false, false, false, false])) problems.push(`情境沒造好：派工綁定（7 天）應是 [真,真,假,假,假,假]，實際 ${JSON.stringify(before.binding)}`);
    // public 的同名表一列都沒動
    for (const t of ["verify_dispatches", "contribution_task_skips"]) {
      if ((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM public.${t}`)).n !== 1) problems.push(`public.${t} 被動到了`);
    }
  } finally {
    await db.close();
  }
  return problems;
}

Deno.test("派工紀錄清理：超過保留天數的刪、沒到期的不動；清理前後驗證池與派工綁定查詢逐筆相同；只動 policy_jp，public 同名表原封不動", async () => {
  assertEquals(await purgeScenario(), []);
});

Deno.test("派工紀錄清理的還原驗證：不看時間全刪、什麼都不刪、跳過紀錄保留期改壞、掃到 public、停用不生效——情境必須紅", async () => {
  const mustBeRed = async (name: string, mig: string) => assert((await purgeScenario(mig)).length > 0, `${name}：改壞了卻沒被抓到`);
  await mustBeRed("verify_dispatches 不看保留期全刪", mutate(MIG_SQL, "WHERE dispatched_at < now() - make_interval(days => s.verify_dispatches_days)", "WHERE dispatched_at < now()"));
  await mustBeRed("什麼都不刪", mutate(MIG_SQL, "WHERE dispatched_at < now() - make_interval(days => s.verify_dispatches_days)", "WHERE dispatched_at < now() - interval '1000 days'"));
  await mustBeRed("skips 保留期改壞", mutate(MIG_SQL, "WHERE skipped_at < now() - make_interval(days => s.task_skips_days)", "WHERE skipped_at < now() - interval '1 hour'"));
  // 改成讀／刪 public（自我檢查會讓 migration 直接失敗，連情境都跑不起來；兩種紅法都算抓到）
  const toPublic = mutate(MIG_SQL, "DELETE FROM policy_jp.contribution_task_skips d", "DELETE FROM public.contribution_task_skips d");
  await assertRejects(() => purgeScenario(toPublic), Error, "public.");
  // 停用旗標沒生效：停用時照刪
  const db = await freshDb(mutate(MIG_SQL, "IF NOT FOUND OR NOT s.enabled THEN", "IF NOT FOUND THEN"));
  try {
    const c = await addContribution(db, "no_change", 1);
    await db.query(`INSERT INTO policy_jp.verify_dispatches (contribution_id, ip_hash, dispatched_at) VALUES ($1, 'A', now() - interval '40 days')`, [c]);
    await db.exec(`UPDATE policy_jp.dispatch_records_settings SET enabled = false WHERE id = 1`);
    await db.query(`SELECT policy_jp.dispatch_records_purge()`);
    assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.verify_dispatches`)).n, 0, "改壞的版本停用也會刪（證明下面的停用檢查看得出來）");
  } finally {
    await db.close();
  }
});

Deno.test("派工紀錄清理的設定：欄位 CHECK 擋掉不安全的保留天數；停用不刪；分批上限；改值進審計；只有 service_role 能執行；migration 重跑不多一列", async () => {
  const db = await freshDb();
  try {
    // 下限：verify_dispatches_days ≥ 8（必須大於派工綁定的 7 天）、task_skips_days ≥ 2
    for (const bad of ["verify_dispatches_days = 7", "verify_dispatches_days = 1", "verify_dispatches_days = 366", "task_skips_days = 1", "batch_size = 99999999", "batch_size = 99", "max_batches = 0"]) {
      await assertRejects(() => db.exec(`UPDATE policy_jp.dispatch_records_settings SET ${bad} WHERE id = 1`), Error, "violates check constraint", `${bad} 應被 CHECK 擋掉`);
    }
    await db.exec(`UPDATE policy_jp.dispatch_records_settings SET verify_dispatches_days = 8, task_skips_days = 2 WHERE id = 1`); // 下限本身可以
    await db.exec(`UPDATE policy_jp.dispatch_records_settings SET verify_dispatches_days = 14, task_skips_days = 7 WHERE id = 1`);
    await assertRejects(() => db.exec(`INSERT INTO policy_jp.dispatch_records_settings (id) VALUES (2)`), Error, "violates check constraint");
    assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.dispatch_records_settings`)).n, 1);

    // 停用：照跑但什麼都不刪
    for (let i = 1; i <= 250; i++) await addContribution(db, "no_change", i);
    await db.exec(`INSERT INTO policy_jp.verify_dispatches (contribution_id, ip_hash, dispatched_at) SELECT id, 'A', now() - interval '30 days' FROM policy_jp.contributions`);
    await db.exec(`UPDATE policy_jp.dispatch_records_settings SET enabled = false, note = '測試停用' WHERE id = 1`);
    assertEquals((await one<{ r: unknown }>(db, `SELECT policy_jp.dispatch_records_purge() AS r`)).r, { enabled: false, verify_dispatches: 0, contribution_task_skips: 0 });
    assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM policy_jp.verify_dispatches`)).n, 250);

    // 分批：每批 100、最多 2 批 → 一次最多 200，沒刪完的下一次接著刪
    await db.exec(`UPDATE policy_jp.dispatch_records_settings SET enabled = true, batch_size = 100, max_batches = 2 WHERE id = 1`);
    const run = async () => (await one<{ r: Record<string, unknown> }>(db, `SELECT policy_jp.dispatch_records_purge() AS r`)).r.verify_dispatches;
    assertEquals([await run(), await run(), await run()], [200, 50, 0]);

    // 審計：每次改設定一列，agent_name = activity-audit，寫進 policy_jp.edit_history
    const audit = await db.query<{ agent_name: string; d: string; b: string }>(
      `SELECT agent_name, new_value->>'verify_dispatches_days' AS d, new_value->>'batch_size' AS b FROM policy_jp.edit_history WHERE table_name = 'dispatch_records_settings' ORDER BY id`);
    assert(audit.rows.length >= 3, "每次修改各一列審計（初始那一列在觸發器建立之前就插了，沒有審計）");
    assertEquals(audit.rows[audit.rows.length - 1], { agent_name: "activity-audit", d: "14", b: "100" });

    // 權限：函式只有 service_role 能執行；設定表 anon／authenticated 讀寫都被擋（通用的表權限測試也涵蓋）
    const can = async (role: string) => (await one<{ ok: boolean }>(db, `SELECT has_function_privilege('${role}', 'policy_jp.dispatch_records_purge()', 'EXECUTE') AS ok`)).ok;
    assertEquals([await can("service_role"), await can("anon"), await can("authenticated")], [true, false, false]);
    for (const role of ["anon", "authenticated"]) {
      await assertRejects(() => asRole(db, role, `SELECT policy_jp.dispatch_records_purge()`), Error, "permission denied");
      await assertRejects(() => asRole(db, role, `SELECT * FROM policy_jp.dispatch_records_settings`), Error, "permission denied");
      await assertRejects(() => asRole(db, role, `UPDATE policy_jp.dispatch_records_settings SET enabled = false`), Error, "permission denied");
    }
    // 沒有 Public read 那種 policy：內部表慣例（只有擁有者與 service_role 的 BYPASSRLS 讀得到）
    assertEquals((await one<{ n: number }>(db, `SELECT count(*)::INT AS n FROM pg_policies WHERE schemaname = 'policy_jp' AND tablename = 'dispatch_records_settings'`)).n, 0);

    // migration 重跑：不多一列設定、不覆蓋已改的值
    await db.exec(MIG_SQL);
    assertEquals((await one<{ n: number; b: number }>(db, `SELECT count(*)::INT AS n, max(batch_size)::INT AS b FROM policy_jp.dispatch_records_settings`)), { n: 1, b: 100 });
  } finally {
    await db.close();
  }
});

Deno.test("排程與自我檢查：有 pg_cron 就排、沒有就略過；還原驗證（拿掉 RLS／給 anon 權限／加 public. 引用）會讓 migration 失敗", async () => {
  // 有 cron
  const cron = `CREATE SCHEMA cron; CREATE TABLE cron.job (jobname TEXT, schedule TEXT, command TEXT);
    CREATE FUNCTION cron.schedule(a TEXT, b TEXT, c TEXT) RETURNS BIGINT LANGUAGE sql AS $$ INSERT INTO cron.job VALUES (a, b, c) RETURNING 1::BIGINT $$;
    CREATE FUNCTION cron.unschedule(a TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = a RETURNING true $$;`;
  const withCron = await freshDb(MIG_SQL, cron);
  await withCron.exec(MIG_SQL); // 第二次：先 unschedule 再 schedule，只留一條
  const job = await withCron.query<{ jobname: string; schedule: string; command: string }>(`SELECT * FROM cron.job ORDER BY jobname`);
  assertEquals(job.rows, [
    { jobname: "policy-jp-dispatch-records-purge", schedule: "55 19 * * *", command: "SELECT policy_jp.dispatch_records_purge();" },
    { jobname: "policy-jp-seed-10min", schedule: "*/10 * * * *", command: "SELECT policy_jp.seed_auto_task_queue();" },
  ]);
  await withCron.close();

  // 還原驗證
  const mustFail = async (name: string, sql: string, msg: string) => {
    await assertRejects(() => freshDb(sql).then((d) => d.close()), Error, msg, name);
  };
  await mustFail("拿掉 RLS", mutate(MIG_SQL, "    EXECUTE format('ALTER TABLE policy_jp.%I ENABLE ROW LEVEL SECURITY', t);\n", ""), "沒開 RLS");
  await mustFail("給 anon 權限", mutate(MIG_SQL, "    EXECUTE format('REVOKE ALL ON policy_jp.%I FROM PUBLIC, anon, authenticated', t);", "    EXECUTE format('GRANT SELECT ON policy_jp.%I TO anon', t);"), "不該有任何權限");
  await mustFail("函式給 anon", mutate(MIG_SQL, "GRANT EXECUTE ON FUNCTION policy_jp.lg_code_valid(TEXT), policy_jp.election_level(TEXT) TO anon, authenticated;",
    "GRANT EXECUTE ON FUNCTION policy_jp.queue_now() TO anon;"), "不該能執行");
  await mustFail("函式提到 public.", mutate(MIG_SQL, "  SELECT COALESCE(NULLIF(current_setting('app.queue_now', true), '')::TIMESTAMPTZ, now())", "  SELECT COALESCE(NULLIF(current_setting('app.queue_now', true), '')::TIMESTAMPTZ, now()) FROM (SELECT 1 FROM public.nothing) x"), "");
});
