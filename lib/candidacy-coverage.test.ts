/**
 * 參選地圖的連續色階（lib/color-scale.ts、lib/candidacy-map.ts）：端點、單調、50% 落在黃、無資料灰、超過 100% 同綠、
 * 人數模式的藍色漸層與 log 尺度、圖例、提示卡。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  COUNT_STOPS, COUNT_ZERO_COLOR, COVERAGE_STOPS, NO_DATA_COLOR, countColor, countT, coverageColor, fromOklab, gradientAt, hexToRgb, mixHex,
  rgbToHex, toOklab,
} from "./color-scale.ts";
import { coveragePercent, legendFor, tooltipLines, unitColor, type MapUnit } from "./candidacy-map.ts";

const unit = (candidates: number, registered: number | null, seats: number | null = null): MapUnit => ({
  code: "A", name: "甲", idx: 0, candidates, registered, seats,
});
const lab = (hex: string) => toOklab(hexToRgb(hex));
const hue = (hex: string) => { const [, a, b] = lab(hex); return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360; };
const chroma = (hex: string) => { const [, a, b] = lab(hex); return Math.hypot(a, b); };
const lightness = (hex: string) => lab(hex)[0];

Deno.test("OKLab 轉換來回不失真（hex → Lab → hex）", () => {
  for (const hex of ["#dc2626", "#facc15", "#16a34a", "#f5f5f5", "#171717", "#3b82f6"]) assertEquals(rgbToHex(fromOklab(toOklab(hexToRgb(hex)))), hex);
});

Deno.test("收錄率色階端點：0% 紅、50% 黃、100% 綠（就是固定的 hex），超過 100% 同綠", () => {
  assertEquals(coverageColor(0), COVERAGE_STOPS[0][1]);
  assertEquals(coverageColor(0.5), COVERAGE_STOPS[1][1]);
  assertEquals(coverageColor(1), COVERAGE_STOPS[2][1]);
  assertEquals(coverageColor(1.2), COVERAGE_STOPS[2][1]);
  assertEquals(coverageColor(25), COVERAGE_STOPS[2][1]);
  assertEquals(coverageColor(-0.3), COVERAGE_STOPS[0][1], "負數夾到 0%");
});

Deno.test("收錄率：沒有登記資料（null）是中性淺灰，登記 0 也是灰；灰色跟漸層上任何一點都不同", () => {
  assertEquals(coverageColor(null), NO_DATA_COLOR);
  assertEquals(unitColor(unit(5, null), "coverage", 100), NO_DATA_COLOR);
  assertEquals(unitColor(unit(5, 0), "coverage", 100), NO_DATA_COLOR);
  assertEquals(unitColor(unit(0, 0), "coverage", 100), NO_DATA_COLOR);
  for (let i = 0; i <= 100; i += 1) assert(coverageColor(i / 100) !== NO_DATA_COLOR);
  assert(chroma(NO_DATA_COLOR) < 0.02, "無資料灰是中性的");
});

Deno.test("收錄率漸層單調：色相沿 紅 → 黃 → 綠 一路增加，不會回頭；中段不發灰", () => {
  let prev = -1;
  for (let i = 0; i <= 100; i += 1) {
    const c = coverageColor(i / 100);
    const h = hue(c);
    assert(h >= prev - 0.01, `${i}%：色相 ${h.toFixed(1)} < 前一點 ${prev.toFixed(1)}`);
    prev = h;
    assert(chroma(c) > 0.1, `${i}%：彩度 ${chroma(c).toFixed(3)} 太低（發灰）`);
  }
  assert(hue(coverageColor(0)) < hue(coverageColor(0.5)) && hue(coverageColor(0.5)) < hue(coverageColor(1)));
  // 同一段內也有中間態：25% 不等於任何端點
  const q = coverageColor(0.25);
  assert(![COVERAGE_STOPS[0][1], COVERAGE_STOPS[1][1], COVERAGE_STOPS[2][1]].includes(q));
});

Deno.test("50% 落在黃：色相離黃端點比離紅、綠端點都近；90% 偏綠", () => {
  const near = (c: string, ref: string) => Math.abs(hue(c) - hue(ref));
  const c50 = coverageColor(0.5);
  assert(near(c50, "#facc15") < near(c50, "#dc2626") && near(c50, "#facc15") < near(c50, "#16a34a"));
  const c90 = coverageColor(0.9);
  assert(near(c90, "#16a34a") < near(c90, "#facc15"), "90% 比較接近綠");
  assert(near(coverageColor(0.1), "#dc2626") < near(coverageColor(0.1), "#facc15"), "10% 比較接近紅");
});

Deno.test("unitColor 收錄率模式：用收錄 ÷ 登記的比值（不是分段）；收錄超過登記同綠", () => {
  assertEquals(unitColor(unit(5, 10), "coverage", 100), coverageColor(0.5));
  assertEquals(unitColor(unit(9, 10), "coverage", 100), coverageColor(0.9));
  assertEquals(unitColor(unit(11, 10), "coverage", 100), COVERAGE_STOPS[2][1]);
  assert(unitColor(unit(6, 10), "coverage", 100) !== unitColor(unit(7, 10), "coverage", 100), "相鄰的比值有不同的顏色（連續）");
});

Deno.test("人數色階：0 人是最早那套最淺的灰藍；有人是淺藍到深藍的連續漸層，單調變深，最大值是最深的藍", () => {
  assertEquals(countColor(0, 100), COUNT_ZERO_COLOR);
  assertEquals(COUNT_ZERO_COLOR, "#e2e8f0");
  assertEquals(COUNT_STOPS[0][1], "#dbeafe");
  assertEquals(COUNT_STOPS[COUNT_STOPS.length - 1][1], "#1e40af");
  assertEquals(countColor(100, 100), "#1e40af");
  assertEquals(countColor(500, 100), "#1e40af", "超過最大值夾住");
  let prev = Infinity;
  for (const v of [1, 2, 3, 5, 8, 13, 30, 60, 100]) {
    const l = lightness(countColor(v, 100));
    assert(l < prev, `人數 ${v} 沒有比前一個深`);
    prev = l;
  }
  // 是藍的：色相在藍色帶（OKLab 約 250–270°）
  for (const v of [1, 10, 100]) assert(hue(countColor(v, 100)) > 235 && hue(countColor(v, 100)) < 285, `v=${v} 色相 ${hue(countColor(v, 100)).toFixed(0)}`);
  assertEquals(unitColor(unit(7, 3), "count", 100), unitColor(unit(7, null), "count", 100), "人數模式跟登記人數無關");
});

Deno.test("人數用 log 尺度：個位數之間還分得出深淺，大縣不會把小區全壓成同一色", () => {
  assert(countT(1, 800) > 0);
  assert(countT(2, 800) > countT(1, 800));
  assert(countT(10, 800) > countT(5, 800));
  assert(countT(5, 800) > 0.25, "5 人在最大 800 時也不是幾乎白的");
  assertEquals(countT(0, 800), 0);
  assertEquals(countT(800, 800), 1);
  assert(lightness(countColor(1, 800)) !== lightness(countColor(3, 800)));
});

Deno.test("mixHex／gradientAt：端點不動、中間在兩端之間", () => {
  assertEquals(mixHex("#ff0000", "#00ff00", 0), "#ff0000");
  assertEquals(mixHex("#ff0000", "#00ff00", 1), "#00ff00");
  const mid = mixHex("#000000", "#ffffff", 0.5);
  assert(lightness(mid) > 0.3 && lightness(mid) < 0.8);
  assertEquals(gradientAt(COUNT_STOPS, -1), COUNT_STOPS[0][1]);
  assertEquals(gradientAt(COUNT_STOPS, 2), COUNT_STOPS[COUNT_STOPS.length - 1][1]);
});

Deno.test("coveragePercent：收錄 ÷ 登記；登記是 0 或沒有資料＝null；超過 100% 照實回傳", () => {
  assertEquals(coveragePercent(unit(45, 50)), 90);
  assertEquals(coveragePercent(unit(12, 10)), 120);
  assertEquals(coveragePercent(unit(5, 0)), null);
  assertEquals(coveragePercent(unit(5, null)), null);
});

Deno.test("圖例：收錄率是漸層色條加 0%、50%、90%、100% 刻度與「無登記資料」；人數是藍色漸層加刻度與「0 人」", () => {
  const cov = legendFor("coverage", 0);
  assertEquals(cov.ticks.map((t) => t.label), ["0%", "50%", "90%", "100%"]);
  assertEquals(cov.ticks.map((t) => t.pos), [0, 0.5, 0.9, 1]);
  assert(cov.css.startsWith("linear-gradient(to right,") && cov.css.includes(COVERAGE_STOPS[0][1]) && cov.css.includes(COVERAGE_STOPS[2][1]));
  assertEquals(cov.noData, { color: NO_DATA_COLOR, label: "無登記資料" });

  const cnt = legendFor("count", 800);
  assertEquals(cnt.ticks[0].label, "1");
  assertEquals(cnt.ticks[cnt.ticks.length - 1].label, "800");
  assert(cnt.ticks.every((t, i) => i === 0 || t.pos > cnt.ticks[i - 1].pos), "刻度位置遞增");
  assertEquals(cnt.noData?.label, "0 人");
  assert(cnt.css.includes("#dbeafe") || cnt.css.includes("#1e40af"));
  const tiny = legendFor("count", 1);
  assertEquals(tiny.ticks.map((t) => t.label), ["1"]);
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
