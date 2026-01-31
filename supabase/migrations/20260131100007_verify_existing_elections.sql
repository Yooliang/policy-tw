-- Mark 2022 and 2024 election data as verified (from CEC)
UPDATE politician_elections
SET
  verified = TRUE,
  verified_at = NOW(),
  source_note = '中選會官方資料'
WHERE election_id IN (
  SELECT id FROM elections WHERE EXTRACT(YEAR FROM election_date) IN (2022, 2024)
);
