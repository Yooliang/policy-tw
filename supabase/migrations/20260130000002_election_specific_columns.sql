-- ============================================================
-- Phase 1.2: Add election-specific columns to politician_elections
-- ============================================================

-- Add region_id column to politicians table (FK added later after data migration)
ALTER TABLE politicians
ADD COLUMN IF NOT EXISTS region_id INTEGER;

-- Add election-specific columns to politician_elections
ALTER TABLE politician_elections
ADD COLUMN IF NOT EXISTS position TEXT,           -- Running position (參選職位)
ADD COLUMN IF NOT EXISTS slogan TEXT,             -- Campaign slogan (競選口號)
ADD COLUMN IF NOT EXISTS election_type TEXT,      -- Election type (參選類型)
ADD COLUMN IF NOT EXISTS region_id INTEGER;       -- Normalized region FK (added later)

-- Add election_id column to policies
ALTER TABLE policies
ADD COLUMN IF NOT EXISTS election_id INTEGER;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_policies_election_id ON policies(election_id);
CREATE INDEX IF NOT EXISTS idx_politician_elections_region_id ON politician_elections(region_id);
CREATE INDEX IF NOT EXISTS idx_politicians_region_id ON politicians(region_id);

-- Add comments
COMMENT ON COLUMN politician_elections.position IS 'Running position for this specific election (e.g., 縣市長候選人)';
COMMENT ON COLUMN politician_elections.slogan IS 'Campaign slogan for this specific election';
COMMENT ON COLUMN politician_elections.election_type IS 'Election type for this specific election (e.g., 縣市長, 縣市議員)';
COMMENT ON COLUMN politician_elections.region_id IS 'Reference to normalized region for this specific election';
COMMENT ON COLUMN politicians.region_id IS 'Reference to normalized region (synced from latest election)';
COMMENT ON COLUMN policies.election_id IS 'Reference to the election this policy belongs to';
