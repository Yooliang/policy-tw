/**
 * 「參選地圖」（/stats/map）的邊界點陣化產生器。開發時執行，不在 build 流程裡，執行時也不打任何外部 API。
 * 做法比照日本站 policy-jp 的 scripts/build-pixel-map.mjs：把真實邊界畫成方格，每格存它屬於哪個行政區，游程編碼輸出。
 *
 *   # 1) 下載行政區邊界（TopoJSON，約 5 MB，放 scripts/.cache/，已列入忽略）
 *   mkdir -p scripts/.cache
 *   for f in counties-10t towns-10t villages-10t; do
 *     curl -L -o scripts/.cache/$f.json https://cdn.jsdelivr.net/npm/taiwan-atlas@3.0.0/$f.json
 *   done
 *   # 2) 產生
 *   deno run --allow-read --allow-write scripts/build-tw-raster.ts
 *
 * 資料來源
 *   taiwan-atlas（https://github.com/dkaoster/taiwan-atlas，MIT）：內政部國土測繪中心「縣市界」「鄉鎮市區界」
 *   「村里界」圖資的 TopoJSON，屬性帶官方行政區代碼（COUNTYCODE 5 碼、TOWNCODE 8 碼、VILLCODE 11 碼）。
 *   行政區清單以 scripts/fixtures/admin-codes.txt（admin_divisions 的代碼，2026-10-19 匯出）為準：
 *   圖資有、清單沒有的舊代碼丟掉；清單有、圖資沒有的（新設或更名的村里）沒有邊界，放在該鄉鎮的中心附近 1 格。
 *
 * 尺度（固定實際大小，用公里為單位的正弦投影，中央經線 121°E，lib/raster-grid.ts）
 *   全國層、縣市層：1 公里一格；村里層（選了鄉鎮）：200 公尺一格。
 *    *   每個行政區至少 1 格（小到點不到的里放在重心最近的海格或鄰區的多餘格）。
 *
 * 同一個世界座標（連續縮放的大地圖用）：全國層的畫布就是世界，原點在畫布左上、單位公里；主島與三個離島內嵌框各有一個
 * 「框」（km 座標 → 世界座標的平移）。鄉鎮層（1 公里）與村里層（200 公尺）的格子對齊到同一條格線（格子左上角貼齊該框的
 * 公里原點），每個檔記下自己在世界裡的位置 ox、oy（單位是該檔自己的格）。澎湖、金門、連江的鄉鎮與村里檔畫在同一個內嵌框裡
 * （框外的島，例如烏坵，只給 1 格放在框邊）。
 *
 * 輸出（data/tw-raster/）
 *   national.json            全國：主島＋澎湖、金門、連江三個內嵌框（同尺度）
 *   towns/<縣市代碼>.json     一個縣市，由鄉鎮市區形狀拼成
 *   villages/<鄉鎮代碼>.json  一個鄉鎮市區，由村里形狀拼成（選了鄉鎮才載入）
 */
import {
  encodeRle, ensureCells, polygonStats, projectKm, rasterize, rectKm, rectToGrid,
  type CellTarget, type Pt, type RasterFile, type RasterInput, type RasterLayer, type RasterPolygon,
} from "../lib/raster-grid.ts";

const ROOT = new URL("../", import.meta.url);
const CACHE = new URL("scripts/.cache/", ROOT);
const OUT = new URL("data/tw-raster/", ROOT);

const COUNTY_CELL_KM = 1;
const VILLAGE_CELL_KM = 0.2;
/** 村里層一張圖長邊最多幾格（超過就報錯，格子不放大，才能維持跟全國同一條格線） */
const MAX_LONG = 600;
/** 縣市層一張圖長邊最多幾格（同樣的保險，目前沒有縣市會超過） */
const MAX_LONG_COUNTY = 400;
/** 取景時丟掉離本體太遠的飛地（東沙、南沙等）：距離該範圍最大一塊的重心超過這麼多公里 */
const CORE_RADIUS_KM = { town: 250, village: 60 };

interface Topology {
  transform?: { scale: Pt; translate: Pt };
  arcs: Array<Array<Pt>>;
  objects: Record<string, { geometries: Array<{ type: string; arcs: unknown; properties: Record<string, string> }> }>;
}
interface Geo {
  props: Record<string, string>
  polys: RasterPolygon[]
}

function decodeArcs(topo: Topology): Pt[][] {
  const { scale, translate } = topo.transform ?? { scale: [1, 1] as Pt, translate: [0, 0] as Pt };
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]] as Pt;
    });
  });
}

function ringOf(arcs: Pt[][], ring: number[]): Pt[] {
  const out: Pt[] = [];
  for (const idx of ring) {
    const pts = idx >= 0 ? arcs[idx] : [...arcs[~idx]].reverse();
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  return out;
}

async function load(name: string, object: string): Promise<Geo[]> {
  const topo = JSON.parse(await Deno.readTextFile(new URL(`${name}.json`, CACHE))) as Topology;
  const arcs = decodeArcs(topo);
  return topo.objects[object].geometries.map((g) => {
    const polys = (g.type === "Polygon" ? [g.arcs as number[][]] : (g.arcs as number[][][])).map((rings) => ({
      rings: rings.map((r) => ringOf(arcs, r).map(([lon, lat]) => projectKm(lon, lat))),
    }));
    return { props: g.properties, polys };
  });
}

const adminCodes = (await Deno.readTextFile(new URL("scripts/fixtures/admin-codes.txt", ROOT))).split(/\r?\n/).filter(Boolean);
const childrenOf = (parent: string, len: number) => adminCodes.filter((c) => c.length === len && c.startsWith(parent)).sort();

const counties = await load("counties-10t", "counties");
const towns = await load("towns-10t", "towns");
const villages = await load("villages-10t", "villages");

const byCode = (list: Geo[], key: string) => new Map(list.map((g) => [g.props[key], g]));
const countyGeo = byCode(counties, "COUNTYCODE");
const townGeo = byCode(towns, "TOWNCODE");
const villageGeo = byCode(villages, "VILLCODE");

function bigest(polys: RasterPolygon[]) {
  return polys.map((p) => ({ p, ...polygonStats(p) })).sort((a, b) => b.area - a.area)[0];
}

/** 一個範圍（縣市或鄉鎮）的點陣化：codes 是這張圖的行政區（序號即格值） */
/** 世界框：km 座標 (x, y) → 世界座標 (ox + x − x0, oy + yTop − y)；clip 是這個框裡畫得到的 km 範圍 */
interface Frame { /** 破碎的行政區只留靠近主體的塊（離島框不用：框的範圍已經限定） */ filterFragments: boolean; x0: number; yTop: number; ox: number; oy: number; clip: { xMin: number; xMax: number; yMin: number; yMax: number } }

function rasterScope(codes: string[], geo: Map<string, Geo>, cellKm: number, maxLong: number, radiusKm: number, frame: Frame): RasterFile {
  const inputs: RasterInput[] = codes.map((code) => ({ code, polys: geo.get(code)?.polys ?? [] }));
  const all = inputs.flatMap((u) => u.polys.map((p) => ({ p, ...polygonStats(p) })));
  if (!all.length) throw new Error(`${codes[0]} 這一組完全沒有邊界`);
  const anchor = all.sort((a, b) => b.area - a.area)[0];
  // 取景只看本體：離最大一塊太遠的飛地不算（它們的行政區之後走「至少 1 格」）
  const near = (s: { cx: number; cy: number }) => Math.hypot(s.cx - anchor.cx, s.cy - anchor.cy) <= radiusKm;
  // 主體範圍：只有一塊的行政區（完整、不破碎）決定；全都破碎（澎湖那種群島）就用各區最大的一塊
  const bboxOf = (p: RasterPolygon) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of p.rings[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0, x1, y0, y1 };
  };
  const solid = inputs.filter((u) => u.polys.length === 1 && near(polygonStats(u.polys[0]))).map((u) => u.polys[0]);
  const refPolys = solid.length ? solid : inputs.filter((u) => u.polys.length).map((u) => bigest(u.polys).p).filter((p) => near(polygonStats(p)));
  const ref = refPolys.map(bboxOf).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1) }));
  // 破碎的行政區（多塊：沙洲、島嶼、海埔地）只留離主體不遠的塊；塊與主體範圍的間距超過
  // max(1.5 公里, 主體長邊的 15%) 就不畫（例：口湖鄉台子村的外傘頂洲沙洲離本島 10 公里以上，畫進來會把整個鄉擠成一角）
  const margin = Math.max(1.5, 0.15 * Math.max(ref.x1 - ref.x0, ref.y1 - ref.y0));
  const gapOf = (p: RasterPolygon) => {
    const b = bboxOf(p);
    return Math.hypot(Math.max(0, ref.x0 - b.x1, b.x0 - ref.x1), Math.max(0, ref.y0 - b.y1, b.y0 - ref.y1));
  };
  const core = inputs.map((u) => {
    if (u.polys.length <= 1 || !frame.filterFragments) return { code: u.code, polys: u.polys.filter((p) => near(polygonStats(p))) };
    const kept = u.polys.filter((p) => near(polygonStats(p)) && gapOf(p) <= margin);
    if (kept.length) return { code: u.code, polys: kept };
    const nearest = u.polys.filter((p) => near(polygonStats(p))).sort((a, b) => gapOf(a) - gapOf(b))[0];
    return { code: u.code, polys: nearest ? [nearest] : [] };
  });
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const u of core) for (const p of u.polys) for (const [x, y] of p.rings[0]) {
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x); yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
  }
  // 只畫框裡的範圍，再把格線貼齊世界格線（格子左上角落在框原點的整數格上）
  xMin = Math.max(xMin, frame.clip.xMin); xMax = Math.min(xMax, frame.clip.xMax);
  yMin = Math.max(yMin, frame.clip.yMin); yMax = Math.min(yMax, frame.clip.yMax);
  if (!(xMax > xMin && yMax > yMin)) { xMax = xMin + cellKm; yMax = yMin + cellKm; }
  const cell = cellKm;
  const EPS = 1e-9;
  const gx0 = Math.floor((xMin - frame.x0) / cell + EPS);
  const gx1 = Math.ceil((xMax - frame.x0) / cell - EPS);
  const gy0 = Math.floor((frame.yTop - yMax) / cell + EPS);
  const gy1 = Math.ceil((frame.yTop - yMin) / cell - EPS);
  const rect = { x0: frame.x0 + gx0 * cell, yTop: frame.yTop - gy0 * cell, w: Math.max(1, gx1 - gx0), h: Math.max(1, gy1 - gy0) };
  if (Math.max(rect.w, rect.h) > maxLong) throw new Error(`${codes[0]} 這一組太大（${rect.w}×${rect.h} 格）`);
  const worldOx = Math.round(frame.ox / cell + gx0);
  const worldOy = Math.round(frame.oy / cell + gy0);
  const cells = rasterize(core, rect, cell);

  // 每個行政區至少 1 格：目標＝它最大一塊的重心（沒有邊界的放在整張圖中心）
  const targets: CellTarget[] = inputs.map((u, idx) => {
    const b = u.polys.length ? bigest(u.polys) : null;
    return {
      idx,
      cx: b ? (b.cx - rect.x0) / cell : rect.w / 2,
      cy: b ? (rect.yTop - b.cy) / cell : rect.h / 2,
    };
  });
  ensureCells(cells, rect.w, rect.h, targets, codes.length);
  return {
    cellM: Math.round(cell * 1000),
    w: rect.w,
    h: rect.h,
    ox: worldOx,
    oy: worldOy,
    codes,
    layers: [{ ox: 0, oy: 0, w: rect.w, h: rect.h, rle: encodeRle(cells) }],
  };
}

async function write(path: string, file: RasterFile) {
  await Deno.writeTextFile(new URL(path, OUT), JSON.stringify(file) + "\n");
}

await Deno.mkdir(new URL("towns/", OUT), { recursive: true });
await Deno.mkdir(new URL("villages/", OUT), { recursive: true });

// ── 全國：主島＋三個離島內嵌框，同尺度 ───────────────────────────
/** 縣市代碼 → 世界框（鄉鎮與村里檔用同一個） */
const countyFrame = new Map<string, Frame>();
{
  const codes = childrenOf("", 5);
  const inputs = codes.map((code) => ({ code, polys: countyGeo.get(code)!.polys }));
  const nameOf = (code: string) => countyGeo.get(code)!.props.COUNTYNAME.replace(/臺/g, "台");
  const island = new Set(["澎湖縣", "金門縣", "連江縣"]);
  const mainIdx = codes.map((c, i) => (island.has(nameOf(c)) ? -1 : i)).filter((i) => i >= 0);

  const mainBox = rectKm(120.0, 122.05, 21.85, 25.4);
  const mainRect = rectToGrid(mainBox, COUNTY_CELL_KM);
  const mainInputs = inputs.map((u, i) => (mainIdx.includes(i) ? u : { code: u.code, polys: [] }));
  const mainCells = rasterize(mainInputs, mainRect, COUNTY_CELL_KM);

  // 離島：各自取景（只畫自己的縣，不讓主島的鄰居跑進框裡），內嵌在主島西邊的海上
  const frames: Array<{ name: string; lon: [number, number]; lat: [number, number] }> = [
    { name: "連江縣", lon: [119.88, 120.58], lat: [25.9, 26.45] },
    { name: "澎湖縣", lon: [119.28, 119.75], lat: [23.15, 23.82] },
    { name: "金門縣", lon: [118.15, 118.55], lat: [24.38, 24.55] },
  ];
  const insets = frames.map((f) => {
    const idx = codes.findIndex((c) => nameOf(c) === f.name);
    const rect = rectToGrid(rectKm(f.lon[0], f.lon[1], f.lat[0], f.lat[1]), COUNTY_CELL_KM);
    const only = inputs.map((u, i) => (i === idx ? u : { code: u.code, polys: [] }));
    const cells = rasterize(only, rect, COUNTY_CELL_KM);
    return { idx, rect, cells, name: f.name };
  });
  const margin = Math.max(...insets.map((i) => i.rect.w)) + 6;

  // 主島每個縣至少 1 格；離島每個縣至少 1 格（框內）
  const mainTargets: CellTarget[] = mainIdx.map((idx) => {
    const b = bigest(inputs[idx].polys);
    return { idx, cx: (b.cx - mainRect.x0) / COUNTY_CELL_KM, cy: (mainRect.yTop - b.cy) / COUNTY_CELL_KM };
  });
  ensureCells(mainCells, mainRect.w, mainRect.h, mainTargets, codes.length);
  for (const i of insets) {
    const b = bigest(inputs[i.idx].polys);
    ensureCells(i.cells, i.rect.w, i.rect.h, [{ idx: i.idx, cx: (b.cx - i.rect.x0) / COUNTY_CELL_KM, cy: (i.rect.yTop - b.cy) / COUNTY_CELL_KM }], codes.length);
  }

  let oy = 0;
  const layers: RasterLayer[] = [{ ox: margin, oy: 0, w: mainRect.w, h: mainRect.h, rle: encodeRle(mainCells) }];
  const mainFrame: Frame = { filterFragments: true, x0: mainRect.x0, yTop: mainRect.yTop, ox: margin, oy: 0, clip: mainBox };
  for (const c of codes) countyFrame.set(c, mainFrame);
  for (const i of insets) {
    layers.push({ ox: 1, oy, w: i.rect.w, h: i.rect.h, rle: encodeRle(i.cells), inset: true });
    const fr = frames.find((f) => f.name === i.name)!;
    countyFrame.set(codes[i.idx], { filterFragments: false, x0: i.rect.x0, yTop: i.rect.yTop, ox: 1, oy, clip: rectKm(fr.lon[0], fr.lon[1], fr.lat[0], fr.lat[1]) });
    oy += i.rect.h + 6;
  }
  const file: RasterFile = { cellM: COUNTY_CELL_KM * 1000, w: margin + mainRect.w, h: Math.max(mainRect.h, oy), codes, layers };
  await write("national.json", file);
  console.log(`全國 ${file.w}×${file.h} 格，縣市 ${codes.length}`);
}

// ── 縣市層：鄉鎮市區 ───────────────────────────────────────────
let townTotal = 0;
for (const county of childrenOf("", 5)) {
  const codes = childrenOf(county, 8);
  const file = rasterScope(codes, townGeo, COUNTY_CELL_KM, MAX_LONG_COUNTY, CORE_RADIUS_KM.town, countyFrame.get(county)!);
  await write(`towns/${county}.json`, file);
  townTotal += codes.length;
}
console.log(`鄉鎮市區 ${townTotal}`);

// ── 村里層：每個鄉鎮一個檔 ─────────────────────────────────────
let villageTotal = 0;
let missingGeo = 0;
for (const town of adminCodes.filter((c) => c.length === 8).sort()) {
  const codes = childrenOf(town, 11);
  missingGeo += codes.filter((c) => !villageGeo.has(c)).length;
  const file = rasterScope(codes, villageGeo, VILLAGE_CELL_KM, MAX_LONG, CORE_RADIUS_KM.village, countyFrame.get(town.slice(0, 5))!);
  await write(`villages/${town}.json`, file);
  villageTotal += codes.length;
}
console.log(`村里 ${villageTotal}（官方清單有、圖資沒有邊界的 ${missingGeo}）`);
