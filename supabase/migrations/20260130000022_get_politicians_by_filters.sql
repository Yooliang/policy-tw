-- RPC function to get politicians by election, region and election types
-- Supports lazy loading by region selection

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
  WHERE EXISTS (
    SELECT 1 FROM politician_elections pe
    WHERE pe.politician_id = pwe.id
    AND pe.election_id = p_election_id
  )
  AND (p_region IS NULL OR pwe.region = p_region)
  AND (p_election_types IS NULL OR pwe.election_type = ANY(p_election_types));
$$;
