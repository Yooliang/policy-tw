-- merge_politician 型別在 TS 的 CONTRIBUTION_TYPES 裡，但 contributions.contribution_type 的 CHECK 沒跟上（#98 的疏漏）：
-- 代理查明同名是同一人、交 merge_politician 卻被約束擋下，只好退回 no_change（他們的備註寫得很清楚）。
-- 派出 19 個 duplicate_politician 任務、0 筆合併，全是這個原因。thresholds.test 現在會盯這個 CHECK 跟 TS 一致。

ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician'));
