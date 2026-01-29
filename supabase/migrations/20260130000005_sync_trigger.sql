-- ============================================================
-- Phase 1.5: Sync trigger for auto-updating politicians table
-- ============================================================
-- This trigger automatically syncs politicians table fields with the
-- latest election (highest election_id) data from politician_elections.
-- This enables backward compatibility - existing code can still read
-- position/slogan/electionType directly from politicians table.

-- Trigger function: When politician_elections changes, sync to politicians
CREATE OR REPLACE FUNCTION sync_politician_latest_election()
RETURNS TRIGGER AS $$
DECLARE
  v_politician_id UUID;
  v_latest RECORD;
BEGIN
  -- Get the politician_id to process
  IF TG_OP = 'DELETE' THEN
    v_politician_id := OLD.politician_id;
  ELSE
    v_politician_id := NEW.politician_id;
  END IF;

  -- Find the latest election data for this politician (highest election_id = newest)
  -- Using election_id DESC as it's more reliable than election_date
  SELECT pe.position, pe.slogan, pe.election_type, pe.region_id
  INTO v_latest
  FROM politician_elections pe
  WHERE pe.politician_id = v_politician_id
  ORDER BY pe.election_id DESC
  LIMIT 1;

  -- Update politicians table with latest data
  IF v_latest IS NOT NULL THEN
    UPDATE politicians SET
      position = COALESCE(v_latest.position, position),
      slogan = COALESCE(v_latest.slogan, slogan),
      election_type = COALESCE(v_latest.election_type, election_type::TEXT),
      region_id = COALESCE(v_latest.region_id, region_id)
    WHERE id = v_politician_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Create trigger
DROP TRIGGER IF EXISTS trg_sync_politician_latest ON politician_elections;
CREATE TRIGGER trg_sync_politician_latest
AFTER INSERT OR UPDATE OR DELETE ON politician_elections
FOR EACH ROW
EXECUTE FUNCTION sync_politician_latest_election();

-- Add comment
COMMENT ON FUNCTION sync_politician_latest_election() IS
'Automatically syncs politicians table position/slogan/election_type/region_id with the latest election data from politician_elections';

-- ============================================================
-- Update upsert_politician RPC to support election-specific data
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
      avatar_url = COALESCE(p_avatar_url, avatar_url),
      slogan = COALESCE(p_slogan, slogan),
      region_id = v_region_id
    WHERE id = v_politician_id;
    v_result := 'updated';
  ELSE
    -- Insert new politician
    INSERT INTO politicians (
      name, party, status, election_type, position, current_position,
      region, sub_region, village, birth_year, education_level, avatar_url,
      slogan, region_id
    )
    VALUES (
      p_name, p_party, p_status, p_election_type, p_position, p_current_position,
      p_region, p_sub_region, p_village, p_birth_year, p_education_level, p_avatar_url,
      p_slogan, v_region_id
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
$$ LANGUAGE plpgsql;
