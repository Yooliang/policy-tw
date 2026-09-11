-- ============================================================
-- candidate_status 新增三個值（2026 登記參選名單匯入用）
--   registered  已向選委會登記（8/31～9/4 登記期，來源：中央社名單／中選會）
--   qualified   10/16 選委會審定合格後
--   not_running AI 猜的參選人，但登記期結束沒有登記
-- 既有值不動：rumored / likely / confirmed / elected / defeated。
-- politicians_with_elections view 只是把 pe.candidate_status 原樣塞進 JSON，不用重建。
-- 前端要改的檔（這支 migration 不動前端）：
--   types.ts                        CandidateStatus union 加 'registered' | 'qualified' | 'not_running'
--   pages/election/PoliticianGrid.vue candidateStatusLabel／candidateStatusColor／shouldShowSubRegion
--   pages/PoliticianProfile.vue     getCandidateStatusLabel／getCandidateStatusColor
--   components/StatusBadge.vue      只管政見 PolicyStatus，不用動
-- ============================================================

ALTER TABLE politician_elections
DROP CONSTRAINT IF EXISTS politician_elections_candidate_status_check;

ALTER TABLE politician_elections
ADD CONSTRAINT politician_elections_candidate_status_check
CHECK (candidate_status IN (
    'rumored',      -- 選前：傳聞
    'likely',       -- 選前：可能參選
    'confirmed',    -- 選前：確認參選（宣布／黨提名）
    'registered',   -- 選前：已登記參選
    'qualified',    -- 選前：審定合格
    'not_running',  -- 選前：未登記（傳聞落空）
    'elected',      -- 選後：當選
    'defeated'      -- 選後：落選
));

COMMENT ON COLUMN politician_elections.candidate_status IS
  '參選狀態：rumored(傳聞), likely(可能參選), confirmed(確認參選), registered(已登記), qualified(審定合格), not_running(未登記), elected(當選), defeated(落選)';
