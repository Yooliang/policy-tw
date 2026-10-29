/**
 * 號次任務中縣市長、縣市議員比其他號次任務更優先（維護者 2026-10-29；migration 20261029090000）的守門測試。
 * 用 PGlite 跑「最新一份 cand_no_front_pull() 定義」：縣市長／縣市議員的缺口列與號次驗證列拉到 3 ×，村里長等拉到 2 ×，
 * 非號次列不動；已經夠高的不降；沒有號次的驗證列不動。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function latestFn(): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  let fn = "";
  for (const n of names) {
    const t = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r\n/g, "\n");
    const at = t.lastIndexOf("CREATE OR REPLACE FUNCTION cand_no_front_pull(");
    if (at >= 0) {
      const body = t.slice(at);
      fn = body.slice(0, body.indexOf("$$;", body.indexOf("$$") + 2) + 3);
    }
  }
  assert(fn !== "", "找不到 cand_no_front_pull 定義");
  return fn;
}

const Y = 100; // visitor_front_seconds 的測試值：2 × = 200、3 × = 300

async function build(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE queue_settings (id integer PRIMARY KEY, visitor_front_seconds bigint);
    INSERT INTO queue_settings VALUES (1, ${Y});
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb, boost_seconds bigint NOT NULL DEFAULT 0, cooling boolean NOT NULL DEFAULT true);
    CREATE TABLE contributions (id integer PRIMARY KEY, status text, contribution_type text, payload jsonb);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql AS $$ SELECT date '2026-10-30' $$;
    ${await latestFn()}`);
  const gap = (id: string, et: string) => db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ($1, $2::jsonb)`, [id, JSON.stringify({ kind: "cand_no", election_type: et })]);
  await gap("gap-mayor", "縣市長");
  await gap("gap-council", "縣市議員");
  await gap("gap-village", "村里長");
  await gap("gap-town", "鄉鎮市長");
  await db.query(`INSERT INTO task_dispatches (task_id, target, boost_seconds) VALUES ('other', '{"kind":"other"}', 5)`);
  await db.query(`INSERT INTO task_dispatches (task_id, target, boost_seconds) VALUES ('gap-council-high', '{"kind":"cand_no","election_type":"縣市議員"}', 999)`);
  const c = (id: number, et: string, withNo: boolean) =>
    db.query(`INSERT INTO contributions VALUES ($1, 'pending', 'candidacy', $2::jsonb)`, [id, JSON.stringify(withNo ? { election_type: et, cand_no: 3 } : { election_type: et })]);
  await c(1, "縣市長", true); await c(2, "村里長", true); await c(3, "縣市議員", false);
  for (const i of [1, 2, 3]) await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ($1, NULL)`, [`verify:${i}`]);
  return db;
}

Deno.test("縣市長／縣市議員的號次缺口與驗證列拉到 3 ×，其他號次 2 ×，其餘不動", async () => {
  const db = await build();
  await db.exec("SELECT cand_no_front_pull()");
  const r = (await db.query<{ task_id: string; boost_seconds: number }>(`SELECT task_id, boost_seconds::int AS boost_seconds FROM task_dispatches`)).rows;
  const b = Object.fromEntries(r.map((x) => [x.task_id, x.boost_seconds]));
  assertEquals(b["gap-mayor"], 3 * Y);
  assertEquals(b["gap-council"], 3 * Y);
  assertEquals(b["gap-village"], 2 * Y);
  assertEquals(b["gap-town"], 2 * Y);
  assertEquals(b["verify:1"], 3 * Y); // 縣市長號次驗證票
  assertEquals(b["verify:2"], 2 * Y); // 村里長號次驗證票
  assertEquals(b["verify:3"], 0); // 沒帶號次的驗證票不動
  assertEquals(b["other"], 5);
  assertEquals(b["gap-council-high"], 999); // 已經更高的不降
  assert(b["gap-mayor"] > b["gap-village"] && b["gap-council"] > b["gap-town"]);
});
