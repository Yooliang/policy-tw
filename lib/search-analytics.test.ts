import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { createSearchTracker, sanitizeSearchTerm } from "./search-analytics.ts";

type Call = [string, Record<string, unknown>];

function setup() {
  const calls: Call[] = [];
  let next = 1;
  const timers = new Map<number, () => void>();
  const tracker = createSearchTracker({
    send: (n, p) => calls.push([n, p]),
    settleMs: 1500,
    setTimer: (fn) => { const id = next++; timers.set(id, fn); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  });
  const settle = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((f) => f()); };
  return { calls, tracker, settle, timers };
}

Deno.test("搜尋詞整理：壓空白、截 100 字、空的回 null", () => {
  assertEquals(sanitizeSearchTerm("  王   小明 "), "王 小明");
  assertEquals(sanitizeSearchTerm("   "), null);
  assertEquals(sanitizeSearchTerm("字".repeat(150))?.length, 100);
});

Deno.test("搜尋詞整理：像個資的不送", () => {
  assertStrictEquals(sanitizeSearchTerm("a@b.com"), null);
  assertStrictEquals(sanitizeSearchTerm("0912-345 678"), null);
  assertStrictEquals(sanitizeSearchTerm("A123456789"), null);
  assertEquals(sanitizeSearchTerm("2026 縣市長"), "2026 縣市長");
});

Deno.test("結果穩定後送一次，參數正確", () => {
  const { calls, tracker, settle } = setup();
  tracker.results("交通", 5);
  assertEquals(calls.length, 0);
  settle();
  assertEquals(calls, [["search", { search_term: "交通", results_count: 5 }]]);
});

Deno.test("連續打字只送最後一個詞", () => {
  const { calls, tracker, settle, timers } = setup();
  tracker.results("交", 9);
  tracker.results("交通", 5);
  tracker.results("交通局", 2);
  assertEquals(timers.size, 1);
  settle();
  assertEquals(calls.map((c) => c[1].search_term), ["交通局"]);
});

Deno.test("flush 立刻送；沒有待送的不送", () => {
  const { calls, tracker } = setup();
  tracker.flush();
  assertEquals(calls.length, 0);
  tracker.results("托育", 3);
  tracker.flush();
  assertEquals(calls.length, 1);
});

Deno.test("連續同一個詞不重複送，reset 後可再送", () => {
  const { calls, tracker, settle } = setup();
  tracker.results("托育", 3); settle();
  tracker.results("托育", 3); settle();
  assertEquals(calls.length, 1);
  tracker.reset();
  tracker.results("托育", 3); settle();
  assertEquals(calls.length, 2);
});

Deno.test("cancel 只清待送、保留去重", () => {
  const { calls, tracker, settle } = setup();
  tracker.results("托育", 3); settle();
  tracker.results("長照", 1);
  tracker.cancel();
  settle();
  assertEquals(calls.length, 1);
  tracker.results("托育", 3); settle();
  assertEquals(calls.length, 1);
});

Deno.test("沒有結果也送，results_count 為 0", () => {
  const { calls, tracker, settle } = setup();
  tracker.results("查無此人", 0); settle();
  assertEquals(calls[0][1], { search_term: "查無此人", results_count: 0 });
});

Deno.test("個資詞不送，也會取消前一個待送", () => {
  const { calls, tracker, settle } = setup();
  tracker.results("王", 3);
  tracker.results("a@b.com", 0);
  settle();
  tracker.results("0912345678", 0); settle();
  assertEquals(calls.length, 0);
});

Deno.test("沒有 gtag 時不丟錯；有 gtag 時照呼叫", () => {
  const g = globalThis as unknown as { gtag?: unknown };
  const saved = g.gtag;
  try {
    delete g.gtag;
    const t = createSearchTracker();
    t.results("交通", 1);
    t.flush();
    const got: unknown[][] = [];
    g.gtag = (...a: unknown[]) => got.push(a);
    t.reset();
    t.results("交通", 1);
    t.flush();
    assertEquals(got, [["event", "search", { search_term: "交通", results_count: 1 }]]);
    g.gtag = () => { throw new Error("boom"); };
    t.reset();
    t.results("x", 1);
    t.flush();
  } finally {
    g.gtag = saved;
  }
});
