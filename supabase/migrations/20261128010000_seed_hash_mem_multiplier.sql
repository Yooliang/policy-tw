-- seed 一輪的記憶體尖峰減壓：兩支函式的 hash_mem_multiplier 由預設 2 降到 1
-- 只用 ALTER FUNCTION 改函式層級設定，不重寫任何函式本體，work_mem 字面（16MB）不動。
--
-- 為什麼：
--   Supabase Postgres（Medium 4 GB）11-27 重啟四次，每次都是 pg_cron 的 seed_auto_task_queue() 開跑時記憶體撞頂。
--   靜態分析：seed 與總表 contribution_auto_tasks_arms() 在函式層級 work_mem=16MB 下，
--   Hash 節點的上限是 work_mem × hash_mem_multiplier（預設 2）＝32 MB；
--   總表那句 arms_all 同時存活約 5 個 hash 連接，refresh_dispatch_blocked 約 6 個 HashAgg。
--   把 multiplier 設 1，Hash 節點上限降到 16 MB（仍高於 11-19 減負前的 7MB×2＝14MB）；Sort、物化 CTE 仍是 16 MB。
--
-- 預估：
--   記憶體尖峰降約 80～160 MB。seed 可能慢幾秒（Hash 多一輪分批落盤）。
--
-- 怎麼驗（上線後 3 小時、不碰寫入）：
--   1) seed_arm_timings：stage:total 的平均與最大值，對照上線前 24 小時；平均多出 > 10 秒就回滾。
--   2) pg_stat_statements：seed 相關語句 temp_blks_written 前後比；增量大但秒數沒變＝只是多落盤，可接受。
--   3) Reports：每 10 分鐘 seed 開跑那一刻的實體記憶體與 Committed_AS，對照上線前同時段。
--
-- 注意：之後任何 CREATE OR REPLACE 這兩支函式都會洗掉所有函式設定（含 work_mem、statement_timeout）。
--   重定義時本體要帶 SET hash_mem_multiplier = '1'，或其後再 ALTER 一次；守門測試 seed-hash-mem.test.ts 擋。
--
-- 每日呼叫量變化：0（沒有新增排程、觸發器、對外呼叫）
--
-- 回滾（不用重貼任何函式本體；RESET 只清該 key，不動 work_mem 與 statement_timeout）：
--   ALTER FUNCTION public.seed_auto_task_queue() RESET hash_mem_multiplier;
--   ALTER FUNCTION public.contribution_auto_tasks_arms() RESET hash_mem_multiplier;

ALTER FUNCTION public.seed_auto_task_queue() SET hash_mem_multiplier = '1';
ALTER FUNCTION public.contribution_auto_tasks_arms() SET hash_mem_multiplier = '1';

-- 自我檢查：設定真的寫進 proconfig，且原本的 work_mem 沒被洗掉
DO $$
DECLARE r RECORD; v_bad TEXT := '';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::TEXT AS f, p.proconfig
      FROM pg_proc p
     WHERE p.oid IN ('public.seed_auto_task_queue()'::regprocedure, 'public.contribution_auto_tasks_arms()'::regprocedure)
  LOOP
    IF NOT ('hash_mem_multiplier=1' = ANY (COALESCE(r.proconfig, ARRAY[]::TEXT[]))) THEN v_bad := v_bad || ' ' || r.f; END IF;
    IF NOT ('work_mem=16MB' = ANY (COALESCE(r.proconfig, ARRAY[]::TEXT[]))) THEN v_bad := v_bad || ' ' || r.f || '(work_mem)'; END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION 'hash_mem_multiplier 設定沒寫進去或 work_mem 被洗掉：%', v_bad; END IF;
END $$;
