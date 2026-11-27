-- pg_cron：dispatch-gap-shadow-compare-hourly 由每小時 :48 移到 :42（只改分鐘，函式與參數原樣）。2026-11-27
--
-- 理由：11-27 04:48、05:48、12:48 三次，strong-lane-sweep-10min、system-one-vote-budget-10min、reassign-check-10min 等
--   每 10 分鐘 job 在 :48 回 `job startup timeout`。:48 這一分鐘本來就有 4 支 `8,18,28,38,48,58` 的 job
--   （reassign-check、strong-lane-sweep、system-one-vote-budget、system-one-identity），shadow-compare 是第 5 支，
--   第 0 期計畫已寫過「再發就移到別的分鐘」。
-- 為什麼是 :42 不是 :53（唯讀盤點 migrations 內每支 job 最後一筆排程）：
--   :53 有 source-archive-10min、cand-no-auto-10min、policy-jp-stat-registry-verify、system-one-bio-gaps-hourly、
--     queue-task-counts-refresh（奇數分鐘）＝5 支，再加 shadow-compare 就 6 支，超過 20261119160000 訂的「每分鐘最多 4 支」。
--   :51（quota-snapshots、followup-clarify、backfill-15min、evidence-5min、queue-task-counts＝5 支）與
--     :57（cec-verify、roster-reconcile、cec-results-auto、queue-task-counts＝4 支）也不是空的。
--   :42 只有 roster-reconcile-units-10min、roster-batch-10min、policy-jp-lg-registry-verify 三支（UTC 18–21 點再多
--     cec-roster-mirror-5min 一支），加上本 job 最多 4 支；且是偶數、非整十、非 :29／:35，符合 20261126180000 的排程慣例
--     （奇數分鐘留給 queue-task-counts-refresh）。
-- 每日呼叫量變化：0（同一支 job 換分鐘）。pg_cron 以 UTC 計，分鐘不受時區影響。
-- 回滾：再寫一支 migration，把下面的 '42 * * * *' 改回 '48 * * * *'。

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('dispatch-gap-shadow-compare-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-gap-shadow-compare-hourly')$q$;
    EXECUTE $q$SELECT cron.schedule('dispatch-gap-shadow-compare-hourly', '42 * * * *', 'SET statement_timeout TO ''120s''; SELECT dispatch_gap_shadow_run();')$q$;
  END IF;
END $$;
