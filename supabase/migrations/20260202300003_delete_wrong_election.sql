-- ============================================================
-- Delete wrongly created election with id=2
-- elections.id should be the election year (2022, 2024, 2026)
-- ============================================================

-- First delete any related records
DELETE FROM election_types WHERE election_id = 2;
DELETE FROM politician_elections WHERE election_id = 2;

-- Then delete the wrong election record
DELETE FROM elections WHERE id = 2;
