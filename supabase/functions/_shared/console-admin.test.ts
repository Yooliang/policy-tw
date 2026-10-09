/**
 * 主控台手動調整派工開關與選舉日期（#518，migration 20261009260000_console_admin.sql）。
 *
 * PGlite：P0＋P1 跑真的（buildArmsDb，見 arms-pglite.ts），這支 migration 疊上去。
 * manual_visitor／manual_open 兩支臂（20261008165000，更晚才加）這個環境沒有載入，activity_arm_names() 回傳的清單也沒有它們，
 * 所以 console_arm_status() 裡那段 CASE 分支不會被走到；正式庫上两支臂已經存在，contribution_auto_tasks_manual() 也已經存在（已合併的 migration）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildArmsDb, readMig } from "./arms-pglite.ts";

const MIG = await readMig("20261009260000_console_admin.sql");

// manual_visitor／manual_open（20261008165000）更晚才加，這個 P0+P1 環境沒有載入；console_arm_status() 的 LANGUAGE sql 本體
// 在 CREATE 時就會檢查裡面呼叫的函式存在（PGlite 實測：不是等到真的呼叫那個分支才檢查），所以補一個空殼（正式庫上是真的函式，已經存在）。
const MANUAL_STUB = `CREATE FUNCTION contribution_auto_tasks_manual(p_visitor boolean, p_id uuid DEFAULT NULL)
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$ SELECT NULL::text, NULL::text, NULL::jsonb, NULL::text, NULL::text[], NULL::integer, NULL::text WHERE false $$;`;

async function db() {
  const d = await buildArmsDb({ afterP1Sql: MANUAL_STUB });
  await d.exec(MIG);
  return d;
}

Deno.test("console_arm_status：回傳 activity_arm_names() 的每一支臂，always 規則的臂（P1 種子）開著", async () => {
  const d = await db();
  const rows = (await d.query<{ arm: string; is_open: boolean; via: string; queue_count: number }>(
    "SELECT * FROM console_arm_status() ORDER BY arm",
  )).rows;
  const names = (await d.query<{ a: string[] }>("SELECT activity_arm_names() AS a")).rows[0].a;
  assertEquals(rows.map((r) => r.arm).sort(), [...names].sort());
  for (const r of rows) assert(typeof r.queue_count === "number" || r.queue_count === null, `${r.arm} queue_count 應該是數字`);
});

Deno.test("覆寫新增：reason 空字串被擋（400 等級的錯誤，不是資料庫內部錯）", async () => {
  const d = await db();
  await assertRejects(() =>
    d.query("SELECT console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
      "raw:policy_missing", null, null, "closed", null, null, "  ", null, "tester@example.com",
    ])
  );
});

Deno.test("覆寫新增 → 立刻在 activity_open_now／console_active_overrides 生效，console_arm_status 回 closed／override", async () => {
  const d = await db();
  await d.exec("SET app.activity_today = '2026-10-09'");
  const created = (await d.query<{ id: number }>(
    "SELECT id FROM console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    ["raw:policy_missing", null, null, "closed", null, null, "測試：暫停缺政見派工", null, "tester@example.com"],
  )).rows[0];
  assert(created.id > 0);

  const active = (await d.query<{ activity: string; reason: string }>("SELECT activity, reason FROM console_active_overrides WHERE id = $1", [created.id])).rows;
  assertEquals(active.length, 1);
  assertEquals(active[0].reason, "測試：暫停缺政見派工");

  const status = (await d.query<{ via: string; is_open: boolean }>("SELECT is_open, via FROM console_arm_status() WHERE arm = 'raw:policy_missing'")).rows[0];
  assertEquals(status.via, "override");
  assertEquals(status.is_open, false);

  // 審計：edit_history 多一筆 INSERT
  const hist = (await d.query<{ n: number }>("SELECT count(*)::int AS n FROM edit_history WHERE table_name = 'activity_overrides' AND record_id = $1", [String(created.id)])).rows[0];
  assertEquals(hist.n, 1);
  await d.exec("RESET app.activity_today");
});

Deno.test("撤銷：不刪列，expires_at 設成今天 -1、reason 併進原 reason，立刻不再生效；撤銷後 console_active_overrides 看不到它", async () => {
  const d = await db();
  await d.exec("SET app.activity_today = '2026-10-09'");
  const created = (await d.query<{ id: number }>(
    "SELECT id FROM console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    ["raw:policy_missing", null, null, "open", null, null, "原因 A", null, "a@example.com"],
  )).rows[0];

  const revoked = (await d.query<{ id: number; reason: string; expires_at: string }>(
    "SELECT id, reason, expires_at FROM console_admin_override_revoke($1,$2,$3)",
    [created.id, "原因 B：改用規則", "b@example.com"],
  )).rows[0];
  assert(revoked.reason.includes("原因 A"));
  assert(revoked.reason.includes("原因 B：改用規則"));
  assertEquals(isoDate(revoked.expires_at), "2026-10-08");

  const active = (await d.query<{ n: number }>("SELECT count(*)::int AS n FROM console_active_overrides WHERE id = $1", [created.id])).rows[0];
  assertEquals(active.n, 0);

  // 審計：UPDATE 多一筆
  const hist = (await d.query<{ n: number }>("SELECT count(*)::int AS n FROM edit_history WHERE table_name = 'activity_overrides' AND record_id = $1", [String(created.id)])).rows[0];
  assertEquals(hist.n, 2); // INSERT + UPDATE
  await d.exec("RESET app.activity_today");
});

Deno.test("撤銷：重複撤銷同一筆（已經過期）要擋（找不到可撤銷的覆寫）", async () => {
  const d = await db();
  await d.exec("SET app.activity_today = '2026-10-09'");
  const created = (await d.query<{ id: number }>(
    "SELECT id FROM console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    ["raw:policy_missing", null, null, "open", null, null, "原因 A", null, "a@example.com"],
  )).rows[0];
  await d.query("SELECT console_admin_override_revoke($1,$2,$3)", [created.id, "先撤一次", "a@example.com"]);
  await assertRejects(() => d.query("SELECT console_admin_override_revoke($1,$2,$3)", [created.id, "再撤一次", "a@example.com"]));
  await d.exec("RESET app.activity_today");
});

Deno.test("里程碑：新增一列，basis 固定 override、reason 併進 note；再呼叫同一個鍵改成另一天會更新（ON CONFLICT upsert）", async () => {
  const d = await db();
  const first = (await d.query<{ id: number; on_date: string; basis: string; note: string }>(
    "SELECT id, on_date, basis, note FROM console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)",
    [2026, "draw", "縣市長", "2026-10-20", "announced", "測試：抽籤日公告", "admin@example.com"],
  )).rows[0];
  assertEquals(first.basis, "override");
  assert(first.note.includes("測試：抽籤日公告"));
  assert(first.note.includes("admin@example.com"));

  const second = (await d.query<{ id: number; on_date: string }>(
    "SELECT id, on_date FROM console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)",
    [2026, "draw", "縣市長", "2026-10-22", "done", "測試：改成已公告的實際日期", "admin@example.com"],
  )).rows[0];
  assertEquals(second.id, first.id); // 同一把鍵（election_id, kind, election_type）＝更新同一列，不是新增
  assertEquals(isoDate(second.on_date), "2026-10-22");

  const n = (await d.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM election_milestones WHERE election_id = 2026 AND kind = 'draw' AND election_type = '縣市長'",
  )).rows[0].n;
  assertEquals(n, 1, "更新同一列，不是多一列");

  const rows = (await d.query<{ n: number }>("SELECT count(*)::int AS n FROM console_election_milestones WHERE id = $1", [first.id])).rows;
  assertEquals(rows[0].n, 1);
});

Deno.test("里程碑：reason 空被擋；kind 不是可編輯的里程碑（例如 polling）被擋", async () => {
  const d = await db();
  await assertRejects(() => d.query("SELECT console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)", [2026, "draw", null, "2026-10-20", "announced", "", "a@example.com"]));
  await assertRejects(() => d.query("SELECT console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)", [2026, "polling", null, "2026-11-28", "done", "不該能改投票日", "a@example.com"]));
});

/** PGlite 的 DATE 欄位回傳 JS Date（UTC 午夜），轉回台北日曆日字串比對 */
function isoDate(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString().slice(0, 10);
}

async function assertRejects(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error("預期要丟錯，卻成功了");
}
