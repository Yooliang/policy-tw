/**
 * 參選地圖（lib/candidacy-map.ts）的守門：層級切換、座標與人數合併、顏色分段、連結、提示框，
 * 以及預先產生的座標檔（data/tw-grid-*.json）的完整性。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  NATIONAL_VIEW, breadcrumbs, buildMap, canDrill, drillDown, drillUp, normalizeRows, parentCodeOf, rampIndex,
  tooltipLines, unitHref, viewKey, type CountRow, type GridRow,
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

Deno.test("buildMap：座標與人數按代碼合併；資料庫沒有的舊代碼不畫；座標檔沒有的補在空格", () => {
  const grid: GridRow[] = [
    ["A", "甲", 0, 0],
    ["B", "乙", 2, 0],
    ["OLD", "舊里", 1, 0], // 區劃調整後不存在
    ["C", "丙", 0, 1],
  ];
  const counts = [
    row("A", { name: "甲", candidates: 5, registered: 9, seats: 3 }),
    row("B", { name: "乙", candidates: 0 }),
    row("C", { name: "丙", candidates: 2 }),
    row("NEW", { name: "新里", candidates: 1 }),
  ];
  const m = buildMap(grid, counts);
  assertEquals(m.units.length, 4);
  assert(!m.units.some((u) => u.code === "OLD"));
  assertEquals(new Set(m.units.map((u) => `${u.x},${u.y}`)).size, 4);
  const neu = m.units.find((u) => u.code === "NEW")!;
  assertEquals([neu.x, neu.y], [1, 0], "補在外框內最前面的空格（舊代碼讓出來的位置）");
  assertEquals(m.max, 5);
  const a = m.units.find((u) => u.code === "A")!;
  assertEquals([a.candidates, a.registered, a.seats], [5, 9, 3]);
  assertEquals(m.units.find((u) => u.code === "B")!.registered, null);
  assertEquals([m.cols, m.rows], [3, 2]);
});

Deno.test("buildMap：名稱以資料庫為準，空名稱退回座標檔", () => {
  const m = buildMap([["A", "座標名", 0, 0], ["B", "座標乙", 1, 0]], [row("A", { name: "官方名" }), row("B", { name: "" })]);
  assertEquals(m.units.map((u) => u.name), ["官方名", "座標乙"]);
});

Deno.test("buildMap：整層都沒有座標也能排出來", () => {
  const m = buildMap([], [row("X"), row("Y"), row("Z")]);
  assertEquals(m.units.length, 3);
  assertEquals(new Set(m.units.map((u) => `${u.x},${u.y}`)).size, 3);
});

Deno.test("聚合守門：合併後的人數加總等於資料庫給的人數（不多算、不漏算）", () => {
  const counts = [row("A", { candidates: 7 }), row("B", { candidates: 11 }), row("C", { candidates: 0 })];
  const m = buildMap([["A", "a", 0, 0], ["B", "b", 1, 0], ["C", "c", 2, 0]], counts);
  assertEquals(m.units.reduce((s, u) => s + u.candidates, 0), 18);
});

Deno.test("rampIndex：0 人固定第 0 段，1 人以上 1～4 段、單調不減、最大值落在第 4 段", () => {
  assertEquals(rampIndex(0, 100), 0);
  assertEquals(rampIndex(-3, 100), 0);
  assertEquals(rampIndex(1, 100), 1);
  assertEquals(rampIndex(100, 100), 4);
  assertEquals(rampIndex(1, 1), 4, "最大值只有 1 時，有人的格子直接最深");
  assertEquals(rampIndex(5, 0), 4);
  let prev = 0;
  for (let v = 0; v <= 100; v += 1) {
    const i = rampIndex(v, 100);
    assert(i >= prev && i >= 0 && i <= 4, `v=${v} i=${i}`);
    prev = i;
  }
  assertEquals(new Set([1, 10, 30, 60, 100].map((v) => rampIndex(v, 100))).size, 4, "四個有人的段都用得到");
});

Deno.test("unitHref：縣市格連縣市頁、鄉鎮格連鄉鎮頁、村里格連所在鄉鎮頁（照既有網址規則）", () => {
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
  const base = { code: "A", name: "甲", x: 0, y: 0, candidates: 3 };
  assertEquals(tooltipLines({ ...base, registered: null, seats: null }), [{ label: "收錄參選人", value: "3 人" }]);
  assertEquals(tooltipLines({ ...base, registered: 0, seats: 2 }).map((l) => l.label), ["收錄參選人", "中選會登記", "應選席次"]);
});

// ── 預先產生的座標檔 ─────────────────────────────────────────────

const adminGrid = JSON.parse(await Deno.readTextFile(new URL("../data/tw-grid-admin.json", import.meta.url))) as {
  counties: GridRow[];
  towns: Record<string, GridRow[]>;
};

function assertNoOverlap(rows: GridRow[], what: string) {
  const seen = new Set(rows.map((r) => `${r[2]},${r[3]}`));
  assertEquals(seen.size, rows.length, `${what}有兩格重疊`);
  assert(rows.every((r) => Number.isInteger(r[2]) && Number.isInteger(r[3]) && r[2] >= 0 && r[3] >= 0), `${what}座標要是非負整數`);
}

Deno.test("座標檔：縣市 22 格、鄉鎮市區 368 格，代碼層級對得上、每張圖格子不重疊", () => {
  assertEquals(adminGrid.counties.length, 22);
  assertNoOverlap(adminGrid.counties, "縣市");
  let towns = 0;
  for (const [county, rows] of Object.entries(adminGrid.towns)) {
    assert(adminGrid.counties.some((c) => c[0] === county), `${county} 不在縣市清單`);
    assert(rows.every((r) => r[0].length === 8 && r[0].startsWith(county)), `${county} 底下有別縣的鄉鎮`);
    assertNoOverlap(rows, `${county} 的鄉鎮市區`);
    towns += rows.length;
  }
  assertEquals(towns, 368);
  assertEquals(Object.keys(adminGrid.towns).length, 22);
});

Deno.test("座標檔：每個縣市的村里檔存在，村里 11 碼掛在自己的鄉鎮底下、格子不重疊、總數 7,701", async () => {
  let villages = 0;
  for (const [county, towns] of Object.entries(adminGrid.towns)) {
    const file = JSON.parse(await Deno.readTextFile(new URL(`../data/tw-grid-villages/${county}.json`, import.meta.url))) as Record<string, GridRow[]>;
    const townCodes = towns.map((t) => t[0]).sort();
    assertEquals(Object.keys(file).sort(), townCodes, `${county} 的村里檔鄉鎮清單跟鄉鎮座標不同`);
    for (const [town, rows] of Object.entries(file)) {
      assert(rows.every((r) => r[0].length === 11 && r[0].startsWith(town)), `${town} 底下有別鄉的村里`);
      assertNoOverlap(rows, `${town} 的村里`);
      villages += rows.length;
    }
  }
  assertEquals(villages, 7701);
});

Deno.test("座標檔 → buildMap：縣市格用手排座標，22 縣市都畫得出來", () => {
  const counts = adminGrid.counties.map((c) => row(c[0], { name: c[1], candidates: 1 }));
  const m = buildMap(adminGrid.counties, counts);
  assertEquals(m.units.length, 22);
  assertEquals(new Set(m.units.map((u) => `${u.x},${u.y}`)).size, 22);
});
