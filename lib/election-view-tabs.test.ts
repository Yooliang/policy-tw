/**
 * 政見矩陣頁的四個檢視頁籤回選舉頁的連結：要跟選舉頁自己寫網址的規則一致
 * （預設的「候選人」不帶 view；縣市在路徑上；全台沒有縣市段）。
 */
import { assertEquals } from "jsr:@std/assert@1";
import { VIEW_MODES, VIEW_TABS, electionViewLink } from "./election-view-tabs.ts";

Deno.test("預設檢視不帶參數，其餘帶 ?view=", () => {
  assertEquals(electionViewLink("2026", "politicians"), { path: "/election/2026" });
  assertEquals(electionViewLink("2026", "pledges"), { path: "/election/2026", query: { view: "pledges" } });
  assertEquals(electionViewLink(2026, "comparison"), { path: "/election/2026", query: { view: "comparison" } });
});

Deno.test("有縣市就回縣市頁，全台或不認得的縣市回全台頁", () => {
  assertEquals(electionViewLink("2026", "pledges", "台南市"), { path: `/election/2026/${encodeURIComponent("台南市")}`, query: { view: "pledges" } });
  assertEquals(electionViewLink("2026", "politicians", "台南市"), { path: `/election/2026/${encodeURIComponent("台南市")}` });
  assertEquals(electionViewLink("2026", "issues", "All"), { path: "/election/2026", query: { view: "issues" } });
  assertEquals(electionViewLink("2026", "issues", ""), { path: "/election/2026", query: { view: "issues" } });
});

Deno.test("頁籤與網址參數合法值一一對應", () => {
  assertEquals(VIEW_TABS.map((t) => t.key), [...VIEW_MODES]);
});
