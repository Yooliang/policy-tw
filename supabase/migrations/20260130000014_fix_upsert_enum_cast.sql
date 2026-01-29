-- ============================================================
-- 修復 upsert_politician 函數的 enum 轉型問題
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_politician(
  p_name TEXT,
  p_party TEXT DEFAULT '無黨籍',
  p_status TEXT DEFAULT 'politician',
  p_election_type TEXT DEFAULT '其他',
  p_position TEXT DEFAULT '',
  p_current_position TEXT DEFAULT NULL,
  p_region TEXT DEFAULT '未知',
  p_sub_region TEXT DEFAULT NULL,
  p_village TEXT DEFAULT NULL,
  p_birth_year INT DEFAULT NULL,
  p_education_level TEXT DEFAULT NULL,
  p_avatar_url TEXT DEFAULT NULL,
  p_slogan TEXT DEFAULT NULL,
  p_election_id INT DEFAULT 1
) RETURNS TEXT AS $$
DECLARE
  v_politician_id UUID;
  v_region_id INTEGER;
  v_result TEXT;
BEGIN
  -- Get or create region_id from regions table
  SELECT id INTO v_region_id
  FROM regions
  WHERE region = p_region
    AND COALESCE(sub_region, '') = COALESCE(p_sub_region, '')
    AND COALESCE(village, '') = COALESCE(p_village, '');

  -- Insert region if not exists
  IF v_region_id IS NULL THEN
    INSERT INTO regions (region, sub_region, village)
    VALUES (p_region, p_sub_region, p_village)
    RETURNING id INTO v_region_id;
  END IF;

  -- Check if politician already exists (by name and region)
  SELECT id INTO v_politician_id
  FROM politicians
  WHERE name = p_name AND region = p_region
  LIMIT 1;

  IF v_politician_id IS NOT NULL THEN
    -- Update existing politician (cast enums)
    UPDATE politicians SET
      party = COALESCE(p_party, party),
      status = COALESCE(p_status::politician_status, status),
      election_type = COALESCE(p_election_type::election_type, election_type),
      position = COALESCE(NULLIF(p_position, ''), position),
      current_position = COALESCE(p_current_position, current_position),
      sub_region = COALESCE(p_sub_region, sub_region),
      village = COALESCE(p_village, village),
      birth_year = COALESCE(p_birth_year, birth_year),
      education_level = COALESCE(p_education_level, education_level),
      avatar_url = COALESCE(p_avatar_url, avatar_url),
      slogan = COALESCE(p_slogan, slogan),
      region_id = v_region_id
    WHERE id = v_politician_id;
    v_result := 'updated';
  ELSE
    -- Insert new politician (cast enums)
    INSERT INTO politicians (
      name, party, status, election_type, position, current_position,
      region, sub_region, village, birth_year, education_level, avatar_url,
      slogan, region_id
    )
    VALUES (
      p_name, p_party, p_status::politician_status, p_election_type::election_type,
      p_position, p_current_position, p_region, p_sub_region, p_village,
      p_birth_year, p_education_level, p_avatar_url, p_slogan, v_region_id
    )
    RETURNING id INTO v_politician_id;
    v_result := 'inserted';
  END IF;

  -- Insert or update politician_elections with election-specific data
  INSERT INTO politician_elections (
    politician_id, election_id, position, slogan, election_type, region_id
  )
  VALUES (
    v_politician_id, p_election_id, p_position, p_slogan, p_election_type, v_region_id
  )
  ON CONFLICT (politician_id, election_id) DO UPDATE SET
    position = COALESCE(EXCLUDED.position, politician_elections.position),
    slogan = COALESCE(EXCLUDED.slogan, politician_elections.slogan),
    election_type = COALESCE(EXCLUDED.election_type, politician_elections.election_type),
    region_id = COALESCE(EXCLUDED.region_id, politician_elections.region_id);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
