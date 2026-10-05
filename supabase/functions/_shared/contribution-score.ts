/**
 * 貢獻的「分數」與「目標分數」：貢獻看板（contributions-feed）與查核履歷（history）共用的唯一取法。
 *
 * 兩個端點給讀者看同一件事——這筆貢獻現在幾分、要幾分才通過——所以來源只能有一份：
 *   - 分數：contributions.score（DB 觸發器 contribution_apply_consensus 維護，可為負）
 *   - 目標分數：PostgREST 計算欄位 effective_agree（SQL contribution_effective_agree，系統票已折進去）；
 *     拿不到（舊查詢、剛提交還沒計過票）就退回 consensus.ts 的 requiredAgree
 * 之前這段寫在 contributions-feed 裡；history 要帶同樣的欄位時抽出來共用，免得規則一改兩邊不一致。
 * 守門見 contribution-score.test.ts：兩個端點的原始碼都必須走這支、不得自己再算一次。
 */

import { effectiveOrRequired } from "./consensus.ts";

/** 查詢 contributions 時要撈的欄位：要拿到分數與目標分數，select 就得帶這兩個 */
export const SCORE_COLUMNS = "score, effective_agree";

export interface ScoreSource {
  contribution_type: string;
  payload: unknown;
  source_urls?: readonly string[] | null;
  score?: number | null;
  effective_agree?: number | null;
  effective_required?: number | null;
}

/** 一筆貢獻現在的分數與目標分數（目標＝通過的分數；退件門檻另有規則，見 consensus.ts 的 rejectFloor） */
export function contributionScore(row: ScoreSource): { score: number; target_score: number } {
  return { score: row.score ?? 0, target_score: effectiveOrRequired(row) };
}
