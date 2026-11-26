-- /next 的「佇列各型別件數」改讀每輪刷新的小表（2026-11-26）
--
-- 為什麼：
--   /next 每次回應都呼叫 contribution_queue_task_counts(p_region)，本體是
--   「contribution_queue_tasks(NULL, p_region, 100000, '') GROUP BY task_type」＝把整條佇列（含全部合格條件）排序取 10 萬筆再數。
--   正式庫唯讀實測（2026-11-26）：pg_stat_statements 累計 84 次、平均 756 ms、最大 5.7 秒、暫存檔寫 383,050 區塊（約 3 GB，每次約 36 MB）；
--   EXPLAIN ANALYZE：不帶地區 1.6～4.1 秒、暫存讀寫各 4,560 區塊；屏東縣 261 ms。
--   Edge 端的 60 秒快取按 isolate 與地區分開，15 隻代理連續領件幾乎等於沒快取。資料庫 24 小時內因記憶體承諾值逼頂被殺 3 次。
--
-- 做法（方案 A，維護者拍板「砍流程、不加硬體」）：
--   1. 新表 queue_task_counts_cache(region_key PK, payload jsonb, refreshed_at)：每個地區一列（NULL 地區＝全部，鍵 '*'），payload＝[{task_type,total},…]。
--   2. queue_task_counts_refresh()：呼叫一次 contribution_queue_tasks(NULL, NULL, 100000, '')，用 task_dispatches.region 分組，一次寫好全部地區與全部；
--      pg_cron 約每 2 分鐘一次（奇數分鐘、避開 :x0／:29／:35）。
--   3. contribution_queue_task_counts(p_region)：簽名與回傳欄位不變，改讀小表；該地區沒有列、或列超過 10 分鐘沒刷新就退回原本即時算
--      （原本本體原封不動搬進 contribution_queue_task_counts_live）。
--
-- 語意：算法、合格條件與原本完全相同（p_ip_hash／p_agent 都是 NULL 的那一支），差別只在「最多晚約 2 分鐘」（原本 Edge 快取就最多晚 60 秒）。
-- 回傳欄位維持 (task_type, total)：沒加 refreshed_at——改 RETURNS TABLE 等於改函式簽名，要 DROP 重建、依 CLAUDE.md 要分兩次上；
-- 刷新時間看小表本身（queue_task_counts_cache.refreshed_at）。
-- Edge Function 不必改（同簽名），所以沒有部署順序問題。
--
-- 回滾（一行一行貼即可，不丟資料）：
--   SELECT cron.unschedule('queue-task-counts-refresh');
--   把對外函式（同名、同簽名）重建成 LANGUAGE sql STABLE，本體只有 SELECT * FROM contribution_queue_task_counts_live(p_region)；
--   或直接把 20261008165000 裡的原本體貼回去重建。
--   （之後可 DROP TABLE queue_task_counts_cache、DROP FUNCTION queue_task_counts_refresh()、contribution_queue_task_counts_live(text)）
--
-- 引用到的既有物件（2026-11-26 對 origin/main 確認）：contribution_queue_tasks(text,text,integer,text,text,text)（20261114080000＋20261115070000 的 SET enable_seqscan=off）、
--   task_dispatches(task_id PK, region)、pg_cron。

-- ------------------------------------------------------------
-- 1. 小表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queue_task_counts_cache (
  region_key   TEXT PRIMARY KEY,                         -- 地區名；'*'＝不分地區（p_region IS NULL）
  payload      JSONB NOT NULL DEFAULT '[]'::jsonb,       -- [{"task_type":"…","total":123},…]，沒有任務就是 []
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE queue_task_counts_cache IS '/next 的佇列各型別件數快取：每個地區一列，queue_task_counts_refresh() 約每 2 分鐘整批重寫；contribution_queue_task_counts 讀它，沒有列或超過 10 分鐘沒刷新就即時算。2026-11-26';
ALTER TABLE queue_task_counts_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON queue_task_counts_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON queue_task_counts_cache TO service_role;

-- ------------------------------------------------------------
-- 2. 原本的即時算（本體逐字搬來，只改函式名）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_queue_task_counts_live(p_region TEXT DEFAULT NULL)
RETURNS TABLE (task_type TEXT, total BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT t.task_type, COUNT(*) FROM contribution_queue_tasks(NULL, p_region, 100000, '') t GROUP BY t.task_type ORDER BY 1;
$$;
COMMENT ON FUNCTION contribution_queue_task_counts_live IS '佇列上各型別的任務數，即時算（原 contribution_queue_task_counts 的本體；整條佇列排序，約 1～4 秒、暫存約 36 MB）。只有小表沒有列或過期時才由 contribution_queue_task_counts 退回它。2026-11-26';
REVOKE ALL ON FUNCTION contribution_queue_task_counts_live(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION contribution_queue_task_counts_live(TEXT) TO service_role;

-- ------------------------------------------------------------
-- 3. 刷新：一次算好全部地區
-- ------------------------------------------------------------
-- 核心查詢獨立成一支，刷新與等價性驗證共用同一份文字
CREATE OR REPLACE FUNCTION queue_task_counts_compute()
RETURNS TABLE (region_key TEXT, task_type TEXT, total BIGINT)
LANGUAGE sql STABLE AS $$
  WITH q AS MATERIALIZED (
    SELECT t.task_id, t.task_type FROM contribution_queue_tasks(NULL, NULL, 100000, '') t
  )
  SELECT '*'::text, q.task_type, COUNT(*) FROM q GROUP BY q.task_type
  UNION ALL
  SELECT d.region, q.task_type, COUNT(*) FROM q JOIN task_dispatches d ON d.task_id = q.task_id WHERE d.region IS NOT NULL GROUP BY d.region, q.task_type;
$$;
COMMENT ON FUNCTION queue_task_counts_compute IS '一次算出不分地區（鍵 *）與每個地區的各型別件數；與 contribution_queue_task_counts_live 逐列相同（region 條件＝task_dispatches.region 相等）。2026-11-26';
REVOKE ALL ON FUNCTION queue_task_counts_compute() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION queue_task_counts_compute() TO service_role;

CREATE OR REPLACE FUNCTION queue_task_counts_refresh()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_n INTEGER;
BEGIN
  -- 同時只跑一個（上一輪還沒跑完，下一輪直接略過）
  IF NOT pg_try_advisory_xact_lock(hashtext('queue_task_counts_refresh')) THEN
    RETURN 0;
  END IF;

  -- 地區清單＝佇列表裡出現過的地區＋小表裡已有的列（這一輪沒有任務的地區要寫成 []，不能留舊值）
  WITH counts AS (
    SELECT * FROM queue_task_counts_compute()
  ), keys AS (
    SELECT '*'::text AS region_key
    UNION SELECT d.region FROM task_dispatches d WHERE d.region IS NOT NULL
    UNION SELECT c.region_key FROM queue_task_counts_cache c
  ), up AS (
    INSERT INTO queue_task_counts_cache AS c (region_key, payload, refreshed_at)
    SELECT k.region_key,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('task_type', x.task_type, 'total', x.total) ORDER BY x.task_type)
                       FROM counts x WHERE x.region_key = k.region_key), '[]'::jsonb),
           now()
      FROM keys k
    ON CONFLICT (region_key) DO UPDATE SET payload = EXCLUDED.payload, refreshed_at = EXCLUDED.refreshed_at
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM up;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION queue_task_counts_refresh IS '重算並寫入 queue_task_counts_cache 全部地區（含不分地區 *）；pg_cron queue-task-counts-refresh 約每 2 分鐘跑一次，回傳寫入的列數。2026-11-26';
REVOKE ALL ON FUNCTION queue_task_counts_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION queue_task_counts_refresh() TO service_role;

-- ------------------------------------------------------------
-- 4. 對外函式：同簽名、同回傳欄位，改讀小表；沒有列或超過 10 分鐘沒刷新就退回即時算
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_queue_task_counts(p_region TEXT DEFAULT NULL)
RETURNS TABLE (task_type TEXT, total BIGINT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_payload JSONB;
BEGIN
  SELECT c.payload INTO v_payload
    FROM queue_task_counts_cache c
   WHERE c.region_key = COALESCE(p_region, '*')
     AND c.refreshed_at > now() - INTERVAL '10 minutes';
  IF FOUND THEN
    RETURN QUERY
      SELECT (e.value->>'task_type')::text, (e.value->>'total')::bigint
        FROM jsonb_array_elements(v_payload) e
       ORDER BY 1;
    RETURN;
  END IF;
  -- 保底：小表沒有這個地區、或刷新停了超過 10 分鐘
  RETURN QUERY SELECT l.task_type, l.total FROM contribution_queue_task_counts_live(p_region) l;
END;
$$;
COMMENT ON FUNCTION contribution_queue_task_counts IS '佇列上各型別的任務數（自動缺口＋open 的手動任務，跳過 blocked、冷卻中）。/next 的 open_tasks 用。2026-11-26 起讀 queue_task_counts_cache（約每 2 分鐘刷新），沒有該地區的列或超過 10 分鐘沒刷新就退回 contribution_queue_task_counts_live 即時算；簽名與回傳欄位不變。';

-- ------------------------------------------------------------
-- 5. 排程：奇數分鐘、避開 :29／:35（及所有 :x0）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'queue-task-counts-refresh';
    EXECUTE $q$SELECT cron.schedule('queue-task-counts-refresh', '1,3,5,7,9,11,13,15,17,19,21,23,25,27,31,33,37,39,41,43,45,47,49,51,53,55,57,59 * * * *', 'SET statement_timeout TO ''120s''; SELECT queue_task_counts_refresh();')$q$;
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
