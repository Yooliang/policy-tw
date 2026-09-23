/**
 * 同儕驗證共識規則（第一版：匿名、權重一律 1、沒有信譽分級）。
 * 門檻與計票同時寫在 migration 20260912000013 的 contribution_required_agree()／contribution_apply_consensus()，改一邊要改另一邊；
 * skill.md 也寫出同樣的數字（skill.md 是唯一協議文件，沒有 skill.json）。
 */

import { bestSourceKind, type SourceKind } from "./source-priority.ts";
import { correctionTouches, correctionOnlyFromRumor } from "./correction.ts";

export const VOTE_WEIGHT = 1;
/** consensusStatus 的預設門檻（呼叫端一律傳 requiredAgree 算出的值） */
export const VERIFIED_MIN_AGREE = 2;
/**
 * 通過時最多容忍幾張反對：1。
 * 2026-09-19 使用者裁決：「我看不到」不是「我反對」。一張反對（常常是「打不開來源」）不該推翻 2～4 個真的讀過來源的人；
 * 轉爭議要 2 張帶反證的反對。單獨一張反對而同意已達標 → 通過（那張反對留著給對帳看）。
 */
export const VERIFIED_MAX_DISAGREE = 1;

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
  // 2026-09-21 使用者裁示：目標分數一律 3，不動正式資料的型別 2。
  // 舊矩陣（2/3/4/6/8）是票數制的遺物：媒體級參選紀錄目標 5～8，等於要六張 +1，官方名冊一秒可確認的登記
  // 實務上到不了。風險差異之後由 Jev 的風險加成動態調，不靠靜態矩陣。形狀留著是給三處一致性測試比對用。
  normal: { official: 3, media: 3, social: 3, other: 3 },
  high: { official: 3, media: 3, social: 3, other: 3 },
  light: { official: 2, media: 2, social: 2, other: 2 },
  past_result: { official: 3, media: 3, social: 3, other: 3 },
  removal: { official: 3, media: 3, social: 3, other: 3 },
  adjudication: { official: 3, media: 3, social: 3, other: 3 },
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
  // 同名人物合併走 high（官方 4／媒體 6／社群 8）：誤併沒有便宜的回頭路（2026-09-20 審查建議 6；前一天訂 3 票）
  if (contributionType === "merge_politician") return "high";
  if (isPastElectionResult(contributionType, payload)) return "past_result";
  if (contributionType === "candidacy") return "high";
  // correction 多欄位時取最高風險：任一欄是 candidate_status 就走加減參選人的級距
  if (contributionType === "correction" && correctionTouches(payload, "candidate_status")) {
    // 傳聞參選→登記／不參選：一般級（2026-09-20 審查建議 12）；SQL contribution_required_agree 同步
    return correctionOnlyFromRumor(payload) ? "normal" : "high";
  }
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
/** disagree ≥ 2 → disputed（兩張帶反證的反對才是爭議） */
export const DISPUTED_MIN_DISAGREE = 2;

/**
 * 「盲反對」：備註寫的是打不開、連不上、確認不了——那是 unsure 不是 disagree（skill.md §2-9 一直這樣寫，現在改成守門）。
 * 有具體矛盾字眼（不符、矛盾、應為…）就不算盲的，就算同一句也提到某個網址打不開。
 * 2026-09-19：卡伊．馬賴 4 張 agree 被一張「無法開啟來源 PDF」＋一張系統票推進裁決；傅崐萁那筆是 2 agree 被「來源無法確定」卡住。
 */
const BLIND_DISAGREE_RE = /無法(開啟|連線|確定|下載|讀取|存取|核對|取得|驗證|確認|載入|打開)|打不開|開不了|抓不到|連不上|逾時|timeout|timed out|HTTP ?(403|404|5\d\d)|連線失敗|讀不到/i;
// 有實質內容的反對：矛盾字眼、來源「沒提到」、引了別的來源或數字——就算同一句也說某個網址打不開
const CONTRADICTION_RE = /不符|矛盾|不一致|應為|應該是|實為|寫的是|錯誤|有誤|不是|並非|查無|沒有這個人|不存在|沒有任何|沒有提|沒提|未提|無此|只是|而非|才是|年生|經.{1,12}(報|網|資料|公報|名單)/;
/** 兩個網址是不是同一頁：忽略協定、www、尾斜線與大小寫。 */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const x = norm(a), y = norm(b);
  return x.length > 0 && x === y;
}

/**
 * 盲反對：說的是「我拿不到來源」，不是「來源說的跟宣稱不一樣」。這種票改記 unsure。
 *
 * 2026-09-21 現場：澎湖那批 19 筆 candidacy 共用一個已經 404 的 udn 網址，
 * 有四票寫「來源不存在：…回 HTTP 404…web.archive.org 查無快照」卻被記成真的反對。
 * 原因是判斷「有沒有實質反證」的 CONTRADICTION_RE 裡有「不存在」「查無」——
 * 那本來是要抓「這個人不存在」「查無此人」，卻跟「來源不存在」「查無快照」撞在一起。
 *
 * 再用正則去分「來源不存在」與「人不存在」會一直漏（同一批裡還有「故非類別錯誤」
 * 命中「錯誤」）。改用一個結構上的判準：**「讀不到」與「讀到了但內容不符」不可能同時成立**。
 * 所以備註說拿不到、而 evidence_url 指的又正是那個拿不到的來源時，它手上就沒有第二來源。
 *
 * 沒附 evidence_url 的維持原本的文字判斷——歷來有不少票把反證寫在備註裡
 * （「來源打不開，但改查中選會資料庫：登記的是第 6 選區，與 payload 不符」），那是真的反證。
 */
export function isBlindDisagree(
  note: string | null | undefined,
  opts?: { evidenceUrl?: string | null; sourceUrls?: readonly string[] | null },
): boolean {
  const n = (note ?? "").trim();
  if (!n) return false;
  if (!BLIND_DISAGREE_RE.test(n)) return false;
  const ev = opts?.evidenceUrl?.trim();
  if (ev && (opts?.sourceUrls ?? []).some((s) => sameUrl(s, ev))) return true;
  return !CONTRADICTION_RE.test(n);
}
export const BLIND_DISAGREE_NOTE = "（系統改記 unsure：反對票要有反證，「來源打不開／確認不了」不是反證）";

/**
 * 「橡皮圖章同意票」：agree 但備註只有套語、也沒附第二來源——那張票沒有說出它核對了什麼。
 *
 * 2026-09-21 現場（ballyhoo-4d 的還債代理）：它前 6 票品質很好，其中一筆抓到「原貢獻附的
 * CNA 網址實際內容是演唱會娛樂新聞」；接著最後 5 票全變成 `agree` ＋ note「驗證通過」＋
 * 無 evidence_url，一模一樣，而其中 4 票是決定性的那一票（agree_count 剛好達標，直接落庫）。
 *
 * 這是第四種迴避實際查證的形狀，而且前三種（自設預算提前收工、填假網址、拖延不投）
 * 都能靠把指令寫死壓制，**這一種壓不住**：它一開始照做，是後來才衰退的，事前指令涵蓋不到。
 *
 * 2026-09-21 稍後更正：實地逐筆核過那 30 票指向的來源，**內容其實是對的**。
 * 所以問題不是「無據放行」而是「查了卻沒留下痕跡」——下游分不出真查過與沒查過的票。
 * 因此處置不是降級（那會永久吃掉一張有效票，同 IP 不能重投），而是退回 400 讓它補寫再送。
 * disagree 早就要求附反證，agree 卻什麼都不要求——而 agree 才是真正推資料上線的那一票，
 * 這個不對稱沒有道理。
 *
 * 判準刻意保守，只抓「什麼都沒說」：
 *   - 沒有 evidence_url（有附第二來源就是有做事，不管備註寫多短）
 *   - 而且備註去掉標點後短於 RUBBER_STAMP_MIN_NOTE 字，或整句就是套語
 * 寫得出「三個欄位都對得上中選會那頁」這種具體內容的，一律不受影響。
 */
export const RUBBER_STAMP_MIN_NOTE = 12;
const BOILERPLATE_RE = /^(驗證通過|確認通過|核對通過|資料正確|內容正確|無誤|正確|沒問題|沒有問題|ok|okay|looks good|lgtm|同意|通過|已核對|已驗證|已確認|來源正確|來源無誤)[。．.!！]*$/i;

/**
 * 跟自己上一票寫了一模一樣的備註＝罐頭。
 *
 * 2026-09-21 的事故裡這個訊號乾淨得出乎意料：代理自承 vote 5–33「完全沒打開任何來源」，
 * 那 29 票的 note 全是同一句「查證通過」；而前 6 票每一票的 note 都不一樣，那 6 票都真的查了。
 * 29 票裡這條規則擋得掉 28 票（第一句罐頭還是會過，第二句起就擋住）。
 *
 * 成本極低、不要求多給網址、不擋任何認真寫的票——兩次查證不會產生一模一樣的描述。
 * 正規化只去空白與標點：換句話說的算不同，只有整句照抄才算。
 */
export function isRepeatedNote(note: string | null | undefined, previousNote: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").replace(/[\s，。、．,.!！?？；;：:「」『』()（）]/g, "").trim().toLowerCase();
  const a = norm(note);
  if (!a) return false;
  return a === norm(previousNote);
}

/**
 * 跟這筆既有的某張票一字不差、而且自己沒帶引文（數字或引號裡的字）＝抄的（#7 配套，2026-09-21）。
 * 只比「正規化後完全相同」，不比相似度：同一份官方名冊的不同列，句型必然相同，相似度會誤傷正確行為。
 */
export function isCopiedNote(note: string | null | undefined, existingNotes: ReadonlyArray<string | null | undefined>): boolean {
  const norm = (s: string | null | undefined) => (s ?? "").replace(/[\s，。、．,.!！?？；;：:「」『』()（）]/g, "").trim();
  const n = norm(note);
  if (!n) return false;
  if (/\d/.test(note ?? "") || /[「『"]/.test(note ?? "")) return false; // 有自己的引文（行號、日期、數字、引句）
  return existingNotes.some((e) => norm(e) === n);
}

export function isRubberStampAgree(note: string | null | undefined, evidenceUrl: string | null | undefined): boolean {
  if (evidenceUrl && /https?:\/\/\S+/.test(evidenceUrl)) return false;
  const n = (note ?? "").replace(/[\s，。、．,.!！?？；;：:「」『』()（）]/g, "").trim();
  if (!n) return true;
  if (BOILERPLATE_RE.test((note ?? "").trim())) return true;
  return n.length < RUBBER_STAMP_MIN_NOTE;
}


// ---- 系統來源票（Jev）：4 票變 3+1 ----
// 2026-09-19 使用者裁決：代理的價值是找第二、第三個可信來源；Jev 核「提交者附的那個來源」支不支持宣稱，
// 所以它明確有一票。票的形狀：supported 佔一席（門檻 −1，最少仍要 1 張代理票，Jev 不能單獨通過）；
// not_supported 讓門檻 +1（只擋自動上線，**不觸發裁決**——同日晚上改：它判錯過一次就把 4 張人票推進裁決）；
// 棄權則門檻照舊。SQL 版在 contribution_apply_consensus，thresholds.test 盯兩邊一致。
// merge_politician 不拿系統票：Jev 的 same_person 看的是我們自己的欄位，跟代理看的是同一批資料，不構成獨立證據（2026-09-20）
export const SYSTEM_VOTE_ELIGIBLE_TYPES = ["policy", "candidacy", "politician", "correction", "policy_progress"] as const;
export type SystemVote = "supported" | "not_supported" | null;

export function systemVoteEligible(contributionType: string): boolean {
  return (SYSTEM_VOTE_ELIGIBLE_TYPES as readonly string[]).includes(contributionType);
}
/**
 * 這筆現在要幾張同意票：資料列帶著 PostgREST 計算欄位 effective_agree（SQL contribution_effective_agree，系統票已折進去）
 * 就用它；沒帶（舊查詢、剛提交還沒有系統票）就退回原門檻。五個回 required_agree 的地方都走這裡（2026-09-20 審查建議 1）。
 */
export function effectiveOrRequired(row: { contribution_type: string; payload: unknown; source_urls?: readonly string[] | null; effective_agree?: number | null; effective_required?: number | null }): number {
  const eff = row.effective_agree ?? row.effective_required;
  return typeof eff === "number" ? eff : requiredAgree(row.contribution_type, row.payload, row.source_urls ?? []);
}

/** supported → 門檻 −1，但最少 1；not_supported → 門檻 +1（多要一張人票，不算反對） */
export function effectiveRequiredAgree(required: number, systemVote: SystemVote): number {
  if (systemVote === "supported") return Math.max(1, required - 1);
  if (systemVote === "not_supported") return required + 1;
  return required;
}
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
  // 兩張反對＝爭議。一張反對而同意已達標 → 通過（2026-09-19：09-17 那版把它算成爭議，結果一張「打不開來源」
  // 就能把 4 張讀過來源的 agree 推進 4 票的裁決；盲反對現在在 verify 端點就改記 unsure，剩下的一張反對不擋路，留著對帳）。
  // 沒有懸空：反對 ≥2 爭議、達標通過、其餘 pending。
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

/**
 * 同一筆貢獻，同一個 agent_name 或同一個來源 IP 只能投一次。
 *
 * 原本只比 agent_name，同一台機器換個代號就能再投一票，於是一個人自己
 * 就能把票數投到門檻。計票端（contribution_apply_consensus）也改成依來源 IP
 * 去重，這裡先把重複的票擋在門外並講清楚原因，不要靜靜收下卻不計入。
 */
export function isDuplicateVote(existing: readonly VoteRecord[], voter: VoterIdentity): boolean {
  // 2026-09-19 裁決：身份是來源 IP，不是代號。代號是自報的、兩個人可以共用同一個；
  // 同一個代號在兩台機器各投一票，那是兩個人。只有舊票（還沒記 IP 雜湊的年代）才退回比代號。
  return existing.some((v) =>
    v.verifier_ip_hash ? v.verifier_ip_hash === voter.ip_hash : v.agent_name.toLowerCase() === voter.agent_name.toLowerCase()
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

// ============================================================
// 分數制（2026-09-21）：這裡是 SQL contribution_vote_weight()／contribution_apply_consensus() 的鏡像，
// 給回應文字與測試用。真正計分的是 DB 觸發器；兩邊要一致，守門測試盯著。
// ============================================================

export type VoteWeight = -2 | -1 | 0 | 1 | 2;

/** 一票值幾分：agree +1（Jev 核過來源 +2）、disagree −1（Jev 核過反證 −2）、unsure 0 */
export function voteWeight(verdict: string, judgeBacked: boolean): VoteWeight {
  if (verdict === "agree") return judgeBacked ? 2 : 1;
  if (verdict === "disagree") return judgeBacked ? -2 : -1;
  return 0;
}

/**
 * 告訴代理它這一票為什麼值這個分數——看得見才學得會，學不會就沒有人會去找第二來源。
 *
 * 「附了來源但沒核過」要跟「沒附來源」分開講（跑任務的伙伴 2026-09-21 實測：附了不同網域的
 * 第二來源仍拿 +1，回應卻叫它「去附一個來源」——對已經附了的代理是誤導）。
 * 2026-09-23 起系統自己核 evidence_url（cron），代理不再、也不能叫 Jev 替它判。
 */
export function weightReason(verdict: string, judgeBacked: boolean, hasEvidence = false): string {
  if (verdict === "agree") {
    if (judgeBacked) return "你附的 evidence_url 是獨立的第二來源，而且系統核過它直接支持這筆宣稱（+2）";
    if (hasEvidence) return "你附了 evidence_url：系統會在幾分鐘內自己核那個網址，核得過這票自動變 +2；你不用也不能叫系統替你判";
    return "你打開了提交者的來源並寫出核對內容；想拿 +2，附一個不同網域、直接證實這筆宣稱的來源到 evidence_url，系統會自己核";
  }
  if (verdict === "disagree") {
    if (judgeBacked) return "你附的反證系統核過，直接與這筆宣稱矛盾（−2）";
    if (hasEvidence) return "你附了反證：系統會在幾分鐘內自己核那個網址，核心欄位確實矛盾這票自動變 −2";
    return "反對且理由具體；附上系統核過的反證（evidence_url）才是 −2";
  }
  return "存疑不加減分；它記錄你看過，但不推動這筆往任何方向走";
}

/** 高風險型別：分數不得由單一來源 IP 湊足 */
export const SCORE_TWO_IP_TYPES = ["merge_politician", "candidacy", "removal"] as const;

/**
 * 退件門檻：分數 ≤ −這個數就退件。固定 3（不動正式資料的型別 2），**不隨目標分數調整**（2026-09-23 小良哥）。
 * 09-21 原本是 ≤ −目標，但目標會被 Jev 往上調（來源判不支持 → 4；票數預算接上後可到 5～7），
 * 退件跟著變難——Jev 已經說這筆撐不住，反而要更多反對票才退得掉，方向相反。SQL 同步：contribution_reject_floor。
 */
export function rejectFloor(contributionType: string): number {
  return riskLevel(contributionType, null) === "light" ? 2 : 3;
}

/** 總分 → 狀態。只在 pending／verified／disputed 之間轉；其餘狀態由維護者或系統決定。 */
export function scoreStatus(input: { score: number; target: number; distinctIps: number; contributionType: string; current: string }): string {
  const { score, target, distinctIps, contributionType, current } = input;
  if (current !== "pending" && current !== "verified" && current !== "disputed") return current;
  if (score <= -rejectFloor(contributionType)) return "rejected";
  const needTwoIps = (SCORE_TWO_IP_TYPES as readonly string[]).includes(contributionType);
  if (score >= target && (!needTwoIps || distinctIps >= 2)) return "verified";
  return "pending";
}
