-- ============================================================
-- Phase 1.3: Migrate election-specific data
-- ============================================================

-- 1. Set region_id for politicians based on existing region/sub_region/village
UPDATE politicians p
SET region_id = r.id
FROM regions r
WHERE p.region = r.region
  AND COALESCE(p.sub_region, '') = COALESCE(r.sub_region, '')
  AND COALESCE(p.village, '') = COALESCE(r.village, '')
  AND p.region_id IS NULL;

-- 2. Ensure all politicians have a politician_elections record
-- (Create missing records with the minimum election_id from elections table)
INSERT INTO politician_elections (politician_id, election_id)
SELECT p.id, (SELECT MIN(id) FROM elections)
FROM politicians p
WHERE NOT EXISTS (
  SELECT 1 FROM politician_elections pe WHERE pe.politician_id = p.id
)
  AND EXISTS (SELECT 1 FROM elections)  -- Only if elections exist
ON CONFLICT DO NOTHING;

-- 3. Migrate data from politicians to politician_elections
UPDATE politician_elections pe
SET
  position = p.position,
  slogan = p.slogan,
  election_type = p.election_type::TEXT,
  region_id = p.region_id
FROM politicians p
WHERE pe.politician_id = p.id
  AND pe.position IS NULL;

-- 4. Set election_id for existing policies
-- Use the minimum election_id for each politician (typically their first election)
UPDATE policies pol
SET election_id = (
  SELECT MIN(pe.election_id)
  FROM politician_elections pe
  WHERE pe.politician_id = pol.politician_id
)
WHERE pol.election_id IS NULL;

-- 5. Add foreign key constraints now that data is in place
ALTER TABLE politicians
ADD CONSTRAINT fk_politicians_region_id
FOREIGN KEY (region_id) REFERENCES regions(id)
ON DELETE SET NULL;

ALTER TABLE politician_elections
ADD CONSTRAINT fk_politician_elections_region_id
FOREIGN KEY (region_id) REFERENCES regions(id)
ON DELETE SET NULL;

ALTER TABLE policies
ADD CONSTRAINT fk_policies_election_id
FOREIGN KEY (election_id) REFERENCES elections(id)
ON DELETE SET NULL;
