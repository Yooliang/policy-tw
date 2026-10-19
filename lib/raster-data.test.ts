/**
 * 預先產生的點陣檔（data/tw-raster/）的完整性守門：
 * 每個行政區至少 1 格、格子不重疊（一格只有一個序號，且序號都在清單內）、代碼跟 admin_divisions 一致。
 * 官方清單用 scripts/fixtures/admin-codes.txt（admin_divisions.code，2026-10-19 匯出）；
 * 區劃異動時：更新這份清單、重跑 scripts/build-tw-raster.ts。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { cellCounts, decodeRaster, SEA, type RasterFile } from "./raster-grid.ts";

const read = async (path: string) => JSON.parse(await Deno.readTextFile(new URL(`../data/tw-raster/${path}`, import.meta.url))) as RasterFile;
const admin = (await Deno.readTextFile(new URL("../scripts/fixtures/admin-codes.txt", import.meta.url))).split(/\r?\n/).filter(Boolean);
const level = (len: number, parent = "") => admin.filter((c) => c.length === len && c.startsWith(parent)).sort();

function check(file: RasterFile, expected: string[], what: string) {
  assertEquals([...file.codes].sort(), expected, `${what}：行政區代碼跟 admin_divisions 不一致`);
  assertEquals(new Set(file.codes).size, file.codes.length, `${what}：代碼重複`);
  const raster = decodeRaster(file);
  const counts = cellCounts(raster.cells, file.codes.length);
  counts.forEach((n, i) => assert(n >= 1, `${what}：${file.codes[i]} 一格都沒有`));
  for (const v of raster.cells) assert(v >= SEA && v < file.codes.length, `${what}：格值 ${v} 超出清單`);
  // 各塊的游程總長要剛好等於塊的面積（沒有漏格、沒有多格）
  for (const layer of file.layers) {
    let n = 0;
    for (let i = 1; i < layer.rle.length; i += 2) n += layer.rle[i];
    assertEquals(n, layer.w * layer.h, `${what}：游程長度跟塊的大小不符`);
  }
  assert(file.cellM > 0);
}

Deno.test("官方清單：縣市 22、鄉鎮市區 368、村里 7,781", () => {
  assertEquals([level(5).length, level(8).length, level(11).length], [22, 368, 7781]);
});

Deno.test("全國：22 縣市每個至少 1 格，1 公里一格，澎湖金門連江是內嵌框", async () => {
  const file = await read("national.json");
  check(file, level(5), "全國");
  assertEquals(file.cellM, 1000);
  assertEquals(file.layers.filter((l) => l.inset).length, 3);
  const land = [...decodeRaster(file).cells].filter((v) => v >= 0).length;
  assert(land > 30000 && land < 45000, `全國陸地格數 ${land} 應該約 3.6 萬`);
});

Deno.test("縣市層：每個縣市一個檔，鄉鎮市區代碼與官方一致、每區至少 1 格、1 公里一格", async () => {
  for (const county of level(5)) {
    const file = await read(`towns/${county}.json`);
    check(file, level(8, county), `縣市 ${county}`);
    assertEquals(file.cellM, 1000, `縣市 ${county} 尺度`);
  }
});

/** 一個行政區格子的連通塊（8 方向）：[格數, 重心 x, 重心 y]，由大到小 */
function components(file: RasterFile) {
  const r = decodeRaster(file);
  const seen = new Uint8Array(r.w * r.h);
  const comps: Array<Array<[number, number, number]>> = r.codes.map(() => []);
  for (let s = 0; s < r.cells.length; s += 1) {
    if (seen[s] || r.cells[s] < 0) continue;
    const v = r.cells[s];
    const stack = [s];
    seen[s] = 1;
    let n = 0, sx = 0, sy = 0;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % r.w, y = (i - x) / r.w;
      n += 1; sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= r.w || ny >= r.h) continue;
          const j = ny * r.w + nx;
          if (!seen[j] && r.cells[j] === v) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    comps[v].push([n, sx / n, sy / n]);
  }
  comps.forEach((c) => c.sort((a, b) => b[0] - a[0]));
  return { r, comps };
}

Deno.test("口湖鄉（雲林縣）：台子村的外傘頂洲沙洲不能把整個鄉擠成一角，台子村不會散到十幾公里外", async () => {
  const file = await read("villages/10009190.json");
  const { r, comps } = components(file);
  assert(r.w * (r.cellM / 1000) <= 20 && r.h * (r.cellM / 1000) <= 20, `畫布 ${r.w}×${r.h} 格太大，鄉被擠到一角了`);
  let land = 0;
  for (const v of r.cells) if (v >= 0) land += 1;
  assert(land / (r.w * r.h) > 0.3, "陸地占畫布的比例太低");
  const taizi = file.codes.indexOf("10009190014");
  assert(taizi >= 0);
  const main = comps[taizi][0];
  for (const c of comps[taizi].slice(1)) {
    const km = Math.hypot(c[1] - main[1], c[2] - main[2]) * (r.cellM / 1000);
    assert(km < 6, `台子村有一塊離主體 ${km.toFixed(1)} 公里`);
  }
});

/**
 * 讀實際的點陣：這幾個村里本來就有多塊——離島（澎湖、金門、龜山島）、飛地、狹長形被 200 公尺格切斷——掃描時放行。
 * 這份清單是 2026-10-19 掃全國 7,781 個村里的結果（散成相距超過 3 公里的共 19 個，最遠 13.3 公里）；新增異常會讓下面那條紅。
 * 口湖鄉台子村外傘頂洲沙洲、金門烏坵這類「離本體十幾公里以上的塊」已在產生時丟掉，所以不在清單的規模裡。
 */
const KNOWN_SPLIT = new Set([
  "09020030007", "09020050001", // 金門：離島
  "10002040024", // 頭城鎮龜山里：龜山島離岸約 12 公里
  "10009010024", "10009180014", "10009190014", // 雲林沿海：沙洲與海埔地的近端部分（≈3 公里）
  "10013250004", "10013280005", // 枋山鄉善餘村（狹長）、瑪家鄉排灣村（兩塊飛地）
  "10015120003", // 萬榮鄉萬榮村：兩塊（飛地）
  "10016010014", "10016020003", "10016030008", "10016030011", "10016030012", "10016030013", "10016050009", // 澎湖：離島
  "64000110035", "64000360003", // 小港區鳳森里、茂林區多納里：狹長
  "65000220006", // 石門區尖鹿里：狹長
]);
/** 任何村里的塊離主體超過這麼多公里就一定是異常（沙洲、飛地被畫進來） */
const MAX_SPREAD_KM = 15;
Deno.test("全國村里層：沒有村里的格子散成多塊且相距超過 3 公里（已知的 19 個例外除外），任何村里都不超過 15 公里", async () => {
  const flagged: string[] = [];
  for (const town of level(8)) {
    const file = await read(`villages/${town}.json`);
    const { r, comps } = components(file);
    comps.forEach((cs, i) => {
      if (cs.length < 2) return;
      const spread = Math.max(...cs.slice(1).map((c) => Math.hypot(c[1] - cs[0][1], c[2] - cs[0][2]) * (r.cellM / 1000)));
      if ((spread > 3 && !KNOWN_SPLIT.has(file.codes[i])) || spread > MAX_SPREAD_KM) flagged.push(`${file.codes[i]}（${spread.toFixed(1)} 公里）`);
    });
  }
  assertEquals(flagged, [], "村里格子散成相距很遠的多塊");
});

Deno.test("村里層：每個鄉鎮一個檔，村里代碼與官方一致、每里至少 1 格、尺度是 200 公尺的整數倍", async () => {
  let villages = 0;
  for (const town of level(8)) {
    const file = await read(`villages/${town}.json`);
    check(file, level(11, town), `鄉鎮 ${town}`);
    assertEquals(file.cellM % 200, 0, `鄉鎮 ${town} 尺度`);
    villages += file.codes.length;
  }
  assertEquals(villages, 7781);
});
