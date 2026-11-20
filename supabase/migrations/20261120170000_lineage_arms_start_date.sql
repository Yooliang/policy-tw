-- 脈絡「一件事的全貌」第二期 2b（policy-tw#675）：三支缺口臂（現況、立場、事件）共用起跑日，選後 2026-11-29 起自動開。
--
-- 維護者 11-20 裁示：既有三支臂（lineage_candidates／lineage_links／lineage_roles）開著不動——這支 migration 不碰它們的規則、函式，也不重算它們的輸出。
-- 起跑日機制（計畫書 0.1 決定 2、4.1）：
--   1. activity_rules.lineage_status（#872 上線時 enabled=false）改成 enabled=true；兩支新臂 lineage_stances、lineage_events 的規則一開始就種成 enabled=true（永遠開，沒有選舉窗口）。
--   2. 三支臂的函式各自讀 lineage_settings.dispatch_start_on（DATE，台北日），條件是 activity_today() >= dispatch_start_on（不用 now()，
--      假時鐘靠 SET app.activity_today 注入）；起跑日之前三支臂的輸出一律為空：總表沒有它們的列、seed 不寫 task_dispatches、gap_events 沒有紀錄。
--      整組新臂另有總開關 lineage_settings.enabled；各臂同時開著的上限 open_cap_per_arm 初值 20（三臂起跑日當天合計最多 60 件，之後隨任務完成補到 20）。
--   3. 現況臂 #872 的守門「規則必須停用」改成「起跑日前輸出必須為空」（見 lineage-status.test.ts）。
-- 兩支新臂的 task_id 末段是 8 碼指紋（立場＝這批該表態的人名單、事件＝原因加最近一筆事件日），登記進 task_rekey_arms()（換號沿用排隊位置）。
-- 總表 contribution_auto_tasks_arms() 與 activity_arm_names()：以 20261105200000 的現行定義為底，只多兩行 UNION、兩個名字，其餘一字不改。
-- 不新增任何貢獻型別（2a、20261120160000 已開）、不改計分、不碰 seed。
--
-- 回滾：UPDATE activity_rules SET enabled = false WHERE activity IN ('lineage_status', 'lineage_stances', 'lineage_events')（起跑日機制照舊，三臂立刻停派、seed 下一輪收回）；
--   要整個拿掉：把 contribution_auto_tasks_arms()／activity_arm_names()／contribution_auto_tasks_lineage_status()／task_rekey_arms() 用 20261105200000 與 20261019040000 的定義蓋回，
--   再 DROP FUNCTION contribution_auto_tasks_lineage_stances(), contribution_auto_tasks_lineage_events() 並刪兩條規則與 console_arm_stage_map 兩列。沒有任何新資料表或欄位。

-- ------------------------------------------------------------
-- 1. 現況臂：以 20261105200000 為底，加起跑日、總開關、同時開著的上限（其餘條件一字不改）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_status()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    -- >>> 起跑日（二期）：起跑日之前、或總開關關著，整支臂輸出為空
    SELECT st.status_stale_days_active AS d_active, st.status_stale_days_idle AS d_idle, st.gap_not_found_days AS d_nf, activity_today() AS today,
           st.open_cap_per_arm AS cap
      FROM lineage_settings st
     WHERE st.id = 1 AND st.enabled AND activity_today() >= st.dispatch_start_on
    -- <<< 起跑日
  ),
  cur AS (
    SELECT DISTINCT ON (x.lineage_id) x.lineage_id, x.id, x.phase, x.text, x.as_of, x.source_url
      FROM lineage_statuses x
     ORDER BY x.lineage_id, x.as_of DESC
  ),
  due AS (
    SELECT l.id AS lineage_id, l.title, l.summary, l.level, l.region, l.sub_region, l.category, l.created_at,
           c.phase, c.text AS cur_text, c.as_of AS cur_as_of, c.source_url AS cur_source_url, s.today, s.cap
      FROM lineages l
      CROSS JOIN s
      LEFT JOIN cur c ON c.lineage_id = l.id
     WHERE EXISTS (SELECT 1 FROM policies pl WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id))
       AND (c.lineage_id IS NULL
            OR (c.phase IN ('approved', 'in_progress') AND c.as_of < s.today - s.d_active)
            OR (c.phase IN ('proposed', 'planning', 'paused') AND c.as_of < s.today - s.d_idle))
       AND NOT EXISTS (
         SELECT 1 FROM contributions k
          WHERE k.contribution_type = 'lineage_status' AND k.status IN ('pending', 'verified', 'disputed', 'apply_failed')
            AND k.payload->>'lineage_id' = l.id::TEXT)
       AND NOT EXISTS (
         SELECT 1 FROM task_checks tc
          WHERE tc.task_id LIKE 'auto:lineage_status_stale:' || l.id::TEXT || ':%'
            AND tc.outcome = 'not_found'
            AND tc.checked_at > now() - make_interval(days => s.d_nf))
  ),
  -- >>> 同時開著的上限（二期）：已經在派工列的先留著，再依脈絡建立時間補到上限；上限空＝不設
  ranked AS (
    SELECT d.*, row_number() OVER (
             ORDER BY (EXISTS (SELECT 1 FROM task_dispatches td WHERE td.task_id = 'auto:lineage_status_stale:' || d.lineage_id::TEXT || ':' || COALESCE(d.cur_as_of::TEXT, 'none'))) DESC,
                      d.created_at, d.lineage_id) AS rn
      FROM due d
  )
  -- <<< 同時開著的上限
  SELECT 'auto:lineage_status_stale:' || d.lineage_id::TEXT || ':' || COALESCE(d.cur_as_of::TEXT, 'none'),
         'lineage_status_stale',
         jsonb_strip_nulls(jsonb_build_object(
           'lineage_id', d.lineage_id, 'lineage_title', d.title, 'summary', d.summary, 'level', d.level, 'region', d.region, 'sub_region', d.sub_region, 'category', d.category,
           'today', d.today,
           'reason', CASE WHEN d.cur_as_of IS NULL THEN 'none' ELSE 'stale' END,
           'current', CASE WHEN d.cur_as_of IS NULL THEN NULL
                           ELSE jsonb_build_object('phase', d.phase, 'text', d.cur_text, 'as_of', d.cur_as_of, 'source_url', d.cur_source_url) END)),
         CASE WHEN d.cur_as_of IS NULL
              THEN '脈絡「' || d.title || '」還沒有現況。'
              ELSE '脈絡「' || d.title || '」的現況（' || d.cur_text || '）截至 ' || d.cur_as_of::TEXT || '，已經過期。' END
           || '請找這件事**最新的公開文件**（政府公告、議會議事錄、預算書、新聞稿、可靠報導），寫一句現況：用 lineage_status 交一筆，'
           || 'phase 選階段（proposed 提案／planning 規劃中／approved 已核定／in_progress 進行中／completed 已完成／paused 暫緩／cancelled 已終止）、'
           || 'text 一句（8～120 字，只寫出處有的事實，不評價）、as_of 填**出處講到這個狀態的日期**（不是你查的日子）、source_locator 寫在出處哪裡。'
           || '現況沒變、但找得到近期有日期的文件證明仍如此，就用那份文件的日期交新的一筆；沒有新消息不等於新截至日。'
           || '什麼都查不到 → no_change，outcome=not_found，checked_urls 列你查過的網址。',
         ARRAY['政府公告與新聞稿（*.gov.tw）', '縣市議會議事錄與公報', '總預算書與計畫書', '可靠媒體報導'],
         1, COALESCE(d.region, '全國')
    FROM ranked d
   WHERE d.cap IS NULL OR d.rn <= d.cap
$$;
COMMENT ON FUNCTION contribution_auto_tasks_lineage_status IS
  '有合格政見的脈絡，沒有現況或現況過期（階段決定天數，lineage_settings）→ lineage_status_stale（交 lineage_status）。在途交件、not_found 冷卻內不派。二期起：activity_today() 到了 lineage_settings.dispatch_start_on（預設 2026-11-29）才有輸出、受 enabled 總開關與 open_cap_per_arm 上限約束（#675）';

-- ------------------------------------------------------------
-- 2. 立場缺口臂（計畫 4.4）：有合格政見的脈絡，該表態的人（首長、政見持有人、參與者）還沒有立場紀錄
-- ------------------------------------------------------------
-- 應有立場的人：①主辦地方的首長（縣市層級＝縣市長；鄉鎮層級＝鄉鎮市長／區長；任期迄日不早於這條脈絡最早合格政見那一屆的投票日，含前任）
--   ②合格政見的持有人 ③參與者；都要有已投票且當選的紀錄（表態日要落在當選任期內，沒有任期的人沒有可交的立場）。扣掉已有沒下架立場列的人，剩下 ≥1 人才派，名單上限 30 人。
-- 不派：在途的 lineage_stance 交件；同一條脈絡的立場任務 not_found 後 gap_not_found_days 天內（查 task_checks，task_id 前綴比對、不比指紋）。
-- task_id 末段＝名單雜湊 8 碼（x.fp）：名單變才換號（task_rekey_arms 登記，換號沿用排隊位置）。
CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_stances()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT st.gap_not_found_days AS d_nf, st.open_cap_per_arm AS cap, activity_today() AS today
      FROM lineage_settings st
     WHERE st.id = 1 AND st.enabled AND activity_today() >= st.dispatch_start_on
  ),
  q AS (
    -- 有合格政見的脈絡，與其中最早那一屆的投票日（首長任期重疊的下限）
    SELECT l.id AS lineage_id, l.title, l.summary, l.level, l.region, l.sub_region, l.category, l.created_at, MIN(e.election_date) AS since
      FROM lineages l
      JOIN policies pl ON pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)
      LEFT JOIN elections e ON e.id = pl.election_id
     GROUP BY l.id, l.title, l.summary, l.level, l.region, l.sub_region, l.category, l.created_at
  ),
  raw AS (
    SELECT q.lineage_id, COALESCE(p.merged_into, p.id) AS pid, 'head'::TEXT AS why
      FROM q
      JOIN politician_elections pe ON pe.candidacy_status = 'elected'
       AND ((q.level = 'county' AND pe.election_type = '縣市長')
         OR (q.level = 'township' AND pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長')))
      JOIN regions r ON r.id = pe.region_id
       AND replace(r.region, '臺', '台') = replace(q.region, '臺', '台')
       AND (q.level = 'county' OR r.sub_region IS NOT DISTINCT FROM q.sub_region)
      JOIN elections e ON e.id = pe.election_id
      JOIN politicians p ON p.id = pe.politician_id
     WHERE (election_term_end(pe.election_id, pe.election_type) IS NULL OR q.since IS NULL OR election_term_end(pe.election_id, pe.election_type) >= q.since)
    UNION ALL
    SELECT pl.lineage_id, COALESCE(p.merged_into, p.id), 'policy_holder'
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id
     WHERE pl.lineage_id IS NOT NULL AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)
    UNION ALL
    SELECT lp.lineage_id, COALESCE(p.merged_into, p.id), 'participant'
      FROM lineage_participants lp
      JOIN politicians p ON p.id = lp.politician_id
  ),
  who AS (
    SELECT r.lineage_id, r.pid, array_agg(DISTINCT r.why ORDER BY r.why) AS whys
      FROM raw r
      JOIN s ON true
     WHERE EXISTS (SELECT 1 FROM politician_elections pe2 JOIN elections e2 ON e2.id = pe2.election_id
                    WHERE pe2.politician_id = r.pid AND pe2.candidacy_status = 'elected' AND e2.election_date < s.today)
       AND NOT EXISTS (SELECT 1 FROM lineage_stances ls WHERE ls.lineage_id = r.lineage_id AND ls.politician_id = r.pid AND ls.removed_at IS NULL)
     GROUP BY r.lineage_id, r.pid
  ),
  numbered AS (
    SELECT w.*, row_number() OVER (PARTITION BY w.lineage_id ORDER BY w.pid) AS k FROM who w
  ),
  grp AS (
    SELECT n.lineage_id,
           substr(md5(string_agg(n.pid::TEXT, ',' ORDER BY n.pid)), 1, 8) AS fp,
           jsonb_agg(jsonb_build_object('politician_id', n.pid, 'name', p.name,
                                        'why', (SELECT jsonb_agg(CASE w WHEN 'head' THEN '首長' WHEN 'policy_holder' THEN '政見持有人' ELSE '參與者' END) FROM unnest(n.whys) AS u(w)))
                     ORDER BY n.pid) AS people,
           string_agg(p.name, '、' ORDER BY n.pid) AS names
      FROM numbered n
      JOIN politicians p ON p.id = n.pid
     WHERE n.k <= 30
     GROUP BY n.lineage_id
  ),
  due AS (
    SELECT q.*, g.fp, g.people, g.names, s.cap
      FROM grp g
      JOIN q ON q.lineage_id = g.lineage_id
      CROSS JOIN s
     WHERE NOT EXISTS (
         SELECT 1 FROM contributions k
          WHERE k.contribution_type = 'lineage_stance' AND k.status IN ('pending', 'verified', 'disputed', 'apply_failed')
            AND k.payload->>'lineage_id' = q.lineage_id::TEXT)
       AND NOT EXISTS (
         SELECT 1 FROM task_checks tc
          WHERE tc.task_id LIKE 'auto:lineage_stance_missing:' || q.lineage_id::TEXT || ':%'
            AND tc.outcome = 'not_found'
            AND tc.checked_at > now() - make_interval(days => s.d_nf))
  ),
  ranked AS (
    SELECT d.*, row_number() OVER (
             ORDER BY (EXISTS (SELECT 1 FROM task_dispatches td WHERE td.task_id = 'auto:lineage_stance_missing:' || d.lineage_id::TEXT || ':' || d.fp)) DESC,
                      d.created_at, d.lineage_id) AS rn
      FROM due d
  )
  SELECT 'auto:lineage_stance_missing:' || x.lineage_id::TEXT || ':' || x.fp,
         'lineage_stance_missing',
         jsonb_build_object('lineage_id', x.lineage_id, 'lineage_title', x.title, 'summary', x.summary, 'level', x.level, 'region', x.region,
                            'sub_region', x.sub_region, 'category', x.category, 'people', x.people),
         '脈絡「' || x.title || '」還沒有這些人對這件事的立場紀錄：' || x.names || '。'
           || '請到議會議事錄、質詢、記者會、施政報告、新聞稿找他們**當選上任之後**對這件事的公開表態——支持（support）、反對（oppose）或有條件（conditional，要寫條件）。'
           || '用 lineage_stance 交：每個人每次表態一項，stated_on 填表態那天（不是報導日），quote 填出處裡**一字不差**的原文（8～300 字），source_locator 寫在出處哪裡；一筆最多 10 項，沒把握的先不要放。'
           || '選前的競選主張是承諾、不是立場，日期在他上任之前的不收（會被擋回）。不限 target.people，同一件事其他人的表態也可以一起交（要是網站上已有的人物）。'
           || '查不到任何公開表態 → no_change，outcome=not_found，checked_urls 列你查過的網址。',
         ARRAY['縣市議會議事錄與質詢紀錄（*.gov.tw）', '立法院議事暨公報資訊網（ppg.ly.gov.tw）', '政府新聞稿與施政報告（*.gov.tw）', '可靠媒體報導'],
         1, COALESCE(x.region, '全國')
    FROM ranked x
   WHERE x.cap IS NULL OR x.rn <= x.cap
$$;
COMMENT ON FUNCTION contribution_auto_tasks_lineage_stances IS
  '有合格政見的脈絡，首長、政見持有人、參與者裡還沒有立場紀錄的人（≥1 人，上限 30）→ lineage_stance_missing（交 lineage_stance）。activity_today() 到了 lineage_settings.dispatch_start_on 才有輸出；在途交件、not_found 冷卻內不派（#675 第二期）';

-- ------------------------------------------------------------
-- 3. 事件缺口臂（計畫 4.4）：有合格政見的脈絡，①完全沒有事件，或 ②現況階段是 planning／approved／in_progress／paused 而最近一筆事件超過 event_recheck_days
-- ------------------------------------------------------------
-- 不派：階段已是 completed／cancelled 且至少有一筆事件；在途的 lineage_event 交件；not_found 後 gap_not_found_days 天內。
-- task_id 末段＝原因與最近一筆事件日的雜湊 8 碼（x.fp）：有新事件落庫才換號。
CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_events()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT st.event_recheck_days AS d_re, st.gap_not_found_days AS d_nf, st.open_cap_per_arm AS cap, activity_today() AS today
      FROM lineage_settings st
     WHERE st.id = 1 AND st.enabled AND activity_today() >= st.dispatch_start_on
  ),
  cur AS (
    SELECT DISTINCT ON (x.lineage_id) x.lineage_id, x.phase, x.text, x.as_of
      FROM lineage_statuses x
     ORDER BY x.lineage_id, x.as_of DESC
  ),
  ev AS (
    SELECT e.lineage_id, MAX(e.occurred_on) AS last_on, COUNT(*) AS n
      FROM lineage_events e
     WHERE e.removed_at IS NULL
     GROUP BY e.lineage_id
  ),
  due AS (
    SELECT l.id AS lineage_id, l.title, l.summary, l.level, l.region, l.sub_region, l.category, l.created_at,
           c.phase, c.text AS cur_text, c.as_of AS cur_as_of, v.last_on, COALESCE(v.n, 0) AS n_events, s.today, s.cap,
           CASE WHEN v.lineage_id IS NULL THEN 'none' ELSE 'stale' END AS reason
      FROM lineages l
      CROSS JOIN s
      LEFT JOIN cur c ON c.lineage_id = l.id
      LEFT JOIN ev v ON v.lineage_id = l.id
     WHERE EXISTS (SELECT 1 FROM policies pl WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id))
       AND (v.lineage_id IS NULL
            OR (c.phase IN ('planning', 'approved', 'in_progress', 'paused') AND v.last_on < s.today - s.d_re))
       AND NOT EXISTS (
         SELECT 1 FROM contributions k
          WHERE k.contribution_type = 'lineage_event' AND k.status IN ('pending', 'verified', 'disputed', 'apply_failed')
            AND k.payload->>'lineage_id' = l.id::TEXT)
       AND NOT EXISTS (
         SELECT 1 FROM task_checks tc
          WHERE tc.task_id LIKE 'auto:lineage_event_missing:' || l.id::TEXT || ':%'
            AND tc.outcome = 'not_found'
            AND tc.checked_at > now() - make_interval(days => s.d_nf))
  ),
  fp AS (
    SELECT d.*, substr(md5(d.reason || ':' || COALESCE(d.last_on::TEXT, '')), 1, 8) AS fp FROM due d
  ),
  ranked AS (
    SELECT f.*, row_number() OVER (
             ORDER BY (EXISTS (SELECT 1 FROM task_dispatches td WHERE td.task_id = 'auto:lineage_event_missing:' || f.lineage_id::TEXT || ':' || f.fp)) DESC,
                      f.created_at, f.lineage_id) AS rn
      FROM fp f
  )
  SELECT 'auto:lineage_event_missing:' || x.lineage_id::TEXT || ':' || x.fp,
         'lineage_event_missing',
         jsonb_strip_nulls(jsonb_build_object(
           'lineage_id', x.lineage_id, 'lineage_title', x.title, 'summary', x.summary, 'level', x.level, 'region', x.region,
           'sub_region', x.sub_region, 'category', x.category, 'today', x.today, 'reason', x.reason,
           'current_status', CASE WHEN x.cur_as_of IS NULL THEN NULL
                                  ELSE jsonb_build_object('phase', x.phase, 'text', x.cur_text, 'as_of', x.cur_as_of) END,
           'last_event_on', x.last_on, 'events_count', x.n_events)),
         CASE WHEN x.reason = 'none'
              THEN '脈絡「' || x.title || '」還沒有任何事件紀錄。'
              ELSE '脈絡「' || x.title || '」最近一筆事件是 ' || x.last_on::TEXT || '，之後可能又有新的決定。' END
           || '請找這件事政府或議會**已經做成的決定**：拍板（decided）、核定（approved）、編列預算（budget_added）、預算刪減（budget_cut）、動工或開辦（started）、完工或上路（completed）、暫緩（paused）、喊卡或終止（cancelled）、重啟（resumed）；提案、規劃、受訪表示不算。'
           || '用 lineage_event 交：每個決定一項，occurred_on 填決定當天（不是報導日），level／region／sub_region 填做決定的那一級與地方，decided_by 填機關名，description 只寫發生了什麼（10～300 字，不評價），source_locator 寫在出處哪裡；'
           || '知道是誰提案或爭取的，填 initiator_politician_id（網站上已有的人物）。同一天同一機關同一種型態的多項決定合併成一項、description 分點寫；一筆最多 10 項。'
           || '日期必須落在這件事涉及的人的當選任期內，選前的不收。查不到 → no_change，outcome=not_found，checked_urls 列你查過的網址。',
         ARRAY['縣市議會議事錄與公報（*.gov.tw）', '政府公告與新聞稿（*.gov.tw）', '總預算書與計畫書', '可靠媒體報導'],
         1, COALESCE(x.region, '全國')
    FROM ranked x
   WHERE x.cap IS NULL OR x.rn <= x.cap
$$;
COMMENT ON FUNCTION contribution_auto_tasks_lineage_events IS
  '有合格政見的脈絡，完全沒有事件、或進行中卻太久沒有新事件（event_recheck_days）→ lineage_event_missing（交 lineage_event）。activity_today() 到了 lineage_settings.dispatch_start_on 才有輸出；在途交件、not_found 冷卻內不派（#675 第二期）';

-- ------------------------------------------------------------
-- 4. 臂名清單與總表：以 20261105200000 的現行定義為底，只多兩個名字、兩行 UNION
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'raw:policy_missing',
    'raw:profile_gap',
    'raw:policy_validity',
    'raw:progress_stale',
    'raw:candidacy_source_missing',
    'raw:roster_check',
    'raw:policy_election_missing',
    'raw:candidate_status_stale',
    'dup',
    'legacy',
    'mismatch',
    'policy_dup',
    'not_running',
    'mayor_policies',
    'term_policies',
    'roster_villages',
    'township_gap',
    'region_gap',
    'elected_missing',
    'roster_cec_gap',
    'district_seats',
    'policy_elements',
    'deadline_due',
    'lineage_candidates',
    'handover_missing',
    'lineage_roles',
    'lineage_links',
    'career_sources',
    'withdrawn_filing',
    'party_gap',
    'party_roster',
    'party_info',
    'placeholder_politicians',
    'election_results',
    'owner_mismatch',
    'ballot_numbers',
    'manual_visitor',
    'manual_open',
    'regional_stats_missing',
    'traffic:progress_stale',
    'traffic:deadline_due',
    'traffic:term_policies',
    'issue_too_broad',
    'lineage_status',
    'lineage_stances',
    'lineage_events'
  ]::TEXT[]
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE SET work_mem = '16MB' AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),
       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）
       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),
       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),
       -- >>> 名單清查收斂：名冊類差異按單位彙總（開關關著就不算）；原臂在開關開著時停用，單位清查掛 items（見 20261101020000）
       fnd AS MATERIALIZED (SELECT * FROM roster_unit_findings() WHERE roster_unify_on()),
       -- <<< 名單清查收斂
       tagged0 AS (
  SELECT 'raw:' || r.task_type AS arm, r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END AS what_we_need,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
  UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t
  UNION ALL SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM contribution_auto_tasks_mismatch() t
  UNION ALL SELECT 'policy_dup' AS arm, t.* FROM contribution_auto_tasks_policy_dup() t
  UNION ALL SELECT 'not_running' AS arm, t.* FROM contribution_auto_tasks_not_running() t
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t
  UNION ALL SELECT 'roster_villages' AS arm, t.* FROM contribution_auto_tasks_roster_villages() t
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'roster_cec_gap' AS arm, t.* FROM contribution_auto_tasks_roster_cec_gap() t
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM contribution_auto_tasks_district_seats() t
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM contribution_auto_tasks_policy_elements() t
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM contribution_auto_tasks_lineage_candidates() t
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM contribution_auto_tasks_handover_missing() t
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM contribution_auto_tasks_lineage_roles() t
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM contribution_auto_tasks_lineage_links() t
  UNION ALL SELECT 'career_sources' AS arm, t.* FROM contribution_auto_tasks_career_sources() t
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM contribution_auto_tasks_withdrawn_filing() t
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t
  UNION ALL SELECT 'issue_too_broad' AS arm, t.* FROM contribution_auto_tasks_issue_too_broad() t
  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t
  UNION ALL SELECT 'lineage_stances' AS arm, t.* FROM contribution_auto_tasks_lineage_stances() t
  UNION ALL SELECT 'lineage_events' AS arm, t.* FROM contribution_auto_tasks_lineage_events() t
       ),
       -- >>> 名單清查收斂：單位已經有 roster_check（raw、roster_villages、roster_cec_gap）就掛 items；沒有、但有差異的單位開一張（findings_only）
       tagged AS (
  SELECT t0.arm, t0.task_id, t0.task_type, t0.target || COALESCE(x.extra, '{}'::JSONB) AS target,
         CASE WHEN x.extra IS NULL THEN t0.what_we_need
              ELSE t0.what_we_need || ' ' || roster_unify_text((x.extra->>'items_count')::INTEGER, COALESCE(f.voted, t0.target->>'list_source' = 'cec', false)) END AS what_we_need,
         t0.hint_sources, t0.reward, t0.region
    FROM tagged0 t0
    LEFT JOIN fnd f ON t0.task_type = 'roster_check' AND f.task_id = t0.task_id
    CROSS JOIN LATERAL (SELECT CASE WHEN t0.task_type = 'roster_check' AND roster_unify_on() THEN roster_unify_attach(t0.target, f.items, f.items_count, f.kinds) END AS extra) x
  UNION ALL
  SELECT f.arm, f.task_id, 'roster_check', f.target, f.what_we_need, f.hint_sources, 2, f.county
    FROM fnd f
   WHERE NOT EXISTS (SELECT 1 FROM tagged0 t0 WHERE t0.task_id = f.task_id)
       ),
       -- <<< 名單清查收斂
       -- >>> 名單缺口只派有缺口的單位（20261103010000，policy-ops#180）：2026 的 roster_check 列，單位有缺口 → 缺口 items 併進 target.items；
       --     單位沒有 roster_check 列但有缺口 → 開一列；官方名冊鏡像新鮮、卻無缺口也無別種差異 → 不派（收回）。開關同 roster_unify_on()
       gapu AS MATERIALIZED (SELECT * FROM roster_gap_units() WHERE roster_unify_on()),
       gapfresh AS MATERIALIZED (SELECT x.tid FROM roster_gap_fresh_units() AS x(tid) WHERE roster_unify_on()),
       tagged_g AS (
  SELECT t.arm, t.task_id, t.task_type,
         CASE WHEN gu.task_id IS NULL THEN t.target ELSE t.target || roster_gap_attach(t.target, gu.items, gu.items_count, gu.kinds) END AS target,
         CASE WHEN gu.task_id IS NULL THEN t.what_we_need ELSE t.what_we_need || ' ' || roster_gap_text() END AS what_we_need,
         t.hint_sources, t.reward, t.region
    FROM tagged t
    LEFT JOIN gapu gu ON t.task_type = 'roster_check' AND gu.task_id = roster_gap_tid(t.task_id)
   WHERE NOT (t.task_type = 'roster_check' AND t.task_id LIKE 'auto:roster_check:2026:%' AND gu.task_id IS NULL
              AND roster_gap_tid(t.task_id) IN (SELECT f.tid FROM gapfresh f)
              AND (COALESCE(t.target->'items_kinds', '{}'::JSONB) - '缺人' - '缺號次') = '{}'::JSONB)
  UNION ALL
  SELECT gu.arm, gu.task_id, 'roster_check', gu.target, gu.what_we_need, gu.hint_sources, 2, gu.county
    FROM gapu gu
   WHERE NOT EXISTS (SELECT 1 FROM tagged t WHERE t.task_type = 'roster_check' AND roster_gap_tid(t.task_id) = gu.task_id)
       ),
       -- <<< 名單缺口
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       -- >>> 村里長進度：target 沒有職位的臂（進度追蹤的 progress_stale、deadline_due），若這支臂有規則要看職位（except_election_types 排除清單或 election_types 正向清單，任何一種），職位從人物在那一屆的參選紀錄補；其餘臂的分組一個字不變
       -- 兩種都要看：只看排除清單的話，排除規則一被停用，職位全是 NULL，「村里長、要流量」那條正向規則就永遠比對不到、缺口被無聲收回（agy 審查 #480）
       needs_etype AS MATERIALIZED (SELECT DISTINCT r.activity FROM activity_rules r WHERE r.enabled AND (r.except_election_types IS NOT NULL OR r.election_types IS NOT NULL)
                                    -- >>> 有人看才追：來源臂一律補職位（要照職位決定歸不歸流量臂）
                                    UNION SELECT s.arm FROM unnest(traffic_watch_source_arms()) AS s(arm)
                                    -- <<< 有人看才追
                                   ),
       -- <<< 村里長進度
       keyed0 AS (
  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid,
         COALESCE(NULLIF(g.target->>'election_type', ''),
                  CASE WHEN g.arm IN (SELECT n.activity FROM needs_etype n)
                       THEN (SELECT pe.election_type FROM politician_elections pe
                              WHERE pe.politician_id = uuid_or_null(g.target->>'politician_id') AND pe.election_id = election_id_or_null(g.target->>'election_id')
                              ORDER BY pe.id LIMIT 1) END) AS etype
    FROM tagged_g g
       ),
       -- >>> 有人看才追：來源臂裡、職位在 traffic_watch_levels 開著的列，改歸流量臂 traffic:<型別>（task_id、內容一個字不變，只換臂名）；其餘照舊
       traffic_levels AS MATERIALIZED (SELECT l.election_type FROM traffic_watch_levels l WHERE l.enabled),
       keyed AS (
  SELECT CASE WHEN k.arm = ANY (traffic_watch_source_arms()) AND k.etype IN (SELECT t.election_type FROM traffic_levels t)
              THEN traffic_watch_arm(k.arm) ELSE k.arm END AS arm,
         k.task_id, k.task_type, k.target, k.what_we_need, k.hint_sources, k.reward, k.region, k.eid, k.etype
    FROM keyed0 k
       ),
       -- <<< 有人看才追
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE activity_require_rule(x.arm) OFFSET 0) k  -- 每組（約 84 組）檢查一次；OFFSET 0 擋住檢查被推到 7 千多列上去
    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們
      SELECT * FROM activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o ON true
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         CASE WHEN w.ok THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until,
           'traffic_gate', CASE WHEN g.arm LIKE 'traffic:%' THEN true END)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
    -- >>> 流量開窗：窗口有開（o.source），而且是流量臂（traffic:）時，這一列的人物頁或政見頁要在 page_traffic_hot；沒開的列照舊（旗標 gap.arms_all 開著時留下，opened_by 是 NULL）
    CROSS JOIN LATERAL (SELECT o.source IS NOT NULL AND (g.arm NOT LIKE 'traffic:%' OR EXISTS (
           SELECT 1 FROM page_traffic_hot h
            WHERE (h.kind = 'politician' AND h.target_id = g.target->>'politician_id') OR (h.kind = 'policy' AND h.target_id = g.target->>'policy_id'))) AS ok) w
    -- <<< 流量開窗
   WHERE (w.ok OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
     AND (g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT)))
$$;

-- ------------------------------------------------------------
-- 5. 換號沿用排隊位置：以 20261019040000 的現行清單為底，加兩支帶指紋的新臂（task_work_key_fp_arms 讀它，工作卡鍵自動去掉指紋）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_rekey_arms() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['lineage_candidate', 'lineage_link_candidate', 'duplicate_policy', 'lineage_stance_missing', 'lineage_event_missing']::TEXT[] $$;
COMMENT ON FUNCTION task_rekey_arms IS '帶清單指紋的派工臂（task_id＝auto:<臂>:<鍵>:<指紋>）：換號時新列沿用舊列的排隊位置（task_rekey_stable_key）。清單只有這一處。2026-10-19；2026-11-20 加 lineage_stance_missing、lineage_event_missing';

-- ------------------------------------------------------------
-- 6. 規則與主控台階段：現況臂改啟用（起跑日前輸出仍為空）；兩支新臂一開始就種成啟用（永遠開，沒有選舉窗口）
-- ------------------------------------------------------------
UPDATE activity_rules SET enabled = true,
       note = '政策脈絡現況過期／缺現況（policy-ops#201 第 2 期，計畫 4.4）。2026-11-20 起啟用（#675 第二期）：輸出由 lineage_settings.dispatch_start_on（起跑日）決定，起跑日前臂函式回空'
 WHERE activity = 'lineage_status';

INSERT INTO activity_rules (activity, window_kind, enabled, params, note)
SELECT 'lineage_stances', 'always', true, '{}'::JSONB,
       '政策脈絡立場缺口（#675 第二期，計畫 4.4）。規則永遠開，輸出由 lineage_settings.dispatch_start_on（起跑日）決定'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'lineage_stances');
INSERT INTO activity_rules (activity, window_kind, enabled, params, note)
SELECT 'lineage_events', 'always', true, '{}'::JSONB,
       '政策脈絡事件缺口（#675 第二期，計畫 4.4）。規則永遠開，輸出由 lineage_settings.dispatch_start_on（起跑日）決定'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'lineage_events');

INSERT INTO console_arm_stage_map (arm, stage, note) VALUES
  ('lineage_stances', 6, '政策脈絡'),
  ('lineage_events', 6, '政策脈絡')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 7. 參數：三臂各自同時開著的上限初值 20（計畫 2.7；起跑日當天三臂合計最多 60 件）
-- ------------------------------------------------------------
UPDATE lineage_settings SET open_cap_per_arm = 20,
       note = COALESCE(note, '') || CASE WHEN COALESCE(note, '') = '' THEN '' ELSE '；' END || '2026-11-20（#675 第二期）：open_cap_per_arm 初值 20，三支缺口臂各自同時開著的上限'
 WHERE id = 1 AND open_cap_per_arm IS NULL;

-- ------------------------------------------------------------
-- 8. 自我檢查：臂名、總表、規則都接上；規則是啟用的；既有三支臂的規則一條沒少
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT ('lineage_stances' = ANY (activity_arm_names())) OR NOT ('lineage_events' = ANY (activity_arm_names())) THEN
    RAISE EXCEPTION '臂名清單漏了 lineage_stances／lineage_events';
  END IF;
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'contribution_auto_tasks_lineage_stances()') = 0
     OR strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'contribution_auto_tasks_lineage_events()') = 0 THEN
    RAISE EXCEPTION '總表沒有接上立場／事件臂';
  END IF;
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'roster_gap_units()') = 0 THEN
    RAISE EXCEPTION '總表漏了名單缺口的段落（抄底錯版）';
  END IF;
  IF (SELECT count(*) FROM activity_rules r WHERE r.activity IN ('lineage_status', 'lineage_stances', 'lineage_events') AND r.enabled) <> 3 THEN
    RAISE EXCEPTION '三支缺口臂的規則都要是啟用的（輸出由起跑日決定）';
  END IF;
  IF (SELECT count(*) FROM activity_rules r WHERE r.activity IN ('lineage_candidates', 'lineage_links', 'lineage_roles')) <> 3 THEN
    RAISE EXCEPTION '既有三支脈絡臂的規則要原樣還在';
  END IF;
  -- 起跑日前三支臂的輸出必須是空的（現在的「今天」如果已經過了起跑日就略過這一條）
  IF activity_today() < (SELECT dispatch_start_on FROM lineage_settings WHERE id = 1) THEN
    IF EXISTS (SELECT 1 FROM contribution_auto_tasks_arms() WHERE arm IN ('lineage_status', 'lineage_stances', 'lineage_events')) THEN
      RAISE EXCEPTION '起跑日前，三支缺口臂的輸出必須為空';
    END IF;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
