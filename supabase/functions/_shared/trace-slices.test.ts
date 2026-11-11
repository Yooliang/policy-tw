import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { collectWindow, newestFirstSlices, TtlCache, type TraceRow } from "./trace-slices.ts";

const T0 = Date.parse("2026-11-11T00:00:00Z");
const MIN = 60_000;

const row = (ms: number, kind = "vote", extra: Partial<TraceRow> = {}): TraceRow => ({
  at: new Date(ms).toISOString(), kind, task_id: "t", contribution_id: null, agent_name: `a${ms}`, detail: {}, ...extra,
});

/** 假資料庫：給一串事件時間，依 [since, until) 篩、由新到舊、最多 limit 筆 */
function fakeDb(times: number[], limit = 1000) {
  const calls: Array<[number, number]> = [];
  const fetch = (since: number, until: number): Promise<TraceRow[]> => {
    calls.push([since, until]);
    return Promise.resolve(times.filter((t) => t >= since && t < until).sort((a, b) => b - a).slice(0, limit).map((t) => row(t)));
  };
  return { fetch, calls };
}

Deno.test("newestFirstSlices：由新到舊、涵蓋整段、最後一段不超過終點", () => {
  assertEquals(newestFirstSlices(0, 10, 4), [[8, 10], [4, 8], [0, 4]]);
});

Deno.test("沒有回滿：每段只取一次，結果合併", async () => {
  const db = fakeDb([T0 + 5 * MIN, T0 + 40 * MIN, T0 + 70 * MIN]);
  const r = await collectWindow(db.fetch, T0, T0 + 2 * 60 * MIN, { step: 30 * MIN });
  assertEquals(r.rows.length, 3);
  assertEquals([r.truncated, r.partial], [false, false]);
  assertEquals(db.calls.length, 4);
  // 由新到舊依序取
  assertEquals(db.calls[0][0] > db.calls[3][0], true);
});

Deno.test("某一段回滿上限：自己對半再切，事件一筆都不漏、不重複", async () => {
  // 30 分鐘內 250 筆，單次上限 100
  const times = Array.from({ length: 250 }, (_, i) => T0 + i * 7000);
  const db = fakeDb(times, 100);
  const r = await collectWindow(db.fetch, T0, T0 + 30 * MIN, { step: 30 * MIN, limit: 100 });
  assertEquals(r.rows.length, 250);
  assertEquals(new Set(r.rows.map((x) => x.at)).size, 250);
  assertEquals([r.truncated, r.partial], [false, false]);
  assert(db.calls.length > 1, "有再切");
});

Deno.test("切到最小段還是回滿：標 truncated，不無限遞迴", async () => {
  const times = Array.from({ length: 300 }, (_, i) => T0 + 1000 + i); // 全擠在同一分鐘內
  const db = fakeDb(times, 100);
  const r = await collectWindow(db.fetch, T0, T0 + 30 * MIN, { step: 30 * MIN, limit: 100, minSpanMs: MIN });
  assertEquals(r.truncated, true);
  assert(r.rows.length >= 100);
  assert(db.calls.length < 200);
});

Deno.test("某一段失敗：標 partial、其餘照常；全部失敗才丟錯", async () => {
  const errors: number[] = [];
  const bad = (since: number, until: number): Promise<TraceRow[]> => {
    if (since === T0 + 30 * MIN) return Promise.reject(new Error("boom"));
    return Promise.resolve(since >= T0 && until <= T0 + 90 * MIN ? [row(since + 1000)] : []);
  };
  const r = await collectWindow(bad, T0, T0 + 90 * MIN, { step: 30 * MIN, onError: (_e, a) => errors.push(a) });
  assertEquals([r.partial, r.rows.length, errors.length], [true, 2, 1]);
  await assertRejects(() => collectWindow(() => Promise.reject(new Error("down")), T0, T0 + 60 * MIN, { step: 30 * MIN }));
});

Deno.test("TtlCache：期限內命中、過期失效、容量到上限擠掉最舊的", () => {
  const c = new TtlCache<number>(60_000, 2);
  c.set("a", 1, 0);
  assertEquals(c.get("a", 59_999), 1);
  assertEquals(c.get("a", 60_000), undefined);
  c.set("a", 1, 0); c.set("b", 2, 0); c.set("c", 3, 0);
  assertEquals([c.get("a", 1), c.get("b", 1), c.get("c", 1)], [undefined, 2, 3]);
});

// ---- 端點原始碼的守門：只准用 service_role 讀 trace_events、有 CORS、全站有快取、不亂開別的查詢 ----
Deno.test("trace 端點：只呼叫 trace_events、不直接讀任何表、有快取與 CORS、不驗 JWT", async () => {
  const src = (await Deno.readTextFile(new URL("../trace/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
  assert(!/\.from\(/.test(src), "端點不該直接讀表，只走 trace_events()");
  assertEquals([...src.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).every((n) => n === "trace_events"), true);
  assert(/TtlCache<[^>]*>\(60_000\)/.test(src), "全站快取 60 秒");
  assert(/"Access-Control-Allow-Origin": "\*"/.test(src));
  assert(/method !== "GET"/.test(src), "只收 GET");
  const cfg = (await Deno.readTextFile(new URL("../../config.toml", import.meta.url))).replace(/\r\n/g, "\n");
  assert(/\[functions\.trace\]\nenabled = true\n(?:#[^\n]*\n)?verify_jwt = false\nentrypoint = "\.\/functions\/trace\/index\.ts"/.test(cfg), "config.toml 要有 trace（verify_jwt = false）");
});
