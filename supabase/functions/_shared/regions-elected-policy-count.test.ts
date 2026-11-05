/**
 * 數據分佈（/regional-data）的政見數只算當選的（維護者 2026-11-05，工作單 policy-ops#201；
 * migration 20261105010000_regions_elected_policy_count.sql）。
 *
 * 守住：①用既有的 policy_is_elected_term（不另立定義）且排除已移除；②歸屬與 policy_count 同一口徑（提出者的 region／sub_region／village 三層）；
 * ③只寫 elected_policy_count、不動 policy_count 與觸發器；④有排程重算（當選與今天有關，觸發器會過期）；⑤頁面只讀 elected_policy_count。
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const read = async (u: URL) => (await Deno.readTextFile(u)).replace(/\r\n/g, "\n");
const SQL = await read(new URL("../../migrations/20261105010000_regions_elected_policy_count.sql", import.meta.url));
const PAGE = await read(new URL("../../../pages/RegionalData.vue", import.meta.url));
const code = SQL.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

Deno.test("重算：用 policy_is_elected_term、排除已移除、歸屬三層", () => {
  assertStringIncludes(code, "policy_is_elected_term(pl.id, p_today)");
  assertStringIncludes(code, "pl.removed_at IS NULL");
  for (const lvl of ["GROUP BY region\n", "GROUP BY region, sub_region\n", "GROUP BY region, sub_region, village"]) assertStringIncludes(code, lvl);
  assertStringIncludes(code, "JOIN politicians p ON p.id = pl.politician_id");
});

Deno.test("只動 elected_policy_count：不改 policy_count、不建觸發器、不刪欄位", () => {
  assertEquals((code.match(/UPDATE regions/g) ?? []).length, 1);
  assertStringIncludes(code, "SET elected_policy_count = w.n");
  assert(!/SET\s+policy_count/i.test(code));
  assert(!/CREATE\s+(OR REPLACE\s+)?TRIGGER|DROP\s+(COLUMN|TRIGGER|TABLE)|DELETE\s+FROM|INSERT\s+INTO/i.test(code));
});

Deno.test("有排程重算並回填", () => {
  assertStringIncludes(code, "cron.schedule('regions-elected-policy-count-10min'");
  assertStringIncludes(code, "SELECT regions_elected_policy_count_refresh();");
});

Deno.test("頁面只讀 elected_policy_count", () => {
  assert(!/\bpolicy_count\b/.test(PAGE.replaceAll("elected_policy_count", "")));
  assertStringIncludes(PAGE, "政見數");
});
