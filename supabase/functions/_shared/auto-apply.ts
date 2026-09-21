/**
 * verified 即自動落庫：/report{kind:verify} 投票後狀態轉 verified 時立刻呼叫；apply-verified 掃地機補漏並重試 apply_failed。
 * 人工介入點只有 disputed：
 *   - politician／candidacy 的身份由驗證者指認（votes.resolved_politician_id）：兩票同一位 → 用那位；指不同位 → disputed；
 *     都沒指認 → 交多面向比對，matched／new 照常，ambiguous → disputed
 *   - 落庫丟錯 → apply_failed，10 分鐘後重試、最多 3 次，仍失敗 → disputed（review_notes 記原因）
 * applyFn 可注入（測試用 mock）。
 */

import { applyContribution, type ApplyOutcome, type ContributionRow, contributionStatusFor } from "./apply-contribution.ts";
import { APPLY_MAX_RETRIES, type IdentityVote, planRetry, resolveIdentityFromVotes } from "./consensus.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export type ApplyFn = (supabase: SupabaseLike, row: ContributionRow) => Promise<ApplyOutcome>;

export interface AutoApplyResult {
  triggered: boolean;
  status?: string;
  outcome?: ApplyOutcome;
  error?: string;
}

export interface AutoApplyOptions {
  /** 掃地機重試 apply_failed 時為 true；投票路徑不帶（只處理 verified） */
  retry?: boolean;
  /**
   * 沒有投票指認時要用哪一位人物（cec-verify 用：它不投票，身份是拿我們資料庫的唯一同名者比中選會選區確認的）。
   * 投票有指認時以投票為準——那是多個代理看過的結果，比單一來源可靠。
   */
  resolvedPoliticianId?: string | null;
}

/** 純判斷：只有 verified 才自動落庫 */
export function shouldAutoApply(status: string | null | undefined): boolean {
  return status === "verified";
}

/** 純判斷：apply_failed 且還有重試額度、時間到 */
export function shouldRetry(row: { status: string; retry_count?: number | null; next_retry_at?: string | null }, now: number = Date.now()): boolean {
  if (row.status !== "apply_failed") return false;
  if ((row.retry_count ?? 0) >= APPLY_MAX_RETRIES) return false;
  const due = row.next_retry_at ? Date.parse(row.next_retry_at) : 0;
  return !Number.isNaN(due) && due <= now;
}

// task_id 要撈：上線後拿它判斷所屬任務該不該關（task-fulfilment.ts）；少了它，關任務會默默不做
const ROW_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, agent_tool, contributor_url, status, retry_count, next_retry_at, task_id";
const IDENTITY_TYPES = new Set(["politician", "candidacy"]);

async function identityFromVotes(supabase: SupabaseLike, contributionId: string): Promise<ReturnType<typeof resolveIdentityFromVotes>> {
  const { data, error } = await supabase.from("contribution_votes").select("verdict, resolved_politician_id").eq("contribution_id", contributionId);
  if (error) throw new Error(`votes read: ${error.message}`);
  return resolveIdentityFromVotes((data ?? []) as IdentityVote[]);
}

/**
 * 對一筆 contribution 執行自動落庫並更新狀態。冪等：狀態不是 verified（或 retry 模式下不是可重試的 apply_failed）就不動。
 * 失敗不丟出（回 error），讓投票回應仍能成功。
 */
export async function autoApplyContribution(supabase: SupabaseLike, contributionId: string, applyFn: ApplyFn = applyContribution, options: AutoApplyOptions = {}): Promise<AutoApplyResult> {
  const { data: row, error } = await supabase.from("contributions").select(ROW_COLUMNS).eq("id", contributionId).maybeSingle();
  if (error) return { triggered: false, error: `contributions read: ${error.message}` };
  if (!row) return { triggered: false };
  const eligible = options.retry ? shouldRetry(row) : shouldAutoApply(row.status);
  if (!eligible) return { triggered: false, status: row.status };

  const now = new Date().toISOString();
  const lock = { id: contributionId, status: row.status as string }; // 樂觀鎖：只在還是我讀到的狀態時才寫
  const update = async (patch: Record<string, unknown>) => {
    const { error: e } = await supabase.from("contributions").update(patch).eq("id", lock.id).eq("status", lock.status);
    return e ? `contributions update: ${e.message}` : null;
  };
  // 2026-09-21 使用者裁示：衝突或落庫失敗就**不要硬建**，直接退件。缺口還在，派工佇列之後會再把它派出來，
  // 用乾淨的一輪重做，衝突自然消失——不開裁決任務、不開修正任務、不留 disputed 這個狀態。
  //   「資料不如不建，還會比較好。下面幾個任務盤查可能就會讓這些資料重新出現，現在的衝突可能就會被解決。」
  const GAP_RETURNS = "這筆不落庫；缺口會回到任務佇列，由之後的任務重新查一次";

  try {
    let resolvedPoliticianId: string | null = null;
    if (IDENTITY_TYPES.has(row.contribution_type)) {
      const identity = await identityFromVotes(supabase, contributionId);
      if (identity.kind === "conflict") {
        const message = `驗證者指認的人物不一致（${identity.politician_ids.join("、")}），退件。${GAP_RETURNS}`;
        const err = await update({ status: "rejected", review_notes: `[auto] ${message}`, reviewed_by: "auto-apply", reviewed_at: now });
        return { triggered: true, status: "rejected", outcome: { status: "disputed", message }, ...(err ? { error: err } : {}) };
      }
      if (identity.kind === "resolved") resolvedPoliticianId = identity.politician_id;
      else if (identity.kind === "new") resolvedPoliticianId = "new";
      // 沒有投票指認時，呼叫端若已經確認是誰就用它（cec-verify：我們資料庫唯一同名者＋中選會選區對得上）。
      // 有投票指認就不理會這個值——那是多個代理看過的結果。
      else if (identity.kind === "none" && options.resolvedPoliticianId) resolvedPoliticianId = options.resolvedPoliticianId;
    }

    const outcome = await applyFn(supabase, { ...(row as ContributionRow), resolved_politician_id: resolvedPoliticianId });
    if (outcome.status === "failed") throw new Error(outcome.message);
    const status = contributionStatusFor(outcome.status);
    if (status === "rejected") {
      // applyFn 判身份判不出（ambiguous）等情況：一樣退件，不硬建
      const err = await update({ status, review_notes: `[auto] ${outcome.message}。${GAP_RETURNS}`, reviewed_by: "auto-apply", reviewed_at: now });
      return { triggered: true, status, outcome, ...(err ? { error: err } : {}) };
    }
    const err = await update({
      status,
      review_notes: `[auto] ${outcome.message}`,
      reviewed_by: "auto-apply",
      reviewed_at: now,
      applied_at: status === "applied" ? now : null,
      applied_politician_id: outcome.politician_id ?? null,
      applied_policy_id: outcome.policy_id ?? null,
      last_error: null,
      next_retry_at: null,
    });
    return { triggered: true, status, outcome, ...(err ? { error: err } : {}) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const plan = planRetry(row.retry_count ?? 0);
    if (plan.give_up) {
      await update({
        status: "rejected", retry_count: plan.retry_count, last_error: message, next_retry_at: null,
        review_notes: `[auto] 落庫連續 ${plan.retry_count} 次失敗，退件：${message}。${GAP_RETURNS}`, reviewed_by: "auto-apply", reviewed_at: now,
      });
      return { triggered: true, status: "rejected", error: message };
    }
    await update({
      status: "apply_failed", retry_count: plan.retry_count, last_error: message, next_retry_at: plan.next_retry_at,
      review_notes: `[auto] 落庫失敗（第 ${plan.retry_count} 次，${plan.next_retry_at?.slice(11, 16)} UTC 後重試）：${message}`, reviewed_by: "auto-apply", reviewed_at: now,
    });
    return { triggered: true, status: "apply_failed", error: message };
  }
}
