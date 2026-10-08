/**
 * 日本站落庫的呼叫端：jp-report 在票數讓貢獻變 verified 的那一刻，用 rpc 叫 SQL 的 policy_jp.apply_contribution。
 *
 * 為什麼落庫本體是 SQL 不是 TS（跟正見 _shared/apply-contribution.ts 不同）：一筆貢獻要寫的東西（正式列、sources、source_refs、edit_history、
 * 貢獻狀態）要在同一個交易裡成功或失敗；排程重試（apply_verified_pending，pg_cron）也直接叫 SQL。細節與理由見 20261009210000_policy_jp_apply.sql。
 * 這個檔只做三件事：認得哪些型別會落庫、叫 rpc、把 SQL 回的狀態翻成 verify-handler 要的 {status, message}。
 *
 * 失敗不丟出（verify-handler 的 applyFn 規矩：落庫失敗不影響投票成功）；rpc 本身出錯就丟，由 verify-handler 攔住並回報在 auto_apply.message。
 */

import type { JpApplyFn } from "./verify-handler.ts";

/** 會落庫的型別（SQL policy_jp.apply_types() 的鏡像，policy-jp-apply.test.ts 對齊）；task_suggestion、correction 這輪維持 verified */
export const JP_APPLY_TYPES = ["local_government", "regional_stat", "election", "no_change"] as const;

/** SQL 回傳的 status：applied／rejected／apply_failed 是貢獻的新狀態；waiting 是在等團體進來（狀態不變）；其餘不用理 */
const FINAL = new Set(["applied", "rejected", "apply_failed"]);

export const jpApplyViaRpc: JpApplyFn = async (supabase, contributionId) => {
  const { data, error } = await supabase.rpc("apply_contribution", { p_id: contributionId, p_retry: false });
  if (error) throw new Error(`apply_contribution: ${error.message}`);
  const out = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as { status?: unknown; message?: unknown };
  const status = typeof out.status === "string" ? out.status : "";
  const message = typeof out.message === "string" ? out.message : undefined;
  if (FINAL.has(status)) return { status, message };
  // waiting：通過驗證、等外鍵指到的團體落庫（排程會接手）；回報給代理，狀態仍是 verified
  if (status === "waiting") return { message };
  // unsupported（task_suggestion、correction）、skipped、not_found：沒有落庫這回事，不算「觸發了落庫」
  return null;
};
