-- 名單清查加入鄉鎮市民代表、原住民區民代表、村里長（2026-10-04，維護者：「代表、村里長也加進名單清查？加」）
--
-- 代表：跟鄉鎮市長同一套，一個縣市一筆任務（鄉鎮市民代表 13 縣、原住民區民代表 4 直轄市）。
-- 村里長：全台約一萬四千人，一個縣市一筆太大（新北一千多個里），改成「一個鄉鎮市區一筆」：
--   另寫一支臂 contribution_auto_tasks_roster_villages()，鄉鎮市區清單取自 electoral_district_areas（2022／2026 聯集）。
--   任務的 region 寫成「縣市＋鄉鎮市區」（例：新北市板橋區），roster_check 原樣帶回就記成那個鄉鎮已清查，
--   不必改 roster_checks 表或協議欄位。範圍表的村里長列 regions = '{}'，讓縣市層級那支臂不派。
-- 這幾種的 candidacy 要填 sub_region（鄉鎮市區）、村里長再填 village：落庫時參選紀錄會指到 regions
-- （apply-contribution.ts 的 localRegionPatch），arms() 在這幾種的清查任務說明後面補一句提醒。
-- 名單來源：中選會「115 年各類選舉候選人登記彙總表」（web.cec.gov.tw/api/file/*.pdf）——系統逐位核對的那一種，
-- 吻合的參選紀錄一票就過。

INSERT INTO roster_check_scope (election_id, election_type, recheck_days, list_announced_on, registration_closed_on, regions) VALUES
  (2026, '鄉鎮市民代表', 7, DATE '2026-11-17', DATE '2026-09-04',
   ARRAY['宜蘭縣', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '台東縣', '花蓮縣', '澎湖縣', '金門縣', '連江縣']),
  (2026, '直轄市山地原住民區民代表', 7, DATE '2026-11-17', DATE '2026-09-04',
   ARRAY['新北市', '桃園市', '台中市', '高雄市']),
  (2026, '村里長', 7, DATE '2026-11-17', DATE '2026-09-04', ARRAY[]::TEXT[])
ON CONFLICT (election_id, election_type) DO NOTHING;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_villages()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT * FROM roster_check_scope WHERE election_type = '村里長' AND enabled
  ),
  towns AS (
    SELECT DISTINCT replace(a.region, '臺', '台') AS county, a.township
    FROM electoral_district_areas a
    WHERE a.township IS NOT NULL AND btrim(a.township) <> ''
  ),
  ours AS (
    SELECT per.region AS county, per.sub_region AS township, COUNT(*) AS n
    FROM politician_elections pe
    JOIN regions per ON per.id = pe.region_id
    WHERE pe.election_id = 2026 AND pe.election_type::TEXT = '村里長'
    GROUP BY 1, 2
  )
  SELECT 'auto:roster_check:' || s.election_id || ':' || t.county || t.township || ':村里長',
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', t.county || t.township, 'county', t.county, 'township', t.township,
                            'election_type', '村里長', 'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked,
                            'last_failed_attempt', rc.last_attempt_without_count, 'list_announced_on', s.list_announced_on,
                            'official_list_published', CURRENT_DATE >= s.list_announced_on),
         t.county || t.township || ' ' || s.election_id || ' 村里長的名單需要清查。請找這個鄉鎮市區的村里長候選人登記名單'
           || '（中選會「115 年村里長選舉候選人登記彙總表」PDF，或' || t.county || '選舉委員會的登記公告），跟我們現有的 '
           || COALESCE(o.n, 0) || ' 筆比對。名單上有、我們沒有的，每位用 candidacy 型別補一筆：region 填「' || t.county
           || '」、sub_region 填「' || t.township || '」、village 填村里名、election_type 填村里長、candidate_status 填 registered，'
           || 'source_urls 附名冊網址（中選會 web.cec.gov.tw/api/file/…pdf 的名冊系統會逐位核對、吻合的一票就過）；一次最多 20 筆，可分多次交。'
           || '最後用 roster_check 回報：election_id、region、election_type 三欄照任務 target 原樣帶回（region 就是「' || t.county || t.township
           || '」這一串），cec_count 填這個鄉鎮市區名冊上的人數。查不到名冊就不要猜：roster_check 的 cec_count 留空、note 寫你查了哪些網址。',
         ARRAY['web.cec.gov.tw 115 年村里長選舉候選人登記彙總表', t.county || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'],
         2, t.county
  FROM s
  CROSS JOIN towns t
  LEFT JOIN ours o ON o.county = t.county AND o.township = t.township
  LEFT JOIN LATERAL (
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = t.county || t.township AND x.election_type = '村里長'
  ) rc ON TRUE
  WHERE (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_roster_villages IS
  '村里長名單清查：一個鄉鎮市區一筆任務（region＝縣市＋鄉鎮市區），清單取自 electoral_district_areas（2026-10-04）';

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
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。'
  '2026-10-03 名單清查依 roster_check_scope.regions 濾掉沒有這種選舉的縣市。'
  '2026-10-04 加村里長（鄉鎮市區層級）的清查臂；鄉鎮市長／代表類的清查說明補「要填 sub_region」。';
