-- ============================================================
-- Add candidate_status to politicians_with_elections view
-- Must drop dependent functions first, then recreate
-- ============================================================

-- 1. Drop dependent functions
DROP FUNCTION IF EXISTS get_politicians_by_election(integer);
DROP FUNCTION IF EXISTS get_politicians_by_filters(integer, text, text[]);

-- 2. Drop existing view
DROP VIEW IF EXISTS politicians_with_elections;

-- 3. Create updated view with candidate_status in elections array
CREATE VIEW politicians_with_elections AS
SELECT
  p.id,
  p.name,
  p.party,
  p.status,
  p.election_type,
  p.position,
  p.current_position,
  -- Region from normalized regions table (for backward compatibility)
  COALESCE(r.region, p.region) AS region,
  COALESCE(r.sub_region, p.sub_region) AS sub_region,
  COALESCE(r.village, p.village) AS village,
  p.avatar_url,
  p.slogan,
  p.bio,
  p.education,
  p.experience,
  p.birth_year,
  p.education_level,
  -- Backward compatible: array of election IDs
  COALESCE(
    (SELECT json_agg(pe.election_id) FROM politician_elections pe WHERE pe.politician_id = p.id),
    '[]'::json
  ) AS election_ids,
  -- New: array of election-specific data objects (including candidate_status and sourceNote)
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'electionId', pe.election_id,
        'position', COALESCE(pe.position, p.position),
        'slogan', COALESCE(pe.slogan, p.slogan),
        'electionType', COALESCE(pe.election_type, p.election_type::TEXT),
        'regionId', pe.region_id,
        'region', COALESCE(per.region, r.region, p.region),
        'subRegion', COALESCE(per.sub_region, r.sub_region, p.sub_region),
        'village', COALESCE(per.village, r.village, p.village),
        'candidateStatus', pe.candidate_status,
        'sourceNote', pe.source_note
      )
    ) FROM politician_elections pe
    LEFT JOIN regions per ON pe.region_id = per.id
    WHERE pe.politician_id = p.id),
    '[]'::json
  ) AS elections
FROM politicians p
LEFT JOIN regions r ON p.region_id = r.id;

-- 4. Recreate dependent functions
CREATE OR REPLACE FUNCTION get_politicians_by_election(p_election_id integer)
RETURNS SETOF politicians_with_elections
LANGUAGE sql
STABLE
AS $$
  SELECT pwe.*
  FROM politicians_with_elections pwe
  WHERE EXISTS (
    SELECT 1 FROM politician_elections pe
    WHERE pe.politician_id = pwe.id
    AND pe.election_id = p_election_id
  );
$$;

CREATE OR REPLACE FUNCTION get_politicians_by_filters(
  p_election_id integer,
  p_region text DEFAULT NULL,
  p_election_types text[] DEFAULT NULL
)
RETURNS SETOF politicians_with_elections
LANGUAGE sql
STABLE
AS $$
  SELECT pwe.*
  FROM politicians_with_elections pwe
  INNER JOIN politician_elections pe ON pe.politician_id = pwe.id AND pe.election_id = p_election_id
  LEFT JOIN regions r ON r.id = pe.region_id
  WHERE (p_region IS NULL OR r.region = p_region)
  AND (p_election_types IS NULL OR pe.election_type = ANY(p_election_types));
$$;
