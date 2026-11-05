-- 數據分佈（/regional-data）的「政見數」只算當選的（維護者 2026-11-05；工作單 policy-ops#201）。
-- 承諾 → 政見 → 施政 → 脈絡：「政見」是當選那一屆的，所以數字用 policy_is_elected_term(政見 id, 今天) 這一支（20261019020000），不另立定義。
--
-- 做了什麼（只加不刪、不改 policy_count 的意思與觸發器）：
--   1. regions 加一欄 elected_policy_count（預設 0）。policy_count 的唯一讀者是 pages/RegionalData.vue，但它由觸發器 trg_region_policy_stats
--      逐筆加減，只看 politicians.region／sub_region／village 與政見筆數（含已移除、未投票、落選），保留不動。
--   2. regions_elected_policy_count_refresh()：整批重算，歸屬與 policy_count 同一口徑（政見 → 提出者 politicians 的 region／sub_region／village，
--      縣市層級、鄉鎮區層級、村里層級各加一次），再加上：政見未移除（removed_at 為空）且 policy_is_elected_term。
--      「當選」依賴今天與參選結果，單靠 policies 上的觸發器會在開票日過後、結果更正後過期，所以用整批重算，不做觸發器。
--   3. pg_cron 每 10 分鐘重算一次（regions-elected-policy-count-10min；pg_cron 不在的環境略過），並在這支 migration 內立刻回填一次。
--      實測（正式庫唯讀 EXPLAIN ANALYZE，2026-11-05）：重算查詢約 208 ms（5302 條政見）。只更新數字有變的列。
--
-- 先唯讀查過正式庫：regions（id、region、sub_region、village、policy_count）、policies（id、politician_id、removed_at、election_id）、
-- politicians（region、sub_region、village）都有這些欄位；regions 沒有 elected_policy_count。
--
-- 還原：DROP FUNCTION regions_elected_policy_count_refresh(); SELECT cron.unschedule('regions-elected-policy-count-10min');
-- 頁面改回讀 policy_count 之後（先部署頁面，這是兩步），再 ALTER TABLE regions DROP COLUMN elected_policy_count。

ALTER TABLE regions ADD COLUMN IF NOT EXISTS elected_policy_count INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN regions.elected_policy_count IS '該地區當選（那一屆已投票且提出者當選）且未移除的政見數；由 regions_elected_policy_count_refresh() 每 10 分鐘重算。歸屬同 policy_count';

CREATE OR REPLACE FUNCTION regions_elected_policy_count_refresh(p_today DATE DEFAULT activity_today())
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH ep AS (
    SELECT p.region, p.sub_region, p.village
      FROM policies pl JOIN politicians p ON p.id = pl.politician_id
     WHERE pl.removed_at IS NULL AND p.region IS NOT NULL AND policy_is_elected_term(pl.id, p_today)
  ), cnt AS (
    SELECT region, NULL::text AS sub_region, NULL::text AS village, count(*)::int AS n FROM ep GROUP BY region
    UNION ALL
    SELECT region, sub_region, NULL, count(*)::int FROM ep WHERE sub_region IS NOT NULL GROUP BY region, sub_region
    UNION ALL
    SELECT region, sub_region, village, count(*)::int FROM ep WHERE village IS NOT NULL AND sub_region IS NOT NULL GROUP BY region, sub_region, village
  ), want AS (
    SELECT r.id, COALESCE(c.n, 0) AS n
      FROM regions r
      LEFT JOIN cnt c ON c.region = r.region AND c.sub_region IS NOT DISTINCT FROM r.sub_region AND c.village IS NOT DISTINCT FROM r.village
  )
  UPDATE regions r SET elected_policy_count = w.n
    FROM want w
   WHERE r.id = w.id AND r.elected_policy_count IS DISTINCT FROM w.n;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
COMMENT ON FUNCTION regions_elected_policy_count_refresh IS '整批重算 regions.elected_policy_count（當選且未移除的政見，歸屬同 policy_count）；回傳有變動的列數。2026-11-05';

SELECT regions_elected_policy_count_refresh();

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'regions-elected-policy-count-10min';
    EXECUTE $q$SELECT cron.schedule('regions-elected-policy-count-10min', '1,11,21,31,41,51 * * * *', 'SELECT regions_elected_policy_count_refresh();')$q$;
  END IF;
END $$;
