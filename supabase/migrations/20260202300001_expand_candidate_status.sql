-- ============================================================
-- Expand candidate_status to support election lifecycle
-- 選舉前中後三階段狀態
-- ============================================================

-- Drop existing constraint
ALTER TABLE politician_elections
DROP CONSTRAINT IF EXISTS politician_elections_candidate_status_check;

-- Add expanded constraint with new statuses
ALTER TABLE politician_elections
ADD CONSTRAINT politician_elections_candidate_status_check
CHECK (candidate_status IN (
    'rumored',    -- 選前：傳聞
    'likely',     -- 選前：可能參選
    'confirmed',  -- 選中：確認參選（中選會登記）
    'elected',    -- 選後：當選
    'defeated'    -- 選後：落選
));

-- Comments
COMMENT ON COLUMN politician_elections.candidate_status IS '參選狀態：rumored(傳聞), likely(可能參選), confirmed(確認參選), elected(當選), defeated(落選)';
