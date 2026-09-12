-- 把探測用的貢獻標成退件，不要留在正式佇列裡。
--
-- 我在驗證 roster_check 整條路時，用 xiaoliang-roster 這個代號送了一筆嘉義縣的
-- 清查回報。它需要 1 票才會落庫，但沒人能投——自我投票檢查會擋掉我自己，
-- 而那個代號不是任何人在用的。結果它會永遠停在待驗證，順便讓嘉義縣的清查任務
-- 一直被重複派出去。
--
-- 標成 rejected 而不是 DELETE：這個系統對「不採用」的處理就是退件並留下理由，
-- 探測資料也該照同一套規矩走，紀錄留著才看得出發生過什麼。

UPDATE contributions
SET status = 'rejected',
    review_notes = '探測資料：驗證 roster_check 端到端流程時送出的，不是真實清查結果（cec_count 留空、未實際打開中選會名單）。退件以免佔住佇列並讓該縣市的清查任務被重複派出。'
WHERE agent_name IN ('xiaoliang-roster', 'xiaoliang-probe')
  AND status = 'pending';
