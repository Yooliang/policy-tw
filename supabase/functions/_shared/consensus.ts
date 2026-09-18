/**
 * 同儕驗證共識規則（第一版：匿名、權重一律 1、沒有信譽分級）。
 * 門檻與計票同時寫在 migration 20260912000013 的 contribution_required_agree()／contribution_apply_consensus()，改一邊要改另一邊；
 * skill.md 也寫出同樣的數字（skill.md 是唯一協議文件，沒有 skill.json）。
 */

import { bestSourceKind, type SourceKind } from "./source-priority.ts";
import { correctionTouches } from "./correction.ts";

export const VOTE_WEIGHT = 1;
/** consensusStatus 的預設門檻（呼叫端一律傳 requiredAgree 算出的值） */
export const VERIFIED_MIN_AGREE = 2;
export const VERIFIED_MAX_DISAGREE = 0;

/**
 * 風險等級：normal＝一般資料；high＝加減參選人；light＝不動正式資料（提議任務／無異動）；
 * past_result＝補一場已投票選舉的結果；removal＝移除既有資料；adjudication＝裁決
 */
export type RiskLevel = "normal" | "high" | "light" | "past_result" | "removal" | "adjudication";

/**
 * 門檻矩陣（鏡射 SQL contribution_required_agree；migration 000009 與 consensus.test.ts 的一致性測試會比對這張表）
 * 官方來源通過得更快，非官方要更多人看過；多個來源取最高等級。
 */
export const AGREE_THRESHOLDS: Record<RiskLevel, Record<SourceKind, number>> = {
  normal: { official: 2, media: 2, social: 3, other: 3 },
  high: { official: 4, media: 6, social: 8, other: 8 },
  light: { official: 1, media: 2, social: 2, other: 2 },
  // 2026-09-16 看一筆「陳若翠 2024 高雄市立委 not_elected、得票 64,261」要 6 票：
  // 「這種舊期的參選，我覺得 2 票就夠了」。
  // 加減參選人之所以要 4／6／8，是因為那會憑空生出或抹掉一筆參選紀錄；
  // 但「已投票選舉的結果」是查得到的既成事實，而且掛在既有人物既有屆別上，
  // 搞錯了改回來也容易。不看來源等級：選舉結果連維基都抄得到，分級沒有意義。
  past_result: { official: 2, media: 2, social: 2, other: 2 },
  // 移除不看來源等級：移除的理由常常是「查不到任何來源」，那種主張本身沒有來源可言。
  // 3 票＝比一般更正高、比加減參選人低；低是因為移除是軟移除，資料留著、可以復原。
  removal: { official: 3, media: 3, social: 3, other: 3 },
  adjudication: { official: 4, media: 4, social: 4, other: 4 },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 「補一場已投票選舉的結果」：掛在既有人物（帶 politician_id，不是靠姓名新建）、
 * 而且帶 election_result。沒有 politician_id 就不算——那條路會順手建出新人物，
 * 風險跟新增參選人一樣。
 */
export function isPastElectionResult(contributionType: string, payload: unknown): boolean {
  if (contributionType !== "candidacy") return false;
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const result = typeof p.election_result === "string" ? p.election_result : null;
  return (result === "elected" || result === "not_elected") && typeof p.politician_id === "string" && UUID_RE.test(p.politician_id);
}

export function riskLevel(contributionType: string, payload: unknown): RiskLevel {
  if (contributionType === "adjudication") return "adjudication";
  if (contributionType === "removal") return "removal";
  if (isPastElectionResult(contributionType, payload)) return "past_result";
  if (contributionType === "candidacy") return "high";
  // correction 多欄位時取最高風險：任一欄是 candidate_status 就走加減參選人的級距
  if (contributionType === "correction" && correctionTouches(payload, "candidate_status")) return "high";
  // roster_check 跟提議任務、無異動同級：它不改核心資料。
  // 代價是官方來源只要一票就能把某縣市標記為已清查、壓住那個缺口七天——
  // 但最壞情況只是七天的延遲，而且 roster_checks 表裡看得到是誰報的；
  // 要求兩票反而會讓清查永遠確認不了，任務一直重派、代理重複做同一個縣市。
  if (contributionType === "task_suggestion" || contributionType === "no_change" || contributionType === "roster_check") return "light";
  return "normal";
}

/** 依型別／欄位／來源等級決定需要幾票同意；source_urls 沒給視為 other */
export function requiredAgree(contributionType: string, payload: unknown, sourceUrls: readonly string[] = []): number {
  return AGREE_THRESHOLDS[riskLevel(contributionType, payload)][bestSourceKind(sourceUrls)];
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
  // 兩張反對＝爭議；一張反對但同意已達標也是爭議——不能既不通過又不裁決。
  // 2026-09-17：那題 Facebook 提問的 no_change 就是「2 同意 1 反對」，兩邊都不成立，
  // 從 09-12 懸空到今天，沒有任何人會再處理它（全站當時有 3 筆卡在這個縫裡）。
  if (counts.disagree >= DISPUTED_MIN_DISAGREE) return "disputed";
  if (counts.disagree > VERIFIED_MAX_DISAGREE && counts.agree >= minAgree) return "disputed";
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

/**
 * 同一筆貢獻，同一個 agent_name 或同一個來源 IP 只能投一次。
 *
 * 原本只比 agent_name，同一台機器換個代號就能再投一票，於是一個人自己
 * 就能把票數投到門檻。計票端（contribution_apply_consensus）也改成依來源 IP
 * 去重，這裡先把重複的票擋在門外並講清楚原因，不要靜靜收下卻不計入。
 */
export function isDuplicateVote(existing: readonly VoteRecord[], voter: VoterIdentity): boolean {
  return existing.some((v) =>
    v.agent_name.toLowerCase() === voter.agent_name.toLowerCase() ||
    (!!v.verifier_ip_hash && v.verifier_ip_hash === voter.ip_hash)
  );
}

export interface VoteRecord {
  agent_name: string;
  verifier_ip_hash?: string | null;
}

/** 依來源 IP 去重的票數，鏡射 SQL 的 COUNT(DISTINCT verifier_ip_hash)；unsure 不影響狀態，算總筆數。 */
export function tallyByIp(votes: readonly { verdict: Verdict; verifier_ip_hash?: string | null }[]): VoteCounts {
  const seen: Record<Verdict, Set<string>> = { agree: new Set(), disagree: new Set(), unsure: new Set() };
  let unsure = 0;
  for (const v of votes) {
    if (v.verdict === "unsure") { unsure += VOTE_WEIGHT; continue; }
    seen[v.verdict].add(v.verifier_ip_hash ?? "");
  }
  return { agree: seen.agree.size, disagree: seen.disagree.size, unsure };
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

// ---- 身份指認（politician／candidacy）----

export interface IdentityVote { verdict: Verdict; resolved_politician_id: string | null }

export type IdentityResolution =
  | { kind: "resolved"; politician_id: string }
  | { kind: "new" }
  | { kind: "conflict"; politician_ids: string[] }
  | { kind: "none" };

/**
 * 純函式：agree 票裡帶 resolved_politician_id 的，全部指向同一位 → resolved；全部說 "new" → new（建新人物）；
 * 指向不同位（含 new 與某人混）→ conflict（轉 disputed）；都沒帶 → none（交給多面向比對：matched／new 照常，ambiguous 轉 disputed）。
 */
export function resolveIdentityFromVotes(votes: readonly IdentityVote[]): IdentityResolution {
  const ids = [...new Set(votes.filter((v) => v.verdict === "agree" && v.resolved_politician_id).map((v) => v.resolved_politician_id as string))];
  if (ids.length === 0) return { kind: "none" };
  if (ids.length > 1) return { kind: "conflict", politician_ids: ids };
  return ids[0] === "new" ? { kind: "new" } : { kind: "resolved", politician_id: ids[0] };
}

// ---- 落庫失敗自動重試 ----

export const APPLY_MAX_RETRIES = 3;
export const APPLY_RETRY_DELAY_MINUTES = 10;

export interface RetryPlan { give_up: boolean; retry_count: number; next_retry_at: string | null }

/** 純函式：第 N 次失敗後怎麼辦（retry_count 是「已失敗次數」，含這次） */
export function planRetry(previousRetryCount: number, now: number = Date.now()): RetryPlan {
  const retry_count = previousRetryCount + 1;
  if (retry_count >= APPLY_MAX_RETRIES) return { give_up: true, retry_count, next_retry_at: null };
  return { give_up: false, retry_count, next_retry_at: new Date(now + APPLY_RETRY_DELAY_MINUTES * 60 * 1000).toISOString() };
}
