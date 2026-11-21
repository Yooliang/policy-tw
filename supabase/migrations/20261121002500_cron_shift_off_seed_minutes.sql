-- pg_cron：把 9 支被 seed 卡住的工作搬離整十分鐘（維護者交辦 2026-11-21）。只改排程，不動資料、不動函數。
--
-- 根因（2026-11-21 唯讀查正式庫）：
--   seed-auto-task-queue-10min 每 10 分鐘（:00/:10/…/:50）跑約 25 秒。
--   同一分鐘排到的其他 pg_cron 工作要等它；等完就以 `job startup timeout` 失敗，而且 pg_cron 不補跑。
--   cron.max_running_jobs = 32、worker 沒滿、連線全 idle，所以不是資源不足，純粹是「同一分鐘排在 seed 後面」。
--   近 24 小時漏跑（失敗次數／應跑次數）：
--     pipeline-snapshot-hourly 9/24、policy-jp-pipeline-snapshot-hourly 9/24、policy-jp-vote-baseline-hourly 9/24、
--     system-one-legacy-30min 7/48、system-one-bio-gaps-hourly 7/24、cec-roster-mirror-5min 7/48、
--     news-fetch-hourly 6/24、roster-group-tasks-hourly 6/24、cec-sync-settle-6h 2/4。
--   11-19 的 20261119160000_db_tuning.sql 已把 16 支錯開，但這 9 支當時刻意沒動（整點快照怕歸屬漂掉、mirror 有時段）
--   或搬到另一個整十分鐘（legacy 20,50、vote-baseline 30、news-fetch 10），仍然撞 seed。
--
-- 分配表（舊 → 新；全部避開 0/10/20/30/40/50；時間皆 UTC，跟 cron.job 一致）：
--     job                                    舊                  新
--     pipeline-snapshot-hourly               0 * * * *           11 * * * *
--     policy-jp-pipeline-snapshot-hourly     0 * * * *           13 * * * *
--     policy-jp-vote-baseline-hourly         30 * * * *          33 * * * *     （仍在 jp 快照之後）
--     news-fetch-hourly                      10 * * * *          43 * * * *
--     system-one-legacy-30min                20,50 * * * *       26,56 * * * *
--     system-one-bio-gaps-hourly             40 * * * *          53 * * * *
--     roster-group-tasks-hourly              50 * * * *          55 * * * *
--     cec-roster-mirror-5min                 */5 18-21 * * *     2-57/5 18-21 * * *   （:02、:07、:12 … :57；仍是 UTC 18–21 點每 5 分鐘）
--     cec-sync-settle-6h                     20 */6 * * *        36 */6 * * *
--   挑法：快照兩支分開在不同分鐘（各自都是讀整批的重工作）；其餘落在原本只有 3 支啟動的分鐘；不與 mirror 的 :02/:07 尾數重疊的分鐘優先。
--   任一分鐘最多 5 支（:55、:36 與 mirror 在 18–21 點的 :07/:22 等分鐘），沒有任何一支與 seed 同分鐘。
--   快照每小時仍各一筆，只是 taken_at 由整點變成 :11／:13；趨勢圖按 taken_at 畫點，不受影響。
--   roster-group-tasks-hourly 與 cec-roster-mirror-5min 沒有先後依賴（掃描只看已入庫的名單），順序不需保持。
--
-- 不動的：seed-auto-task-queue-10min（維持 */10）、11-19 db_tuning 已錯開的 16 支、所有每日／每週 job。
-- 寫法比照 20261119160000_db_tuning.sql：以 jobname 查 jobid 再 cron.alter_job（不寫死 id）；
--   job 不存在（PGlite／本機沒有 pg_cron）就略過；已經是新排程的不重複 alter（冪等）。command 一個字都沒動。
-- 回滾＝再寫一支 migration，把上表「新」改回「舊」（同一段 DO 區塊換 VALUES 即可）。
-- 引用到的既有物件：cron.job（jobid、jobname、schedule）、cron.alter_job（2026-11-21 唯讀查正式庫確認 9 支都存在）。

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.alter_job(j.jobid, schedule := m.new_schedule)
  FROM (VALUES
    ('pipeline-snapshot-hourly', '11 * * * *'),
    ('policy-jp-pipeline-snapshot-hourly', '13 * * * *'),
    ('policy-jp-vote-baseline-hourly', '33 * * * *'),
    ('news-fetch-hourly', '43 * * * *'),
    ('system-one-legacy-30min', '26,56 * * * *'),
    ('system-one-bio-gaps-hourly', '53 * * * *'),
    ('roster-group-tasks-hourly', '55 * * * *'),
    ('cec-roster-mirror-5min', '2-57/5 18-21 * * *'),
    ('cec-sync-settle-6h', '36 */6 * * *')
  ) AS m(jobname, new_schedule)
  JOIN cron.job j ON j.jobname = m.jobname
  WHERE j.schedule IS DISTINCT FROM m.new_schedule;
END;
$$;
