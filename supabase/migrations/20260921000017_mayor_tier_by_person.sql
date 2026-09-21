-- 修正：優先層改成由 politician_id 直接判，不依賴各臂剛好在 target 裡塞了什麼。
--
-- 上一版比對 target->>'election_type' = '縣市長'，但 profile_gap 那一臂的 target
-- 只有 politician_id／name／party／region／election_id／missing——**沒有 election_type**，
-- 所以它落到最低優先層，跟「基本資料最前」正好相反。實測才看出來。
--
-- 教訓：判斷條件不要建立在「各臂剛好放了什麼欄位」上，那是七臂各自維護的東西。

CREATE OR REPLACE FUNCTION task_priority_tier(p_task_type TEXT, p_target JSONB) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_task_type NOT IN ('profile_gap', 'policy_missing') THEN 2
    WHEN NOT is_2026_mayor_candidate(NULLIF(p_target->>'politician_id', '')::UUID) THEN 2
    WHEN p_task_type = 'profile_gap' THEN 0
    ELSE 1
  END;
$$;
COMMENT ON FUNCTION task_priority_tier IS
  '派工的第一層排序：2026 縣市長的基本資料(0) → 政見(1) → 其餘(2)。由 politician_id 判，不看各臂在 target 裡放了什麼。';
