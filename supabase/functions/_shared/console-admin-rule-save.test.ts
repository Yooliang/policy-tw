/**
 * 主控台直接改派工規則：console_admin_rule_save（2026-10-13 維護者裁決；migration 見 MIG_NAME）。
 *
 * PGlite 實跑：shared-dispatch-plan-pglite.ts 的兩站精簡 activity_rules ＋ 20261011270000（總表）＋這支。
 *   1. 修改：只動有給的欄位，落到正確那一站；理由另記一筆進該站 edit_history（agent_name＝console:<信箱>）
 *   2. 新增：activity 要是那一站認得的名字（派工臂、既有規則的活動名、priority: 加上它們、priority:*），拼錯就擋
 *   3. 擋：reason 空白、site 不對、白名單外的欄位、改 activity、找不到的 id、該站 CHECK 照舊擋不合法的值
 *   4. 權限：只有 service_role 能叫
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { BASE } from "./shared-dispatch-plan-pglite.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (n: string) => (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
const PLAN_MIG = await read("20261011270000_shared_dispatch_plan.sql");
const MIG_NAME = [...Deno.readDirSync(MIGRATIONS)].map((e) => e.name).find((n) => n.endsWith("_console_admin_rule_save.sql"))!;
const MIG = await read(MIG_NAME);

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(`
    CREATE FUNCTION activity_arm_names() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['raw:policy_missing', 'deadline_due', 'ballot_numbers']::TEXT[] $$;
    CREATE FUNCTION policy_jp.activity_arm_names() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['roster_check', 'policy_missing']::TEXT[] $$;
  `);
  await db.exec(PLAN_MIG);
  await db.exec(MIG);
  return db;
}

type Saved = { site: string; id: number; activity: string; enabled: boolean; until_offset: number; election_types: string[] | null; params: Record<string, unknown> };
async function save(db: PGlite, site: string, id: number | null, rule: unknown, reason = "測試", role = "service_role"): Promise<Saved> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    const r = await tx.query<Saved>(
      `SELECT site, id::INT AS id, activity, enabled, until_offset, election_types, params FROM console_admin_rule_save($1, $2, $3::JSONB, $4, 'owner@example.com')`,
      [site, id, JSON.stringify(rule), reason],
    );
    return r.rows[0];
  });
}

Deno.test(`1. 修改：只動有給的欄位、落到正確那一站，理由另記一筆（${MIG_NAME}）`, async () => {
  const db = await freshDb();
  const r = await save(db, "tw", 1, { until_offset: -3, election_types: ["村里長"] }, "選前三天就收");
  assertEquals([r.site, r.id, r.activity, r.until_offset, r.election_types, r.enabled], ["tw", 1, "raw:policy_missing", -3, ["村里長"], true]);
  const t = (await db.query<{ until_kind: string; until_offset: number }>(`SELECT until_kind, until_offset FROM activity_rules WHERE id = 1`)).rows[0];
  assertEquals(t, { until_kind: "polling", until_offset: -3 }, "沒給的欄位（until_kind）不變");
  assertEquals((await db.query(`SELECT 1 FROM policy_jp.activity_rules WHERE until_offset = -3`)).rows.length, 0, "日本同 id 的規則不受影響");

  const j = await save(db, "jp", 1, { params: { cap: 50 }, enabled: false }, "日本先停");
  assertEquals([j.site, j.enabled, j.params], ["jp", false, { cap: 50 }]);

  const why = (await db.query(`SELECT table_name, record_id, field, agent_name FROM edit_history WHERE field = 'reason' AND new_value = to_jsonb('選前三天就收'::TEXT)`)).rows;
  assertEquals(why, [{ table_name: "activity_rules", record_id: "1", field: "reason", agent_name: "console:owner@example.com" }], "台灣的理由進 public.edit_history");
  assertEquals((await db.query(`SELECT 1 FROM policy_jp.edit_history WHERE field = 'reason' AND new_value = to_jsonb('日本先停'::TEXT)`)).rows.length, 1, "日本的理由進 policy_jp.edit_history");
});

Deno.test("2. 新增：認得的任務名才收，拼錯就擋", async () => {
  const db = await freshDb();
  const a = await save(db, "tw", null, { activity: "ballot_numbers", window_kind: "event", from_kind: "draw", until_kind: "polling" });
  assertEquals([a.site, a.id, a.activity], ["tw", 4, "ballot_numbers"]);
  const b = await save(db, "tw", null, { activity: "priority:*", window_kind: "always", priority: 2 });
  assertEquals(b.activity, "priority:*");
  const c = await save(db, "jp", null, { activity: "priority:policy_missing", window_kind: "always", priority: 1 });
  assertEquals([c.site, c.id], ["jp", 2]);
  await assertRejects(() => save(db, "tw", null, { activity: "ballot_number", window_kind: "always" }), Error, "不是台灣站認得的任務名");
  await assertRejects(() => save(db, "jp", null, { activity: "ballot_numbers", window_kind: "always" }), Error, "不是日本站認得的任務名");
  await assertRejects(() => save(db, "tw", null, { window_kind: "always" }), Error, "要給 activity");
  await assertRejects(() => save(db, "tw", null, { activity: "deadline_due" }), Error, "要給 window_kind");
});

Deno.test("3. 擋：理由、site、白名單、改 activity、找不到、該站 CHECK", async () => {
  const db = await freshDb();
  await assertRejects(() => save(db, "tw", 1, { enabled: false }, "  "), Error, "reason 必填");
  await assertRejects(() => save(db, "kr", 1, { enabled: false }), Error, "site 只能是");
  await assertRejects(() => save(db, "tw", 1, { site: "jp" }), Error, "不能從主控台改");
  await assertRejects(() => save(db, "tw", 1, { id: 9, enabled: false }), Error, "不能從主控台改");
  await assertRejects(() => save(db, "tw", 1, { updated_at: "2020-01-01" }), Error, "不能從主控台改");
  await assertRejects(() => save(db, "tw", 1, { activity: "deadline_due" }), Error, "activity 不能改");
  await assertRejects(() => save(db, "tw", 99, { enabled: false }), Error, "找不到台灣站的規則 99");
  await assertRejects(() => save(db, "tw", 1, [1]), Error, "要是一個物件");
  // 該站自己的 CHECK：日本職位寫台灣的、台灣的優先層規則拿掉 priority
  await assertRejects(() => save(db, "jp", 1, { election_types: ["縣市長"] }));
  await assertRejects(() => save(db, "tw", 2, { priority: null }));
  // 擋下來的一筆都沒寫進去
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::INT AS n FROM shared.dispatch_plan WHERE NOT enabled`)).rows[0].n, 0);
});

Deno.test("4. 權限：只有 service_role 能叫", async () => {
  const db = await freshDb();
  for (const role of ["anon", "authenticated"]) {
    await assertRejects(() => save(db, "tw", 1, { enabled: false }, "x", role), Error, "permission denied");
  }
  const ok = await save(db, "tw", 1, { enabled: false });
  assert(!ok.enabled);
});
