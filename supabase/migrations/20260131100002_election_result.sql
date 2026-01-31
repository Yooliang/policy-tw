-- ============================================================
-- Election Result Fields
-- Track election outcomes for politicians
-- ============================================================

-- Add election result columns to politician_elections
ALTER TABLE politician_elections
ADD COLUMN IF NOT EXISTS election_result TEXT CHECK (election_result IN ('elected', 'not_elected', 'withdrawn', 'pending')),
ADD COLUMN IF NOT EXISTS votes_received INTEGER,
ADD COLUMN IF NOT EXISTS vote_percentage DECIMAL(5, 2);

-- Index for filtering by election result
CREATE INDEX IF NOT EXISTS idx_politician_elections_result ON politician_elections(election_result);

-- Comments
COMMENT ON COLUMN politician_elections.election_result IS 'Election outcome: elected, not_elected, withdrawn, or pending';
COMMENT ON COLUMN politician_elections.votes_received IS 'Number of votes received';
COMMENT ON COLUMN politician_elections.vote_percentage IS 'Percentage of total votes received';

-- View for elected politicians (used for policy progress tracking)
CREATE OR REPLACE VIEW elected_politicians AS
SELECT
  p.id,
  p.name,
  p.party,
  p.status,
  p.avatar_url,
  p.region,
  p.sub_region,
  pe.election_id,
  pe.position,
  pe.election_type,
  pe.votes_received,
  pe.vote_percentage,
  e.name AS election_name,
  e.election_date
FROM politicians p
JOIN politician_elections pe ON p.id = pe.politician_id
JOIN elections e ON pe.election_id = e.id
WHERE pe.election_result = 'elected';

GRANT SELECT ON elected_politicians TO anon, authenticated;
