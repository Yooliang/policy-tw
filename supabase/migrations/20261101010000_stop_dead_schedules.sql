-- 停掉已確認沒在產出的排程（機制梳理 2026-11-01 第 5 節；小良哥核准「先停已死的」）。
-- 只停排程，不刪函式、不刪表、不刪臂：news_sweep_refresh_tasks() 與 vote_baseline 相關函式原樣保留。
--
-- 1) news-sweep-refresh（'15 * * * *'，SELECT news_sweep_refresh_tasks();）
--    證據（2026-11-01 唯讀查詢）：created_by='news_sweep_refresh_tasks' 累計 60 件、全為 closed、
--    最後一件建於 2026-09-28、近 7 天 0 件；已被 news-fetch＋news_screen（逐則）取代。
--    恢復：新 migration 執行
--      SELECT cron.schedule('news-sweep-refresh', '15 * * * *', 'SELECT news_sweep_refresh_tasks();');
--
-- 2) overvoted-tick-10min：10/17 已由 20261017030000 unschedule，此處只做冪等確認（不存在就什麼都不做）。
--    vote_baseline 的每 10 分鐘刷新就是 overvoted-tick 本身（contribution_overvoted_tick() 內呼叫
--    contribution_vote_baseline_refresh()），沒有獨立排程，故不需另停；
--    contribution_vote_baseline() 讀不到單列時會退回現算，/report、/next 的爭點資料與主控台不受影響。
--    恢復（需先經維護者同意，並改 overvoted-adjudication-pause.test.ts）：
--      以 20261017020100 第 220 行的排程（名稱 overvoted-tick-10min、頻率 '3,13,23,33,43,53 * * * *'、呼叫 contribution_overvoted_tick()）重新排回。

SELECT cron.unschedule('news-sweep-refresh') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'news-sweep-refresh');
SELECT cron.unschedule('overvoted-tick-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'overvoted-tick-10min');
