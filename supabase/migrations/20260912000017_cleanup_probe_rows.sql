-- 清掉安全盤點時探測 ai-scheduler 端點所產生的 22 筆任務列。
--
-- 經過：盤點開源前的授權面時，發現 ai-scheduler 的 verify_jwt 是關的、程式碼
-- 也沒有任何金鑰檢查。用空 body 探測它是否需要授權，結果它直接執行了排程，
-- 建立 22 筆 candidate_search 任務。這些不是真實需求產生的資料，要清掉。
--
-- ai_prompts 這條管線已經停用（撿任務的 VM 關機、沒有任何程式在處理它），
-- 所以刪掉這批不影響任何運作。其餘 346 筆歷史資料保留不動。

DELETE FROM ai_prompts
WHERE created_at >= '2026-09-12T01:10:00Z'
  AND created_at <  '2026-09-12T01:12:00Z'
  AND task_type = 'candidate_search'
  AND status = 'pending';
