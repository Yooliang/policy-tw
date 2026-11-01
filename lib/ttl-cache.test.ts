import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createTtlCache } from "./ttl-cache.ts";

Deno.test("時效內同一個鍵只載入一次，同時進行中的共用同一個 Promise", async () => {
  let t = 0, calls = 0;
  const c = createTtlCache<number>(1000, () => t);
  const load = () => { calls++; return Promise.resolve(calls); };
  const [a, b] = await Promise.all([c.get("k", load), c.get("k", load)]);
  assertEquals([a, b, calls], [1, 1, 1]);
  t = 999;
  assertEquals(await c.get("k", load), 1);
  assertEquals(calls, 1);
});

Deno.test("過了時效重新載入；不同鍵各自載入", async () => {
  let t = 0, calls = 0;
  const c = createTtlCache<number>(1000, () => t);
  const load = () => Promise.resolve(++calls);
  await c.get("k", load);
  t = 1000;
  assertEquals(await c.get("k", load), 2);
  assertEquals(await c.get("other", load), 3);
});

Deno.test("載入失敗不留：下次再試", async () => {
  const c = createTtlCache<number>(1000, () => 0);
  await assertRejects(() => c.get("k", () => Promise.reject(new Error("x"))));
  await Promise.resolve();
  assertEquals(c.size, 0);
  assertEquals(await c.get("k", () => Promise.resolve(7)), 7);
});
