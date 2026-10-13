/**
 * 統一派工總表第一步：視圖 shared.dispatch_plan（migration 20261011270000_shared_dispatch_plan.sql）。
 *
 * PGlite 實跑：兩站的 activity_rules 用跟正式庫同欄位的精簡版（只放這裡要驗的 CHECK、稽核觸發器、RLS），再套這支 migration。
 *   1. 總表＝兩站規則的聯集，一條規則一列，site／id／欄位都對
 *   2. 透過總表新增、修改、刪除，落到正確那一站的 activity_rules，該站的 CHECK 與稽核照舊生效
 *   3. 擋：site 不在 tw／jp、換站、改 id、另一站專用的欄位
 *   4. 權限：anon／authenticated 只讀得到、寫不進；service_role 寫得進
 *   5. 派工引擎不讀總表：這支 migration 沒有重新定義任何既有函式或視圖，也沒有改兩站 activity_rules 的結構
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { BASE } from "./shared-dispatch-plan-pglite.ts";

const MIG_NAME = "20261011270000_shared_dispatch_plan.sql";
const MIG = (await Deno.readTextFile(new URL(`../../migrations/${MIG_NAME}`, import.meta.url))).replace(/\r\n/g, "\n");


async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIG);
  return db;
}

async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}

type Row = { site: string; id: number; activity: string; except_election_types: string[] | null; requires_traffic: boolean; after_step: string | null };

Deno.test("1. 總表＝兩站規則的聯集，一條規則一列", async () => {
  const db = await freshDb();
  const rows = (await db.query<Row>(`SELECT site, id::INT AS id, activity, except_election_types, requires_traffic, after_step FROM shared.dispatch_plan ORDER BY site, id`)).rows;
  assertEquals(rows.map((r) => `${r.site}:${r.id}:${r.activity}`), ["jp:1:roster_check", "tw:1:raw:policy_missing", "tw:2:priority:*", "tw:3:deadline_due"]);
  assertEquals(rows.find((r) => r.site === "jp")!.after_step, "region");
  assertEquals(rows.find((r) => r.site === "jp")!.requires_traffic, false);
  assertEquals(rows.find((r) => r.id === 3 && r.site === "tw")!.except_election_types, ["村里長"]);
  // 套用兩次（CREATE OR REPLACE／IF NOT EXISTS）
  await db.exec(MIG);
});

Deno.test("2. 透過總表寫入：落到正確那一站，CHECK 與稽核照舊", async () => {
  const db = await freshDb();
  const ins = await asRole<{ site: string; id: number }>(db, "service_role",
    `INSERT INTO shared.dispatch_plan (site, activity, window_kind, election_types) VALUES ('jp', 'policy_missing', 'always', ARRAY['mayor']) RETURNING site, id::INT AS id`);
  assertEquals(ins, [{ site: "jp", id: 2 }]);
  assertEquals((await db.query(`SELECT 1 FROM policy_jp.activity_rules WHERE id = 2 AND activity = 'policy_missing'`)).rows.length, 1);
  assertEquals((await db.query(`SELECT 1 FROM activity_rules WHERE activity = 'policy_missing'`)).rows.length, 0);

  await asRole(db, "service_role", `INSERT INTO shared.dispatch_plan (site, activity, window_kind) VALUES ('tw', 'ballot_numbers', 'always')`);
  assertEquals((await db.query(`SELECT id::INT AS id FROM activity_rules WHERE activity = 'ballot_numbers'`)).rows, [{ id: 4 }]);

  await asRole(db, "service_role", `UPDATE shared.dispatch_plan SET enabled = false, note = '測試停用' WHERE site = 'tw' AND id = 1`);
  assertEquals((await db.query(`SELECT enabled, note FROM activity_rules WHERE id = 1`)).rows, [{ enabled: false, note: "測試停用" }]);
  // 日本 id 1 不受影響（兩站 id 會重複，更新一定要帶 site）
  assertEquals((await db.query(`SELECT enabled FROM policy_jp.activity_rules WHERE id = 1`)).rows, [{ enabled: true }]);

  await asRole(db, "service_role", `DELETE FROM shared.dispatch_plan WHERE site = 'jp' AND id = 2`);
  assertEquals((await db.query(`SELECT 1 FROM policy_jp.activity_rules WHERE id = 2`)).rows.length, 0);

  // 稽核：各站寫進自己的 edit_history，table_name 仍是 activity_rules
  const twAudit = (await db.query<{ table_name: string; record_id: string }>(`SELECT table_name, record_id FROM edit_history WHERE record_id = '1' AND old_value IS NOT NULL`)).rows;
  assert(twAudit.some((r) => r.table_name === "activity_rules" && r.record_id === "1"), "台灣的修改要進 public.edit_history");
  const jpAudit = (await db.query<{ n: number }>(`SELECT count(*)::INT AS n FROM policy_jp.edit_history WHERE record_id = '2'`)).rows[0].n;
  assertEquals(jpAudit, 2, "日本的新增與刪除各一筆，進 policy_jp.edit_history");

  // 該站的 CHECK 照舊：日本職位寫台灣的名字被擋、優先層規則名不對被擋
  await assertRejects(() => asRole(db, "service_role", `INSERT INTO shared.dispatch_plan (site, activity, window_kind, election_types) VALUES ('jp', 'x', 'always', ARRAY['縣市長'])`));
  await assertRejects(() => asRole(db, "service_role", `INSERT INTO shared.dispatch_plan (site, activity, window_kind, priority) VALUES ('tw', 'not_priority', 'always', 1)`));
  await assertRejects(() => asRole(db, "service_role", `INSERT INTO shared.dispatch_plan (site, activity, window_kind) VALUES ('jp', 'x', 'term')`));
});

Deno.test("3. 擋：site 不對、換站、改 id、另一站專用的欄位", async () => {
  const db = await freshDb();
  const sr = (sql: string) => asRole(db, "service_role", sql);
  await assertRejects(() => sr(`INSERT INTO shared.dispatch_plan (site, activity, window_kind) VALUES ('kr', 'x', 'always')`), Error, "site 只能是");
  await assertRejects(() => sr(`INSERT INTO shared.dispatch_plan (site, activity, window_kind) VALUES (NULL, 'x', 'always')`), Error, "site 只能是");
  await assertRejects(() => sr(`UPDATE shared.dispatch_plan SET site = 'jp' WHERE site = 'tw' AND id = 1`), Error, "不能換站");
  await assertRejects(() => sr(`UPDATE shared.dispatch_plan SET id = 99 WHERE site = 'tw' AND id = 1`), Error, "id 不能改");
  await assertRejects(() => sr(`INSERT INTO shared.dispatch_plan (site, activity, window_kind, requires_traffic) VALUES ('jp', 'x', 'always', true)`), Error, "台灣專用");
  await assertRejects(() => sr(`INSERT INTO shared.dispatch_plan (site, activity, window_kind, except_election_types) VALUES ('jp', 'x', 'always', ARRAY['mayor'])`), Error, "台灣專用");
  await assertRejects(() => sr(`INSERT INTO shared.dispatch_plan (site, activity, window_kind, after_step) VALUES ('tw', 'x', 'always', 'region')`), Error, "日本專用");
});

Deno.test("4. 權限：anon／authenticated 只讀，service_role 可寫", async () => {
  const db = await freshDb();
  for (const role of ["anon", "authenticated"]) {
    const rows = await asRole<{ n: number }>(db, role, `SELECT count(*)::INT AS n FROM shared.dispatch_plan`);
    assertEquals(rows[0].n, 4, `${role} 要讀得到兩站全部規則（日本那張不開給它也一樣）`);
    await assertRejects(() => asRole(db, role, `INSERT INTO shared.dispatch_plan (site, activity, window_kind) VALUES ('tw', 'x', 'always')`));
    await assertRejects(() => asRole(db, role, `UPDATE shared.dispatch_plan SET enabled = false WHERE site = 'tw'`));
    await assertRejects(() => asRole(db, role, `DELETE FROM shared.dispatch_plan WHERE site = 'jp'`));
  }
  assertEquals((await db.query<{ n: number }>(`SELECT count(*)::INT AS n FROM shared.dispatch_plan WHERE enabled`)).rows[0].n, 4, "前面被擋的寫入一筆都沒落下");
});

Deno.test("5. 引擎不讀總表：migration 只新增 shared 的物件，不改既有函式、視圖與兩站 activity_rules 的結構", () => {
  const created = [...MIG.matchAll(/CREATE (?:OR REPLACE )?(?:FUNCTION|VIEW|TABLE|TRIGGER)\s+(?:IF NOT EXISTS\s+)?([\w.]+)/g)].map((m) => m[1]);
  assertEquals(created.sort(), ["shared.dispatch_plan", "shared.dispatch_plan_write", "trg_dispatch_plan_write"].sort());
  assert(!/ALTER TABLE/i.test(MIG), "不改任何表的結構");
  assert(!/DROP (TABLE|VIEW|FUNCTION)/i.test(MIG), "不刪任何既有物件");
});
