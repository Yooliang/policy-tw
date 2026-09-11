-- ============================================================
-- 任務來源與外部提議：
--   contribution_tasks 加 source（manual／suggested／web_request）、suggested_by、hint_sources、requester_ip_hash、closed_at
--   contributions.contribution_type 加 task_suggestion（外部代理提議任務，2 票通過 → 自動 insert 成 open 任務）
-- ============================================================
ALTER TABLE contribution_tasks
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'suggested', 'web_request')),
  ADD COLUMN IF NOT EXISTS suggested_by TEXT,
  ADD COLUMN IF NOT EXISTS hint_sources TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS requester_ip_hash TEXT,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
COMMENT ON COLUMN contribution_tasks.source IS 'manual＝維護者建；suggested＝外部 task_suggestion 通過驗證自動建；web_request＝網站「請 AI 幫忙查」按鈕建';
COMMENT ON COLUMN contribution_tasks.priority IS '/next 派手動任務時依 priority DESC；維護者預設 1、web_request 預設 0（低於維護者、高於自動缺口）';
CREATE INDEX IF NOT EXISTS idx_contribution_tasks_source_status ON contribution_tasks (source, status);
CREATE INDEX IF NOT EXISTS idx_contribution_tasks_requester_day ON contribution_tasks (requester_ip_hash, created_at);

ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion'));
