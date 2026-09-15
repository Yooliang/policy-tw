import { assert, assertEquals } from "jsr:@std/assert@1";
import { summarizeTaskVotes, type VoteContribution } from "./task-votes.ts";

const OFFICIAL = ["https://www.gov.taipei/news/1"];
const c = (over: Partial<VoteContribution>): VoteContribution => ({
  id: "c", contribution_type: "policy_progress", payload: {}, source_urls: OFFICIAL, status: "pending",
  agree_count: 0, disagree_count: 0, task_id: null, ...over,
});

Deno.test("任務票數：一般任務用 task_id 對貢獻，挑同意比例最高的進行中那筆；退件不算", () => {
  const tasks = [{ task_id: "t1", task_type: "progress_stale", target: { policy_id: "p1" } }];
  const s = summarizeTaskVotes(tasks, [
    c({ id: "a", task_id: "t1", agree_count: 0 }),
    c({ id: "b", task_id: "t1", agree_count: 1, disagree_count: 1 }),
    c({ id: "x", task_id: "t1", status: "rejected", agree_count: 9 }),
    c({ id: "other", task_id: "t2", agree_count: 2 }),
  ]).get("t1")!;
  assertEquals(s.submissions, 2, "退件與別的任務的貢獻不算");
  assertEquals(s.leading?.contribution_id, "b");
  assertEquals([s.leading?.agree_count, s.leading?.disagree_count], [1, 1]);
  assert((s.leading?.required_agree ?? 0) >= 2);
  assertEquals(s.leading?.verdict, null);
});

Deno.test("任務票數：已上線的那筆優先；沒有任何貢獻 → leading null", () => {
  const tasks = [{ task_id: "t1", task_type: "policy_missing", target: {} }, { task_id: "t0", task_type: "profile_gap", target: {} }];
  const m = summarizeTaskVotes(tasks, [c({ id: "p", task_id: "t1", agree_count: 1 }), c({ id: "ok", task_id: "t1", status: "applied", agree_count: 2 })]);
  assertEquals(m.get("t1")!.leading?.contribution_id, "ok");
  assertEquals(m.get("t0"), { submissions: 0, leading: null });
});

Deno.test("任務票數：裁決任務對 payload.contribution_id，需 4 票，帶出裁決結論", () => {
  const tasks = [{ task_id: "adj-1", task_type: "adjudicate", target: { contribution_id: "orig-1" } }];
  const s = summarizeTaskVotes(tasks, [
    c({ id: "j1", contribution_type: "adjudication", payload: { contribution_id: "orig-1", verdict: "reject" }, agree_count: 1, disagree_count: 0 }),
    c({ id: "j2", contribution_type: "adjudication", payload: { contribution_id: "orig-OTHER", verdict: "uphold" }, agree_count: 3 }),
    c({ id: "orig-1", contribution_type: "policy", task_id: "adj-1", agree_count: 2 }),
  ]).get("adj-1")!;
  assertEquals(s.submissions, 1, "只算裁決這一筆，不算原貢獻、也不算別件爭議的裁決");
  assertEquals(s.leading?.contribution_id, "j1");
  assertEquals(s.leading?.required_agree, 4);
  assertEquals(s.leading?.verdict, "reject");
});
