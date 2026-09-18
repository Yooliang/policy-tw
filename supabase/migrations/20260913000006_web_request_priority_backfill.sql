-- 回填：已經排在隊伍裡的網站訪客請求，priority 還是舊的 0。
--
-- 2026-09-13 指出民眾提問沒有被優先領走。修法有兩段：
--   1. dispatch.ts 的 pickManualTask 改成「先取 priority 最高那一層」（改之前是整池隨機，
--      所以撈任務時的 .order("priority") 與提問的表態排序都是白寫的）
--   2. task-admin.ts 的 DEFAULT_PRIORITY 把 source='web_request' 設成 3（有真人在等）
--
-- 但那兩段只影響「之後才建的」任務。他貼給我看的那兩筆提問是今天早上建的，
-- priority 還是 0，會繼續排在 8 筆裁決（priority 2）後面。所以這裡回填。
--
-- 只動 open 的：已關閉的任務改 priority 沒有意義，也不要去動歷史紀錄。

UPDATE contribution_tasks
   SET priority = 3
 WHERE status = 'open'
   AND source = 'web_request'
   AND priority < 3;

-- 另一件事：「這不是政見？」那顆按鈕在 2026-09-13 之前建的是 task_type='question'，
-- 代理只會回一段文字貼在提問下面，那筆不像政見的資料不會被移除。
-- 回饋：「這個也有型別的吧，也是會更新資料的吧」。按鈕已經改成建 policy_validity，
-- 這裡把已經排隊的那幾筆一起換過去，否則它們還是只會收到一段文字。
--
-- 認得出來是因為那句話是按鈕預先填好的固定句型（見 lib/ask-links.ts 的 askNotAPolicy），
-- 不是訪客自己打的。這是一次性的資料修正，不是一條會重複套用的規則。
UPDATE contribution_tasks
   SET task_type = 'policy_validity'
 WHERE status = 'open'
   AND source = 'web_request'
   AND task_type = 'question'
   AND target ? 'policy_id'
   AND description LIKE '%這筆看起來不像政見%';
