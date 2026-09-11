-- ============================================================
-- 軟認領（lease）：/next 派出的任務 30 分鐘內不再派給其他 agent_name；/report 提交後釋放。
-- 以 target_key（politician_id 或 policy_id；手動任務用 task_id）為單位，同一目標不同任務類型也算同一個認領。
-- 沒有金鑰、認領只是「軟」的：過期自動失效，同一 agent 重領同一筆會延長。
-- ============================================================
CREATE TABLE IF NOT EXISTS contribution_task_leases (
  task_id       TEXT PRIMARY KEY,
  target_key    TEXT NOT NULL,
  agent_name    TEXT NOT NULL,
  ip_hash       TEXT NOT NULL,
  leased_until  TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE contribution_task_leases IS '/next 派工軟認領：leased_until 內同一 target_key 不派給其他代理；/report 帶 task_id 提交後刪除';
CREATE INDEX IF NOT EXISTS idx_task_leases_target_until ON contribution_task_leases (target_key, leased_until);
CREATE INDEX IF NOT EXISTS idx_task_leases_until ON contribution_task_leases (leased_until);
ALTER TABLE contribution_task_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role all" ON contribution_task_leases;
CREATE POLICY "Service role all" ON contribution_task_leases FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 順手清過期（/next 每次也會刪）
CREATE OR REPLACE FUNCTION contribution_task_leases_purge() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  DELETE FROM contribution_task_leases WHERE leased_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
