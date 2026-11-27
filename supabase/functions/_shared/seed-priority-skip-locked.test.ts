/**
 * seed_auto_task_queue 兩句 UPDATE 改 FOR UPDATE SKIP LOCKED（migration 20261127110000_seed_priority_skip_locked.sql）守門。
 *
 * 起因：2026-11-27 11:50、18:30 seed 整輪死在 deadlock（鎖 task_dispatches 的 priority_seconds UPDATE）。
 *   A. 文字層：新 migration 每一句 UPDATE task_dispatches 都帶 SKIP LOCKED 並按 task_id 排序取鎖；
 *      兩個函式層級 SET 還在；時間戳大於 main 當時最新一支（090000）
 *   B. 與前一版（20261126180000）比：把兩句 UPDATE 換成佔位符之後，其餘本文逐字相同（去註解、去空白）
 *   C. PGlite：兩句 UPDATE 照樣只更新「真的有變」的列、沒變的列不動（PGlite 單連線，無法模擬真的鎖衝突，只驗語法與結果）
 *   D. 還原驗證：把 SKIP LOCKED 拿掉，A 要紅
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { migrationNames, readMig } from "./arms-pglite.ts";

const MIG_NAME = "20261127110000_seed_priority_skip_locked.sql";
const PREV_NAME = "20261126180000_dispatch_gaps_phase0b.sql";
const MIG = await readMig(MIG_NAME);
const PREV = await readMig(PREV_NAME);

/** 取 seed_auto_task_queue() 本體（宣告到 END 之間，兩個 $$ 之間） */
function seedBody(src: string): string {
  const start = src.lastIndexOf("FUNCTION seed_auto_task_queue()");
  assert(start >= 0, "找不到 seed_auto_task_queue 定義");
  const open = src.indexOf("$$", start);
  const close = src.indexOf("$$", open + 2);
  return src.slice(open + 2, close);
}
/** 去掉註解與空白，方便逐字比對 */
const squash = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join(" ").replace(/\s+/g, " ").trim();

const CONTENT_UPD = /UPDATE task_dispatches d SET task_type = a\.task_type[^;]*;/;
const PRIORITY_UPD = /UPDATE task_dispatches d SET priority_seconds = COALESCE\(g\.priority_seconds, 0\)[^;]*;/;

/** 回傳每一句 UPDATE task_dispatches（去註解後） */
function updatesOf(body: string): string[] {
  return squash(body).match(/UPDATE task_dispatches d SET[^;]*;/g) ?? [];
}

// ============================================================
// A. 文字層
// ============================================================
Deno.test("A1 每一句 UPDATE task_dispatches 都帶 FOR UPDATE OF … SKIP LOCKED，並按 task_id 排序取鎖", () => {
  const ups = updatesOf(seedBody(MIG));
  assertEquals(ups.length, 2, "seed 裡鎖 task_dispatches 的 UPDATE 目前是兩句（內容、優先秒數）");
  for (const u of ups) {
    assert(/ORDER BY d2\.task_id FOR UPDATE OF d2 SKIP LOCKED/.test(u), `缺 SKIP LOCKED：${u.slice(0, 80)}`);
  }
});

Deno.test("A2 函式定義帶 statement_timeout 與 work_mem（CREATE OR REPLACE 會洗掉函式層級 SET）", () => {
  const head = MIG.slice(MIG.lastIndexOf("FUNCTION seed_auto_task_queue()"));
  const pre = head.slice(0, head.indexOf("$$"));
  assert(/SET statement_timeout = '280s'/.test(pre));
  assert(/SET work_mem = '16MB'/.test(pre));
});

Deno.test("A3 這支只重定義 seed_auto_task_queue；時間戳大於 main 當時最新一支（20261127090000）", async () => {
  const defs = [...MIG.matchAll(/CREATE OR REPLACE FUNCTION ([a-z_]+)\(/g)].map((m) => m[1]);
  assertEquals(defs, ["seed_auto_task_queue"]);
  assert(MIG_NAME > "20261127090000_cron_stagger_heavy_off_seed.sql");
  assert((await migrationNames()).includes(MIG_NAME));
  // 前一版確實是 phase0b（之後 seed 又被別支重定義，要以最新那版為底重做）
  const defining: string[] = [];
  for (const n of await migrationNames()) if ((await readMig(n)).includes("CREATE OR REPLACE FUNCTION seed_auto_task_queue(")) defining.push(n);
  assertEquals(defining[defining.indexOf(MIG_NAME) - 1], PREV_NAME, "前一版變了：要以最新的為底重做");
});

Deno.test("A4 migration 開頭註解寫了為什麼、改了哪幾句、為什麼不改 DELETE、回滾檔名", () => {
  const head = MIG.slice(0, MIG.indexOf("CREATE OR REPLACE FUNCTION"));
  for (const must of ["deadlock detected", "SKIP LOCKED", "DELETE", PREV_NAME, "回滾"]) {
    assert(head.includes(must), `註解缺「${must}」`);
  }
});

// ============================================================
// B. 與前一版相比只有兩句 UPDATE 不同
// ============================================================
Deno.test("B1 兩句 UPDATE 換成佔位符後，新舊兩版函式本文逐字相同", () => {
  const oldS = squash(seedBody(PREV));
  const newS = squash(seedBody(MIG));
  const oldUps = updatesOf(seedBody(PREV));
  const newUps = updatesOf(seedBody(MIG));
  assertEquals(oldUps.length, 2);
  assertEquals(newUps.length, 2);
  const mask = (s: string) => s.replace(CONTENT_UPD, "<<CONTENT>>").replace(PRIORITY_UPD, "<<PRIORITY>>");
  assertEquals(mask(newS), mask(oldS));
  // 兩句都真的被換掉了，而且新版保留原句的全部條件（把子查詢拿掉後與舊句相同）
  for (let i = 0; i < 2; i++) {
    const kept = newUps[i].replace(/\s+AND d\.task_id IN \(.*\)\s*;$/, ";");
    assertEquals(kept, oldUps[i]);
  }
});

// ============================================================
// C. PGlite：兩句 UPDATE 的結果
// ============================================================
async function runUpdates(): Promise<Record<string, unknown>[]> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, priority_seconds integer, task_type text, target jsonb,
      what_we_need text, hint_sources text[], reward integer, region text, refreshed_at timestamptz);
    CREATE TABLE _gaps_all (rn integer PRIMARY KEY, task_id text, task_type text, what_we_need text, hint_sources text[], reward integer, region text);
    CREATE TABLE _gaps (task_id text PRIMARY KEY, src_rn integer, arm text, target jsonb, opened_by jsonb, priority_seconds integer);
    INSERT INTO task_dispatches VALUES
      ('t1', 5, 'x', '{"a":1}', 'w', '{}', 1, 'r', NULL),   -- 內容與優先秒數都要變
      ('t2', 7, 'x', '{"a":1}', 'w', '{}', 1, 'r', NULL),   -- 完全沒變
      ('t3', 9, 'x', '{"a":1}', 'w', '{}', 1, 'r', NULL),   -- 只有優先秒數要變（NULL 當 0）
      ('t4', 3, 'x', '{"a":1}', 'w', '{}', 1, 'r', NULL);   -- 不在 _gaps：不動
    INSERT INTO _gaps_all VALUES (1,'t1','y','w2','{}',1,'r'), (2,'t2','x','w','{}',1,'r'), (3,'t3','x','w','{}',1,'r');
    INSERT INTO _gaps VALUES ('t1',1,'a','{"a":1}','{}',50), ('t2',2,'a','{"a":1}','{}',7), ('t3',3,'a','{"a":1}','{}',NULL);
  `);
  const body = seedBody(MIG);
  const content = CONTENT_UPD.exec(body.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"))![0];
  const priority = PRIORITY_UPD.exec(body.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"))![0];
  await db.exec(content);
  await db.exec(priority);
  const r = await db.query<Record<string, unknown>>(
    "SELECT task_id, priority_seconds, task_type, what_we_need, (refreshed_at IS NOT NULL) AS touched FROM task_dispatches ORDER BY task_id",
  );
  return r.rows;
}

Deno.test("C1 兩句 UPDATE 只改真的有變的列", async () => {
  const rows = await runUpdates();
  assertEquals(rows, [
    { task_id: "t1", priority_seconds: 50, task_type: "y", what_we_need: "w2", touched: true },
    { task_id: "t2", priority_seconds: 7, task_type: "x", what_we_need: "w", touched: false },
    { task_id: "t3", priority_seconds: 0, task_type: "x", what_we_need: "w", touched: false },
    { task_id: "t4", priority_seconds: 3, task_type: "x", what_we_need: "w", touched: false },
  ]);
});

// ============================================================
// D. 還原驗證
// ============================================================
Deno.test("D1 把 SKIP LOCKED 拿掉，A1 的判斷會紅", () => {
  const broken = seedBody(MIG).replace(/ FOR UPDATE OF d2 SKIP LOCKED/g, "");
  const ups = updatesOf(broken);
  assert(ups.some((u) => !/SKIP LOCKED/.test(u)), "還原後應該偵測得到缺 SKIP LOCKED 的 UPDATE");
});
