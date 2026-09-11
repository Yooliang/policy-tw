import { assert, assertEquals } from "jsr:@std/assert@1";
import { chooseKind, filterVerifyCandidates, pickBySeed } from "./dispatch.ts";

Deno.test("/next 比例輪替：3 驗 1 任、3 驗 1 任…", () => {
  const seq: string[] = [];
  const progress = { verifies_done: 0, tasks_done: 0 };
  for (let i = 0; i < 8; i++) {
    const k = chooseKind(10, progress);
    seq.push(k);
    if (k === "verify") progress.verifies_done++;
    else progress.tasks_done++;
  }
  assertEquals(seq, ["verify", "verify", "verify", "task", "verify", "verify", "verify", "task"]);
});

Deno.test("/next：total_pending=0 只派 task，即使驗證數為 0", () => {
  assertEquals(chooseKind(0, { verifies_done: 0, tasks_done: 0 }), "task");
  assertEquals(chooseKind(0, { verifies_done: 0, tasks_done: 5 }), "task");
});

Deno.test("/next 排除自己提交的（同名或同機）、已投過的、agree 已達門檻的", () => {
  const base = { contribution_type: "policy", payload: {} };
  const rows = [
    { ...base, id: "a", agent_name: "xiaoliang", contributor_ip_hash: "ip-1", agree_count: 0, status: "pending" },
    { ...base, id: "b", agent_name: "someone", contributor_ip_hash: "ip-1", agree_count: 0, status: "pending" },
    { ...base, id: "c", agent_name: "someone", contributor_ip_hash: "ip-2", agree_count: 0, status: "pending" },
    { ...base, id: "d", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 2, status: "pending" },
    { ...base, id: "e", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 0, status: "pending" },
    { ...base, id: "f", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 0, status: "verified" },
    // candidacy 門檻 6：2 票還要繼續派
    { id: "g", contribution_type: "candidacy", payload: { candidate_status: "registered" }, agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 2, status: "pending" },
    { id: "h", contribution_type: "candidacy", payload: { candidate_status: "registered" }, agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 6, status: "pending" },
  ];
  const me = { agent_name: "XiaoLiang", ip_hash: "ip-1", voted_ids: new Set(["e"]) };
  assertEquals(filterVerifyCandidates(rows, me).map((r) => r.id), ["c", "g"]);
});

Deno.test("pickBySeed：同 seed 同結果、不同 seed 會分散", () => {
  const list = ["a", "b", "c", "d", "e", "f", "g", "h"];
  assertEquals(pickBySeed(list, "agent-1"), pickBySeed(list, "agent-1"));
  const picks = new Set(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((s) => pickBySeed(list, s)));
  assert(picks.size > 1);
  assertEquals(pickBySeed([], "x"), null);
});
