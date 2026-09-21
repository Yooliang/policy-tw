import { assertEquals } from "jsr:@std/assert";
import { manualQueueAt, pickQueuedManual, QUEUE_FRONT } from "./dispatch.ts";

// 這組測試盯的是 2026-09-21 的裁示：佇列只有一個時間軸。
//   「最前面就是最舊的，最舊的那一些會被最先領走。」
//   「領完就走…輪了 900 次之後可能出現 300 筆上線的資料；可是你如果把一筆複雜的
//     任務卡在前面，900 筆過後可能只有 50 筆。」

Deno.test("有人明確要求的任務排最前：維護者建的、裁決、訪客按按鈕", () => {
  for (const source of ["manual", "auto_dispute", "web_request"]) {
    assertEquals(manualQueueAt({ source, created_at: "2026-09-21T00:00:00Z" }), QUEUE_FRONT, source);
  }
});

Deno.test("累積下來的待辦照進佇列的時間排，不插隊", () => {
  assertEquals(
    manualQueueAt({ source: "suggested", created_at: "2026-09-21T00:00:00Z" }),
    "2026-09-21T00:00:00Z",
  );
});

Deno.test("派出去之後回到隊尾——連裁決也一樣", () => {
  // 這條是整個設計的重點。裁決拿到的是「一次立刻被領走」，不是永久特權；
  // 不然它就會變成那筆「卡在前面的複雜任務」。
  assertEquals(
    manualQueueAt({ source: "auto_dispute", created_at: "2026-09-01T00:00:00Z", last_dispatched_at: "2026-09-21T10:00:00Z" }),
    "2026-09-21T10:00:00Z",
  );
});

Deno.test("1980 比任何真實時間都舊", () => {
  assertEquals(QUEUE_FRONT < "1990-01-01T00:00:00Z", true);
  assertEquals(QUEUE_FRONT < "2026-09-21T00:00:00Z", true);
});

Deno.test("pickQueuedManual：沒派過的裁決贏過派過的裁決", () => {
  const picked = pickQueuedManual([
    { source: "auto_dispute", created_at: "2026-09-01T00:00:00Z", last_dispatched_at: "2026-09-21T10:00:00Z", id: "派過" },
    { source: "auto_dispute", created_at: "2026-09-21T00:00:00Z", last_dispatched_at: null, id: "剛建立" },
  ], "seed");
  assertEquals(picked?.id, "剛建立");
});

Deno.test("pickQueuedManual：派過的裁決輸給還沒派過的一般提議", () => {
  // 覆蓋率優先：貴的工作做過一輪就該讓位
  const picked = pickQueuedManual([
    { source: "auto_dispute", created_at: "2026-09-01T00:00:00Z", last_dispatched_at: "2026-09-21T10:00:00Z", id: "裁決" },
    { source: "suggested", created_at: "2026-09-20T00:00:00Z", last_dispatched_at: null, id: "提議" },
  ], "seed");
  assertEquals(picked?.id, "提議");
});

Deno.test("pickQueuedManual：唯一的第一名不受 seed 影響", () => {
  const tasks = [
    { source: "manual", created_at: "2026-09-21T00:00:00Z", last_dispatched_at: null, id: "new" },
    { source: "suggested", created_at: "2026-09-20T00:00:00Z", last_dispatched_at: null, id: "old1" },
    { source: "suggested", created_at: "2026-09-19T00:00:00Z", last_dispatched_at: null, id: "old2" },
  ];
  for (const s of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
    assertEquals(pickQueuedManual(tasks, s)?.id, "new");
  }
});

Deno.test("pickQueuedManual：並列第一的才用 seed 散開（防兩個代理撞同一筆）", () => {
  const tasks = [
    { source: "manual", created_at: "2026-09-21T00:00:00Z", last_dispatched_at: null, id: "a" },
    { source: "manual", created_at: "2026-09-20T00:00:00Z", last_dispatched_at: null, id: "b" },
    { source: "auto_dispute", created_at: "2026-09-19T00:00:00Z", last_dispatched_at: null, id: "c" },
  ];
  const picked = new Set(["s1", "s2", "s3", "s4", "s5", "s6"].map((s) => pickQueuedManual(tasks, s)?.id));
  assertEquals(picked.size > 1, true);
});

Deno.test("pickQueuedManual：空清單回 null", () => {
  assertEquals(pickQueuedManual([], "seed"), null);
});
