/**
 * AI 判定帳戶的餘額不公開（migration 20261021040000_platform_balance_private.sql；維護者 2026-10-21）。
 *
 *   A. PGlite 實跑真的 migration（角色用 CREATE ROLE 模擬，並先設 Supabase 的「新表預設全給 anon」）：
 *      1. anon、authenticated 讀不到 platform_costs（整張表、openrouter_credits／usage）
 *      2. 公開出口 platform_cost_public() 只回等級，回傳欄位與內容都沒有金額
 *      3. 舊的 platform_cost_summary() 的 balance_usd 一律 NULL
 *      4. service_role 讀得到原始值（寫入端 system-one 與主控台仍可用）
 *      5. 等級門檻（SQL）跟前端常數（lib/agent-plans.ts）逐點一致
 *   B. 文字層：前端目錄不讀 platform_costs／balance_usd；system-one 的 costs 回應不帶餘額；
 *      本支之後沒有 migration 重新給 platform_costs 公開 policy 或 GRANT
 *   C. 還原驗證：拿掉 DROP POLICY 與 REVOKE，A1 必須紅
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { balanceTone, BALANCE_ORANGE_USD, BALANCE_RED_USD, BALANCE_YELLOW_USD } from "../../../lib/agent-plans.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
const MIG = "20261021040000_platform_balance_private.sql";
const read = async (url: URL) => (await Deno.readTextFile(url)).replace(/\r\n/g, "\n");
const MIG_SQL = await read(new URL(MIG, MIGRATIONS));

function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 60)}`);
  return sql.replace(from, () => to);
}

async function freshDb(mig: string = MIG_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    -- 20260924000008_platform_costs.sql 建的表與公開 policy（那支有 pg_cron，PGlite 跑不了，這裡照抄表與 policy）
    CREATE TABLE platform_costs (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      openrouter_credits NUMERIC,
      openrouter_usage NUMERIC,
      refreshed_at TIMESTAMPTZ
    );
    ALTER TABLE platform_costs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY platform_costs_public_read ON platform_costs FOR SELECT USING (true);
    CREATE TABLE jev_decisions (asked_at TIMESTAMPTZ, model TEXT, cost_usd NUMERIC);
    INSERT INTO platform_costs VALUES (1, 100, 97.5, now());
    INSERT INTO jev_decisions VALUES (now(), 'typesafe/x', 0.25);
  `);
  await db.exec(mig);
  return db;
}

async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}

const PUBLIC_ROLES = ["anon", "authenticated"] as const;

async function checkBlocked(db: PGlite) {
  for (const role of PUBLIC_ROLES) {
    await assertRejects(() => asRole(db, role, "SELECT * FROM platform_costs"), Error, "permission denied");
    await assertRejects(() => asRole(db, role, "SELECT openrouter_credits FROM platform_costs"), Error, "permission denied");
    await assertRejects(() => asRole(db, role, "SELECT openrouter_usage FROM platform_costs"), Error, "permission denied");
  }
}

Deno.test("A1 anon／authenticated 讀不到 platform_costs，RLS 仍開著且沒有公開 policy", async () => {
  const db = await freshDb();
  await checkBlocked(db);
  const pol = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'platform_costs'");
  assertEquals(pol.rows[0].n, 0);
  const rls = await db.query<{ r: boolean }>("SELECT relrowsecurity AS r FROM pg_class WHERE relname = 'platform_costs'");
  assertEquals(rls.rows[0].r, true);
  await db.close();
});

Deno.test("A2 platform_cost_public()：anon 只拿得到等級，欄位與內容都沒有金額", async () => {
  const db = await freshDb();
  for (const role of PUBLIC_ROLES) {
    const rows = await asRole<Record<string, unknown>>(db, role, "SELECT * FROM platform_cost_public()");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].balance_level, "orange"); // 100 − 97.5 = 2.5
    assertEquals(Object.keys(rows[0]).sort(), ["balance_level", "db_bytes", "jev_month_calls", "jev_month_usd", "refreshed_at"]);
    const text = JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
    assert(!text.includes("97.5") && !text.includes('"2.5"') && !text.includes(":2.5"), "不得帶出餘額、儲值或已用");
  }
  await db.close();
});

Deno.test("A3 舊的 platform_cost_summary() 的 balance_usd 一律 NULL，其他欄位照舊", async () => {
  const db = await freshDb();
  for (const role of PUBLIC_ROLES) {
    const rows = await asRole<{ balance_usd: unknown; jev_month_calls: unknown }>(db, role, "SELECT * FROM platform_cost_summary()");
    assertEquals(rows[0].balance_usd, null);
    assertEquals(Number(rows[0].jev_month_calls), 1);
  }
  await db.close();
});

Deno.test("A4 service_role 讀得到原始值，也寫得進去（寫入端 system-one 不受影響）", async () => {
  const db = await freshDb();
  const rows = await asRole<{ openrouter_credits: string; openrouter_usage: string }>(db, "service_role", "SELECT openrouter_credits, openrouter_usage FROM platform_costs");
  assertEquals([Number(rows[0].openrouter_credits), Number(rows[0].openrouter_usage)], [100, 97.5]);
  await asRole(db, "service_role", "UPDATE platform_costs SET openrouter_usage = 99.5 WHERE id = 1");
  const lv = await asRole<{ balance_level: string }>(db, "anon", "SELECT balance_level FROM platform_cost_public()");
  assertEquals(lv[0].balance_level, "red");
  await db.close();
});

Deno.test("A5 等級門檻：SQL 的 platform_balance_level() 與前端常數逐點一致", async () => {
  assertEquals([BALANCE_YELLOW_USD, BALANCE_ORANGE_USD, BALANCE_RED_USD], [5, 3, 1]);
  const db = await freshDb();
  for (const b of [100, 5.01, 5, 4.99, 3.01, 3, 2.99, 1.01, 1, 0.99, 0, -2]) {
    const r = await db.query<{ l: string }>(`SELECT platform_balance_level(${b}) AS l`);
    const sqlTone = r.rows[0].l === "ok" ? "none" : r.rows[0].l;
    assertEquals(sqlTone, balanceTone(b), `餘額 ${b}`);
  }
  await db.close();
});

Deno.test("B 文字層：前端不碰 platform_costs／balance_usd；system-one 的 costs 不回餘額；之後沒有 migration 重開公開讀取", async () => {
  async function* walk(dir: URL): AsyncGenerator<URL> {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) yield* walk(u);
      else if (/\.(ts|vue)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) yield u;
    }
  }
  for (const d of ["pages/", "components/", "composables/", "lib/"]) {
    for await (const f of walk(new URL(d, ROOT))) {
      const t = await read(f);
      assert(!/platform_costs|balance_usd|platform_cost_summary|openrouter_credits/.test(t), `${f.pathname} 不該讀餘額來源`);
    }
  }
  const sys = await read(new URL("supabase/functions/system-one/index.ts", ROOT));
  const costs = sys.slice(sys.indexOf('if (action === "costs")'), sys.indexOf("// ---- submission_followups"));
  assert(costs.length > 200 && costs.includes("platform_costs"), "抽到 costs 區段");
  assert(!/balance_usd|credits\s*-\s*usage/.test(costs.replace(/\/\/.*$/gm, "")), "costs 回應不得帶餘額");
  const names = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.name > MIG && e.name.endsWith(".sql")) names.push(e.name);
  for (const n of names) {
    const t = await read(new URL(n, MIGRATIONS));
    assert(!/CREATE POLICY[^;]*ON\s+platform_costs/i.test(t) && !/GRANT[^;]*ON\s+(TABLE\s+)?platform_costs[^;]*TO[^;]*(anon|authenticated|PUBLIC)/i.test(t), `${n} 不該重開 platform_costs 的公開讀取`);
  }
});

Deno.test("C 還原驗證：拿掉 DROP POLICY 與 REVOKE，A1 的檢查必須紅", async () => {
  let bad = mutate(MIG_SQL, "DROP POLICY IF EXISTS platform_costs_public_read ON platform_costs;", "");
  bad = mutate(bad, "REVOKE ALL ON TABLE platform_costs FROM anon;", "");
  bad = mutate(bad, "REVOKE ALL ON TABLE platform_costs FROM authenticated;", "");
  const db = await freshDb(bad);
  await assertRejects(() => checkBlocked(db));
  await db.close();
});
