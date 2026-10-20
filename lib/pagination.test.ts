import { assertEquals } from "jsr:@std/assert@1";
import { clampPage, pageItems, slicePage, totalPagesOf } from "./pagination.ts";

Deno.test("totalPagesOf：空清單也是 1 頁，整除與不整除", () => {
  assertEquals(totalPagesOf(0, 60), 1);
  assertEquals(totalPagesOf(60, 60), 1);
  assertEquals(totalPagesOf(61, 60), 2);
  assertEquals(totalPagesOf(1200, 60), 20);
});

Deno.test("clampPage：壞值回 1、超過回最後一頁", () => {
  assertEquals(clampPage("3", 10), 3);
  assertEquals(clampPage("", 10), 1);
  assertEquals(clampPage("abc", 10), 1);
  assertEquals(clampPage("0", 10), 1);
  assertEquals(clampPage("-2", 10), 1);
  assertEquals(clampPage("2.5", 10), 1);
  assertEquals(clampPage("99", 10), 10);
  assertEquals(clampPage(undefined, 10), 1);
  assertEquals(clampPage(5, 0), 1);
});

Deno.test("slicePage：每頁切片、最後一頁不滿、超出夾回", () => {
  const items = Array.from({ length: 125 }, (_, i) => i);
  assertEquals(slicePage(items, 1, 60).length, 60);
  assertEquals(slicePage(items, 1, 60)[0], 0);
  assertEquals(slicePage(items, 2, 60)[0], 60);
  assertEquals(slicePage(items, 3, 60), items.slice(120));
  assertEquals(slicePage(items, 9, 60), items.slice(120));
  assertEquals(slicePage(items, 0, 60)[0], 0);
  assertEquals(slicePage([], 1, 60), []);
});

Deno.test("pageItems：頁數少全列、多時用省略號", () => {
  assertEquals(pageItems(1, 1), [1]);
  assertEquals(pageItems(2, 5), [1, 2, 3, 4, 5]);
  assertEquals(pageItems(1, 20), [1, 2, "gap", 20]);
  assertEquals(pageItems(2, 20), [1, 2, 3, "gap", 20]);
  assertEquals(pageItems(10, 20), [1, "gap", 9, 10, 11, "gap", 20]);
  assertEquals(pageItems(19, 20), [1, "gap", 18, 19, 20]);
  assertEquals(pageItems(20, 20), [1, "gap", 19, 20]);
  // 只隔一頁不放省略號
  assertEquals(pageItems(4, 20), [1, 2, 3, 4, 5, "gap", 20]);
  assertEquals(pageItems(99, 7), [1, "gap", 6, 7]);
});
