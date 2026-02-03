-- ============================================================
-- Deduplicate politicians table
-- Merge duplicate politicians (same name + party) into one
-- ============================================================

-- Step 1: Create temp table to identify duplicates and which to keep
-- Keep the one with the most data (bio, avatar_url, etc.)
CREATE TEMP TABLE politician_duplicates AS
WITH ranked AS (
  SELECT
    id,
    name,
    party,
    -- Score based on data completeness
    (CASE WHEN bio IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN avatar_url IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN experience IS NOT NULL THEN 1 ELSE 0 END +
     CASE WHEN education IS NOT NULL THEN 1 ELSE 0 END) as data_score,
    ROW_NUMBER() OVER (
      PARTITION BY name, party
      ORDER BY
        (CASE WHEN bio IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN avatar_url IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN experience IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN education IS NOT NULL THEN 1 ELSE 0 END) DESC,
        id ASC  -- Tie-breaker: keep lower ID
    ) as rn
  FROM politicians
)
SELECT
  r1.id as keep_id,
  r2.id as delete_id,
  r1.name
FROM ranked r1
JOIN ranked r2 ON r1.name = r2.name AND r1.party = r2.party AND r1.rn = 1 AND r2.rn > 1;

-- Step 2: Copy politician_elections from duplicates to kept politician (skip conflicts)
-- Use INSERT...SELECT with ON CONFLICT to avoid duplicates
INSERT INTO politician_elections (
  politician_id, election_id, position, slogan, election_type, region_id,
  election_result, votes_received, vote_percentage, candidate_status,
  verified, verified_at, verified_by, source_note
)
SELECT
  pd.keep_id,
  pe.election_id,
  pe.position,
  pe.slogan,
  pe.election_type,
  pe.region_id,
  pe.election_result,
  pe.votes_received,
  pe.vote_percentage,
  pe.candidate_status,
  pe.verified,
  pe.verified_at,
  pe.verified_by,
  pe.source_note
FROM politician_elections pe
JOIN politician_duplicates pd ON pe.politician_id = pd.delete_id
ON CONFLICT (politician_id, election_id) DO NOTHING;

-- Step 3: Delete all politician_elections for duplicate politicians
DELETE FROM politician_elections pe
USING politician_duplicates pd
WHERE pe.politician_id = pd.delete_id;

-- Step 4: Move policies from duplicates to the kept politician
UPDATE policies p
SET politician_id = pd.keep_id
FROM politician_duplicates pd
WHERE p.politician_id = pd.delete_id;

-- Step 5: Delete duplicate politicians
DELETE FROM politicians p
USING politician_duplicates pd
WHERE p.id = pd.delete_id;

-- Step 6: Report results
DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO deleted_count FROM politician_duplicates;
  RAISE NOTICE 'Merged % duplicate politicians', deleted_count;
END $$;

-- Clean up
DROP TABLE politician_duplicates;
