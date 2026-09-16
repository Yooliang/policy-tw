-- 還原 2026-09-17 第一次實跑 cec-verify 造成的副作用。
--
-- 那一版把「中選會出生年對得上」的貢獻標成 verified 後交給既有落庫流程，但落庫要靠
-- 投票的 resolved_politician_id 指認身份，而自動查證不投票；我們資料庫裡「吳品叡」有兩筆
-- 同名、「邱建富」也有，於是這兩筆被判成 disputed、各自開了一個裁決任務。
--
-- 程式已經修好（cec-verify 在我們這邊身份不明時就不碰，確定身份時把 politician_id 傳給落庫）。
-- 這裡把資料復原成實跑之前的樣子：兩筆回到 pending，兩個裁決任務關閉。
-- 只動這兩筆與這兩個任務，用 id 指名，不做條件式批次。

UPDATE contributions
   SET status = 'pending',
       review_notes = NULL,
       reviewed_by = NULL,
       reviewed_at = NULL,
       verified_at = NULL
 WHERE id IN ('e02e0c2a-8d40-4152-8653-cccbc2b98918', 'd0f69dd2-be28-4b30-800b-d95f57125627')
   AND status = 'disputed';

UPDATE contribution_tasks
   SET status = 'closed', closed_at = now()
 WHERE task_type = 'adjudicate'
   AND status = 'open'
   AND target->>'contribution_id' IN ('e02e0c2a-8d40-4152-8653-cccbc2b98918', 'd0f69dd2-be28-4b30-800b-d95f57125627');
