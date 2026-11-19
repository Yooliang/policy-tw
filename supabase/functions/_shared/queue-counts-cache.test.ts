import { assertEquals } from "jsr:@std/assert@1";
import { cachedQueueCounts, QUEUE_COUNTS_TTL_MS, queueCountsKey, resetQueueCountsCache } from "./queue-counts-cache.ts";

const ok = (n: number) => () => Promise.resolve({ data: [{ task_type: "x", total: n }], error: null });

Deno.test("TTL 內同一個 region 只打一次", async () => {
  resetQueueCountsCache();
  let calls = 0;
  const f = () => { calls++; return ok(5)(); };
  const a = await cachedQueueCounts("TPE", f, 1000);
  const b = await cachedQueueCounts("TPE", f, 1000 + QUEUE_COUNTS_TTL_MS - 1);
  assertEquals(calls, 1);
  assertEquals(a.data, b.data);
});

Deno.test("null 與 undefined 都當 ALL；不同 region 分開快取", async () => {
  resetQueueCountsCache();
  assertEquals(queueCountsKey(null), "ALL");
  assertEquals(queueCountsKey(undefined), "ALL");
  let calls = 0;
  const f = () => { calls++; return ok(calls)(); };
  await cachedQueueCounts(null, f, 0);
  await cachedQueueCounts(undefined, f, 0);
  assertEquals(calls, 1);
  await cachedQueueCounts("TPE", f, 0);
  await cachedQueueCounts("KHH", f, 0);
  assertEquals(calls, 3);
});

Deno.test("過期後重打並換成新值", async () => {
  resetQueueCountsCache();
  let calls = 0;
  const f = () => { calls++; return ok(calls)(); };
  await cachedQueueCounts("TPE", f, 0);
  const r = await cachedQueueCounts("TPE", f, QUEUE_COUNTS_TTL_MS);
  assertEquals(calls, 2);
  assertEquals(r.data, [{ task_type: "x", total: 2 }]);
});

Deno.test("重打失敗（error 或例外）沿用舊值", async () => {
  resetQueueCountsCache();
  await cachedQueueCounts("TPE", ok(7), 0);
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const r1 = await cachedQueueCounts("TPE", () => Promise.resolve({ data: null, error: { message: "boom" } }), QUEUE_COUNTS_TTL_MS);
    assertEquals(r1.error, null);
    assertEquals(r1.data, [{ task_type: "x", total: 7 }]);
    const r2 = await cachedQueueCounts("TPE", () => Promise.reject(new Error("net")), QUEUE_COUNTS_TTL_MS + 1);
    assertEquals(r2.error, null);
    assertEquals(r2.data, [{ task_type: "x", total: 7 }]);
    assertEquals(warned, 2);
  } finally { console.warn = warn; }
});

Deno.test("沒有舊值時失敗照原樣回錯誤，且不快取失敗", async () => {
  resetQueueCountsCache();
  const r = await cachedQueueCounts("TPE", () => Promise.resolve({ data: null, error: { message: "boom" } }), 0);
  assertEquals(r.error?.message, "boom");
  let calls = 0;
  await cachedQueueCounts("TPE", () => { calls++; return ok(1)(); }, 1);
  assertEquals(calls, 1);
});

Deno.test("同時過期的請求共用同一個進行中查詢", async () => {
  resetQueueCountsCache();
  let calls = 0;
  const f = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { data: [], error: null }; };
  await Promise.all([cachedQueueCounts("TPE", f, 0), cachedQueueCounts("TPE", f, 0), cachedQueueCounts("TPE", f, 0)]);
  assertEquals(calls, 1);
});
