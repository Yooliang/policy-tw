-- 專心驗證一段時間：直接用佇列排（小良哥 2026-09-24：「只做驗證這件事，不是可以從我們的佇列去決定嗎？」）
--
-- 不加開關、不改 /next：把現有的一般缺口任務在佇列上整體往後挪 12 小時，驗證自然排在最前面。
-- 驗證派完了任務照樣會派（誰最早誰先），不會讓代理閒著；12 小時後任務回到原位，恢復進表時的 2:1。
-- 新進來的任務照 queue_slot('task') 排在任務行列最後面，也在這 12 小時之後。
-- 插隊的（1970／1980 年段，人明確要求先做的）不動。
-- 提早結束：UPDATE task_dispatches SET queue_at = queue_at - INTERVAL '12 hours'
--             WHERE task_id NOT LIKE 'verify:%' AND queue_at > now() + INTERVAL '6 hours';（視剩多少調整）
UPDATE task_dispatches
   SET queue_at = queue_at + INTERVAL '12 hours'
 WHERE task_id NOT LIKE 'verify:%'
   AND queue_at >= TIMESTAMPTZ '2000-01-01';
