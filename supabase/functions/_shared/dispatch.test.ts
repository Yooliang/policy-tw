import { assert, assertEquals } from "jsr:@std/assert@1";
import { chooseKind, filterLeasedTasks, filterVerifyCandidates, pickBySeed, taskTargetKey } from "./dispatch.ts";

Deno.test("軟認領：別人 30 分鐘內領走的目標不派；自己的、過期的照派；同目標不同任務類型也算同一認領", () => {
  const now = new Date("2026-09-11T10:00:00Z");
  const tasks = [
    { task_id: "auto:policy_missing:P1", target: { politician_id: "P1" } },
    { task_id: "auto:profile_gap:P1", target: { politician_id: "P1" } },
    { task_id: "auto:policy_missing:P2", target: { politician_id: "P2" } },
    { task_id: "auto:progress_stale:X9", target: { policy_id: "X9", politician_id: "P3" } },
    { task_id: "manual-uuid", target: {} },
  ];
  const leases = [
    { task_id: "auto:policy_missing:P1", target_key: "politician:P1", agent_name: "other", leased_until: "2026-09-11T10:20:00Z" },
    { task_id: "auto:policy_missing:P2", target_key: "politician:P2", agent_name: "me", leased_until: "2026-09-11T10:20:00Z" },
    { task_id: "auto:progress_stale:X9", target_key: "policy:X9", agent_name: "other", leased_until: "2026-09-11T09:00:00Z" }, // 已過期
  ];
  assertEquals(taskTargetKey(tasks[3]), "policy:X9", "有 policy_id 以政見為單位");
  assertEquals(taskTargetKey(tasks[4]), "task:manual-uuid");
  const free = filterLeasedTasks(tasks, leases, "ME", now).map((t) => t.task_id);
  assertEquals(free, ["auto:policy_missing:P2", "auto:progress_stale:X9", "manual-uuid"]);
});

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
  const base = { contribution_type: "policy", payload: {}, source_urls: ["https://www.cna.com.tw/x"] }; // 媒體來源：門檻 2
  const rows = [
    { ...base, id: "a", agent_name: "xiaoliang", contributor_ip_hash: "ip-1", agree_count: 0, status: "pending" },
    { ...base, id: "b", agent_name: "someone", contributor_ip_hash: "ip-1", agree_count: 0, status: "pending" },
    { ...base, id: "c", agent_name: "someone", contributor_ip_hash: "ip-2", agree_count: 0, status: "pending" },
    { ...base, id: "d", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 2, status: "pending" },
    { ...base, id: "e", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 0, status: "pending" },
    { ...base, id: "f", agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 0, status: "verified" },
    // candidacy 媒體來源門檻 6：2 票還要繼續派
    { id: "g", contribution_type: "candidacy", payload: { candidate_status: "registered" }, source_urls: ["https://www.cna.com.tw/x"], agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 2, status: "pending" },
    { id: "h", contribution_type: "candidacy", payload: { candidate_status: "registered" }, source_urls: ["https://www.cna.com.tw/x"], agent_name: "other", contributor_ip_hash: "ip-3", agree_count: 6, status: "pending" },
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
