/**
 * #349 第二階段 B（刪 related_policies 表與 related_policies_uncovered 視圖）的守門測試。
 *   1. migration 20261009220000：先查表與視圖是空的，依賴順序 DROP 觸發器、視圖、表、函式，policies_with_logs 重建後沒有 related_policy_ids、
 *      最後一欄仍是 no_public_progress，結尾自檢
 *   2. 之後的 migration 不得重建 related_policies／related_policies_uncovered／related_policy_ids
 *   3. PGlite 實跑：空表時能刪、重建後欄位正確；表有資料時整支退回
 *   4. repo 內（前端、Edge Function、腳本、Worker、協議文件）不得再有讀寫：from("related_policies")、SQL 的 FROM／JOIN／INSERT／UPDATE、related_policy_ids、relatedPolicyIds
 * 
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";

const ROOT = new URL("../../../", import.meta.url);
const MIGRATIONS = new URL("supabase/migrations/", ROOT);
const FILE = "20261009220000_drop_related_policies.sql";

/** 去掉 -- 註解再比對，說明文字裡提到 DROP／表名不算 */
function code(sql: string): string {
  return sql.replace(/\r/g, "").split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

Deno.test("migration 刪除順序：觸發器 → 視圖 → 視圖 → 表 → 函式 → 重建 policies_with_logs", async () => {
  const sql = code(await Deno.readTextFile(new URL(FILE, MIGRATIONS)));
  const order = [
    /DROP TRIGGER IF EXISTS related_policies_no_write ON related_policies/,
    /DROP VIEW IF EXISTS related_policies_uncovered/,
    /DROP VIEW IF EXISTS policies_with_logs/,
    /DROP TABLE IF EXISTS related_policies;/,
    /DROP FUNCTION IF EXISTS related_policies_retired\(\)/,
    /CREATE VIEW policies_with_logs AS/,
  ];
  let at = -1;
  for (const re of order) {
    const m = re.exec(sql);
    assert(m, `缺少 ${re}`);
    assert(m.index > at, `順序不對：${re}`);
    at = m.index;
  }
});

Deno.test("migration 先確認空的才刪，結尾自檢", async () => {
  const sql = code(await Deno.readTextFile(new URL(FILE, MIGRATIONS)));
  assert(/SELECT count\(\*\) FROM related_policies\)\s*<>\s*0[\s\S]*RAISE EXCEPTION/.test(sql), "表不是空的要整支退回");
  assert(/SELECT count\(\*\) FROM related_policies_uncovered\)\s*<>\s*0[\s\S]*RAISE EXCEPTION/.test(sql), "視圖不是空的要整支退回");
  assert(/SELECT count\(\*\) FROM policies_with_logs\) <> b\.n_pwl/.test(sql), "policies_with_logs 列數要核對");
  assert(/column_name = 'related_policy_ids'/.test(sql), "要核對 related_policy_ids 已不在");
  assert(/<> 'no_public_progress'/.test(sql), "no_public_progress 要仍是最後一欄");
});

Deno.test("重建的 policies_with_logs 沒有 related_policy_ids，其餘欄位順序不變、仍是 security_invoker 且給 anon 讀", async () => {
  const sql = code(await Deno.readTextFile(new URL(FILE, MIGRATIONS)));
  const view = sql.slice(sql.indexOf("CREATE VIEW policies_with_logs AS"));
  const body = view.slice(0, view.indexOf("FROM policies p;"));
  assertFalse(/related_policy/.test(body), "重建的視圖不能再碰 related_policies");
  const cols = [...body.matchAll(/\bAS (\w+)\b/g)].map((m) => m[1]);
  assert(cols.join() === "logs,elements,lineage,sources,no_public_progress", `欄位順序：${cols.join()}`);
  assert(/ALTER VIEW policies_with_logs SET \(security_invoker = on\)/.test(view));
  assert(/GRANT SELECT ON policies_with_logs TO anon, authenticated/.test(view));
});

Deno.test("之後的 migration 不得重建 related_policies／related_policies_uncovered／related_policy_ids", async () => {
  const hits: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) {
    if (!e.name.endsWith(".sql") || e.name <= FILE) continue;
    const sql = code(await Deno.readTextFile(new URL(e.name, MIGRATIONS)));
    if (/CREATE\s+(OR\s+REPLACE\s+)?(TABLE|VIEW|FUNCTION|TRIGGER)[^;]*\brelated_polic/i.test(sql) || /related_policy_ids/.test(sql) ||
        /(FROM|JOIN|INTO|UPDATE)\s+related_policies\b/i.test(sql)) hits.push(e.name);
  }
  assertFalse(hits.length > 0, `這些 migration 又碰了 related_policies：${hits.join("、")}。政見之間的相關讀 lineage`);
});

Deno.test("repo 內沒有任何讀寫 related_policies 的程式（前端、Edge Function、腳本、Worker、協議）", async () => {
  const hits: string[] = [];
  const skipDirs = new Set(["node_modules", ".git", "dist", ".claude", "migrations", "docs"]);
  const exts = /\.(ts|vue|js|mjs|sql|md|txt|json)$/;
  const bad = [
    /from\(\s*['"`]related_policies/,
    /(FROM|JOIN|INTO|UPDATE)\s+related_policies\b/i,
    /related_policy_ids|relatedPolicyIds/,
  ];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.name.startsWith(".")) continue; // 暫存檔（.pr.md、.pr.diff）與 .git／.claude 不是 repo 內容
      if (e.isDirectory) { if (!skipDirs.has(e.name)) await walk(new URL(e.name + "/", dir)); continue; }
      if (!exts.test(e.name) || e.name.endsWith(".test.ts") || e.name === "pnpm-lock.yaml") continue;
      const u = new URL(e.name, dir);
      const text = await Deno.readTextFile(u);
      if (bad.some((re) => re.test(text))) hits.push(u.pathname);
    }
  };
  await walk(ROOT);
  assertFalse(hits.length > 0, `這些檔案還在讀寫 related_policies：${hits.join("、")}`);
});

// ── PGlite 實跑 ──────────────────────────────────────────────
const BEFORE_VIEW = `SELECT p.*, (SELECT json_agg(rp.related_policy_id) FROM related_policies rp WHERE rp.policy_id = p.id) AS related_policy_ids FROM policies p`;
async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE lineages (id uuid PRIMARY KEY, title text, level text, region text, sub_region text, category text, summary text);
    CREATE TABLE policies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, lineage_id uuid);
    CREATE TABLE tracking_logs (id bigserial PRIMARY KEY, date date, event text, description text, policy_id uuid);
    CREATE TABLE policy_elements (id uuid PRIMARY KEY, policy_id uuid, element text, stated boolean, text text, deadline_date date, source_locator text, source_url text, updated_at timestamptz);
    CREATE TABLE sources (id bigint PRIMARY KEY, url text, title text, publisher text, source_kind text, archive_url text);
    CREATE TABLE source_refs (target_table text, target_id text, source_id bigint, role text);
    CREATE FUNCTION source_brief_list(t text, i text) RETURNS json LANGUAGE sql AS $$ SELECT '[]'::json $$;
    CREATE FUNCTION policy_no_public_progress(p uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    CREATE TABLE related_policies (id serial PRIMARY KEY, policy_id uuid REFERENCES policies(id), related_policy_id uuid REFERENCES policies(id));
    CREATE FUNCTION related_policies_retired() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'retired'; END $$;
    CREATE TRIGGER related_policies_no_write BEFORE INSERT OR UPDATE ON related_policies FOR EACH ROW EXECUTE FUNCTION related_policies_retired();
    CREATE VIEW related_policies_uncovered AS SELECT policy_id, related_policy_id FROM related_policies;
    CREATE VIEW policies_with_logs AS ${BEFORE_VIEW};
    INSERT INTO policies (title) VALUES ('a'), ('b');
  `);
  return db;
}
const exists = async (db: PGlite, name: string) => (await db.query<{ r: string | null }>(`SELECT to_regclass('${name}')::text AS r`)).rows[0].r !== null;

Deno.test("PGlite：空表時整支能跑，表、視圖、觸發器函式都沒了，policies_with_logs 欄位正確、列數不變", async () => {
  const db = await freshDb();
  try {
    await db.exec(await Deno.readTextFile(new URL(FILE, MIGRATIONS)));
    assertFalse(await exists(db, "related_policies"));
    assertFalse(await exists(db, "related_policies_uncovered"));
    const fn = await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'related_policies_retired'`);
    assertEquals(fn.rows.length, 0);
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'policies_with_logs' ORDER BY ordinal_position`)).rows.map((r) => r.column_name);
    assertEquals(cols.join(), "id,title,lineage_id,logs,elements,lineage,sources,no_public_progress");
    assertEquals((await db.query(`SELECT 1 FROM policies_with_logs`)).rows.length, 2);
    assertEquals((await db.query(`SELECT 1 FROM pg_class WHERE relname = '_drop_rp_before'`)).rows.length, 0, "暫存表要清掉");
  } finally { await db.close(); }
});

Deno.test("PGlite：表有資料時整支 migration 退回，表、視圖、觸發器原封不動", async () => {
  const db = await freshDb();
  try {
    await db.exec(`ALTER TABLE related_policies DISABLE TRIGGER related_policies_no_write;
      INSERT INTO related_policies (policy_id, related_policy_id) SELECT a.id, b.id FROM policies a, policies b WHERE a.title = 'a' AND b.title = 'b';
      ALTER TABLE related_policies ENABLE TRIGGER related_policies_no_write;`);
    let err = "";
    try { await db.exec(await Deno.readTextFile(new URL(FILE, MIGRATIONS))); } catch (e) { err = (e as Error).message; }
    assert(/related_policies 不是空的/.test(err), `應該被前置檢查擋下：${err}`);
    await db.exec("ROLLBACK").catch(() => {});
    assert(await exists(db, "related_policies"));
    assert(await exists(db, "related_policies_uncovered"));
    const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'policies_with_logs'`)).rows.map((r) => r.column_name);
    assert(cols.includes("related_policy_ids"), "退回後視圖要還是舊的");
    assertEquals((await db.query(`SELECT 1 FROM related_policies`)).rows.length, 1);
  } finally { await db.close(); }
});
