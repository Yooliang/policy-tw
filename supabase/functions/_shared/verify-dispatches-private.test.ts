/**
 * verify_dispatches 不公開可讀（#495；migration 20261009120000_verify_dispatches_private.sql）。
 *
 * 表裡有 ip_hash（來源網段雜湊）與 agent_name；原本 `verify_dispatches_read USING (true)` 加上 Supabase 預設的
 * 表權限，讓公開的 anon key 就讀得到。只要 --allow-read（CI 的 deno test --allow-read _shared/ 就跑）。
 *
 *   A. PGlite 實跑真的 migration（建表那支、dispatch_recent 那支、本支），角色用 CREATE ROLE 模擬，
 *      並先設 ALTER DEFAULT PRIVILEGES 模擬 Supabase「新表預設全給 anon／authenticated」：
 *      1. anon、authenticated 直接 SELECT 整張表、單讀 ip_hash／agent_name 都被擋
 *      2. 寫入也不行
 *      3. 公開出口 dispatch_recent() 照常：anon 讀得到代號與時間，回傳欄位沒有 ip_hash
 *      4. service_role 讀寫照常；以 INVOKER 身分讀這張表的函式，anon 呼叫會大聲失敗（不是安靜讀到 0 列）
 *      5. 套用兩次成功（冪等）
 *   B. 文字層：前端目錄（pages、components、composables、lib）沒有任何直接讀這張表；
 *      本支之後沒有任何 migration 重新建 verify_dispatches 的公開 policy 或 GRANT
 *   C. 還原驗證：把 migration 改壞一處（拿掉 DROP POLICY／拿掉 REVOKE），對應檢查必須紅
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const ROOT = new URL("../../../", import.meta.url);
const CREATE_MIG = "20260921000014_verify_dispatch.sql";
const RECENT_MIG = "20260924000007_dispatch_recent.sql";
const FIX_MIG = "20261009120000_verify_dispatches_private.sql";
const read = async (name: string) => (await Deno.readTextFile(new URL(name, MIGRATIONS))).replace(/\r\n/g, "\n");
const CREATE_SQL = await read(CREATE_MIG);
const RECENT_SQL = await read(RECENT_MIG);
const FIX_SQL = await read(FIX_MIG);

/** 精確改一處：改不到或改到兩處都算失敗（標記字串必須唯一，不然還原驗證可能什麼都沒改） */
function mutate(sql: string, from: string, to: string): string {
  const n = sql.split(from).length - 1;
  assertEquals(n, 1, `要改的字串必須剛好出現一次（出現 ${n} 次）：${from.slice(0, 60)}`);
  return sql.replace(from, () => to);
}

const IP = "ip-hash-secret-aaaa";
const AGENT = "a-zhen";

async function freshDb(fix: string | null = FIX_SQL): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    -- Supabase 的預設：postgres 在 public 建的新表，anon／authenticated／service_role 全有權限
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
    -- 本檔需要的最小外部表
    CREATE TABLE contributions (id UUID PRIMARY KEY);
    CREATE TABLE contribution_task_leases (task_id TEXT PRIMARY KEY, agent_name TEXT, leased_until TIMESTAMPTZ NOT NULL);
  `);
  await db.exec(CREATE_SQL);
  await db.exec(RECENT_SQL);
  if (fix) await db.exec(fix);
  await db.exec(`
    INSERT INTO contributions (id) VALUES ('00000000-0000-0000-0000-000000000001');
    INSERT INTO verify_dispatches (contribution_id, ip_hash, agent_name)
      VALUES ('00000000-0000-0000-0000-000000000001', '${IP}', '${AGENT}');
    -- 以 INVOKER 身分讀這張表的函式（等同 contribution_verify_pool 的情況）
    CREATE FUNCTION invoker_reader() RETURNS BIGINT LANGUAGE sql STABLE AS $$ SELECT count(*) FROM verify_dispatches $$;
  `);
  return db;
}

async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T[]> {
  return await db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    return (await tx.query<T>(sql)).rows;
  });
}

const PUBLIC_ROLES = ["anon", "authenticated"] as const;

// ============================================================
// A. 行為層
// ============================================================
async function checkBlocked(db: PGlite) {
  for (const role of PUBLIC_ROLES) {
    await assertRejects(() => asRole(db, role, "SELECT * FROM verify_dispatches"), Error, "permission denied");
    await assertRejects(() => asRole(db, role, "SELECT ip_hash FROM verify_dispatches"), Error, "permission denied");
    await assertRejects(() => asRole(db, role, "SELECT agent_name FROM verify_dispatches"), Error, "permission denied");
    await assertRejects(() => asRole(db, role, "SELECT count(*) FROM verify_dispatches"), Error, "permission denied");
  }
}

Deno.test("A1 anon／authenticated 讀不到 verify_dispatches（整張表、ip_hash、agent_name、計數都擋）", async () => {
  const db = await freshDb();
  await checkBlocked(db);
  // 保險：連權限層都沒擋的話，RLS 本身也不能是 USING (true)
  const pol = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'verify_dispatches'");
  assertEquals(pol.rows[0].n, 0, "不該留任何 policy");
  const rls = await db.query<{ r: boolean }>("SELECT relrowsecurity AS r FROM pg_class WHERE relname = 'verify_dispatches'");
  assertEquals(rls.rows[0].r, true, "RLS 仍須開著（縱深防禦）");
  await db.close();
});

Deno.test("A2 anon／authenticated 寫不進、改不了、刪不掉", async () => {
  const db = await freshDb();
  for (const role of PUBLIC_ROLES) {
    await assertRejects(() => asRole(db, role, "INSERT INTO verify_dispatches (contribution_id, ip_hash) VALUES ('00000000-0000-0000-0000-000000000001', 'x')"), Error, "permission denied");
    await assertRejects(() => asRole(db, role, "UPDATE verify_dispatches SET agent_name = 'x'"), Error, "permission denied");
    await assertRejects(() => asRole(db, role, "DELETE FROM verify_dispatches"), Error, "permission denied");
  }
  await db.close();
});

Deno.test("A3 公開出口 dispatch_recent() 照常：anon 讀得到代號，回傳欄位沒有 ip_hash", async () => {
  const db = await freshDb();
  for (const role of PUBLIC_ROLES) {
    const rows = await asRole<Record<string, unknown>>(db, role, "SELECT * FROM dispatch_recent(30)");
    assertEquals(rows.length, 1, `${role} 該讀得到這一筆派發`);
    assertEquals(rows[0].kind, "verify");
    assertEquals(rows[0].agent_name, AGENT);
    assertEquals(Object.keys(rows[0]).sort(), ["active_until", "agent_name", "dispatched_at", "kind", "task_id"]);
    assert(!JSON.stringify(rows).includes(IP), "回傳內容不得帶出 ip_hash");
  }
  await db.close();
});

Deno.test("A4 service_role 讀寫照常；INVOKER 函式被 anon 呼叫會大聲失敗而不是安靜讀到 0 列", async () => {
  const db = await freshDb();
  const rows = await asRole<{ ip_hash: string; agent_name: string }>(db, "service_role", "SELECT ip_hash, agent_name FROM verify_dispatches");
  assertEquals(rows, [{ ip_hash: IP, agent_name: AGENT }]);
  await asRole(db, "service_role", "INSERT INTO verify_dispatches (contribution_id, ip_hash, agent_name) VALUES ('00000000-0000-0000-0000-000000000001', 'other', 'b')");
  assertEquals((await asRole<{ n: number }>(db, "service_role", "SELECT count(*)::int AS n FROM verify_dispatches"))[0].n, 2);
  assertEquals(Number((await asRole<{ c: string }>(db, "service_role", "SELECT invoker_reader() AS c"))[0].c), 2);
  for (const role of PUBLIC_ROLES) {
    await assertRejects(() => asRole(db, role, "SELECT invoker_reader()"), Error, "permission denied");
  }
  await db.close();
});

Deno.test("A5 migration 套用兩次成功（冪等）", async () => {
  const db = await freshDb();
  await db.exec(FIX_SQL);
  await checkBlocked(db);
  await db.close();
});

// ============================================================
// B. 文字層
// ============================================================
const TBL = String.raw`(?:"?public"?\.)?"?verify_dispatches"?`;
const POLICY_RE = new RegExp(String.raw`CREATE\s+POLICY\s+(?:\w+|"[^"]+")\s+ON\s+${TBL}(?![\w"])`, "i");
const GRANT_RE = new RegExp(String.raw`GRANT\s+[^;]*\bON\s+(?:TABLE\s+)?${TBL}(?![\w"])[^;]*\bTO\s+[^;]*\b(?:anon|authenticated|PUBLIC)\b`, "i");
/** 回傳這段 SQL 重新公開 verify_dispatches 的原因（沒有就空陣列） */
const reopens = (sql: string): string[] => {
  const s = sql.replace(/--.*$/gm, "");
  return [POLICY_RE.test(s) ? "policy" : "", GRANT_RE.test(s) ? "grant" : ""].filter(Boolean);
};

Deno.test("B1 前端沒有直接讀 verify_dispatches（含 router、根目錄的 .vue／.ts）", async () => {
  const hits: string[] = [];
  const isSrc = (n: string) => /\.(vue|ts|tsx|js|mjs)$/.test(n) && !/\.test\.ts$/.test(n);
  const check = async (dir: URL, name: string, rel: string) => {
    if ((await Deno.readTextFile(new URL(name, dir))).includes("verify_dispatches")) hits.push(rel + name);
  };
  async function walk(dir: URL, rel: string) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) await walk(new URL(e.name + "/", dir), rel + e.name + "/");
      else if (isSrc(e.name)) await check(dir, e.name, rel);
    }
  }
  for (const d of ["pages", "components", "composables", "lib", "router"]) {
    try { await walk(new URL(d + "/", ROOT), d + "/"); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
  }
  // 根目錄只看檔案本身（App.vue、main.ts…），不往下走
  let rootScanned = 0;
  for await (const e of Deno.readDir(ROOT)) if (e.isFile && isSrc(e.name)) { rootScanned++; await check(ROOT, e.name, ""); }
  assert(rootScanned > 0, "根目錄應該掃得到 App.vue／main.ts");
  assertEquals(hits, [], "前端不得直接讀 verify_dispatches；要公開的欄位走 dispatch_recent()");
});

Deno.test("B2 本支之後沒有 migration 重新公開這張表", async () => {
  const later: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql") && e.name > FIX_MIG) later.push(e.name);
  for (const name of later.sort()) assertEquals(reopens(await read(name)), [], `${name} 不得重新公開 verify_dispatches`);
});

Deno.test("B3 還原驗證：B2 的偵測對帶引號、帶空格的 policy 名稱與各種 GRANT 寫法會紅", () => {
  const bad = [
    'CREATE POLICY "Public read" ON verify_dispatches FOR SELECT USING (true);',
    'create policy "x" on public.verify_dispatches for select using (true);',
    'CREATE POLICY pub ON "public"."verify_dispatches" FOR SELECT USING (true);',
    "GRANT SELECT ON verify_dispatches TO anon;",
    "GRANT ALL ON TABLE public.verify_dispatches TO authenticated, service_role;",
    "grant select on table verify_dispatches to public;",
  ];
  for (const sql of bad) assert(reopens(sql).length > 0, `應該抓到：${sql}`);
  const good = [
    "GRANT SELECT ON verify_dispatches TO service_role;",
    "CREATE POLICY p ON other_table FOR SELECT USING (true);",
    "-- CREATE POLICY p ON verify_dispatches FOR SELECT USING (true);",
    "GRANT SELECT ON verify_dispatches_extra TO anon;",
  ];
  for (const sql of good) assertEquals(reopens(sql), [], `不該誤報：${sql}`);
});

// ============================================================
// C. 還原驗證
// ============================================================
Deno.test("C1 還原驗證：拿掉修正（不套本支 migration）時 A1 必須紅", async () => {
  const db = await freshDb(null);
  await assertRejects(() => checkBlocked(db), Error);
  await db.close();
});

Deno.test("C2 還原驗證：只拿掉 REVOKE（policy 已刪）時，anon 直接 SELECT 仍須被擋的檢查要紅", async () => {
  const db = await freshDb(mutate(FIX_SQL, "REVOKE ALL ON TABLE verify_dispatches FROM PUBLIC, anon, authenticated;", ""));
  await assertRejects(() => checkBlocked(db), Error);
  await db.close();
});

Deno.test("C3 還原驗證：只拿掉 DROP POLICY（REVOKE 還在）時，policy 檢查要紅", async () => {
  const db = await freshDb(mutate(FIX_SQL, "DROP POLICY IF EXISTS verify_dispatches_read ON verify_dispatches;", ""));
  const pol = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'verify_dispatches'");
  assert(pol.rows[0].n !== 0, "拿掉 DROP POLICY 後應該還留著 policy（A1 的 policy 斷言會紅）");
  await db.close();
});
