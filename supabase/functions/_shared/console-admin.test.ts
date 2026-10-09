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

// 這個 P0+P1 環境沒有載入 20261008160000_roster_milestones.sql（更晚的 migration，把 qualification_review 加進
// election_milestones.kind 的 CHECK）；要測「qualification_review 可以改」這個情境，表的 CHECK 本身要先認得這個值，
// 否則連 INSERT 都過不了（跟我這支 migration 的白名單是不是漏寫無關，是測試環境的 CHECK 太舊）。只補這一處 CHECK，
// 不整支載入 roster_milestones（它還牽涉 roster_check_scope 的觸發器與其他臂，不是這支要測的範圍）。
const QUALIFICATION_REVIEW_CHECK = `ALTER TABLE election_milestones DROP CONSTRAINT election_milestones_kind_check;
ALTER TABLE election_milestones ADD CONSTRAINT election_milestones_kind_check
  CHECK (kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw', 'qualification_review',
                   'bulletin_published', 'result_announced', 'certified'));`;

async function db() {
  const d = await buildArmsDb({ afterP1Sql: MANUAL_STUB + "\n" + QUALIFICATION_REVIEW_CHECK });
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

// 2026-10-09 agy 審查第 1 點退回修正：qualification_review（資格審查完成日）漏在白名單外，維護者在主控台改這個日期會被
// RAISE EXCEPTION 擋下。20261008160000 已把它加進 election_milestones.kind 與 activity_rules 的 CHECK，這支臂的日期可以改。
Deno.test("里程碑：qualification_review（資格審查完成日）可以改，不被白名單擋下", async () => {
  const d = await db();
  const row = (await d.query<{ kind: string; on_date: string }>(
    "SELECT kind, on_date FROM console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)",
    [2026, "qualification_review", "縣市長", "2026-10-16", "announced", "測試：資格審查完成日", "admin@example.com"],
  )).rows[0];
  assertEquals(row.kind, "qualification_review");
  assertEquals(isoDate(row.on_date), "2026-10-16");
});

// 2026-10-09 agy 審查第 3 點退回修正：election_type 傳空字串（不是 null）要被正規化掉，不能讓它撞 CHECK 違反
// （CHECK 允許 NULL 或白名單裡的職位，"" 兩邊都不是）。Edge Function 那層已經把表單空字串轉成 null，這裡測 SQL 這層的第二道防禦
// ——直接打 RPC（不經過 Edge Function）送空字串也不該被 CHECK 擋下，而是視同沒有限定職位。
Deno.test("里程碑：election_type 傳空字串（不是 null）視同不限職位，不撞 CHECK 違反（SQL 層防禦）", async () => {
  const d = await db();
  const row = (await d.query<{ election_type: string | null }>(
    "SELECT election_type FROM console_admin_milestone_set($1,$2,$3,$4,$5,$6,$7)",
    [2026, "bulletin_published", "", "2026-11-18", "expected", "測試：空字串職位", "admin@example.com"],
  )).rows[0];
  assertEquals(row.election_type, null);
});

Deno.test("覆寫新增：election_type 傳空字串視同不限職位，不撞 CHECK 違反（SQL 層防禦，同里程碑那條）", async () => {
  const d = await db();
  const row = (await d.query<{ election_type: string | null }>(
    "SELECT election_type FROM console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    ["raw:policy_missing", null, "", "open", null, null, "測試：空字串職位", null, "a@example.com"],
  )).rows[0];
  assertEquals(row.election_type, null);
});

// 2026-10-09 agy 審查第 4 點退回修正：force='window' 的覆寫很少另外填 expires_at，open_until 過了之後這筆覆寫在
// activity_open() 裡早就不生效，但原本的視圖只看 expires_at，會一直留在「目前有效」清單裡誤導維護者。
Deno.test("console_active_overrides：force=window 且 open_until 已過期的覆寫，不算「目前有效」", async () => {
  const d = await db();
  await d.exec("SET app.activity_today = '2026-10-09'");
  const past = (await d.query<{ id: number }>(
    "SELECT id FROM console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    ["raw:policy_missing", null, null, "window", "2026-10-01", "2026-10-05", "測試：已經過去的期間", null, "a@example.com"],
  )).rows[0];
  const future = (await d.query<{ id: number }>(
    "SELECT id FROM console_admin_override_create($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    ["raw:profile_gap", null, null, "window", "2026-10-01", "2026-12-31", "測試：還沒結束的期間", null, "a@example.com"],
  )).rows[0];

  const pastActive = (await d.query<{ n: number }>("SELECT count(*)::int AS n FROM console_active_overrides WHERE id = $1", [past.id])).rows[0];
  assertEquals(pastActive.n, 0, "open_until 已經過了，不該出現在「目前有效」清單");
  const futureActive = (await d.query<{ n: number }>("SELECT count(*)::int AS n FROM console_active_overrides WHERE id = $1", [future.id])).rows[0];
  assertEquals(futureActive.n, 1, "open_until 還沒到，應該仍算有效");

  // 但原始表仍然留著這一列（撤銷才會動它，單純過期不代表要清掉，審計看得到它曾經存在過）
  const raw = (await d.query<{ n: number }>("SELECT count(*)::int AS n FROM activity_overrides WHERE id = $1", [past.id])).rows[0];
  assertEquals(raw.n, 1);
  await d.exec("RESET app.activity_today");
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
