import { assert, assertEquals } from "jsr:@std/assert";
import { isManualTaskId, pickQueueTaskHead } from "./dispatch.ts";

// 這組測試盯的是 2026-09-21 的裁示：佇列只有一個時間軸（queue_at）。
//   「最前面就是最舊的，最舊的那一些會被最先領走。」
// 2026-10-08 起手動任務也是派工臂（manual_visitor／manual_open），queue_at 全部由排程算好寫進 task_dispatches，
// TS 不再自己算（以前的 manualQueueAt／QUEUE_FRONT 已移除）；排位的規則由 manual-open-arm.test.ts 的 PGlite 測試守。
// 這裡只守 TS 端「從排好序的清單挑隊頭」：自動缺口取第一筆、手動任務並列第一時用 seed 散開。

const auto = (id: string, queue_at: string) => ({ task_id: `auto:${id}`, queue_at });
const manual = (id: string, queue_at: string) => ({ task_id: id, queue_at });
const FRONT = "1970-01-01T00:00:00+00:00";

Deno.test("isManualTaskId：auto: 開頭是自動缺口、verify: 是驗證，其餘（任務 uuid）是手動任務", () => {
  assertEquals(isManualTaskId("auto:policy_missing:abc"), false);
  assertEquals(isManualTaskId("verify:123"), false);
  assertEquals(isManualTaskId("5b3c0a9e-7f65-4a0b-9d3e-0b6b3c1d2e4f"), true);
});

Deno.test("pickQueueTaskHead：空清單回 null", () => {
  assertEquals(pickQueueTaskHead([], "seed"), null);
});

Deno.test("pickQueueTaskHead：第一筆是自動缺口就取它（含同一刻並列的自動缺口——自動缺口的選法與以前一樣，不用 seed）", () => {
  const tasks = [auto("a", "1979-12-31T23:59:00+00:00"), auto("b", "1979-12-31T23:59:00+00:00"), manual("m1", FRONT)];
  for (const s of ["s1", "s2", "s3", "s4", "s5", "s6"]) assertEquals(pickQueueTaskHead(tasks, s)?.task_id, "auto:a");
});

Deno.test("pickQueueTaskHead：唯一的第一名不受 seed 影響", () => {
  const tasks = [manual("new", FRONT), manual("old1", "2026-09-20T00:00:00Z"), manual("old2", "2026-09-19T00:00:00Z")];
  for (const s of ["s1", "s2", "s3", "s4", "s5", "s6"]) assertEquals(pickQueueTaskHead(tasks, s)?.task_id, "new");
});

Deno.test("pickQueueTaskHead：手動任務並列第一（網站請求與公民提問都在 1970）用 seed 散開，且只在前 3 筆裡挑（防兩個代理撞同一筆）", () => {
  const tasks = ["a", "b", "c", "d", "e"].map((id) => manual(id, FRONT));
  const seen = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((s) => pickQueueTaskHead(tasks, s)?.task_id));
  assert(seen.size > 1, "並列要散開");
  for (const id of seen) assert(["a", "b", "c"].includes(id!), `只能從前 3 筆挑：${id}`);
});

Deno.test("pickQueueTaskHead：並列看的是時間點本身——+00:00 與 Z 寫法不同也算同一刻；不同刻的不算並列", () => {
  const same = [manual("x", "1970-01-01T00:00:00+00:00"), manual("y", "1970-01-01T00:00:00.000Z"), manual("z", "1970-01-01T00:00:00Z")];
  const seen = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((s) => pickQueueTaskHead(same, s)?.task_id));
  assert(seen.size > 1);
  const differ = [manual("first", "1970-01-01T00:00:00Z"), manual("second", "1970-01-01T00:00:01Z")];
  for (const s of ["s1", "s2", "s3", "s4"]) assertEquals(pickQueueTaskHead(differ, s)?.task_id, "first");
});

Deno.test("pickQueueTaskHead：並列只算手動任務——同一刻夾著自動缺口時，自動缺口不被 seed 挑走", () => {
  const tasks = [manual("m1", FRONT), manual("m2", FRONT), auto("a", FRONT)];
  const seen = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((s) => pickQueueTaskHead(tasks, s)?.task_id));
  assert(!seen.has("auto:a"));
});
