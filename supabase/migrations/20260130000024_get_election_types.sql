-- Get available election types for a specific election
CREATE OR REPLACE FUNCTION get_election_types(p_election_id integer)
RETURNS TABLE(election_type text, count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT pe.election_type, COUNT(*) as count
  FROM politician_elections pe
  WHERE pe.election_id = p_election_id
  GROUP BY pe.election_type
  ORDER BY count DESC;
$$;
