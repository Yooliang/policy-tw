-- Add candidate status field to track announcement status
ALTER TABLE politician_elections
ADD COLUMN IF NOT EXISTS candidate_status TEXT
  CHECK (candidate_status IN ('confirmed', 'likely', 'rumored'))
  DEFAULT 'rumored';

COMMENT ON COLUMN politician_elections.candidate_status IS '參選狀態：confirmed(已宣布)、likely(可能參選)、rumored(傳聞)';
