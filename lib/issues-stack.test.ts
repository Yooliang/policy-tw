import { assertEquals } from "jsr:@std/assert@1";
import { appendCards, hasMore, type IssueCard, levelCounts, mapPageRows, mapSummaryRows, normRegion, pageKey, summaryKey } from "./issues-stack.ts";

const card = (id: string, extra: Partial<IssueCard> = {}): IssueCard => ({
  policyId: id, title: id, category: null, proposedDate: null, lineageId: null, level: "議員", politicianId: "p", name: "n", position: null, candNo: null, avatarUrl: null, party: null, ...extra,
});

Deno.test("mapSummaryRows：整理資料庫回傳，丟掉壞列，層級小計只留有筆數的", () => {
  const rows = mapSummaryRows([
    { issue: "交通", total: 6, by_level: { "縣市長": 1, "議員": 4, "鄉鎮市區長": 1, "怪層級": 9 }, samples: ["a", 5, "b"] },
    { issue: "", total: 3, by_level: {} },
    { issue: "零", total: 0, by_level: {} },
    { issue: "長照", total: "1", by_level: { "村里長": 1 } },
  ]);
  assertEquals(rows.map((r) => r.issue), ["交通", "長照"]);
  assertEquals(rows[0].byLevel, { "縣市長": 1, "議員": 4, "鄉鎮市區長": 1 });
  assertEquals(rows[0].samples, ["a", "b"]);
  assertEquals(rows[1].total, 1);
  assertEquals(mapSummaryRows(null), []);
});

Deno.test("levelCounts：由上到下、沒筆數的不列", () => {
  assertEquals(levelCounts({ byLevel: { "村里長": 2, "縣市長": 1 } }), [{ level: "縣市長", count: 1 }, { level: "村里長", count: 2 }]);
  assertEquals(levelCounts({ byLevel: {} }), []);
});

Deno.test("mapPageRows：欄位對應、total 取每列相同的總數、壞列丟掉", () => {
  const { cards, total } = mapPageRows([
    { policy_id: "a", politician_id: "p1", level: "縣市長", title: "T", name: "王", position_title: "市長", cand_no: 3, avatar_url: "u", party: "國民黨", total: 12, proposed_date: "2026-06-01", lineage_id: null, category: "交通" },
    { policy_id: "b", politician_id: "p2", level: "不存在", total: 12 },
    { policy_id: "c", politician_id: "p3", level: "議員", total: 12, cand_no: null },
  ]);
  assertEquals(total, 12);
  assertEquals(cards.map((c) => c.policyId), ["a", "c"]);
  assertEquals(cards[0], { policyId: "a", politicianId: "p1", level: "縣市長", title: "T", category: "交通", proposedDate: "2026-06-01", lineageId: null, name: "王", position: "市長", candNo: 3, avatarUrl: "u", party: "國民黨" });
  assertEquals(mapPageRows(undefined), { cards: [], total: 0 });
});

Deno.test("appendCards：接下一頁、重複的不再加；hasMore 看已載入與總數", () => {
  const a = [card("1"), card("2")];
  assertEquals(appendCards(a, [card("2"), card("3")]).map((c) => c.policyId), ["1", "2", "3"]);
  assertEquals(hasMore(30, 31), true);
  assertEquals(hasMore(31, 31), false);
  assertEquals(hasMore(0, 0), false);
});

Deno.test("快取鍵：臺／台視為同一個縣市；層級與位移分開", () => {
  assertEquals(normRegion("臺北市"), "台北市");
  assertEquals(summaryKey(2026, "臺北市"), summaryKey(2026, "台北市"));
  const base = pageKey(2026, "高雄市", "交通", null, 0);
  assertEquals(base === pageKey(2026, "高雄市", "交通", "議員", 0), false);
  assertEquals(base === pageKey(2026, "高雄市", "交通", null, 30), false);
});
