/**
 * 名稱是靜態資料（lib/map-layer.ts、點陣檔的 names）：幾何一載入就有名稱與邊界，人數資料回來只重新上色。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { applyRows, buildLayer } from "./map-layer.ts";
import { buildMap, normalizeRows, tooltipLines, unitColor } from "./candidacy-map.ts";
import { labelCache } from "./map-data-cache.ts";
import { placeLabels, type RasterFile } from "./raster-grid.ts";

const national = JSON.parse(await Deno.readTextFile(new URL("../data/tw-raster/national.json", import.meta.url))) as RasterFile;
const adminNames = new Map(
  (await Deno.readTextFile(new URL("../scripts/fixtures/admin-names.tsv", import.meta.url))).split(/\r?\n/).filter(Boolean).map((l) => l.split("\t") as [string, string]),
);

Deno.test("點陣檔自帶名稱：沒有人數資料也有每個行政區的名稱，嘉義縣、嘉義市是對的", () => {
  const layer = buildLayer("county", "county", national, []);
  assertEquals(layer.ready, false);
  assertEquals(layer.built.units.length, 22);
  const nameOf = (code: string) => layer.built.units.find((u) => u.code === code)?.name;
  assertEquals(nameOf("10010"), "嘉義縣");
  assertEquals(nameOf("10020"), "嘉義市");
  assertEquals(nameOf("63000"), "台北市", "縣市「臺」寫「台」");
  assert(layer.built.units.every((u) => u.name && u.name !== u.code && u.candidates === 0 && u.registered === null));
  assert(layer.fills.some((d) => d.startsWith("M")) && layer.boundary.length > 0, "名稱之外，path 與邊界也已經合成好");
});

Deno.test("人數資料回來只重新上色：名稱、path、邊界原封不動，數字與顏色改變", () => {
  const layer = buildLayer("county", "county", national, []);
  const fills = layer.fills;
  const boundary = layer.boundary;
  const namesBefore = layer.built.units.map((u) => u.name);
  const colorBefore = unitColor(layer.built.units[0], "coverage", 0);
  applyRows(layer, normalizeRows([{ code: layer.built.units[0].code, name: "資料庫的名字", parent_code: null, candidates: 30, registered: 40, seats: 5 }]));
  assertEquals(layer.ready, true);
  assert(layer.fills === fills && layer.boundary === boundary, "path 與邊界沒有重算");
  assertEquals(layer.built.units.map((u) => u.name), namesBefore, "名稱以靜態資料為準，不被資料庫的寫法覆蓋");
  const u = layer.built.units[0];
  assertEquals([u.candidates, u.registered, u.seats], [30, 40, 5]);
  assert(unitColor(u, "coverage", 30) !== colorBefore, "有登記資料後才有顏色（之前是中性灰）");
  assertEquals(tooltipLines(u).map((l) => l.label), ["收錄參選人", "中選會登記", "收錄率", "應選席次"]);
});

Deno.test("buildMap：靜態名稱優先，沒有才用資料庫的、再沒有用代碼", () => {
  const m = buildMap({ codes: ["A", "B", "C"], names: ["甲", "", "丙"] }, [
    { code: "A", name: "資料庫甲", parent_code: null, candidates: 1, registered: null, seats: null },
    { code: "B", name: "資料庫乙", parent_code: null, candidates: 2, registered: null, seats: null },
  ]);
  assertEquals(m.units.map((u) => u.name), ["甲", "資料庫乙", "丙"]);
  assertEquals(buildMap({ codes: ["X"] }, []).units[0].name, "X");
});

Deno.test("點陣檔的名稱跟 admin_divisions 一致（國家、鄉鎮、村里各抽檢）", async () => {
  assertEquals(national.names?.length, national.codes.length);
  national.codes.forEach((c, i) => assertEquals(national.names![i], adminNames.get(c)));
  for (const p of ["towns/10009.json", "villages/10009190.json", "villages/63000010.json"]) {
    const f = JSON.parse(await Deno.readTextFile(new URL(`../data/tw-raster/${p}`, import.meta.url))) as RasterFile;
    assertEquals(f.names?.length, f.codes.length, p);
    f.codes.forEach((c, i) => assertEquals(f.names![i], adminNames.get(c), `${p} ${c}`));
  }
});

Deno.test("標籤避讓結果以（圖層、縮放級距）快取：同一級第二次直接拿，不重算", () => {
  const layer = buildLayer("county", "county", national, []);
  const names = layer.built.units.map((u) => u.name);
  const key = `${layer.key}|7`;
  assertEquals(labelCache.has(key), false);
  labelCache.set(key, placeLabels(layer.raster, names, 8).map((p) => ({ code: layer.built.units[p.idx].code, text: p.text, x: p.x, y: p.y, fs: p.fs })));
  const first = labelCache.get(key)!;
  assert(first.length >= 15);
  assert(labelCache.get(key) === first, "同一級回來拿到同一份結果");
  labelCache.delete(key);
});
