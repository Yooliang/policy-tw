/**
 * 號次缺口任務依序提前（維護者 2026-10-30；migration 20261030050000）的守門測試。
 * 清單：鄉鎮市長 → 直轄市山地原住民區長 → 鄉鎮市民代表 → 直轄市山地原住民區民代表 → 村里長。
 * 第一個有缺口列的職位拿 2.5 ×，其餘 2 ×；縣市長／縣市議員仍 3 ×；第一個沒列時輪到下一個。
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

const Y = 100; // 2 × = 200、2.5 × = 250、3 × = 300

async function build(types: string[]): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE queue_settings (id integer PRIMARY KEY, visitor_front_seconds bigint);
    INSERT INTO queue_settings VALUES (1, ${Y});
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, target jsonb, boost_seconds bigint NOT NULL DEFAULT 0, cooling boolean NOT NULL DEFAULT true);
    CREATE TABLE contributions (id integer PRIMARY KEY, status text, contribution_type text, payload jsonb);
    CREATE FUNCTION activity_today() RETURNS date LANGUAGE sql AS $$ SELECT date '2026-10-30' $$;
    ${await latestFn()}`);
  for (const et of types) {
    await db.query(`INSERT INTO task_dispatches (task_id, target) VALUES ($1, $2::jsonb)`, [`gap-${et}`, JSON.stringify({ kind: "cand_no", election_type: et })]);
  }
  await db.query(`INSERT INTO task_dispatches (task_id, target, boost_seconds) VALUES ('other', '{"kind":"other"}', 5)`);
  return db;
}

async function run(types: string[]): Promise<Record<string, number>> {
  const db = await build(types);
  await db.exec("SELECT cand_no_front_pull()");
  const r = (await db.query<{ task_id: string; boost_seconds: number }>(`SELECT task_id, boost_seconds::int AS boost_seconds FROM task_dispatches`)).rows;
  return Object.fromEntries(r.map((x) => [x.task_id, x.boost_seconds]));
}

const ALL = ["縣市長", "縣市議員", "鄉鎮市長", "直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長", "不在清單職位"];

Deno.test("清單第一個有列：只提它 2.5 ×，其餘 2 ×，縣市長／議員 3 ×", async () => {
  const b = await run(ALL);
  assertEquals(b["gap-鄉鎮市長"], 2.5 * Y);
  for (const t of ["直轄市山地原住民區長", "鄉鎮市民代表", "直轄市山地原住民區民代表", "村里長", "不在清單職位"]) assertEquals(b[`gap-${t}`], 2 * Y, t);
  assertEquals(b["gap-縣市長"], 3 * Y);
  assertEquals(b["gap-縣市議員"], 3 * Y);
  assertEquals(b["other"], 5);
});

Deno.test("第一個沒列時輪到第二個；再沒有就輪到下一個", async () => {
  let b = await run(ALL.filter((t) => t !== "鄉鎮市長"));
  assertEquals(b["gap-直轄市山地原住民區長"], 2.5 * Y);
  assertEquals(b["gap-鄉鎮市民代表"], 2 * Y);
  b = await run(["縣市長", "村里長", "鄉鎮市民代表"]);
  assertEquals(b["gap-鄉鎮市民代表"], 2.5 * Y);
  assertEquals(b["gap-村里長"], 2 * Y);
  assertEquals(b["gap-縣市長"], 3 * Y);
});

Deno.test("清單職位都沒列：不在清單的職位維持 2 ×", async () => {
  const b = await run(["縣市長", "不在清單職位"]);
  assertEquals(b["gap-不在清單職位"], 2 * Y);
  assertEquals(b["gap-縣市長"], 3 * Y);
});
