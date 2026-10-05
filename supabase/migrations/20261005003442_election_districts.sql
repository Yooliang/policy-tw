-- 選舉區與應選名額（#344 第一階段：只加不刪）
-- ============================================================
--
-- 為什麼：選區名稱散在 8,249 列地區資料（regions）與中選會名單裡，沒有一張表說「這場選舉有哪些選舉區、
-- 每區選幾席」。沒有分母就無法判斷候選人、當選人收齊了沒。日本站（政策の系譜）的 election_districts
-- 一列一個選舉區加定數；這裡照做，寫法跟 cec_candidates 同一套（region／sub_region／village），
-- 之後拿中選會名單或參選紀錄對選舉區不用再轉換。
--
-- 做了什麼（全部只加）：
--   1. 新表 election_districts：一列＝一場選舉、一種職位、一個選舉區，帶應選名額與名額依據。
--   2. 回填「能確定」的部分（839 列）：
--        - 名額由法律定死、選舉區就是行政區的（一席）：2022／2026 縣市長 22、鄉鎮市長 198、
--          直轄市山地原住民區長 6（來源：內政部行政區清單 admin_divisions）；2024 總統副總統 1
--        - 2024 立法委員：區域 73 區各一席（憲法增修條文第 4 條「按應選名額劃分同額選舉區」，
--          各縣市區數寫在下面）、平地原住民 3、山地原住民 3、不分區 34
--        - 2022 縣市議員 160 區、2026 縣市議員 150 區（來源：electoral_district_areas），名額留空
--   3. 視圖 election_seat_totals：每場選舉每種職位有幾區、幾區知道名額、已知名額合計——看得出哪裡缺分母。
--
-- 刻意沒回填的（之後走流程補，不用維運者判斷寫資料）：
--   - 議員各區名額（中選會選舉公告才有，資料庫裡沒有）、議員原住民選舉區（各縣市、各屆不同，
--     COUNCIL_ABORIGINAL_DISTRICTS 只核過一部分）、2026 新竹縣議員選區（對照表還沒有）
--   - 鄉鎮市民代表、原住民區民代表：選區名只在 cec_candidates（cec-sync 會先刪後寫，migration 讀它
--     可能撞上同步中途），名額也不知道
--   - 村里長：2022 的村里只在 cec_candidates；2026 的村里以選舉公告為準，現行行政區清單不一定就是
--     這次選的那一份（村里調整常在新任期開始那天生效）
--   - 2022 嘉義市長：照舊算在 2022 這一場（實際 12-18 重行選舉），第二階段若拆成 2022-12-18_rerun_10020
--     再搬
--
-- 錯了的代價：名額寫錯，之後「收齊了沒」會判錯——所以只寫法律定死的一席，其餘留空；
-- 選舉區漏列不會報錯，只會讓分母看起來比較小，election_seat_totals 的「幾區」對照下面的數字就看得出來。

-- 引用到的既有欄位（10-05 唯讀查詢確認存在）：
--   elections(id)、admin_divisions(code, level, county, town)、electoral_district_areas(election_id, region, electoral_district)

CREATE TABLE IF NOT EXISTS election_districts (
  id             BIGSERIAL PRIMARY KEY,
  election_id    INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  election_type  TEXT NOT NULL CHECK (election_type IN (
                   '總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長',
                   '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')),
  -- at_large：以整個行政區為一區（總統、縣市長、鄉鎮市長、原住民區長、村里長）；district：一般選舉區；
  -- proportional：不分區（政黨名單）；indigenous_plain／indigenous_mountain：平地／山地原住民選舉區
  district_kind  TEXT NOT NULL CHECK (district_kind IN ('at_large', 'district', 'proportional', 'indigenous_plain', 'indigenous_mountain')),
  region         TEXT NOT NULL,   -- 縣市（「台」）；全國一區的寫「全國」
  sub_region     TEXT,            -- 跟 cec_candidates.sub_region 同寫法：議員「第01選舉區」、立委「台中市第01選區」、
                                  -- 代表「麥寮鄉第04選舉區」、鄉鎮市長與原住民區長是鄉鎮市區名、立委全國一區是「不分區」等
  village        TEXT,            -- 村里長才有
  admin_code     TEXT REFERENCES admin_divisions(code),  -- 以行政區為一區時的內政部代碼
  seats          INTEGER CHECK (seats IS NULL OR seats > 0),  -- 應選名額；空白＝還沒查證
  seats_basis    TEXT CHECK (seats_basis IN ('law', 'cec_notice')),  -- 名額依據：法律定死／中選會選舉公告
  seats_source   TEXT,            -- 依據出處（法條，或公告網址）
  is_uncontested BOOLEAN,         -- 同額競選（候選人數不超過應選名額；台灣仍要投票、得票要過門檻）；空白＝還不知道
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT election_districts_unique UNIQUE NULLS NOT DISTINCT (election_id, election_type, region, sub_region, village),
  -- 首長類（每個行政區一人）一定是 at_large，其餘一定不是
  CONSTRAINT election_districts_kind_matches_type CHECK (
    (election_type IN ('總統副總統', '縣市長', '鄉鎮市長', '直轄市山地原住民區長', '村里長')) = (district_kind = 'at_large')),
  CONSTRAINT election_districts_proportional_only_legislator CHECK (district_kind <> 'proportional' OR election_type = '立法委員'),
  CONSTRAINT election_districts_at_large_one_seat CHECK (district_kind <> 'at_large' OR seats IS NULL OR seats = 1),
  -- 有名額就要有依據；沒名額就不能有依據
  CONSTRAINT election_districts_seats_basis CHECK ((seats IS NULL) = (seats_basis IS NULL)),
  CONSTRAINT election_districts_village_only_chief CHECK (village IS NULL OR election_type = '村里長')
);
CREATE INDEX IF NOT EXISTS election_districts_election_type_idx ON election_districts (election_id, election_type);

COMMENT ON TABLE election_districts IS
  '選舉區與應選名額：一列＝一場選舉、一種職位、一個選舉區（#344）。寫法跟 cec_candidates 同一套（region／sub_region／village）。名額空白＝還沒查證，不要用候選人數或當選人數推';
COMMENT ON COLUMN election_districts.seats IS '應選名額；空白＝還沒查證。不要用候選人數、當選人數推（資料沒收齊時會推錯）';
COMMENT ON COLUMN election_districts.seats_basis IS 'law＝法律定死（首長一人、立委席次）；cec_notice＝中選會選舉公告';
COMMENT ON COLUMN election_districts.is_uncontested IS '同額競選：候選人數不超過應選名額（依中選會候選人名單公告）。台灣沒有無投票當選，同額仍要投票、得票過門檻才當選';

ALTER TABLE election_districts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON election_districts;
CREATE POLICY "Public read" ON election_districts FOR SELECT USING (true);

-- ── 回填 ──────────────────────────────────────────────────────
-- 只回填職位清單裡真的有這種職位的選舉（elections.election_types 由上一支 migration 從 election_types 表回填）

-- 縣市長：每個縣市一席（2022 的嘉義市實際在 12-18 重行選舉，見檔頭）
INSERT INTO election_districts (election_id, election_type, district_kind, region, admin_code, seats, seats_basis, seats_source)
SELECT e.id, '縣市長', 'at_large', replace(a.county, '臺', '台'), a.code, 1, 'law', '地方制度法：直轄市、縣（市）置市長／縣長一人'
FROM elections e
JOIN admin_divisions a ON a.level = 'county'
WHERE '縣市長' = ANY (e.election_types)
ON CONFLICT DO NOTHING;

-- 鄉鎮市長：縣轄的鄉、鎮、縣轄市各一席（直轄市的區沒有區長選舉；新竹市、嘉義市的區也沒有）。
-- 名稱「臺」寫成「台」，跟 cec_candidates 的鄉鎮市長同寫法（臺西鄉、霧臺鄉、臺東市）。
INSERT INTO election_districts (election_id, election_type, district_kind, region, sub_region, admin_code, seats, seats_basis, seats_source)
SELECT e.id, '鄉鎮市長', 'at_large', replace(a.county, '臺', '台'), replace(a.town, '臺', '台'), a.code, 1, 'law', '地方制度法：鄉（鎮、市）置鄉（鎮、市）長一人'
FROM elections e
JOIN admin_divisions a ON a.level = 'town'
  AND right(a.town, 1) IN ('鄉', '鎮', '市')
  AND left(a.code, 5) NOT IN ('63000', '64000', '65000', '66000', '67000', '68000')
WHERE '鄉鎮市長' = ANY (e.election_types)
ON CONFLICT DO NOTHING;

-- 直轄市山地原住民區長：六個山地原住民區各一席（新北烏來、桃園復興、台中和平、高雄那瑪夏／桃源／茂林）
INSERT INTO election_districts (election_id, election_type, district_kind, region, sub_region, admin_code, seats, seats_basis, seats_source)
SELECT e.id, '直轄市山地原住民區長', 'at_large', replace(a.county, '臺', '台'), a.town, a.code, 1, 'law', '地方制度法：直轄市山地原住民區置區長一人'
FROM elections e
JOIN admin_divisions a ON a.level = 'town'
  AND a.code IN ('65000290', '68000130', '66000290', '64000380', '64000370', '64000360')
WHERE '直轄市山地原住民區長' = ANY (e.election_types)
ON CONFLICT DO NOTHING;

-- 總統副總統：全國一組
INSERT INTO election_districts (election_id, election_type, district_kind, region, seats, seats_basis, seats_source)
SELECT e.id, '總統副總統', 'at_large', '全國', 1, 'law', '中華民國憲法增修條文第 2 條：總統、副總統候選人聯名登記，以得票最多之一組為當選'
FROM elections e
WHERE '總統副總統' = ANY (e.election_types)
ON CONFLICT DO NOTHING;

-- 立法委員（第 11 屆，2024）：區域 73 區各一席，各縣市區數如下；原住民與不分區全國一區。
-- 席次與選舉區數由憲法增修條文第 4 條定死（區域 73、平地原住民 3、山地原住民 3、不分區 34），
-- 各縣市區數是中選會 2024 名單上的實際區數（cec_candidates 2024 區域立委 73 區，10-05 唯讀查詢）。
-- 只寫 2024：每一屆的選區劃分可能重劃，下一屆要照那一屆的公告另外寫。
INSERT INTO election_districts (election_id, election_type, district_kind, region, sub_region, seats, seats_basis, seats_source)
SELECT 2024, '立法委員', 'district', c.region, c.region || '第' || lpad(n::TEXT, 2, '0') || '選區', 1, 'law',
       '中華民國憲法增修條文第 4 條：區域立委依人口比例分配，按應選名額劃分同額選舉區（每區一席）'
FROM (VALUES
  ('台北市', 8), ('新北市', 12), ('桃園市', 6), ('台中市', 8), ('台南市', 6), ('高雄市', 8),
  ('基隆市', 1), ('新竹市', 1), ('新竹縣', 2), ('苗栗縣', 2), ('彰化縣', 4), ('南投縣', 2),
  ('雲林縣', 2), ('嘉義市', 1), ('嘉義縣', 2), ('屏東縣', 2), ('宜蘭縣', 1), ('花蓮縣', 1),
  ('台東縣', 1), ('澎湖縣', 1), ('金門縣', 1), ('連江縣', 1)
) AS c(region, districts)
CROSS JOIN LATERAL generate_series(1, c.districts) AS n
WHERE EXISTS (SELECT 1 FROM elections e WHERE e.id = 2024 AND '立法委員' = ANY (e.election_types))
ON CONFLICT DO NOTHING;

INSERT INTO election_districts (election_id, election_type, district_kind, region, sub_region, seats, seats_basis, seats_source)
SELECT 2024, '立法委員', x.kind, '全國', x.sub_region, x.seats, 'law', x.source
FROM (VALUES
  ('indigenous_plain', '平地原住民', 3, '中華民國憲法增修條文第 4 條：自由地區平地原住民 3 人'),
  ('indigenous_mountain', '山地原住民', 3, '中華民國憲法增修條文第 4 條：自由地區山地原住民 3 人'),
  ('proportional', '不分區', 34, '中華民國憲法增修條文第 4 條：全國不分區及僑居國外國民共 34 人')
) AS x(kind, sub_region, seats, source)
WHERE EXISTS (SELECT 1 FROM elections e WHERE e.id = 2024 AND '立法委員' = ANY (e.election_types))
ON CONFLICT DO NOTHING;

-- 縣市議員：一般選舉區照選舉區對照表（electoral_district_areas）；名額留空（中選會選舉公告才有）。
-- 原住民選舉區不對應鄉鎮、這張對照表不收，之後跟名額一起走流程補。
INSERT INTO election_districts (election_id, election_type, district_kind, region, sub_region)
SELECT DISTINCT eda.election_id, '縣市議員', 'district', eda.region, eda.electoral_district
FROM electoral_district_areas eda
JOIN elections e ON e.id = eda.election_id AND '縣市議員' = ANY (e.election_types)
WHERE eda.electoral_district ~ '^第[0-9]{2}選舉區$'
ON CONFLICT DO NOTHING;

-- 回填結果核一次：每一類的列數跟上面寫的一樣，不一樣就整支退回（不要默默少一截分母）
DO $$
DECLARE
  v_got TEXT;
  v_expected CONSTANT TEXT :=
    '2022|縣市長|22|22,2022|縣市議員|160|0,2022|鄉鎮市長|198|198,2022|直轄市山地原住民區長|6|6,'
    '2024|總統副總統|1|1,2024|立法委員|76|113,'
    '2026|縣市長|22|22,2026|縣市議員|150|0,2026|鄉鎮市長|198|198,2026|直轄市山地原住民區長|6|6';
BEGIN
  -- 排序用職位分層的順序，不用文字排序（正式庫與本機的定序可能不同）
  SELECT string_agg(election_id || '|' || election_type || '|' || n || '|' || seats, ','
                    ORDER BY election_id, array_position(ARRAY['總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']::TEXT[], election_type))
  INTO v_got
  FROM (SELECT election_id, election_type, COUNT(*) AS n, COALESCE(SUM(seats), 0) AS seats
        FROM election_districts GROUP BY election_id, election_type) s;
  IF v_got IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION '#344 election_districts 回填結果跟預期不同：%', v_got;
  END IF;
END $$;

-- ── 分母看板 ──────────────────────────────────────────────────
-- 每場選舉、每種職位：幾個選舉區、幾區知道名額、已知名額合計。「幾區」本身漏列不會報錯，
-- 要對照法定或公告的區數看（2026 議員 150 區是因為新竹縣與原住民選舉區還沒有）。
CREATE OR REPLACE VIEW election_seat_totals AS
SELECT d.election_id,
       d.election_type,
       COUNT(*) AS districts,
       COUNT(d.seats) AS districts_with_seats,
       COALESCE(SUM(d.seats), 0) AS seats_known,
       COUNT(*) FILTER (WHERE d.seats IS NULL) AS districts_missing_seats
FROM election_districts d
GROUP BY d.election_id, d.election_type;
ALTER VIEW election_seat_totals SET (security_invoker = on);
COMMENT ON VIEW election_seat_totals IS
  '分母看板（#344）：每場選舉每種職位的選舉區數、知道名額的區數、已知名額合計；districts_missing_seats > 0 就是還缺分母';
GRANT SELECT ON election_seat_totals TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
