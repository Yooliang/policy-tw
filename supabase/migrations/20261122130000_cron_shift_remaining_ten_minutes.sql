-- pg_cron：剩下 10 支落在整十分鐘的工作全部搬開（維護者 2026-11-22：所有 cron 不排 0/10/20/30/40/50 分）。只改排程，不動資料、不動函數。
--
-- 背景：#1022、#1028 搬完後，2026-11-22 唯讀查正式庫 cron.job 全表，只剩下面這 10 支（seed-auto-task-queue-10min 本身除外）仍落在整十分鐘；
--   seed 每 10 分鐘跑約 25～40 秒，同分鐘的工作會 `job startup timeout` 且不補跑。
--
-- 分配表（舊 → 新；時間皆 UTC，與 cron.job 一致）：
--     job                              舊                新
--     cec-sync-2022-weekly             0 19 * * 6        3 19 * * 6
--     cec-sync-2022-rest               5,10 19 * * 6     7,12 19 * * 6      （仍在 2022-weekly 之後；與 #1028 的 1,6,11,16,21 不重疊）
--     cec-reconcile-weekly             30 20 * * 6       33 20 * * 6
--     news-items-retention-weekly      30 20 * * 6       37 20 * * 6        （兩支互無先後依賴：一個開任務、一個瘦身新聞列；錯開只為不同時搶連線）
--     gate-rejections-purge            40 19 * * *       42 19 * * *
--     policy-jp-news-purge-daily       40 19 * * *       47 19 * * *
--     dispatch-records-purge           50 19 * * *       52 19 * * *
--     moi-sync-daily                   20 20 * * *       22 20 * * *
--     moi-avatar-import-daily          50 20 * * *       52 20 * * *        （仍在 moi-sync-daily 之後）
--     ditrust-purge-rate-limits-daily  20 3 * * *        22 3 * * *
--
-- 寫法比照 20261121002500：以 jobname 查 jobid 再 cron.alter_job，command 不動；沒有 pg_cron（PGlite／本機）就略過；冪等。
-- 回滾＝再寫一支 migration，把上表「新」改回「舊」。
-- 引用到的既有物件：cron.job（jobid、jobname、schedule）、cron.alter_job（2026-11-22 唯讀查正式庫確認 10 支都存在）。

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.alter_job(j.jobid, schedule := m.new_schedule)
  FROM (VALUES
    ('cec-sync-2022-weekly', '3 19 * * 6'),
    ('cec-sync-2022-rest', '7,12 19 * * 6'),
    ('cec-reconcile-weekly', '33 20 * * 6'),
    ('news-items-retention-weekly', '37 20 * * 6'),
    ('gate-rejections-purge', '42 19 * * *'),
    ('policy-jp-news-purge-daily', '47 19 * * *'),
    ('dispatch-records-purge', '52 19 * * *'),
    ('moi-sync-daily', '22 20 * * *'),
    ('moi-avatar-import-daily', '52 20 * * *'),
    ('ditrust-purge-rate-limits-daily', '22 3 * * *')
  ) AS m(jobname, new_schedule)
  JOIN cron.job j ON j.jobname = m.jobname
  WHERE j.schedule IS DISTINCT FROM m.new_schedule;
END $$;
