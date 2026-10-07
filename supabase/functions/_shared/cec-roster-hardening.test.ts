// 中選會名冊核對的加固（2026-10-08，#440 同儕審查）：
//   1. 長姓名切分：看內政部政黨名冊，不看「前一塊有幾個字」
//   2. 單列異常不拖垮整份
//   3. checkBatch 核對鄉鎮市區與村里（同 10-05 議員選區那個洞：名字、縣市、政黨都對，地名填錯也一票過）
//   4. 名冊 PDF 太大不在 Edge 上抽字（WORKER_RESOURCE_LIMIT），交人工驗證
//   5. 政黨名單複本跟 lib/party-seed.json 一致
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { cecRosterText, checkBatch, parseRoster, ROSTER_MAX_BYTES, RosterTooLargeError } from "./cec-roster.ts";
import { ROSTER_PARTY_NAMES } from "./party-names.ts";

const readFixture = (f: string) => Deno.readTextFile(new URL(`./fixtures/${f}`, import.meta.url));
const HDR = "選舉區 登記日期 姓名 推薦之政黨 備註 ";

// ── 1. 長姓名切分 ─────────────────────────────────────────────────
Deno.test("長姓名不會被當成黨名前半：[杜司偉, 車牧勒薩以, 中國國民黨] ＝ 姓名「杜司偉車牧勒薩以」＋中國國民黨", () => {
  const rows = parseRoster(HDR + "屏東縣三地門鄉 115/09/01 杜司偉 車牧勒薩以 中國國民黨 屏東縣霧臺鄉 115/09/02 王大明 無");
  assertEquals(rows.map((r) => [r.name, r.party]), [["杜司偉車牧勒薩以", "中國國民黨"], ["王大明", "無"]]);
});

Deno.test("黨名被換行拆開：名冊上的黨名（含不以黨結尾的）接回完整；名冊裡沒有的黨名，碎片長得像黨名才接", () => {
  const rows = parseRoster(HDR + [
    "新竹縣竹北市 115/09/01 李惠暄 小民參政歐巴桑 聯盟",
    "新竹縣竹北市 115/09/01 林聖峰 天宙和平統一家 庭黨",
    "新竹縣竹北市 115/09/01 梁志宇 中國國家社會 主義勞工黨",
    "新竹縣竹北市 115/09/01 張三 剛成立還沒進名冊的 新聯盟", // 名冊裡沒有，但碎片「新聯盟」長得像黨名
    "新竹縣竹北市 115/09/01 李四 某某姓名太長的 不知名", // 名冊裡沒有、碎片也不像黨名：最後一塊當政黨
  ].join(" "));
  assertEquals(rows.map((r) => [r.name, r.party]), [
    ["李惠暄", "小民參政歐巴桑聯盟"], ["林聖峰", "天宙和平統一家庭黨"], ["梁志宇", "中國國家社會主義勞工黨"],
    ["張三剛成立還沒進名冊的", "新聯盟"], ["李四某某姓名太長的", "不知名"],
  ]);
});

// ── 2. 單列異常不拖垮整份 ─────────────────────────────────────────
Deno.test("單列異常（姓名欄空、政黨不以「黨」結尾、整列只有姓名）不會讓整份退回逐欄配對：每列照收，其餘照解", () => {
  const normal = Array.from({ length: 40 }, (_, i) => `新竹縣竹北市 115/09/01 候選人${i} 無`);
  const rows = parseRoster(HDR + [
    ...normal,
    "新竹縣竹北市 115/09/02 王大明 無",
    "新竹縣竹北市 115/09/02 夏潮聯合會", // 姓名欄是空的、政黨不以黨結尾（內政部名冊有這個政黨）
    "新竹縣竹東鎮 115/09/03 神秘人", // 只有一塊、不是政黨
    "新竹縣竹東鎮 115/09/03", // 什麼都沒有
    "新竹縣竹東鎮 115/09/04 李小龍 中國國民黨",
  ].join(" "));
  assertEquals(rows.length, 45, "45 個日期就是 45 列");
  assertEquals(rows.slice(40).map((r) => [r.name, r.party, r.place]), [
    ["王大明", "無", "竹北市"], ["", "夏潮聯合會", "竹北市"], ["", "神秘人", "竹東鎮"], ["", "", "竹東鎮"], ["李小龍", "中國國民黨", "竹東鎮"],
  ]);
  assertEquals(rows[39].name, "候選人39", "異常的列不影響前面正常的");
  // 沒有姓名的列不會對上任何人
  assertEquals(checkBatch(rows, [{ id: "x", name: "神秘人", party: "神秘人", region: "新竹縣" }]).passed, []);
});

// ── 3. 核對鄉鎮市區與村里 ─────────────────────────────────────────
const village = parseRoster(await readFixture("cec-roster-2026-village.txt"));
const mayors = parseRoster(await readFixture("cec-roster-2026-township-mayor.txt"));
const reps = parseRoster(await readFixture("cec-roster-2026-township-rep.txt"));
const councilRows = parseRoster(await readFixture("cec-roster-2026-municipal-council.txt"));

Deno.test("村里長：鄉鎮市區與村里都對得上才過；填成別區別里（姓名、縣市、政黨都對）判不支持並寫明名冊上的地名", () => {
  // 名冊：台北市松山區莊敬里 周政諭 中國國民黨
  const base = { name: "周政諭", party: "中國國民黨", region: "台北市" };
  const r = checkBatch(village, [
    { id: "ok", ...base, sub_region: "松山區", village: "莊敬里" },
    { id: "okRegionWithTown", ...base, region: "台北市松山區", village: "莊敬里" }, // 村里長任務 target.region 是縣市＋鄉鎮市區
    { id: "okTai", ...base, region: "臺北市", sub_region: "松山區", village: "莊敬里" },
    { id: "wrongTown", ...base, sub_region: "大安區", village: "莊敬里" },
    { id: "wrongVillage", ...base, sub_region: "松山區", village: "德安里" },
    { id: "wrongBoth", ...base, sub_region: "大安區", village: "德安里" },
    { id: "wrongTownInRegion", ...base, region: "台北市大安區" },
    { id: "noPlaceGiven", ...base }, // 交件沒給地名：不比（維持原行為）
  ]);
  assertEquals(r.passed.sort(), ["noPlaceGiven", "ok", "okRegionWithTown", "okTai"]);
  assertEquals(r.failed.map((f) => f.id).sort(), ["wrongBoth", "wrongTown", "wrongTownInRegion", "wrongVillage"]);
  for (const f of r.failed) assert(f.reason.includes("名冊上的地名是 松山區莊敬里"), f.reason);
});

Deno.test("鄉鎮市長、區長：鄉鎮市區要對得上；PDF 村里欄是空的那幾列只比鄉鎮市區", () => {
  const r = checkBatch([...mayors, ...village], [
    { id: "mayor", name: "邱臣遠", party: "台灣民眾黨", region: "新竹縣", sub_region: "竹北市" },
    { id: "mayorWrongTown", name: "邱臣遠", party: "台灣民眾黨", region: "新竹縣", sub_region: "竹東鎮" },
    // 台中市大安區洪正義：PDF 的村里欄是空的（place 只有「大安區」）——村里不比，鄉鎮市區照比
    { id: "noVillageCell", name: "洪正義", party: "無", region: "台中市", sub_region: "大安區", village: "隨便一里" },
    { id: "noVillageCellWrongTown", name: "洪正義", party: "無", region: "台中市", sub_region: "后里區", village: "隨便一里" },
  ]);
  assertEquals(r.passed.sort(), ["mayor", "noVillageCell"]);
  assertEquals(r.failed.map((f) => f.id).sort(), ["mayorWrongTown", "noVillageCellWrongTown"]);
});

Deno.test("議員（名冊沒有地名欄）不受影響：交件帶了 sub_region 也不比；代表仍核選舉區", () => {
  const council = councilRows[0];
  assertEquals(council.place ?? null, null);
  assertEquals(checkBatch(councilRows, [{ id: "c", name: council.name, party: council.party, region: "台北市", district: council.district, sub_region: "隨便區" }]).passed, ["c"]);
  const rep = reps[0]; // 新竹縣竹北市 第01選舉區 張美珠 無
  const r = checkBatch(reps, [
    { id: "ok", name: rep.name, party: rep.party, region: "新竹縣", sub_region: "竹北市", district: "第01選舉區" },
    { id: "wrongTown", name: rep.name, party: rep.party, region: "新竹縣", sub_region: "竹東鎮", district: "第01選舉區" },
    { id: "wrongDistrict", name: rep.name, party: rep.party, region: "新竹縣", sub_region: "竹北市", district: "第09選舉區" },
  ]);
  assertEquals(r.passed, ["ok"]);
  assertEquals(r.failed.map((f) => f.id).sort(), ["wrongDistrict", "wrongTown"]);
});

// ── 4. 名冊 PDF 太大不在 Edge 上抽字 ───────────────────────────────
Deno.test("名冊 PDF 超過上限：看 Content-Length 就丟 RosterTooLargeError、不讀內容，也不抽字", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } });
  const fake = (() => Promise.resolve(new Response(body, { headers: { "content-length": "7501826" } }))) as unknown as typeof fetch;
  const e = await assertRejects(() => cecRosterText("https://web.cec.gov.tw/api/file/f1abbda2-229b-4a02-8dfb-58beb3ceca61.pdf", fake), RosterTooLargeError);
  assertEquals(e.bytes, 7501826);
  assert(cancelled, "太大的名冊不能把內容讀進記憶體");
  assertEquals(ROSTER_MAX_BYTES, 3_000_000);
});

Deno.test("名冊 PDF 沒有 Content-Length 時，讀完發現超過上限一樣丟 RosterTooLargeError（不抽字）", async () => {
  const fake = (() => Promise.resolve(new Response(new Uint8Array(ROSTER_MAX_BYTES + 1)))) as unknown as typeof fetch;
  await assertRejects(() => cecRosterText("https://web.cec.gov.tw/api/file/f1abbda2-229b-4a02-8dfb-58beb3ceca61.pdf", fake), RosterTooLargeError);
});

Deno.test("system-one roster_batch：太大的名冊回報原因、不佔一輪 3 份的名額；交件的 sub_region／village 傳進核對", async () => {
  const src = await Deno.readTextFile(new URL("../system-one/index.ts", import.meta.url));
  assert(src.includes("RosterTooLargeError"), "roster_batch 要接 RosterTooLargeError");
  assert(src.includes("照舊交人工驗證"), "回報要寫原因：沒有系統票、交人工驗證");
  assert(/let read = 0;[\s\S]*?if \(read >= 3\) break;/.test(src), "名額只算真的抽字的名冊（太大的不算，免得它每輪排在前面把別份擠掉）");
  assert(!src.includes("[...byUrl.entries()].slice(0, 3)"), "不能用 slice(0, 3) 先切（太大的會佔名額）");
  assert(src.includes("sub_region: typeof c.payload.sub_region") && src.includes("village: typeof c.payload.village"), "要把 sub_region／village 交給 checkBatch");
});

// ── 5. 政黨名單複本 ───────────────────────────────────────────────
Deno.test("party-names.ts 是 lib/party-seed.json 的複本（名稱＋寫法對照）：名冊更新了要重跑 scripts/gen-party-names.mjs", async () => {
  const seed = JSON.parse(await Deno.readTextFile(new URL("../../../lib/party-seed.json", import.meta.url)));
  const want = [...new Set([...seed.parties.map((p: { name: string }) => p.name), ...seed.aliases.map((a: { alias: string }) => a.alias)])].sort();
  assertEquals([...ROSTER_PARTY_NAMES], want);
  for (const p of ["夏潮聯合會", "小民參政歐巴桑聯盟", "三勢團結促進聯盟"]) assert(ROSTER_PARTY_NAMES.includes(p), p);
});
