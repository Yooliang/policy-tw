import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { DEFAULT_MAX_PAGES, PAGE_SIZE, fetchAllPages, type PageResponse } from "./fetch-all-pages.ts";

/** 假的分頁查詢：給一份完整資料，照 from/to 切片回傳，並記下每次被要求的區間。 */
function fakeSource<T>(all: T[], calls: Array<[number, number]>) {
  return (from: number, to: number): Promise<PageResponse<T>> => {
    calls.push([from, to]);
    return Promise.resolve({ data: all.slice(from, to + 1), error: null });
  };
}

Deno.test("不滿一頁就停，只發一次查詢", async () => {
  const calls: Array<[number, number]> = [];
  const r = await fetchAllPages("t", fakeSource([1, 2, 3], calls), { pageSize: 10 });
  assertEquals(r.rows, [1, 2, 3]);
  assertEquals(r.pages, 1);
  assertEquals(r.truncated, false);
  assertEquals(calls, [[0, 9]]);
});

Deno.test("剛好滿一頁時會再撈一次拿到空頁才停——不然會以為撈完了", async () => {
  const calls: Array<[number, number]> = [];
  const r = await fetchAllPages("t", fakeSource([1, 2, 3], calls), { pageSize: 3 });
  assertEquals(r.rows, [1, 2, 3]);
  assertEquals(r.pages, 2);
  assertEquals(r.truncated, false);
  assertEquals(calls, [[0, 2], [3, 5]]);
});

Deno.test("跨多頁累加，順序照呼叫端給的排序串接", async () => {
  const all = Array.from({ length: 25 }, (_, i) => i);
  const calls: Array<[number, number]> = [];
  const r = await fetchAllPages("t", fakeSource(all, calls), { pageSize: 10 });
  assertEquals(r.rows, all);
  assertEquals(r.pages, 3);
  assertEquals(r.truncated, false);
  assertEquals(calls, [[0, 9], [10, 19], [20, 29]]);
});

// 這一題就是高雄市 2022 的縮小版：1769 列、一頁 1000，第二頁才拿到市長跟議員。
Deno.test("高雄市 2022 的形狀：1769 列要分兩頁撈完，第二頁拿到剩下的 769 列", async () => {
  const all = Array.from({ length: 1769 }, (_, i) => (i < 1609 ? "村里長" : "其他"));
  const calls: Array<[number, number]> = [];
  const r = await fetchAllPages("高雄市", fakeSource(all, calls), { pageSize: PAGE_SIZE });
  assertEquals(r.rows.length, 1769);
  assertEquals(r.rows.filter((t) => t === "其他").length, 160);
  assertEquals(r.truncated, false);
  assertEquals(calls, [[0, 999], [1000, 1999]]);
});

Deno.test("撈到 maxPages 還是滿頁 → truncated，不假裝撈完了", async () => {
  const all = Array.from({ length: 100 }, (_, i) => i);
  const calls: Array<[number, number]> = [];
  const r = await fetchAllPages("t", fakeSource(all, calls), { pageSize: 10, maxPages: 3 });
  assertEquals(r.rows, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  assertEquals(r.pages, 3);
  assertEquals(r.truncated, true);
  assertEquals(calls.length, 3);
});

Deno.test("最後一頁剛好把 maxPages 用完但不滿頁 → 不算 truncated", async () => {
  const all = Array.from({ length: 25 }, (_, i) => i);
  const r = await fetchAllPages("t", fakeSource(all, []), { pageSize: 10, maxPages: 3 });
  assertEquals(r.rows.length, 25);
  assertEquals(r.truncated, false);
});

Deno.test("查詢回錯誤就丟出，錯誤訊息帶得上 label——不要把失敗當成空名單", async () => {
  await assertRejects(
    () => fetchAllPages("高雄市候選人", () => Promise.resolve({ data: null, error: { message: "JWT expired" } })),
    Error,
    "高雄市候選人: JWT expired",
  );
});

Deno.test("第二頁才失敗也要丟出，不能回半份名單", async () => {
  let n = 0;
  await assertRejects(
    () =>
      fetchAllPages<number>("t", () => {
        n++;
        return Promise.resolve(n === 1 ? { data: [1, 2, 3], error: null } : { data: null, error: { message: "boom" } });
      }, { pageSize: 3 }),
    Error,
    "t: boom",
  );
  assertEquals(n, 2);
});

Deno.test("data 是 null 但沒有 error 時當成空頁，正常收尾", async () => {
  const r = await fetchAllPages<number>("t", () => Promise.resolve({ data: null, error: null }));
  assertEquals(r.rows, []);
  assertEquals(r.pages, 1);
  assertEquals(r.truncated, false);
});

Deno.test("pageSize／maxPages 不是正整數就 fail fast，不要回空名單加 truncated", async () => {
  const ok = () => Promise.resolve({ data: [], error: null });
  await assertRejects(() => fetchAllPages("t", ok, { pageSize: 0 }), Error, "pageSize 必須是正整數");
  await assertRejects(() => fetchAllPages("t", ok, { pageSize: -1 }), Error, "pageSize 必須是正整數");
  await assertRejects(() => fetchAllPages("t", ok, { pageSize: 1.5 }), Error, "pageSize 必須是正整數");
  await assertRejects(() => fetchAllPages("t", ok, { maxPages: 0 }), Error, "maxPages 必須是正整數");
  await assertRejects(() => fetchAllPages("t", ok, { maxPages: -3 }), Error, "maxPages 必須是正整數");
});

Deno.test("預設值：一頁 1000 列、最多 30 頁", async () => {
  const calls: Array<[number, number]> = [];
  await fetchAllPages("t", fakeSource([1], calls));
  assertEquals(calls, [[0, 999]]);
  assertEquals(PAGE_SIZE, 1000);
  assertEquals(DEFAULT_MAX_PAGES, 30);
});
