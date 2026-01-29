-- Add current_position field to politicians table
ALTER TABLE politicians
ADD COLUMN IF NOT EXISTS current_position TEXT;

-- Migrate existing position data to current_position (since old data is mostly about current job)
UPDATE politicians
SET current_position = position
WHERE current_position IS NULL AND position IS NOT NULL;

-- Clear position field (will be set to proper "參選職位" later)
-- UPDATE politicians SET position = NULL;

-- Add comment for clarity
COMMENT ON COLUMN politicians.position IS '參選職位 (e.g., 縣市長候選人, 縣市議員候選人)';
COMMENT ON COLUMN politicians.current_position IS '現職 (e.g., 立法委員, 現任市長, 議員)';

-- Update the view to include the new column
DROP VIEW IF EXISTS politicians_with_elections;

CREATE VIEW politicians_with_elections AS
SELECT
  p.id,
  p.name,
  p.party,
  p.status,
  p.election_type,
  p.position,
  p.current_position,
  p.region,
  p.sub_region,
  p.village,
  p.avatar_url,
  p.slogan,
  p.bio,
  p.education,
  p.experience,
  p.birth_year,
  p.education_level,
  COALESCE(
    (SELECT json_agg(pe.election_id) FROM politician_elections pe WHERE pe.politician_id = p.id),
    '[]'::json
  ) AS election_ids
FROM politicians p;

-- Update the upsert_politician RPC function to include current_position
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
  p_election_id INT DEFAULT 2026
) RETURNS TEXT AS $$
DECLARE
  v_politician_id UUID;
  v_result TEXT;
BEGIN
  -- Check if politician already exists
  SELECT id INTO v_politician_id
  FROM politicians
  WHERE name = p_name AND region = p_region
  LIMIT 1;

  IF v_politician_id IS NOT NULL THEN
    -- Update existing politician
    UPDATE politicians SET
      party = COALESCE(p_party, party),
      status = COALESCE(p_status, status),
      election_type = COALESCE(p_election_type, election_type),
      position = COALESCE(NULLIF(p_position, ''), position),
      current_position = COALESCE(p_current_position, current_position),
      sub_region = COALESCE(p_sub_region, sub_region),
      village = COALESCE(p_village, village),
      birth_year = COALESCE(p_birth_year, birth_year),
      education_level = COALESCE(p_education_level, education_level),
      avatar_url = COALESCE(p_avatar_url, avatar_url)
    WHERE id = v_politician_id;
    v_result := 'updated';
  ELSE
    -- Insert new politician
    INSERT INTO politicians (name, party, status, election_type, position, current_position, region, sub_region, village, birth_year, education_level, avatar_url)
    VALUES (p_name, p_party, p_status, p_election_type, p_position, p_current_position, p_region, p_sub_region, p_village, p_birth_year, p_education_level, p_avatar_url)
    RETURNING id INTO v_politician_id;
    v_result := 'inserted';
  END IF;

  -- Link to election if not already linked
  INSERT INTO politician_elections (politician_id, election_id)
  VALUES (v_politician_id, p_election_id)
  ON CONFLICT DO NOTHING;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql;
