-- 稽核任務與「無異動」回報
--   contribution_tasks.task_type 加 audit（訪客在政見深度分析頁貼文件網址 → request-task kind=audit；target 帶 source_url）
--   contributions.contribution_type 加 no_change（代理查完發現與資料庫一致：只關閉任務、不改資料，門檻 2 票）

ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change'));

-- 同網址 24 小時去重用
CREATE INDEX IF NOT EXISTS contribution_tasks_audit_source_url_idx
  ON contribution_tasks ((target->>'source_url'), created_at DESC)
  WHERE task_type = 'audit';

COMMENT ON COLUMN contribution_tasks.task_type IS 'policy_missing／profile_gap／policy_source_missing／progress_stale／candidacy_source_missing／audit（target.source_url 是要核對的文件）／other';
