-- 台灣站 vote_baseline 重算接回每小時排程（維護者裁示「補」，2026-11-21）。只加排程並重算一次統計值，不改資料表結構。
--
-- 背景：
--   vote_baseline（單列 id=1）＝近 30 天已結案、至少 1 票的交件平均票數，是「投太多輪」停派線的基準（倍數在 queue_settings）。
--   由 public.contribution_vote_baseline_refresh() 重算，原本掛在 overvoted-tick-10min（contribution_overvoted_tick() 內呼叫）。
--   20261101010000_stop_dead_schedules.sql 把 overvoted-tick 停了，當時判斷「基準刷新就是 overvoted-tick 本身、沒有獨立排程」，
--   結果基準從 2026-10-17 起沒再更新（computed_at 停在 10-17），之後的交件分布變了也不會跟著動。
--   contribution_vote_baseline() 只要讀得到單列就用舊列，所以凍住不會報錯、只會讓停派線基於過時平均。
-- 做法：
--   1. 新增獨立排程 vote-baseline-hourly，每小時 :49 重算一次（照日本站 policy-jp-vote-baseline-hourly）。
--      基準是 30 天平均，不需要 10 分鐘那麼密。分鐘避開 seed（每 10 分整點跑約 25 秒，同分鐘會 startup timeout，見 20261121002500）。
--   2. 這支 migration 內立刻重算一次，讓基準馬上追上現況。
-- 回滾：SELECT cron.unschedule('vote-baseline-hourly');（基準會再凍住，值保留最後一次重算的結果）。
-- 引用到的既有物件：public.contribution_vote_baseline_refresh()（2026-11-21 唯讀查正式庫確認存在、無參數）、vote_baseline、cron.schedule/unschedule。

SELECT public.contribution_vote_baseline_refresh();

-- pg_cron 不在的環境（本機、測試）略過；重跑先 unschedule 再 schedule，只留一條
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('vote-baseline-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vote-baseline-hourly')$q$;
    EXECUTE $q$SELECT cron.schedule('vote-baseline-hourly', '49 * * * *', 'SELECT public.contribution_vote_baseline_refresh();')$q$;
  END IF;
END $$;
