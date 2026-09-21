import { assertEquals } from "jsr:@std/assert";
import {
  autoTaskTier,
  manualTaskTier,
  pickQueuedManual,
  queueKeyBefore,
  TIER_ADJUDICATION,
  TIER_MAYOR_POLICY,
  TIER_MAYOR_PROFILE,
  TIER_REST,
  TIER_WEB_REQUEST,
} from "./dispatch.ts";

// 這組測試盯的是 2026-09-21 那個裁示：
//   「任務一建立它就是最快會被進行的，之後就照著流程走。」
// 以及它的邊界：不能為了做到這件事，讓 86 筆裁決排到 926 筆沒派過的自動缺口後面。

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

Deno.test("層級勝過時間：沒派過的低層仍排在派過的高層後面", () => {
  // 這條是重點。裁決（層 2）雖然全都派過了，仍然排在從沒派過的一般缺口（層 4）前面——
  // 不這樣的話，實測 926 筆沒派過的自動缺口會把 86 筆裁決壓好幾週。
  assertEquals(queueKeyBefore(
    { tier: TIER_ADJUDICATION, lastDispatchedAt: "2026-09-21T00:00:00Z" },
    { tier: TIER_REST, lastDispatchedAt: null },
  ), true);
});

Deno.test("完全相同不算在前面（避免比較器不穩定）", () => {
  assertEquals(queueKeyBefore(
    { tier: TIER_REST, lastDispatchedAt: null },
    { tier: TIER_REST, lastDispatchedAt: null },
  ), false);
});

Deno.test("手動任務的層級只認裁決與訪客觸發", () => {
  assertEquals(manualTaskTier("auto_dispute"), TIER_ADJUDICATION);
  assertEquals(manualTaskTier("web_request"), TIER_WEB_REQUEST);
  // 維護者建的與外部提議通過的，跟自動缺口平等——這就是「整個手動清單不再卡在最前面」
  assertEquals(manualTaskTier("manual"), TIER_REST);
  assertEquals(manualTaskTier("suggested"), TIER_REST);
  assertEquals(manualTaskTier(null), TIER_REST);
  assertEquals(manualTaskTier(undefined), TIER_REST);
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

Deno.test("pickQueuedManual：新建的維護者任務贏過派過的裁決嗎——不該贏", () => {
  const picked = pickQueuedManual([
    { source: "manual", last_dispatched_at: null },
    { source: "auto_dispute", last_dispatched_at: "2026-09-21T00:00:00Z" },
  ]);
  assertEquals(picked?.source, "auto_dispute");
});

Deno.test("pickQueuedManual：同層時新建的排最前", () => {
  const picked = pickQueuedManual([
    { source: "suggested", last_dispatched_at: "2026-09-20T00:00:00Z" },
    { source: "manual", last_dispatched_at: null },
    { source: "suggested", last_dispatched_at: "2026-09-19T00:00:00Z" },
  ]);
  assertEquals(picked?.last_dispatched_at, null);
});

Deno.test("pickQueuedManual：空清單回 null", () => {
  assertEquals(pickQueuedManual([]), null);
});
