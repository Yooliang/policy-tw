/**
 * 邊界點陣化（lib/raster-grid.ts）的守門：用合成的多邊形驗證尺度、洞、多數決、至少 1 格、游程編碼與 SVG path。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  SEA, boundaryPath, decodeRaster, decodeRle, encodeRle, ensureCells, outlinePath, projectKm, rasterize, rectToGrid,
  unitFillPaths, unitStats, type RasterInput, type RasterPolygon,
} from "./raster-grid.ts";

const square = (x0: number, y0: number, x1: number, y1: number): RasterPolygon => ({ rings: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] });
const rect = { x0: 0, yTop: 10, w: 10, h: 10 };

Deno.test("projectKm：中央經線上 1 度緯度約 111 公里；赤道外沿緯線的距離乘 cos(緯度)", () => {
  const [, y1] = projectKm(121, 24);
  const [, y2] = projectKm(121, 25);
  assert(Math.abs(y2 - y1 - 111.195) < 0.01);
  const [xa] = projectKm(121, 24);
  const [xb] = projectKm(122, 24);
  assert(Math.abs(xb - xa - 111.195 * Math.cos((24 * Math.PI) / 180)) < 0.01);
});

Deno.test("rectToGrid：格數依公里尺度進位", () => {
  assertEquals(rectToGrid({ xMin: 0, xMax: 10.2, yMin: 0, yMax: 4 }, 1), { x0: 0, yTop: 4, w: 11, h: 4 });
  assertEquals(rectToGrid({ xMin: 0, xMax: 10, yMin: 0, yMax: 4 }, 0.2), { x0: 0, yTop: 4, w: 50, h: 20 });
});

Deno.test("rasterize：兩個相鄰的方塊各拿自己那半邊，不重疊、沒漏格", () => {
  const inputs: RasterInput[] = [
    { code: "A", polys: [square(0, 0, 5, 10)] },
    { code: "B", polys: [square(5, 0, 10, 10)] },
  ];
  const cells = rasterize(inputs, rect, 1);
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) assertEquals(cells[y * 10 + x], x < 5 ? 0 : 1, `(${x},${y})`);
  }
});

Deno.test("rasterize：洞（內環）是海，圖外也是海", () => {
  const donut: RasterPolygon = {
    rings: [
      [[1, 1], [9, 1], [9, 9], [1, 9]],
      [[4, 4], [6, 4], [6, 6], [4, 6]],
    ],
  };
  const cells = rasterize([{ code: "D", polys: [donut] }], rect, 1);
  assertEquals(cells[5 * 10 + 5], SEA, "洞");
  assertEquals(cells[0], SEA, "圖外");
  assertEquals(cells[2 * 10 + 2], 0);
  const land = [...cells].filter((v) => v === 0).length;
  assertEquals(land, 8 * 8 - 2 * 2);
});

Deno.test("rasterize：格子的邊界上以取樣點多數決，同票取序號小的（結果可重現）", () => {
  // 兩塊分界在 x=5.4：第 5 欄 3 個取樣欄（4.17, 5.0, 5.83 → 以 sub=3 取樣於 5.17、5.5、5.83）裡 5.17 屬 A、其餘屬 B
  const inputs: RasterInput[] = [
    { code: "A", polys: [square(0, 0, 5.4, 10)] },
    { code: "B", polys: [square(5.4, 0, 10, 10)] },
  ];
  const cells = rasterize(inputs, rect, 1);
  assertEquals(cells[5], 1);
  assertEquals(cells[4], 0);
  assertEquals(rasterize(inputs, rect, 1), cells);
});

Deno.test("ensureCells：小到點不到的行政區至少拿 1 格（放在鄰區的多餘格或最近的海格），不讓鄰區歸零", () => {
  const inputs: RasterInput[] = [
    { code: "BIG", polys: [square(0, 0, 10, 10)] },
    { code: "TINY", polys: [square(3.1, 3.1, 3.2, 3.2)] }, // 0.1 公里見方，點不到任何取樣點
    { code: "ISLET", polys: [square(30, 30, 30.1, 30.1)] }, // 在取景框外
  ];
  const cells = rasterize(inputs, rect, 1);
  assertEquals([...cells].filter((v) => v === 1).length, 0);
  ensureCells(cells, 10, 10, [
    { idx: 1, cx: 3.15, cy: 6.85 }, // y 軸朝下：yTop(10) − 3.15
    { idx: 2, cx: 30, cy: -20 },
  ], 3);
  const count = (i: number) => [...cells].filter((v) => v === i).length;
  assertEquals(count(1), 1);
  assertEquals(count(2), 1);
  assertEquals(cells[6 * 10 + 3], 1, "TINY 落在它重心所在的格子");
  assertEquals(count(0), 100 - 2, "被拿走的格子從 BIG 扣掉，沒有格子被兩個行政區同時佔著");
  // 第二次再跑（已經都有格子）不再動
  const before = Int16Array.from(cells);
  ensureCells(cells, 10, 10, [{ idx: 1, cx: 0, cy: 0 }], 3);
  assertEquals(cells, before);
});

Deno.test("ensureCells：不拿只剩 1 格的鄰區的格子", () => {
  const cells = new Int16Array(4).fill(SEA);
  cells[0] = 0; // 行政區 0 只有 1 格
  ensureCells(cells, 2, 2, [{ idx: 1, cx: 0.5, cy: 0.5 }], 2);
  assertEquals(cells[0], 0);
  assertEquals([...cells].filter((v) => v === 1).length, 1);
});

Deno.test("游程編碼：編碼再解碼等於原本；空輸入不炸", () => {
  const cells = Int16Array.from([-1, -1, 0, 0, 0, 2, -1, 1, 1]);
  const rle = encodeRle(cells);
  assertEquals(rle, [-1, 2, 0, 3, 2, 1, -1, 1, 1, 2]);
  assertEquals(decodeRle(rle, cells.length), cells);
  assertEquals(encodeRle([]), []);
});

Deno.test("decodeRaster：內嵌框蓋在主圖上，海不覆蓋；insets 記下框的位置", () => {
  const file = {
    cellM: 1000, w: 4, h: 2, codes: ["M", "I"],
    layers: [
      { ox: 0, oy: 0, w: 4, h: 2, rle: encodeRle([0, 0, 0, 0, 0, 0, 0, 0]) },
      { ox: 1, oy: 0, w: 2, h: 1, rle: encodeRle([1, SEA]), inset: true },
    ],
  };
  const r = decodeRaster(file);
  assertEquals([...r.cells], [0, 1, 0, 0, 0, 0, 0, 0]);
  assertEquals(r.insets, [{ ox: 1, oy: 0, w: 2, h: 1 }]);
});

Deno.test("unitFillPaths：同一個行政區的格子合併成一條 path，列內相連的格子合成一個長方形", () => {
  const raster = { w: 4, h: 2, codes: ["A", "B"], cells: Int16Array.from([0, 0, 1, SEA, 0, 1, 1, SEA]) };
  const [a, b] = unitFillPaths(raster);
  assertEquals(a, "M0 0h2v1h-2zM0 1h1v1h-1z");
  assertEquals(b, "M2 0h1v1h-1zM1 1h2v1h-2z");
});

Deno.test("unitStats：格數、重心、外框；沒有格子的是 null", () => {
  const raster = { w: 3, h: 2, codes: ["A", "B", "Z"], cells: Int16Array.from([0, 0, 1, 0, SEA, 1]) };
  const s = unitStats(raster);
  assertEquals(s[0]!.count, 3);
  assertEquals([s[0]!.minX, s[0]!.maxX, s[0]!.minY, s[0]!.maxY], [0, 2, 0, 2]);
  assertEquals(s[1]!.count, 2);
  assertEquals(s[2], null);
});

Deno.test("boundaryPath／outlinePath：只畫行政區之間的邊；單區外框含面向海的邊", () => {
  const raster = { w: 2, h: 1, cells: Int16Array.from([0, 1]) };
  assertEquals(boundaryPath(raster), "M1 0v1", "兩區之間一條垂直線，海邊不畫");
  const out = outlinePath(raster, 0);
  // 左邊、上邊、下邊、與右鄰區之間的邊
  assert(out.includes("M0 0v1") && out.includes("M1 0v1") && out.includes("M0 0h1") && out.includes("M0 1h1"));
  assertEquals(outlinePath({ w: 1, h: 1, cells: Int16Array.from([SEA]) }, 0), "");
});
