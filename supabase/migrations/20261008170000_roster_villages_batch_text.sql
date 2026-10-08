-- 2026 村里長名單清查任務的說明：名冊批次一次交件上限 20 → 150（2026-10-08，維護者裁示 B 案；協議 1.78.0）
--
-- 只改 contribution_auto_tasks_roster_villages 說明文字裡的一句：「一次最多 20 筆，可分多次交。」→ 名冊逐位吻合的 candidacy 一次最多 150 筆。
-- 現行定義＝20261004000003（這支臂只定義過這一次）＋一處機械替換；task_id、target、hint_sources、reward、region、條件、其他臂與總表、seed 一字不動。
-- 守門：_shared/roster-batch-limit.test.ts（現行定義＋一處替換、PGlite 實跑新舊輸出逐件只差那一句、還原驗證）。
-- 已投票屆別的名單缺口臂（roster_cec_gap）的「一次最多 20 筆」不改：那種 candidacy 引用的是中選會選舉資料庫、不是登記名冊 PDF，
-- 不在 150 筆的範圍內（150 筆的條件是 source_urls 引用中選會登記名冊 PDF 而且逐位吻合）。

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
           || 'source_urls 附名冊網址（中選會 web.cec.gov.tw/api/file/…pdf 的名冊系統會逐位核對、吻合的一票就過）；一次最多 150 筆（整批都是 candidacy、source_urls 放這份名冊、每一筆都跟名冊逐位吻合才收；其他型別一次最多 20 筆），可分多次交。'
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
