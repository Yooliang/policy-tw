/**
 * 名稱標籤的位置與避讓（lib/raster-grid.ts 的 inscribedDistance／placeLabels）：
 * 最大內接位置、互不重疊、小面積優先、被環繞的小區（嘉義市在嘉義縣中間）一定有標籤。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { SEA, decodeRaster, inscribedDistance, placeLabels, type PlacedLabel, type RasterFile } from "./raster-grid.ts";

/** 環狀大區（0）中間包著一個小區（1）：大區的重心剛好落在小區上 */
function ringRaster(size = 60, hole = 8) {
  const cells = new Int16Array(size * size).fill(0);
  const o = Math.floor((size - hole) / 2);
  for (let y = o; y < o + hole; y += 1) for (let x = o; x < o + hole; x += 1) cells[y * size + x] = 1;
  return { w: size, h: size, codes: ["RING", "HOLE"], cells };
}

const box = (l: PlacedLabel) => ({ x0: l.x - (l.text.length * l.fs) / 2, x1: l.x + (l.text.length * l.fs) / 2, y0: l.y - l.fs * 0.6, y1: l.y + l.fs * 0.6 });
const overlap = (a: PlacedLabel, b: PlacedLabel) => {
  const p = box(a), q = box(b);
  return p.x0 < q.x1 && p.x1 > q.x0 && p.y0 < q.y1 && p.y1 > q.y0;
};

Deno.test("inscribedDistance：海是 0，中心比邊緣遠，邊界格約 0.5", () => {
  const cells = Int16Array.from([
    SEA, SEA, SEA, SEA, SEA,
    SEA, 0, 0, 0, SEA,
    SEA, 0, 0, 0, SEA,
    SEA, 0, 0, 0, SEA,
    SEA, SEA, SEA, SEA, SEA,
  ]);
  const d = inscribedDistance({ w: 5, h: 5, cells });
  assertEquals(d[0], 0);
  assertEquals(d[1 * 5 + 1], 0.5);
  assert(d[2 * 5 + 2] > d[1 * 5 + 1]);
  assertEquals(d[2 * 5 + 2], 1.5);
});

Deno.test("placeLabels：環狀大區的標籤不在小區上（不用重心），小區自己也有標籤，兩者不重疊、各自落在自己的格子上", () => {
  const r = ringRaster();
  const labels = placeLabels(r, ["環區", "小區"], 6);
  const ring = labels.find((l) => l.idx === 0);
  const hole = labels.find((l) => l.idx === 1);
  assert(ring && hole, "兩個區都有標籤");
  const at = (l: PlacedLabel) => r.cells[Math.floor(l.y) * r.w + Math.floor(l.x)];
  assertEquals(at(ring!), 0, "大區的標籤中心在大區的格子上");
  assertEquals(at(hole!), 1, "小區的標籤中心在小區的格子上");
  assert(!overlap(ring!, hole!), "標籤互不重疊");
});

Deno.test("placeLabels：兩個擠在一起的標籤，小面積的先擺、大區的讓開或縮小；實在放不下就不放", () => {
  // 左右兩區，右區很小，字比整個區還大
  const w = 40, h = 20;
  const cells = new Int16Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) cells[y * w + x] = x < 34 ? 0 : 1;
  const labels = placeLabels({ w, h, codes: ["BIG", "SMALL"], cells }, ["大大大大", "小小"], 5);
  const small = labels.find((l) => l.idx === 1);
  assert(small, "小區一定有標籤（字可以溢出）");
  const big = labels.find((l) => l.idx === 0);
  if (big) assert(!overlap(big, small!));
  // 空間太小：1×1 的區放得下零個以上的標籤也不能炸；同一格不會有兩個標籤重疊
  const tiny = placeLabels({ w: 2, h: 1, codes: ["A", "B"], cells: Int16Array.from([0, 1]) }, ["甲乙丙", "丁戊己"], 5);
  for (let i = 0; i < tiny.length; i += 1) for (let j = i + 1; j < tiny.length; j += 1) assert(!overlap(tiny[i], tiny[j]));
});

Deno.test("placeLabels：結果可重現，標籤字級不小於 0.6 倍", () => {
  const r = ringRaster(80, 10);
  const a = placeLabels(r, ["環", "洞"], 8);
  assertEquals(placeLabels(r, ["環", "洞"], 8), a);
  assert(a.every((l) => l.fs >= 8 * 0.6 - 1e-9 && l.fs <= 8 + 1e-9));
});

// ── 真實資料：全國層 ───────────────────────────────────────────

const NAMES: Record<string, string> = {
  "09007": "連江縣", "09020": "金門縣", "10002": "宜蘭縣", "10004": "新竹縣", "10005": "苗栗縣", "10007": "彰化縣", "10008": "南投縣",
  "10009": "雲林縣", "10010": "嘉義縣", "10013": "屏東縣", "10014": "台東縣", "10015": "花蓮縣", "10016": "澎湖縣", "10017": "基隆市",
  "10018": "新竹市", "10020": "嘉義市", "63000": "台北市", "64000": "高雄市", "65000": "新北市", "66000": "台中市", "67000": "台南市",
  "68000": "桃園市",
};

Deno.test("全國層：嘉義縣與嘉義市標籤不重疊、各自落在自己的格子上；新竹市也有標籤；所有標籤兩兩不重疊", async () => {
  const file = JSON.parse(await Deno.readTextFile(new URL("../data/tw-raster/national.json", import.meta.url))) as RasterFile;
  const r = decodeRaster(file);
  const texts = r.codes.map((c) => NAMES[c]);
  const fs = Math.max(r.w, r.h) / 36;
  const labels = placeLabels(r, texts, fs);
  const byCode = (code: string) => labels.find((l) => r.codes[l.idx] === code);
  const county = byCode("10010");
  const city = byCode("10020");
  assert(county && city, "嘉義縣、嘉義市都有標籤");
  const cellAt = (l: PlacedLabel) => r.codes[r.cells[Math.floor(l.y) * r.w + Math.floor(l.x)]];
  assertEquals(cellAt(county!), "10010", "嘉義縣的標籤在嘉義縣的格子上");
  assertEquals(cellAt(city!), "10020", "嘉義市的標籤在嘉義市的格子上");
  assert(!overlap(county!, city!), "嘉義縣與嘉義市的標籤不重疊");
  assert(byCode("10018"), "被新竹縣包住的新竹市也有標籤");
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) assert(!overlap(labels[i], labels[j]), `${labels[i].text} 與 ${labels[j].text} 重疊`);
  }
  // 大部分縣市都放得下標籤（避讓不是把標籤全丟掉）
  assert(labels.length >= 15, `只放了 ${labels.length} 個標籤`);
});
