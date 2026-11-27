-- pg_cron：把與 seed 同分鐘（或前一、後一分鐘）起跑的整表重算類排程錯開（2026-11-27 13:56 資料庫記憶體撞頂重啟的直接對策）。只改排程，不動資料、不動函數、不動 command。
--
-- 背景（Supabase 後台實測 2026-11-27）：UTC 05:49～05:50 同一分鐘內 regions_elected_policy_count_refresh、candidacy_map_refresh_all、
--   queue_task_counts_refresh 與 05:50 的 seed_auto_task_queue（每 10 分鐘、約 60～120 秒、CTE 很大）疊加，05:51 記憶體 3.66／3.73 GB、承諾 5.0 GB、
--   swap 784 MB，連線池掉線，05:56 重啟。11-19 的資料庫減負（20261119160000）也是記憶體問題，當時只把 16 支週期 job 錯開起始分鐘，
--   這三支沒有在名單內，仍落在 :x9（seed 前一分鐘）與 :x1（seed 後一分鐘）。
--
-- 分配表（舊 → 新；時間皆 UTC，與 cron.job 一致）：
--     job                                  舊（分鐘欄）                                                    新
--     regions-elected-policy-count-10min   9,19,29,39,49,59                                              8,18,28,38,47,58
--     candidacy-map-stats-10min            9,19,29,39,49,59                                              6,16,26,36,46,56
--     queue-task-counts-refresh            1,3,5,7,9,11,13,15,17,19,21,23,25,27,31,33,37,39,41,          2,3,5,7,12,13,15,17,22,23,25,27,32,33,37,
--                                          43,45,47,49,51,53,55,57,59（28 次／小時）                       42,43,45,52,53,57（21 次／小時）
--   後面的欄位（時、日、月、週）三支都是 `* * * *`，不動。
--   - 三支都不再落在 :x9、:x0、:x1；seed 在 :x0 起跑，最長約 120 秒，:x2 起才有別的整表重算開始。
--   - regions 用 :x8（第六次放 :47，避開 :48）；candidacy 用 :x6；兩支各自的 10 分鐘間隔不變（regions 有一個 9 分、一個 11 分間隔）。
--   - queue-task-counts-refresh：:x1 搬到 :x2（6 次）、:x9 的 5 次不補（原 :29 本來就沒跑）、:47 讓給 regions（兩支重 job 不同分鐘）、:55 讓出（該分鐘已有 5 支每小時都跑的 job）；
--     一小時從 28 次降到 21 次，最長間隔 7 分鐘，遠小於 contribution_queue_task_counts 的保底門檻（小表超過 10 分鐘沒刷新才退回即時算）。
--   - 搬完這三支各自新分鐘的每小時啟動數（唯讀盤點，含每小時都跑的全部 job）：regions 的 :x8 與 :47 各 5、candidacy 的 :x6 各 5，
--     queue 的 :x2 為 4～5（:42、:22、:52 為 5）；沒有任何分鐘比原本最擠的 :55（6）更多。
--   - 每日／每週才跑一次的 job（含 cec-sync 週六那批）不在上面計數；這三支以外沒有落在 :x9／:x0／:x1 的整表重算類排程。
--   - 順帶一提：policy-jp-seed-10min（:x9，日本站的 seed）、apply-verified-10min、quota-snapshots-10min、system-one-followup-clarify-10min（:x1）不在本次範圍，
--     它們不是整表重算；若之後記憶體再撞頂，下一個該看的是 policy-jp-seed-10min。
--
-- 寫法比照 20261121002500／20261122130000：以 jobname 查 jobid 再 cron.alter_job，只換 schedule，command 一字不動（排程 command 在原 migration 裡，
--   這裡不重抄一份，避免抄錯）；沒有 pg_cron（PGlite／本機）就略過；冪等（排程已是新值就不動）。
--
-- 每日呼叫量變化：queue-task-counts-refresh 每天少 168 次（7 次／小時 × 24），其餘兩支次數不變，合計 -168／天。
--
-- 回滾＝再寫一支 migration，把上表「新」改回「舊」（原排程字串如下，可直接貼）：
--   regions-elected-policy-count-10min  '9,19,29,39,49,59 * * * *'
--   candidacy-map-stats-10min           '9,19,29,39,49,59 * * * *'
--   queue-task-counts-refresh           '1,3,5,7,9,11,13,15,17,19,21,23,25,27,31,33,37,39,41,43,45,47,49,51,53,55,57,59 * * * *'
-- 引用到的既有物件：cron.job（jobid、jobname、schedule）、cron.alter_job（2026-11-27 以 migration 檔確認三支都已建立）。

DO $$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RETURN;
  END IF;
  PERFORM cron.alter_job(j.jobid, schedule := m.new_schedule)
  FROM (VALUES
    ('regions-elected-policy-count-10min', '8,18,28,38,47,58 * * * *'),
    ('candidacy-map-stats-10min', '6,16,26,36,46,56 * * * *'),
    ('queue-task-counts-refresh', '2,3,5,7,12,13,15,17,22,23,25,27,32,33,37,42,43,45,52,53,57 * * * *')
  ) AS m(jobname, new_schedule)
  JOIN cron.job j ON j.jobname = m.jobname
  WHERE j.schedule IS DISTINCT FROM m.new_schedule;
END $$;
