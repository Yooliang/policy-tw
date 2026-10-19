/**
 * 參選地圖（lib/candidacy-map.ts）的守門：層級切換、點陣與人數合併、顏色分段、連結、提示框。
 * 點陣檔本身的完整性（每個行政區至少 1 格、代碼跟 admin_divisions 一致）在 raster-data.test.ts。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  NATIONAL_VIEW, breadcrumbs, buildMap, canDrill, drillDown, drillUp, normalizeRows, parentCodeOf,
  tooltipLines, unitHref, viewKey, type CountRow,
} from "./candidacy-map.ts";

const row = (code: string, over: Partial<CountRow> = {}): CountRow => ({
  code, name: `n${code}`, parent_code: null, candidates: 0, registered: null, seats: null, ...over,
});

Deno.test("層級切換：全國 → 縣市 → 鄉鎮市區，可以一層一層回上去", () => {
  const town = drillDown(NATIONAL_VIEW, "63000");
  assertEquals(town, { level: "town", countyCode: "63000" });
  const village = drillDown(town, "63000010");
  assertEquals(village, { level: "village", countyCode: "63000", townCode: "63000010" });
  assertEquals(drillDown(village, "63000010002"), village, "村里是最底層，不再往下");
  assertEquals(drillUp(village), { level: "town", countyCode: "63000" });
  assertEquals(drillUp(town), NATIONAL_VIEW);
  assertEquals(drillUp(NATIONAL_VIEW), NATIONAL_VIEW);
  assertEquals([NATIONAL_VIEW, town, village].map(canDrill), [true, true, false]);
});

Deno.test("查資料庫的 p_parent：全國不帶、鄉鎮層帶縣市、村里層帶鄉鎮；層與上一層合起來是快取鍵", () => {
  const town = drillDown(NATIONAL_VIEW, "63000");
  const village = drillDown(town, "63000010");
  assertEquals([NATIONAL_VIEW, town, village].map(parentCodeOf), [null, "63000", "63000010"]);
  assertEquals(new Set([NATIONAL_VIEW, town, village, drillDown(NATIONAL_VIEW, "64000")].map(viewKey)).size, 4);
});

Deno.test("麵包屑：每一段點了回到那一層", () => {
  const names: Record<string, string> = { "63000": "台北市", "63000010": "松山區" };
  const nameOf = (c: string) => names[c];
  assertEquals(breadcrumbs(NATIONAL_VIEW, nameOf).map((c) => c.label), ["全國"]);
  const town = drillDown(NATIONAL_VIEW, "63000");
  assertEquals(breadcrumbs(town, nameOf).map((c) => c.label), ["全國", "台北市"]);
  const village = drillDown(town, "63000010");
  const crumbs = breadcrumbs(village, nameOf);
  assertEquals(crumbs.map((c) => c.label), ["全國", "台北市", "松山區"]);
  assertEquals(crumbs[0].view, NATIONAL_VIEW);
  assertEquals(crumbs[1].view, { level: "town", countyCode: "63000" });
  assertEquals(crumbs[2].view, village);
});

Deno.test("normalizeRows：PostgREST 回的字串數字轉成數字，空值維持 null（不是 0）", () => {
  const [a, b] = normalizeRows([
    { code: "10002", name: "宜蘭縣", parent_code: null, candidates: "255", registered: "771", seats: null },
    { code: "10004", name: "新竹縣", parent_code: null, candidates: 0, registered: null, seats: 51 },
  ]);
  assertEquals(a, { code: "10002", name: "宜蘭縣", parent_code: null, candidates: 255, registered: 771, seats: null });
  assertEquals(b.registered, null);
  assertEquals(b.seats, 51);
});

Deno.test("buildMap：點陣的行政區依序號配上人數；資料庫有、點陣沒有的進 unshaped；點陣有、資料庫沒有的人數 0", () => {
  const raster = { codes: ["A", "B", "OLD"] };
  const m = buildMap(raster, [
    row("A", { name: "甲", candidates: 5, registered: 9, seats: 3 }),
    row("B", { name: "乙", candidates: 0 }),
    row("NEW", { name: "新里", candidates: 8 }),
  ]);
  assertEquals(m.units.map((u) => [u.code, u.idx]), [["A", 0], ["B", 1], ["OLD", 2]]);
  const a = m.units[0];
  assertEquals([a.name, a.candidates, a.registered, a.seats], ["甲", 5, 9, 3]);
  assertEquals(m.units[1].registered, null);
  assertEquals([m.units[2].name, m.units[2].candidates], ["OLD", 0]);
  assertEquals(m.unshaped.map((u) => [u.code, u.idx, u.candidates]), [["NEW", -1, 8]]);
  assertEquals(m.max, 8, "顏色上界連沒有形狀的也算，清單的色塊才跟地圖同一把尺");
});

Deno.test("聚合守門：地圖加清單的人數加總等於資料庫給的人數（不多算、不漏算）", () => {
  const counts = [row("A", { candidates: 7 }), row("B", { candidates: 11 }), row("C", { candidates: 0 }), row("D", { candidates: 4 })];
  const m = buildMap({ codes: ["A", "B", "C"] }, counts);
  assertEquals([...m.units, ...m.unshaped].reduce((s, u) => s + u.candidates, 0), 22);
});

Deno.test("unitHref：縣市連縣市頁、鄉鎮連鄉鎮頁、村里連所在鄉鎮頁（照既有網址規則）", () => {
  assertEquals(unitHref(2026, NATIONAL_VIEW, { name: "台北市", code: "63000" }, {}), "/election/2026/" + encodeURIComponent("台北市"));
  const town = drillDown(NATIONAL_VIEW, "63000");
  assertEquals(
    unitHref(2026, town, { name: "松山區", code: "63000010" }, { county: "台北市" }),
    `/election/2026/${encodeURIComponent("台北市")}/${encodeURIComponent("松山區")}`,
  );
  const village = drillDown(town, "63000010");
  assertEquals(
    unitHref(2026, village, { name: "莊敬里", code: "63000010002" }, { county: "台北市", town: "松山區" }),
    `/election/2026/${encodeURIComponent("台北市")}/${encodeURIComponent("松山區")}`,
  );
});

Deno.test("tooltipLines：登記人數與席次沒有資料就不出現；0 是真的 0、照樣顯示", () => {
  const base = { code: "A", name: "甲", idx: 0, candidates: 3 };
  assertEquals(tooltipLines({ ...base, registered: null, seats: null }), [{ label: "收錄參選人", value: "3 人" }]);
  assertEquals(tooltipLines({ ...base, registered: 0, seats: 2 }).map((l) => l.label), ["收錄參選人", "中選會登記", "應選席次"]);
});
