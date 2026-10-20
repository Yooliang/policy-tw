-- 參選地圖的統計表（#680）：candidacy_map() 改成讀預先算好的表，排程每 10 分鐘整批重算。
--
-- 為什麼：candidacy_map() 每次呼叫都要掃一遍參選紀錄、中選會登記名冊（約 2 萬列）與選舉區，再跟 admin_divisions 比對，
-- 2026-10-20 唯讀 EXPLAIN ANALYZE 量到（伺服器端、不含網路）：縣市層 65 ms、鄉鎮層 180 ms、村里層（單一鄉鎮）208～233 ms、
-- 村里層整層 260 ms，另外計畫時間約 8 ms；固定成本幾乎都是那幾次全表掃描，所以頁面放大到村里時每個鄉鎮各打一次、各 200 多毫秒。
-- 資料其實每 10 分鐘才會變一次（名冊比對 roster-reconcile 每 10 分鐘最多新增 100 位），沒必要每次現算。
--
-- 做法：
--   1. 現行的 candidacy_map(integer, text, text) 本體原封不動改名為 candidacy_map_live（20261019090000 的定義，仍可呼叫）。
--   2. 新表 candidacy_map_stats，形狀跟點陣檔、地圖的讀法對齊：一屆約 391 列——
--        nation（1 列，code 空字串）：全國合計，children＝22 個縣市 { 縣市代碼: [名稱, 收錄, 登記, 席次] }
--        county（22 列）：該縣市自身的三個數字，children＝底下各鄉鎮市區 { 鄉鎮代碼: [名稱, 收錄, 登記, 席次] }
--        town（368 列）：該鄉鎮市區自身的三個數字，children＝底下所有村里 { 村里代碼: [名稱, 收錄, 登記, 席次] }（一個鄉鎮一列，
--        跟點陣檔「一個鄉鎮一檔」一一對應，放大到某鄉鎮的村里層抓這一列就拿到全部村里）
--      數字：收錄人數、中選會登記人數（對不上＝null）、應選席次（沒查證＝null）。
--   3. candidacy_map_refresh(election_id)：單一函式＝單一交易，DELETE 該屆再 INSERT，讀的人在 commit 之前看到的是舊的整份、
--      commit 之後是新的整份（MVCC），不會讀到半套。candidacy_map_refresh_all()：重算近 120 天內投票的選舉（其餘屆別不在表裡、
--      走即時計算），pg_cron candidacy-map-stats-10min 每 10 分鐘第 9 分（roster-reconcile 是第 7 分，晚兩分鐘剛好接在它後面）。
--   4. candidacy_map() 簽名與回傳不變（前端照舊呼叫，快取邏輯不用動）：該屆在表裡有資料就從表展開（縣市層讀 county 列、
--      鄉鎮層讀 town 列、村里層展開 town 列的 children），沒有（表空、或沒排程的屆別）退回 candidacy_map_live 即時計算。
--      前端不直接讀表，是因為直接讀沒有「表空時退回即時」這條路。
--
-- 引用到的既有欄位（2026-10-20 唯讀查詢確認存在）：elections(id, election_date)；candidacy_map_live 引用的欄位見 20261019090000。
-- 不碰任何人物或參選紀錄：這張表只是既有資料的快取，隨時可以整張刪掉重算。

ALTER FUNCTION candidacy_map(integer, text, text) RENAME TO candidacy_map_live;
COMMENT ON FUNCTION candidacy_map_live(integer, text, text) IS
  '參選地圖（#680）即時計算版：某一屆、某一層每個行政區一列。candidacy_map() 在統計表有資料時讀表、沒有才退回這支；candidacy_map_refresh() 用它整批重算';

CREATE TABLE IF NOT EXISTS candidacy_map_stats (
  election_id integer NOT NULL,
  scope       text    NOT NULL CHECK (scope IN ('nation', 'county', 'town')),
  code        text    NOT NULL,
  name        text    NOT NULL,
  candidates  integer NOT NULL,
  registered  integer,
  seats       integer,
  children    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (election_id, scope, code),
  CONSTRAINT candidacy_map_stats_code_shape CHECK (
       (scope = 'nation' AND code = '')
    OR (scope = 'county' AND length(code) = 5)
    OR (scope = 'town'   AND length(code) = 8))
);
CREATE INDEX IF NOT EXISTS candidacy_map_stats_scope_code ON candidacy_map_stats (election_id, scope, code text_pattern_ops);
COMMENT ON TABLE candidacy_map_stats IS
  '參選地圖統計（#680）：一屆約 391 列（全國 1、縣市 22、鄉鎮市區 368）。children＝下一層 { 代碼: [名稱, 收錄, 登記, 席次] }（全國→縣市、縣市→鄉鎮、鄉鎮→村里）。pg_cron candidacy-map-stats-10min 每 10 分鐘用 candidacy_map_refresh() 單一交易覆寫；candidacy_map() 讀這張表。登記／席次為 null＝沒有對得上的名冊／沒查證名額';
ALTER TABLE candidacy_map_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON candidacy_map_stats;
CREATE POLICY "Public read" ON candidacy_map_stats FOR SELECT USING (true);
GRANT SELECT ON candidacy_map_stats TO anon, authenticated;

CREATE OR REPLACE FUNCTION candidacy_map_refresh(p_election_id integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_n integer;
BEGIN
  -- 整支函式是一個交易：覆寫期間別人讀到的還是舊的整份，commit 之後才換成新的整份
  DELETE FROM candidacy_map_stats WHERE election_id = p_election_id;
  INSERT INTO candidacy_map_stats (election_id, scope, code, name, candidates, registered, seats, children, computed_at)
  WITH c AS MATERIALIZED (SELECT * FROM candidacy_map_live(p_election_id, 'county', NULL)),
       t AS MATERIALIZED (SELECT * FROM candidacy_map_live(p_election_id, 'town', NULL)),
       v AS MATERIALIZED (SELECT * FROM candidacy_map_live(p_election_id, 'village', NULL)),
       vg AS (SELECT v.parent_code AS code, jsonb_object_agg(v.code, jsonb_build_array(v.name, v.candidates, v.registered, v.seats)) AS kids FROM v GROUP BY v.parent_code),
       tg AS (SELECT t.parent_code AS code, jsonb_object_agg(t.code, jsonb_build_array(t.name, t.candidates, t.registered, t.seats)) AS kids FROM t GROUP BY t.parent_code)
  SELECT p_election_id, 'nation', '', '全國', COALESCE(sum(c.candidates), 0)::integer, sum(c.registered)::integer, sum(c.seats)::integer,
         COALESCE(jsonb_object_agg(c.code, jsonb_build_array(c.name, c.candidates, c.registered, c.seats)), '{}'::jsonb), v_now
    FROM c
  UNION ALL
  SELECT p_election_id, 'county', c.code, c.name, c.candidates, c.registered, c.seats, COALESCE(tg.kids, '{}'::jsonb), v_now
    FROM c LEFT JOIN tg ON tg.code = c.code
  UNION ALL
  SELECT p_election_id, 'town', t.code, t.name, t.candidates, t.registered, t.seats, COALESCE(vg.kids, '{}'::jsonb), v_now
    FROM t LEFT JOIN vg ON vg.code = t.code;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION candidacy_map_refresh(integer) IS '重算某一屆的參選地圖統計表（單一交易覆寫，回傳寫入列數）；pg_cron 透過 candidacy_map_refresh_all() 每 10 分鐘叫';

-- 近 120 天內投票（或還沒投票）的選舉才排程重算；更早的屆別資料不會再變，不在表裡、走即時計算
CREATE OR REPLACE FUNCTION candidacy_map_refresh_all() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_total integer := 0;
BEGIN
  FOR r IN SELECT e.id FROM elections e WHERE e.election_date IS NOT NULL AND e.election_date >= current_date - 120 ORDER BY e.id LOOP
    v_total := v_total + candidacy_map_refresh(r.id);
  END LOOP;
  RETURN v_total;
END;
$$;
COMMENT ON FUNCTION candidacy_map_refresh_all() IS '排程入口（pg_cron candidacy-map-stats-10min）：重算近 120 天內投票或尚未投票的選舉，回傳總列數';

REVOKE ALL ON FUNCTION candidacy_map_refresh(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION candidacy_map_refresh_all() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION candidacy_map_refresh(integer) TO service_role;
GRANT EXECUTE ON FUNCTION candidacy_map_refresh_all() TO service_role;

-- 簽名與回傳不變：統計表有這一屆就從表展開，沒有就即時算
CREATE OR REPLACE FUNCTION candidacy_map(p_election_id integer, p_level text, p_parent text DEFAULT NULL)
RETURNS TABLE (code text, name text, parent_code text, candidates integer, registered integer, seats integer)
LANGUAGE plpgsql STABLE SECURITY INVOKER
AS $$
#variable_conflict use_column
BEGIN
  IF NOT EXISTS (SELECT 1 FROM candidacy_map_stats s WHERE s.election_id = p_election_id) THEN
    RETURN QUERY SELECT * FROM candidacy_map_live(p_election_id, p_level, p_parent);
  ELSIF p_level = 'county' THEN
    RETURN QUERY
      SELECT s.code, s.name, NULL::text, s.candidates, s.registered, s.seats
        FROM candidacy_map_stats s
       WHERE s.election_id = p_election_id AND s.scope = 'county' AND (p_parent IS NULL OR s.code LIKE p_parent || '%')
       ORDER BY s.code;
  ELSIF p_level = 'town' THEN
    RETURN QUERY
      SELECT s.code, s.name, left(s.code, 5), s.candidates, s.registered, s.seats
        FROM candidacy_map_stats s
       WHERE s.election_id = p_election_id AND s.scope = 'town' AND (p_parent IS NULL OR s.code LIKE p_parent || '%')
       ORDER BY s.code;
  ELSIF p_level = 'village' THEN
    -- 一個鄉鎮一列：展開那一列的 children（p_parent 是鄉鎮或縣市代碼；更長的代碼再用村里代碼前綴過濾）
    RETURN QUERY
      SELECT k.key, k.value ->> 0, s.code, (k.value ->> 1)::integer, (k.value ->> 2)::integer, (k.value ->> 3)::integer
        FROM candidacy_map_stats s
        CROSS JOIN LATERAL jsonb_each(s.children) AS k(key, value)
       WHERE s.election_id = p_election_id AND s.scope = 'town'
         AND (p_parent IS NULL OR s.code LIKE left(p_parent, 8) || '%')
         AND (p_parent IS NULL OR k.key LIKE p_parent || '%')
       ORDER BY k.key;
  END IF;
END;
$$;
COMMENT ON FUNCTION candidacy_map(integer, text, text) IS
  '參選地圖（#680）：某一屆、某一層（county／town／village）每個行政區一列，收錄人數、中選會登記人數（對不上＝NULL）、應選席次（沒查證＝NULL）；p_parent 限定在上一層代碼底下。統計表（candidacy_map_stats）有這一屆就從表展開，沒有退回即時計算 candidacy_map_live';
GRANT EXECUTE ON FUNCTION candidacy_map(integer, text, text) TO anon, authenticated;

-- 第一次填表，之後交給排程
SELECT candidacy_map_refresh_all();

SELECT cron.unschedule('candidacy-map-stats-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'candidacy-map-stats-10min');
SELECT cron.schedule('candidacy-map-stats-10min', '9,19,29,39,49,59 * * * *', $$SELECT candidacy_map_refresh_all();$$);
