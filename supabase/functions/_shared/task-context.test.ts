import { assert, assertEquals } from "jsr:@std/assert@1";
import { shapeTaskCurrent, shapeVerifyCurrent } from "./task-context.ts";

// 2026-09-17：只列已上線的政見害李四川被重複查——21 筆等票的沒被列出來，
// 代理看不到「居住新五箭」已經交過三次，於是交了第四次。
Deno.test("policy_missing 的現況要列出還在等票的提交", () => {
  const out = shapeTaskCurrent("policy_missing", {
    politician: { id: "p1", name: "李四川" },
    policies: [{ id: "x", title: "興建蘆洲醫院", category: "醫療衛生", status: "Campaign Pledge" }],
    policies_total: 10,
    queued_policies: [
      { id: "c1", agent_name: "a-zhen", payload: { title: "公布「居住新五箭」" } },
      { id: "c2", agent_name: "antigravity", payload: { title: "推動「居住新五箭」擴大社宅供給" } },
      { id: "c3", agent_name: "noise", payload: {} }, // 沒有標題的不列
    ],
  });
  const queued = out.queued_policies as Array<Record<string, unknown>>;
  assertEquals(queued.length, 2);
  assertEquals(queued[0].contribution_id, "c1");
  assertEquals(queued[0].agent_name, "a-zhen");
  assert(String(out.queued_policies_note).includes("2 筆"));
});

Deno.test("沒有等票的提交時不要硬塞提醒", () => {
  const out = shapeTaskCurrent("policy_missing", { politician: { id: "p1" }, policies: [] });
  assertEquals((out.queued_policies as unknown[]).length, 0);
  assertEquals(out.queued_policies_note, null);
});

// 2026-09-21 票數→分數：/next 把派工池的 score／target_score 傳進來才附 scoring，
// 缺一個（舊池子、或這個型別沒有分數概念）就不要印出半份分數騙代理。
Deno.test("shapeVerifyCurrent：score 與 target_score 都是數字才附 scoring 區塊", () => {
  const withScore = shapeVerifyCurrent("policy", { name: "陳素月", title: "托育" }, {
    politicians: [{ id: "p", name: "陳素月" }],
    score: 1,
    target_score: 3,
  });
  assertEquals(withScore.scoring, {
    target_score: 3,
    current_score: 1,
    your_vote_could_be: { max: 2, how: "找到另一個獨立來源並放進 evidence_url，系統核過就是 +2；只打開提交者的來源核對是 +1" },
  });

  const missingTarget = shapeVerifyCurrent("policy", { name: "陳素月" }, { politicians: [], score: 1 });
  assertEquals(missingTarget.scoring, undefined);

  const neither = shapeVerifyCurrent("policy", { name: "陳素月" }, { politicians: [] });
  assertEquals(neither.scoring, undefined);
});
