-- Fix: Use election_type from politician_elections, not from view
-- This ensures we filter by the type in that specific election

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
