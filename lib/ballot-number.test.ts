/**
 * 守號次的呈現（#460）：
 *   1. 只有正整數算號次，其餘一律當沒有（徽章、標題都不出）；
 *   2. 標題帶「（2 號）」、沒有號次標題不變；
 *   3. 同一場選舉內有號次的在前、沒有的維持原順序，而且不同場次互不干擾、整份清單的位置不動。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { TAIWAN_COUNTIES } from "./election-regions.ts";
import {
  ballotLabel,
  ballotNo,
  anyBallotNo,
  ballotNoOfElection,
  compareBallotNo,
  listByBallotNo,
  listByCountyBallot,
  nameWithBallot,
  orderByBallotNo,
  orderPeopleByBallotNo,
} from "./ballot-number.ts";

Deno.test("只有正整數算號次", () => {
  assertEquals(ballotNo(1), 1);
  assertEquals(ballotNo(12), 12);
  for (const bad of [0, -3, 1.5, NaN, "2", null, undefined, true]) assertEquals(ballotNo(bad), undefined);
});

Deno.test("徽章文字：N 號；沒有號次是空字串", () => {
  assertEquals(ballotLabel(2), "2 號");
  assertEquals(ballotLabel(undefined), "");
  assertEquals(ballotLabel(0), "");
});

Deno.test("姓名帶號次：標題用", () => {
  assertEquals(nameWithBallot("王小明", 2), "王小明（2 號）");
  assertEquals(nameWithBallot("王小明", undefined), "王小明");
  assertEquals(nameWithBallot("王小明", null), "王小明");
});

Deno.test("號次先後：有號次在前、小的在前、都沒有回 0", () => {
  assertEquals(compareBallotNo(1, 2) < 0, true);
  assertEquals(compareBallotNo(3, 1) > 0, true);
  assertEquals(compareBallotNo(5, undefined) < 0, true);
  assertEquals(compareBallotNo(undefined, 5) > 0, true);
  assertEquals(compareBallotNo(undefined, undefined), 0);
  assertEquals(compareBallotNo(0, undefined), 0, "0 不是號次");
});

type P = { id: string; name: string; candNo?: number; electionType: string; region?: string; subRegion?: string; village?: string };
const p = (id: string, electionType: string, o: Partial<P> = {}): P => ({ id, name: id, electionType, ...o });
const ids = (xs: P[]) => xs.map((x) => x.id);

Deno.test("同一場：有號次照號次在前，沒有號次排後面並維持原順序", () => {
  const list = [
    p("無甲", "縣市長", { region: "臺北市" }),
    p("三號", "縣市長", { region: "臺北市", candNo: 3 }),
    p("無乙", "縣市長", { region: "臺北市" }),
    p("一號", "縣市長", { region: "臺北市", candNo: 1 }),
  ];
  assertEquals(ids(orderPeopleByBallotNo(list)), ["一號", "三號", "無甲", "無乙"]);
});

Deno.test("沒有任何人有號次：整份清單完全不變", () => {
  const list = [p("丙", "縣市長", { region: "臺北市" }), p("甲", "縣市長", { region: "臺北市" }), p("乙", "縣市長", { region: "新北市" })];
  assertEquals(ids(orderPeopleByBallotNo(list)), ["丙", "甲", "乙"]);
});

Deno.test("不同縣市的縣市長互不干擾：各縣市佔的位置不動", () => {
  const list = [
    p("北無", "縣市長", { region: "臺北市" }),
    p("新二", "縣市長", { region: "新北市", candNo: 2 }),
    p("北一", "縣市長", { region: "臺北市", candNo: 1 }),
    p("新一", "縣市長", { region: "新北市", candNo: 1 }),
  ];
  // 臺北市佔第 0、2 格：一號進第 0 格、無號次的退到第 2 格；新北市佔第 1、3 格：一號進第 1 格
  assertEquals(ids(orderPeopleByBallotNo(list)), ["北一", "新一", "北無", "新二"]);
});

Deno.test("議員照選舉區分場；選區待補的人（分不出哪一場）原地不動", () => {
  const list = [
    p("待補", "縣市議員", { region: "臺北市" }),
    p("二區二", "縣市議員", { region: "臺北市", subRegion: "第02選舉區", candNo: 2 }),
    p("一區無", "縣市議員", { region: "臺北市", subRegion: "第01選舉區" }),
    p("二區一", "縣市議員", { region: "臺北市", subRegion: "第02選舉區", candNo: 1 }),
    p("一區五", "縣市議員", { region: "臺北市", subRegion: "第01選舉區", candNo: 5 }),
  ];
  assertEquals(ids(orderPeopleByBallotNo(list)), ["待補", "二區一", "一區五", "二區二", "一區無"]);
});

Deno.test("總統副總統：副手分不出場次，原地不動", () => {
  const list = [
    p("副", "總統副總統", { position: "副總統" } as Partial<P>),
    p("總二", "總統副總統", { position: "總統", candNo: 2 } as Partial<P>),
    p("總一", "總統副總統", { position: "總統", candNo: 1 } as Partial<P>),
  ];
  assertEquals(ids(orderPeopleByBallotNo(list)), ["副", "總一", "總二"]);
});

Deno.test("通用版：group 回 undefined 的不動；不改動原陣列", () => {
  const src = [{ n: 2, g: "a" }, { n: undefined, g: undefined }, { n: 1, g: "a" }];
  const out = orderByBallotNo(src, { candNo: (x) => x.n, group: (x) => x.g });
  assertEquals(out.map((x) => x.n), [1, undefined, 2]);
  assertEquals(src.map((x) => x.n), [2, undefined, 1]);
});

Deno.test("某一屆的號次：只認該屆、退選的不算", () => {
  const els = [
    { electionId: 2022, candNo: 7, candidacyStatus: "not_elected" },
    { electionId: 2026, candNo: 2, candidacyStatus: "filed" },
  ];
  assertEquals(ballotNoOfElection(els, 2026), 2);
  assertEquals(ballotNoOfElection(els, 2022), 7);
  assertEquals(ballotNoOfElection(els, 2024), undefined);
  assertEquals(ballotNoOfElection([{ electionId: 2026, candNo: 2, candidacyStatus: "withdrawn" }], 2026), undefined);
  assertEquals(ballotNoOfElection([{ electionId: 2026, candidacyStatus: "filed" }], 2026), undefined);
  assertEquals(ballotNoOfElection(undefined, 2026), undefined);
  assertEquals(ballotNoOfElection(els, null), undefined);
});

// ---- 有號次的場次純照號次、隱藏沒號次的人（維護者 10-18） ----
const council = (id: number, candNo?: number, extra: Record<string, unknown> = {}) =>
  ({ id, name: `議${id}`, candNo, electionType: "縣市議員", region: "新竹縣", subRegion: "第01選舉區", ...extra });
const mayor = (id: number, name: string, candNo?: number) =>
  ({ id, name, candNo, electionType: "縣市長", region: "新竹縣" });

Deno.test("新竹縣 2022 第01選舉區：22 位亂序 → 1..22", () => {
  const nos = [8, 21, 4, 13, 1, 22, 2, 3, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20];
  const out = listByBallotNo(nos.map((n, i) => council(i, n)));
  assertEquals(out.map((p) => p.candNo), Array.from({ length: 22 }, (_, i) => i + 1));
});

Deno.test("縣長 1..5 加一筆沒號次的重複紀錄：重複的隱藏", () => {
  const list = [
    mayor(1, "劉雁祿"), // 沒號次的重複紀錄
    mayor(2, "甲", 3), mayor(3, "乙", 1), mayor(4, "丙", 5), mayor(5, "丁", 2), mayor(6, "戊", 4),
  ];
  const out = listByBallotNo(list);
  assertEquals(out.map((p) => p.candNo), [1, 2, 3, 4, 5]);
  assertEquals(out.some((p) => p.name === "劉雁祿"), false);
});

Deno.test("沒有任何號次的場次完全不變（含順序、不隱藏）", () => {
  const list = [council(3), council(1), council(2)];
  assertEquals(listByBallotNo(list), list);
});

Deno.test("隱藏只看同一場：別的選區沒號次的人不受影響", () => {
  const a1 = council(1, 2), a2 = council(2, 1), a3 = council(3);
  const b1 = council(4, undefined, { subRegion: "第02選舉區" }), b2 = council(5, undefined, { subRegion: "第02選舉區" });
  const out = listByBallotNo([a1, b1, a3, b2, a2]);
  assertEquals(out.map((p) => p.id), [2, 4, 5, 1]); // 第01區照號次且隱藏 a3；第02區原樣
});

Deno.test("退選的人不因沒號次被隱藏；分不出場次的人原地不動", () => {
  const w = council(9, undefined, { candidacyStatus: "withdrawn" });
  const noType = { id: 10, name: "無職位" };
  const out = listByBallotNo([council(1, 2), w, noType, council(2, 1)]);
  assertEquals(out.map((p) => p.id), [2, 1, 10, 9]); // 退選者留在清單、排在有號次的後面
});

Deno.test("anyBallotNo：只有合法號次算", () => {
  assertEquals(anyBallotNo([{ candNo: 0 }, { candNo: undefined }]), false);
  assertEquals(anyBallotNo([{}, { candNo: 3 }]), true);
});

const mayorIn = (id: string, name: string, region: string, candNo?: number, extra: Record<string, unknown> = {}) =>
  ({ id, name, region, candNo, electionType: "縣市長", ...extra });

Deno.test("listByCountyBallot：跨縣市不交錯，縣市照站上固定順序，同縣市內號次遞增", () => {
  const list = [
    mayorIn("a", "謝國樑", "基隆市", 1), mayorIn("b", "黃源甫", "新竹市", 1), mayorIn("c", "張善政", "桃園市", 1),
    mayorIn("d", "張家豪", "台北市", 1), mayorIn("e", "許忠信", "台南市", 1), mayorIn("f", "陳薇仲", "基隆市", 2),
    mayorIn("g", "王文娟", "台北市", 2), mayorIn("h", "林姿妙", "宜蘭縣", 1), mayorIn("i", "蔡適應", "基隆市", 3),
  ];
  const out = listByCountyBallot(list, TAIWAN_COUNTIES);
  assertEquals(out.map((p) => p.id), ["d", "g", "c", "e", "a", "f", "i", "b", "h"]);
  assertEquals(out.map((p) => p.region), ["台北市", "台北市", "桃園市", "台南市", "基隆市", "基隆市", "基隆市", "新竹市", "宜蘭縣"]);
});

Deno.test("listByCountyBallot：臺／台寫法同一個縣市；不在縣市名單上的排最後", () => {
  const out = listByCountyBallot([mayorIn("x", "外", "火星市", 1), mayorIn("a", "甲", "臺南市", 1), mayorIn("b", "乙", "台北市", 1)], TAIWAN_COUNTIES);
  assertEquals(out.map((p) => p.id), ["b", "a", "x"]);
});

Deno.test("listByCountyBallot：議員同縣市內先選舉區（固定順序）再號次", () => {
  const c = (id: string, sub: string, no: number) =>
    ({ id, name: id, region: "新竹縣", subRegion: sub, candNo: no, electionType: "縣市議員" });
  const out = listByCountyBallot([c("p", "第02選舉區", 1), c("q", "第01選舉區", 2), c("r", "第01選舉區", 1), c("s", "第10選舉區", 1)], TAIWAN_COUNTIES);
  assertEquals(out.map((p) => p.id), ["r", "q", "p", "s"]);
});

Deno.test("listByCountyBallot：沒有號次的排該縣市組尾，依姓名筆畫（王 < 張）", () => {
  const out = listByCountyBallot([
    mayorIn("n1", "張無", "台北市", undefined, { candidacyStatus: "withdrawn" }),
    mayorIn("n2", "王無", "台北市", undefined, { candidacyStatus: "withdrawn" }),
    mayorIn("a", "甲", "台北市", 2), mayorIn("b", "乙", "台北市", 1), mayorIn("c", "丙", "基隆市", 1),
  ], TAIWAN_COUNTIES);
  assertEquals(out.map((p) => p.id), ["b", "a", "n2", "n1", "c"]);
});

Deno.test("listByCountyBallot：非村里長的人帶著別場留下的 village，也照同選區內的號次排（不先比 village）", () => {
  const rep = (id: string, candNo: number, village?: string) =>
    ({ id, name: id, region: "桃園市", subRegion: "復興區第01選舉區", candNo, electionType: "直轄市山地原住民區民代表", village });
  // 2022 當過村里長的人物物件會帶 village；2026 這場他們的號次是 7、1，不可因此排到最後
  const list = [rep("n2", 2), rep("n3", 3), rep("v7", 7, "高義里"), rep("n4", 4), rep("v1", 1, "三民里"), rep("n5", 5)];
  assertEquals(listByCountyBallot(list, TAIWAN_COUNTIES).map((p) => p.candNo), [1, 2, 3, 4, 5, 7]);
});

Deno.test("listByCountyBallot：村里長同選區（鄉鎮）內仍先依村里再號次", () => {
  const chief = (id: string, candNo: number, village: string) =>
    ({ id, name: id, region: "桃園市", subRegion: "復興區", candNo, electionType: "村里長", village });
  const out = listByCountyBallot([chief("a", 2, "高義里"), chief("b", 1, "高義里"), chief("c", 1, "三民里")], TAIWAN_COUNTIES);
  assertEquals(out.map((p) => p.village), ["三民里", "高義里", "高義里"]);
  assertEquals(out.filter((p) => p.village === "高義里").map((p) => p.candNo), [1, 2]);
});
