import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { buildContribFlow, buildVoteFlow, type FlowRow } from "./model-flow.ts";

const outSum = (g: { links: { source: string; value: number }[] }, id: string) =>
  g.links.filter((l) => l.source === id).reduce((a, l) => a + l.value, 0);

Deno.test("交件分流：每個模型出流量加總＝100，量大小不影響", () => {
  const rows: FlowRow[] = [
    { layer: "contrib", model: "大", key1: "x", key2: "applied", n: 750 },
    { layer: "contrib", model: "大", key1: "y", key2: "rejected", n: 250 },
    { layer: "contrib", model: "小", key1: "x", key2: "applied", n: 3 },
    { layer: "contrib", model: "小", key1: "x", key2: "pending", n: 1 },
  ];
  const g = buildContribFlow(rows);
  assertAlmostEquals(outSum(g, "m:大"), 100);
  assertAlmostEquals(outSum(g, "m:小"), 100);
  const toApplied = g.links.find((l) => l.source === "t:x" && l.target === "r:applied")!;
  assertAlmostEquals(toApplied.value, 75 + 75); // 大 75%、小 75%
  assertEquals(toApplied.raw, 753);
});

Deno.test("交件分流：退件原因跟著模型正規化", () => {
  const rows: FlowRow[] = [
    { layer: "contrib", model: "a", key1: "x", key2: "rejected", n: 40 },
    { layer: "contrib", model: "a", key1: "x", key2: "applied", n: 60 },
    { layer: "reject", model: "a", key1: "data", key2: null, n: 40 },
  ];
  const g = buildContribFlow(rows);
  const l = g.links.find((k) => k.source === "r:rejected" && k.target === "x:data")!;
  assertAlmostEquals(l.value, 40);
  assertEquals(l.raw, 40);
});

Deno.test("投票分流：每個模型出流量加總＝100，投對投錯用同一比例", () => {
  const rows: FlowRow[] = [
    { layer: "vote", model: "a", key1: "agree", key2: "right", n: 90 },
    { layer: "vote", model: "a", key1: "disagree", key2: "wrong", n: 10 },
    { layer: "vote", model: "b", key1: "agree", key2: "right", n: 2 },
  ];
  const g = buildVoteFlow(rows);
  assertAlmostEquals(outSum(g, "m:a"), 100);
  assertAlmostEquals(outSum(g, "m:b"), 100);
  const right = g.links.find((l) => l.source === "d:agree" && l.target === "o:right")!;
  assertAlmostEquals(right.value, 190);
  assertEquals(right.raw, 92);
});
