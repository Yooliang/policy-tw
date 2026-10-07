-- 中選會 115 年登記彙總表九份的資料表（2026-10-08，10-08 缺口盤點 R1）
--
-- 背景：2026 登記共 19,695 人，我們只收約 1,640 人（村里長 14,100 人只收 262）。名冊 PDF 是中選會頁面
-- （https://web.cec.gov.tw/central/article/64709）掛的九份，內容固定（115/09/07 製表）。
-- 以前系統只在 roster_batch 讀 PDF 逐位核對（每 10 分鐘、在 Edge 上抽字）：村里長那份 7.5 MB 超過 Edge 的 3 MB 抽字上限，
-- 整份沒有系統票；其餘每輪都重新下載、重新抽字。這裡把九份解析成資料表，一次解析、查表使用：
--   1. cec_registrations：一列一位登記者（縣市、鄉鎮市區、村里、選舉區、姓名、政黨、PDF 列序、來源網址）。
--   2. cec_registration_sources：每份名冊的網址、選舉別、列數（預期筆數）、被誰取代。
--   3. roster_registration_gap()：某一個單位（縣市，或縣市＋鄉鎮市區）名冊上的人對照我們：已有／要改狀態／缺，給名單清查任務附上。
-- 資料段在下一支 migration（20261008130100，由 scripts/gen-cec-registrations.ts 產生；同一個 parser、同一個抽字法）。
--
-- 不碰任何人物或參選紀錄：這張表是「中選會名冊的鏡像」，不是我們的資料；要成為參選紀錄仍要代理交 candidacy、同儕驗證
-- （09-19「系統票不能單獨通過」、10-01「名冊逐位吻合目標分數 1」都不變）。

CREATE TABLE IF NOT EXISTS cec_registrations (
  id            BIGSERIAL PRIMARY KEY,
  election_id   INTEGER NOT NULL,
  election_type TEXT NOT NULL,           -- 跟 politician_elections.election_type 同一套（縣市長、縣市議員、…、村里長）
  region        TEXT NOT NULL,           -- 縣市（台北市，不用「臺」）
  place         TEXT,                    -- 縣市以後的地名原樣（鄉鎮市區，村里長是「鄉鎮市區＋村里」連在一起）；縣市長、議員沒有
  sub_region    TEXT,                    -- 鄉鎮市區（內政部官方寫法，「臺西鄉」「臺東市」）
  village       TEXT,                    -- 村里（村里長才有；名冊抽字的原樣，臺→台）
  district      TEXT,                    -- 選舉區（第NN選舉區；議員、代表才有）
  name          TEXT NOT NULL,           -- 名冊上的姓名原字；PDF 的姓名欄是空的（罕用字抽不出來）就是空字串，flags 有 name_empty
  name_key      TEXT GENERATED ALWAYS AS (COALESCE(cec_name_key(name), NULLIF(cec_name_norm(name), ''))) STORED,  -- 比對用的姓名鍵：cec_name_key（跟 cec_candidates.name_norm 同一套）；整個姓名都是拉丁字母的（「Laling Yumin」）去尾端拼音會變空，退回 cec_name_norm
  party         TEXT NOT NULL,           -- 推薦之政黨原字（「無」＝未經政黨推薦）
  row_no        INTEGER NOT NULL,        -- 在那份 PDF 裡的列序（從 1 起）
  source_url    TEXT NOT NULL,           -- 名冊 PDF 網址（web.cec.gov.tw/api/file/….pdf）
  flags         TEXT[] NOT NULL DEFAULT '{}',  -- 異常列的標記：name_empty、party_empty、village_empty、place_unmatched；照收不丟
  parsed_at     TIMESTAMPTZ NOT NULL,    -- 解析這份 PDF 的時間
  CONSTRAINT cec_registrations_source_row UNIQUE (source_url, row_no)
);
CREATE INDEX IF NOT EXISTS cec_registrations_scope_idx ON cec_registrations (election_id, election_type, region);
CREATE INDEX IF NOT EXISTS cec_registrations_name_idx ON cec_registrations (election_id, name_key);
COMMENT ON TABLE cec_registrations IS '中選會候選人登記彙總表（一列一位登記者）：roster_batch 先查這張表、不下載 PDF；名單清查任務附上缺的名單（2026-10-08）';

CREATE TABLE IF NOT EXISTS cec_registration_sources (
  source_url    TEXT PRIMARY KEY,
  election_id   INTEGER NOT NULL,
  election_type TEXT NOT NULL,
  label         TEXT NOT NULL,
  row_count     INTEGER NOT NULL,        -- 這份名冊解析出的列數（＝PDF 的登記日期列數）；表裡的列數對不上就當沒有這份（roster_batch 退回 PDF）
  superseded_by TEXT REFERENCES cec_registration_sources(source_url),  -- 有值＝舊版：留著讓引用舊網址的交件也查得到表，算缺口看新版
  parsed_at     TIMESTAMPTZ NOT NULL
);
COMMENT ON TABLE cec_registration_sources IS 'cec_registrations 的名冊清單：網址、選舉別、預期列數、被哪個網址的新版取代';

ALTER TABLE cec_registrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cec_registrations_read ON cec_registrations;
CREATE POLICY cec_registrations_read ON cec_registrations FOR SELECT USING (true);
ALTER TABLE cec_registration_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cec_registration_sources_read ON cec_registration_sources;
CREATE POLICY cec_registration_sources_read ON cec_registration_sources FOR SELECT USING (true);

-- 健康檢查（正常是空的）：登記的列數跟表裡實際的列數對不上的名冊
CREATE OR REPLACE VIEW cec_registration_drift AS
SELECT s.source_url, s.label, s.row_count AS expected, count(r.id) AS actual
  FROM cec_registration_sources s
  LEFT JOIN cec_registrations r ON r.source_url = s.source_url
 GROUP BY s.source_url, s.label, s.row_count
HAVING count(r.id) <> s.row_count;
COMMENT ON VIEW cec_registration_drift IS '名冊登記的列數跟 cec_registrations 實際列數對不上的（正常是空的；對不上的名冊 roster_batch 會退回讀 PDF）';

-- 各類人數（現行版）：選舉別 × 名冊份數、人數、異常列數
CREATE OR REPLACE VIEW cec_registration_totals AS
SELECT r.election_id, r.election_type,
       count(DISTINCT r.source_url) AS sources,
       count(*) AS registered,
       count(*) FILTER (WHERE cardinality(r.flags) > 0) AS flagged
  FROM cec_registrations r
  JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL
 GROUP BY r.election_id, r.election_type;
COMMENT ON VIEW cec_registration_totals IS '名冊現行版的各類人數（舊版不算）；2026 合計 19,695';

-- 「算進名冊內人數」的狀態判準，**單一真相**：#447 派工判準的 n_listed（20261008112000 那一版名單清查派工臂裡的 ours）
-- 是「排除 considering（可能參選）與 withdrawn（退選），其餘都算——已登記、已表態，選後的當選／落選也算」；
-- 這支函式照字面抄同一個條件，roster-check-gap／cec-registrations 兩邊的測試把兩處文字對齊。
-- 不一致的後果：名冊 10 人、我們 10 筆但 1 筆是 considering，任務顯示「缺 0」、代理回報 cec_count＝10，
-- 派工端只算 9（10 > 9）而每 10 分鐘再派一次，代理永遠看不到要改什麼。
CREATE OR REPLACE FUNCTION candidacy_is_listed(p_status TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_status, '') NOT IN ('considering', 'withdrawn')
$$;
COMMENT ON FUNCTION candidacy_is_listed IS '這個參選狀態算不算進「名冊內人數」：排除 considering、withdrawn，其餘（含空值、選後的 elected／not_elected）都算；跟派工判準 n_listed 同一個條件（2026-10-08）';

-- 某一個單位（縣市；或縣市＋鄉鎮市區）名冊上的人，跟我們的對照，分三種：
--   matched      ：我們有同名、而且狀態算進名冊內人數（candidacy_is_listed）的參選紀錄
--   needs_status ：我們有同名的參選紀錄，但狀態是 considering 或 withdrawn（不算進名冊內人數）——要用 correction 改狀態，不是 candidacy 新增；
--                  附 politician_id、politician_election_id 與目前狀態，代理才改得了
--   missing      ：我們一筆同名紀錄都沒有——要 candidacy 補
-- 三種加上姓名欄是空的（unnamed）剛好等於 registered。給名單清查任務（roster_check）附上，代理照著做完、回報
-- cec_count＝registered，派工判準（cec_count > 我們的名冊內人數）就會成立不了而不再派。
--
-- 「同名」：同一屆、同一種選舉、同一個縣市，姓名鍵（cec_name_key）相同；我們的紀錄有鄉鎮市區、名冊那一列也有的話，鄉鎮市區也要相同。
-- 村里不比：造字與寫法（臺／台、異體字）太雜，錯判成「沒有」只會讓代理多交一筆（落庫時同一人同一屆會併進既有紀錄），
-- 錯判成「有」卻會讓那個人永遠不在清單上。
-- 一對一：同縣市同姓名鍵的登記者 k 位、我們算進名冊內人數的同名紀錄 m 筆，前 m 位算 matched，其餘 k−m 位不是 matched；
-- 不是 matched、而且我們有同名但不算進名冊內人數的紀錄（considering、withdrawn）的是 needs_status（挑 politician_election_id 最小的那筆），其餘是 missing。
-- PDF 的姓名欄是空的那幾列（name_empty）不列：沒有名字可以抄；數量放在 unnamed_count。
-- 回傳 NULL＝這個單位在名冊裡一個人都沒有（這屆、這種選舉沒有名冊資料，或沒人登記）。
CREATE OR REPLACE FUNCTION roster_registration_gap(
  p_election_id INTEGER, p_election_type TEXT, p_county TEXT, p_town TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 120
) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  WITH reg AS (
    SELECT r.row_no, r.source_url, r.name, r.name_key, r.party, r.region, r.place, r.sub_region, r.village, r.district
      FROM cec_registrations r
      JOIN cec_registration_sources s ON s.source_url = r.source_url AND s.superseded_by IS NULL
     WHERE r.election_id = p_election_id AND r.election_type = p_election_type
       AND r.region = replace(p_county, '臺', '台')
       AND (p_town IS NULL OR replace(r.sub_region, '臺', '台') = replace(p_town, '臺', '台'))
  ),
  ours AS MATERIALIZED (
    SELECT COALESCE(cec_name_key(p.name), NULLIF(cec_name_norm(p.name), '')) AS nn,
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
      FROM reg JOIN ours o ON o.nn = reg.name_key
                           AND (o.town IS NULL OR reg.sub_region IS NULL OR o.town = replace(reg.sub_region, '臺', '台'))
  ),
  -- 一對一：名冊上同一個縣市、同姓名鍵的登記者有 k 位，我們算進名冊內人數的同名紀錄有 m 筆，就只有前 m 位算已有，其餘 k−m 位算缺
  -- （派工判準比的是人數：cec_count＝名冊人數 > 我們的名冊內人數；同名兩位只有一筆紀錄時，如果兩位都算已有，任務顯示缺 0、派工端卻永遠差 1）
  listed_hit AS (
    SELECT DISTINCT h.source_url, h.row_no FROM hit h WHERE h.listed
  ),
  ranked AS (
    SELECT lh.source_url, lh.row_no, reg.name_key,
           row_number() OVER (PARTITION BY reg.name_key ORDER BY lh.source_url, lh.row_no) AS rn
      FROM listed_hit lh JOIN reg ON reg.source_url = lh.source_url AND reg.row_no = lh.row_no
  ),
  ours_cnt AS (
    SELECT nn, count(*) AS n FROM ours WHERE listed GROUP BY nn
  ),
  matched_rows AS (
    SELECT r.source_url, r.row_no FROM ranked r JOIN ours_cnt c ON c.nn = r.name_key WHERE r.rn <= c.n
  ),
  non_listed AS (
    SELECT h.source_url, h.row_no,
           (array_agg(h.politician_id ORDER BY h.pe_id))[1] AS pid,
           (array_agg(h.pe_id ORDER BY h.pe_id))[1] AS pe_id,
           (array_agg(h.status ORDER BY h.pe_id))[1] AS status
      FROM hit h WHERE NOT h.listed GROUP BY h.source_url, h.row_no
  ),
  marked AS (
    SELECT reg.*, (m.row_no IS NOT NULL) AS matched,
           (m.row_no IS NULL AND nl.row_no IS NOT NULL) AS needs_status,
           nl.pid, nl.pe_id, nl.status
      FROM reg
      LEFT JOIN matched_rows m ON m.source_url = reg.source_url AND m.row_no = reg.row_no
      LEFT JOIN non_listed nl ON nl.source_url = reg.source_url AND nl.row_no = reg.row_no
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
  '單位（縣市，或縣市＋鄉鎮市區）名冊上的人對照我們：registered＝matched（有同名且算進名冊內人數）＋needs_status_count（同名但 considering／withdrawn，要 correction 改狀態）＋missing_count（沒有同名紀錄，要 candidacy 補）＋unnamed_count；missing／needs_status 最多 p_limit 位；沒有名冊資料回 NULL（2026-10-08）';
