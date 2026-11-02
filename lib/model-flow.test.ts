import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { buildContribFlow, buildVoteFlow, parseDimOrder, nodeText, linkText, selectionStats, selNodeText, CONTRIB_DIMS, type FlowRow } from "./model-flow.ts";

const outSum = (g: { links: { source: string; value: number }[] }, id: string) =>
  g.links.filter((l) => l.source === id).reduce((a, l) => a + l.value, 0);

const perms = <T,>(a: T[]): T[][] => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));

const ROWS: FlowRow[] = [
  { layer: "contrib", model: "大", key1: "x", key2: "applied", key3: null, n: 600 },
  { layer: "contrib", model: "大", key1: "y", key2: "rejected", key3: "data", n: 150 },
  { layer: "contrib", model: "大", key1: "x", key2: "rejected", key3: "timeout", n: 100 },
  { layer: "contrib", model: "大", key1: "y", key2: "pending", key3: null, n: 150 },
  { layer: "contrib", model: "小", key1: "x", key2: "applied", key3: null, n: 3 },
  { layer: "contrib", model: "小", key1: "y", key2: "rejected", key3: "score", n: 1 },
];

Deno.test("交件分流：任意維度順序，每一層之間的總流量都是 100 × 模型數；模型在第一層時各模型出流量＝100", () => {
  for (const order of perms(["model", "type", "result", "reason"])) {
    const g = buildContribFlow(ROWS, order);
    for (let i = 0; i < order.length - 1; i++) {
      const sum = g.links.filter((l) => l.source.startsWith(order[i] + ":") && l.target.startsWith(order[i + 1] + ":")).reduce((a, l) => a + l.value, 0);
      assertAlmostEquals(sum, 200, 1e-6, order.join());
    }
    if (order[0] === "model") {
      assertAlmostEquals(outSum(g, "model:大"), 100);
      assertAlmostEquals(outSum(g, "model:小"), 100);
    }
  }
});

Deno.test("交件分流：非退件的路徑在退件原因層歸到「非退件」，不亂掛原因", () => {
  const g = buildContribFlow(ROWS, ["model", "result", "reason", "type"]);
  assertEquals(g.nodes.find((n) => n.id === "reason:none")?.label, "非退件");
  const fromApplied = g.links.filter((l) => l.source === "result:applied").map((l) => l.target);
  assertEquals(fromApplied, ["reason:none"]);
  const toTimeout = g.links.find((l) => l.source === "result:rejected" && l.target === "reason:timeout")!;
  assertEquals(toTimeout.raw, 100);
});

Deno.test("交件分流：退件原因放在結果前面也走得通", () => {
  const g = buildContribFlow(ROWS, ["model", "reason", "result", "type"]);
  const l = g.links.find((k) => k.source === "reason:data" && k.target === "result:rejected")!;
  assertAlmostEquals(l.value, 150 / 1000 * 100);
});

Deno.test("投票分流：任意順序，每一層之間的總流量都是 100 × 模型數", () => {
  const rows: FlowRow[] = [
    { layer: "vote", model: "a", key1: "agree", key2: "right", n: 90 },
    { layer: "vote", model: "a", key1: "disagree", key2: "wrong", n: 10 },
    { layer: "vote", model: "a", key1: "unsure", key2: "none", n: 5 },
    { layer: "vote", model: "b", key1: "agree", key2: "right", n: 2 },
  ];
  for (const order of perms(["model", "verdict", "outcome"])) {
    const g = buildVoteFlow(rows, order);
    for (let i = 0; i < order.length - 1; i++) {
      const sum = g.links.filter((l) => l.source.startsWith(order[i] + ":") && l.target.startsWith(order[i + 1] + ":")).reduce((a, l) => a + l.value, 0);
      assertAlmostEquals(sum, 200, 1e-6, order.join());
    }
  }
  const g = buildVoteFlow(rows, ["model", "verdict", "outcome"]);
  const right = g.links.find((l) => l.source === "verdict:agree" && l.target === "outcome:right")!;
  assertAlmostEquals(right.value, 90 / 105 * 100 + 100);
  assertEquals(right.raw, 92);
});

Deno.test("維度順序網址：只收完整排列，其餘退回預設", () => {
  const def = ["model", "result", "reason", "type"];
  assertEquals(parseDimOrder("type,model,result,reason", CONTRIB_DIMS, def), ["type", "model", "result", "reason"]);
  assertEquals(parseDimOrder("type,model", CONTRIB_DIMS, def), def);
  assertEquals(parseDimOrder("model,model,result,reason", CONTRIB_DIMS, def), def);
  assertEquals(parseDimOrder("a,b,c,d", CONTRIB_DIMS, def), def);
  assertEquals(parseDimOrder(undefined, CONTRIB_DIMS, def), def);
});

Deno.test("標籤：比例模式只有百分比，沒有件數也沒有「僅 N 件」；數量模式才有件數", () => {
  const n = { label: "投錯", raw: 3, share: 18 };
  assertEquals(nodeText("pct", n), "投錯 18.0%");
  assertEquals(nodeText("pct", { ...n, raw: 500 }), "投錯 18.0%");
  assertEquals(nodeText("pct", { label: "模型甲", raw: 3, share: 100, hideShare: true }), "模型甲");
  assertEquals(linkText("pct", { from: "甲", to: "乙", raw: 18, share: 18 }), "甲 → 乙：18.0%");
  for (const t of [nodeText("pct", n), linkText("pct", { from: "甲", to: "乙", raw: 18, share: 18 })]) assertEquals(/件/.test(t), false);
  assertEquals(nodeText("count", n), "投錯（僅 3 件）");
  assertEquals(nodeText("count", { ...n, raw: 18 }), "投錯（18 件）");
});

Deno.test("選中某模型：各層節點的條件佔比各加總 100；沒經過的節點為 0；任意維度順序", () => {
  for (const order of perms(["model", "type", "result", "reason"])) {
    const g = buildContribFlow(ROWS, order);
    const st = selectionStats(g, "model:小");
    for (const dim of order) {
      const sum = g.nodes.filter((n) => n.id.startsWith(dim + ":")).reduce((a, n) => a + st.get(n.id)!.share, 0);
      assertAlmostEquals(sum, 100, 1e-6, order.join());
    }
    assertEquals(st.get("model:大")!.share, 0);
    assertEquals(st.get("model:大")!.raw, 0);
    assertEquals(st.get("result:pending")!.share, 0); // 小模型沒有等票中
    assertEquals(st.get("result:pending")!.raw, 0);
    assertAlmostEquals(st.get("result:applied")!.share, 75, 1e-6); // 3 / 4
    assertEquals(st.get("result:applied")!.raw, 3);
  }
});

Deno.test("選中結果節點：子集合只含退件路徑，模型佔比以件數權重重新彙總", () => {
  const g = buildContribFlow(ROWS, ["model", "result", "reason", "type"]);
  const st = selectionStats(g, "result:rejected");
  assertAlmostEquals(st.get("model:大")!.share + st.get("model:小")!.share, 100, 1e-6);
  assertEquals(st.get("result:applied")!.share, 0);
  assertEquals(st.get("reason:none")!.raw, 0);
  assertEquals(st.get("reason:data")!.raw, 150);
});

Deno.test("投票分流：選中節點同樣可重新彙總", () => {
  const V: FlowRow[] = [
    { layer: "vote", model: "甲", key1: "agree", key2: "right", n: 8 },
    { layer: "vote", model: "甲", key1: "disagree", key2: "wrong", n: 2 },
    { layer: "vote", model: "乙", key1: "agree", key2: "wrong", n: 5 },
  ];
  for (const order of perms(["model", "verdict", "outcome"])) {
    const g = buildVoteFlow(V, order);
    const st = selectionStats(g, "model:甲");
    assertEquals(st.get("model:乙")!.raw, 0);
    assertEquals(st.get("outcome:right")!.raw, 8);
    assertAlmostEquals(st.get("verdict:agree")!.share, 80, 1e-6);
  }
});

Deno.test("selNodeText：比例模式帶全體對照、數量模式只顯示子集件數", () => {
  assertEquals(selNodeText("pct", { label: "上線", raw: 1, share: 91.2, allShare: 84.6 }), "上線 91.2%（全體 84.6%）");
  assertEquals(selNodeText("pct", { label: "上線", raw: 1, share: 91.2, allShare: 84.6, withAll: false }), "上線 91.2%");
  assertEquals(selNodeText("count", { label: "退件", raw: 0, share: 0, allShare: 5 }), "退件（0 件）");
});
