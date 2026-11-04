-- 政黨分流圖資料層（工作單：Yooliang/policy-ops#193，小良哥 2026-11-04 裁定：各屆、年齡、性別）
--
-- 本檔做三件事，只加不刪；畫面先不動：
--   1. cec_roster_2026 加 gender（中選會名冊原始值照存，不轉換；缺值為 NULL）。
--      cec_roster_replace_unit 簽名不變，只多寫 gender；其他行為（404／空檔保留舊資料、整檔原子替換）一字不動。
--      既有 19,490 列 gender 為 NULL，要等 cec-roster-mirror 下一輪重抓該單位才補（fetched_at 超過 20 小時才重抓）。
--   2. cec_candidates 加 gender（cand_sex：1＝男、2＝女，其他與空值為 NULL；換算在 _shared/cec-static-fetch.ts 的 genderFromCandSex）。
--      不新增、不刪任何列；既有列 gender 為 NULL，重跑 cec-sync 該場次才補。
--   3. 新函式 party_flow_rows(p_election_id)：回單一 jsonb 陣列，只有聚合（政黨、縣市、鄉鎮、選舉別、年齡組、性別、當選結果、人數），
--      沒有姓名、生日或其他個資。2026 讀 cec_roster_2026，其他屆讀 cec_candidates；傳 2022 連 id＝4 的重行選舉一起算。
--      鍵：p 政黨、c 縣市、t 鄉鎮（沒有鄉鎮為空字串）、e 選舉別、a 年齡組（20／30／…／70＝70 歲以上，缺值 null）、
--          g 性別（男／女，其餘 null）、r 結果（當選／未當選，2026 還沒投票為 null）、n 人數。
--      正規化同 party_flow_counts：臺→台；政黨空值、「無」、「無黨籍及未經政黨推薦(者)」→ 無黨籍。
--      年齡＝該屆投票年－出生年，每 10 歲一組，70 歲以上併一組。2026 名冊 birth 是民國 7 碼（YYYMMDD，實測 19,490 筆全部合格）；
--      cec_candidates.birth_year 是西元，2024 立委有 177 筆缺值，一律回 null。
--      鄉鎮：只有鄉鎮市長、區長、鄉鎮市民代表、區民代表、村里長有；代表的 sub_region 是「<鄉鎮>第NN選舉區」，去掉選舉區尾巴；
--      縣市長、縣市議員、立法委員、總統副總統為空字串。縣市欄：總統副總統與全國性立委（不分區等）是「全國」。
--   party_flow_counts() 不動（線上頁面還在用；改簽名要分兩次上）。
--
-- 引用到的既有欄位（2026-11-04 唯讀查詢確認存在）：cec_roster_2026(election_type, county, town, party, birth)、
--   cec_candidates(election_id, election_type, region, sub_region, party, birth_year, elected)、elections(id, election_date)

ALTER TABLE cec_roster_2026 ADD COLUMN IF NOT EXISTS gender TEXT;
COMMENT ON COLUMN cec_roster_2026.gender IS '中選會名冊原始性別值（照存、不轉換），缺值為 NULL。2026-11-04';
ALTER TABLE cec_candidates ADD COLUMN IF NOT EXISTS gender TEXT;
COMMENT ON COLUMN cec_candidates.gender IS '性別：中選會 cand_sex 1＝男、2＝女，其他與空值為 NULL。2026-11-04';

-- ▼▼ SECTION: mirror ▼▼
CREATE OR REPLACE FUNCTION cec_roster_replace_unit(p_url TEXT, p_http INTEGER, p_rows JSONB DEFAULT NULL, p_error TEXT DEFAULT NULL) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE u cec_roster_units%ROWTYPE; v_n INTEGER;
BEGIN
  SELECT * INTO u FROM cec_roster_units WHERE url = p_url FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cec_roster_units 沒有 %', p_url; END IF;
  IF p_error IS NOT NULL THEN
    UPDATE cec_roster_units SET status = 'error', http_status = p_http, attempted_at = now(), error = left(p_error, 500) WHERE url = p_url;
    RETURN 'error';
  END IF;
  IF p_http = 404 THEN
    IF u.row_count > 0 THEN
      UPDATE cec_roster_units SET status = 'error', http_status = 404, attempted_at = now(), error = '之前有資料、這次 404：保留舊資料' WHERE url = p_url;
      RETURN 'error';
    END IF;
    UPDATE cec_roster_units SET status = 'absent', http_status = 404, attempted_at = now(), fetched_at = now(), error = NULL WHERE url = p_url;
    RETURN 'absent';
  END IF;
  IF p_http IS DISTINCT FROM 200 OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    UPDATE cec_roster_units SET status = 'error', http_status = p_http, attempted_at = now(), error = 'HTTP ' || COALESCE(p_http::TEXT, '?') WHERE url = p_url;
    RETURN 'error';
  END IF;
  IF jsonb_array_length(p_rows) = 0 AND u.row_count > 0 THEN
    UPDATE cec_roster_units SET status = 'error', http_status = 200, attempted_at = now(), error = '之前有資料、這次是空的：保留舊資料' WHERE url = p_url;
    RETURN 'error';
  END IF;
  DELETE FROM cec_roster_2026 WHERE unit_url = p_url;
  INSERT INTO cec_roster_2026 (election_type, county_code, county, town_code, town, district, area_code, li_code, name, name_key, cand_no, party, birth, home, gender, unit_key, unit_url, fetched_at)
  SELECT u.election_type, u.county_code, u.county,
         COALESCE(NULLIF(x.dept_code, ''), u.town_code), COALESCE(tt.town, u.town),
         COALESCE(x.district, ''), COALESCE(x.area_code, ''), COALESCE(x.li_code, ''),
         x.name, roster_name_key(x.name), x.cand_no, x.party, x.birth, x.home, x.gender,
         cec_roster_unit_key(u.election_type, u.county, COALESCE(tt.town, u.town), x.area_code), p_url, now()
    FROM jsonb_to_recordset(p_rows) AS x(name TEXT, cand_no INTEGER, party TEXT, birth TEXT, home TEXT, gender TEXT, district TEXT, area_code TEXT, dept_code TEXT, li_code TEXT)
    LEFT JOIN LATERAL (SELECT c.town FROM cec_vote2026_codes c WHERE c.county_code = u.county_code AND c.town_code = NULLIF(x.dept_code, '') AND c.town <> '' LIMIT 1) tt ON true
   WHERE NULLIF(btrim(x.name), '') IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE cec_roster_units SET status = 'ok', http_status = 200, row_count = v_n, attempted_at = now(), fetched_at = now(), error = NULL WHERE url = p_url;
  RETURN 'ok';
END;
$$;
COMMENT ON FUNCTION cec_roster_replace_unit IS '官方名冊單位整檔原子替換：200 換掉舊資料；404 且之前沒資料＝官方沒有（absent）；200 但空而之前有資料、或 404 而之前有資料＝可疑，保留舊資料標 error；失敗帶 p_error。2026-11-04 起多寫 gender。2026-10-31';
-- ▲▲ SECTION: mirror ▲▲

-- ▼▼ SECTION: party-flow-rows ▼▼
CREATE OR REPLACE FUNCTION party_flow_rows(p_election_id integer)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  WITH src AS (
    -- 2026：名冊（birth 是民國 YYYMMDD 7 碼；格式不符一律當缺值）
    SELECT r.party AS party, r.county AS county,
           CASE WHEN r.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長') THEN COALESCE(r.town, '') ELSE '' END AS town,
           r.election_type AS etype,
           CASE WHEN r.birth ~ '^[0-9]{7}$' THEN y.yr - (substr(r.birth, 1, 3)::int + 1911) END AS age,
           r.gender AS gender,
           NULL::boolean AS elected
      FROM cec_roster_2026 r
      CROSS JOIN (SELECT EXTRACT(YEAR FROM e.election_date)::int AS yr FROM elections e WHERE e.id = 2026) y
     WHERE p_election_id = 2026
    UNION ALL
    -- 其他屆：cec_candidates（傳 2022 連 id＝4 的重行選舉一起算）
    SELECT c.party, c.region,
           CASE WHEN c.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
                THEN COALESCE(NULLIF(regexp_replace(COALESCE(c.sub_region, ''), '第[0-9]+(選舉區|選區)$', ''), ''), '') ELSE '' END,
           c.election_type,
           CASE WHEN c.birth_year IS NOT NULL THEN EXTRACT(YEAR FROM e.election_date)::int - c.birth_year END,
           c.gender,
           c.elected
      FROM cec_candidates c
      JOIN elections e ON e.id = c.election_id
     WHERE p_election_id <> 2026
       AND c.election_id = ANY (CASE WHEN p_election_id = 2022 THEN ARRAY[2022, 4] ELSE ARRAY[p_election_id] END)
  ),
  norm AS (
    SELECT CASE WHEN COALESCE(btrim(party), '') IN ('', '無') OR party LIKE '無黨籍及未經政黨推薦%' THEN '無黨籍' ELSE replace(btrim(party), '臺', '台') END AS p,
           replace(county, '臺', '台') AS c,
           replace(town, '臺', '台') AS t,
           etype AS e,
           CASE WHEN age IS NULL OR age < 0 THEN NULL ELSE LEAST(70, (age / 10) * 10) END AS a,
           CASE WHEN gender IN ('男', '女') THEN gender END AS g,
           CASE elected WHEN true THEN '當選' WHEN false THEN '未當選' END AS r
      FROM src
  ),
  grp AS (
    SELECT p, c, t, e, a, g, r, count(*)::integer AS n FROM norm GROUP BY 1, 2, 3, 4, 5, 6, 7
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('p', p, 'c', c, 't', t, 'e', e, 'a', a, 'g', g, 'r', r, 'n', n)
                            ORDER BY p, c, t, e, a NULLS LAST, g NULLS LAST, r NULLS LAST), '[]'::jsonb)
    FROM grp;
$$;
COMMENT ON FUNCTION party_flow_rows(integer) IS '政黨分流圖用：某一屆名冊依（政黨、縣市、鄉鎮、選舉別、年齡組、性別、當選結果）分組的人數，只有聚合、沒有個資。2026 讀名冊、其他屆讀 cec_candidates（2022 含重行選舉）；查不到的屆別回空陣列。鍵 p c t e a g r n。2026-11-04';
GRANT EXECUTE ON FUNCTION party_flow_rows(integer) TO anon, authenticated;
-- ▲▲ SECTION: party-flow-rows ▲▲
