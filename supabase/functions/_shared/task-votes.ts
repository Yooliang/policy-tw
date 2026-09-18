/**
 * 任務清單上的票數條：每筆手動任務收到的貢獻，挑「最接近通過」的那一筆，回它的票數。
 *
 * 2026-09-15 看貢獻清單的票數條（「需 4 票，已有 0 票同意」）：「任務清單裡的記錄，也可以作這個出來吧」。
 *
 * 任務本身不被投票，被投票的是代理針對它交的貢獻：
 *   - 一般任務：contributions.task_id = 任務 id
 *   - 裁決任務：contribution_type=adjudication 且 payload.contribution_id = 任務 target.contribution_id
 *     （一份裁決本身也要 4 票同意才定案，見 consensus.ts 的 AGREE_THRESHOLDS.adjudication）
 */

import { requiredAgree } from "./consensus.ts";

export interface VoteContribution {
  id: string;
  contribution_type: string;
  payload: unknown;
  source_urls: string[] | null;
  status: string;
  agree_count: number;
  disagree_count: number;
  task_id: string | null;
}

export interface TaskVoteSummary {
  /** 收到幾筆貢獻（被退件的不算） */
  submissions: number;
  /** 最接近通過的那一筆；沒有進行中的就是 null */
  leading: {
    contribution_id: string;
    status: string;
    agree_count: number;
    disagree_count: number;
    required_agree: number;
    /** 裁決任務才有：uphold＝維持原貢獻、reject＝原貢獻有誤 */
    verdict: string | null;
  } | null;
}

const COUNTED = new Set(["pending", "verified", "disputed", "applied", "apply_failed"]);
const IN_PROGRESS = new Set(["pending", "verified", "disputed", "apply_failed"]);

interface TaskRef { task_id: string; task_type: string; target: unknown }

function adjudicatedIdOf(t: TaskRef): string | null {
  if (t.task_type !== "adjudicate") return null;
  const target = (t.target && typeof t.target === "object" ? t.target : {}) as Record<string, unknown>;
  return typeof target.contribution_id === "string" ? target.contribution_id : null;
}

function payloadField(payload: unknown, key: string): string | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return typeof p[key] === "string" ? p[key] as string : null;
}

/** 純函式：任務 × 貢獻 → 每筆任務的票數摘要。已上線的那筆優先當 leading（已經過了），否則取同意票比例最高的進行中那筆 */
export function summarizeTaskVotes(tasks: readonly TaskRef[], contributions: readonly VoteContribution[]): Map<string, TaskVoteSummary> {
  const out = new Map<string, TaskVoteSummary>();
  for (const t of tasks) {
    const originalId = adjudicatedIdOf(t);
    const mine = contributions.filter((c) =>
      COUNTED.has(c.status) &&
      (originalId
        ? c.contribution_type === "adjudication" && payloadField(c.payload, "contribution_id") === originalId
        : c.task_id === t.task_id)
    );
    const withNeed = mine.map((c) => ({ c, need: requiredAgree(c.contribution_type, c.payload, c.source_urls ?? []) }));
    const applied = withNeed.find(({ c }) => c.status === "applied");
    const inProgress = withNeed
      .filter(({ c }) => IN_PROGRESS.has(c.status))
      .sort((a, b) => b.c.agree_count / b.need - a.c.agree_count / a.need || a.c.disagree_count - b.c.disagree_count);
    const pick = applied ?? inProgress[0];
    out.set(t.task_id, {
      submissions: mine.length,
      leading: pick
        ? {
          contribution_id: pick.c.id,
          status: pick.c.status,
          agree_count: pick.c.agree_count,
          disagree_count: pick.c.disagree_count,
          required_agree: pick.need,
          verdict: originalId ? payloadField(pick.c.payload, "verdict") : null,
        }
        : null,
    });
  }
  return out;
}
