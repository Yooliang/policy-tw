import { assertEquals } from "jsr:@std/assert@1";
import { blockedSingleAnswerIndexes, taskTypeOf } from "./single-answer-guard.ts";

const Q = "599276f1-bb90-4566-aa1b-46e274d24d20"; // 萬大捷運站那題的任務
const LI = "79f6848d-d6b4-4fb1-b6a6-cf2a8740f7a1"; // 補李四川的政見
const types = new Map([[Q, "question"], [LI, "policy_missing"]]);

Deno.test("任務型別：自動缺口從 id 解析，手動任務查表，查不到回 null", () => {
  assertEquals(taskTypeOf("auto:progress_stale:abc", types), "progress_stale");
  assertEquals(taskTypeOf(Q, types), "question");
  assertEquals(taskTypeOf("00000000-0000-0000-0000-000000000000", types), null);
});

Deno.test("單一答案型任務：同 IP 已有一份在排隊就擋；同批交兩份只收第一份", () => {
  // 萬大實況：同一個 IP 已經答過（排隊中），又來一份
  assertEquals([...blockedSingleAnswerIndexes([{ task_id: Q }], types, new Set([Q]))], [0]);
  // 同批兩份
  assertEquals([...blockedSingleAnswerIndexes([{ task_id: Q }, { task_id: Q }], types, new Set())], [1]);
  // 自動缺口的單一答案型也擋
  assertEquals([...blockedSingleAnswerIndexes([{ task_id: "auto:profile_gap:p1" }, { task_id: "auto:profile_gap:p1" }], types, new Set())], [1]);
});

Deno.test("多條型任務不擋：補政見一次交很多條、沒帶 task_id、查不到型別的都照收", () => {
  const nine = Array.from({ length: 9 }, () => ({ task_id: LI }));
  assertEquals(blockedSingleAnswerIndexes(nine, types, new Set([LI])).size, 0, "李四川那 9 條不同政見是正常的");
  assertEquals(blockedSingleAnswerIndexes([{ task_id: "auto:roster_check:2026:新竹市:縣市議員" }, { task_id: "auto:roster_check:2026:新竹市:縣市議員" }], types, new Set()).size, 0);
  assertEquals(blockedSingleAnswerIndexes([{}, { task_id: null }], types, new Set()).size, 0);
  assertEquals(blockedSingleAnswerIndexes([{ task_id: "unknown-uuid" }], types, new Set(["unknown-uuid"])).size, 0);
});
