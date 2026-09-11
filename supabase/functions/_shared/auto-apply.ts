/**
 * verified 即自動落庫：/report{kind:verify} 投票後狀態轉 verified 時立刻呼叫；apply-verified 掃地機補漏。
 * applyFn 可注入（測試用 mock）。
 */

import { applyContribution, type ApplyOutcome, type ContributionRow, contributionStatusFor } from "./apply-contribution.ts";

// deno-lint-ignore no-explicit-any
type SupabaseLike = any;

export type ApplyFn = (supabase: SupabaseLike, row: ContributionRow) => Promise<ApplyOutcome>;

export interface AutoApplyResult {
  triggered: boolean;
  status?: string;
  outcome?: ApplyOutcome;
  error?: string;
}

/** 純判斷：只有 verified 才自動落庫 */
export function shouldAutoApply(status: string | null | undefined): boolean {
  return status === "verified";
}

const ROW_COLUMNS = "id, contribution_type, payload, source_urls, note, agent_name, contributor_url, status";

/**
 * 對一筆 contribution 執行自動落庫並更新狀態。冪等：狀態不是 verified 就不動。
 * 失敗不丟出（回 error），讓投票回應仍能成功；狀態寫成 apply_failed 供掃地機／維護者處理。
 */
export async function autoApplyContribution(supabase: SupabaseLike, contributionId: string, applyFn: ApplyFn = applyContribution): Promise<AutoApplyResult> {
  const { data: row, error } = await supabase.from("contributions").select(ROW_COLUMNS).eq("id", contributionId).maybeSingle();
  if (error) return { triggered: false, error: `contributions read: ${error.message}` };
  if (!row || !shouldAutoApply(row.status)) return { triggered: false, status: row?.status };

  const now = new Date().toISOString();
  try {
    const outcome = await applyFn(supabase, row as ContributionRow);
    const status = contributionStatusFor(outcome.status);
    const { error: updateError } = await supabase.from("contributions").update({
      status,
      review_notes: `[auto] ${outcome.message}`,
      reviewed_by: "auto-apply",
      reviewed_at: now,
      applied_at: status === "applied" ? now : null,
      applied_politician_id: outcome.politician_id ?? null,
      applied_policy_id: outcome.policy_id ?? null,
    }).eq("id", contributionId).eq("status", "verified");
    if (updateError) return { triggered: true, status, outcome, error: `contributions update: ${updateError.message}` };
    return { triggered: true, status, outcome };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase.from("contributions").update({ status: "apply_failed", review_notes: `[auto] 落庫失敗：${message}`, reviewed_by: "auto-apply", reviewed_at: now })
      .eq("id", contributionId).eq("status", "verified");
    return { triggered: true, status: "apply_failed", error: message };
  }
}
