-- politician_election_policy_counts 改讀快取表（2026-11-28 開票夜 P1 止血）
--
-- 為什麼：
--   選舉頁卡片與預渲染讀視圖 politician_election_policy_counts（20261118120000），視圖本體是對 policies 全表（約 5 萬筆）的 GROUP BY。
--   開票夜訪客暴衝，PostgREST 同時有 30～40 個這個查詢在跑（gateway 24 小時統計它是 REST 第一大戶，約 45 萬次／天），
--   每次都整表聚合，CPU 吃滿，seed 與排程逾時。
--
-- 做法（同 queue_task_counts_cache，20261126160000）：
--   1. 原視圖改名 politician_election_policy_counts_live（即時版，供刷新與對照；不給 anon／authenticated）。
--   2. 新表 politician_election_policy_counts_cache：欄位與視圖相同＋refreshed_at，主鍵 (politician_id, election_id)；RLS 開、anon／authenticated 可讀、寫入只有 service_role。
--   3. policy_counts_cache_refresh()：用即時版視圖整批 upsert，並刪掉不再存在的鍵；pg_cron policy-counts-cache-refresh 每 5 分鐘一輪（分鐘 4,9,14,…，避開整十分與重 job 的分鐘）；migration 內先灌滿一次。
--   4. 原名視圖 politician_election_policy_counts 改成 SELECT 同四欄 FROM 快取表（欄位名、順序、型別與 20261118120000 相同；security_invoker 與 GRANT 照舊），前端一字不改。
--
-- 行為變更：承諾數／政見數最晚 5 分鐘更新（原本即時）。沒有改 policies 的觸發器。
-- 每日呼叫量變化：+288／天（每 5 分鐘一輪，每輪內單一聚合）；REST 讀取次數不變，但每次由整表聚合變成主鍵索引讀。
--
-- 回滾（一行一行貼，不丟資料）：
--   SELECT cron.unschedule('policy-counts-cache-refresh');
--   DROP VIEW politician_election_policy_counts;
--   ALTER VIEW politician_election_policy_counts_live RENAME TO politician_election_policy_counts;
--   GRANT SELECT ON politician_election_policy_counts TO anon, authenticated;
--   （之後可 DROP TABLE politician_election_policy_counts_cache、DROP FUNCTION policy_counts_cache_refresh()）
--
-- 依賴：2026-11-28 對 origin/main 全 repo 搜尋，沒有其他視圖或函式依賴 politician_election_policy_counts（只有前端 useSupabase.ts、lib/ssg/server-data.ts 以名稱讀取），所以改名＋重建不會 DROP 失敗。

-- ------------------------------------------------------------
-- 1. 原視圖改名成即時版（授權收回，只留給 service_role／postgres 與刷新函式用）
-- ------------------------------------------------------------
ALTER VIEW politician_election_policy_counts RENAME TO politician_election_policy_counts_live;
REVOKE ALL ON politician_election_policy_counts_live FROM PUBLIC, anon, authenticated;
GRANT SELECT ON politician_election_policy_counts_live TO service_role;
COMMENT ON VIEW politician_election_policy_counts_live IS
  '每人每屆承諾數與政見數的即時版（原 politician_election_policy_counts 的本體，整表聚合，開票夜 30～40 並發會吃滿 CPU）。只給 policy_counts_cache_refresh() 與對照用；對外的 politician_election_policy_counts 讀快取表。2026-11-28';

-- ------------------------------------------------------------
-- 2. 快取表（欄位型別直接繼承即時版視圖）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS politician_election_policy_counts_cache AS
SELECT politician_id, election_id, pledge_count, policy_count
FROM politician_election_policy_counts_live
WITH NO DATA;

ALTER TABLE politician_election_policy_counts_cache ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE politician_election_policy_counts_cache ALTER COLUMN politician_id SET NOT NULL;
ALTER TABLE politician_election_policy_counts_cache ALTER COLUMN election_id SET NOT NULL;
ALTER TABLE politician_election_policy_counts_cache ALTER COLUMN pledge_count SET NOT NULL;
ALTER TABLE politician_election_policy_counts_cache ALTER COLUMN policy_count SET NOT NULL;
ALTER TABLE politician_election_policy_counts_cache ADD PRIMARY KEY (politician_id, election_id);
CREATE INDEX IF NOT EXISTS politician_election_policy_counts_cache_election_idx
  ON politician_election_policy_counts_cache (election_id);

COMMENT ON TABLE politician_election_policy_counts_cache IS
  '每人每屆承諾數／政見數快取：policy_counts_cache_refresh() 每 5 分鐘整批重寫；視圖 politician_election_policy_counts 讀它（security_invoker，所以 anon 要有 SELECT 與 RLS policy）。2026-11-28';
ALTER TABLE politician_election_policy_counts_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON politician_election_policy_counts_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT ON politician_election_policy_counts_cache TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON politician_election_policy_counts_cache TO service_role;
DROP POLICY IF EXISTS policy_counts_cache_public_read ON politician_election_policy_counts_cache;
CREATE POLICY policy_counts_cache_public_read ON politician_election_policy_counts_cache
  FOR SELECT TO anon, authenticated USING (true);

-- ------------------------------------------------------------
-- 3. 刷新函式：即時版整批 upsert，刪掉不再存在的鍵；同時只跑一個
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_counts_cache_refresh()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('policy_counts_cache_refresh')) THEN
    RETURN 0;
  END IF;

  WITH l AS MATERIALIZED (
    SELECT politician_id, election_id, pledge_count, policy_count
    FROM politician_election_policy_counts_live
  ), up AS (
    INSERT INTO politician_election_policy_counts_cache AS c (politician_id, election_id, pledge_count, policy_count, refreshed_at)
    SELECT l.politician_id, l.election_id, l.pledge_count, l.policy_count, now() FROM l
    ON CONFLICT (politician_id, election_id) DO UPDATE
      SET pledge_count = EXCLUDED.pledge_count, policy_count = EXCLUDED.policy_count, refreshed_at = EXCLUDED.refreshed_at
      WHERE c.pledge_count IS DISTINCT FROM EXCLUDED.pledge_count OR c.policy_count IS DISTINCT FROM EXCLUDED.policy_count
    RETURNING 1
  ), del AS (
    DELETE FROM politician_election_policy_counts_cache c
     WHERE NOT EXISTS (SELECT 1 FROM l WHERE l.politician_id = c.politician_id AND l.election_id = c.election_id)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM up)::int + (SELECT count(*) FROM del)::int INTO v_n;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION policy_counts_cache_refresh IS '重算 politician_election_policy_counts_cache（改變的列寫入、不存在的鍵刪除），回傳異動列數；pg_cron policy-counts-cache-refresh 每 5 分鐘一輪。2026-11-28';
REVOKE ALL ON FUNCTION policy_counts_cache_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_counts_cache_refresh() TO service_role;

-- 首次灌滿
SELECT policy_counts_cache_refresh();

-- ------------------------------------------------------------
-- 4. 原名視圖改讀快取表（欄位名、順序、型別不變）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW politician_election_policy_counts AS
SELECT
  c.politician_id,
  c.election_id,
  c.pledge_count,
  c.policy_count
FROM politician_election_policy_counts_cache c;

ALTER VIEW politician_election_policy_counts SET (security_invoker = on);
GRANT SELECT ON politician_election_policy_counts TO anon, authenticated;
COMMENT ON VIEW politician_election_policy_counts IS
  '每人每屆的承諾數（status=Campaign Pledge）與政見數（全部未移除），選舉頁卡片與預渲染用。2026-11-28 起讀 politician_election_policy_counts_cache（最晚 5 分鐘更新），即時版是 politician_election_policy_counts_live。';

-- ------------------------------------------------------------
-- 5. 排程：每 5 分鐘（:x4、:x9），避開整十分（seed）、:x6／:x8／:47／奇數（重 job 的起跑分鐘）與 :x3、:x7（各已有 4 支）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'policy-counts-cache-refresh';
    EXECUTE $q$SELECT cron.schedule('policy-counts-cache-refresh', '4,9,14,19,24,29,34,39,44,49,54,59 * * * *', 'SET statement_timeout TO ''120s''; SELECT policy_counts_cache_refresh();')$q$;
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
