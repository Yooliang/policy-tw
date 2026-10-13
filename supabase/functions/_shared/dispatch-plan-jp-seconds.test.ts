/**
 * 主控台規則總表：日本的規則也有優先秒數（migration 20261011360100_dispatch_plan_jp_priority_seconds.sql，2026-10-13；
 * 接在 20261011360000_policy_jp_queue_priority_seconds.sql 後面，那一支給 policy_jp.activity_rules 加了 priority_seconds）。
 *
 * PGlite 實跑：shared-dispatch-plan-pglite.ts 的兩站精簡 activity_rules ＋ 20261011270000（總表）＋兩站都加上 priority_seconds 欄＋這支。
 *   1. 文字層：這支的視圖與寫入觸發器＝正見 20261011320000 的定義，只換「日本那一支給 r.priority_seconds、寫入不再擋、INSERT／UPDATE 帶這欄」
 *   2. 總表讀得到日本規則的秒數；透過總表新增、修改日本 priority: 規則的秒數，落到 policy_jp.activity_rules
 *   3. 另一站專用的欄位照舊擋（日本不能填 requires_traffic、except_election_types；台灣不能填 after_step）
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { BASE } from "./shared-dispatch-plan-pglite.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const read = async (n: string) => (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
const PLAN_MIG = await read("20261011270000_shared_dispatch_plan.sql");
const TW_SEC = await read("20261011320000_queue_priority_seconds.sql");
const MIG_NAME = "20261011360100_dispatch_plan_jp_priority_seconds.sql";
const MIG = await read(MIG_NAME);

/** 從 migration 切出「CREATE OR REPLACE VIEW shared.dispatch_plan」到寫入觸發器函式結尾 */
function planPart(sql: string): string {
  const a = sql.indexOf("CREATE OR REPLACE VIEW shared.dispatch_plan AS");
  const b = sql.indexOf("\n$$;\n", sql.indexOf("CREATE OR REPLACE FUNCTION shared.dispatch_plan_write()", a));
  assert(a >= 0 && b > a, "切不到總表那一段");
  return sql.slice(a, b + 5);
}

Deno.test("1. 文字層：＝正見 20261011320000 的總表定義，只換日本那一支的四處", () => {
  const reps: Array<[string, string]> = [
    ["false, r.after_step, r.params, r.enabled, r.note, r.created_at, r.updated_at, NULL::INTEGER", "false, r.after_step, r.params, r.enabled, r.note, r.created_at, r.updated_at, r.priority_seconds"],
    ["OR COALESCE(NEW.requires_traffic, false) OR NEW.priority_seconds IS NOT NULL) THEN", "OR COALESCE(NEW.requires_traffic, false)) THEN"],
    ["except_election_types、requires_traffic、priority_seconds 是台灣專用的欄位", "except_election_types、requires_traffic 是台灣專用的欄位"],
    ["reasons, levels, election_types, jurisdictions, priority, after_step, params, enabled, note)\n", "reasons, levels, election_types, jurisdictions, priority, after_step, params, enabled, note, priority_seconds)\n"],
    ["COALESCE(NEW.params, '{}'::JSONB), COALESCE(NEW.enabled, true), NEW.note)\n", "COALESCE(NEW.params, '{}'::JSONB), COALESCE(NEW.enabled, true), NEW.note, NEW.priority_seconds)\n"],
    ["priority = NEW.priority, after_step = NEW.after_step, params = NEW.params, enabled = NEW.enabled, note = NEW.note\n", "priority = NEW.priority, after_step = NEW.after_step, params = NEW.params, enabled = NEW.enabled, note = NEW.note,\n             priority_seconds = NEW.priority_seconds\n"],
  ];
  let expected = planPart(TW_SEC);
  for (const [a, b] of reps) {
    assertEquals(expected.split(a).length - 1, 1, `正見那一版找不到（或不只一處）：${a.slice(0, 60)}`);
    expected = expected.replace(a, () => b);
  }
  assertEquals(planPart(MIG), expected);
  // 這支只動總表：沒有別的函式、視圖、表結構
  const created = [...MIG.matchAll(/CREATE (?:OR REPLACE )?(?:FUNCTION|VIEW|TABLE|TRIGGER)\s+([\w.]+)/g)].map((m) => m[1]).sort();
  assertEquals(created, ["shared.dispatch_plan", "shared.dispatch_plan_write"]);
  assert(!/ALTER TABLE|DROP /i.test(MIG.replace(/--[^\n]*/g, "")), "不改表結構、不刪東西");
});

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(PLAN_MIG);
  // 正見 20261011320000 與日本 20261011360000 加的欄（這裡只放總表用得到的）
  await db.exec(`ALTER TABLE activity_rules ADD COLUMN priority_seconds INTEGER;
                 ALTER TABLE policy_jp.activity_rules ADD COLUMN priority_seconds INTEGER;
                 INSERT INTO policy_jp.activity_rules (activity, window_kind, priority, priority_seconds) VALUES ('priority:roster_check', 'always', 1, 259200);`);
  await db.exec(MIG);
  return db;
}
const asSr = <T>(db: PGlite, sql: string) => db.transaction(async (tx) => {
  await tx.exec(`SET LOCAL ROLE service_role`);
  return (await tx.query<T>(sql)).rows;
});

Deno.test("2. 總表讀得到日本規則的秒數；透過總表新增、修改日本規則的秒數，落到 policy_jp.activity_rules", async () => {
  const db = await freshDb();
  const read = async () => (await db.query<{ activity: string; s: number | null }>(
    `SELECT activity, priority_seconds AS s FROM shared.dispatch_plan WHERE site = 'jp' ORDER BY id`)).rows;
  assertEquals(await read(), [{ activity: "roster_check", s: null }, { activity: "priority:roster_check", s: 259200 }]);
  await asSr(db, `UPDATE shared.dispatch_plan SET priority_seconds = 86400 WHERE site = 'jp' AND activity = 'priority:roster_check'`);
  assertEquals((await db.query(`SELECT priority_seconds AS s FROM policy_jp.activity_rules WHERE activity = 'priority:roster_check'`)).rows, [{ s: 86400 }]);
  await asSr(db, `INSERT INTO shared.dispatch_plan (site, activity, window_kind, priority, priority_seconds) VALUES ('jp', 'priority:policy_missing', 'always', 3, -2592000)`);
  assertEquals((await db.query(`SELECT priority, priority_seconds AS s FROM policy_jp.activity_rules WHERE activity = 'priority:policy_missing'`)).rows, [{ priority: 3, s: -2592000 }]);
  // 台灣那一站照舊
  await asSr(db, `UPDATE shared.dispatch_plan SET priority_seconds = 100 WHERE site = 'tw' AND activity = 'priority:*'`);
  assertEquals((await db.query(`SELECT priority_seconds AS s FROM activity_rules WHERE activity = 'priority:*'`)).rows, [{ s: 100 }]);
  await db.close();
});

Deno.test("3. 另一站專用的欄位照舊擋", async () => {
  const db = await freshDb();
  await assertRejects(() => asSr(db, `INSERT INTO shared.dispatch_plan (site, activity, window_kind, requires_traffic) VALUES ('jp', 'x', 'always', true)`), Error, "台灣專用");
  await assertRejects(() => asSr(db, `INSERT INTO shared.dispatch_plan (site, activity, window_kind, except_election_types) VALUES ('jp', 'x', 'always', ARRAY['mayor'])`), Error, "台灣專用");
  await assertRejects(() => asSr(db, `INSERT INTO shared.dispatch_plan (site, activity, window_kind, after_step) VALUES ('tw', 'x', 'always', 'region')`), Error, "日本專用");
  await db.close();
});
