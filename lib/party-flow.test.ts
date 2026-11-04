/**
 * 政黨分流圖（policy-ops#193）：分組、篩選、鑽取與網址參數。
 * 核心不變量：政黨層、縣市層的人數合計永遠等於篩選後的列數合計；鄉鎮層只多出「展開縣市裡有鄉鎮的選舉」。
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  buildPartyFlow, countyOrder, filterRows, NO_PARTY, parseQuery, parseRows, partyOrder, sumRows, toggle, toQuery,
  type PartyFlowRow,
} from "./party-flow.ts";

const R = (p: string, c: string, t: string, e: string, n: number): PartyFlowRow => ({ p, c, t, e, n });
const ROWS: PartyFlowRow[] = [
  R("民主進步黨", "台北市", "", "縣市長", 1),
  R("民主進步黨", "台北市", "", "縣市議員", 10),
  R("民主進步黨", "台北市", "大安區", "村里長", 4),
  R("中國國民黨", "台北市", "大安區", "村里長", 5),
  R("中國國民黨", "台北市", "信義區", "村里長", 3),
  R("中國國民黨", "新北市", "板橋區", "鄉鎮市民代表", 7),
  R(NO_PARTY, "新北市", "板橋區", "村里長", 20),
  R(NO_PARTY, "台南市", "", "縣市議員", 2),
];

Deno.test("parseRows：臺→台、丟掉型別不對與非正整數", () => {
  const rows = parseRows([
    { p: "臺灣人民共產黨", c: "臺北市", t: "", e: "縣市長", n: 1 },
    { p: "x", c: "台北市", t: "", e: "縣市長", n: 0 },
    { p: "x", c: "台北市", t: "", e: "縣市長", n: 1.5 },
    { p: 1, c: "台北市", e: "縣市長", n: 1 },
    null,
  ]);
  assertEquals(rows, [{ p: "台灣人民共產黨", c: "台北市", t: "", e: "縣市長", n: 1 }]);
  assertEquals(parseRows("nope"), []);
});

Deno.test("partyOrder：筆畫順序、無黨籍最後、不併其他", () => {
  const order = partyOrder(ROWS);
  assertEquals(order.at(-1), NO_PARTY);
  assertEquals(order.length, 3);
  assertEquals(order.slice(0, 2), ["中國國民黨", "民主進步黨"].sort((a, b) => new Intl.Collator("zh-Hant-TW").compare(a, b)));
});

Deno.test("countyOrder：六都在前、其餘照縣市選擇器", () => {
  assertEquals(countyOrder(ROWS), ["台北市", "新北市", "台南市"]);
});

Deno.test("預設圖只有政黨與縣市，兩層合計＝名冊筆數", () => {
  const g = buildPartyFlow(ROWS);
  assertEquals(g.total, sumRows(ROWS));
  assertEquals(g.layerTotals, { party: 52, county: 52, town: 0 });
  assertEquals(g.nodes.some((n) => n.id.startsWith("t:")), false);
  const out = g.links.filter((l) => l.source.startsWith("p:")).reduce((a, l) => a + l.raw, 0);
  assertEquals(out, 52);
});

Deno.test("鑽取：展開台北市多出大安區、信義區；沒有鄉鎮的選舉只算到縣市", () => {
  const g = buildPartyFlow(ROWS, ["台北市"]);
  const towns = g.links.filter((l) => l.source === "c:台北市").map((l) => [l.target, l.raw]);
  assertEquals(towns, [["t:台北市/大安區", 9], ["t:台北市/信義區", 3]]);
  // 台北市共 1+10+4+5+3＝23，其中有鄉鎮的 12；縣市長與議員 11 不往下畫
  assertEquals(g.layerTotals.town, 12);
  assertEquals(g.layerTotals.county, 52);
  // 沒展開的縣市不出鄉鎮
  assertEquals(g.nodes.some((n) => n.id === "t:新北市/板橋區"), false);
});

Deno.test("鑽取：不同縣市同名鄉鎮是不同節點", () => {
  const rows = [R("甲黨", "台北市", "中山區", "村里長", 1), R("甲黨", "新北市", "中山區", "村里長", 2)];
  const g = buildPartyFlow(rows, ["台北市", "新北市"]);
  assertEquals(g.nodes.filter((n) => n.label === "中山區").length, 2);
});

Deno.test("篩選後各層合計仍等於篩選後的列數合計", () => {
  const f = filterRows(ROWS, { types: ["村里長"], parties: [] });
  assertEquals(sumRows(f), 32);
  const g = buildPartyFlow(f, ["新北市"]);
  assertEquals(g.layerTotals, { party: 32, county: 32, town: 20 });
  const f2 = filterRows(ROWS, { types: [], parties: ["中國國民黨"] });
  assertEquals(buildPartyFlow(f2).total, 15);
  assertEquals(filterRows(ROWS, { types: [], parties: [] }).length, ROWS.length);
});

Deno.test("篩到沒有資料：圖是空的、合計 0", () => {
  const g = buildPartyFlow(filterRows(ROWS, { types: ["縣市長"], parties: ["中國國民黨"] }));
  assertEquals(g.nodes.length, 0);
  assertEquals(g.total, 0);
});

Deno.test("網址參數來回、丟掉不認得的值、臺→台", () => {
  const known = { types: ["縣市長", "村里長"], parties: ["中國國民黨"], counties: ["台北市"] };
  const q = parseQuery({ type: "縣市長,亂寫,縣市長", party: "中國國民黨", open: "臺北市,火星" }, known);
  assertEquals(q, { types: ["縣市長"], parties: ["中國國民黨"], open: ["台北市"] });
  assertEquals(toQuery(q), { type: "縣市長", party: "中國國民黨", open: "台北市" });
});

Deno.test("預設選舉別：沒帶參數＝縣市長＋縣市議員，網址不帶；type=all 才是全部類別", () => {
  assertEquals(parseQuery({}), { types: ["縣市長", "縣市議員"], parties: [], open: [] });
  assertEquals(toQuery({ types: ["縣市議員", "縣市長"], parties: [], open: [] }), {});
  assertEquals(parseQuery({ type: "all" }).types, []);
  assertEquals(toQuery({ types: [], parties: [], open: [] }), { type: "all" });
  // 來回一次狀態不變
  assertEquals(parseQuery(toQuery({ types: [], parties: [], open: [] })).types, []);
  assertEquals(parseQuery(toQuery({ types: ["村里長"], parties: [], open: [] })).types, ["村里長"]);
  // 頁面載入後用空字串核對：已選全部時不能被改回預設
  assertEquals(parseQuery({ type: "" }, { types: ["縣市長"] }).types, []);
});

Deno.test("toggle：加入、移除、保持順序", () => {
  assertEquals(toggle(["a", "b"], "c"), ["a", "b", "c"]);
  assertEquals(toggle(["a", "b", "c"], "b"), ["a", "c"]);
});
