/**
 * 政黨分流圖（policy-ops#193）：維度開關與排序、鑽取、缺值、各屆、網址參數。
 * 核心不變量：任何維度組合與順序下，每一欄的人數合計都等於篩選後的人數；相鄰兩欄之間的連線合計也等於總人數
 * （有鄉鎮的人多走一欄鄉鎮，沒有鄉鎮的人直接跳到下一欄）；缺值不會丟人。
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  ageLabel, availableDims, buildPartyFlow, countyOrder, defaultTypesFor, filterRows, FLOW_DIMS, MISSING, NO_PARTY, normalizeDims,
  parseQuery, parseRows, partyOrder, resolveTypes, sumRows, toggle, toQuery, typeOrder, type PartyFlowRow,
} from "./party-flow.ts";

const R = (p: string, c: string, t: string, e: string, a: number | null, g: string | null, r: string | null, n: number): PartyFlowRow => ({ p, c, t, e, a, g, r, n });
const ROWS: PartyFlowRow[] = [
  R("民主進步黨", "台北市", "", "縣市長", 50, "男", "當選", 1),
  R("民主進步黨", "台北市", "", "縣市議員", 40, "女", "當選", 10),
  R("民主進步黨", "台北市", "大安區", "村里長", 60, "男", "未當選", 4),
  R("中國國民黨", "台北市", "大安區", "村里長", 70, "女", "當選", 5),
  R("中國國民黨", "台北市", "信義區", "村里長", null, null, "當選", 3),
  R("中國國民黨", "新北市", "板橋區", "鄉鎮市民代表", 30, "男", "未當選", 7),
  R(NO_PARTY, "新北市", "板橋區", "村里長", 20, "女", "當選", 20),
  R(NO_PARTY, "台南市", "", "縣市議員", null, null, null, 2),
];
const TOTAL = 52;
const ALL_DIMS = FLOW_DIMS.map((d) => d.id);

function permutations<T>(xs: T[], k: number): T[][] {
  if (k === 0) return [[]];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)], k - 1).map((rest) => [x, ...rest]));
}

Deno.test("parseRows：臺→台、年齡組取整並封頂 70、性別只認男女、結果只認兩種、缺鍵為 null、丟掉非正整數人數", () => {
  const rows = parseRows([
    { p: "臺灣人民共產黨", c: "臺北市", t: "", e: "縣市長", a: 45, g: "男", r: "當選", n: 1 },
    { p: "x", c: "台北市", t: "", e: "縣市長", a: 85, g: "其他", r: "?", n: 2 },
    { p: "x", c: "台北市", t: "", e: "縣市長", n: 3 },
    { p: "x", c: "台北市", t: "", e: "縣市長", a: null, g: null, r: null, n: 0 },
    { p: "x", c: "台北市", t: "", e: "縣市長", n: 1.5 },
    { p: 1, c: "台北市", e: "縣市長", n: 1 },
    null,
  ]);
  assertEquals(rows, [
    { p: "台灣人民共產黨", c: "台北市", t: "", e: "縣市長", a: 40, g: "男", r: "當選", n: 1 },
    { p: "x", c: "台北市", t: "", e: "縣市長", a: 70, g: null, r: null, n: 2 },
    { p: "x", c: "台北市", t: "", e: "縣市長", a: null, g: null, r: null, n: 3 },
  ]);
  assertEquals(parseRows("nope"), []);
});

Deno.test("各維度的節點順序：政黨筆畫（無黨籍最後）、縣市全國在前、選舉別層級、年齡遞增、未提供最後", () => {
  const order = partyOrder(ROWS);
  assertEquals(order.at(-1), NO_PARTY);
  assertEquals(order.slice(0, 2), ["中國國民黨", "民主進步黨"].sort((a, b) => new Intl.Collator("zh-Hant-TW").compare(a, b)));
  assertEquals(countyOrder([...ROWS, R("甲黨", "全國", "", "總統副總統", 60, "男", "當選", 1)]), ["全國", "台北市", "新北市", "台南市"]);
  assertEquals(typeOrder([R("a", "全國", "", "立法委員", null, null, null, 1), R("a", "全國", "", "總統副總統", null, null, null, 1), R("a", "台北市", "", "縣市議員", null, null, null, 1), R("a", "台北市", "", "縣市長", null, null, null, 1)]),
    ["總統副總統", "立法委員", "縣市長", "縣市議員"]);
  const g = buildPartyFlow(ROWS, ["age", "gender"]);
  assertEquals(g.nodes.filter((n) => n.id.startsWith("age:")).map((n) => n.label), ["20～29 歲", "30～39 歲", "40～49 歲", "50～59 歲", "60～69 歲", "70 歲以上", MISSING]);
  assertEquals(g.nodes.filter((n) => n.id.startsWith("gender:")).map((n) => n.label), ["男", "女", MISSING]);
  assertEquals(ageLabel(70), "70 歲以上");
  assertEquals(ageLabel(40), "40～49 歲");
});

Deno.test("預設只畫政黨 → 縣市，兩欄合計＝人數", () => {
  const g = buildPartyFlow(ROWS);
  assertEquals(g.total, TOTAL);
  assertEquals(g.columns, [{ dim: "party", total: TOTAL }, { dim: "county", total: TOTAL }]);
  assertEquals(g.townTotal, 0);
  assertEquals(g.nodes.some((n) => n.id.startsWith("town:")), false);
});

Deno.test("任意維度組合與順序：每一欄合計＝人數，相鄰兩欄連線合計＝人數，連線都由左往右", () => {
  const combos = [...permutations(ALL_DIMS, 2), ...permutations(ALL_DIMS, 3), ...permutations(ALL_DIMS.slice(0, 4), 4)];
  for (const dims of combos) {
    const g = buildPartyFlow(ROWS, dims);
    assertEquals(g.columns.map((c) => c.dim), dims);
    for (const c of g.columns) assertEquals(c.total, TOTAL, `${dims.join(",")} 的 ${c.dim} 欄`);
    const col = new Map(g.nodes.map((n) => [n.id, n.col!]));
    for (let i = 0; i + 1 < dims.length; i++) {
      const between = g.links.filter((l) => col.get(l.source) === i && col.get(l.target) === i + 1).reduce((a, l) => a + l.raw, 0);
      assertEquals(between, TOTAL, `${dims.join(",")} 第 ${i} 到 ${i + 1} 欄`);
    }
    for (const l of g.links) assertEquals(col.get(l.source)! < col.get(l.target)!, true);
  }
});

Deno.test("缺值與非男女標「未提供」，不會丟人", () => {
  const g = buildPartyFlow(ROWS, ["gender", "age"]);
  const none = g.nodes.find((n) => n.id === "gender:none")!;
  assertEquals(none.label, MISSING);
  // 缺性別的人：中國國民黨信義區 3 ＋ 台南市無黨籍 2 ＝ 5
  assertEquals(g.links.filter((l) => l.source === "gender:none").reduce((a, l) => a + l.raw, 0), 5);
  assertEquals(g.columns.map((c) => c.total), [TOTAL, TOTAL]);
  // 結果缺值（還沒投票的屆別整層都是未提供）
  const allNull = ROWS.map((r) => ({ ...r, r: null }));
  assertEquals(availableDims(allNull).some((d) => d.id === "result"), false);
  const gr = buildPartyFlow(allNull, ["party", "result"]);
  assertEquals(gr.nodes.filter((n) => n.id.startsWith("result:")).map((n) => n.label), [MISSING]);
  assertEquals(gr.columns[1].total, TOTAL);
  assertEquals(availableDims(ROWS).some((d) => d.id === "result"), true);
});

Deno.test("鑽取：展開台北市，鄉鎮接在縣市後面；沒有鄉鎮的人直接跳到下一欄，縣市之後的維度右移一欄", () => {
  const g = buildPartyFlow(ROWS, ["party", "county", "age"], ["台北市"]);
  const col = new Map(g.nodes.map((n) => [n.id, n.col!]));
  assertEquals(col.get("party:民主進步黨"), 0);
  assertEquals(col.get("county:台北市"), 1);
  assertEquals(col.get("town:台北市/大安區"), 2);
  assertEquals(col.get("age:50"), 3);
  // 台北市共 1+10+4+5+3＝23，其中有鄉鎮的 12
  assertEquals(g.townTotal, 12);
  assertEquals(g.columns.map((c) => c.total), [TOTAL, TOTAL, TOTAL]);
  assertEquals(g.links.filter((l) => l.source === "county:台北市" && l.target.startsWith("town:")).map((l) => [l.target, l.raw]), [["town:台北市/大安區", 9], ["town:台北市/信義區", 3]]);
  // 沒有鄉鎮的縣市長、議員：縣市 → 年齡 直接相連（跳過鄉鎮欄）
  assertEquals(g.links.filter((l) => l.source === "county:台北市" && l.target.startsWith("age:")).reduce((a, l) => a + l.raw, 0), 11);
  // 鄉鎮 → 年齡 合計＝有鄉鎮的人
  assertEquals(g.links.filter((l) => l.source.startsWith("town:")).reduce((a, l) => a + l.raw, 0), 12);
  // 沒展開的縣市不出鄉鎮
  assertEquals(g.nodes.some((n) => n.id === "town:新北市/板橋區"), false);
});

Deno.test("縣市是最後一個維度：鄉鎮就是最後一欄；縣市沒開時 open 不生效", () => {
  const g = buildPartyFlow(ROWS, ["party", "county"], ["新北市"]);
  assertEquals(g.nodes.find((n) => n.id === "town:新北市/板橋區")!.col, 2);
  assertEquals(g.townTotal, 27);
  const off = buildPartyFlow(ROWS, ["party", "age"], ["新北市", "台北市"]);
  assertEquals(off.nodes.some((n) => n.id.startsWith("town:") || n.id.startsWith("county:")), false);
  assertEquals(off.townTotal, 0);
});

Deno.test("同名節點跨維度不混；不同縣市同名的鄉鎮是不同節點", () => {
  const rows = [
    R("台北市", "台北市", "中山區", "村里長", 40, "男", null, 1), // 政黨名剛好和縣市同名
    R("台北市", "新北市", "中山區", "村里長", 40, "男", null, 2),
  ];
  const g = buildPartyFlow(rows, ["party", "county"], ["台北市", "新北市"]);
  assertEquals(g.nodes.filter((n) => n.label === "台北市").map((n) => n.id).sort(), ["county:台北市", "party:台北市"]);
  assertEquals(g.nodes.filter((n) => n.label === "中山區").map((n) => n.id).sort(), ["town:台北市/中山區", "town:新北市/中山區"]);
  assertEquals(new Set(g.nodes.map((n) => n.id)).size, g.nodes.length);
});

Deno.test("篩選後各維度合計仍等於篩選後人數；預設選舉別因屆而異", () => {
  const f = filterRows(ROWS, { types: ["村里長"], parties: [] });
  assertEquals(sumRows(f), 32);
  const g = buildPartyFlow(f, ["type", "gender", "age"]);
  assertEquals(g.columns.map((c) => c.total), [32, 32, 32]);
  assertEquals(buildPartyFlow(filterRows(ROWS, { types: [], parties: ["中國國民黨"] })).total, 15);
  assertEquals(buildPartyFlow(filterRows(ROWS, { types: ["縣市長"], parties: ["中國國民黨"] })).nodes.length, 0);
  // 2022、2026 預設縣市長＋縣市議員；2024 沒有這兩類，視同全部
  assertEquals(defaultTypesFor(ROWS), ["縣市長", "縣市議員"]);
  const y2024 = [R("甲", "全國", "", "總統副總統", 60, "男", "當選", 1), R("乙", "台北市", "", "立法委員", null, null, "未當選", 3)];
  assertEquals(defaultTypesFor(y2024), []);
  assertEquals(resolveTypes(y2024, null), []);
  assertEquals(resolveTypes(ROWS, null), ["縣市長", "縣市議員"]);
  assertEquals(resolveTypes(ROWS, []), []);
  assertEquals(resolveTypes(ROWS, ["村里長"]), ["村里長"]);
});

Deno.test("網址：預設不寫、各參數來回、舊參數 type／party／open 繼續有效、維度不足兩個退回預設", () => {
  assertEquals(parseQuery({}), { election: 2026, types: null, parties: [], open: [], dims: ["party", "county"] });
  const known = { types: ["縣市長", "村里長"], parties: ["中國國民黨"], counties: ["台北市"], dims: ALL_DIMS };
  // 舊網址（沒有 election、dims）
  const old = parseQuery({ type: "縣市長,亂寫,縣市長", party: "中國國民黨", open: "臺北市,火星" }, known);
  assertEquals(old, { election: 2026, types: ["縣市長"], parties: ["中國國民黨"], open: ["台北市"], dims: ["party", "county"] });
  assertEquals(parseQuery({ type: "all" }).types, []);
  assertEquals(parseQuery({ election: "2024" }).election, 2024);
  assertEquals(parseQuery({ election: "1999" }).election, 2026);
  assertEquals(parseQuery({ dims: "age,gender,party" }).dims, ["age", "gender", "party"]);
  assertEquals(parseQuery({ dims: "age" }).dims, ["party", "county"], "少於兩個退回預設");
  assertEquals(parseQuery({ dims: "age,age,火星" }).dims, ["party", "county"]);
  assertEquals(parseQuery({ dims: "age,result,party" }, { dims: ["party", "age"] }).dims, ["age", "party"], "這屆沒有的維度丟掉");

  const base = { election: 2026, types: null, parties: [], open: [], dims: ["party", "county"] };
  assertEquals(toQuery(base), {});
  assertEquals(toQuery({ ...base, election: 2022, dims: ["county", "party", "age"], parties: ["中國國民黨"], open: ["台北市"] }),
    { election: "2022", dims: "county,party,age", party: "中國國民黨", open: "台北市" });
  assertEquals(toQuery({ ...base, types: [] }), { type: "all" });
  assertEquals(toQuery({ ...base, types: ["縣市長", "縣市議員"] }), {}, "跟預設相同就不寫");
  assertEquals(toQuery({ ...base, types: [] }, []), {}, "2024 的預設就是全部，不寫");
  assertEquals(toQuery({ ...base, types: ["立法委員"] }, []), { type: "立法委員" });
  assertEquals(toQuery({ ...base, open: ["台北市"], dims: ["party", "age"] }), { dims: "party,age" }, "縣市沒開時不寫 open");
  // 來回
  const q = toQuery({ election: 2024, types: ["立法委員"], parties: ["甲"], open: [], dims: ["gender", "party", "result"] }, []);
  assertEquals(parseQuery(q), { election: 2024, types: ["立法委員"], parties: ["甲"], open: [], dims: ["gender", "party", "result"] });
});

Deno.test("normalizeDims、toggle", () => {
  assertEquals(normalizeDims(["age", "party", "age", "亂寫"]), ["age", "party"]);
  assertEquals(normalizeDims(["age"]), ["party", "county"]);
  assertEquals(normalizeDims(["age", "result"], ["age", "party", "county"]), ["party", "county"], "只剩一個認得的就退回預設");
  assertEquals(toggle(["a", "b"], "c"), ["a", "b", "c"]);
  assertEquals(toggle(["a", "b", "c"], "b"), ["a", "c"]);
});
