-- 新聞追蹤的保存：每週瘦身、三年刪除（維護者 2026-10-03 裁示）
--
-- 量（2026-10-03，09-29 起 3.9 天、7,273 則）：每天約 1,844 則；96.3% 判定無關／沒提到人名，3.7% 相關。
-- 原本完全沒有清理，三年約 202 萬則、約 1.5 GB。每則完整一列約 730 bytes（網址 100、標題 82、摘要 268、判定 JSON 80 ＋固定欄位＋網址唯一索引）。
--
-- 初篩完之後標題、摘要、判定細節就用不到了：
--   · 無關的不會再被讀
--   · 相關的開任務時已經把網址、標題、來源、發布時間、對應人物與政見複製進任務（system-one 的 newsTaskOf），
--     任務被派出與執行時不回頭讀 news_items；網站頁面也沒有顯示新聞標題摘要，只有統計
--   · 統計（news_daily_stats）只用 fetched_at、screen->>'result'、task_id
-- 但網址要留：url 唯一索引就是去重，RSS 會在 feed 裡留同一則好幾天，刪了會被重新收進來、再花一次初篩。
--
-- ① 每週瘦身：收錄超過 7 天、已初篩完的，清掉標題（NOT NULL，清成空字串）、摘要、判定細節（只留 result 代碼）。
--    保留：網址、來源、收錄時間、發布時間、判定代碼、任務編號 → 去重與統計照常。
--    例外不清：
--      · 判定中（screen->>'result' = 'screening'）—— 初篩卡住的會被 system-one 30 分鐘後放回重判，要有標題
--      · 相關但延後開任務、還沒開的（screen->>'deferred' = 'true' 且 task_id 為空）—— 之後要拿標題補開
--    7 天緩衝：要回頭看某則原標題摘要還來得及。
-- ② 三年刪除：收錄超過 3 年的整列刪掉。三年前的新聞 RSS 不會再抓回來，不會造成重複初篩。
--    任務那邊存的是新聞內容的複本（JSON），沒有外鍵指回來，刪了不影響任務。
--
-- 三年量體估計：約 550 MB（瘦身後每則約 270 bytes），之後穩定不再長。估計誤差約 ±30%。

CREATE OR REPLACE FUNCTION news_items_slim() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE news_items
     SET title = '',
         summary = NULL,
         screen = jsonb_build_object('result', screen->>'result')
   WHERE screened_at IS NOT NULL
     AND fetched_at < now() - interval '7 days'
     AND screen->>'result' IS DISTINCT FROM 'screening'
     AND NOT (screen->>'deferred' = 'true' AND task_id IS NULL)
     -- 已經瘦過的不再寫一次（避免每週把整張表重寫、製造無謂的死列）
     AND (title <> '' OR summary IS NOT NULL OR screen <> jsonb_build_object('result', screen->>'result'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION news_items_slim IS
  '每週：收錄超過 7 天、已初篩完的新聞清掉標題／摘要／判定細節，只留網址（去重）與統計用欄位。判定中、延後待開任務的不清。2026-10-03。';

CREATE OR REPLACE FUNCTION news_items_purge() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  DELETE FROM news_items WHERE fetched_at < now() - interval '3 years';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION news_items_purge IS '收錄超過 3 年的新聞整列刪除。2026-10-03。';

-- 每週日台北 04:30（UTC 週六 20:30）跑一次
SELECT cron.unschedule('news-items-retention-weekly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'news-items-retention-weekly');
SELECT cron.schedule('news-items-retention-weekly', '30 20 * * 6', $$
  SELECT news_items_slim();
  SELECT news_items_purge();
$$);
