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

// 2026-11-19 數據分佈頁改版（regional-v2）：頁面不再讀 regions 的計數欄，政見數改讀聚合視圖（以 policies_by_region.listed 為準）。
// 守的前提變成：這頁與它的元件、純函式都不碰 elected_policy_count／policy_count／舊的整份政見，政見數只認新視圖。
const REGIONAL_SOURCES = [
  "../../../pages/RegionalData.vue",
  "../../../components/regional/RegionalKpi.vue",
  "../../../components/regional/StageFunnel.vue",
  "../../../components/regional/CategoryHeatmap.vue",
  "../../../components/regional/PledgeQuality.vue",
  "../../../components/regional/LineageRelay.vue",
  "../../../components/regional/DeadlineBlock.vue",
  "../../../lib/regional-overview.ts",
];

Deno.test("數據分佈頁與其元件都不讀 elected_policy_count／policy_count，政見數讀聚合視圖", async () => {
  for (const rel of REGIONAL_SOURCES) {
    const src = await read(new URL(rel, import.meta.url));
    assert(!/elected_policy_count/.test(src), `${rel} 不該讀 elected_policy_count`);
    assert(!/policy_count/.test(src), `${rel} 不該讀 policy_count`);
  }
  const kpi = await read(new URL("../../../components/regional/RegionalKpi.vue", import.meta.url));
  assertStringIncludes(kpi, "政見數");
  assertStringIncludes(kpi, "policyTotal(");
  const data = await read(new URL("../../../composables/useSupabase.ts", import.meta.url));
  assertStringIncludes(data, "region_category_stage_counts");
});
