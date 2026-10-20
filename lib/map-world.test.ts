/**
 * 參選地圖連續縮放（lib/map-world.ts）：細節層門檻與遲滯、以游標為中心縮放、視窗範圍挑鄉鎮、釋放，
 * 以及鄉鎮／村里點陣檔跟全國層對齊到同一個世界座標（含離島內嵌框）。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  K_MAX, TOWN_AT, VILLAGE_AT, boxesIntersect, cellAt, clampView, isZoomWheel, zoomModifierLabel, fitBox, fitK, layerBox, lodFor, pickEvictions, pickVisibleTowns,
  screenToWorld, viewBox, wheelK, zoomAtPoint,
} from "./map-world.ts";
import { decodeRaster, type RasterFile } from "./raster-grid.ts";

Deno.test("lodFor：縮小看縣市、中間鄉鎮、放大村里；縮回時有遲滯不閃", () => {
  assertEquals(lodFor(1, "county"), "county");
  assertEquals(lodFor(TOWN_AT, "county"), "town");
  assertEquals(lodFor(TOWN_AT - 0.1, "county"), "county");
  assertEquals(lodFor(TOWN_AT - 0.1, "town"), "town", "剛過門檻往回縮一點點還維持鄉鎮");
  assertEquals(lodFor(TOWN_AT * 0.85, "town"), "county");
  assertEquals(lodFor(VILLAGE_AT, "town"), "village");
  assertEquals(lodFor(VILLAGE_AT - 0.5, "village"), "village");
  assertEquals(lodFor(VILLAGE_AT * 0.85, "village"), "town");
  assertEquals(lodFor(K_MAX, "county"), "village", "一口氣放大到底，直接跳過鄉鎮到村里");
  assertEquals(lodFor(0.5, "village"), "county");
});

Deno.test("viewBox／screenToWorld：視窗中心就是 (cx, cy)，像素與世界互相對得上", () => {
  const v = { cx: 100, cy: 200, k: 4 };
  assertEquals(viewBox(v, 800, 400), { x0: 0, y0: 150, x1: 200, y1: 250 });
  assertEquals(screenToWorld(v, 800, 400, 400, 200), [100, 200]);
  assertEquals(screenToWorld(v, 800, 400, 0, 0), [0, 150]);
});

Deno.test("zoomAtPoint：游標下那個世界點在縮放前後留在同一個螢幕位置", () => {
  const v = { cx: 120, cy: 180, k: 3 };
  const W = 900, H = 600;
  for (const [px, py, k2] of [[100, 80, 6], [450, 300, 1.5], [880, 590, 12]] as const) {
    const before = screenToWorld(v, W, H, px, py);
    const nv = zoomAtPoint(v, W, H, px, py, k2);
    const after = screenToWorld(nv, W, H, px, py);
    assert(Math.abs(before[0] - after[0]) < 1e-9 && Math.abs(before[1] - after[1]) < 1e-9, `${px},${py}`);
    assertEquals(nv.k, k2);
  }
});

Deno.test("wheelK：往上滾放大、往下滾縮小，夾在上下限內，捏合更靈敏，單次變化有上限", () => {
  assert(wheelK(5, -100, false, 1) > 5);
  assert(wheelK(5, 100, false, 1) < 5);
  assertEquals(wheelK(1, 100, false, 1), 1, "縮到底就停在最小倍率");
  assertEquals(wheelK(K_MAX, -100, false, 1), K_MAX);
  assert(wheelK(5, -5, true, 1) > wheelK(5, -5, false, 1));
  assertEquals(wheelK(5, -100000, false, 1), wheelK(5, -200, false, 1));
});

Deno.test("fitBox／fitK／clampView", () => {
  const v = fitBox({ x0: 10, y0: 20, x1: 30, y1: 40 }, 800, 400, 1.25, 1);
  assertEquals([v.cx, v.cy], [20, 30]);
  assertEquals(v.k, Math.min(800 / 25, 400 / 25));
  assertEquals(fitBox({ x0: 0, y0: 0, x1: 0.01, y1: 0.01 }, 800, 400, 1.25, 1).k, K_MAX, "很小的範圍也不會超過最大倍率");
  assertEquals(fitK({ w: 289, h: 395 }, 1000, 500), 500 / 395);
  assertEquals(clampView({ cx: -50, cy: 999, k: 3 }, { w: 289, h: 395 }), { cx: 0, cy: 395, k: 3 });
});

Deno.test("pickVisibleTowns：只挑跟視窗相交的鄉鎮，近中心的先，有上限；pickEvictions：不釋放正在看的、最久沒用的先", () => {
  const towns = [
    { code: "A", box: { x0: 0, y0: 0, x1: 10, y1: 10 } },
    { code: "B", box: { x0: 40, y0: 0, x1: 50, y1: 10 } },
    { code: "C", box: { x0: 100, y0: 100, x1: 110, y1: 110 } },
    { code: "D", box: { x0: 12, y0: 0, x1: 20, y1: 10 } },
  ];
  const view = { x0: -5, y0: -5, x1: 25, y1: 15 };
  assertEquals(pickVisibleTowns(towns, view, 10), ["A", "D"]);
  assertEquals(pickVisibleTowns(towns, view, 1), ["A"]);
  assert(boxesIntersect(towns[0].box, view) && !boxesIntersect(towns[2].box, view));

  const loaded = new Map([["A", 5], ["B", 1], ["C", 3], ["D", 9]]);
  assertEquals(pickEvictions(loaded, new Set(["A"]), 2), ["B", "C"]);
  assertEquals(pickEvictions(loaded, new Set(), 4), []);
  assertEquals(pickEvictions(loaded, new Set(["B", "C", "D", "A"]), 1), [], "全都在看就不釋放");
});

// ── 世界座標對齊（真實資料）────────────────────────────────────────

const read = async (p: string) => decodeRaster(JSON.parse(await Deno.readTextFile(new URL(`../data/tw-raster/${p}`, import.meta.url))) as RasterFile);
const adminCodes = (await Deno.readTextFile(new URL("../scripts/fixtures/admin-codes.txt", import.meta.url))).split(/\r?\n/).filter(Boolean);

type R = Awaited<ReturnType<typeof read>>;
/** 細檔（child）的陸地格心有多少比例落在粗檔（parent）的指定行政區上；shiftKm 把細檔整張平移（驗證「對齊」不是巧合） */
function overlap(child: R, parent: R, parentIdx: number, shiftKm = 0): number {
  const cu = child.cellM / 1000;
  let land = 0, hit = 0;
  for (let y = 0; y < child.h; y += 1) {
    for (let x = 0; x < child.w; x += 1) {
      if (child.cells[y * child.w + x] < 0) continue;
      land += 1;
      if (cellAt(parent, (child.ox + x + 0.5) * cu + shiftKm, (child.oy + y + 0.5) * cu) === parentIdx) hit += 1;
    }
  }
  return hit / land;
}

/** 對齊（位移 0）的重疊要明顯好、而且不輸給任何平移 ±1～4 公里的結果 */
function assertAligned(child: R, parent: R, parentIdx: number, what: string, min: number) {
  const at0 = overlap(child, parent, parentIdx);
  assert(at0 > min, `${what}：只有 ${(100 * at0).toFixed(0)}% 的格子落在粗一層的同一行政區`);
  for (const s of [-4, -3, -2, -1, 1, 2, 3, 4]) assert(at0 >= overlap(child, parent, parentIdx, s), `${what}：平移 ${s} 公里後重疊更好，座標沒對齊`);
}

Deno.test("世界座標：鄉鎮檔的陸地跟縣市檔的同一縣市重疊並對齊（含澎湖、金門、連江內嵌框）", async () => {
  const national = await read("national.json");
  for (const county of ["63000", "10009", "10014", "10016", "09020", "09007", "66000"]) {
    assertAligned(await read(`towns/${county}.json`), national, national.codes.indexOf(county), `縣市 ${county}`, 0.8);
  }
});

Deno.test("世界座標：村里檔的陸地跟鄉鎮檔的同一鄉鎮重疊並對齊，且格線對齊 200 公尺", async () => {
  const sample = ["63000010", "63000110", "10009190", "10014160", "10016010", "09020030", "09007020", "10002040", "66000020"];
  for (const town of sample) {
    assert(adminCodes.includes(town), town);
    const towns = await read(`towns/${town.slice(0, 5)}.json`);
    const villages = await read(`villages/${town}.json`);
    // 格線：村里檔左上角的世界座標（公里）是 200 公尺的整數倍，而且跟鄉鎮檔的 1 公里格線同一條
    const x = villages.ox * (villages.cellM / 1000);
    const y = villages.oy * (villages.cellM / 1000);
    assert(Math.abs(x / 0.2 - Math.round(x / 0.2)) < 1e-6 && Math.abs(y / 0.2 - Math.round(y / 0.2)) < 1e-6, `${town}：不在 200 公尺格線上`);
    assertAligned(villages, towns, towns.codes.indexOf(town), `鄉鎮 ${town}`, 0.7);
    const b = layerBox(villages);
    assert(b.x1 > b.x0 && b.y1 > b.y0);
  }
});
Deno.test("滾輪只有帶 Ctrl／⌘ 才縮放；Mac 顯示 ⌘、其他顯示 Ctrl", () => {
  assertEquals(isZoomWheel({ ctrlKey: false, metaKey: false }), false, "一般滾輪留給頁面捲動");
  assertEquals(isZoomWheel({ ctrlKey: true, metaKey: false }), true);
  assertEquals(isZoomWheel({ ctrlKey: false, metaKey: true }), true);
  assertEquals(zoomModifierLabel("MacIntel"), "⌘");
  assertEquals(zoomModifierLabel("iPhone"), "⌘");
  assertEquals(zoomModifierLabel("Win32"), "Ctrl");
  assertEquals(zoomModifierLabel("Linux x86_64"), "Ctrl");
});

Deno.test("滑鼠 Ctrl＋滾輪一格（deltaY 約 100）跟一般滾輪一樣的靈敏度；觸控板捏合（deltaY 很小）才放大靈敏度", () => {
  assertEquals(wheelK(5, -100, true, 1), wheelK(5, -100, false, 1));
  assert(wheelK(5, -100, true, 1) < 5 * 1.5, "一格不會放大到 1.5 倍以上");
  assert(wheelK(5, -2, true, 1) > wheelK(5, -2, false, 1));
});
