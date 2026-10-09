-- 地方基本統計（issue #508）：縣市與鄉鎮市區的人口、面積、總預算（歲出）、65 歲以上比例，照日本站 policy_jp.regional_stats
-- 同一個形狀（地區代碼 × 指標 × 年度 × 數值 × 單位 × 出處），一律走代理交件 → 同儕驗證 → 落庫，不排程直接寫表、不推估。
-- ============================================================
--
-- 背景（維護者 10-08）：日本站「地域データ」換成 e-Stat 真實統計，正見本來就需要同一組數字，兩站同形好做走樣守門。
-- 日本站做法見 20261009210000_policy_jp_apply.sql；這支是正見版，地區用 admin_divisions 的官方代碼（#348），
-- 只收縣市（level=county，5 碼）與鄉鎮市區（level=town，8 碼）——不收村里，跟日本站「都道府県・市区町村」對齊、跟 issue 範圍一致。
--
-- 指標先收四項（issue 指定）：
--   population          人口（內政部戶政司人口統計）           單位：人
--   area_km2             面積（內政部國土測繪中心）              單位：平方公里
--   budget_expenditure   總預算歲出（各縣市主計處總預算書）      單位：千元
--   aging_rate           65 歲以上人口比例                       單位：%
-- 一個地區一個指標一個年度一列；沒有列＝未調查（前端顯示「未調查」，不是 0 或空白，照「讓資料自己說話」）。
--
-- 出處：沿用既有 sources／source_refs（#347），不像日本站另起一套 sources 表（正見已經有）。
-- regional_stats 自己留一欄 source_url（主要出處），用跟政策脈絡（lineage_participants 等）同一個機制同步進
-- source_refs：trg_regional_stats_sync_source 呼叫既有的 lineage_rows_sync_source()/lineage_rows_drop_refs()
-- （那兩支函式只認 TG_TABLE_NAME 與 NEW.id/NEW.source_url，對任何表都通用，不用為這張表另寫一份）。
--
-- 落庫規則：已有一樣的數值＝冪等（成功，不重寫）；已有不一樣的數值＝不覆蓋、退件（沒有人工介入點，照「資料走流程」）。
-- 不做系統核對（無法像選舉結果那樣核對名單），一律走一般同儕驗證。

-- ------------------------------------------------------------
-- 1. 單位對照（SQL 與 TS 兩份，lib/regional-stats.ts 的 REGIONAL_STAT_UNIT 要跟這裡一致）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION regional_stat_unit(p_stat_key TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_stat_key
           WHEN 'population' THEN '人'
           WHEN 'area_km2' THEN '平方公里'
           WHEN 'budget_expenditure' THEN '千元'
           WHEN 'aging_rate' THEN '%'
         END
$$;
COMMENT ON FUNCTION regional_stat_unit IS '地方統計指標的單位（population=人／area_km2=平方公里／budget_expenditure=千元／aging_rate=%）。一個 stat_key 只有一種單位，交件要照填，落庫時對這張表比對（#508）';

-- 指標的中文說明（任務描述、前端標籤共用；lib/regional-stats.ts 的 REGIONAL_STAT_LABEL 要跟這裡一致）
CREATE OR REPLACE FUNCTION regional_stat_label(p_stat_key TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_stat_key
           WHEN 'population' THEN '人口'
           WHEN 'area_km2' THEN '面積'
           WHEN 'budget_expenditure' THEN '總預算歲出'
           WHEN 'aging_rate' THEN '65 歲以上人口比例'
         END
$$;

-- ------------------------------------------------------------
-- 2. 表：regional_stats
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regional_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_code      TEXT NOT NULL REFERENCES admin_divisions(code),
  stat_key        TEXT NOT NULL CHECK (stat_key IN ('population', 'area_km2', 'budget_expenditure', 'aging_rate')),
  year            INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  value           NUMERIC NOT NULL,
  unit            TEXT NOT NULL,
  as_of           DATE,
  source_url      TEXT NOT NULL,
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一個地區同一個指標同一個年度只有一列（跟日本站 regional_stats_unique 同一個做法）
  CONSTRAINT regional_stats_one_per_key_year UNIQUE (admin_code, stat_key, year),
  CONSTRAINT regional_stats_unit_matches CHECK (unit = regional_stat_unit(stat_key)),
  CONSTRAINT regional_stats_value_range CHECK (
    value >= 0
    AND (stat_key <> 'aging_rate' OR value <= 100)
    AND (stat_key <> 'area_km2' OR value > 0)
  )
);
CREATE INDEX IF NOT EXISTS regional_stats_key_year_idx ON regional_stats (stat_key, year);
COMMENT ON TABLE regional_stats IS
  '縣市與鄉鎮市區的地方基本統計（人口、面積、總預算歲出、65 歲以上比例，issue #508）。一律走代理交件（contribution_type=regional_stat）'
  '→ 同儕驗證 → 落庫，不排程直接寫表、不推估。admin_code 只收 admin_divisions 的縣市（5 碼）與鄉鎮市區（8 碼），不收村里。'
  'year＝統計年度（西元；歲出填會計年度）、as_of＝基準日（例：111 年人口普查 2022-10-01，選填）。沒有列＝未調查，前端顯示「未調查」。';
COMMENT ON COLUMN regional_stats.unit IS '單位固定：population＝人／area_km2＝平方公里／budget_expenditure＝千元／aging_rate＝%（65 歲以上人口占比）';
COMMENT ON COLUMN regional_stats.source_url IS '主要出處（內政部戶政司、國土測繪中心、縣市主計處總預算書等官方資料）；同步進 source_refs（trg_regional_stats_sync_source）';

-- admin_code 只能是縣市或鄉鎮市區（不收村里）：CHECK 不能查其他表，用觸發器擋
CREATE OR REPLACE FUNCTION regional_stats_admin_level_ok() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_level TEXT;
BEGIN
  SELECT level INTO v_level FROM admin_divisions WHERE code = NEW.admin_code;
  IF v_level IS NULL THEN
    RAISE EXCEPTION 'regional_stats.admin_code 在 admin_divisions 查不到：%', NEW.admin_code;
  END IF;
  IF v_level NOT IN ('county', 'town') THEN
    RAISE EXCEPTION 'regional_stats.admin_code 只收縣市或鄉鎮市區（level=county／town），% 是 %', NEW.admin_code, v_level;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_regional_stats_admin_level ON regional_stats;
CREATE TRIGGER trg_regional_stats_admin_level BEFORE INSERT OR UPDATE OF admin_code ON regional_stats
  FOR EACH ROW EXECUTE FUNCTION regional_stats_admin_level_ok();

DROP TRIGGER IF EXISTS trg_regional_stats_touch ON regional_stats;
CREATE TRIGGER trg_regional_stats_touch BEFORE UPDATE ON regional_stats FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();

ALTER TABLE regional_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON regional_stats;
CREATE POLICY "Public read" ON regional_stats FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON regional_stats;
CREATE POLICY "Service role write" ON regional_stats FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
-- 跟多數新表同一個慣例明寫 GRANT（例：politician_careers、parties、election_bulletins）：RLS policy 限制列，
-- 這裡的 GRANT 限制欄／動作——anon／authenticated 只能 SELECT，寫入只留 service_role（RLS 的 WITH CHECK 再擋一次）
REVOKE ALL ON regional_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT ON regional_stats TO anon, authenticated;
GRANT ALL ON regional_stats TO service_role;

-- ------------------------------------------------------------
-- 3. 貢獻型別：新增 regional_stat（CLAUDE.md「加新型別要清點四處」第一處——漏這個 CHECK 的話代理交件全被擋而測試全綠）
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'election_results', 'reassign_candidacy', 'regional_stat'));

-- ------------------------------------------------------------
-- 4. 出處同步：跟政策脈絡（lineage_participants 等）共用既有的通用觸發器（migration 20261006034900）
-- ------------------------------------------------------------
ALTER TABLE source_refs DROP CONSTRAINT IF EXISTS source_refs_target_table_check;
ALTER TABLE source_refs ADD CONSTRAINT source_refs_target_table_check
  CHECK (target_table IN ('policies', 'tracking_logs', 'policy_elements', 'lineage_participants', 'handovers', 'lineage_links',
                          'politician_careers', 'parties', 'politician_elections', 'regional_stats'));

DROP TRIGGER IF EXISTS trg_regional_stats_sync_source ON regional_stats;
CREATE TRIGGER trg_regional_stats_sync_source AFTER INSERT OR UPDATE OF source_url ON regional_stats
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_sync_source();
DROP TRIGGER IF EXISTS trg_regional_stats_drop_refs ON regional_stats;
CREATE TRIGGER trg_regional_stats_drop_refs AFTER DELETE ON regional_stats
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_drop_refs();

-- ------------------------------------------------------------
-- 5. 讀取：縣市頁／鄉鎮頁／`/regional-data` 共用這個視圖，不用自己 join admin_divisions。
--    region／sub_region 換成網站慣用的「台」寫法（跟 district_seats 等既有臂同一個 replace，admin_divisions.county／town 保留官方原字「臺」）。
--    只收 published 的列（目前全部都是，列著是跟其他公開視圖同一個慣例，之後若加草稿狀態時不用改前端）。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW regional_stats_public WITH (security_invoker = true) AS
  SELECT rs.id, rs.admin_code, ad.level,
         replace(ad.county, '臺', '台') AS region,
         CASE WHEN ad.level = 'town' THEN replace(ad.town, '臺', '台') END AS sub_region,
         rs.stat_key, rs.year, rs.value, rs.unit, rs.as_of, rs.source_url
    FROM regional_stats rs
    JOIN admin_divisions ad ON ad.code = rs.admin_code;
COMMENT ON VIEW regional_stats_public IS '地方基本統計，換成網站慣用的縣市／鄉鎮市區寫法（#508），前端一次撈這個視圖即可，不用自己 join admin_divisions';
GRANT SELECT ON regional_stats_public TO anon, authenticated;

-- ------------------------------------------------------------
-- 6. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'regional_stats') THEN
    RAISE EXCEPTION 'regional_stats 沒開 RLS';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants g
              WHERE g.table_schema = 'public' AND g.table_name = 'regional_stats' AND g.grantee IN ('anon', 'authenticated') AND g.privilege_type <> 'SELECT') THEN
    RAISE EXCEPTION 'regional_stats：anon／authenticated 不該有除了 SELECT 以外的權限';
  END IF;
  IF NOT has_table_privilege('anon', 'regional_stats', 'SELECT') THEN
    RAISE EXCEPTION 'regional_stats：anon 讀不到這張表（GRANT 沒生效）';
  END IF;
  IF NOT has_table_privilege('anon', 'regional_stats_public', 'SELECT') THEN
    RAISE EXCEPTION 'regional_stats_public：anon 讀不到這個視圖（GRANT 沒生效）';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
