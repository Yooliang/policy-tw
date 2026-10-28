import { assert, assertEquals } from "jsr:@std/assert@1";
import { requestTaskDoneLabel, requestTaskMessage, type RequestTaskResult } from "./request-task-text.ts";

const base = { queue_position: 3, open_tasks: 9, board_url: "/tasks", message: "" };

Deno.test("requestTask 近期已查過：按鈕「近期已查過」，說明帶日期與結果，不提任務池", () => {
  const r: RequestTaskResult = { ...base, status: "recently_checked", checked_at: "2026-10-27T04:00:00Z", outcome: "no_change", window_days: 5 };
  assertEquals(requestTaskDoneLabel(r), "近期已查過");
  const m = requestTaskMessage(r);
  assert(m.includes("10/27"));
  assert(m.includes("查無新資料"));
  assert(m.includes("5 天內不重複查"));
  assert(!m.includes("任務池"));
});

Deno.test("requestTask 有人交了資料／任務已結束的說法不同；日期壞掉也不會壞", () => {
  assertEquals(requestTaskMessage({ ...base, status: "recently_checked", outcome: "updated" }), "已有人處理並交出資料，5 天內不重複查");
  assertEquals(requestTaskMessage({ ...base, status: "recently_checked", outcome: "closed", checked_at: "bad" }), "已處理完，5 天內不重複查");
});

Deno.test("requestTask 原本兩種狀態的字不變", () => {
  assertEquals(requestTaskDoneLabel({ ...base, status: "queued", task_id: "t" }), "已排入任務池");
  assertEquals(requestTaskDoneLabel({ ...base, status: "already_queued", task_id: "t" }), "已在任務池中");
  assert(requestTaskMessage({ ...base, status: "queued", task_id: "t" }).includes("已加入任務池"));
});
