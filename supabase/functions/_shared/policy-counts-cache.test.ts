/**
 * politician_election_policy_counts 改讀快取表（migration 20261128080000_policy_counts_cache.sql，2026-11-28 P1 止血）守門。
 *
 *   A. 文字層：cron 分鐘不含整十分、排程呼叫刷新函式、RLS／GRANT／policy 存在、即時版視圖不給 anon
 *   B. PGlite：先套原視圖 migration（20261118120000）再套本支，
 *      - 對外視圖欄位名、順序、型別與即時版視圖相同
 *      - 刷新後快取與即時版雙向差集為 0（含新增政見、移除政見、改 status、無政見的人、整屆消失）
 *      - anon 讀得到視圖、寫不進快取表
 *
 * 只要 --allow-read。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const read = async (f: string) => norm(await Deno.readTextFile(new URL(f, MIGRATIONS)));
const ORIG = await read("20261118120000_politician_election_policy_counts.sql");
const MIG = await read("20261128080000_policy_counts_cache.sql");
const noComments = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const sql = noComments(MIG);

Deno.test("A1 排程：分鐘不含整十分、呼叫刷新函式、有 statement_timeout", () => {
  const m = /cron\.schedule\('policy-counts-cache-refresh', '([\d,]+) \* \* \* \*', '([^']*(?:''[^']*)*)'/.exec(sql);
  assert(m, "找不到排程");
  const mins = m![1].split(",").map(Number);
  assert(mins.length >= 10, "約每 5 分鐘");
  for (const x of mins) assert(x % 10 !== 0, `${x} 是整十分（seed 窗口）`);
  assert(/policy_counts_cache_refresh\(\)/.test(m![2]));
  assert(/statement_timeout/.test(m![2]));
});

Deno.test("A2 RLS、GRANT、policy；即時版不給 anon；刷新函式只給 service_role", () => {
  assert(/ALTER TABLE politician_election_policy_counts_cache ENABLE ROW LEVEL SECURITY/.test(sql));
  assert(/GRANT SELECT ON politician_election_policy_counts_cache TO anon, authenticated/.test(sql));
  assert(/GRANT SELECT, INSERT, UPDATE, DELETE ON politician_election_policy_counts_cache TO service_role/.test(sql));
  assert(/CREATE POLICY policy_counts_cache_public_read[\s\S]*FOR SELECT TO anon, authenticated USING \(true\)/.test(sql));
  assert(/REVOKE ALL ON politician_election_policy_counts_live FROM PUBLIC, anon, authenticated/.test(sql));
  assert(/REVOKE ALL ON FUNCTION policy_counts_cache_refresh\(\) FROM PUBLIC, anon, authenticated/.test(sql));
  assert(/GRANT EXECUTE ON FUNCTION policy_counts_cache_refresh\(\) TO service_role/.test(sql));
  assert(/SECURITY DEFINER/.test(sql));
});

Deno.test("A3 對外視圖 security_invoker、GRANT 照舊、欄位順序同原視圖", () => {
  assert(/ALTER VIEW politician_election_policy_counts SET \(security_invoker = on\)/.test(sql));
  assert(/GRANT SELECT ON politician_election_policy_counts TO anon, authenticated/.test(sql));
  const view = /CREATE OR REPLACE VIEW politician_election_policy_counts AS\s*SELECT([\s\S]*?)FROM politician_election_policy_counts_cache/.exec(sql);
  assert(view, "找不到新視圖定義");
  const cols = view![1].split(",").map((s) => s.trim().replace(/^c\./, ""));
  assertEquals(cols, ["politician_id", "election_id", "pledge_count", "policy_count"]);
  // 原視圖輸出欄位順序（文字層）
  const orig = /AS\s+pledge_count|pledge_count/.exec(ORIG);
  assert(orig);
  assert(ORIG.indexOf("p.politician_id") < ORIG.indexOf("p.election_id") && ORIG.indexOf("AS pledge_count") < ORIG.indexOf("AS policy_count"));
});

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    DO $$ BEGIN
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE policies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      politician_id uuid NOT NULL,
      election_id integer,
      status text NOT NULL DEFAULT 'Campaign Pledge',
      removed_at timestamptz
    );
    GRANT SELECT ON policies TO anon, authenticated;
  `);
  await db.exec(ORIG);
  await db.exec(MIG);
  return db;
}

const P1 = "00000000-0000-0000-0000-000000000001";
const P2 = "00000000-0000-0000-0000-000000000002";
const P3 = "00000000-0000-0000-0000-000000000003";

async function diff(db: PGlite): Promise<{ missing: number; extra: number }> {
  const q = (a: string, b: string) =>
    db.query<{ c: string }>(
      `SELECT count(*) c FROM (SELECT politician_id, election_id, pledge_count, policy_count FROM ${a} EXCEPT SELECT politician_id, election_id, pledge_count, policy_count FROM ${b}) t`,
    );
  const missing = Number((await q("politician_election_policy_counts_live", "politician_election_policy_counts_cache")).rows[0].c);
  const extra = Number((await q("politician_election_policy_counts_cache", "politician_election_policy_counts_live")).rows[0].c);
  return { missing, extra };
}

Deno.test("B1 對外視圖欄位名、順序、型別與即時版相同", async () => {
  const db = await buildDb();
  const cols = async (v: string) =>
    (await db.query<{ column_name: string; data_type: string; ordinal_position: number }>(
      `SELECT column_name, data_type, ordinal_position FROM information_schema.columns WHERE table_name = '${v}' ORDER BY ordinal_position`,
    )).rows;
  assertEquals(await cols("politician_election_policy_counts"), await cols("politician_election_policy_counts_live"));
  await db.close();
});

Deno.test("B2 刷新後快取與即時版雙向差集 0（新增、移除、改 status、無政見的人、整屆消失）", async () => {
  const db = await buildDb();
  await db.exec(`
    INSERT INTO policies (politician_id, election_id, status) VALUES
      ('${P1}', 2026, 'Campaign Pledge'), ('${P1}', 2026, 'Campaign Pledge'), ('${P1}', 2026, 'In Progress'),
      ('${P1}', 2022, 'Achieved'),
      ('${P2}', 2026, 'Campaign Pledge'),
      ('${P3}', NULL, 'Campaign Pledge');   -- 沒標屆別的不算
  `);
  await db.exec(`SELECT policy_counts_cache_refresh()`);
  assertEquals(await diff(db), { missing: 0, extra: 0 });
  const r = await db.query<{ p: number; n: number }>(
    `SELECT pledge_count p, policy_count n FROM politician_election_policy_counts WHERE politician_id = '${P1}' AND election_id = 2026`,
  );
  assertEquals(r.rows, [{ p: 2, n: 3 }]);
  const none = await db.query(`SELECT 1 FROM politician_election_policy_counts WHERE politician_id = '${P3}'`);
  assertEquals(none.rows.length, 0, "沒政見／沒屆別的人不在視圖裡");

  // 新增政見、改 status、軟移除、整屆消失
  await db.exec(`
    INSERT INTO policies (politician_id, election_id, status) VALUES ('${P3}', 2026, 'Campaign Pledge');
    UPDATE policies SET status = 'Campaign Pledge' WHERE politician_id = '${P1}' AND status = 'In Progress';
    UPDATE policies SET removed_at = now() WHERE politician_id = '${P2}';
    UPDATE policies SET removed_at = now() WHERE politician_id = '${P1}' AND election_id = 2022;
  `);
  // 刷新前：快取仍是舊的（最晚 5 分鐘更新）
  assert((await diff(db)).missing + (await diff(db)).extra > 0, "刷新前快取應該還是舊值");
  await db.exec(`SELECT policy_counts_cache_refresh()`);
  assertEquals(await diff(db), { missing: 0, extra: 0 });
  const after = await db.query<{ p: number; n: number }>(
    `SELECT pledge_count p, policy_count n FROM politician_election_policy_counts WHERE politician_id = '${P1}' AND election_id = 2026`,
  );
  assertEquals(after.rows, [{ p: 3, n: 3 }]);
  const gone = await db.query(`SELECT 1 FROM politician_election_policy_counts WHERE politician_id = '${P2}' OR (politician_id = '${P1}' AND election_id = 2022)`);
  assertEquals(gone.rows.length, 0, "不再存在的鍵要刪掉");
  await db.close();
});

Deno.test("B3 migration 內已灌滿一次：套完就與即時版一致；再刷新一次冪等", async () => {
  const db = await buildDb();
  assertEquals(await diff(db), { missing: 0, extra: 0 });
  const r = await db.query<{ n: number }>(`SELECT policy_counts_cache_refresh() n`);
  assertEquals(r.rows[0].n, 0, "沒變動時不寫任何列");
  await db.close();
});

Deno.test("B4 anon 讀得到對外視圖、寫不進快取表、叫不動刷新函式、讀不到即時版", async () => {
  const db = await buildDb();
  await db.exec(`INSERT INTO policies (politician_id, election_id) VALUES ('${P1}', 2026); SELECT policy_counts_cache_refresh();`);
  await db.exec(`SET ROLE anon`);
  const rows = await db.query(`SELECT * FROM politician_election_policy_counts`);
  assertEquals(rows.rows.length, 1);
  for (const stmt of [
    `INSERT INTO politician_election_policy_counts_cache (politician_id, election_id, pledge_count, policy_count) VALUES ('${P2}', 1, 1, 1)`,
    `SELECT policy_counts_cache_refresh()`,
    `SELECT * FROM politician_election_policy_counts_live`,
  ]) {
    let failed = false;
    try {
      await db.exec(stmt);
    } catch {
      failed = true;
    }
    assert(failed, `anon 不該能執行：${stmt}`);
  }
  await db.exec(`RESET ROLE`);
  await db.close();
});
