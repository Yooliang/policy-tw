import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isStatementTimeout, runCandNoCheck } from "./cand-no-check.ts";

const timeout = { code: "57014", message: "canceling statement due to statement timeout" };

Deno.test("isStatementTimeout：57014 與訊息都認，其他不認", () => {
  assertEquals(isStatementTimeout(timeout), true);
  assertEquals(isStatementTimeout({ message: "canceling statement due to statement timeout" }), true);
  assertEquals(isStatementTimeout({ code: "23505", message: "dup" }), false);
  assertEquals(isStatementTimeout(null), false);
});

Deno.test("runCandNoCheck：超時就減半重試，回報實際 limit 與重試次數", async () => {
  const seen: number[] = [];
  const r = await runCandNoCheck((n) => { seen.push(n); return Promise.resolve(n > 12 ? { data: null, error: timeout } : { data: { checked: n, flagged: 1 }, error: null }); }, 50);
  assertEquals(seen, [50, 25, 12]);
  assertEquals(r, { checked: 12, flagged: 1, limit_used: 12, retries: 2 });
});

Deno.test("runCandNoCheck：到下限 5 筆仍超時就丟錯；非超時錯誤不重試", async () => {
  const seen: number[] = [];
  await assertRejects(() => runCandNoCheck((n) => { seen.push(n); return Promise.resolve({ data: null, error: timeout }); }, 50), Error, "下限 5");
  assertEquals(seen, [50, 25, 12, 6, 5]);
  const other: number[] = [];
  await assertRejects(() => runCandNoCheck((n) => { other.push(n); return Promise.resolve({ data: null, error: { code: "42501", message: "denied" } }); }, 50), Error, "denied");
  assertEquals(other, [50]);
});
