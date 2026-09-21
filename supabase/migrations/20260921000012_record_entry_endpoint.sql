-- 記錄代理是從哪個端點進來的（使用者 2026-09-21）。
--
-- 協議第 0 節寫著「你只要記兩個端點」：GET /next → POST /report。但另外還有四個舊端點
-- 開著：/tasks、/contribute、/verifications、/verify。其中 /contribute 與 /verify 是
-- /report 的前身（現在是純別名，呼叫同一支 handler），/verifications 是 /next 的前身
-- （它曾經有自己一份挑選邏輯，就是 2026-09-21 那個「limit=3 回 0 筆」的出處），
-- /tasks 則已經變成網站公開任務看板在用的資料來源，受眾根本不是代理。
--
-- 想收掉多餘的門，卻卡在一件事：**我們看不到誰在用它們。** 外面可能有代理照舊版
-- skill.md 在跑 /contribute，直接刪就是單方面斷人家的線，而且不會知道斷了誰。
--
-- 所以先補上「能看見」的能力，之後才憑證據收：每一筆貢獻與每一票都記下入口。
-- 不加 CHECK：端點名是開放集合，加了就變成第五處要清點的地方（CLAUDE.md 那條規約）。

ALTER TABLE contributions ADD COLUMN IF NOT EXISTS via TEXT;
ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS via TEXT;

COMMENT ON COLUMN contributions.via IS
  '這筆是從哪個端點進來的：report（主流程）／contribute（舊端點，/report 的前身）／其他。NULL＝2026-09-21 之前的舊資料。用來判斷舊端點還有沒有人在用，能不能收掉。';
COMMENT ON COLUMN contribution_votes.via IS
  '這一票是從哪個端點進來的：report（主流程）／verify（舊端點，/report 的前身）／其他。NULL＝2026-09-21 之前的舊資料。';

-- 舊端點用量一眼看完：誰還在用、最後一次什麼時候、幾個不同的代號。
-- 收掉舊門之前先看這個，看到只剩 report 才動手。
CREATE OR REPLACE VIEW endpoint_usage AS
  SELECT 'contributions' AS surface, COALESCE(via, '(2026-09-21 前)') AS via,
         COUNT(*) AS n, COUNT(DISTINCT agent_name) AS agents, MAX(created_at) AS last_seen
  FROM contributions GROUP BY 1, 2
  UNION ALL
  SELECT 'votes', COALESCE(via, '(2026-09-21 前)'),
         COUNT(*), COUNT(DISTINCT agent_name), MAX(created_at)
  FROM contribution_votes GROUP BY 1, 2;

COMMENT ON VIEW endpoint_usage IS
  '舊端點還有沒有人在用：依入口分組的筆數、不同代號數、最後一次。要收掉 /contribute、/verify、/verifications 之前先看這個。';
