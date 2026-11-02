-- 參選地圖（/stats/map）改看「有號次人數／中選會人數」（工作單：Yooliang/policy-ops#180）。
--
-- 2026 屆的兩個數字換來源（其他屆別維持原樣）：
--   candidates  有號次人數＝politician_elections 該屆 cand_no 不是空、candidacy_status 在 filed／qualified／elected／not_elected，按人去重
--   registered  中選會人數＝cec_roster_2026（官方名冊鏡像）的列數；county 的「臺」換成「台」後對 admin_divisions.match_key。
--               名冊的村里長只有村里序號、沒有村里名，對不到村里，所以村里層的中選會人數是 NULL（畫面不顯示缺口）
-- 兩個數字走同一套行政區歸屬規則，缺口 ＝ 中選會 − 有號次。
-- 做法：只改 candidacy_map_live 的兩段 CTE（簽名、回傳、統計表、排程都不動），改完立刻重算 2026 統計表。
--
-- 引用到的既有欄位（2026-11-03 唯讀查詢確認存在）：politician_elections(cand_no, candidacy_status)、cec_roster_2026(county, town, election_type)

CREATE OR REPLACE FUNCTION candidacy_map_live(p_election_id integer, p_level text, p_parent text DEFAULT NULL)
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
       AND CASE WHEN p_election_id = 2026
                THEN pe.cand_no IS NOT NULL AND pe.candidacy_status IN ('filed', 'qualified', 'elected', 'not_elected')
                ELSE pe.candidacy_status IS DISTINCT FROM 'withdrawn' END
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
       AND p_election_id <> 2026
       AND NOT EXISTS (SELECT 1 FROM cec_registration_sources s
                        WHERE s.source_url = c.source_url AND s.superseded_by IS NOT NULL)
    UNION ALL
    SELECT replace(m.county, '臺', '台'), NULLIF(m.town, ''), NULL::text
      FROM cec_roster_2026 m
     WHERE p_election_id = 2026
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

COMMENT ON FUNCTION candidacy_map_live(integer, text, text) IS
  '參選地圖即時計算版：2026 屆＝有號次人數（cand_no 非空、非退選／不合格）對中選會名冊人數（cec_roster_2026）；其他屆＝收錄人數對登記彙總表。candidacy_map() 在統計表有資料時讀表、沒有才退回這支；candidacy_map_refresh() 用它整批重算';

-- 立刻重算 2026 統計表（之後仍由 pg_cron 每 10 分鐘重算）
SELECT candidacy_map_refresh(2026);
