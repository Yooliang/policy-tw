import { assertEquals } from "jsr:@std/assert";
import {
  autoTaskTier,
  manualTaskTier,
  pickQueuedManual,
  queueKeyBefore,
  TIER_MAYOR_POLICY,
  TIER_MAYOR_PROFILE,
  TIER_REST,
} from "./dispatch.ts";

// 這組測試盯的是 2026-09-21 的兩個裁示：
//   「任務一建立它就是最快會被進行的，之後就照著流程走。」
//   「我們要的是盡可能覆蓋任務數量，而不是把一個任務做到完成，
//     所以『領完就走』這件事情是優先的。」
// 第二條推翻了第一版給裁決與訪客觸發留層的做法——貴的工作不該卡在便宜的前面。

Deno.test("沒派過的排在派過的前面", () => {
  assertEquals(queueKeyBefore(
    { tier: TIER_REST, lastDispatchedAt: null },
    { tier: TIER_REST, lastDispatchedAt: "2026-09-21T00:00:00Z" },
  ), true);
  assertEquals(queueKeyBefore(
    { tier: TIER_REST, lastDispatchedAt: "2026-09-21T00:00:00Z" },
    { tier: TIER_REST, lastDispatchedAt: null },
  ), false);
});

Deno.test("同層比最久沒派", () => {
  assertEquals(queueKeyBefore(
    { tier: TIER_REST, lastDispatchedAt: "2026-09-20T00:00:00Z" },
    { tier: TIER_REST, lastDispatchedAt: "2026-09-21T00:00:00Z" },
  ), true);
});

Deno.test("層級勝過時間：縣市長就算剛派過，仍排在沒派過的一般缺口前面", () => {
  // 只剩使用者明確指定的那一層有這個特權。裁決沒有——它跟所有缺口一起輪。
  assertEquals(queueKeyBefore(
    { tier: TIER_MAYOR_PROFILE, lastDispatchedAt: "2026-09-21T00:00:00Z" },
    { tier: TIER_REST, lastDispatchedAt: null },
  ), true);
});

Deno.test("裁決不插隊：派過的裁決排在沒派過的缺口後面", () => {
  // 覆蓋率優先。裁決是最貴、最可能做不完的工作，讓它卡在 926 筆便宜的補資料前面，
  // 就是「900 輪只換到 50 筆上線資料」的成因。
  assertEquals(queueKeyBefore(
    { tier: manualTaskTier("auto_dispute"), lastDispatchedAt: "2026-09-21T00:00:00Z" },
    { tier: TIER_REST, lastDispatchedAt: null },
  ), false);
});

Deno.test("完全相同不算在前面（避免比較器不穩定）", () => {
  assertEquals(queueKeyBefore(
    { tier: TIER_REST, lastDispatchedAt: null },
    { tier: TIER_REST, lastDispatchedAt: null },
  ), false);
});

Deno.test("手動任務一律落在共同池，沒有任何 source 可以插隊", () => {
  for (const source of ["auto_dispute", "web_request", "manual", "suggested", null, undefined]) {
    assertEquals(manualTaskTier(source), TIER_REST, `${source} 不該有自己的層`);
  }
});

Deno.test("自動缺口只有縣市長那兩層有意義", () => {
  assertEquals(autoTaskTier(0), TIER_MAYOR_PROFILE);
  assertEquals(autoTaskTier(1), TIER_MAYOR_POLICY);
  assertEquals(autoTaskTier(9), TIER_REST);
  assertEquals(autoTaskTier(null), TIER_REST);
  assertEquals(autoTaskTier(undefined), TIER_REST);
  // RPC 回字串或別的東西時不要誤判成縣市長
  assertEquals(autoTaskTier("0"), TIER_REST);
});

Deno.test("pickQueuedManual：新建的維護者任務贏過派過的裁決", () => {
  // 第一版這條的期望是相反的（裁決贏）。覆蓋率優先之後改過來：沒派過的先派。
  const picked = pickQueuedManual([
    { source: "manual", last_dispatched_at: null },
    { source: "auto_dispute", last_dispatched_at: "2026-09-21T00:00:00Z" },
  ], "seed");
  assertEquals(picked?.source, "manual");
});

Deno.test("pickQueuedManual：同層時新建的排最前", () => {
  const picked = pickQueuedManual([
    { source: "suggested", last_dispatched_at: "2026-09-20T00:00:00Z" },
    { source: "manual", last_dispatched_at: null },
    { source: "suggested", last_dispatched_at: "2026-09-19T00:00:00Z" },
  ], "seed");
  assertEquals(picked?.last_dispatched_at, null);
});

Deno.test("pickQueuedManual：空清單回 null", () => {
  assertEquals(pickQueuedManual([], "seed"), null);
});

Deno.test("pickQueuedManual：並列第一的才用 seed 散開（防兩個代理撞同一筆）", () => {
  // 三筆都沒派過、同層＝並列第一，不同 seed 應該挑得到不只一筆
  const tasks = [
    { source: "manual", last_dispatched_at: null, id: "a" },
    { source: "manual", last_dispatched_at: null, id: "b" },
    { source: "manual", last_dispatched_at: null, id: "c" },
  ];
  const picked = new Set(["s1", "s2", "s3", "s4", "s5", "s6"].map((s) => pickQueuedManual(tasks, s)?.id));
  assertEquals(picked.size > 1, true);
});

Deno.test("pickQueuedManual：唯一的第一名不受 seed 影響", () => {
  // 這條是上一條的反面，也是裁示的本體：只有一筆剛建立時，它必須每次都被派出去
  const tasks = [
    { source: "manual", last_dispatched_at: null, id: "new" },
    { source: "manual", last_dispatched_at: "2026-09-20T00:00:00Z", id: "old1" },
    { source: "manual", last_dispatched_at: "2026-09-19T00:00:00Z", id: "old2" },
  ];
  for (const s of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
    assertEquals(pickQueuedManual(tasks, s)?.id, "new");
  }
});
