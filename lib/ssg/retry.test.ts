/// <reference lib="deno.ns" />
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { FETCH_ATTEMPTS, RETRY_DELAY_MS, withRetry } from "./retry.ts";

const noWait = { sleep: () => Promise.resolve(), warn: () => {} };

Deno.test("建置端重試：第一次逾時、第二次成功，回第二次的結果", async () => {
  let calls = 0;
  const v = await withRetry("x", async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    return "ok";
  }, () => true, noWait);
  assertEquals(v, "ok");
  assertEquals(calls, 2);
});

Deno.test("建置端重試：沒丟錯但結果不完整（ok 回 false）也重試，用盡次數丟出『內容不完整』", async () => {
  let calls = 0;
  await assertRejects(
    () => withRetry("政見", async () => { calls++; return false; }, (r) => r, noWait),
    Error,
    "回傳的內容不完整",
  );
  assertEquals(calls, FETCH_ATTEMPTS);
});

Deno.test("建置端重試：用盡次數丟出最後一次的真正錯誤", async () => {
  let calls = 0;
  await assertRejects(
    () => withRetry("x", async () => { calls++; throw new Error(`boom ${calls}`); }, () => true, noWait),
    Error,
    `boom ${FETCH_ATTEMPTS}`,
  );
});

Deno.test("建置端重試：退避依序拉長，第一次不等", async () => {
  const waits: number[] = [];
  await assertRejects(() => withRetry("x", async () => { throw new Error("e"); }, () => true, {
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
    warn: () => {},
  }));
  assertEquals(waits, RETRY_DELAY_MS.slice(1, FETCH_ATTEMPTS));
  assert(waits.every((w, i) => i === 0 || w > waits[i - 1]), "退避要遞增");
  assert(waits[0] >= 5_000, "第一次退避至少 5 秒：DB 忙的時候 3 秒再撞沒有意義");
});

Deno.test("接線：預渲染載入政見等五塊時，看全域 error 與 policiesComplete 決定要不要重試（ensure* 失敗不丟錯）", async () => {
  const src = (await Deno.readTextFile(new URL("./server-data.ts", import.meta.url))).replace(/\r\n/g, "\n");
  const start = src.indexOf("'按需載入的五塊");
  assert(start > 0, "找不到五塊載入");
  const block = src.slice(start, src.indexOf("}, (ok) => ok)", start));
  assert(block.includes("loadError.value = null"), "每次嘗試前要清掉上一次的失敗標記");
  assert(block.includes("loadError.value === null && policiesComplete.value"), "成功判斷不能再是無條件 true");
  assert(!block.includes("return true"), "不得無條件回 true（2026-11-19 重試完全沒作用的原因）");
  assert(src.includes("from './retry'"), "要用 lib/ssg/retry.ts 的 withRetry");
});
