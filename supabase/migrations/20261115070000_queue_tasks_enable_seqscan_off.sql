-- contribution_queue_tasks 關掉 seq scan（止血，2026-11-15）
--
-- 為什麼：
--   Edge Function /next 的 timed("auto") 呼叫 contribution_queue_tasks(p_type,p_region,p_limit,p_seed,p_ip_hash,p_agent)。
--   PostgREST 傳進來的參數是非常數（json_to_record 的 LATERAL），planner 對 task_dispatches 選 Seq Scan：
--   15,811 列裡 11,810 列逐筆跑完全部過濾子查詢（租約、在途、停放、冷卻、lease_events…）才排序取 30，估 rows=1、實際 11,810。
--   走 task_dispatches_queue_at_idx 的計畫成本 666,657 對 Seq Scan 661,784，幾乎平手，統計一動就翻。
--   實測（2026-11-15 調查，同一函式、PostgREST 實際寫法）：
--     不帶 region 3,534 ms／region=屏東縣 1,436 ms／同一句加 enable_seqscan=off 後 20 ms；
--     參數寫死成字面值 5~50 ms；pg_stat_statements 上 PostgREST 呼叫 4.3 萬次、平均 428 ms、最大 7,986 ms，撞 authenticator 的 8 秒 statement_timeout。
--   結果是 /next 回「auto tasks: statement timeout」。
--
-- 做法：函式層級的 GUC，只影響這支函式內的執行計畫，不動全域設定、不動函式本體。
--   ALTER FUNCTION ... SET 可重跑（冪等）。
--
-- 這是治標：根治是把 queue_tasks 內昂貴的 NOT EXISTS 子查詢改成預先算好的 blocked／parked 欄位（refresh_dispatch_blocked 已是這做法），另開。
--
-- 回滾：
--   ALTER FUNCTION public.contribution_queue_tasks(text, text, integer, text, text, text) RESET enable_seqscan;
--
-- ⚠️ CREATE OR REPLACE FUNCTION 會把函式的 SET 設定一併換成新語句寫的（沒寫就清空）。
--   之後任何 migration 重建 contribution_queue_tasks，都要在函式定義裡加 SET enable_seqscan = off，或在其後再下一次本檔的 ALTER。
--   守門：queue-tasks-enable-seqscan.test.ts。

ALTER FUNCTION public.contribution_queue_tasks(text, text, integer, text, text, text)
  SET enable_seqscan = off;
