/**
 * 「參選地圖」（/stats/map）的格子座標產生器。開發時執行，不在 build 流程裡，也不在執行時打任何外部 API。
 *
 *   # 1) 下載行政區邊界（TopoJSON，來源見下，約 5 MB，放 scripts/.cache/，已列入忽略）
 *   mkdir -p scripts/.cache
 *   for f in counties-10t towns-10t villages-10t; do
 *     curl -L -o scripts/.cache/$f.json https://cdn.jsdelivr.net/npm/taiwan-atlas@3.0.0/$f.json
 *   done
 *   # 2) 產生座標
 *   deno run --allow-read --allow-write scripts/build-tw-tile-grid.ts
 *
 * 資料來源
 *   taiwan-atlas（https://github.com/dkaoster/taiwan-atlas，MIT）：內政部國土測繪中心「村里界」「鄉鎮市區界」
 *   「縣市界」圖資轉成的 TopoJSON，屬性帶官方行政區代碼（COUNTYCODE 5 碼、TOWNCODE 8 碼、VILLCODE 11 碼），
 *   跟 admin_divisions.code 同一套。這裡只取每個行政區「面積最大的那一塊」的重心當中心點（離島、飛地不會把
 *   中心拉歪），再交給 lib/tile-layout.ts 的 layoutTiles 排成格子。
 *
 * 輸出（lib/ 以外的純資料，執行時只讀）
 *   data/tw-grid-admin.json            { counties: [[代碼,名稱,x,y]…], towns: { 縣市代碼: [[代碼,名稱,x,y]…] } }
 *   data/tw-grid-villages/<縣市代碼>.json   { 鄉鎮代碼: [[代碼,名稱,x,y]…] }，選了鄉鎮才依縣市載入
 *
 * 三層各自獨立排：縣市 22 格排一張；每個縣市的鄉鎮市區排一張；每個鄉鎮市區的村里排一張。
 * 座標是各張圖內的相對位置（從 0,0 起算）。
 */
import { layoutTiles, type GeoPoint } from "../lib/tile-layout.ts";

const ROOT = new URL("../", import.meta.url);
const CACHE = new URL("scripts/.cache/", ROOT);

type Pos = [number, number];
interface Topology {
  transform?: { scale: Pos; translate: Pos };
  arcs: Array<Array<Pos>>;
  objects: Record<string, { geometries: Array<Geom> }>;
}
interface Geom {
  type: string;
  arcs: unknown;
  properties: Record<string, string>;
}

/** 解碼 TopoJSON 的弧：差分編碼＋量化 → 經緯度 */
function decodeArcs(topo: Topology): Array<Array<Pos>> {
  const { scale, translate } = topo.transform ?? { scale: [1, 1] as Pos, translate: [0, 0] as Pos };
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]] as Pos;
    });
  });
}

function ringPoints(arcs: Array<Array<Pos>>, ring: number[]): Pos[] {
  const out: Pos[] = [];
  for (const idx of ring) {
    const pts = idx >= 0 ? arcs[idx] : [...arcs[~idx]].reverse();
    // 相鄰的弧共用端點，去掉重複
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  return out;
}

/** 多邊形外環的面積與重心（平面近似，夠用在選中心點） */
function ringCentroid(pts: Pos[]): { area: number; lon: number; lat: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[i];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = pts.length || 1;
    return { area: 0, lon: pts.reduce((s, p) => s + p[0], 0) / n, lat: pts.reduce((s, p) => s + p[1], 0) / n };
  }
  return { area: Math.abs(a / 2), lon: cx / (3 * a), lat: cy / (3 * a) };
}

/** 一個行政區（Polygon 或 MultiPolygon）面積最大那一塊的重心 */
function mainCentroid(arcs: Array<Array<Pos>>, g: Geom): { lon: number; lat: number } {
  const polys: number[][][] = g.type === "Polygon" ? [g.arcs as number[][]] : (g.arcs as number[][][]);
  let best = { area: -1, lon: 0, lat: 0 };
  for (const rings of polys) {
    const c = ringCentroid(ringPoints(arcs, rings[0]));
    if (c.area > best.area) best = c;
  }
  return { lon: best.lon, lat: best.lat };
}

async function load(name: string, object: string) {
  const topo = JSON.parse(await Deno.readTextFile(new URL(`${name}.json`, CACHE))) as Topology;
  const arcs = decodeArcs(topo);
  return topo.objects[object].geometries.map((g) => ({ props: g.properties, ...mainCentroid(arcs, g) }));
}

/** 臺→台：站上縣市一律寫「台」（lib/election-regions.ts） */
const tai = (s: string) => s.replace(/臺/g, "台");

type Row = [string, string, number, number];

function layoutRows(items: Array<{ code: string; name: string; lon: number; lat: number }>): Row[] {
  const points: GeoPoint[] = items.map((i) => ({ key: i.code, lon: i.lon, lat: i.lat }));
  const { cells } = layoutTiles(points);
  const byCode = new Map(items.map((i) => [i.code, i]));
  return cells.map((c) => [c.key, byCode.get(c.key)!.name, c.x, c.y] as Row);
}

const counties = await load("counties-10t", "counties");
const towns = await load("towns-10t", "towns");
const villages = await load("villages-10t", "villages");

/**
 * 縣市 22 格手排（北在上，大致照相對位置；排版是示意，不是比例）。
 * 其餘兩層沒有現成座標，走 layoutTiles。
 */
const COUNTY_MANUAL: Record<string, Pos> = {
  連江縣: [4, 0],
  桃園市: [2, 1], 新北市: [3, 1], 基隆市: [4, 1],
  新竹市: [1, 2], 新竹縣: [2, 2], 台北市: [3, 2], 宜蘭縣: [4, 2],
  金門縣: [0, 3], 苗栗縣: [1, 3], 台中市: [2, 3], 南投縣: [3, 3], 花蓮縣: [4, 3],
  澎湖縣: [0, 4], 彰化縣: [1, 4], 雲林縣: [2, 4], 嘉義縣: [3, 4],
  嘉義市: [2, 5], 台南市: [3, 5], 台東縣: [4, 5],
  高雄市: [3, 6], 屏東縣: [4, 6],
};
const countyRows: Row[] = counties.map((c) => {
  const name = tai(c.props.COUNTYNAME);
  const at = COUNTY_MANUAL[name];
  if (!at) throw new Error(`縣市手排表缺 ${name}`);
  return [c.props.COUNTYCODE, name, at[0], at[1]] as Row;
});
if (new Set(countyRows.map((r) => `${r[2]},${r[3]}`)).size !== countyRows.length) throw new Error("縣市手排有兩格重疊");

const townsByCounty: Record<string, Row[]> = {};
const byCounty = Map.groupBy(towns, (t) => t.props.COUNTYCODE);
for (const [code, list] of [...byCounty].sort((a, b) => a[0].localeCompare(b[0]))) {
  townsByCounty[code] = layoutRows(list.map((t) => ({ code: t.props.TOWNCODE, name: t.props.TOWNNAME, lon: t.lon, lat: t.lat })));
}

await Deno.mkdir(new URL("data/tw-grid-villages/", ROOT), { recursive: true });
await Deno.writeTextFile(new URL("data/tw-grid-admin.json", ROOT), JSON.stringify({ counties: countyRows, towns: townsByCounty }) + "\n");

let villageTotal = 0;
const villagesByCounty = Map.groupBy(villages, (v) => v.props.COUNTYCODE);
for (const [county, list] of [...villagesByCounty].sort((a, b) => a[0].localeCompare(b[0]))) {
  const out: Record<string, Row[]> = {};
  const byTown = Map.groupBy(list, (v) => v.props.TOWNCODE);
  for (const [town, vs] of [...byTown].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[town] = layoutRows(vs.map((v) => ({ code: v.props.VILLCODE, name: v.props.VILLNAME, lon: v.lon, lat: v.lat })));
    villageTotal += vs.length;
  }
  await Deno.writeTextFile(new URL(`data/tw-grid-villages/${county}.json`, ROOT), JSON.stringify(out) + "\n");
}
console.log(`縣市 ${countyRows.length}、鄉鎮市區 ${towns.length}、村里 ${villageTotal}`);
