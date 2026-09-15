-- 代理按 skip 跳過的任務，同一個來源 IP 在 24 小時內不再派回去（見 _shared/dispatch.ts 的 SKIP_MEMORY_HOURS）。
--
-- 2026-09-15 萬大捷運站那題提問：代理回報「反覆派過來、一直 skip」。原本 skip 只釋放當下的認領，
-- 那題又在最高優先層、只從前 3 筆裡挑，下一次 /next 馬上又抽回同一題。
-- 以 IP 為單位：跟每日額度、計票一致，同一台機器換代號仍是同一個人。

CREATE TABLE IF NOT EXISTS contribution_task_skips (
  task_id     TEXT        NOT NULL,          -- 手動任務的 uuid，或自動缺口的 auto:… 鍵
  ip_hash     TEXT        NOT NULL,
  agent_name  TEXT,
  skipped_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, ip_hash)
);
COMMENT ON TABLE contribution_task_skips IS '代理 skip 過的任務；同 IP 24 小時內不再派（/next）';
CREATE INDEX IF NOT EXISTS contribution_task_skips_ip_idx ON contribution_task_skips (ip_hash, skipped_at DESC);

-- 只有 edge function（service role）讀寫；ip_hash 不對外
ALTER TABLE contribution_task_skips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role all" ON contribution_task_skips;
CREATE POLICY "Service role all" ON contribution_task_skips FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
