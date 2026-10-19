-- 參選地圖（/stats/map，#680）的資料函式：每個縣市／鄉鎮市區／村里一列，帶三個數字。
--
--   candidates  收錄人數：politician_elections（該屆、candidacy_status 不是 withdrawn）按人去重，歸到參選紀錄所在的行政區
--   registered  中選會登記人數：cec_registrations（跳過被新版取代的名冊），沒有對得上的列就是 NULL
--   seats       應選席次：election_districts 的 seats 加總，沒有任何一區查證過名額就是 NULL
--
-- 歸屬規則（三個數字同一套）：一筆紀錄先看有沒有內政部代碼（regions.admin_code），沒有就用縣市／鄉鎮市區／村里的
-- 文字對 admin_divisions.match_key（臺＝台、去空白）。議員、代表的選舉區名稱（「第05選舉區」「桃源區第01選舉區」）
-- 把後面的「第NN選舉區」拿掉，剩下的是鄉鎮市區名；拿掉後是空的（縣市議員）就只歸到縣市。
-- 所以縣市的數字＝該縣市底下所有紀錄（含鄉鎮市長、村里長），鄉鎮市區的數字＝歸得到鄉鎮的紀錄，村里＝村里長。
-- 歸不到任何行政區的（region_id 是空的）不計入任何一格。
--
-- 引用到的既有欄位（2026-10-19 唯讀查詢確認存在）：
--   politician_elections(election_id, politician_id, region_id, candidacy_status)
--   regions(id, region, sub_region, village, admin_code)
--   admin_divisions(code, level, parent_code, county, town, village, match_key)；函式 admin_match_key(text, text, text)
--   cec_registrations(election_id, region, sub_region, village, source_url)；cec_registration_sources(source_url, superseded_by)
--   election_districts(election_id, region, sub_region, village, seats)
--
-- 一次回傳一層：p_level＝county／town／village；p_parent 給上一層代碼（鄉鎮市區層給縣市代碼、村里層給鄉鎮市區代碼），
-- 不給就是整層。PostgREST 一次最多 1,000 列，所以村里層一定要帶 p_parent。

CREATE OR REPLACE FUNCTION candidacy_map(p_election_id integer, p_level text, p_parent text DEFAULT NULL)
RETURNS TABLE (code text, name text, parent_code text, candidates integer, registered integer, seats integer)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH units AS (
    SELECT d.code, d.parent_code,
           CASE d.level WHEN 'county' THEN replace(d.county, '臺', '台') WHEN 'town' THEN d.town ELSE d.village END AS name
      FROM admin_divisions d
     WHERE d.level = p_level
       AND p_level IN ('county', 'town', 'village')
       AND (p_parent IS NULL OR d.code LIKE p_parent || '%')
  ),
  cand AS (
    SELECT pe.politician_id, r.region, r.village, r.admin_code,
           NULLIF(regexp_replace(COALESCE(r.sub_region, ''), '第[0-9]+(選舉區|選區)$', ''), '') AS town_name
      FROM politician_elections pe
      JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_id = p_election_id
       AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
  ),
  cand_r AS (
    SELECT c.politician_id,
           COALESCE(CASE WHEN length(c.admin_code) >= 5 THEN left(c.admin_code, 5) END, dc.code) AS county_code,
           COALESCE(CASE WHEN length(c.admin_code) >= 8 THEN left(c.admin_code, 8) END, dt.code) AS town_code,
           COALESCE(CASE WHEN length(c.admin_code) = 11 THEN c.admin_code END, dv.code) AS village_code
      FROM cand c
      LEFT JOIN admin_divisions dc ON dc.match_key = admin_match_key(c.region, NULL, NULL)
      LEFT JOIN admin_divisions dt ON c.town_name IS NOT NULL
                                  AND dt.match_key = admin_match_key(c.region, c.town_name, NULL)
      LEFT JOIN admin_divisions dv ON c.town_name IS NOT NULL AND c.village IS NOT NULL
                                  AND dv.match_key = admin_match_key(c.region, c.town_name, c.village)
  ),
  cand_n AS (
    SELECT CASE p_level WHEN 'county' THEN county_code WHEN 'town' THEN town_code ELSE village_code END AS code,
           count(DISTINCT politician_id)::integer AS n
      FROM cand_r
     GROUP BY 1
  ),
  reg AS (
    SELECT c.region, c.sub_region AS town_name, c.village
      FROM cec_registrations c
     WHERE c.election_id = p_election_id
       AND NOT EXISTS (SELECT 1 FROM cec_registration_sources s
                        WHERE s.source_url = c.source_url AND s.superseded_by IS NOT NULL)
  ),
  reg_r AS (
    SELECT dc.code AS county_code, dt.code AS town_code, dv.code AS village_code
      FROM reg c
      LEFT JOIN admin_divisions dc ON dc.match_key = admin_match_key(c.region, NULL, NULL)
      LEFT JOIN admin_divisions dt ON c.town_name IS NOT NULL
                                  AND dt.match_key = admin_match_key(c.region, c.town_name, NULL)
      LEFT JOIN admin_divisions dv ON c.town_name IS NOT NULL AND c.village IS NOT NULL
                                  AND dv.match_key = admin_match_key(c.region, c.town_name, c.village)
  ),
  reg_n AS (
    SELECT CASE p_level WHEN 'county' THEN county_code WHEN 'town' THEN town_code ELSE village_code END AS code,
           count(*)::integer AS n
      FROM reg_r
     GROUP BY 1
  ),
  seat AS (
    SELECT e.region, e.village, e.seats,
           NULLIF(regexp_replace(COALESCE(e.sub_region, ''), '第[0-9]+(選舉區|選區)$', ''), '') AS town_name
      FROM election_districts e
     WHERE e.election_id = p_election_id
  ),
  seat_r AS (
    SELECT s.seats, dc.code AS county_code, dt.code AS town_code, dv.code AS village_code
      FROM seat s
      LEFT JOIN admin_divisions dc ON dc.match_key = admin_match_key(s.region, NULL, NULL)
      LEFT JOIN admin_divisions dt ON s.town_name IS NOT NULL
                                  AND dt.match_key = admin_match_key(s.region, s.town_name, NULL)
      LEFT JOIN admin_divisions dv ON s.town_name IS NOT NULL AND s.village IS NOT NULL
                                  AND dv.match_key = admin_match_key(s.region, s.town_name, s.village)
  ),
  seat_n AS (
    SELECT CASE p_level WHEN 'county' THEN county_code WHEN 'town' THEN town_code ELSE village_code END AS code,
           sum(seats)::integer AS n
      FROM seat_r
     WHERE seats IS NOT NULL
     GROUP BY 1
  )
  SELECT u.code, u.name, u.parent_code,
         COALESCE(cand_n.n, 0),
         reg_n.n,
         seat_n.n
    FROM units u
    LEFT JOIN cand_n ON cand_n.code = u.code
    LEFT JOIN reg_n ON reg_n.code = u.code
    LEFT JOIN seat_n ON seat_n.code = u.code
   ORDER BY u.code
$$;

COMMENT ON FUNCTION candidacy_map(integer, text, text) IS
  '參選地圖（#680）：某一屆、某一層（county／town／village）每個行政區一列，收錄人數、中選會登記人數（對不上＝NULL）、應選席次（沒查證＝NULL）；p_parent 限定在上一層代碼底下';

GRANT EXECUTE ON FUNCTION candidacy_map(integer, text, text) TO anon, authenticated;
