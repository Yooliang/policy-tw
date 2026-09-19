-- 第二來源判定端點（使用者 2026-09-19：「jev 提供端點，別給 key」）。
--
-- 代理找到第二個來源後，不用自己拿 OpenRouter 金鑰問 Jev：POST system-one?action=judge { contribution_id, url }，
-- 伺服器自己抓那一頁（代理只能給網址、不能餵假文本）、用同一套「每欄一題」判定、記進 jev_decisions，回每欄結果。
-- 這不是系統票：question 用 second_source 跟 source_support 分開，contribution_system_vote 只看 source_support。
-- 票還是代理投的，evidence_url 放那個網址；判定紀錄讓對帳時看得到「這張票背後的第二來源 Jev 怎麼說」。
--
-- 成本守法：不帶金鑰的公開端點，按來源 IP 雜湊記 requester_ip_hash，每 IP 每 10 分鐘上限＋全域 10 分鐘上限（端點裡）。

ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source'));

ALTER TABLE jev_decisions ADD COLUMN IF NOT EXISTS requester_ip_hash TEXT;
CREATE INDEX IF NOT EXISTS jev_decisions_requester_idx ON jev_decisions (requester_ip_hash, asked_at DESC);

COMMENT ON COLUMN jev_decisions.requester_ip_hash IS
  'judge 動作的呼叫端來源 IP 雜湊（配額用）；系統自己的判定為 NULL';
