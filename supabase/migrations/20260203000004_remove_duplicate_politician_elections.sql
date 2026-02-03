-- ============================================================
-- Remove duplicate politician_elections for 2026
-- Keep only the most recent record for each politician + election_type combination
-- ============================================================

-- First, identify and delete duplicates, keeping the one with the highest ID
WITH duplicates AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY politician_id, election_id, election_type
      ORDER BY id DESC  -- Keep the latest (highest ID)
    ) as rn
  FROM politician_elections
  WHERE election_id = 2026
)
DELETE FROM politician_elections
WHERE id IN (
  SELECT id FROM duplicates WHERE rn > 1
);

-- Log how many were deleted
DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % duplicate politician_elections records', deleted_count;
END $$;
