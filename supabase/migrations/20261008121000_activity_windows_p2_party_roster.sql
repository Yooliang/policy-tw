-- 派工與排程的啟用時間窗，P2（一支臂一個 PR）：party_roster——還沒投票、已登記、缺政黨（2026-10-08，docs/PLAN-task-activation.md）
-- ============================================================
--
-- 這是第一支「有迄日」的臂：臂內條件 election_date >= CURRENT_DATE（投票日當天仍開、隔天關）翻成只有迄點的規則；
-- 有迄日就會有「窗口到點關」的收回，所以這支同時讓 seed 分得出收回的原因是 window（臂還算得出來、規則關了）還是 filled（臂已經算不出來）。
--
-- 一、party_roster（contribution_auto_tasks_party_roster，產出 candidacy_source_missing、target.kind＝party_roster）
--   臂內的日期條件：g CTE 的 JOIN elections e ON e.id = pe.election_id AND e.election_date >= CURRENT_DATE（「還沒投票的屆別」）。唯一一處。
--   candidacy_list_published(…, CURRENT_DATE) 是名單公告日（算 candidate_status 字眼用），不是「這支臂何時開」，不動。
--
-- 規則（把 P1 的「永遠開」種子原地改成窗口，rule_id 不變）：
--   * activity='party_roster'：window_kind='event'、from_kind＝NULL（沒有起點）、until_kind='polling'、until_offset=0、min_status='announced'；範圍不限。
--     只有迄點的形狀 P0 的 activity_rules_shape 允許（event 掛事件、起點與迄點至少一端），activity_open() 也處理（沒有起點＝一直開著、到迄日當天為止，含頭含尾；
--     起點為空時確定程度看迄點里程碑）。不需要另找表示法。
--       - 迄日：投票日 +0，即投票日當天仍開、隔天（+1）關。2026：11-28 開、11-29 關。
--       - 日界：規則用台北時間（activity_today()），原條件的 CURRENT_DATE 是資料庫 UTC 的日期，所以窗口比原本早 8 小時關（台北 11-29 00:00 關，原本是 08:00）；
--         party_gap（上一個 PR）從投票日 +1 起，兩條規則在台北日界下剛好銜接：同一天只有一邊開著，不重疊也不留縫。
--       - 屆別：不限定。每場選舉各自到自己的投票日為止，2028 不用再改。
--       - election_date 空的選舉沒有 polling 里程碑，迄點找不到＝關（原條件 NULL >= CURRENT_DATE 也不成立，行為相同）。
--       - opened_by：沒有起點里程碑，所以不帶 milestone_kind／milestone_on_date／expected_open_on（沒有「該開的日期」可對帳，gap_open_lateness 不列），
--         改帶 open_until（迄日）。缺口的出生仍由「這個人這一屆已登記而缺政黨」的資料決定。
--   * 臂本身現在也算投票日之後的屆別（2022、2024、重行選舉裡還停在 filed 而缺政黨的參選紀錄），輸出再由總表依規則濾掉，今天輸出不變。
--
-- 二、收回原因 window／filled（P1 計畫第 11 節「已知限制」記的、要等第一支有迄日的臂才做的事）
--   以前 seed 收回缺口一律記 filled（P0 沒有規則在過濾、P1 規則都是永遠開，收回只可能是缺口補上了）。現在窗口會到點關，要分：
--     * window：臂自己還算得出來這個缺口，只是規則的窗口關了（例：party_roster 過了投票日）；
--     * filled：臂已經算不出來（補上了，或臂自己的條件不成立）。
--   做法（沿用 P0 的交易內設定 gap.close_reason／gap.close_detail，由 task_dispatches 的 AFTER DELETE 觸發器寫進 closed 事件）：
--     1. contribution_auto_tasks_arms() 多一個交易內旗標 gap.arms_all：預設（沒設）行為與原本完全相同；設成 'on' 時多回傳「被規則濾掉的列」，
--        那些列的 opened_by 是 NULL（開著的列 opened_by 一定不是 NULL——一定有 basis），用這個分辨。實作上只是把 opened CTE 的 CROSS JOIN LATERAL 改成 LEFT JOIN LATERAL ... ON true、
--        opened_by 改成「有開窗才組」、最後加一個 WHERE（o.source IS NOT NULL 或旗標開著）。臂的簽名、回傳型別、28 個分支一字不動。
--        不另建「完整輸出」函式：總表的 UNION 清單只有一份（新增派工臂的三處登記照舊），也不需要把整串臂再算第二遍。
--     2. seed_auto_task_queue() 只算一次總表（旗標開著），存進暫存表 _gaps_all；_gaps（原本的開著的缺口）從它取 opened_by IS NOT NULL 的列，其餘一字不動。
--        收回前先多一段：不在 _gaps、但在 _gaps_all 的派工列＝臂還算得出來而窗口關了，設 gap.close_reason＝'window' 刪掉再清掉設定；
--        剩下的（臂已算不出來）走原本那一段 DELETE，不設原因，觸發器預設記 filled。
--   窗口關掉的缺口之後若又開（例如該人改回已登記、或別的規則接手），seed 照常 INSERT，觸發器記 reopened。
--   party_roster 收回之後若 party_gap 接手（中選會名冊對得到）：同一個 task_id 在 _gaps 裡，派工列不動、不產生 closed／reopened，只是 opened_by 以舊的為準（seed 不改既有列的出生紀錄）。
--
-- 三、機械替換（都照正式庫現行定義，2026-10-08 逐字比對過）
--   * contribution_auto_tasks_party_roster：本體＝20261006220000 的現行定義（與正式庫 pg_get_functiondef 一字不差），只把「JOIN elections e ON e.id = pe.election_id AND e.election_date >= CURRENT_DATE」
--     換成「JOIN elections e ON e.id = pe.election_id」加一行說明註解。同簽名（CREATE OR REPLACE）。
--   * contribution_auto_tasks_arms：本體＝20261008114000（測試名人物隔離 #448）的現行定義（與正式庫 pg_get_functiondef 一字不差），機械替換：opened CTE 多帶 open_until、LEFT JOIN LATERAL、opened_by 有開窗才組、WHERE 前面多一個「開著或旗標開著」的條件並把 #448 的測試名人物過濾整段包在外層 AND 裡（見上面「做法 1」與 open_until）；#448 的 ph／phe 兩個 MATERIALIZED CTE 與過濾邏輯一字不動，所以旗標開著時測試人物的任務一樣不出現（那是「臂不再算它」，收回記 filled，不是 window）。同簽名、同回傳型別（CREATE OR REPLACE，不用分兩次上）。
--   * seed_auto_task_queue：本體＝20261008090000（佇列優先層 #443）的現行定義（與正式庫 pg_get_functiondef 一字不差），兩處機械插入（見上面「做法 2」）；#443 加的優先層段落（_gaps 加 priority 欄、既有列換層、INSERT 帶 priority）一字不動。
--   呼叫 arms 的只有 seed_auto_task_queue() 與 task_boost_matches(jsonb)，呼叫 seed 的只有 pg_cron（seed-auto-task-queue-10min）與 task_boost()（2026-10-08 唯讀查正式庫 pg_proc／cron.job 確認，沒有 Edge Function 直接呼叫）；簽名都沒變。
--   觸發器 task_dispatches_gap_after_delete 不用動：它本來就讀 gap.close_reason，只是以前沒有人設 window。
--
-- 需要注意的連帶效果：
--   * 窗口關掉的那一刻（台北 11-29 00:00 後的下一輪 seed，≤10 分鐘），所有還沒補上的 2026 party_roster 派工列被收回、原因 window；
--     中選會名冊對得到的由 party_gap 接手（同 task_id，已在 _gaps 裡，不被收回）。
--   * 成本：總表多算一個 LEFT JOIN 與一個旗標判斷；seed 多一張暫存表與一次 EXISTS（只對「不在 _gaps 的既有派工列」）。實測見 PR 說明（正式庫 EXPLAIN ANALYZE，唯讀）。
--
-- 守門：supabase/functions/_shared/activity-party-roster.test.ts（文字層：臂＝前一版加一處替換、總表＝#448 版加機械替換、seed＝#443 版加兩處插入、這支只動這四樣；
--   PGlite：假時鐘 2026-11-28 開、11-29 關、與 party_gap 不重疊不留縫、seed 的 window／filled 判斷、opened_by 帶 open_until；每條守門做還原驗證）；
--   scripts/arms-parity-p2.ts party_roster：正式庫唯讀快照，新舊輸出筆數與全欄雜湊相等（不進 CI，PR 說明附結果）。
--   activity-arms.test.ts／activity-windows.test.ts 的 A1 尾端守門同步更新（總表：P1、#448 之後只允許這一支再定義；seed：P1、#443 之後只允許這一支再定義）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：P0／P1 的 activity_rules、activity_open、activity_require_rule、election_milestones_all、gap_events、task_dispatches 與其觸發器；
-- 臂本來就用的表與函式（candidacy_protocol_status、candidacy_list_published、verification_sources、contributions…）沒有新增引用。

-- ------------------------------------------------------------
-- 1. contribution_auto_tasks_party_roster：g CTE 拿掉日期比較（其餘一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_roster()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    -- candidate_status＝交件協議的詞（派工說明「照現況填」那一句用），由 candidacy_status 換算，不是舊欄位
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status,
           p.id AS politician_id, p.name, p.party AS person_party,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county, r.sub_region
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      -- 投票日當天之前才派：移到規則（activity_rules「party_roster」：到投票日 +0 為止，P2 20261008121000）；這裡不再比日期
      LEFT JOIN regions r ON r.id = pe.region_id
     -- 還沒投票的屆別、已登記（名冊上才有他）、我們不知道這一次的政黨
     WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'
  ),
  x AS (
    SELECT g.*,
           (SELECT array_agg(v.list_url ORDER BY v.sort, v.id) FROM verification_sources v
             WHERE v.kind = 'cec' AND v.status = 'ok' AND v.list_url IS NOT NULL AND 'roster' = ANY (v.provides)
               AND g.election_type = ANY (v.election_types) AND g.county = ANY (v.regions)) AS rosters
      FROM g
     -- 已經有人交了這一人這一屆的 candidacy 還在等票的先不派
     WHERE NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = g.politician_id::TEXT AND c.payload->>'election_id' = g.election_id::TEXT)
  )
  SELECT 'auto:candidacy_source_missing:party:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('kind', 'party_roster', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'missing', jsonb_build_array('party'), 'person_party', x.person_party,
                            'rosters', to_jsonb(x.rosters)),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，已登記）這一次參選的政黨我們不知道——'
           || '網站只看得到他現在登記的政黨（「' || COALESCE(x.person_party, '空的') || '」），參選紀錄要記的是這一次登記時的推薦政黨。'
           || '這一屆還沒投票，中選會選舉資料庫還沒有名單：請打開中選會候選人登記彙總表'
           || COALESCE('（' || array_to_string(x.rosters, '、') || '）', '（web.cec.gov.tw/central/article/64709）')
           || '找到他那一列，用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、name 填「' || x.name
           || '」、election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、region 填「' || COALESCE(x.county, '') || '」'
           || CASE WHEN x.election_type = '縣市議員' THEN '、electoral_district 填名冊上的選舉區' ELSE '' END
           || '、party 照那一列的「推薦之政黨」原字填（寫「無」就填「無」，不要填他現在的政黨）、candidate_status 照現況填「' || COALESCE(x.candidate_status, '') || '」；'
           || 'source_urls 第一個放那份登記彙總表：系統會逐位核對名冊上的姓名、縣市、政黨，吻合的一票就過。名冊上找不到他就用 no_change 回報，不要猜。',
         COALESCE(x.rosters, ARRAY[]::TEXT[]) || ARRAY['https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表'],
         1, x.county
    FROM x
$$;

-- ------------------------------------------------------------
-- 2. contribution_auto_tasks_arms：被規則濾掉的列在旗標 gap.arms_all 開著時也回傳（其餘一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),
       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）
       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),
       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),
       tagged AS (
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
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t
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
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       keyed AS (
  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid, NULLIF(g.target->>'election_type', '') AS etype FROM tagged g
       ),
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
         CASE WHEN o.source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
   WHERE (o.source IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
     AND (g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT)))
$$;

-- ------------------------------------------------------------
-- 3. seed_auto_task_queue：收回原因分 window／filled（其餘一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT * FROM contribution_auto_tasks_arms();
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;

  -- >>> 優先層：每個缺口現在在哪一層（每組「臂×選舉×職位」問一次）
  ALTER TABLE _gaps ADD COLUMN priority SMALLINT, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority = p.priority, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.priority, x.rule_id
            FROM (SELECT DISTINCT y.arm, election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL activity_priority(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先層

  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了（例：party_roster 過了投票日）→ 收回，原因記 window（交給觸發器寫進 closed 事件）
  PERFORM set_config('gap.close_reason', 'window', true);
  PERFORM set_config('gap.close_detail', '{"via":"seed_window"}', true);
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id;

  -- >>> 優先層：既有的派工列跟著規則換層（排隊時間不動；下一步的 rebalance 依新的層交錯）
  UPDATE task_dispatches d SET priority = g.priority
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority IS DISTINCT FROM g.priority;
  -- <<< 優先層

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id)), g.priority
    FROM _gaps g
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), contribution_queue_at(c.contribution_type, c.task_id, c.created_at), 0
    FROM contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 每 10 分鐘重排成 驗證：任務＝2:1（維護者 09-24：不要手動調）
  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM refresh_verify_targets();

  PERFORM rebalance_queue();

  RETURN v_new + v_verify;
END;
$$;

-- ------------------------------------------------------------
-- 4. 規則：把 P1 的「永遠開」種子原地改成「只有迄點：到投票日當天為止」（rule_id 不變；審計觸發器照寫 edit_history）
-- ------------------------------------------------------------
-- 沒有起點、迄日投票日 +0（含當天）、不限屆別與職位、min_status 用預設 announced（理由見檔頭）。可重跑：已經是這個形狀的規則再改一次不變
UPDATE activity_rules
   SET window_kind = 'event', from_kind = NULL, from_offset = 0, until_kind = 'polling', until_offset = 0, min_status = 'announced',
       recur_months = NULL, reasons = NULL, levels = NULL, election_types = NULL, jurisdictions = NULL, enabled = true,
       note = 'P2：到投票日當天為止（原臂內條件 e.election_date >= CURRENT_DATE，台北日界）；只有迄點、沒有起點；投票日 +1 起由 party_gap 接手；範圍不限、每場選舉各自到自己的投票日'
 WHERE activity = 'party_roster'
   AND (window_kind = 'always' OR (from_kind IS NULL AND until_kind = 'polling' AND until_offset = 0));

-- 沒改到、改到多條、或這個活動還有別條規則（OR 會讓窗口比預期寬）都不能上線
DO $$
BEGIN
  IF (SELECT count(*) FROM activity_rules r WHERE r.activity = 'party_roster') <> 1
     OR NOT EXISTS (SELECT 1 FROM activity_rules r
                     WHERE r.activity = 'party_roster' AND r.enabled AND r.window_kind = 'event' AND r.from_kind IS NULL AND r.until_kind = 'polling' AND r.until_offset = 0
                       AND r.reasons IS NULL AND r.levels IS NULL AND r.election_types IS NULL AND r.jurisdictions IS NULL) THEN
    RAISE EXCEPTION 'P2（party_roster）：party_roster 的規則不是預期的一條「到投票日當天為止」';
  END IF;
END
$$;

-- 函式備註補一句（只補一次：已經有標記就不再補）
DO $$
DECLARE v_old TEXT := obj_description('contribution_auto_tasks_party_roster()'::regprocedure, 'pg_proc');
BEGIN
  IF v_old IS NOT NULL AND v_old NOT LIKE '%P2 20261008121000%' THEN
    EXECUTE format('COMMENT ON FUNCTION contribution_auto_tasks_party_roster IS %L',
                   v_old || '｜2026-10-08（P2 20261008121000）：「還沒投票的屆別」改由規則 activity_rules「party_roster」（到投票日當天為止）決定，臂內不再比日期');
  END IF;
END
$$;

COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '全站自動缺口總表：28 個分支 UNION，每個分支貼臂名（arm），再依 activity_rules／activity_overrides 過濾（沒有開窗的規則＝濾掉）。'
  '測試名人物（politician_name_is_placeholder）的非 placeholder 任務不出現（#448）。'
  'opened_by＝開窗的規則＋里程碑＋迄日（seed 寫進 task_dispatches.opened_by）。seed_auto_task_queue() 每 10 分鐘算一次（約 4 秒）。'
  '交易內旗標 gap.arms_all＝on 時多回傳被規則濾掉的列（opened_by 是 NULL；開著的列一定不是 NULL），seed 用它分辨收回原因是 window 還是 filled；沒設旗標＝只回開著的列。2026-10-08（P2 20261008121000）';
