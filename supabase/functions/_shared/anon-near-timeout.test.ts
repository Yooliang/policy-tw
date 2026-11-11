/**
 * anon 3 秒逾時邊緣的兩支函式（migration 20261111230000）：純效能，結果不變。
 *   platform_cost_public：jev_decisions 本月只掃一遍（依 model 分組再分類），不再 4 個子查詢各掃 7 萬列跑正則
 *   console_timeline：件數只算一遍，不再經 console_arm_status() 重算（改讀 console_arm_via()）
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fnText, readMig } from "./arms-pglite.ts";

const SQL = await readMig("20261111230000_anon_near_timeout.sql");

Deno.test("platform_cost_public：只有一處讀 jev_decisions、依 model 分組、簽名與權限不變", () => {
  const f = fnText(SQL, "platform_cost_public");
  assertEquals(f.split("FROM jev_decisions").length - 1, 1);
  assertStringIncludes(f, "GROUP BY j.model");
  assert(!/DROP\s+FUNCTION/i.test(SQL));
  assertStringIncludes(SQL, "GRANT EXECUTE ON FUNCTION platform_cost_public() TO anon, authenticated;");
});

Deno.test("console_timeline：不再呼叫 console_arm_status()，件數合計取自同一份 CTE；不加 CONCURRENTLY", () => {
  const f = fnText(SQL, "console_timeline");
  assert(!f.includes("console_arm_status()"));
  assertStringIncludes(f, "console_arm_via()");
  assertStringIncludes(f, "v_totals");
  assertEquals(f.split("console_arm_election_counts()").length - 1, 1);
  assert(!SQL.replace(/--[^\n]*/g, "").includes("CONCURRENTLY"));
});
