/**
 * 同儕驗證共識規則（第一版：匿名、權重一律 1、沒有信譽分級）。
 * 門檻同時寫在 migration 20260912000002 的 contribution_apply_consensus()，改一邊要改另一邊；
 * skill.md 也寫出同樣的數字（skill.md 是唯一協議文件，沒有 skill.json）。
 */

export const VOTE_WEIGHT = 1;
/** 一般型別：agree ≥ 2 且 disagree = 0 → verified */
export const VERIFIED_MIN_AGREE = 2;
/** 高風險（加減參選人）：candidacy 任何狀態、correction 改 candidate_status → agree ≥ 6 */
export const HIGH_RISK_MIN_AGREE = 6;
export const VERIFIED_MAX_DISAGREE = 0;

/** 依型別／欄位決定需要幾票同意（鏡射 SQL contribution_required_agree） */
export function requiredAgree(contributionType: string, payload: unknown): number {
  if (contributionType === "candidacy") return HIGH_RISK_MIN_AGREE;
  if (contributionType === "correction") {
    const field = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).field : undefined;
    if (field === "candidate_status") return HIGH_RISK_MIN_AGREE;
  }
  return VERIFIED_MIN_AGREE;
}
/** disagree ≥ 2 → disputed */
export const DISPUTED_MIN_DISAGREE = 2;
/** /verifications 的預設 limit（skill.md 的工作順序是驗證：任務約 3：1，不寫死上限） */
export const MAX_VERIFICATIONS_PER_RUN = 5;
/** 24 小時內同名／同機提交過的筆不能驗 */
export const SELF_VOTE_WINDOW_HOURS = 24;

export type Verdict = "agree" | "disagree" | "unsure";
export type PeerStatus = "pending" | "verified" | "disputed";

export interface VoteCounts {
  agree: number;
  disagree: number;
  unsure: number;
}

/** 只在 pending／verified／disputed 之間轉；approved／rejected／applied 由維護者決定、不受投票影響。 */
export function consensusStatus(counts: VoteCounts, current: string, minAgree: number = VERIFIED_MIN_AGREE): string {
  if (current !== "pending" && current !== "verified" && current !== "disputed") return current;
  if (counts.disagree >= DISPUTED_MIN_DISAGREE) return "disputed";
  if (counts.agree >= minAgree && counts.disagree <= VERIFIED_MAX_DISAGREE) return "verified";
  return "pending";
}

export function tally(votes: readonly { verdict: Verdict }[]): VoteCounts {
  return votes.reduce<VoteCounts>((acc, v) => ({ ...acc, [v.verdict]: acc[v.verdict] + VOTE_WEIGHT }), { agree: 0, disagree: 0, unsure: 0 });
}

export interface ContributionIdentity {
  agent_name: string;
  contributor_ip_hash: string;
}

export interface VoterIdentity {
  agent_name: string;
  ip_hash: string;
}

/** 不能驗自己提交的：agent_name 相同或 ip_hash 相同，任一命中就擋。 */
export function isSelfVote(contribution: ContributionIdentity, voter: VoterIdentity): boolean {
  return contribution.agent_name.toLowerCase() === voter.agent_name.toLowerCase() || contribution.contributor_ip_hash === voter.ip_hash;
}

/** 同一 contribution 同一 agent_name 只能投一次（DB 也有 unique）；同機不同名可以，但會被記下。 */
export function isDuplicateVote(existing: readonly { agent_name: string }[], voter: VoterIdentity): boolean {
  return existing.some((v) => v.agent_name.toLowerCase() === voter.agent_name.toLowerCase());
}

/** agent_name＝人的代號（GitHub 帳號、暱稱），2～64 字，字母數字與 ._-；不含模型名 */
export const AGENT_NAME_RE = /^[\p{L}\p{N}._-]{2,64}$/u;
/** agent_tool＝AI 自報的執行環境／模型（claude-code、gemini-cli、codex、gpt-4o…），選填、只做統計 */
export const AGENT_TOOL_RE = /^[\p{L}\p{N}@._\-/ ]{1,64}$/u;

export function isValidAgentName(v: unknown): v is string {
  return typeof v === "string" && AGENT_NAME_RE.test(v);
}

export function isValidAgentTool(v: unknown): v is string {
  return typeof v === "string" && AGENT_TOOL_RE.test(v.trim()) && v.trim().length > 0;
}
