/**
 * 日本站主控台手動調整派工開關與選舉日期（#518 第二步，migration 20261010010000_policy_jp_console_admin.sql）。
 * 對應台灣版 console-admin.test.ts。PGlite 上套 policy_jp 的 schema、tables、dispatch（含 activity_open／activity_arm_names）再疊這支。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const MIG_NAME = "20261010010000_policy_jp_console_admin.sql";
const MIG_SQL = await read(MIG_NAME);
// 這支之前的全部 policy_jp migration（依檔名排序），含缺口臂（210100）與選舉鏈（250400）：
// 只套 schema／tables／dispatch 時 activity_arm_names() 只有兩支手動臂，auto: 臂的計數測不到（agy 10-10 指出的盲點）
const BEFORE: string[] = [];
for await (const e of Deno.readDir(MIGRATIONS)) {
  if (e.isFile && e.name.includes("_policy_jp_") && e.name < MIG_NAME) BEFORE.push(e.name);
}
BEFORE.sort();
const BEFORE_SQL = await Promise.all(BEFORE.map(read));

const ELECTION = "2028-07-09_national_lower_national";

async function freshDb(mig = MIG_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;`);
  for (const sql of BEFORE_SQL) await db.exec(sql);
  await db.exec(mig);
  await db.exec(`INSERT INTO policy_jp.elections (id, name, election_date, election_type, election_reason, level, review_status)
    VALUES ('${ELECTION}', '衆議院議員総選挙', '2028-07-09', 'national_lower', 'regular', 'national', 'published')`);
  return db;
}
const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}
const isoDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const CREATE = "SELECT * FROM policy_jp.console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)";

Deno.test("套用兩次都成功；public 沒有 console_* 物件（不碰台灣站）", async () => {
  const db = await freshDb();
  await db.exec(MIG_SQL);
  const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname LIKE 'console_%'`);
  assertEquals(n.n, 0);
  const v = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM pg_views WHERE schemaname = 'public' AND viewname LIKE 'console_%'`);
  assertEquals(v.n, 0);
});

Deno.test("console_arm_status：回傳 activity_arm_names() 的每一支臂，queue_count 是數字或 null", async () => {
  const db = await freshDb();
  const rows = (await db.query<{ arm: string; is_open: boolean; via: string; queue_count: number | null }>("SELECT * FROM policy_jp.console_arm_status() ORDER BY arm")).rows;
  const names = (await one<{ a: string[] }>(db, "SELECT policy_jp.activity_arm_names() AS a")).a;
  assertEquals(rows.map((r) => r.arm).sort(), [...names].sort());
  for (const r of rows) assert(typeof r.queue_count === "number" || r.queue_count === null, `${r.arm} queue_count`);
});

Deno.test("覆寫新增：reason 空白被擋；新增後 console_active_overrides 看得到、console_arm_status 回 closed／override；審計多一筆", async () => {
  const db = await freshDb();
  await assertRejects(() => db.query(CREATE, ["manual_open", null, null, "closed", null, null, "  ", null, "t@example.com"]), Error, "reason 必填");
  await db.exec("SET app.activity_today = '2028-06-01'");
  const created = await one<{ id: number }>(db, CREATE, ["manual_open", null, null, "closed", null, null, "測試：暫停", null, "t@example.com"]);
  assert(created.id > 0);
  const act = (await db.query<{ reason: string }>("SELECT reason FROM policy_jp.console_active_overrides WHERE id = $1", [created.id])).rows;
  assertEquals(act.length, 1);
  assertEquals(act[0].reason, "測試：暫停");
  const st = await one<{ via: string; is_open: boolean }>(db, "SELECT is_open, via FROM policy_jp.console_arm_status() WHERE arm = 'manual_open'");
  assertEquals(st.via, "override");
  assertEquals(st.is_open, false);
  const hist = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM policy_jp.edit_history WHERE table_name = 'activity_overrides' AND record_id = $1", [String(created.id)]);
  assertEquals(hist.n, 1);
});

Deno.test("覆寫新增：election_id 是 TEXT（日本站選舉 key），空字串正規化成 NULL", async () => {
  const db = await freshDb();
  const withEl = await one<{ election_id: string }>(db, CREATE, ["manual_open", ELECTION, "national_lower", "open", null, null, "指到選舉", null, "t@example.com"]);
  assertEquals(withEl.election_id, ELECTION);
  const blank = await one<{ election_id: string | null; election_type: string | null }>(db, CREATE, ["manual_visitor", "  ", "", "open", null, null, "空字串", null, "t@example.com"]);
  assertEquals(blank.election_id, null);
  assertEquals(blank.election_type, null);
});

Deno.test("撤銷：不刪列，expires_at 設今天 -1、兩個原因都留住、立刻不再列在 active；審計 INSERT＋UPDATE；重複撤銷與缺原因被擋", async () => {
  const db = await freshDb();
  await db.exec("SET app.activity_today = '2028-06-01'");
  const created = await one<{ id: number }>(db, CREATE, ["manual_open", null, null, "open", null, null, "原因 A", null, "a@example.com"]);
  await assertRejects(() => db.query("SELECT policy_jp.console_admin_override_revoke($1,$2,$3)", [created.id, " ", "b@example.com"]), Error, "reason 必填");
  const rev = await one<{ reason: string; expires_at: unknown }>(db, "SELECT reason, expires_at FROM policy_jp.console_admin_override_revoke($1,$2,$3)", [created.id, "原因 B：改用規則", "b@example.com"]);
  assert(rev.reason.includes("原因 A") && rev.reason.includes("原因 B：改用規則"));
  assertEquals(isoDate(rev.expires_at), "2028-05-31");
  assertEquals((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM policy_jp.console_active_overrides WHERE id = $1", [created.id])).n, 0);
  assertEquals((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM policy_jp.edit_history WHERE table_name = 'activity_overrides' AND record_id = $1", [String(created.id)])).n, 2);
  await assertRejects(() => db.query("SELECT policy_jp.console_admin_override_revoke($1,$2,$3)", [created.id, "再撤", "a@example.com"]));
});

Deno.test("里程碑：新增一列（basis=override、reason 併進 note）；同鍵再呼叫＝upsert；reason 缺、kind 不在白名單（含台灣專用的 qualification_review）被擋", async () => {
  const db = await freshDb();
  const first = await one<{ id: number; basis: string; note: string; on_date: unknown }>(db, "SELECT * FROM policy_jp.console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)",
    [ELECTION, "draw", null, "2028-06-20", "announced", "測試：抽籤日", "admin@example.com"]);
  assertEquals(first.basis, "override");
  assert(first.note.includes("測試：抽籤日") && first.note.includes("admin@example.com"));
  const second = await one<{ id: number; on_date: unknown; status: string }>(db, "SELECT * FROM policy_jp.console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)",
    [ELECTION, "draw", "", "2028-06-25", "done", "改期", "admin@example.com"]);
  assertEquals(second.id, first.id, "同一個鍵要 upsert 同一列");
  assertEquals(isoDate(second.on_date), "2028-06-25");
  assertEquals(second.status, "done");
  assertEquals((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM policy_jp.election_milestones WHERE election_id = $1 AND kind = 'draw'", [ELECTION])).n, 1);
  const view = await one<{ election_date: unknown; on_date: unknown }>(db, "SELECT election_date, on_date FROM policy_jp.console_election_milestones WHERE id = $1", [first.id]);
  assertEquals(isoDate(view.election_date), "2028-07-09");
  assertEquals(isoDate(view.on_date), "2028-06-25");
  await assertRejects(() => db.query("SELECT policy_jp.console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)", [ELECTION, "draw", null, "2028-06-20", "announced", "", "a"]), Error, "reason 必填");
  for (const kind of ["qualification_review", "polling", "term_start", "bogus"]) {
    await assertRejects(() => db.query("SELECT policy_jp.console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)", [ELECTION, kind, null, "2028-06-20", "announced", "x", "a"]), Error, "不是 election_milestones 可以改的里程碑");
  }
});

Deno.test("權限：anon／authenticated 不能叫三支寫入 RPC，也讀不到底下的表；讀 RPC 與兩個視圖 anon 可用；service_role 都能", async () => {
  const db = await freshDb();
  const writes = [
    `SELECT policy_jp.console_admin_override_create('manual_open', NULL, NULL, 'open', NULL, NULL, 'r', NULL, 'x')`,
    `SELECT policy_jp.console_admin_override_revoke(1, 'r', 'x')`,
    `SELECT policy_jp.console_admin_milestone_set('${ELECTION}', 'draw', NULL, '2028-06-20', 'announced', 'r', 'x')`,
  ];
  for (const role of ["anon", "authenticated"]) {
    for (const sql of writes) await assertRejects(() => asRole(db, role, sql), Error, "permission denied", `${role}: ${sql}`);
    for (const t of ["activity_overrides", "election_milestones", "task_dispatches", "activity_rules"]) {
      await assertRejects(() => asRole(db, role, `SELECT * FROM policy_jp.${t}`), Error, "permission denied", `${role} 不該直接讀 ${t}`);
    }
    // 公開唯讀：函式與兩個視圖
    assert((await asRole(db, role, `SELECT * FROM policy_jp.console_arm_status()`)).length >= 2);
    await asRole(db, role, `SELECT * FROM policy_jp.console_active_overrides`);
    await asRole(db, role, `SELECT * FROM policy_jp.console_election_milestones`);
  }
  // 視圖不能被拿來寫
  await assertRejects(() => asRole(db, "anon", `DELETE FROM policy_jp.console_active_overrides`), Error, "cannot delete from view");
  await assertRejects(() => asRole(db, "anon", `DELETE FROM policy_jp.activity_overrides`), Error, "permission denied");
  const sr = await asRole<{ r: unknown }>(db, "service_role", `SELECT (policy_jp.console_admin_override_create('manual_open', NULL, NULL, 'open', NULL, NULL, 'sr', NULL, 'x')).id AS r`);
  assert(sr[0].r !== undefined);
  await asRole(db, "service_role", writes[2]);
});

Deno.test("安全性：四支 console 函式全是 SECURITY DEFINER＋釘 search_path = policy_jp, pg_temp；寫入的只有 service_role 有 EXECUTE（不含 PUBLIC）", async () => {
  const db = await freshDb();
  const rows = (await db.query<{ proname: string; secdef: boolean; cfg: string[] | null; acl: string[] | null }>(
    `SELECT p.proname, p.prosecdef AS secdef, p.proconfig AS cfg, p.proacl::text[] AS acl
       FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'policy_jp' AND p.proname LIKE 'console_%' ORDER BY p.proname`,
  )).rows;
  assertEquals(rows.map((r) => r.proname), ["console_admin_milestone_set", "console_admin_override_create", "console_admin_override_revoke", "console_arm_status"]);
  for (const r of rows) {
    assert(r.secdef, `${r.proname} 要 SECURITY DEFINER`);
    assert((r.cfg ?? []).some((c) => c.replace(/\s/g, "") === "search_path=policy_jp,pg_temp"), `${r.proname} 要釘 search_path`);
    const acl = (r.acl ?? []).join(" ");
    assert(acl.includes("service_role=X"), `${r.proname} service_role 要有 EXECUTE`);
    if (r.proname !== "console_arm_status") {
      assert(!/(^|[ {,])=X/.test(acl), `${r.proname} 不能留 PUBLIC EXECUTE`);
      assert(!acl.includes("anon=") && !acl.includes("authenticated="), `${r.proname} 不給 anon／authenticated`);
    }
  }
});

Deno.test("還原驗證：拿掉函式裡的 reason 檢查，錯誤訊息就不再是『reason 必填』（測試真的在守門）", async () => {
  const bad = MIG_SQL.replace(
    `  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  INSERT INTO policy_jp.activity_overrides`,
    `  INSERT INTO policy_jp.activity_overrides`,
  );
  assert(bad !== MIG_SQL, "替換要真的發生");
  const db = await freshDb(bad);
  const err = await db.query(CREATE, ["manual_open", null, null, "open", null, null, "  ", null, "x"]).then(() => "", (e: Error) => e.message);
  assert(!err.includes("reason 必填"), "拿掉函式裡的檢查後訊息就不是『reason 必填』");
});

Deno.test("console_arm_status：auto: 臂（選舉發現、團體、地域統計）也在清單裡，queue_count 算的是該臂 auto: 開頭的派工列", async () => {
  const db = await freshDb();
  const names = (await one<{ a: string[] }>(db, "SELECT policy_jp.activity_arm_names() AS a")).a;
  for (const arm of ["election_discovery", "local_government_missing", "regional_stats_missing"]) assert(names.includes(arm), `activity_arm_names 要有 ${arm}`);
  const before = (await db.query<{ arm: string; queue_count: number | null }>("SELECT arm, queue_count FROM policy_jp.console_arm_status()")).rows;
  const base = new Map(before.map((r) => [r.arm, Number(r.queue_count ?? 0)]));
  // seed 寫派工列時 opened_by 帶臂名（console_arm_status 依它計數）
  await db.exec(`INSERT INTO policy_jp.task_dispatches (task_id, task_type, target, queue_at, last_dispatched_at, dispatch_count, opened_by) VALUES
    ('auto:regional_stats_missing:232033', 'regional_stats_missing', '{}'::jsonb, now(), now(), 0, '{"arm":"regional_stats_missing"}'::jsonb),
    ('auto:regional_stats_missing:011002', 'regional_stats_missing', '{}'::jsonb, now(), now(), 0, '{"arm":"regional_stats_missing"}'::jsonb),
    ('auto:election_discovery:2027-01-31:232033:head', 'election_discovery', '{}'::jsonb, now(), now(), 0, '{"arm":"election_discovery"}'::jsonb)`);
  const after = new Map((await db.query<{ arm: string; queue_count: number | null }>("SELECT arm, queue_count FROM policy_jp.console_arm_status()")).rows.map((r) => [r.arm, Number(r.queue_count ?? 0)]));
  assertEquals(after.get("regional_stats_missing")! - base.get("regional_stats_missing")!, 2);
  assertEquals(after.get("election_discovery")! - base.get("election_discovery")!, 1);
  assertEquals(after.get("local_government_missing"), base.get("local_government_missing"));
});
