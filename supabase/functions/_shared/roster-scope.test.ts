/**
 * 名單清查加入鄉鎮市長、原住民區長（2026-10-03）。守兩件事：
 *   1. 這兩種只派到真的有這種選舉的縣市（鄉鎮市長 13 縣、原住民區長 4 直轄市），不對其他縣市派注定 0 人的任務
 *   2. arms() 重寫時，原本八支臂一支都沒少，而且 roster_check 有經過範圍過濾
 */
import { assert, assertStringIncludes } from "jsr:@std/assert@1";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

async function latestFunctionBody(fn: string): Promise<string> {
  const names: string[] = [];
  for await (const e of Deno.readDir(MIGRATIONS)) if (e.isFile && e.name.endsWith(".sql")) names.push(e.name);
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, MIGRATIONS));
    const from = sql.lastIndexOf(`FUNCTION ${fn}(`);
    if (from < 0 || !sql.slice(0, from).match(/CREATE OR REPLACE\s*$/)) continue;
    const ends = [sql.indexOf("COMMENT ON FUNCTION", from), sql.indexOf("CREATE OR REPLACE FUNCTION", from + 10)].filter((i) => i > from);
    return sql.slice(from, ends.length > 0 ? Math.min(...ends) : undefined);
  }
  throw new Error(`沒有任何 migration 定義 ${fn}`);
}

Deno.test("arms()：八支臂都在，roster_check 依範圍過濾", async () => {
  const arms = (await latestFunctionBody("contribution_auto_tasks_arms")).replace(/\s+/g, " ");
  for (const arm of ["raw", "dup", "legacy", "mismatch", "policy_dup", "not_running", "mayor_policies", "term_policies", "roster_villages"]) {
    assertStringIncludes(arms, `FROM contribution_auto_tasks_${arm}()`, `arms 漏了 contribution_auto_tasks_${arm}`);
  }
  assertStringIncludes(arms, "roster_scope_covers(r.target->>'election_type', r.region)");
});

Deno.test("範圍：鄉鎮市長只派 13 縣、原住民區長只派 4 直轄市", async () => {
  const sql = await Deno.readTextFile(new URL("20261003000004_roster_scope_township_heads.sql", MIGRATIONS));
  const flat = sql.replace(/\s+/g, " ");
  const township = flat.match(/'鄉鎮市長',[^;]*?ARRAY\[([^\]]+)\]/)?.[1] ?? "";
  const indigenous = flat.match(/'直轄市山地原住民區長',[^;]*?ARRAY\[([^\]]+)\]/)?.[1] ?? "";
  assert(township.split(",").length === 13, `鄉鎮市長應為 13 縣：${township}`);
  assert(indigenous.split(",").length === 4, `原住民區長應為 4 直轄市：${indigenous}`);
  // 直轄市與省轄市沒有鄉鎮市長
  for (const city of ["台北市", "新北市", "桃園市", "台中市", "台南市", "高雄市", "基隆市", "新竹市", "嘉義市"]) {
    assert(!township.includes(`'${city}'`), `${city} 沒有鄉鎮市長`);
  }
});
