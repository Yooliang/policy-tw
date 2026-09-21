-- 派發即綁定（使用者 2026-09-21：「這是任務派發的問題，不是投票的問題」）。
--
-- 現況：/verifications 可以一次列 50 筆讓代理自己挑，而 contributions-feed 是公開的、
-- id 拿得到——所以光關掉端點擋不住。跑任務的伙伴實測示範過：它用同一份官方 PDF
-- 對 16 筆投了同樣的票。使用者的裁示是從派發解，不在投票端補防線。
--
-- 所以記下「伺服器把哪一筆派給了哪個來源 IP」，投票時要求對得上。
--
-- 為什麼不沿用 contribution_task_leases：那張表的 task_id 是主鍵，一筆任務同時只有
-- 一個認領者——任務該這樣，驗證不該。驗證本來就要好幾個人各自看。
--
-- 順帶解掉另一件事：這張表就是「這一筆派給過誰、什麼時候」，
-- 之後要把驗證池改成「派過的排到後面」（避免同一批一直排在最前面）靠的就是它。

CREATE TABLE IF NOT EXISTS verify_dispatches (
  contribution_id UUID        NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  ip_hash         TEXT        NOT NULL,
  agent_name      TEXT,
  dispatched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contribution_id, ip_hash)
);

-- 派工排序要問「這一筆最後一次派出去是什麼時候」
CREATE INDEX IF NOT EXISTS verify_dispatches_recent ON verify_dispatches (contribution_id, dispatched_at DESC);
-- 投票時要問「這個 IP 有沒有被派過這一筆」
CREATE INDEX IF NOT EXISTS verify_dispatches_by_ip ON verify_dispatches (ip_hash, dispatched_at DESC);

ALTER TABLE verify_dispatches ENABLE ROW LEVEL SECURITY;
-- 公開讀（跟其他表一致）；寫入只走 service role
DROP POLICY IF EXISTS verify_dispatches_read ON verify_dispatches;
CREATE POLICY verify_dispatches_read ON verify_dispatches FOR SELECT USING (true);

COMMENT ON TABLE verify_dispatches IS
  '伺服器把哪一筆待驗證派給了哪個來源 IP。投票時要求對得上——派發是唯一的工作來源，代理不能自己挑題目。同時是「這一筆最後何時派出」的依據。';
