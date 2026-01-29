-- ============================================================
-- Phase 1.4: Update views to include election-specific data
-- ============================================================

-- Drop existing view
DROP VIEW IF EXISTS politicians_with_elections;

-- Create updated view with elections array containing election-specific data
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
  -- New: array of election-specific data objects
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
        'village', COALESCE(per.village, r.village, p.village)
      )
    ) FROM politician_elections pe
    LEFT JOIN regions per ON pe.region_id = per.id
    WHERE pe.politician_id = p.id),
    '[]'::json
  ) AS elections
FROM politicians p
LEFT JOIN regions r ON p.region_id = r.id;

-- Update policies_with_logs view to include election_id
DROP VIEW IF EXISTS policies_with_logs;

CREATE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'id', tl.id,
        'date', tl.date,
        'event', tl.event,
        'description', tl.description
      ) ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids
FROM policies p;
