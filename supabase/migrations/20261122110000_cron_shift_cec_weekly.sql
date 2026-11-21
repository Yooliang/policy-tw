-- pg_cron：每週六中選會同步三支搬離整十分鐘（#1022 漏掉的；維護者在 #1022 拍板「所有 cron 不排 0/10/20/30/40/50 分」）。只改排程，不動資料、不動函數。
--
-- 根因：seed-auto-task-queue-10min 每 10 分鐘（:00/:10/…/:50）跑約 25～40 秒，同分鐘排到的工作會 `job startup timeout` 且不補跑。
--   2026-11-22 03:xx（台北，週日；UTC 週六 19 點）這三支各失敗數筆：
--     cec-sync-weekly（:00／:10／:20 撞）、cec-sync-2022-village-rest（:10／:20 撞）、cec-sync-2024-weekly（:30 撞）。
--
-- 分配表（舊 → 新；時間皆 UTC，與 cron.job 一致；全部避開 0/10/20/30/40/50）：
--     job                           舊                       新
--     cec-sync-weekly               0,5,10,15,20 19 * * 6    1,6,11,16,21 19 * * 6
--     cec-sync-2022-village-rest    5,10,15,20 19 * * 6      6,11,16,21 19 * * 6   （跟著 weekly 同一組分鐘去掉第一個）
--     cec-sync-2024-weekly          30 19 * * 6              32 19 * * 6
--   三支彼此順序與每 5 分鐘的間隔不變。不動的：cec-sync-live-10min（4,14,…）、cec-sync-offcycle-weekly（45）。
--
-- 寫法比照 20261121002500：以 jobname 查 jobid 再 cron.alter_job，command 不動；沒有 pg_cron（PGlite／本機）就略過；冪等。
-- 回滾＝再寫一支 migration，把上表「新」改回「舊」。
-- 引用到的既有物件：cron.job（jobid、jobname）、cron.alter_job（2026-11-22 唯讀查正式庫確認三支都存在）。

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.alter_job(j.jobid, schedule := m.new_schedule)
  FROM (VALUES
    ('cec-sync-weekly', '1,6,11,16,21 19 * * 6'),
    ('cec-sync-2022-village-rest', '6,11,16,21 19 * * 6'),
    ('cec-sync-2024-weekly', '32 19 * * 6')
  ) AS m(jobname, new_schedule)
  JOIN cron.job j ON j.jobname = m.jobname
  WHERE j.schedule IS DISTINCT FROM m.new_schedule;
END $$;
