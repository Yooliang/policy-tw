/**
 * #349 第二階段 B（刪 related_policies 表與 related_policies_uncovered 視圖）的守門測試。
 *   1. migration 20261009220000：先查表與視圖是空的，依賴順序 DROP 觸發器、視圖、表、函式，policies_with_logs 重建後沒有 related_policy_ids、
 *      最後一欄仍是 no_public_progress，結尾自檢
 *   2. 之後的 migration 不得重建 related_policies／related_policies_uncovered／related_policy_ids
 *   3. repo 內（前端、Edge Function、腳本、Worker、協議文件）不得再有讀寫：from("related_policies")、SQL 的 FROM／JOIN／INSERT／UPDATE、related_policy_ids、relatedPolicyIds
 * SQL 本身另外在 PGlite（WASM Postgres）上實跑過，見 PR 說明；這裡沒有資料庫。
 */
import { assert, assertFalse } from "jsr:@std/assert@1";

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
