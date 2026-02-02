-- ============================================================
-- Fix candidate_status for past elections
-- 過去選舉的候選人應為 confirmed（中選會官方資料）
-- 而非 rumored（傳聞）
-- ============================================================

-- 對於已結束的選舉（election_date < NOW()），
-- 如果 source_note 包含「中選會」，則應為 confirmed
UPDATE politician_elections pe
SET candidate_status = 'confirmed'
FROM elections e
WHERE pe.election_id = e.id
  AND e.election_date < CURRENT_DATE
  AND (pe.source_note LIKE '%中選會%' OR pe.source_note IS NULL)
  AND (pe.candidate_status IS NULL OR pe.candidate_status = 'rumored');

-- 如果是 2022 選舉（已結束），預設設為 confirmed
UPDATE politician_elections pe
SET candidate_status = 'confirmed'
FROM elections e
WHERE pe.election_id = e.id
  AND e.election_date < '2023-01-01'
  AND (pe.candidate_status IS NULL OR pe.candidate_status = 'rumored');
