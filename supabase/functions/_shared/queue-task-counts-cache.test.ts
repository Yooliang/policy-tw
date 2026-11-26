/**
 * /next 的佇列件數改讀小表（migration 20261126160000_queue_task_counts_cache.sql，2026-11-26）守門。
 *
 *   A. 文字層：最新定義讀小表、保底分支（沒有列／超過 10 分鐘）退回即時算、即時算本體與原定義逐字相同、刷新函式與排程存在、小表 RLS
 *   B. PGlite 行為層（stub 掉 contribution_queue_tasks，其餘照 migration 原文）：刷新後每個地區＋NULL 的讀小表結果與即時算逐列相同；
 *      沒有該地區的列、列過期（> 10 分鐘）時退回即時算；沒有任務的地區刷新後是空集合而不是舊值
 *
 * 只要 --allow-read。還原驗證見 PR 說明（拿掉被守的東西確認會紅）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, latestFn, readMig } from "./arms-pglite.ts";

const MIG = "20261126160000_queue_task_counts_cache.sql";
const ORIG_MIG = "20261008165000_manual_tasks_as_arm.sql";
const mig = await readMig(MIG);
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const sql = noComments(mig);
const bodyOf = (fn: string) => fn.slice(fn.indexOf("$$") + 2, fn.lastIndexOf("$$")).trim();

Deno.test("A1 最新定義讀小表、有 10 分鐘保底、簽名與回傳欄位不變", async () => {
  const fn = await latestFn("contribution_queue_task_counts");
  assert(fn.includes("queue_task_counts_cache"), "最新定義要讀小表");
  assert(/c\.region_key = COALESCE\(p_region, '\*'\)/.test(fn), "NULL 地區用 '*' 這一列");
  assert(/c\.refreshed_at > now\(\) - INTERVAL '10 minutes'/.test(fn), "超過 10 分鐘沒刷新要退回即時算");
  assert(/IF FOUND THEN/.test(fn) && /contribution_queue_task_counts_live\(p_region\)/.test(fn), "沒有該地區的列要退回即時算");
  assert(/contribution_queue_task_counts\(p_region TEXT DEFAULT NULL\)\s*RETURNS TABLE \(task_type TEXT, total BIGINT\)/.test(fn), "簽名與回傳欄位不能動（改要分兩次上）");
  assertEquals(fn, fnText(mig, "contribution_queue_task_counts"), "最新定義就在這支 migration");
});

Deno.test("A2 即時算（_live）本體與原 contribution_queue_task_counts 逐字相同", async () => {
  const orig = bodyOf(fnText(await readMig(ORIG_MIG), "contribution_queue_task_counts"));
  const live = bodyOf(fnText(mig, "contribution_queue_task_counts_live"));
  assertEquals(live, orig);
  assert(/contribution_queue_tasks\(NULL, p_region, 100000, ''\)/.test(live));
});

Deno.test("A3 刷新：一次呼叫佇列函式、含不分地區與每個地區、沒有任務的地區寫成 []、同時只跑一個", () => {
  const compute = fnText(mig, "queue_task_counts_compute");
  assertEquals((compute.match(/contribution_queue_tasks\(/g) ?? []).length, 1, "整條佇列只掃一次");
  assert(/'\*'::text, q\.task_type, COUNT\(\*\) FROM q GROUP BY q\.task_type/.test(compute), "不分地區那一組");
  assert(/JOIN task_dispatches d ON d\.task_id = q\.task_id WHERE d\.region IS NOT NULL GROUP BY d\.region, q\.task_type/.test(compute), "各地區那一組");
  const refresh = fnText(mig, "queue_task_counts_refresh");
  assert(refresh.includes("pg_try_advisory_xact_lock"), "上一輪沒跑完就略過");
  assert(refresh.includes("SELECT c.region_key FROM queue_task_counts_cache c"), "小表已有的地區也要重寫（這輪沒任務就是 []）");
  assert(refresh.includes("'[]'::jsonb"));
  assert(/ON CONFLICT \(region_key\) DO UPDATE SET payload = EXCLUDED\.payload, refreshed_at = EXCLUDED\.refreshed_at/.test(refresh));
});

Deno.test("A4 排程：奇數分鐘、避開 :29／:35 與所有 :x0；小表 RLS 開、不給 anon／authenticated", () => {
  const m = /cron\.schedule\('queue-task-counts-refresh', '([\d,]+) \* \* \* \*'/.exec(sql);
  assert(m, "找不到排程");
  const mins = m![1].split(",").map(Number);
  assert(mins.length >= 25, "約每 2 分鐘");
  for (const x of mins) {
    assert(x % 2 === 1, `${x} 不是奇數分鐘`);
    assert(x !== 29 && x !== 35 && x % 10 !== 0, `${x} 撞到要避開的分鐘`);
  }
  assert(/queue_task_counts_refresh\(\)/.test(m!.input.slice(m!.index)), "排程呼叫刷新函式");
  assert(/ALTER TABLE queue_task_counts_cache ENABLE ROW LEVEL SECURITY/.test(sql));
  assert(/REVOKE ALL ON queue_task_counts_cache FROM PUBLIC, anon, authenticated/.test(sql));
  assert(!/CREATE POLICY/.test(sql) && !/GRANT[^;]*queue_task_counts_cache TO (anon|authenticated)/.test(sql));
});

// ---------------- B. PGlite ----------------
type Row = { task_type: string; total: number };

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE task_dispatches (task_id text PRIMARY KEY, region text, task_type text, eligible boolean NOT NULL DEFAULT true);
    -- 佇列函式 stub：只回合格的列（真正的合格條件在 contribution_queue_tasks，不是這支守門的範圍）
    CREATE FUNCTION contribution_queue_tasks(p_type text DEFAULT NULL, p_region text DEFAULT NULL, p_limit integer DEFAULT 20, p_seed text DEFAULT '',
      p_ip_hash text DEFAULT NULL, p_agent text DEFAULT NULL) RETURNS TABLE (task_id text, task_type text) LANGUAGE sql STABLE AS $$
      SELECT d.task_id, d.task_type FROM task_dispatches d WHERE d.eligible AND (p_region IS NULL OR d.region = p_region) ORDER BY d.task_id LIMIT p_limit $$;
    -- 原本的對外函式（遷移前的狀態）
    ${fnText(await readMig(ORIG_MIG), "contribution_queue_task_counts")}
  `);
  await db.exec(mig);
  return db;
}

const rows = async (db: PGlite, q: string) => (await db.query<Row>(q)).rows.map((r) => ({ task_type: r.task_type, total: Number(r.total) }));
const seed = (db: PGlite) =>
  db.exec(`
    INSERT INTO task_dispatches (task_id, region, task_type, eligible) VALUES
      ('a1', '屏東縣', 'audit', true), ('a2', '屏東縣', 'audit', true), ('a3', '屏東縣', 'policy_missing', true), ('a4', '屏東縣', 'audit', false),
      ('b1', '高雄市', 'audit', true), ('b2', '高雄市', 'question', true),
      ('c1', NULL, 'audit', true), ('c2', NULL, 'question', true),
      ('d1', '連江縣', 'audit', false);`);

Deno.test("B1 刷新後：每個地區與 NULL 讀小表的結果＝即時算（逐列）", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const n = (await db.query<{ n: number }>("SELECT queue_task_counts_refresh() AS n")).rows[0].n;
    assertEquals(Number(n), 4, "不分地區＋三個有任務列的地區（連江縣只有不合格的列，寫成 []）");
    for (const region of [null, "屏東縣", "高雄市", "連江縣"]) {
      const arg = region === null ? "NULL" : `'${region}'`;
      const cached = await rows(db, `SELECT task_type, total FROM contribution_queue_task_counts(${arg})`);
      const live = await rows(db, `SELECT task_type, total FROM contribution_queue_task_counts_live(${arg})`);
      assertEquals(cached, live, `地區 ${region}`);
    }
    assertEquals(await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts(NULL)"), [
      { task_type: "audit", total: 4 }, { task_type: "policy_missing", total: 1 }, { task_type: "question", total: 2 },
    ]);
    assertEquals(await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts('連江縣')"), []);
    // 真的讀小表：改小表內容，對外函式跟著變（即時算不會變）
    await db.exec(`UPDATE queue_task_counts_cache SET payload = '[{"task_type":"audit","total":999}]' WHERE region_key = '高雄市'`);
    assertEquals(await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts('高雄市')"), [{ task_type: "audit", total: 999 }]);
  } finally {
    await db.close();
  }
});

Deno.test("B2 保底：沒有該地區的列、列超過 10 分鐘沒刷新，都退回即時算", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // 小表是空的（刷新還沒跑過）
    assertEquals(await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts('屏東縣')"), [{ task_type: "audit", total: 2 }, { task_type: "policy_missing", total: 1 }]);
    await db.exec("SELECT queue_task_counts_refresh()");
    // 小表沒有的地區
    assertEquals(await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts('不存在縣')"), []);
    // 資料變了、小表過期（刷新停了）→ 看得到新資料
    await db.exec(`INSERT INTO task_dispatches (task_id, region, task_type) VALUES ('a9', '屏東縣', 'audit')`);
    assertEquals((await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts('屏東縣')"))[0], { task_type: "audit", total: 2 }, "10 分鐘內讀小表（舊值）");
    await db.exec(`UPDATE queue_task_counts_cache SET refreshed_at = now() - INTERVAL '11 minutes'`);
    assertEquals((await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts('屏東縣')"))[0], { task_type: "audit", total: 3 }, "過期退回即時算");
    assertEquals((await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts(NULL)"))[0], { task_type: "audit", total: 5 });
  } finally {
    await db.close();
  }
});

Deno.test("B3 刷新是整批重寫：任務清空的地區變成 []、不留舊值；重跑冪等", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await db.exec("SELECT queue_task_counts_refresh()");
    await db.exec("UPDATE task_dispatches SET eligible = false WHERE region = '高雄市'");
    await db.exec("SELECT queue_task_counts_refresh()");
    await db.exec("SELECT queue_task_counts_refresh()");
    assertEquals(await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts('高雄市')"), []);
    assertEquals((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM queue_task_counts_cache")).rows[0].n, 4);
    assertEquals(await rows(db, "SELECT task_type, total FROM contribution_queue_task_counts(NULL)"), [
      { task_type: "audit", total: 3 }, { task_type: "policy_missing", total: 1 }, { task_type: "question", total: 1 },
    ]);
  } finally {
    await db.close();
  }
});
