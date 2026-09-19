-- 身份鍵 actor_id：第 1 步，只加欄位與回填，不改任何行為。設計見 docs/BLUEPRINT-agent-identity.md §5、§8。
--
-- 為什麼要一個獨立的身份鍵，而不是繼續用 agent_name／IP 雜湊：
--   agent_name 是自報的、可以共用；IP 雜湊一個人兩台機器會變兩個人、一台機器兩個人會變一個人。
--   之後 DiTurst 帳號進來（actor_id = 'dtrust:<agent_id>'）要跟匿名（'ip:<雜湊>'）放在同一個欄位比，
--   去重、排除、額度、貢獻榜、「我的貢獻」才有一個統一的鍵可看。
--
-- 這一步之後伺服器每筆寫入都帶 actor_id（contribute-handler／verify-handler）；舊資料回填成 ip:<雜湊>。
-- 格式：<等級>:<鍵>。等級目前只有 ip；dtrust 等 DiTurst 的 verify 端點上線後才會出現。

ALTER TABLE contributions      ADD COLUMN IF NOT EXISTS actor_id TEXT;
ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS actor_id TEXT;

UPDATE contributions      SET actor_id = 'ip:' || contributor_ip_hash
  WHERE actor_id IS NULL AND contributor_ip_hash IS NOT NULL;
UPDATE contribution_votes SET actor_id = 'ip:' || verifier_ip_hash
  WHERE actor_id IS NULL AND verifier_ip_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS contributions_actor_idx      ON contributions (actor_id);
CREATE INDEX IF NOT EXISTS contribution_votes_actor_idx ON contribution_votes (actor_id);

COMMENT ON COLUMN contributions.actor_id IS
  '身份鍵 <等級>:<鍵>。ip:<雜湊>＝匿名；dtrust:<agent_id>＝DiTurst 帳號。去重與歸戶看這個，agent_name 只給人看';
COMMENT ON COLUMN contribution_votes.actor_id IS
  '同 contributions.actor_id';
