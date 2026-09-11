-- ============================================================
-- 政治人物身份比對：面向 key 表 + 待審表 + 正規化函式 + 自動累積觸發器
--
-- 背景：AI 匯入用 name.eq().single() 找人，同名 ≥2 筆時回錯誤被當「查無」再 insert，
--       每跑一次多一筆空殼（陳素月 10 筆）。改成確定性多面向比對，見
--       supabase/functions/_shared/politician-identity.ts。
--
-- 這裡的 identity_norm_* 規則與 TS 版 identity-normalize.ts 一一對應，
-- 共用測試案例 supabase/functions/_shared/fixtures/normalization-cases.json；
-- 套完可用 scripts/verify-identity-norm.sql 驗 SQL 版是否與案例一致。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS politician_keys (
  id            BIGSERIAL PRIMARY KEY,
  politician_id UUID NOT NULL REFERENCES politicians(id) ON DELETE CASCADE,
  key_type      TEXT NOT NULL CHECK (key_type IN ('birth', 'region_type', 'position', 'party', 'alias_name', 'cec_cand_id')),
  key_value     TEXT NOT NULL,
  strength      SMALLINT NOT NULL CHECK (strength BETWEEN 1 AND 3),
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE politician_keys IS '政治人物已知面向 key：新資料只要姓名相同且面向對得上就是同一人。故意不對 (key_type, key_value) 加 unique——同名兩人可合法共用一個 key。';
COMMENT ON COLUMN politician_keys.key_type IS 'birth(強3)={name}|{birth_year}；region_type(中2)={name}|{region}|{election_type}；position(中2／常見職位弱1)={name}|{職位類別}；party(弱1)={name}|{party}；alias_name(強3)={舊名}；cec_cand_id(強3)={中選會 cand_id}，只在新匯入時寫入、不回溯';
COMMENT ON COLUMN politician_keys.source IS '來源：backfill／derived（觸發器）／ai-action／import-candidate／manual…';

-- 同一人同一 key 只留一筆（讓回填與寫回可重跑）
CREATE UNIQUE INDEX IF NOT EXISTS idx_politician_keys_unique
  ON politician_keys (politician_id, key_type, key_value);
CREATE INDEX IF NOT EXISTS idx_politician_keys_lookup
  ON politician_keys (key_type, key_value);
CREATE INDEX IF NOT EXISTS idx_politician_keys_politician
  ON politician_keys (politician_id);

CREATE TABLE IF NOT EXISTS politician_identity_reviews (
  id                     BIGSERIAL PRIMARY KEY,
  candidate              JSONB NOT NULL,
  candidates             JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason                 TEXT,
  source                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at            TIMESTAMPTZ,
  resolved_politician_id UUID REFERENCES politicians(id) ON DELETE SET NULL
);

COMMENT ON TABLE politician_identity_reviews IS '身份比對判為 ambiguous 的候選資料：不 insert，留給後台人工認定。';
CREATE INDEX IF NOT EXISTS idx_politician_identity_reviews_status
  ON politician_identity_reviews (status, created_at);

-- RLS：公開讀、service_role 寫（與 policy_sources 同款）
ALTER TABLE politician_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON politician_keys;
CREATE POLICY "Public read" ON politician_keys FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON politician_keys;
CREATE POLICY "Service role write" ON politician_keys FOR ALL USING (auth.role() = 'service_role');

ALTER TABLE politician_identity_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON politician_identity_reviews;
CREATE POLICY "Public read" ON politician_identity_reviews FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON politician_identity_reviews;
CREATE POLICY "Service role write" ON politician_identity_reviews FOR ALL USING (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 2. 正規化函式（鏡射 identity-normalize.ts）
-- ------------------------------------------------------------

-- trim → NFKC（全形轉半形）→ 去所有空白 → 臺→台；空值標記回 NULL
CREATE OR REPLACE FUNCTION identity_norm_text(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN s IN ('', '無', '未知', '未定', '待定', 'null', 'undefined', '-') THEN NULL
    ELSE s
  END
  FROM (SELECT translate(regexp_replace(normalize(t, NFKC), '\s', '', 'g'), '臺', '台') AS s) x;
$$;

CREATE OR REPLACE FUNCTION identity_norm_party(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s
    WHEN '國民黨' THEN '中國國民黨'
    WHEN '民進黨' THEN '民主進步黨'
    WHEN '民眾黨' THEN '台灣民眾黨'
    WHEN '無黨' THEN '無黨籍'
    WHEN '無黨籍及未經政黨推薦' THEN '無黨籍'
    WHEN '無黨籍及未經政黨推薦者' THEN '無黨籍'
    WHEN '未經政黨推薦' THEN '無黨籍'
    ELSE s
  END
  FROM (SELECT identity_norm_text(p) AS s) x;
$$;

-- 職位／現職 → 類別；認不出就回正規化後的原字串
CREATE OR REPLACE FUNCTION identity_norm_position(p TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  s TEXT := identity_norm_text(p);
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  IF s LIKE '%總統%' THEN RETURN '總統副總統'; END IF;
  IF s LIKE '%立法委員%' OR s LIKE '%立委%' OR s LIKE '%立法院%' THEN RETURN '立法委員'; END IF;
  IF s LIKE '%副市長%' OR s LIKE '%副縣長%' THEN RETURN '副縣市長'; END IF;
  IF s LIKE '%議員%' OR s LIKE '%議長%' THEN RETURN '縣市議員'; END IF;
  IF s LIKE '%代表%' THEN
    RETURN CASE WHEN s LIKE '%山地原住民區%' THEN '直轄市山地原住民區民代表' ELSE '鄉鎮市民代表' END;
  END IF;
  IF s LIKE '%山地原住民區長%' THEN RETURN '直轄市山地原住民區長'; END IF;
  IF s LIKE '%鄉鎮市長%' OR s LIKE '%鄉長%' OR s LIKE '%鎮長%' THEN RETURN '鄉鎮市長'; END IF;
  IF s LIKE '%縣市長%' OR s LIKE '%縣長%' OR s LIKE '%市長%' THEN RETURN '縣市長'; END IF;
  IF s LIKE '%村里長%' OR s LIKE '%村長%' OR s LIKE '%里長%' THEN RETURN '村里長'; END IF;
  RETURN s;
END;
$$;

CREATE OR REPLACE FUNCTION identity_norm_election_type(t TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  known TEXT[] := ARRAY['總統副總統','立法委員','縣市長','縣市議員','鄉鎮市長','直轄市山地原住民區長','鄉鎮市民代表','直轄市山地原住民區民代表','村里長'];
  s TEXT := identity_norm_text(t);
  g TEXT;
BEGIN
  IF s IS NULL THEN RETURN NULL; END IF;
  IF s = ANY(known) THEN RETURN s; END IF;
  g := identity_norm_position(s);
  RETURN CASE WHEN g = ANY(known) THEN g ELSE NULL END;
END;
$$;

CREATE OR REPLACE FUNCTION identity_norm_region(r TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s = '全國' THEN NULL ELSE s END FROM (SELECT identity_norm_text(r) AS s) x;
$$;

-- 常見到幾乎沒辨識力的職位類別只算弱面向（1），其餘中（2）
CREATE OR REPLACE FUNCTION identity_position_strength(category TEXT) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN category IN ('縣市議員','鄉鎮市長','鄉鎮市民代表','直轄市山地原住民區民代表','直轄市山地原住民區長','村里長') THEN 1
    ELSE 2
  END::SMALLINT;
$$;

-- ------------------------------------------------------------
-- 3. 由現有欄位推導一個人的全部 key（鏡射 TS buildKeys）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity_build_keys(p_politician_id UUID)
RETURNS TABLE (key_type TEXT, key_value TEXT, strength SMALLINT)
LANGUAGE sql STABLE AS $$
  WITH p AS (
    SELECT
      identity_norm_text(name)                          AS nm,
      CASE WHEN birth_year BETWEEN 1850 AND 2100 THEN birth_year END AS birth,
      identity_norm_party(party)                        AS party,
      identity_norm_region(region)                      AS region,
      identity_norm_election_type(election_type::TEXT)  AS etype,
      identity_norm_position(current_position)          AS cur_pos,
      identity_norm_position(position)                  AS pos
    FROM politicians WHERE id = p_politician_id
  ),
  pe AS (
    SELECT
      COALESCE(identity_norm_region(r.region), p.region) AS region,
      COALESCE(identity_norm_election_type(e.election_type::TEXT), identity_norm_election_type(e.position)) AS etype,
      identity_norm_position(e.position) AS pos
    FROM politician_elections e
    LEFT JOIN regions r ON r.id = e.region_id
    CROSS JOIN p
    WHERE e.politician_id = p_politician_id
  ),
  raw AS (
    SELECT 'birth'::TEXT AS key_type, p.nm || '|' || p.birth AS key_value, 3::SMALLINT AS strength FROM p WHERE p.birth IS NOT NULL
    UNION ALL
    SELECT 'party', p.nm || '|' || p.party, 1 FROM p WHERE p.party IS NOT NULL
    UNION ALL
    SELECT 'region_type', p.nm || '|' || p.region || '|' || p.etype, 2 FROM p WHERE p.region IS NOT NULL AND p.etype IS NOT NULL
    UNION ALL
    SELECT 'position', p.nm || '|' || p.cur_pos, identity_position_strength(p.cur_pos) FROM p WHERE p.cur_pos IS NOT NULL
    UNION ALL
    SELECT 'position', p.nm || '|' || p.pos, identity_position_strength(p.pos) FROM p WHERE p.pos IS NOT NULL
    UNION ALL
    SELECT 'region_type', p.nm || '|' || pe.region || '|' || pe.etype, 2 FROM pe CROSS JOIN p WHERE pe.region IS NOT NULL AND pe.etype IS NOT NULL
    UNION ALL
    SELECT 'position', p.nm || '|' || pe.pos, identity_position_strength(pe.pos) FROM pe CROSS JOIN p WHERE pe.pos IS NOT NULL
  )
  SELECT DISTINCT raw.key_type, raw.key_value, raw.strength
  FROM raw CROSS JOIN p
  WHERE p.nm IS NOT NULL;
$$;

-- 只補缺的 key，不刪（面向是累積的；alias_name 與 AI 寫回的 key 不受影響）
CREATE OR REPLACE FUNCTION identity_sync_keys(p_politician_id UUID, p_source TEXT DEFAULT 'derived')
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER;
BEGIN
  INSERT INTO politician_keys (politician_id, key_type, key_value, strength, source)
  SELECT p_politician_id, k.key_type, k.key_value, k.strength, p_source
  FROM identity_build_keys(p_politician_id) k
  ON CONFLICT (politician_id, key_type, key_value) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 4. 觸發器：politicians／politician_elections 一變就補 key；改名自動留 alias_name
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity_trg_politicians() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.name IS DISTINCT FROM NEW.name AND identity_norm_text(OLD.name) IS NOT NULL THEN
    INSERT INTO politician_keys (politician_id, key_type, key_value, strength, source)
    VALUES (NEW.id, 'alias_name', identity_norm_text(OLD.name), 3, 'rename')
    ON CONFLICT (politician_id, key_type, key_value) DO NOTHING;
  END IF;
  PERFORM identity_sync_keys(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_identity_politicians ON politicians;
CREATE TRIGGER trg_identity_politicians
AFTER INSERT OR UPDATE OF name, party, region, election_type, position, current_position, birth_year
ON politicians
FOR EACH ROW EXECUTE FUNCTION identity_trg_politicians();

CREATE OR REPLACE FUNCTION identity_trg_politician_elections() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM identity_sync_keys(NEW.politician_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_identity_politician_elections ON politician_elections;
CREATE TRIGGER trg_identity_politician_elections
AFTER INSERT OR UPDATE OF politician_id, position, election_type, region_id
ON politician_elections
FOR EACH ROW EXECUTE FUNCTION identity_trg_politician_elections();
