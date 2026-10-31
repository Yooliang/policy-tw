-- 中選會官方名冊鏡像＋名冊對帳任務（2026-10-31，維護者批准「做」；小良哥補充：三類任務與補號次同級插隊）
-- ============================================================
--
-- 背景：唯讀盤點 2026-10-31 比對中選會選舉專區 JSON（https://info.cec.gov.tw/vote2026/static/json/，含號次 candNo）與正式庫 2026 參選紀錄，
--   人數對不起來（議員 18 單位、鄉鎮市長 7、代表 197、村里長 554…）；同人兩筆重號（北市第7區 Icyang、第8區 Haisul、新北第13區 馬見Lahuy‧Ipin、南市第9區 葉翰勳）；
--   我們多出官方沒有的（多半退選／資格不符）、官方有我們沒有的。目標：號次與人員清單儘可能到 100%。
--
-- 本檔（只建表、函式、排程；不寫任何參選紀錄或人物；不新增任務型別）：
--   1. 官方名冊鏡像 cec_roster_2026（官方參考資料表，不是參選紀錄）＋單位清單 cec_roster_units（每個 JSON 檔一列：抓過沒、結果）。
--      抓取在 Edge Function cec-roster-mirror（pg_cron 每天 UTC 18～21 時每 5 分鐘一輪，每輪約 100 秒預算，同網域每檔間隔 0.5 秒，抓完當天停；
--      約 500 個檔：縣市長 C1、縣市議員 T、鄉鎮市長 D1、區長 D2、代表 R、區民代表 R3 各縣市一檔；村里長 V1 每鄉鎮一檔）。
--      單位換檔一律整檔原子替換；404 不當錯誤（沒有這種選舉）；200 但空的、而之前有人，視為可疑、保留舊資料。
--   2. 比對 cec_roster_diff()（唯讀，可重複算）：以「號次單位」為範圍；姓名鍵沿用 roster_name_key（臺台、異體字、去尾端羅馬拼音），
--      先一對一完全相同，剩下的再做容錯（只做比對，不開任務）：造字代碼（@2F97F@）當 1～2 字的萬用字元、同號次僅差一字、同號次一方是另一方的子字串。
--      三種結果：extra（我們有效〔非 withdrawn〕但官方名冊沒有）、missing（官方有我們沒有）、dup（同單位同號次我們有兩筆人物）。
--      只比「該單位 JSON 近 3 天內抓成功」的範圍。dup 配對由 cec_roster_refresh_dups() 寫進 cec_roster_dup_pairs（查詢用）。
--   3. 名單清查 roster_check 的 target.registration（函式 roster_registration_gap）：2026 屆、該單位有新鮮的鏡像資料時，改以 cec_roster_2026 為名冊來源
--      （造字代碼姓名也比得上），沒有鏡像資料才退回 9 月登記彙總表（cec_registrations）；missing／needs_status／系統自動建（target.reconcile）照舊流程。
--      派工判準（名單清查何時派，讀 roster_reconcile_units）與系統自動建人物（roster_reconcile_next）也走同一個來源選擇（共用函式 cec_roster_mirror_units／cec_roster_unit_mirrored）：
--      重定義 roster_reconcile_rows，只換名冊那一段；村里長 JSON 沒有村里名，系統建不起來，仍用登記彙總表。
--   「站上有、官方名冊沒有」的人不另建任務：cec_roster_diff() 的 extra 供手動打網站請求用（scripts/cec-roster-extra.sql）。
-- 守門：_shared/cec-roster-diff.test.ts。

-- ▼▼ SECTION: tables ▼▼
CREATE TABLE IF NOT EXISTS cec_roster_units (
  url           TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('C1', 'T', 'D1', 'D2', 'R', 'R3', 'V1')),
  election_type TEXT NOT NULL,
  county        TEXT NOT NULL,
  county_code   TEXT NOT NULL,
  town          TEXT NOT NULL DEFAULT '',   -- 只有村里長（每鄉鎮一檔）有值
  town_code     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'absent', 'error')),
  http_status   INTEGER,
  row_count     INTEGER NOT NULL DEFAULT 0,
  fetched_at    TIMESTAMPTZ,                -- 最近一次成功（200 或確認沒有這個檔）的時間
  attempted_at  TIMESTAMPTZ,                -- 最近一次嘗試（成功或失敗），失敗的 10 分鐘後才再試
  error         TEXT
);
ALTER TABLE cec_roster_units ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cec_roster_units_read ON cec_roster_units;
CREATE POLICY cec_roster_units_read ON cec_roster_units FOR SELECT USING (true);
COMMENT ON TABLE cec_roster_units IS '官方名冊鏡像的抓取單位（一個 JSON 檔一列）：status＝ok 抓成功、absent 官方沒有這個檔（404）、error 失敗待重試、pending 還沒抓。比對只信 ok 且 fetched_at 在 3 天內的單位。2026-10-31';

CREATE TABLE IF NOT EXISTS cec_roster_2026 (
  id            BIGSERIAL PRIMARY KEY,
  election_type TEXT NOT NULL,
  county_code   TEXT NOT NULL,              -- 縣市碼（prvCityDept.json 的 prvCityCode）
  county        TEXT NOT NULL,
  town_code     TEXT NOT NULL DEFAULT '',   -- 鄉鎮碼（deptCode）
  town          TEXT NOT NULL DEFAULT '',
  district      TEXT NOT NULL DEFAULT '',   -- 選區（議員、代表的 areaName，原字）
  area_code     TEXT NOT NULL DEFAULT '',
  li_code       TEXT NOT NULL DEFAULT '',   -- 村里序號（村里長）
  name          TEXT NOT NULL,
  name_key      TEXT,
  cand_no       INTEGER,
  party         TEXT,
  birth         TEXT,
  home          TEXT,
  unit_key      TEXT NOT NULL,              -- 號次單位（跟 ballot_number_unit 同寫法；議員選舉區補成兩位；村里長只到鄉鎮）
  unit_url      TEXT NOT NULL REFERENCES cec_roster_units(url) ON DELETE CASCADE,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cec_roster_2026_unit ON cec_roster_2026 (election_type, unit_key);
CREATE INDEX IF NOT EXISTS idx_cec_roster_2026_url ON cec_roster_2026 (unit_url);
ALTER TABLE cec_roster_2026 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cec_roster_2026_read ON cec_roster_2026;
CREATE POLICY cec_roster_2026_read ON cec_roster_2026 FOR SELECT USING (true);
COMMENT ON TABLE cec_roster_2026 IS '中選會選舉專區 2026 候選人名冊鏡像（官方參考資料，不是參選紀錄；每天由 cec-roster-mirror 整檔替換）。系統不據此直接改 politician_elections／politicians，只開任務讓代理查證。2026-10-31';

-- 同單位同號次、我們有兩筆人物的配對（reconcile 每次整表重算；contribution_auto_tasks_dup 讀它）
CREATE TABLE IF NOT EXISTS cec_roster_dup_pairs (
  a_id          UUID NOT NULL,
  b_id          UUID NOT NULL,
  election_type TEXT NOT NULL,
  unit          TEXT NOT NULL,
  cand_no       INTEGER NOT NULL,
  roster_name   TEXT,
  roster_url    TEXT,
  found_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (a_id, b_id)
);
ALTER TABLE cec_roster_dup_pairs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cec_roster_dup_pairs_read ON cec_roster_dup_pairs;
CREATE POLICY cec_roster_dup_pairs_read ON cec_roster_dup_pairs FOR SELECT USING (true);
COMMENT ON TABLE cec_roster_dup_pairs IS '名冊對帳找到的「同單位同號次兩筆人物」配對（a_id < b_id）；contribution_auto_tasks_dup 據此開 duplicate_politician（target.roster_gap）。2026-10-31';

-- 單列狀態：最近一次對帳時間（reconcile_if_due 用）
CREATE TABLE IF NOT EXISTS cec_roster_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  last_reconciled_at TIMESTAMPTZ,
  last_summary       JSONB
);
INSERT INTO cec_roster_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE cec_roster_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cec_roster_state_read ON cec_roster_state;
CREATE POLICY cec_roster_state_read ON cec_roster_state FOR SELECT USING (true);
-- ▲▲ SECTION: tables ▲▲

-- ▼▼ SECTION: match ▼▼
-- 號次單位字串：議員的選舉區補成兩位（第7＝第07），其他不動（代表的 ballot_number_unit 本來就補兩位）
CREATE OR REPLACE FUNCTION cec_roster_norm_unit(p_unit TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_unit ~ '\|第[0-9]+選舉區$'
              THEN split_part(p_unit, '|', 1) || '|第' || lpad((regexp_match(p_unit, '第0*([0-9]+)選舉區$'))[1], 2, '0') || '選舉區'
              ELSE p_unit END
$$;

-- 名冊那一邊的號次單位（跟 ballot_number_unit 的字串對得上；村里長只到鄉鎮）
CREATE OR REPLACE FUNCTION cec_roster_unit_key(p_type TEXT, p_county TEXT, p_town TEXT, p_area TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type = '縣市長' THEN replace(p_county, '臺', '台')
    WHEN p_type = '縣市議員' THEN replace(p_county, '臺', '台') || '|第' || lpad(regexp_replace(COALESCE(p_area, ''), '^0+', ''), 2, '0') || '選舉區'
    WHEN p_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長') THEN replace(p_county, '臺', '台') || '|' || replace(p_town, '臺', '台')
    WHEN p_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
      THEN replace(p_county, '臺', '台') || '|' || replace(p_town, '臺', '台') || '第' || lpad(regexp_replace(COALESCE(p_area, ''), '^0+', ''), 2, '0') || '選舉區'
  END
$$;

-- 兩個姓名鍵是不是「同一個人」的容錯比對（只用在對帳，不開任務）。
--   完全相同；造字代碼（@2F97F@ 這種）當 1～2 個字的萬用字元；同號次僅差一字；同號次一方是另一方的子字串（較短的至少 2 字：法定全名與暱稱）。
CREATE OR REPLACE FUNCTION cec_name_fuzzy_eq(a TEXT, b TEXT, a_no INTEGER, b_no INTEGER) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE tok TEXT := '@[0-9A-Fa-f]{3,6}@'; pat TEXT; diff INTEGER; i INTEGER;
BEGIN
  IF a IS NULL OR b IS NULL OR a = '' OR b = '' THEN RETURN false; END IF;
  IF a = b THEN RETURN true; END IF;
  IF b ~ tok THEN
    pat := '^' || regexp_replace(regexp_replace(b, '([\\^$.|?*+()\[\]{}])', '\\\1', 'g'), tok, '.{1,2}', 'g') || '$';
    IF a ~ pat THEN RETURN true; END IF;
  END IF;
  IF a ~ tok THEN
    pat := '^' || regexp_replace(regexp_replace(a, '([\\^$.|?*+()\[\]{}])', '\\\1', 'g'), tok, '.{1,2}', 'g') || '$';
    IF b ~ pat THEN RETURN true; END IF;
  END IF;
  IF a_no IS NOT NULL AND b_no IS NOT NULL AND a_no = b_no THEN
    IF length(a) = length(b) AND length(a) >= 2 THEN
      diff := 0;
      FOR i IN 1..length(a) LOOP
        IF substr(a, i, 1) <> substr(b, i, 1) THEN diff := diff + 1; END IF;
        EXIT WHEN diff > 1;
      END LOOP;
      IF diff = 1 THEN RETURN true; END IF;
    END IF;
    IF least(length(a), length(b)) >= 2 AND (position(a IN b) > 0 OR position(b IN a) > 0) THEN RETURN true; END IF;
  END IF;
  RETURN false;
END;
$$;
COMMENT ON FUNCTION cec_name_fuzzy_eq IS '名冊對帳的姓名容錯：完全相同、造字代碼（@2F97F@）當萬用字元、同號次僅差一字、同號次子字串（較短至少 2 字）。只用在比對，不開任務。2026-10-31';

-- 比對：回傳三種差異（kind＝extra／missing／dup）。唯讀、可重複算；範圍只含近 3 天內抓成功的 JSON 單位。
CREATE OR REPLACE FUNCTION cec_roster_diff()
RETURNS TABLE (kind TEXT, diff_key TEXT, election_type TEXT, county TEXT, town TEXT, unit TEXT, cand_no INTEGER,
               pe_id INTEGER, politician_id UUID, our_name TEXT, our_status TEXT, our_cand_no INTEGER,
               roster_id BIGINT, roster_name TEXT, roster_party TEXT, roster_birth TEXT, roster_url TEXT, roster_li_code TEXT,
               partner_pe_id INTEGER, partner_politician_id UUID, partner_name TEXT)
LANGUAGE sql STABLE SET enable_nestloop = off AS $fn$
  WITH
  fresh AS MATERIALIZED (
    SELECT u.election_type, replace(u.county, '臺', '台') AS county, replace(u.town, '臺', '台') AS town
      FROM cec_roster_units u WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'
  ),
  r AS MATERIALIZED (
    SELECT x.id, x.election_type, replace(x.county, '臺', '台') AS county, replace(x.town, '臺', '台') AS town, x.unit_key AS unit, x.name,
           COALESCE(x.name_key, roster_name_key(x.name)) AS nkey, x.cand_no, x.party, x.birth, x.unit_url, x.li_code
      FROM cec_roster_2026 x
      JOIN fresh f ON f.election_type = x.election_type AND f.county = replace(x.county, '臺', '台')
                  AND (x.election_type <> '村里長' OR f.town = replace(x.town, '臺', '台'))
  ),
  o0 AS MATERIALIZED (
    SELECT pe.id AS pe_id, pe.politician_id, p.name, roster_name_key(p.name) AS nkey, pe.election_type,
           replace(COALESCE(rg.region, p.region), '臺', '台') AS county,
           CASE WHEN pe.election_type = '村里長' THEN COALESCE(replace(rg.sub_region, '臺', '台'), '') ELSE '' END AS scope_town,
           pe.cand_no, pe.candidacy_status AS status, rg.sub_region, rg.village
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.election_id = 2026
       AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
       AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
  ),
  o AS MATERIALIZED (
    SELECT o0.*,
           CASE WHEN o0.election_type = '村里長'
                THEN CASE WHEN o0.scope_town <> '' THEN o0.county || '|' || o0.scope_town END
                ELSE cec_roster_norm_unit(ballot_number_unit(o0.election_type, o0.county, o0.sub_region, o0.sub_region, o0.village)) END AS unit
      FROM o0
     WHERE o0.county IS NOT NULL
       AND EXISTS (SELECT 1 FROM fresh f WHERE f.election_type = o0.election_type AND f.county = o0.county AND f.town = o0.scope_town)
  ),
  -- 第一輪：同單位、同姓名鍵，一對一（同名的依號次排名配對）
  ro AS MATERIALIZED (SELECT r.*, row_number() OVER (PARTITION BY r.election_type, r.unit, r.nkey ORDER BY r.cand_no, r.id) AS rk FROM r),
  oo AS MATERIALIZED (SELECT o.*, row_number() OVER (PARTITION BY o.election_type, o.unit, o.nkey ORDER BY o.cand_no, o.pe_id) AS rk FROM o WHERE o.unit IS NOT NULL),
  m1 AS MATERIALIZED (
    SELECT oo.pe_id, ro.id AS rid FROM oo JOIN ro ON ro.election_type = oo.election_type AND ro.unit = oo.unit AND ro.nkey = oo.nkey AND ro.rk = oo.rk
  ),
  -- 第二輪：剩下的在同單位做容錯
  lo AS MATERIALIZED (SELECT o.* FROM o WHERE o.unit IS NOT NULL AND NOT EXISTS (SELECT 1 FROM m1 WHERE m1.pe_id = o.pe_id)),
  lr AS MATERIALIZED (SELECT r.* FROM r WHERE NOT EXISTS (SELECT 1 FROM m1 WHERE m1.rid = r.id)),
  m2 AS MATERIALIZED (
    SELECT lo.pe_id, lr.id AS rid FROM lo JOIN lr ON lr.election_type = lo.election_type AND lr.unit = lo.unit AND cec_name_fuzzy_eq(lo.nkey, lr.nkey, lo.cand_no, lr.cand_no)
  ),
  -- 第三輪：參選紀錄沒有選區／鄉鎮（單位算不出來），退到縣市（村里長到鄉鎮）層級比姓名
  m3 AS MATERIALIZED (
    SELECT o.pe_id, r.id AS rid FROM o JOIN r ON r.election_type = o.election_type AND r.county = o.county
                                               AND (o.election_type <> '村里長' OR r.town = o.scope_town)
     WHERE o.unit IS NULL AND cec_name_fuzzy_eq(o.nkey, r.nkey, o.cand_no, r.cand_no)
  ),
  mo AS MATERIALIZED (SELECT pe_id FROM m1 UNION SELECT pe_id FROM m2 UNION SELECT pe_id FROM m3),
  mr AS MATERIALIZED (SELECT rid FROM m1 UNION SELECT rid FROM m2 UNION SELECT rid FROM m3),
  -- 同單位同號次、我們有兩筆不同人物，且其中至少一筆對不上官方名冊，而官方在該單位有這個號次（村里長的單位是村里，官方只到鄉鎮）
  dg AS MATERIALIZED (
    SELECT DISTINCT ON (a.politician_id, b.politician_id)
           a.pe_id AS a_pe, a.politician_id AS a_pid, a.name AS a_name, b.pe_id AS b_pe, b.politician_id AS b_pid, b.name AS b_name,
           a.election_type, a.county, a.scope_town, a.unit, a.cand_no, rr.id AS rid, rr.name AS rname, rr.party AS rparty, rr.birth AS rbirth, rr.unit_url AS rurl, rr.li_code AS rli
      FROM o a
      JOIN o b ON b.election_type = a.election_type AND b.unit = a.unit AND b.cand_no = a.cand_no AND b.politician_id > a.politician_id
              AND COALESCE(b.village, '') = COALESCE(a.village, '')
      JOIN r rr ON rr.election_type = a.election_type AND rr.unit = a.unit AND rr.cand_no = a.cand_no
     WHERE a.unit IS NOT NULL AND a.cand_no IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM mo WHERE mo.pe_id = a.pe_id) OR NOT EXISTS (SELECT 1 FROM mo WHERE mo.pe_id = b.pe_id))
     ORDER BY a.politician_id, b.politician_id, rr.id
  ),
  dx AS MATERIALIZED (SELECT a_pe AS pe_id FROM dg UNION SELECT b_pe FROM dg),
  dr AS MATERIALIZED (SELECT rid FROM dg)
  SELECT 'extra', 'extra:' || o.pe_id, o.election_type, o.county, o.scope_town, o.unit, o.cand_no,
         o.pe_id, o.politician_id, o.name, o.status, o.cand_no,
         NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
         NULL::INTEGER, NULL::UUID, NULL::TEXT
    FROM o WHERE o.unit IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM mo WHERE mo.pe_id = o.pe_id) AND NOT EXISTS (SELECT 1 FROM dx WHERE dx.pe_id = o.pe_id)
  UNION ALL
  SELECT 'missing', 'missing:' || r.election_type || '|' || r.unit || '|' || r.li_code || '|' || COALESCE(r.cand_no::TEXT, '') || '|' || COALESCE(r.nkey, ''),
         r.election_type, r.county, CASE WHEN r.election_type = '村里長' THEN r.town ELSE '' END, r.unit, r.cand_no,
         NULL::INTEGER, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INTEGER,
         r.id, r.name, r.party, r.birth, r.unit_url, r.li_code,
         NULL::INTEGER, NULL::UUID, NULL::TEXT
    FROM (SELECT DISTINCT ON (x.election_type, x.unit, x.li_code, x.cand_no, x.nkey) x.*
            FROM r x WHERE NOT EXISTS (SELECT 1 FROM mr WHERE mr.rid = x.id) AND NOT EXISTS (SELECT 1 FROM dr WHERE dr.rid = x.id)
           ORDER BY x.election_type, x.unit, x.li_code, x.cand_no, x.nkey, x.id) r
  UNION ALL
  SELECT 'dup', 'dup:' || g.a_pid || '|' || g.b_pid, g.election_type, g.county, g.scope_town, g.unit, g.cand_no,
         g.a_pe, g.a_pid, g.a_name, NULL::TEXT, g.cand_no,
         g.rid, g.rname, g.rparty, g.rbirth, g.rurl, g.rli,
         g.b_pe, g.b_pid, g.b_name
    FROM dg g
$fn$;
COMMENT ON FUNCTION cec_roster_diff IS '官方名冊鏡像 × 我們的 2026 參選紀錄（非 withdrawn）的差異：extra（我們有、官方沒有）、missing（官方有、我們沒有）、dup（同單位同號次兩筆人物，至少一筆對不上官方）。只比近 3 天內抓成功的單位；容錯規則見 cec_name_fuzzy_eq。唯讀。2026-10-31';
-- ▲▲ SECTION: match ▲▲

-- ▼▼ SECTION: mirror ▼▼
-- 單位清單：縣市層級六種各縣市一檔（C1、T、D1、D2、R、R3）、村里長每鄉鎮一檔（V1）；網址用 cec_vote2026_cand_url（20261031140000）
CREATE OR REPLACE FUNCTION cec_roster_seed_units() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  INSERT INTO cec_roster_units (url, kind, election_type, county, county_code, town, town_code)
  SELECT cec_vote2026_cand_url(k.et, c.county, t.town), k.kind, k.et, c.county, c.county_code, COALESCE(t.town, ''), COALESCE(t.town_code, '')
    FROM cec_vote2026_codes c
    CROSS JOIN (VALUES ('C1', '縣市長'), ('T', '縣市議員'), ('D1', '鄉鎮市長'), ('D2', '直轄市山地原住民區長'), ('R', '鄉鎮市民代表'), ('R3', '直轄市山地原住民區民代表')) AS k(kind, et)
    LEFT JOIN LATERAL (SELECT NULL::TEXT AS town, NULL::TEXT AS town_code) t ON true
   WHERE c.town = ''
     AND cec_vote2026_cand_url(k.et, c.county, NULL) IS NOT NULL
  ON CONFLICT (url) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO cec_roster_units (url, kind, election_type, county, county_code, town, town_code)
  SELECT cec_vote2026_cand_url('村里長', c.county, t.town), 'V1', '村里長', c.county, c.county_code, t.town, t.town_code
    FROM cec_vote2026_codes c JOIN cec_vote2026_codes t ON t.county = c.county AND t.town <> ''
   WHERE c.town = '' AND cec_vote2026_cand_url('村里長', c.county, t.town) IS NOT NULL
  ON CONFLICT (url) DO NOTHING;
  RETURN v_n + (SELECT 0);
END;
$$;
COMMENT ON FUNCTION cec_roster_seed_units IS '把縣市與鄉鎮碼對照表（cec_vote2026_codes）展開成要抓的 JSON 單位（約 500 個），已有的不動。2026-10-31';

-- 該抓的單位：沒抓過或超過 p_stale 沒成功，且最近 10 分鐘內沒試過
CREATE OR REPLACE FUNCTION cec_roster_next_units(p_limit INTEGER DEFAULT 40, p_stale INTERVAL DEFAULT INTERVAL '20 hours')
RETURNS TABLE (url TEXT, kind TEXT, election_type TEXT, county TEXT, county_code TEXT, town TEXT, town_code TEXT)
LANGUAGE sql STABLE AS $$
  SELECT u.url, u.kind, u.election_type, u.county, u.county_code, u.town, u.town_code
    FROM cec_roster_units u
   WHERE (u.fetched_at IS NULL OR u.fetched_at < now() - p_stale)
     AND (u.attempted_at IS NULL OR u.attempted_at < now() - INTERVAL '10 minutes')
   ORDER BY u.fetched_at NULLS FIRST, u.url
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 40), 200))
$$;

-- 單位換檔：p_http＝200 帶 p_rows（jsonb 陣列：name、cand_no、party、birth、home、district、area_code、dept_code、li_code）；404＝官方沒有這個檔；p_error 非空＝失敗
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
  INSERT INTO cec_roster_2026 (election_type, county_code, county, town_code, town, district, area_code, li_code, name, name_key, cand_no, party, birth, home, unit_key, unit_url, fetched_at)
  SELECT u.election_type, u.county_code, u.county,
         COALESCE(NULLIF(x.dept_code, ''), u.town_code), COALESCE(tt.town, u.town),
         COALESCE(x.district, ''), COALESCE(x.area_code, ''), COALESCE(x.li_code, ''),
         x.name, roster_name_key(x.name), x.cand_no, x.party, x.birth, x.home,
         cec_roster_unit_key(u.election_type, u.county, COALESCE(tt.town, u.town), x.area_code), p_url, now()
    FROM jsonb_to_recordset(p_rows) AS x(name TEXT, cand_no INTEGER, party TEXT, birth TEXT, home TEXT, district TEXT, area_code TEXT, dept_code TEXT, li_code TEXT)
    LEFT JOIN LATERAL (SELECT c.town FROM cec_vote2026_codes c WHERE c.county_code = u.county_code AND c.town_code = NULLIF(x.dept_code, '') AND c.town <> '' LIMIT 1) tt ON true
   WHERE NULLIF(btrim(x.name), '') IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE cec_roster_units SET status = 'ok', http_status = 200, row_count = v_n, attempted_at = now(), fetched_at = now(), error = NULL WHERE url = p_url;
  RETURN 'ok';
END;
$$;
COMMENT ON FUNCTION cec_roster_replace_unit IS '官方名冊單位整檔原子替換：200 換掉舊資料；404 且之前沒資料＝官方沒有（absent）；200 但空而之前有資料、或 404 而之前有資料＝可疑，保留舊資料標 error；失敗帶 p_error。2026-10-31';
-- ▲▲ SECTION: mirror ▲▲

-- ▼▼ SECTION: reconcile ▼▼
-- 同單位同號次、我們有兩筆人物的配對：整表重算，只供查詢用（不建任務）。
CREATE OR REPLACE FUNCTION cec_roster_refresh_dups() RETURNS INTEGER
LANGUAGE plpgsql AS $fn$
DECLARE v_n INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('cec_roster_refresh_dups'));
  DELETE FROM cec_roster_dup_pairs;
  INSERT INTO cec_roster_dup_pairs (a_id, b_id, election_type, unit, cand_no, roster_name, roster_url)
  SELECT d.politician_id, d.partner_politician_id, d.election_type, d.unit, d.cand_no, d.roster_name, d.roster_url FROM cec_roster_diff() d WHERE d.kind = 'dup'
  ON CONFLICT (a_id, b_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE cec_roster_state SET last_reconciled_at = now(), last_summary = jsonb_build_object('dup_pairs', v_n) WHERE id = 1;
  RETURN v_n;
END;
$fn$;
COMMENT ON FUNCTION cec_roster_refresh_dups IS '重算 cec_roster_dup_pairs（同單位同號次兩筆人物，查詢用）。不建任務、不改任何參選紀錄。2026-10-31';

-- 鏡像抓完（沒有待抓單位）而且比上次重算新，才重算；沒到時機回 NULL
CREATE OR REPLACE FUNCTION cec_roster_reconcile_if_due() RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_last TIMESTAMPTZ; v_newest TIMESTAMPTZ;
BEGIN
  IF EXISTS (SELECT 1 FROM cec_roster_units u WHERE u.fetched_at IS NULL OR u.fetched_at < now() - INTERVAL '20 hours') THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM cec_roster_units) THEN RETURN NULL; END IF;
  SELECT s.last_reconciled_at INTO v_last FROM cec_roster_state s WHERE s.id = 1;
  SELECT max(u.fetched_at) INTO v_newest FROM cec_roster_units u;
  IF v_last IS NOT NULL AND v_last >= v_newest THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('dup_pairs', cec_roster_refresh_dups());
END;
$$;
COMMENT ON FUNCTION cec_roster_reconcile_if_due IS '沒有待抓單位、且最新一次抓取比上次重算新，才重算同號兩筆配對；否則回 NULL。鏡像函式每輪結尾與備援排程都呼叫。2026-10-31';
-- ▲▲ SECTION: reconcile ▲▲

-- ▼▼ SECTION: auth ▼▼
REVOKE ALL ON FUNCTION cec_roster_seed_units() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION cec_roster_next_units(INTEGER, INTERVAL) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION cec_roster_replace_unit(TEXT, INTEGER, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION cec_roster_refresh_dups() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION cec_roster_reconcile_if_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cec_roster_seed_units() TO service_role;
GRANT EXECUTE ON FUNCTION cec_roster_next_units(INTEGER, INTERVAL) TO service_role;
GRANT EXECUTE ON FUNCTION cec_roster_replace_unit(TEXT, INTEGER, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION cec_roster_refresh_dups() TO service_role;
GRANT EXECUTE ON FUNCTION cec_roster_reconcile_if_due() TO service_role;
-- ▲▲ SECTION: auth ▲▲

-- ▼▼ SECTION: source ▼▼
-- 名冊來源的共用判斷（派工判準 roster_reconcile_rows、系統自動建人物、任務附的名冊 roster_registration_gap 三處同一個定義）：
-- 該單位（屆別 2026、選舉別、縣市；村里長到鄉鎮）有 3 天內成功抓取、而且有資料的中選會 JSON → 用 cec_roster_2026，沒有才用 9 月登記彙總表。
-- p_for_build＝true（給系統建人物與派工判準用）時村里長不算：JSON 只有村里序號、沒有村里名，系統建不起來，村里長仍用登記彙總表。
CREATE OR REPLACE FUNCTION cec_roster_mirror_units(p_for_build BOOLEAN DEFAULT false)
RETURNS TABLE (election_type TEXT, county TEXT, town TEXT)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT u.election_type, replace(u.county, '臺', '台'), CASE WHEN u.election_type = '村里長' THEN replace(u.town, '臺', '台') ELSE '' END
    FROM cec_roster_units u
   WHERE u.status = 'ok' AND u.row_count > 0 AND u.fetched_at > now() - INTERVAL '3 days'
     AND NOT (p_for_build AND u.election_type = '村里長')
$$;
COMMENT ON FUNCTION cec_roster_mirror_units IS '有新鮮官方名冊鏡像（3 天內成功抓取且有資料）的單位清單；名冊來源選擇的唯一定義。p_for_build＝true 時排除村里長（JSON 沒有村里名）。2026-10-31';

CREATE OR REPLACE FUNCTION cec_roster_unit_mirrored(p_election_id INTEGER, p_election_type TEXT, p_county TEXT, p_town TEXT DEFAULT NULL) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT p_election_id = 2026 AND EXISTS (
    SELECT 1 FROM cec_roster_mirror_units(false) m
     WHERE m.election_type = p_election_type AND m.county = replace(p_county, '臺', '台')
       AND (m.town = '' OR (p_town IS NOT NULL AND m.town = replace(p_town, '臺', '台'))))
$$;
COMMENT ON FUNCTION cec_roster_unit_mirrored IS '這個單位的名冊要不要用官方 JSON 鏡像（roster_registration_gap 用；村里長要給鄉鎮）。2026-10-31';

-- ▲▲ SECTION: source ▲▲

-- ▼▼ SECTION: rows ▼▼
CREATE OR REPLACE FUNCTION roster_reconcile_rows()
RETURNS TABLE (
  reg_id BIGINT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, sub_region TEXT, village TEXT, district TEXT,
  name TEXT, party TEXT, source_url TEXT, row_no INTEGER, pe_id INTEGER, politician_id UUID, our_status TEXT,
  category TEXT, reason TEXT, person_action TEXT, system_applied BOOLEAN, announce_id BIGINT, announce_state TEXT
)
LANGUAGE sql STABLE
SET enable_nestloop = off  -- 見檔頭：不關的話 CTE 列數被估成 1，選巢狀迴圈，10.6 秒；關掉 0.5 秒
AS $$
  WITH reg AS (
    SELECT r.id AS reg_id, r.election_id, r.election_type, replace(r.region, '臺', '台') AS county,
           r.sub_region, replace(r.sub_region, '臺', '台') AS town, r.village, r.district,
           r.name, roster_name_key(r.name) AS name_key, r.party, r.source_url, r.row_no,
           NULLIF(btrim(replace(COALESCE(r.village, ''), '臺', '台')), '') AS village_n
      FROM cec_registrations r
      JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL
     -- >>> 官方名冊鏡像（20261031160000）：該單位有 3 天內成功抓取的中選會 JSON 就不用登記彙總表（村里長 JSON 沒有村里名，系統建不起來，仍用登記彙總表）
     WHERE NOT EXISTS (SELECT 1 FROM cec_roster_mirror_units(true) mu
                        WHERE mu.election_type = r.election_type AND mu.county = replace(r.region, '臺', '台')
                          AND (mu.town = '' OR mu.town = COALESCE(replace(r.sub_region, '臺', '台'), '')))
    UNION ALL
    -- reg_id：鏡像列每天重抓、id 會變，改用內容（單位、選區、號次、姓名）算出的穩定負數，跟登記彙總表的正數 id 不會撞；log 的「每位只處理一次」靠它
    SELECT -abs(hashtextextended(x.election_type || '|' || x.county || '|' || x.town || '|' || x.area_code || '|' || COALESCE(x.cand_no::TEXT, '') || '|' || x.name, 0)),
           2026, x.election_type, replace(x.county, '臺', '台'),
           CASE WHEN x.election_type = '縣市議員' THEN NULL ELSE NULLIF(x.town, '') END,
           NULLIF(replace(x.town, '臺', '台'), ''), NULL::TEXT,
           CASE WHEN x.area_code <> '' THEN '第' || lpad(regexp_replace(x.area_code, '^0+', ''), 2, '0') || '選舉區' END,
           x.name, roster_name_key(x.name), COALESCE(x.party, '無'), x.unit_url, COALESCE(x.cand_no, 0), NULL::TEXT
      FROM cec_roster_2026 x
     WHERE EXISTS (SELECT 1 FROM cec_roster_mirror_units(true) mu
                    WHERE mu.election_type = x.election_type AND mu.county = replace(x.county, '臺', '台')
                      AND (mu.town = '' OR mu.town = replace(x.town, '臺', '台')))
    -- <<< 官方名冊鏡像
  ),
  regn AS (
    SELECT g.*, CASE WHEN g.name_key IS NULL THEN NULL
                     ELSE count(*) OVER (PARTITION BY g.election_id, g.election_type, g.county, g.name_key) END AS dup_n
      FROM reg g
  ),
  ours AS MATERIALIZED (
    SELECT pe.id AS pe_id, pe.politician_id, pe.election_id, pe.election_type::TEXT AS election_type,
           pe.candidacy_status AS status, COALESCE(pe.withdrawn_after_filing, FALSE) AS filed_out,
           p.name AS pname,
           roster_name_key(p.name) AS nn,
           replace(COALESCE(rg.region, p.region), '臺', '台') AS county,
           NULLIF(replace(regexp_replace(COALESCE(rg.sub_region, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '') AS town,
           substring(COALESCE(rg.sub_region, '') FROM '第[0-9]+選舉區') AS district
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE (pe.election_id, pe.election_type::TEXT) IN (SELECT DISTINCT x.election_id, x.election_type FROM reg x)
  ),
  hit AS (
    SELECT g.reg_id, o.pe_id
      FROM regn g
      JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type
                 AND o.county = g.county AND o.nn = g.name_key
                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)
  ),
  reg_deg AS (SELECT h.reg_id, count(*) AS n, min(h.pe_id) AS pe_id FROM hit h GROUP BY h.reg_id),
  pe_deg AS (SELECT h.pe_id, count(*) AS n FROM hit h GROUP BY h.pe_id),
  -- 同單位先比對（優先於全庫同名規則）：名冊這位沒有名字相同的紀錄，但同屆、同職位、同縣市（鄉鎮層級的選舉要同鄉鎮）已有一筆
  -- 參選紀錄（含已經對上名冊別一列的：正式庫的名冊真的有「佀廣洋」與長名兩列），名字是名冊名的子字串或反過來（較短的那個至少 2 字）——改過名、暱稱與全名、名冊寫法較長：
  -- 多半是同一個人，系統不建（建了就是重複人物），派代理確認（reason＝similar_name_in_unit）
  sim AS (
    SELECT g.reg_id, min(o.pe_id) AS pe_id, min(o.politician_id::TEXT)::UUID AS politician_id
      FROM regn g
      JOIN ours o ON o.election_id = g.election_id AND o.election_type = g.election_type AND o.county = g.county
                 AND (o.town IS NULL OR g.town IS NULL OR o.town = g.town)
                 AND (g.election_type <> '縣市議員' OR o.district IS NULL OR g.district IS NULL OR o.district = g.district)
     WHERE g.name_key IS NOT NULL AND o.nn IS NOT NULL AND o.nn <> g.name_key
       AND g.reg_id NOT IN (SELECT d.reg_id FROM reg_deg d)
       AND ((length(o.nn) >= 2 AND strpos(g.name_key, o.nn) > 0) OR (length(g.name_key) >= 2 AND strpos(o.nn, g.name_key) > 0))
     GROUP BY g.reg_id
  ),
  -- 安全網：同單位只要還有「我們標已表態／已登記／選後（或登記後退選）、卻沒對上名冊」的參選紀錄，名冊這邊沒對上的人就不給 new（改派代理，
  -- reason＝unmatched_candidacy_in_unit）：那一筆多半就是名冊這位換了寫法（異體字、打錯字、純羅馬拼音、暱稱）還沒被比對器認出來，
  -- 這時候建新人物就是重複人物。單位＝同屆、同職位、同縣市（鄉鎮層級要同鄉鎮、縣市議員雙方都有選舉區時要同選舉區）。只擋 new：attach 掛的是既有人物，不會多出人。
  unm AS (
    SELECT o.election_id, o.election_type, o.county, o.town, o.district FROM ours o
     WHERE o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)
       AND (o.status IN ('declared', 'filed', 'elected', 'not_elected') OR (o.status = 'withdrawn' AND o.filed_out))
  ),
  unm_hit AS (
    SELECT DISTINCT g.reg_id
      FROM regn g
      JOIN unm u ON u.election_id = g.election_id AND u.election_type = g.election_type AND u.county = g.county
                AND (u.town IS NULL OR g.town IS NULL OR u.town = g.town)
                AND (g.election_type <> '縣市議員' OR u.district IS NULL OR g.district IS NULL OR u.district = g.district)
     WHERE g.reg_id NOT IN (SELECT d.reg_id FROM reg_deg d)
  ),
  -- 人物：全庫同名（姓名鍵相同、未合併）的人有幾位；剛好一位時，他要「看得出是同一個地方的人」（鄉鎮層級的選舉要同縣市同鄉鎮，其餘同縣市）
  -- 而且這一屆還沒有別筆參選紀錄（一人一屆一筆），才能掛上去
  pn AS MATERIALIZED (
    SELECT p.id, roster_name_key(p.name) AS nn, replace(p.region, '臺', '台') AS pregion, p.party
      FROM politicians p
     WHERE p.merged_into IS NULL
       AND roster_name_key(p.name) IN (SELECT x.name_key FROM regn x WHERE x.name_key IS NOT NULL)
  ),
  pn_n AS (SELECT q.nn, count(*) AS n, min(q.id::TEXT)::UUID AS one_id, min(q.pregion) AS pregion, min(q.party) AS party FROM pn q GROUP BY q.nn),
  pplace AS (
    SELECT DISTINCT pe.politician_id, replace(rg.region, '臺', '台') AS county,
           NULLIF(replace(regexp_replace(COALESCE(rg.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '') AS town,
           NULLIF(btrim(replace(COALESCE(rg.village, ''), '臺', '台')), '') AS village
      FROM politician_elections pe JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.politician_id IN (SELECT z.one_id FROM pn_n z WHERE z.n = 1)
  ),
  pplace_c AS (SELECT DISTINCT q.politician_id, q.county FROM pplace q),
  pplace_t AS (SELECT DISTINCT q.politician_id, q.county, q.town FROM pplace q WHERE q.town IS NOT NULL),
  -- 村里長：既有的參選紀錄在這個鄉鎮「有明確村里」（pv_any）而名冊的村里跟其中任何一個都不同（沒有 pv_eq）→ 不掛（同鄉鎮不同里的同名者是兩個人）
  pv_any AS (SELECT DISTINCT q.politician_id, q.county, q.town FROM pplace q WHERE q.town IS NOT NULL AND q.village IS NOT NULL),
  pv_eq AS (SELECT DISTINCT q.politician_id, q.county, q.town, q.village FROM pplace q WHERE q.town IS NOT NULL AND q.village IS NOT NULL),
  p_has AS (
    SELECT DISTINCT pe.politician_id, pe.election_id
      FROM politician_elections pe WHERE pe.politician_id IN (SELECT z.one_id FROM pn_n z WHERE z.n = 1)
  ),
  -- 全部用相等連接（不用相關子查詢：關掉 nested loop 之後，相關子查詢逐列掃整張暫存表，20 秒）
  person AS (
    SELECT g.reg_id,
           CASE WHEN COALESCE(n.n, 0) = 0 THEN 'new'
                WHEN n.n = 1
                 AND h.politician_id IS NULL
                 AND (CASE WHEN g.town IS NULL THEN (n.pregion = g.county OR pc.politician_id IS NOT NULL)
                           ELSE pt.politician_id IS NOT NULL END)
                 AND NOT (g.election_type = '村里長' AND g.village_n IS NOT NULL AND va.politician_id IS NOT NULL AND ve.politician_id IS NULL)
                 -- 政黨互斥（兩邊都不是無黨籍、而且不同黨）不自動掛
                 AND NOT (COALESCE(btrim(g.party), '') NOT IN ('', '無', '無黨籍') AND COALESCE(btrim(n.party), '') NOT IN ('', '無', '無黨籍')
                          AND strpos(n.party, g.party) = 0 AND strpos(g.party, n.party) = 0)
                THEN 'attach' END AS person_action,
           CASE WHEN n.n = 1 THEN n.one_id END AS one_id
      FROM regn g
      LEFT JOIN pn_n n ON n.nn = g.name_key
      LEFT JOIN p_has h ON h.politician_id = n.one_id AND h.election_id = g.election_id
      LEFT JOIN pplace_c pc ON pc.politician_id = n.one_id AND pc.county = g.county
      LEFT JOIN pplace_t pt ON pt.politician_id = n.one_id AND pt.county = g.county AND pt.town = g.town
      LEFT JOIN pv_any va ON va.politician_id = n.one_id AND va.county = g.county AND va.town = g.town
      LEFT JOIN pv_eq ve ON ve.politician_id = n.one_id AND ve.county = g.county AND ve.town = g.town AND ve.village = g.village_n
     WHERE g.name_key IS NOT NULL AND g.reg_id NOT IN (SELECT d.reg_id FROM reg_deg d)
  ),
  rows_reg AS (
    SELECT g.reg_id, g.election_id, g.election_type, g.county, COALESCE(g.town, '') AS town, g.sub_region, g.village, g.district,
           g.name, g.party, g.source_url, g.row_no, COALESCE(o.pe_id, sm.pe_id) AS pe_id, COALESCE(o.politician_id, sm.politician_id, pr.one_id) AS politician_id, o.status AS our_status,
           CASE
             WHEN g.name_key IS NULL THEN 'missing_ambiguous'
             WHEN rd.n = 1 AND pd.n = 1 THEN
               CASE WHEN o.status = 'considering' OR (o.status = 'withdrawn' AND NOT o.filed_out) THEN 'status_mismatch' ELSE 'both' END
             WHEN rd.n >= 1 THEN 'match_ambiguous'
             WHEN sm.reg_id IS NOT NULL THEN 'missing_ambiguous'
             WHEN ap.reg_id IS NOT NULL THEN 'missing_ambiguous'
             WHEN g.dup_n > 1 THEN 'missing_ambiguous'
             WHEN pr.person_action IS NULL THEN 'missing_ambiguous'
             WHEN pr.person_action = 'new' AND uh.reg_id IS NOT NULL THEN 'missing_ambiguous'
             ELSE 'missing_creatable' END AS category,
           CASE
             WHEN g.name_key IS NULL THEN 'unreadable_name'
             WHEN rd.n = 1 AND pd.n = 1 THEN
               CASE WHEN o.status = 'considering' THEN 'ours_considering'
                    WHEN o.status = 'withdrawn' AND NOT o.filed_out THEN 'ours_withdrawn_not_after_filing' END
             WHEN rd.n >= 1 THEN 'match_not_one_to_one'
             WHEN sm.reg_id IS NOT NULL THEN 'similar_name_in_unit'
             WHEN ap.reg_id IS NOT NULL THEN
               CASE WHEN ap.reverted_at IS NOT NULL THEN 'system_reverted'
                    WHEN ap.outcome = 'applied' THEN 'system_applied_gone'
                    ELSE 'system_unresolved' END
             WHEN g.dup_n > 1 THEN 'same_name_multi'
             WHEN pr.person_action IS NULL THEN 'person_unclear'
             WHEN pr.person_action = 'new' AND uh.reg_id IS NOT NULL THEN 'unmatched_candidacy_in_unit'
             END AS reason,
           CASE WHEN rd.n IS NULL AND ap.reg_id IS NULL AND sm.reg_id IS NULL AND g.name_key IS NOT NULL AND g.dup_n = 1
                     AND NOT (pr.person_action = 'new' AND uh.reg_id IS NOT NULL) THEN pr.person_action END AS person_action,
           (ap.reg_id IS NOT NULL AND ap.outcome = 'applied' AND ap.reverted_at IS NULL) AS system_applied
      FROM regn g
      LEFT JOIN reg_deg rd ON rd.reg_id = g.reg_id
      LEFT JOIN pe_deg pd ON pd.pe_id = rd.pe_id
      LEFT JOIN ours o ON o.pe_id = rd.pe_id
      LEFT JOIN person pr ON pr.reg_id = g.reg_id
      LEFT JOIN sim sm ON sm.reg_id = g.reg_id
      LEFT JOIN unm_hit uh ON uh.reg_id = g.reg_id
      LEFT JOIN roster_reconcile_log ap ON ap.reg_id = g.reg_id
  ),
  rows_ours AS (
    SELECT NULL::BIGINT AS reg_id, o.election_id, o.election_type, o.county, COALESCE(o.town, '') AS town, o.town AS sub_region, NULL::TEXT AS village, NULL::TEXT AS district,
           o.pname AS name, NULL::TEXT AS party, NULL::TEXT AS source_url, NULL::INTEGER AS row_no,
           o.pe_id, o.politician_id, o.status AS our_status,
           CASE WHEN o.status IN ('declared', 'filed', 'elected', 'not_elected') THEN 'ours_extra' ELSE 'status_mismatch' END AS category,
           CASE WHEN o.status IN ('declared', 'filed', 'elected', 'not_elected') THEN 'not_in_registration' ELSE 'filed_flag_no_registration' END AS reason,
           NULL::TEXT AS person_action, FALSE AS system_applied
      FROM ours o
     WHERE o.pe_id NOT IN (SELECT d.pe_id FROM pe_deg d)
       AND (o.status IN ('declared', 'filed', 'elected', 'not_elected') OR (o.status = 'withdrawn' AND o.filed_out))
  )
  SELECT x.reg_id, x.election_id, x.election_type, x.county, x.town, x.sub_region, x.village, x.district,
         x.name, x.party, x.source_url, x.row_no, x.pe_id, x.politician_id, x.our_status,
         x.category, x.reason, x.person_action, x.system_applied,
         NULL::BIGINT AS announce_id, NULL::TEXT AS announce_state
    FROM (SELECT * FROM rows_reg UNION ALL SELECT * FROM rows_ours) x
$$;
-- ▲▲ SECTION: rows ▲▲

-- ▼▼ SECTION: gap ▼▼
CREATE OR REPLACE FUNCTION roster_registration_gap(
  p_election_id INTEGER, p_election_type TEXT, p_county TEXT, p_town TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 120
) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  WITH mir AS MATERIALIZED (
    -- >>> 官方名冊鏡像（20261031160000）：用不用鏡像由共用函式 cec_roster_unit_mirrored 決定（派工判準與系統自動建人物的 roster_reconcile_rows 用同一個定義）
    SELECT cec_roster_unit_mirrored(p_election_id, p_election_type, p_county, p_town) AS on_
    -- <<< 官方名冊鏡像
  ),
  reg AS (
    SELECT r.row_no, r.source_url, r.name, r.name_key, r.party, r.region, r.place, r.sub_region, r.village, r.district,
           COALESCE(replace(r.sub_region, '臺', '台'), '') AS rk, false AS glyph
      FROM cec_registrations r
      JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL
     WHERE r.election_id = p_election_id AND r.election_type = p_election_type
       AND r.region = replace(p_county, '臺', '台')
       AND (p_town IS NULL OR replace(r.sub_region, '臺', '台') = replace(p_town, '臺', '台'))
       AND NOT (SELECT on_ FROM mir)
    UNION ALL
    -- >>> 官方名冊鏡像：行序用鏡像列 id，source_url 是該單位的 JSON 網址；造字代碼的姓名標 glyph，比對時當 1～2 字萬用字元
    SELECT x.id::INTEGER, x.unit_url, x.name, x.name_key, COALESCE(x.party, '無'), replace(x.county, '臺', '台'), NULL::TEXT, NULLIF(replace(x.town, '臺', '台'), ''), NULL::TEXT, NULLIF(x.district, ''),
           COALESCE(replace(x.town, '臺', '台'), ''), x.name ~ '@[0-9A-Fa-f]{3,6}@'
      FROM cec_roster_2026 x
     WHERE (SELECT on_ FROM mir) AND x.election_type = p_election_type AND replace(x.county, '臺', '台') = replace(p_county, '臺', '台')
       AND (p_town IS NULL OR replace(x.town, '臺', '台') = replace(p_town, '臺', '台'))
    -- <<< 官方名冊鏡像
  ),
  ours AS MATERIALIZED (
    SELECT CASE WHEN (SELECT on_ FROM mir) THEN roster_name_key(p.name) ELSE COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), '')) END AS nn,   -- 鏡像：與名冊同一個鍵（異體字、羅馬拼音）
           -- 議員的 regions.sub_region 是「第07選舉區」，不是鄉鎮：去掉選舉區就是空的，下面當成「不比鄉鎮」
           NULLIF(replace(regexp_replace(COALESCE(rg.sub_region, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), '') AS town,
           p.id AS politician_id, pe.id AS pe_id, pe.candidacy_status AS status,
           candidacy_is_listed(pe.candidacy_status) AS listed
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.election_id = p_election_id AND pe.election_type = p_election_type
       AND replace(COALESCE(rg.region, p.region), '臺', '台') = replace(p_county, '臺', '台')
  ),
  -- 用連接而不是放在 select 清單裡的 EXISTS：後者是逐列的關聯子查詢，名冊 1,600 列 × 我們 1,200 筆要算兩百萬次姓名鍵（PGlite 實測 5 秒）
  hit AS (
    SELECT reg.source_url, reg.row_no, o.politician_id, o.pe_id, o.status, o.listed
      FROM reg JOIN ours o ON (o.nn = reg.name_key OR (reg.glyph AND cec_name_fuzzy_eq(o.nn, reg.name_key, NULL, NULL)))
                           AND (o.town IS NULL OR reg.sub_region IS NULL OR o.town = replace(reg.sub_region, '臺', '台'))
  ),
  -- 一對一，而且配額只算「這個比對範圍內真的命中的」我們的紀錄（2026-10-08 第二輪審查）：
  -- 名冊上同姓名鍵、同鄉鎮（rk；沒有鄉鎮的選舉別是同一組）的登記者有 k 位，這一組命中的、算進名冊內人數的我們的紀錄有 m 筆（以 pe_id 去重），
  -- 前 m 位算 matched，其餘 k−m 位不是 matched；接著不是 matched、又命中不算進名冊內人數的紀錄（considering、withdrawn）共 q 筆的，前 q 位
  -- 各自對上不同的一筆（needs_status，不會兩位指到同一個 pe_id），其餘落進 missing。
  -- 為什麼不能拿「全縣同名者有幾位」當配額：問板橋區時 reg 只剩板橋區，ours 卻是全縣——三重區也有一位同名的，配額變 2，
  -- 板橋區名冊上同名的兩位都被算成已有，真正缺的那位不出現在 missing（任務無聲消失）。
  -- 派工判準比的是人數（cec_count＝名冊人數 > 我們的名冊內人數），同名兩位只有一筆紀錄時兩位都算已有，會是任務顯示缺 0、派工端永遠差 1。
  listed_hit AS (
    SELECT DISTINCT h.source_url, h.row_no FROM hit h WHERE h.listed
  ),
  quota_listed AS (
    SELECT reg.name_key, reg.rk, count(DISTINCT h.pe_id) AS n
      FROM hit h JOIN reg ON reg.source_url = h.source_url AND reg.row_no = h.row_no
     WHERE h.listed GROUP BY reg.name_key, reg.rk
  ),
  ranked AS (
    SELECT lh.source_url, lh.row_no, reg.name_key, reg.rk,
           row_number() OVER (PARTITION BY reg.name_key, reg.rk ORDER BY lh.source_url, lh.row_no) AS rn
      FROM listed_hit lh JOIN reg ON reg.source_url = lh.source_url AND reg.row_no = lh.row_no
  ),
  matched_rows AS (
    SELECT r.source_url, r.row_no FROM ranked r JOIN quota_listed c ON c.name_key = r.name_key AND c.rk = r.rk WHERE r.rn <= c.n
  ),
  -- 還沒對上的名冊列裡，命中不算進名冊內人數的紀錄的，同組內依列序編號
  rest AS (
    SELECT reg.source_url, reg.row_no, reg.name_key, reg.rk,
           row_number() OVER (PARTITION BY reg.name_key, reg.rk ORDER BY reg.source_url, reg.row_no) AS rn2
      FROM reg
      LEFT JOIN matched_rows m ON m.source_url = reg.source_url AND m.row_no = reg.row_no
     WHERE m.row_no IS NULL
       AND EXISTS (SELECT 1 FROM hit h WHERE h.source_url = reg.source_url AND h.row_no = reg.row_no AND NOT h.listed)
  ),
  -- 這一組命中的、不算進名冊內人數的紀錄（以 pe_id 去重），依 pe_id 編號
  non_listed_pes AS (
    SELECT x.name_key, x.rk, x.pe_id, x.politician_id, x.status,
           row_number() OVER (PARTITION BY x.name_key, x.rk ORDER BY x.pe_id) AS p
      FROM (SELECT DISTINCT reg.name_key, reg.rk, h.pe_id, h.politician_id, h.status
              FROM hit h JOIN reg ON reg.source_url = h.source_url AND reg.row_no = h.row_no
             WHERE NOT h.listed) x
  ),
  assigned AS (
    SELECT rest.source_url, rest.row_no, n.pe_id, n.politician_id AS pid, n.status
      FROM rest JOIN non_listed_pes n ON n.name_key = rest.name_key AND n.rk = rest.rk AND n.p = rest.rn2
  ),
  marked AS (
    SELECT reg.*, (m.row_no IS NOT NULL) AS matched,
           (a.row_no IS NOT NULL) AS needs_status,
           a.pid, a.pe_id, a.status
      FROM reg
      LEFT JOIN matched_rows m ON m.source_url = reg.source_url AND m.row_no = reg.row_no
      LEFT JOIN assigned a ON a.source_url = reg.source_url AND a.row_no = reg.row_no
  ),
  gap AS (
    SELECT * FROM marked WHERE NOT matched AND NOT needs_status AND name_key IS NOT NULL
  ),
  shown AS (
    SELECT * FROM gap ORDER BY source_url, row_no LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 120), 500))
  ),
  needs AS (
    SELECT * FROM marked WHERE needs_status ORDER BY source_url, row_no LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 120), 500))
  )
  SELECT CASE WHEN (SELECT count(*) FROM marked) = 0 THEN NULL ELSE jsonb_build_object(
    'registered', (SELECT count(*) FROM marked),
    'matched', (SELECT count(*) FROM marked WHERE matched),
    'needs_status_count', (SELECT count(*) FROM marked WHERE needs_status),
    'missing_count', (SELECT count(*) FROM gap),
    'unnamed_count', (SELECT count(*) FROM marked WHERE name_key IS NULL),
    'source_urls', (SELECT COALESCE(jsonb_agg(DISTINCT source_url), '[]'::jsonb) FROM marked),
    'truncated', (SELECT count(*) FROM gap) > (SELECT count(*) FROM shown),
    'missing', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'name', name, 'party', party, 'region', region, 'sub_region', sub_region, 'village', village,
                  'district', district, 'row_no', row_no) ORDER BY source_url, row_no) FROM shown), '[]'::jsonb),
    'needs_status', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'name', name, 'party', party, 'region', region, 'sub_region', sub_region, 'village', village,
                  'district', district, 'row_no', row_no, 'politician_id', pid, 'politician_election_id', pe_id,
                  'candidacy_status', status) ORDER BY source_url, row_no) FROM needs), '[]'::jsonb),
    'needs_status_truncated', (SELECT count(*) FROM marked WHERE needs_status) > (SELECT count(*) FROM needs)
  ) END
$$;
COMMENT ON FUNCTION roster_registration_gap IS
  '單位名冊上的人對照我們（matched／needs_status／missing）。2026 屆、該單位有新鮮的官方名冊鏡像（cec_roster_2026，中選會選舉專區 JSON）時以鏡像為來源（造字代碼姓名也比得上，source_urls 是 JSON 網址），否則照舊用登記彙總表（cec_registrations）。20261031160000';
-- ▲▲ SECTION: gap ▲▲

-- ▼▼ SECTION: cron ▼▼
-- 排程（UTC）：每天 18～21 時每 5 分鐘一輪鏡像（台灣時間凌晨 2～6 點；每輪約 100 秒預算，約 5 輪抓完 500 檔；抓完當天空轉）；22:25 備援對帳
-- 呼叫憑證沿用 roster-reconcile 的 Vault 密鑰（函式端用 roster_reconcile_cron_secret_ok 驗）
DO $do$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL AND to_regnamespace('net') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname IN ('cec-roster-mirror-5min', 'cec-roster-reconcile-daily');
    PERFORM cron.schedule('cec-roster-mirror-5min', '*/5 18-21 * * *', $q$
      SELECT net.http_post(
        url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/cec-roster-mirror',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', COALESCE((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'roster_reconcile_cron_secret' LIMIT 1), '')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 150000
      );
    $q$);
    PERFORM cron.schedule('cec-roster-reconcile-daily', '25 22 * * *', 'SELECT cec_roster_reconcile_if_due();');
  END IF;
END
$do$;
-- ▲▲ SECTION: cron ▲▲

-- 單位清單先種好（約 500 個），第一輪排程就能抓
SELECT cec_roster_seed_units();
