-- 2026 縣市長的基本資料與政見排最前（使用者 2026-09-21）。
--
-- 「這 83 個人的基本資料我們要有，這是目前網站進來最大的賣點。第二大的任務就是補充
-- 他們的政見。先有基本資料、有政見，再來談後續其他的部分。」
--
-- 實查 82 位已登記的 2026 縣市長候選人：45 位缺基本資料、29 位 0 政見、
-- **24 位只有 1～2 筆政見**。最後那 24 位目前完全不會被派任務——policy_missing
-- 的條件是「0 筆」，補了第一筆之後就沒有人再管。這支一併處理。
--
-- 兩件事：
--   1. policy_missing 對 2026 縣市長放寬成「少於 3 筆」（其他職位維持 0 筆才派）
--   2. 派工排序加一層：2026 縣市長的 profile_gap 最前、policy_missing 次之、其餘照舊

-- 判斷用的小函式：這個人是不是 2026 已登記的縣市長候選人
CREATE OR REPLACE FUNCTION is_2026_mayor_candidate(p_politician_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM politician_elections pe
    WHERE pe.politician_id = p_politician_id
      AND pe.election_id = 2026 AND pe.election_type = '縣市長'
      AND pe.candidate_status IN ('registered', 'qualified', 'confirmed')
  );
$$;
COMMENT ON FUNCTION is_2026_mayor_candidate IS
  '2026 已登記的縣市長候選人：他們的基本資料與政見是網站首要內容，派工排最前（使用者 2026-09-21）。';

-- 縣市長政見不足 3 筆也要派（其他職位仍是 0 筆才派）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_mayor_policies()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT p.id, p.name, p.party, p.region,
           (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = p.id AND pl.removed_at IS NULL) AS n
    FROM politicians p
    WHERE p.merged_into IS NULL AND is_2026_mayor_candidate(p.id)
  )
  SELECT 'auto:policy_missing:' || m.id, 'policy_missing',
         jsonb_build_object('politician_id', m.id, 'name', m.name, 'party', m.party, 'region', m.region,
                            'election_id', 2026, 'election_type', '縣市長', 'policies_now', m.n),
         m.name || '（' || COALESCE(m.region, '') || ' 2026 縣市長候選人）目前只有 ' || m.n ||
           ' 筆政見。縣市長是網站的主要內容，請把這位的政見補齊：找有出處的具體政見，最多 5 筆、每筆一個 policy 型別、各附自己的出處。' ||
           '先看 current.queued_policies 與既有政見，已經有的不要重複交。' ||
           '找到幾筆交幾筆，不要為了湊數交口號、願景或個人表態。',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 2, m.region
  FROM m
  WHERE m.n BETWEEN 1 AND 2   -- 0 筆的那些由原本的 policy_missing 臂處理，不要重複
$$;
COMMENT ON FUNCTION contribution_auto_tasks_mayor_policies IS
  '2026 縣市長政見不足 3 筆：原本的 policy_missing 只在 0 筆時派，補了第一筆就沒人再管（實查 24 位卡在 1～2 筆）。';

-- 併進 arms
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT * FROM contribution_auto_tasks_raw()
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
$$;

-- 排序：2026 縣市長的基本資料最前、政見次之，其餘照舊
CREATE OR REPLACE FUNCTION task_priority_tier(p_task_type TEXT, p_target JSONB) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_target->>'election_type' = '縣市長' AND (p_target->>'election_id')::TEXT = '2026' AND p_task_type = 'profile_gap' THEN 0
    WHEN p_target->>'election_type' = '縣市長' AND (p_target->>'election_id')::TEXT = '2026' AND p_task_type = 'policy_missing' THEN 1
    ELSE 2
  END;
$$;
COMMENT ON FUNCTION task_priority_tier IS
  '派工的第一層排序：2026 縣市長的基本資料(0) → 政見(1) → 其餘(2)。使用者 2026-09-21：先有基本資料、有政見，再談其他。';
