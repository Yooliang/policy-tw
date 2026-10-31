import { assertEquals } from "jsr:@std/assert@1";
import { MOBILE_SECTION_TABS, sectionTabsFor } from "./mobile-section-tabs.ts";

Deno.test("路由對到頁籤：政見三頁，我的關注看 view=mine", () => {
  assertEquals(sectionTabsFor("/tracking", {})?.active, "tracking");
  assertEquals(sectionTabsFor("/tracking", { view: "mine" })?.active, "mine");
  assertEquals(sectionTabsFor("/analysis", {})?.active, "analysis");
  assertEquals(sectionTabsFor("/analysis", {})?.tabs.map((t) => t.to), ["/tracking", "/analysis", "/tracking?view=mine"]);
});

Deno.test("參與與搜尋兩組", () => {
  assertEquals(sectionTabsFor("/stats", {})?.tabs.map((t) => t.key), ["stats", "skill", "community"]);
  assertEquals(sectionTabsFor("/parties", {})?.tabs.map((t) => t.key), ["search", "elections", "politicians", "parties"]);
  assertEquals(sectionTabsFor("/search/", {})?.active, "search");
});

Deno.test("左右鄰頁：第一頁沒有左鄰、最後一頁沒有右鄰", () => {
  const first = sectionTabsFor("/tracking", {})!;
  const last = sectionTabsFor("/community", {})!;
  const i = (s: typeof first) => s.tabs.findIndex((t) => t.key === s.active);
  assertEquals(i(first), 0);
  assertEquals(i(last), last.tabs.length - 1);
  assertEquals(first.tabs[i(first) + 1]?.to, "/analysis");
  assertEquals(last.tabs[i(last) - 1]?.to, "/skill");
});

Deno.test("詳情頁與其他頁不顯示頁籤", () => {
  assertEquals(sectionTabsFor("/policy/abc", {}), null);
  assertEquals(sectionTabsFor("/politicians/x", {}), null);
  assertEquals(sectionTabsFor("/", {}), null);
  assertEquals(sectionTabsFor("/regional-data", {}), null);
});

Deno.test("每個頁籤自己的路由都回到同一組、自己是 active", () => {
  for (const g of MOBILE_SECTION_TABS) for (const t of g) {
    const [path, qs] = t.to.split("?");
    const r = sectionTabsFor(path, qs ? Object.fromEntries(new URLSearchParams(qs)) : {});
    assertEquals(r?.active, t.key);
    assertEquals(r?.tabs, g);
  }
});
