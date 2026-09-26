import { assertEquals } from "jsr:@std/assert@1";
import { handleContribute } from "./contribute-handler.ts";

// 2026-09-26：陳瑩有兩筆人物，政見只給姓名，過了驗證才在落庫時炸「同名不只一位」、重試到退件。交件時就擋。
function fake(politicians: unknown[]) {
  return {
    from(table: string) {
      const chain = {
        select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, is: () => chain, order: () => chain, limit: () => chain,
        insert: (rows: Array<{ payload_hash: string }>) => ({ select: () => ({ data: rows.map((r, i) => ({ id: `new-${i}`, payload_hash: r.payload_hash })), error: null }) }),
        delete: () => ({ in: () => ({ error: null }) }),
        then: (res: (v: { data: unknown; error: null; count: number }) => unknown) =>
          res({ data: table === "politicians" ? politicians : [], error: null, count: 0 }),
      };
      return chain;
    },
  };
}

const ITEM = {
  contribution_type: "policy",
  payload: { name: "陳瑩", title: "推動 AI 個性化學習支持", description: "在生生有平板基礎上善用 AI，為偏鄉學生提供個性化學習支持", election_id: 2026, category: "教育文化", status: "Campaign Pledge" },
  source_urls: ["https://news.ltn.com.tw/news/politics/breakingnews/1"],
  agent_name: "tester",
  agent_tool: "claude-code/sonnet",
};

Deno.test("政見只給姓名、同名不只一位：400 ambiguous_politician_name，附候選", async () => {
  const res = await handleContribute(fake([{ id: "a", region: "台東縣" }, { id: "b", region: "台東縣" }]), "https://x", ITEM, "ip");
  assertEquals(res.status, 400);
  assertEquals((res.body as { error: string }).error, "ambiguous_politician_name");
});

Deno.test("同名只有一位、或有帶 politician_id：照常收", async () => {
  const one = await handleContribute(fake([{ id: "a", region: "台東縣" }]), "https://x", ITEM, "ip");
  assertEquals(one.status !== 400 || (one.body as { error?: string }).error !== "ambiguous_politician_name", true);
  const withId = await handleContribute(fake([{ id: "a" }, { id: "b" }]), "https://x", { ...ITEM, payload: { ...ITEM.payload, politician_id: "8aa6ee40-231a-447a-a967-99bcf8b35d3f" } }, "ip");
  assertEquals((withId.body as { error?: string }).error !== "ambiguous_politician_name", true);
});
