/**
 * 兩處「改一邊漏一邊」的小事（盤點 #10，2026-10-07 維護者同意）：
 *   1. 系統票採信機率 0.95：SQL system_one_min_probability()、TS MIN_PROBABILITY、next/index.ts 兩處字面。
 *      現在 next 引用常數；SQL 與 TS 對照；別處不准再寫字面的 0.95 門檻。
 *   2. CI 的前端測試清單：以前手寫 36 個檔名（新測試漏加＝存在但沒跑），改成整個資料夾。
 */
import { assert, assertEquals, assertMatch, assertNotMatch } from "jsr:@std/assert@1";
import { MIN_PROBABILITY } from "./system-one.ts";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function latestDef(name: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  names.sort();
  const re = new RegExp(`CREATE OR REPLACE FUNCTION (?:public\\.)?${name}\\(`);
  let def: string | null = null;
  for (const n of names) {
    const sql = (await Deno.readTextFile(new URL(n, MIGRATIONS))).replace(/\r/g, "");
    const i = sql.search(re);
    if (i < 0) continue;
    const rest = sql.slice(i);
    const tag = /AS (\$[a-z]*\$)/.exec(rest);
    if (!tag) continue;
    const start = rest.indexOf(tag[0]) + tag[0].length;
    def = rest.slice(0, rest.indexOf(tag[1], start) + tag[1].length);
  }
  if (!def) throw new Error(`找不到 ${name}`);
  return def;
}

// ---- 1. 0.95 ----

Deno.test("SQL 與 TS 一致：system_one_min_probability() ＝ MIN_PROBABILITY", async () => {
  const def = await latestDef("system_one_min_probability");
  const m = /SELECT\s+([0-9.]+)::NUMERIC/i.exec(def);
  assert(m, "抓不到 SQL 的門檻");
  assertEquals(Number(m[1]), MIN_PROBABILITY);
});

Deno.test("next/index.ts 的系統票門檻引用 MIN_PROBABILITY，不寫字面 0.95", async () => {
  const text = await Deno.readTextFile(new URL("../next/index.ts", import.meta.url));
  assertMatch(text, /import \{ MIN_PROBABILITY \} from "\.\.\/_shared\/system-one\.ts";/);
  assertMatch(text, /Number\(sv\.probability\) >= MIN_PROBABILITY/);
  assertMatch(text, /min_probability: MIN_PROBABILITY,/);
  assertNotMatch(text, /(>=|min_probability:)\s*0\.95\b/);
});

Deno.test("任何端點與共用模組都不再寫字面的 0.95 採信門檻（要改就改 MIN_PROBABILITY 與 SQL 那一行）", async () => {
  const hits: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(new URL(e.name + "/", dir), rel + e.name + "/");
        continue;
      }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      const text = (await Deno.readTextFile(new URL(e.name, dir))).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
      if (/(>=|<|min_probability:|MIN_PROBABILITY\s*=)\s*0\.95\b/.test(text) && rel + e.name !== "_shared/system-one.ts") hits.push(rel + e.name);
    }
  }
  await walk(new URL("../", import.meta.url), "");
  assertEquals(hits, []);
});

// ---- 2. CI 測試清單 ----

Deno.test("CI 的前端測試整個資料夾交給 deno 找，不手寫檔名；lib/ 與 cloudflare/ 底下的 *.test.ts 都在範圍內", async () => {
  const ci = (await Deno.readTextFile(new URL("../../../.github/workflows/ci.yml", import.meta.url))).replace(/\r/g, "");
  const denoLines = ci.split("\n").filter((l) => /^\s*run:\s*deno test\b/.test(l));
  assert(denoLines.length >= 2, "找不到 CI 的 deno test 步驟");
  const frontend = denoLines.filter((l) => !/_shared\//.test(l));
  assertEquals(frontend.length, 1, "前端純函式那一步");
  assertMatch(frontend[0], /deno test --allow-read lib\/ cloudflare\/\s*$/);
  for (const l of denoLines) assertNotMatch(l, /\.test\.ts/, "CI 不要再手寫測試檔名（漏加＝測試存在但沒跑）");

  // 範圍涵蓋所有真的有測試的資料夾：lib、cloudflare 以外不能出現新的前端測試資料夾
  const roots = new Set<string>();
  async function walk(dir: URL, rel: string) {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) await walk(new URL(e.name + "/", dir), rel + e.name + "/");
      } else if (/\.test\.(ts|mjs|js)$/.test(e.name)) roots.add(rel.split("/")[0]);
    }
  }
  const repo = new URL("../../../", import.meta.url);
  for (const top of ["lib", "cloudflare", "components", "composables", "pages", "router", "scripts"]) {
    try { await walk(new URL(top + "/", repo), top + "/"); } catch { /* 沒這個資料夾 */ }
  }
  assertEquals([...roots].sort(), ["cloudflare", "lib"], "有測試的前端資料夾都要在 CI 的 deno test 範圍內（目前是 lib/ 與 cloudflare/）");
});
