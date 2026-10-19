/**
 * 參選地圖的收錄率著色（lib/candidacy-map.ts）：分段門檻、沒有登記資料不算紅、>100% 算綠、人數模式灰階、圖例、提示卡。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  COUNT_GRAYS, COVERAGE_COLORS, COVERAGE_GREEN_MIN, COVERAGE_YELLOW_MIN, coverageBand, coveragePercent, legendItems,
  tooltipLines, unitColor, type MapUnit,
} from "./candidacy-map.ts";

const unit = (candidates: number, registered: number | null, seats: number | null = null): MapUnit => ({
  code: "A", name: "甲", idx: 0, candidates, registered, seats,
});

Deno.test("門檻常數：90% 綠、50% 黃", () => {
  assertEquals([COVERAGE_GREEN_MIN, COVERAGE_YELLOW_MIN], [90, 50]);
});

Deno.test("coveragePercent：收錄 ÷ 登記；登記是 0 或沒有資料＝null；超過 100% 照實回傳", () => {
  assertEquals(coveragePercent(unit(45, 50)), 90);
  assertEquals(coveragePercent(unit(1, 3)), 33);
  assertEquals(coveragePercent(unit(0, 10)), 0);
  assertEquals(coveragePercent(unit(12, 10)), 120);
  assertEquals(coveragePercent(unit(5, 0)), null);
  assertEquals(coveragePercent(unit(5, null)), null);
});

Deno.test("coverageBand：≥90 綠、50–89 黃、<50 紅、沒有資料是 none（不算紅）；邊界值落在較高那一段", () => {
  assertEquals(coverageBand(100), "green");
  assertEquals(coverageBand(90), "green");
  assertEquals(coverageBand(89), "yellow");
  assertEquals(coverageBand(50), "yellow");
  assertEquals(coverageBand(49), "red");
  assertEquals(coverageBand(0), "red");
  assertEquals(coverageBand(250), "green", "收錄超過登記也算綠");
  assertEquals(coverageBand(null), "none");
});

Deno.test("unitColor 收錄率模式：綠黃紅與中性灰，登記人數 0 的格子是灰不是紅", () => {
  assertEquals(unitColor(unit(9, 10), "coverage", 100), COVERAGE_COLORS.green);
  assertEquals(unitColor(unit(6, 10), "coverage", 100), COVERAGE_COLORS.yellow);
  assertEquals(unitColor(unit(1, 10), "coverage", 100), COVERAGE_COLORS.red);
  assertEquals(unitColor(unit(0, 0), "coverage", 100), COVERAGE_COLORS.none);
  assertEquals(unitColor(unit(3, null), "coverage", 100), COVERAGE_COLORS.none);
  assertEquals(unitColor(unit(11, 10), "coverage", 100), COVERAGE_COLORS.green);
  assertEquals(new Set(Object.values(COVERAGE_COLORS)).size, 4, "四種顏色各不相同");
  assert(Object.values(COVERAGE_COLORS).every((c) => /^#[0-9a-f]{6}$/.test(c)), "固定 hex");
});

Deno.test("unitColor 人數模式：中性灰階，0 人最淺、最多最深，單調，與登記人數無關", () => {
  assertEquals(unitColor(unit(0, 50), "count", 100), COUNT_GRAYS[0]);
  assertEquals(unitColor(unit(100, null), "count", 100), COUNT_GRAYS[4]);
  const order = [0, 1, 10, 40, 100].map((n) => COUNT_GRAYS.indexOf(unitColor(unit(n, null), "count", 100) as typeof COUNT_GRAYS[number]));
  assertEquals(order, [...order].sort((a, b) => a - b));
  assert(COUNT_GRAYS.every((c) => /^#([0-9a-f])\1?/.test(c) || /^#[0-9a-f]{6}$/.test(c)));
  // 灰階：R=G=B，不含藍
  for (const c of COUNT_GRAYS) assertEquals(c.slice(1, 3) === c.slice(3, 5) && c.slice(3, 5) === c.slice(5, 7), true, c);
  assertEquals(unitColor(unit(5, 100), "count", 100), unitColor(unit(5, 2), "count", 100));
});

Deno.test("legendItems：收錄率模式標百分比與無登記資料；人數模式五段灰階", () => {
  assertEquals(legendItems("coverage").map((l) => l.label), ["90% 以上", "50–90%", "未滿 50%", "無登記資料"]);
  assertEquals(legendItems("coverage").map((l) => l.color), [COVERAGE_COLORS.green, COVERAGE_COLORS.yellow, COVERAGE_COLORS.red, COVERAGE_COLORS.none]);
  assertEquals(legendItems("count").map((l) => l.color), [...COUNT_GRAYS]);
});

Deno.test("tooltipLines：有登記人數就帶收錄率（照實顯示 >100%）；沒登記或登記 0 就沒有收錄率", () => {
  assertEquals(tooltipLines(unit(45, 50, 7)), [
    { label: "收錄參選人", value: "45 人" },
    { label: "中選會登記", value: "50 人" },
    { label: "收錄率", value: "90%" },
    { label: "應選席次", value: "7 席" },
  ]);
  assertEquals(tooltipLines(unit(12, 10)).find((l) => l.label === "收錄率")?.value, "120%");
  assertEquals(tooltipLines(unit(5, null)).map((l) => l.label), ["收錄參選人"]);
  assertEquals(tooltipLines(unit(5, 0)).map((l) => l.label), ["收錄參選人", "中選會登記"]);
});
