-- RPC function to get politicians by election ID
-- Uses politician_elections table for efficient JOIN

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
