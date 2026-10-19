/**
 * 格子排版演算法（lib/tile-layout.ts）的守門：每個單位一格不重疊、方位大致照地理、結果可重現、補格不動既有格子。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { appendTiles, layoutTiles, type GeoPoint } from "./tile-layout.ts";

const key = (c: { x: number; y: number }) => `${c.x},${c.y}`;

Deno.test("空輸入與單一單位", () => {
  assertEquals(layoutTiles([]), { cells: [], cols: 0, rows: 0 });
  assertEquals(layoutTiles([{ key: "a", lon: 121, lat: 24 }]), { cells: [{ key: "a", x: 0, y: 0 }], cols: 1, rows: 1 });
});

Deno.test("每個單位一格、座標不重疊，從 0,0 起算", () => {
  const pts: GeoPoint[] = [
    { key: "n", lon: 121.5, lat: 25.1 },
    { key: "s", lon: 121.5, lat: 22.5 },
    { key: "e", lon: 122.0, lat: 24.0 },
    { key: "w", lon: 120.0, lat: 24.0 },
  ];
  const { cells, cols, rows } = layoutTiles(pts);
  assertEquals(cells.length, 4);
  assertEquals(new Set(cells.map(key)).size, 4);
  assertEquals(Math.min(...cells.map((c) => c.x)), 0);
  assertEquals(Math.min(...cells.map((c) => c.y)), 0);
  assert(cells.every((c) => c.x < cols && c.y < rows));
  const at = (k: string) => cells.find((c) => c.key === k)!;
  assert(at("n").y < at("s").y, "北在上");
  assert(at("w").x < at("e").x, "西在左");
});

Deno.test("擠在同一點的單位會被推到相鄰空格，仍然一格一個", () => {
  const pts: GeoPoint[] = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, lon: 121, lat: 24 }));
  pts.push({ key: "far", lon: 123, lat: 26 }); // 撐出外框
  const { cells } = layoutTiles(pts);
  assertEquals(new Set(cells.map(key)).size, 10);
  const cluster = cells.filter((c) => c.key !== "far");
  const xs = cluster.map((c) => c.x);
  const ys = cluster.map((c) => c.y);
  // 9 格擠成一團：離中心不會太遠（3×3 附近，容許推出一圈）
  assert(Math.max(...xs) - Math.min(...xs) <= 4, "水平方向沒有被推散到很遠");
  assert(Math.max(...ys) - Math.min(...ys) <= 4, "垂直方向沒有被推散到很遠");
});

Deno.test("結果可重現：輸入順序不同，座標相同", () => {
  const pts: GeoPoint[] = Array.from({ length: 40 }, (_, i) => ({
    key: `u${String(i).padStart(2, "0")}`,
    lon: 120 + ((i * 7) % 11) * 0.05,
    lat: 23 + ((i * 3) % 13) * 0.04,
  }));
  const a = layoutTiles(pts).cells;
  const b = layoutTiles([...pts].reverse()).cells;
  assertEquals(a, b);
});

Deno.test("共線輸入（同緯度一排）不會除以零", () => {
  const pts: GeoPoint[] = [0, 1, 2, 3, 4].map((i) => ({ key: `r${i}`, lon: 120 + i * 0.1, lat: 24 }));
  const { cells, rows } = layoutTiles(pts);
  assertEquals(new Set(cells.map(key)).size, 5);
  assert(rows >= 1);
  assert(cells.find((c) => c.key === "r0")!.x < cells.find((c) => c.key === "r4")!.x);
});

Deno.test("大量單位（七百個、中心高度集中）一格一個", () => {
  const pts: GeoPoint[] = Array.from({ length: 700 }, (_, i) => ({
    key: `v${String(i).padStart(4, "0")}`,
    lon: 121.5 + ((i * 37) % 50) * 0.001,
    lat: 25 + ((i * 17) % 50) * 0.001,
  }));
  const { cells } = layoutTiles(pts);
  assertEquals(cells.length, 700);
  assertEquals(new Set(cells.map(key)).size, 700);
});

Deno.test("appendTiles：先補外框內的空格，滿了才開新的一列，不動既有格子", () => {
  const base = [
    { key: "a", x: 0, y: 0 },
    { key: "b", x: 2, y: 0 },
    { key: "c", x: 0, y: 1 },
  ];
  const r = appendTiles(base, ["z", "y"]);
  assertEquals(r.cells.slice(0, 3), base);
  // 外框 3×2，空格由上而下、由左而右是 (1,0)、(1,1)、(2,1)；key 排序後 y 先、z 後
  assertEquals(r.cells.find((c) => c.key === "y"), { key: "y", x: 1, y: 0 });
  assertEquals(r.cells.find((c) => c.key === "z"), { key: "z", x: 1, y: 1 });
  assertEquals(new Set(r.cells.map(key)).size, 5);

  const full = appendTiles([{ key: "a", x: 0, y: 0 }], ["b"]);
  assertEquals(full.cells.find((c) => c.key === "b"), { key: "b", x: 0, y: 1 });
  assertEquals(full.rows, 2);
});
