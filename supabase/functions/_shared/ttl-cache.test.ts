import { assertEquals } from "jsr:@std/assert@1";
import { createTtlCache } from "./ttl-cache.ts";
import {
  cachedPendingAdjudications,
  PENDING_ADJUDICATIONS_TTL_MS,
  resetPendingAdjudicationsCache,
} from "./pending-adjudications-cache.ts";

const TTL = 1000;
const ok = (n: number) => () => Promise.resolve({ data: n, error: null });

Deno.test("ttl-cache：TTL 內同鍵只打一次，不同鍵分開", async () => {
  const c = createTtlCache(TTL, "t");
  let calls = 0;
  const f = () => { calls++; return ok(calls)(); };
  await c.get("a", f, 0);
  const r = await c.get("a", f, TTL - 1);
  assertEquals(calls, 1);
  assertEquals(r.data, 1);
  await c.get("b", f, 0);
  assertEquals(calls, 2);
});

Deno.test("ttl-cache：過期後重打並換新值", async () => {
  const c = createTtlCache(TTL, "t");
  let calls = 0;
  const f = () => { calls++; return ok(calls)(); };
  await c.get("a", f, 0);
  const r = await c.get("a", f, TTL);
  assertEquals(calls, 2);
  assertEquals(r.data, 2);
});

Deno.test("ttl-cache：重打失敗沿用舊值並 warn；沒舊值回錯誤且不快取失敗", async () => {
  const c = createTtlCache(TTL, "t");
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const first = await c.get("x", () => Promise.resolve({ data: null, error: { message: "boom" } }), 0);
    assertEquals(first.error?.message, "boom");
    await c.get("a", ok(7), 0);
    const r1 = await c.get("a", () => Promise.resolve({ data: null, error: { message: "boom" } }), TTL);
    assertEquals(r1, { data: 7, error: null });
    const r2 = await c.get("a", () => Promise.reject(new Error("net")), TTL + 1);
    assertEquals(r2, { data: 7, error: null });
    assertEquals(warned, 2);
    let calls = 0;
    await c.get("x", () => { calls++; return ok(1)(); }, 1);
    assertEquals(calls, 1);
  } finally { console.warn = warn; }
});

Deno.test("ttl-cache：同時過期的請求共用進行中的查詢", async () => {
  const c = createTtlCache(TTL, "t");
  let calls = 0;
  const f = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { data: 1, error: null }; };
  await Promise.all([c.get("a", f, 0), c.get("a", f, 0), c.get("a", f, 0)]);
  assertEquals(calls, 1);
});

Deno.test("未定案裁決快取：TTL 內只翻一次、過期重翻、失敗沿用舊值、沒舊值丟例外", async () => {
  resetPendingAdjudicationsCache();
  const rows = (id: string) => [{ payload: { contribution_id: id } }];
  let calls = 0;
  const f = () => { calls++; return Promise.resolve(rows(`c${calls}`)); };
  const a = await cachedPendingAdjudications(f, 0);
  const b = await cachedPendingAdjudications(f, PENDING_ADJUDICATIONS_TTL_MS - 1);
  assertEquals(calls, 1);
  assertEquals(a, b);
  const c = await cachedPendingAdjudications(f, PENDING_ADJUDICATIONS_TTL_MS);
  assertEquals(calls, 2);
  assertEquals(c, rows("c2"));

  const warn = console.warn;
  console.warn = () => {};
  try {
    const stale = await cachedPendingAdjudications(() => Promise.reject(new Error("db down")), PENDING_ADJUDICATIONS_TTL_MS * 2);
    assertEquals(stale, rows("c2"));
    resetPendingAdjudicationsCache();
    let threw = "";
    try { await cachedPendingAdjudications(() => Promise.reject(new Error("db down")), 0); } catch (e) { threw = (e as Error).message; }
    assertEquals(threw, "db down");
  } finally { console.warn = warn; }
});
