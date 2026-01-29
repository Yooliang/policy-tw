-- ============================================================
-- 修復 politician_elections 中誤設為 2024 的資料
-- 這些實際上是 2026 年的候選人
-- ============================================================

-- 先刪除已存在於 2026 的記錄（避免衝突）
DELETE FROM politician_elections pe1
WHERE pe1.election_id = 2024
  AND EXISTS (
    SELECT 1 FROM politician_elections pe2
    WHERE pe2.politician_id = pe1.politician_id
      AND pe2.election_id = 2026
  );

-- 將剩餘的 election_id 從 2024 改為 2026
UPDATE politician_elections
SET election_id = 2026
WHERE election_id = 2024;
