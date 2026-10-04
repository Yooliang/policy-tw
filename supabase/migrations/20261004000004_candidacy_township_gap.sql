-- 鄉鎮市長／鄉鎮市民代表／村里長／直轄市山地原住民區長／區民代表：補鄉鎮（村里長補村里）的自動缺口（2026-10-04）
--
-- 背景：這五種選舉的參選紀錄（LOCAL_ELECTION_TYPES，apply-contribution.ts）今天起落庫時會用
-- payload 的 sub_region（村里長再加 village）把 region_id 指到 regions（localRegionPatch）。
-- 之前交的、或交件沒填 sub_region 的那筆，region_id 就是空的——網站沒辦法把他放進正確的鄉鎮／村里頁。
-- 2026 registration 剛在 09-04 截止，這幾種選舉的候選人還在陸續由 roster_check 補進來
-- （20261004000003_roster_reps_and_village_chiefs.sql 剛加的那幾支清查臂），
-- 這支臂接住清查補進來、但漏填 sub_region 的那些，不必等下一輪清查才發現。
--
-- 派任務：不新增任務型別，直接沿用既有的 candidacy_source_missing——那個型別本來就是
-- 「這筆參選紀錄缺東西，請用 candidacy 型別重交同一人同一屆」，缺的東西寫在 what_we_need
-- 裡（這裡缺的是鄉鎮而不是來源網址），suggested_contribution_type／task-guidance／看板顏色
-- 都已經是現成的，不必再清點四處。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_township_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:candidacy_source_missing:' || pe.id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'party', p.party, 'region', p.region,
                            'election_id', pe.election_id, 'election_type', pe.election_type, 'candidate_status', pe.candidate_status),
         CASE WHEN pe.election_type = '村里長' THEN
           p.name || '（' || COALESCE(p.region, '') || ' ' || pe.election_id || ' 村里長候選人）的參選紀錄少了鄉鎮市區與村里，網站沒辦法把他放進正確的村里頁。'
             || '請查這個人的登記資料，確認他參選的鄉鎮市區與村里，用 candidacy 型別重交同一人同一屆：region 填「' || COALESCE(p.region, '')
             || '」、sub_region 填鄉鎮市區、village 填村里名，其餘欄位（political_party、candidate_status 等）照現有資料原樣帶，'
             || 'source_urls 附名冊或登記公告網址（中選會名冊系統會逐位核對、吻合的一票就過）。'
         ELSE
           p.name || '（' || COALESCE(p.region, '') || ' ' || pe.election_id || ' ' || pe.election_type || '候選人）的參選紀錄少了鄉鎮市區，網站沒辦法把他放進正確的鄉鎮頁。'
             || '請查這個人的登記資料，確認他參選的鄉鎮市區，用 candidacy 型別重交同一人同一屆：region 填「' || COALESCE(p.region, '')
             || '」、sub_region 填鄉鎮市區，其餘欄位照現有資料原樣帶，source_urls 附名冊或登記公告網址（中選會名冊系統會逐位核對、吻合的一票就過）。'
         END,
         ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表', COALESCE(p.region, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'],
         1, p.region
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  WHERE pe.election_id = 2026
    AND pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
    AND pe.region_id IS NULL
    AND pe.candidate_status NOT IN ('not_running')
    AND p.merged_into IS NULL
$$;
COMMENT ON FUNCTION contribution_auto_tasks_township_gap IS
  '鄉鎮市長／代表／村里長／原住民區長／區民代表：region_id 空的參選紀錄缺鄉鎮（村里長缺村里），2026-10-04 新增';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END,
         r.hint_sources, r.reward, r.region
    FROM contribution_auto_tasks_raw() r
   WHERE r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region)
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_villages()
  UNION ALL SELECT * FROM contribution_auto_tasks_township_gap()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。'
  '2026-10-03 名單清查依 roster_check_scope.regions 濾掉沒有這種選舉的縣市。'
  '2026-10-04 加村里長（鄉鎮市區層級）的清查臂；鄉鎮市長／代表類的清查說明補「要填 sub_region」。'
  '2026-10-04 加 township_gap：region_id 空的鄉鎮／村里層級參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing 型別。';
