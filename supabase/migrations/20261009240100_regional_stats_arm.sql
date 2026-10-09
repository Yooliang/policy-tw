-- 地方基本統計（#508）新派工臂 regional_stats_missing：縣市與鄉鎮市區缺最新年度統計的，派任務找官方資料補
-- ============================================================
--
-- 前提：20261009240000_regional_stats.sql（表、單位對照、出處同步）。
-- 做法照「讓資料自己說話」＋「資料走流程」：程式不產生數字，只找缺口、派任務，代理附官方出處交件，同儕驗證後落庫。
--
-- 一個地區（縣市或鄉鎮市區，admin_divisions 的 county／town 代碼）一件任務，列出缺哪幾個 stat_key（跟日本站
-- regional_stats_missing 同一個「一個團體一件、列出缺項」做法，20261009210100_policy_jp_gap_arms.sql）。
-- min_year：每個 stat_key 最舊可接受的年份——新的年度資料進來就自動滿足，要求更新的年度改 activity_rules.params 一行
-- （不改函式）。已經有人交了、還在等票的「地區×指標」先不派（queued CTE，同 district_seats／party_info 等既有臂的慣例；
-- 排除的粒度是 admin_code＋stat_key，不是整個地區——一個指標在等票不該連帶擋住同一地區另外三個指標的派工）。
--
-- 參數讀取不卡 activity_rules.enabled：這支函式只負責「列出缺口」，開不開派（規則停用、窗口沒開）完全交給
-- 外層 contribution_auto_tasks_arms() 的 activity_open() 判斷；min_year 用 COALESCE 的純量子查詢取現有規則列（不論
-- enabled），查不到任何列（migration 的種子不該發生，但防呆）才退回預設值，確保規則被停用時臂仍然回得出候選列，
-- 讓 gap.arms_all 的 window／filled 區分（見 CLAUDE.md「新增一支派工臂要三處一起加」那段）照常動作，不會被臂自己
-- 內部的過濾搶先關掉而誤記成 filled。
--
-- 新增一支派工臂的三處（CLAUDE.md）：總表加 UNION 分支、activity_arm_names() 加名字、activity_rules 種規則——都在這支。
-- 總表與臂名清單是 20261009010000 的版本加一行／一個名字（其餘一字不改；守門測試對照比對）。
--
-- 臂沒有選舉（target 沒有 election_id）＝預設優先層，跟 party_info、manual_open 等既有臂一樣；不用額外配置。

-- ------------------------------------------------------------
-- 1. 派工臂：regional_stats_missing
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_regional_stats_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH p AS (
    SELECT COALESCE(
      (SELECT r.params -> 'min_year' FROM activity_rules r WHERE r.activity = 'regional_stats_missing' ORDER BY r.id LIMIT 1),
      '{"population":2024,"area_km2":2020,"budget_expenditure":2023,"aging_rate":2024}'::JSONB
    ) AS min_year
  ),
  want AS (
    SELECT k.key AS stat_key, k.value::INTEGER AS min_year FROM p, jsonb_each_text(p.min_year) AS k(key, value)
  ),
  -- 已經有人交了這個地區這個指標的 regional_stat、還在等票的先不派這一項（粒度是 admin_code＋stat_key：
  -- 一個指標在等票，不該連帶擋住同一地區另外三個指標的派工）
  queued AS (
    SELECT DISTINCT c.payload ->> 'admin_code' AS admin_code, c.payload ->> 'stat_key' AS stat_key
      FROM contributions c WHERE c.contribution_type = 'regional_stat' AND c.status IN ('pending', 'verified')
  ),
  cand AS (
    SELECT a.code AS admin_code, a.level, a.county, a.town,
           (SELECT jsonb_agg(jsonb_build_object('stat_key', w.stat_key, 'min_year', w.min_year, 'unit', regional_stat_unit(w.stat_key)) ORDER BY w.stat_key)
              FROM want w
             WHERE NOT EXISTS (SELECT 1 FROM regional_stats s WHERE s.admin_code = a.code AND s.stat_key = w.stat_key AND s.year >= w.min_year)
               AND NOT EXISTS (SELECT 1 FROM queued q WHERE q.admin_code = a.code AND q.stat_key = w.stat_key)) AS missing
      FROM admin_divisions a
     WHERE a.level IN ('county', 'town')
  ),
  gaps AS (
    SELECT c.* FROM cand c WHERE c.missing IS NOT NULL
  )
  SELECT 'auto:regional_stat_missing:' || g.admin_code, 'regional_stat_missing',
         jsonb_build_object('admin_code', g.admin_code, 'level', g.level, 'region', replace(g.county, '臺', '台'),
                            'sub_region', CASE WHEN g.level = 'town' THEN replace(g.town, '臺', '台') END, 'missing', g.missing),
         replace(g.county, '臺', '台') || COALESCE(CASE WHEN g.level = 'town' THEN replace(g.town, '臺', '台') END, '') || ' 缺以下地方統計：'
           || (SELECT string_agg(regional_stat_label(m ->> 'stat_key') || '＝' || (m ->> 'min_year') || ' 年以後的最新值（stat_key=' || (m ->> 'stat_key') || '、單位：' || (m ->> 'unit') || '）', '、' ORDER BY m ->> 'stat_key')
                 FROM jsonb_array_elements(g.missing) m)
           || '。請查內政部戶政司人口統計、內政部國土測繪中心、該縣市主計處總預算書等官方資料，一個數值交一筆 regional_stat'
           || '（payload：admin_code 填「' || g.admin_code || '」、stat_key、year（統計年度，歲出填會計年度）、value、unit、as_of 選填）。'
           || '查不到確切數字就不要推估，用 no_change 說明查了哪些網址。',
         ARRAY['內政部戶政司人口統計（https://www.ris.gov.tw/）', '內政部國土測繪中心 全國土地面積統計', '該縣市政府主計處總預算書', '內政部 65 歲以上人口統計'],
         1, replace(g.county, '臺', '台')
    FROM gaps g
$$;
COMMENT ON FUNCTION contribution_auto_tasks_regional_stats_missing IS
  '縣市與鄉鎮市區缺最新年度地方統計（人口・面積・總預算歲出・65歲以上比例）→ regional_stat_missing 任務，一個地區一件、列出缺哪幾項（#508）。min_year 由 activity_rules.params 設定';

-- ------------------------------------------------------------
-- 2. 臂名清單與總表：20261009010000 的版本加一個名字／一行 UNION（其餘一字不改）
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
    'raw:election_result_missing',
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
    'regional_stats_missing'
  ]::TEXT[]
$$;

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
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       -- >>> 村里長進度：target 沒有職位的臂（進度追蹤的 progress_stale、deadline_due），若這支臂有規則要看職位（except_election_types 排除清單或 election_types 正向清單，任何一種），職位從人物在那一屆的參選紀錄補；其餘臂的分組一個字不變
       -- 兩種都要看：只看排除清單的話，排除規則一被停用，職位全是 NULL，「村里長、要流量」那條正向規則就永遠比對不到、缺口被無聲收回（agy 審查 #480）
       needs_etype AS MATERIALIZED (SELECT DISTINCT r.activity FROM activity_rules r WHERE r.enabled AND (r.except_election_types IS NOT NULL OR r.election_types IS NOT NULL)),
       -- <<< 村里長進度
       keyed AS (
  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid,
         COALESCE(NULLIF(g.target->>'election_type', ''),
                  CASE WHEN g.arm IN (SELECT n.activity FROM needs_etype n)
                       THEN (SELECT pe.election_type FROM politician_elections pe
                              WHERE pe.politician_id = uuid_or_null(g.target->>'politician_id') AND pe.election_id = election_id_or_null(g.target->>'election_id')
                              ORDER BY pe.id LIMIT 1) END) AS etype
    FROM tagged g
       ),
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until,
         COALESCE((SELECT r.requires_traffic FROM activity_rules r WHERE r.id = o.rule_id), false) AS requires_traffic  -- 這條規則要不要「該列的人物頁或政見頁在 page_traffic_hot」才算開
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
           'traffic_gate', CASE WHEN o.requires_traffic THEN true END)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
    -- >>> 流量開窗：窗口有開（o.source），而且規則要流量時，這一列的人物頁或政見頁要在 page_traffic_hot；沒開的列照舊（旗標 gap.arms_all 開著時留下，opened_by 是 NULL）
    CROSS JOIN LATERAL (SELECT o.source IS NOT NULL AND (NOT o.requires_traffic OR EXISTS (
           SELECT 1 FROM page_traffic_hot h
            WHERE (h.kind = 'politician' AND h.target_id = g.target->>'politician_id') OR (h.kind = 'policy' AND h.target_id = g.target->>'policy_id'))) AS ok) w
    -- <<< 流量開窗
   WHERE (w.ok OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
     AND (g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT)))
$$;

-- ------------------------------------------------------------
-- 3. 規則：永遠開（沒有選舉、不用窗口；照 party_info／manual_open 等既有臂的慣例）
-- ------------------------------------------------------------
INSERT INTO activity_rules (activity, window_kind, params, note)
SELECT 'regional_stats_missing', 'always',
       '{"min_year":{"population":2024,"area_km2":2020,"budget_expenditure":2023,"aging_rate":2024}}'::JSONB,
       '縣市與鄉鎮市區缺地方統計（人口・面積・總預算歲出・65歲以上比例）就派 regional_stat_missing（#508）。永遠開；min_year 是每個 stat_key 最舊可接受的年份，改一行即可，不用改函式'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'regional_stats_missing');

-- ------------------------------------------------------------
-- 4. 自我檢查：新臂漏登記規則、或 min_year 用了不認得的 stat_key 都讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'regional_stats_missing') THEN
    RAISE EXCEPTION 'regional_stats_missing 沒有規則';
  END IF;
  SELECT string_agg(k.key, '、') INTO bad
    FROM activity_rules r, jsonb_each_text(r.params -> 'min_year') AS k(key, value)
   WHERE r.activity = 'regional_stats_missing' AND regional_stat_unit(k.key) IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'regional_stats_missing 的 min_year 有不認得的 stat_key：%', bad; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
