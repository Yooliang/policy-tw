/**
 * GET /next 的派工決策（純函式，可測）。
 *
 * 比例：待驗證 > 0 時約 3 verify：1 task 輪替，用「該 agent_name 今天已做的驗證數／任務數」決定下一步
 *   → verify 當 verifies_done < (tasks_done + 1) * 3，否則 task。（3 驗、1 任、3 驗、1 任…）
 * 待驗證 = 0 時只派 task。
 * 派 verify 時排除：自己提交（agent_name 或 ip_hash 相同）、已投過、agree_count 已達門檻（不用再派）。
 * 隨機化：候選清單取最早的一批，再用 seed 隨機挑一筆，避免所有代理拿到同一筆。
 */

import { requiredAgree } from "./consensus.ts";

export const VERIFY_TASK_RATIO = 3;

export type NextKind = "verify" | "task" | "none";

export interface AgentProgress {
  verifies_done: number;
  tasks_done: number;
}

export function chooseKind(totalPending: number, progress: AgentProgress): NextKind {
  if (totalPending <= 0) return "task";
  return progress.verifies_done < (progress.tasks_done + 1) * VERIFY_TASK_RATIO ? "verify" : "task";
}

export interface VerifyCandidate {
  id: string;
  contribution_type: string;
  payload: unknown;
  agent_name: string;
  contributor_ip_hash: string;
  agree_count: number;
  status: string;
}

export interface Requester {
  agent_name: string;
  ip_hash: string;
  voted_ids: ReadonlySet<string>;
}

export function filterVerifyCandidates<T extends VerifyCandidate>(rows: readonly T[], me: Requester): T[] {
  const mine = me.agent_name.toLowerCase();
  return rows.filter((r) =>
    r.status === "pending" &&
    r.agent_name.toLowerCase() !== mine &&
    r.contributor_ip_hash !== me.ip_hash &&
    !me.voted_ids.has(r.id) &&
    r.agree_count < requiredAgree(r.contribution_type, r.payload)
  );
}

/** 軟認領：派出後幾分鐘內不派給其他代理 */
export const LEASE_MINUTES = 30;

export interface TaskLike {
  task_id: string;
  target?: unknown;
}

export interface LeaseLike {
  task_id: string;
  target_key: string;
  agent_name: string;
  leased_until: string;
}

/** 認領以目標為單位：politician_id 或 policy_id；沒有就用 task_id 本身 */
export function taskTargetKey(task: TaskLike): string {
  const t = (task.target && typeof task.target === "object" ? task.target : {}) as Record<string, unknown>;
  if (typeof t.policy_id === "string") return `policy:${t.policy_id}`;
  if (typeof t.politician_id === "string") return `politician:${t.politician_id}`;
  return `task:${task.task_id}`;
}

/** 排掉「別人」未過期的認領；自己認領中的可以再拿到（會延長） */
export function filterLeasedTasks<T extends TaskLike>(tasks: readonly T[], leases: readonly LeaseLike[], agentName: string, now: Date = new Date()): T[] {
  const mine = agentName.toLowerCase();
  const heldByOthers = new Set(
    leases.filter((l) => new Date(l.leased_until) > now && l.agent_name.toLowerCase() !== mine).map((l) => l.target_key),
  );
  return tasks.filter((t) => !heldByOthers.has(taskTargetKey(t)));
}

/** 確定性的偽隨機挑選：同 seed 同結果，不同代理（不同 seed）拿到不同筆。 */
export function pickBySeed<T>(list: readonly T[], seed: string): T | null {
  if (list.length === 0) return null;
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return list[h % list.length];
}
