-- 名單清查加入鄉鎮市長、直轄市山地原住民區長（2026-10-03，維護者：「九合一各種參選都要收」）
--
-- 盤點：2026 只收了縣市長（82 位已登記）與縣市議員（962 位），其餘七種 0 筆。
-- 這一支先收人數少、一個縣市一筆任務就清得完的兩種（2022 中選會：鄉鎮市長 489 人、原住民區長 20 人）。
-- 村里長、鄉鎮市民代表、原住民區民代表（約一萬七千人）另案：等 11-17 官方名單，走系統比對匯入，不派人逐筆抄。
--
-- 原本的清查是「每種選舉 × 全部 22 縣市」：鄉鎮市長只有 13 個縣有、原住民區長只有 4 個直轄市有，
-- 照舊會對其他縣市派出注定是 0 人的任務。所以範圍表加一欄 regions（NULL＝全部縣市，維持縣市長／議員原狀），
-- 在 contribution_auto_tasks_arms() 把範圍外的 roster_check 濾掉——不重寫 200 行的 contribution_auto_tasks_raw()。
-- candidate_status_stale 臂也 JOIN 這張表，加列後這兩種的「傳聞／可能參選」也會在登記截止後被追，這是要的。

ALTER TABLE roster_check_scope ADD COLUMN IF NOT EXISTS regions TEXT[];
COMMENT ON COLUMN roster_check_scope.regions IS '這種選舉有哪些縣市要清查；NULL＝全部縣市（locations）';

INSERT INTO roster_check_scope (election_id, election_type, recheck_days, list_announced_on, registration_closed_on, regions) VALUES
  (2026, '鄉鎮市長', 7, DATE '2026-11-17', DATE '2026-09-04',
   ARRAY['宜蘭縣', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '台東縣', '花蓮縣', '澎湖縣', '金門縣', '連江縣']),
  (2026, '直轄市山地原住民區長', 7, DATE '2026-11-17', DATE '2026-09-04',
   ARRAY['新北市', '桃園市', '台中市', '高雄市'])
ON CONFLICT (election_id, election_type) DO NOTHING;

CREATE OR REPLACE FUNCTION roster_scope_covers(p_election_type TEXT, p_region TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM roster_check_scope s
    WHERE s.election_type = p_election_type AND (s.regions IS NULL OR p_region = ANY (s.regions))
  )
$$;
COMMENT ON FUNCTION roster_scope_covers IS '名單清查：這個縣市在不在這種選舉的清查範圍（roster_check_scope.regions，NULL＝全部）';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT r.* FROM contribution_auto_tasks_raw() r
   WHERE r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region)
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。'
  '2026-10-03 名單清查依 roster_check_scope.regions 濾掉沒有這種選舉的縣市。';
