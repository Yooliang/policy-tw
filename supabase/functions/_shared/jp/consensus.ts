/**
 * 日本站同儕驗證共識規則（no_change、task_suggestion、correction、election 四種貢獻）。
 *
 * 複製自 ../consensus.ts：AGREE_THRESHOLDS／riskLevel／requiredAgree／rejectFloor。
 * 保留的：系統票（Jev）調門檻——supported 門檻 −1（最少 1）、not_supported +1（effectiveRequiredAgree，同正見）。
 * 拿掉的（日本站沒有或本 PR 不做）：candidacy／election_results／merge_politician／removal／adjudication 等風險級別、
 * 來源等級矩陣（正見的矩陣其實全是同一個值，日本站直接用單一門檻）、中選會名冊逐位吻合（ROSTER_*／rosterMatched 那條）、
 * 系統票可投型別縮成日本站有的 correction（no_change／task_suggestion 在正見也不拿系統票）、
 * needsTwoIps／scoreStatus（計分由 SQL 觸發器做，TS 這邊不鏡像）。jp-system-one 本身（投系統票的端點）留給下一個 PR。
 *
 * 門檻要跟日本站 SQL 一致（policy_jp.contribution_required_agree／contribution_reject_floor，由另一份 migration 提供）：
 *   no_change／task_suggestion 目標 2，correction 目標 3；退件門檻 no_change／task_suggestion −2，其餘 −3。
 * election（查到的選舉日程，PR②）：SQL 的 contribution_required_agree 走 ELSE 的 normal，目標 3、退件 −3；
 *   system_vote_eligible 不收它（不拿 Jev 系統票，門檻不調）；不用兩個網段（contribution_needs_two_ips 沒列它）。TS 這邊不用多寫分支，由 consensus.test.ts 守著。
 * 純函式（不動資料）的守門規則（盲反對、罐頭備註、抄備註、同網站證據…）不複製，直接從正見的 consensus.ts 轉出，行為完全相同。
 */

export {
  BLIND_DISAGREE_NOTE,
  isBlindDisagree,
  isCopiedNote,
  isDuplicateVote,
  isRepeatedNote,
  isRubberStampAgree,
  isSelfVote,
  isValidAgentName,
  isValidAgentTool,
  sameSiteAsSubmitted,
  voteWeight,
  weightReason,
} from "../consensus.ts";

export type JpContributionType = "no_change" | "task_suggestion" | "correction" | "election";

/** light＝不動正式資料（無異動、提議任務）；normal＝更正、選舉日程（election） */
export type JpRiskLevel = "normal" | "light";

export const JP_AGREE_THRESHOLDS: Record<JpRiskLevel, number> = { normal: 3, light: 2 };

export function riskLevel(contributionType: string): JpRiskLevel {
  return contributionType === "task_suggestion" || contributionType === "no_change" ? "light" : "normal";
}

/** 這一筆需要幾分才通過（沒有系統票，沒有來源等級加減） */
export function requiredAgree(contributionType: string, _payload?: unknown, _sourceUrls: readonly string[] = []): number {
  return JP_AGREE_THRESHOLDS[riskLevel(contributionType)];
}

/** 退件門檻：分數 ≤ −這個數就退件；light 2、其餘 3（同正見 rejectFloor） */
export function rejectFloor(contributionType: string): number {
  return riskLevel(contributionType) === "light" ? 2 : 3;
}

// ---- 系統來源票（Jev）：同正見 SYSTEM_VOTE_ELIGIBLE_TYPES／effectiveRequiredAgree，拿掉名冊逐位吻合那條 ----
export const SYSTEM_VOTE_ELIGIBLE_TYPES = ["correction"] as const;
export type SystemVote = "supported" | "not_supported" | null;

export function systemVoteEligible(contributionType: string): boolean {
  return (SYSTEM_VOTE_ELIGIBLE_TYPES as readonly string[]).includes(contributionType);
}

/** supported → 門檻 −1，但最少 1；not_supported → 門檻 +1（多要一張人票，不算反對） */
export function effectiveRequiredAgree(required: number, systemVote: SystemVote): number {
  if (systemVote === "supported") return Math.max(1, required - 1);
  if (systemVote === "not_supported") return required + 1;
  return required;
}
