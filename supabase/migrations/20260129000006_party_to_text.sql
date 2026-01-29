-- 把 party 欄位從 enum 改成 TEXT，保留原始黨名

-- 先刪除依賴的 view
DROP VIEW IF EXISTS politicians_with_elections;

-- 修改欄位類型
ALTER TABLE politicians
  ALTER COLUMN party TYPE TEXT;

-- 重建 view
CREATE OR REPLACE VIEW politicians_with_elections AS
SELECT
  pol.*,
  COALESCE(
    (SELECT json_agg(pe.election_id)
     FROM politician_elections pe
     WHERE pe.politician_id = pol.id),
    '[]'::json
  ) AS election_ids
FROM politicians pol;

-- 更新 upsert_politician 函式，移除 party 的 enum 轉型
CREATE OR REPLACE FUNCTION upsert_politician(
  p_name TEXT,
  p_party TEXT,
  p_status TEXT,
  p_election_type TEXT,
  p_position TEXT,
  p_region TEXT,
  p_sub_region TEXT,
  p_village TEXT,
  p_birth_year INT,
  p_education_level TEXT,
  p_election_id INT
) RETURNS TEXT AS $$
DECLARE
  v_id UUID;
  v_result TEXT;
BEGIN
  -- 查找是否已存在同名+同出生年的人
  SELECT id INTO v_id FROM politicians
  WHERE name = p_name
    AND (birth_year = p_birth_year OR (birth_year IS NULL AND p_birth_year IS NULL))
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    -- 已存在，更新空白欄位
    UPDATE politicians SET
      birth_year = COALESCE(birth_year, p_birth_year),
      education_level = COALESCE(education_level, p_education_level),
      sub_region = COALESCE(sub_region, p_sub_region),
      village = COALESCE(village, p_village)
    WHERE id = v_id;
    v_result := 'exists';
  ELSE
    -- 不存在，新增（party 改成 TEXT，不需轉型）
    INSERT INTO politicians (name, party, status, election_type, position, region, sub_region, village, birth_year, education_level)
    VALUES (
      p_name,
      p_party,
      p_status::politician_status,
      p_election_type::election_type,
      p_position,
      p_region,
      p_sub_region,
      p_village,
      p_birth_year,
      p_education_level
    )
    RETURNING id INTO v_id;
    v_result := 'inserted';
  END IF;

  -- 關聯選舉
  INSERT INTO politician_elections (politician_id, election_id)
  VALUES (v_id, p_election_id)
  ON CONFLICT (politician_id, election_id) DO NOTHING;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;
