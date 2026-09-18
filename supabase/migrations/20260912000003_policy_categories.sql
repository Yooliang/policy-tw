-- ============================================================
-- 政見分類標準化並擴充為 19 類（2026-09-11 拍板）
--   1. categories 表加 description；改名 2 個（保留 id）、新增 11 個（往後編號）
--   2. policies.category 既有髒值依對照表統一（併入原 scripts/normalize-policy-categories.sql）
--   3. policies.category 加 FK → categories(name) ON UPDATE CASCADE
-- 對照（TS 版在 supabase/functions/_shared/category-map.ts，改要一起改）：
--   交通→交通建設｜社會→社會福利｜社福→社會福利｜經濟→經濟發展與產業｜經濟發展→經濟發展與產業｜經濟補助→經濟發展與產業
--   環境→環境保護｜教育→教育文化｜行政革新→行政革新與數位治理｜能源→能源｜其他→其他
-- 2026-09-11 以 anon 只讀掃 prod（293 筆／17 種寫法）預期更新後分布：
--   交通建設 44｜社會福利 86｜經濟發展與產業 77｜教育文化 12｜環境保護 22｜行政革新與數位治理 12｜政治議題 12｜公平正義 1｜能源 1｜其他 26
-- ============================================================

-- ------------------------------------------------------------
-- 1. categories：description、改名、新增
-- ------------------------------------------------------------
ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT;

-- 改名（保留 id；policies 尚未加 FK，先改名再對照更新 policies）
UPDATE categories SET name = '經濟發展與產業' WHERE name = '經濟發展';
UPDATE categories SET name = '行政革新與數位治理' WHERE name = '行政革新';

INSERT INTO categories (name) VALUES
  ('都市發展與住宅'), ('醫療衛生'), ('農漁業'), ('能源'), ('治安消防與防災'),
  ('青年與勞工'), ('性別與人權'), ('原住民與族群'), ('體育休閒'), ('財政與稅務'), ('其他')
ON CONFLICT (name) DO NOTHING;

UPDATE categories SET description = v.description
FROM (VALUES
  ('交通建設',            '道路、橋梁、大眾運輸、捷運輕軌、鐵路、停車、交通安全與運輸政策'),
  ('都市發展與住宅',      '都市計畫、都更、社會住宅、居住正義、房價與租屋、區域開發、公共空間'),
  ('社會福利',            '長照、托育、身心障礙、弱勢扶助、津貼補助、社福設施'),
  ('醫療衛生',            '醫療資源、公衛、防疫、健保、心理健康、食安'),
  ('教育文化',            '各級教育、幼教、技職、文化藝術、圖書館、語言與文資'),
  ('經濟發展與產業',      '產業政策、招商投資、中小企業、觀光、商圈、就業機會、地方經濟'),
  ('農漁業',              '農業、漁業、畜牧、農地、農產運銷、農漁民福利'),
  ('環境保護',            '空污、水污、廢棄物、生態保育、氣候調適、淨零'),
  ('能源',                '電力、再生能源、核能、節能、能源轉型'),
  ('治安消防與防災',      '警政治安、消防、災害防救、防洪治水、公共安全'),
  ('青年與勞工',          '青年政策、創業、勞動條件、薪資、職訓、工會'),
  ('性別與人權',          '性別平等、婚姻家庭、人權、多元族群平權（非原住民）'),
  ('原住民與族群',        '原住民族政策、族群文化、新住民、客家'),
  ('體育休閒',            '運動場館、體育推廣、休閒設施、公園綠地'),
  ('行政革新與數位治理',  '政府效能、開放資料、數位服務、廉政、組織改造'),
  ('財政與稅務',          '預算、財政紀律、稅制、規費、公共債務'),
  ('公平正義',            '司法改革、轉型正義、分配正義、弱勢權益保障'),
  ('政治議題',            '選制、地方自治、兩岸、國防外交、政黨政治'),
  ('其他',                '上列都不適合時才用')
) AS v(name, description)
WHERE categories.name = v.name;

DO $$
DECLARE n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM categories;
  IF n <> 19 THEN RAISE EXCEPTION 'categories 應為 19 筆，實際 %', n; END IF;
  RAISE NOTICE 'categories = % 筆', n;
END $$;

-- ------------------------------------------------------------
-- 2. policies.category 既有髒值統一
-- ------------------------------------------------------------
DO $$
DECLARE
  n_total INTEGER; n_dirty_before INTEGER; n_updated INTEGER; n_unmapped INTEGER; r RECORD;
BEGIN
  SELECT COUNT(*) INTO n_total FROM policies;
  SELECT COUNT(*) INTO n_dirty_before FROM policies WHERE category NOT IN (SELECT name FROM categories);
  RAISE NOTICE 'policies total = %, 不在 19 類內（更新前）= %', n_total, n_dirty_before;

  UPDATE policies SET category = CASE category
    WHEN '交通' THEN '交通建設'
    WHEN '社會' THEN '社會福利'
    WHEN '社福' THEN '社會福利'
    WHEN '經濟' THEN '經濟發展與產業'
    WHEN '經濟發展' THEN '經濟發展與產業'
    WHEN '經濟補助' THEN '經濟發展與產業'
    WHEN '環境' THEN '環境保護'
    WHEN '教育' THEN '教育文化'
    WHEN '行政革新' THEN '行政革新與數位治理'
    ELSE category END
  WHERE category IN ('交通', '社會', '社福', '經濟', '經濟發展', '經濟補助', '環境', '教育', '行政革新');
  GET DIAGNOSTICS n_updated = ROW_COUNT;
  RAISE NOTICE 'policies 已依對照表更新 % 筆', n_updated;

  SELECT COUNT(*) INTO n_unmapped FROM policies WHERE category NOT IN (SELECT name FROM categories);
  IF n_unmapped > 0 THEN
    FOR r IN SELECT category, COUNT(*) AS c FROM policies WHERE category NOT IN (SELECT name FROM categories) GROUP BY 1 LOOP
      RAISE NOTICE '  未對照：% (% 筆)', r.category, r.c;
    END LOOP;
    RAISE EXCEPTION 'policies.category 仍有 % 筆不在 19 類內，請補對照表後重跑', n_unmapped;
  END IF;

  FOR r IN SELECT category, COUNT(*) AS c FROM policies GROUP BY 1 ORDER BY 2 DESC LOOP
    RAISE NOTICE '  % = %', r.category, r.c;
  END LOOP;
  IF (SELECT COUNT(*) FROM policies) <> n_total THEN RAISE EXCEPTION 'policies 筆數變了'; END IF;
END $$;

-- ------------------------------------------------------------
-- 3. FK：只能是 categories.name；改名會跟著改
-- ------------------------------------------------------------
ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_category_fkey;
ALTER TABLE policies
  ADD CONSTRAINT policies_category_fkey FOREIGN KEY (category) REFERENCES categories(name) ON UPDATE CASCADE;

COMMENT ON COLUMN policies.category IS '政見分類，必須是 categories.name 的 19 類之一（skill.md 有涵蓋說明）';
