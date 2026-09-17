import { assertEquals } from "jsr:@std/assert@1";
import { fetchAllRows } from "./fetch-all.ts";

/** 假的查詢建構器：照 range 切一份固定資料，模擬 PostgREST 一次最多回 1000 列 */
function fakeTable(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ i }));
  const calls: Array<[number, number]> = [];
  const build = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null });
  };
  return { build, calls };
}

// 2026-09-17：貢獻榜的驗證票合計剛好卡在 1000，之後投的票一張都不算分
Deno.test("超過 1000 列時要翻頁撈完，不是停在第一頁", async () => {
  const t = fakeTable(2300);
  const out = await fetchAllRows<{ i: number }>("t", t.build);
  assertEquals(out.length, 2300);
  assertEquals(t.calls.length, 3);
  assertEquals(out[2299].i, 2299);
});

Deno.test("不足一頁時只查一次；空表回空陣列", async () => {
  const t = fakeTable(120);
  assertEquals((await fetchAllRows("t", t.build)).length, 120);
  assertEquals(t.calls.length, 1);
  const empty = fakeTable(0);
  assertEquals((await fetchAllRows("t", empty.build)).length, 0);
});

Deno.test("查詢出錯要丟出來，不能默默回半份資料", async () => {
  let threw = false;
  try {
    await fetchAllRows("t", () => Promise.resolve({ data: null, error: { message: "boom" } }));
  } catch (e) {
    threw = String(e).includes("boom");
  }
  assertEquals(threw, true);
});
