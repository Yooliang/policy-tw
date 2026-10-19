/**
 * 參選地圖資料快取（lib/async-cache.ts）：同一個鍵第二次不再呼叫載入函式、進行中的共用、失敗不留、clear 才重抓。
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createAsyncCache } from "./async-cache.ts";
import { rowsKey } from "./map-data-cache.ts";

Deno.test("同一個鍵第二次不再呼叫載入函式（縮放來回、離開再回來都一樣）", async () => {
  const cache = createAsyncCache<number[]>();
  let calls = 0;
  const load = () => { calls += 1; return Promise.resolve([1, 2, 3]); };
  const a = await cache.get("town:", load);
  const b = await cache.get("town:", load);
  const c = await cache.get("town:", load);
  assertEquals(calls, 1);
  assert(a === b && b === c);
  await cache.get("village:63000010", load);
  assertEquals(calls, 2, "不同的鍵各載一次");
});

Deno.test("同時進行中的同一個請求共用同一個 Promise，不並發重複打", async () => {
  const cache = createAsyncCache<string>();
  let calls = 0;
  let release!: (v: string) => void;
  const load = () => { calls += 1; return new Promise<string>((r) => { release = r; }); };
  const p1 = cache.get("k", load);
  const p2 = cache.get("k", load);
  assert(p1 === p2);
  release("done");
  assertEquals([await p1, await p2], ["done", "done"]);
  assertEquals(calls, 1);
});

Deno.test("載入失敗的不留，下次會再試；成功之後就不再打", async () => {
  const cache = createAsyncCache<number>();
  let calls = 0;
  const flaky = () => { calls += 1; return calls === 1 ? Promise.reject(new Error("逾時")) : Promise.resolve(7); };
  await assertRejects(() => cache.get("k", flaky));
  assertEquals(await cache.get("k", flaky), 7);
  assertEquals(await cache.get("k", flaky), 7);
  assertEquals(calls, 2);
});

Deno.test("clear 之後才會重抓", async () => {
  const cache = createAsyncCache<number>();
  let calls = 0;
  const load = () => { calls += 1; return Promise.resolve(calls); };
  assertEquals(await cache.get("k", load), 1);
  cache.clear();
  assertEquals(cache.size, 0);
  assertEquals(await cache.get("k", load), 2);
});

Deno.test("rowsKey：屆別、層級、上層代碼都在鍵裡（換屆別不會拿到舊的）", () => {
  assert(rowsKey(2026, "town") !== rowsKey(2022, "town"));
  assert(rowsKey(2026, "village", "63000010") !== rowsKey(2026, "village", "63000020"));
  assert(rowsKey(2026, "county") !== rowsKey(2026, "town"));
  assertEquals(rowsKey(2026, "county"), rowsKey(2026, "county", undefined));
});
