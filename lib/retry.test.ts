/// <reference lib="deno.ns" />
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isClientError, withTimeoutAndRetry } from "./retry.ts";

Deno.test("isClientError：SQLSTATE 與 PGRST 請求錯誤算客戶端錯誤；沒 code、PGRST0xx、AbortError 不算", () => {
  assertEquals(isClientError({ code: "22P02", message: "invalid input syntax for type uuid" }), true);
  assertEquals(isClientError({ code: "42501", message: "permission denied" }), true);
  assertEquals(isClientError({ code: "PGRST116", message: "no rows" }), true);
  assertEquals(isClientError({ code: "PGRST001", message: "could not connect" }), false);
  assertEquals(isClientError({ code: "", message: "Gateway Timeout" }), false);
  assertEquals(isClientError(new DOMException("timed out", "TimeoutError")), false);
  assertEquals(isClientError(new TypeError("Failed to fetch")), false);
  assertEquals(isClientError(null), false);
});

Deno.test("客戶端錯誤不重試，直接丟出", async () => {
  let calls = 0;
  await assertRejects(
    () => withTimeoutAndRetry("x", async () => { calls++; throw { code: "22P02", message: "bad uuid" }; }, { delaysMs: [0, 0], timeoutMs: 1000 }),
  );
  assertEquals(calls, 1);
});

const noDelay = { delaysMs: [0, 0], timeoutMs: 1000 };

Deno.test("成功就直接回傳，不重試", async () => {
  let calls = 0;
  const v = await withTimeoutAndRetry("x", async () => { calls++; return 42; }, noDelay);
  assertEquals(v, 42);
  assertEquals(calls, 1);
});

Deno.test("暫時性失敗會重試，第三次成功就回傳", async () => {
  let calls = 0;
  const v = await withTimeoutAndRetry("x", async () => {
    calls++;
    if (calls < 3) throw new Error("Gateway Timeout");
    return "ok";
  }, noDelay);
  assertEquals(v, "ok");
  assertEquals(calls, 3);
});

Deno.test("連續失敗超過次數就丟出最後一個錯誤", async () => {
  let calls = 0;
  await assertRejects(
    () => withTimeoutAndRetry("x", async () => { calls++; throw new Error(`fail ${calls}`); }, noDelay),
    Error,
    "fail 3",
  );
  assertEquals(calls, 3);
});

Deno.test("單次請求超過 timeout 會被 signal 中止，然後重試", async () => {
  let calls = 0;
  const v = await withTimeoutAndRetry("x", (signal) => new Promise<string>((resolve, reject) => {
    calls++;
    if (calls === 1) {
      signal.addEventListener("abort", () => reject(signal.reason));
      return;
    }
    resolve("second");
  }), { delaysMs: [0], timeoutMs: 20 });
  assertEquals(v, "second");
  assertEquals(calls, 2);
});
