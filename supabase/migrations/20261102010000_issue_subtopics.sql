-- 議題細項標籤自動化 P1（policy-ops#173，小良哥 2026-11-02 核准流程與門檻 150 筆）
-- ============================================================
--
-- 起因：串聯（依縣市、依議題看各級承諾）要比的是「同一件事」。大類議題（例：社會福利混了托育／敬老／生育）太寬時，
-- 要由流程自動長出細項標籤——不手工定表、不由系統直接寫。
--
-- 做法（沿用 regional_stat 的一整套：新交件型別＋新任務型別＋新派工臂，資料一律走代理交件＋同儕驗證）：
--   1. 偵測：2026 某縣市×議題的承諾數（範圍照 issues_scoped／issues_summary）超過門檻就開一張「拆分議題」任務
--      （task_type＝issue_too_broad，task_id＝auto:issue_too_broad:2026:<縣市>:<議題>）。
--      門檻在 activity_rules.params（threshold，預設 150；election_id，預設 2026），改值一行 UPDATE，不用改函式。
--      「承諾數」只算還沒有細項的承諾：拆分通過之後缺口自然縮小，條件不再成立時任務由 seed 自動收回；
--      剩下沒歸進去的仍超過門檻就會再開一張（細項名清單會帶上已存在的細項，優先沿用）。
--   2. 貢獻型別 policy_subtopics：代理對一批承諾提交細項歸類（issue、subtopics 2～6 個、assignments）。
--   3. 落庫寫進新表 policy_subtopics（承諾×議題 → 細項），**不寫進 policies.tags**。
--      原因（主線 2026-11-02 提醒）：issue_tags_of 只要 tags 有非雜訊值就不再看 category，若把細項塞進 tags，
--      該承諾的大類會被細項名取代、從大類消失，串聯分組會壞。所以細項獨立存放，大類判定（issue_tags_of、
--      issues_scoped、issues_summary）一個字不動；守門測試 issue-subtopics.test.ts 證明加了細項後承諾仍在原大類。
--   4. 任務的 target：該縣市×議題的承諾清單（id、標題、層級；單張最多 200 筆）與全站該議題已存在的細項名清單。
--
-- 本檔不碰任何既有資料；種子規則啟用，但現況沒有任何縣市×議題超過 150（正式庫唯讀實測最多 35），所以開 0 張。

-- ------------------------------------------------------------
-- 1. 表：policy_subtopics（承諾 × 議題 → 細項；一個承諾在一個議題下只有一個細項）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_subtopics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id       UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  issue           TEXT NOT NULL CHECK (char_length(btrim(issue)) BETWEEN 2 AND 20),
  subtopic        TEXT NOT NULL CHECK (char_length(btrim(subtopic)) BETWEEN 2 AND 12 AND subtopic = btrim(subtopic)),
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT policy_subtopics_one_per_issue UNIQUE (policy_id, issue),
  CONSTRAINT policy_subtopics_not_issue CHECK (subtopic <> issue)
);
CREATE INDEX IF NOT EXISTS policy_subtopics_issue_idx ON policy_subtopics (issue, subtopic);
COMMENT ON TABLE policy_subtopics IS
  '議題細項（policy-ops#173 P1）：某筆承諾在某個大類議題下的細項標籤。只能經 policy_subtopics 交件 → 同儕驗證 → 落庫寫入，系統不直接寫。'
  '獨立於 policies.tags，大類判定（issue_tags_of）不看這張表，所以加細項不會讓承諾離開原大類。';

ALTER TABLE policy_subtopics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON policy_subtopics;
CREATE POLICY "Public read" ON policy_subtopics FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON policy_subtopics;
CREATE POLICY "Service role write" ON policy_subtopics FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON policy_subtopics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON policy_subtopics TO anon, authenticated;
GRANT ALL ON policy_subtopics TO service_role;

-- ------------------------------------------------------------
-- 2. 落庫前的範圍檢查：這些承諾是不是真的在「這一屆、這個縣市、這個大類議題」的範圍內（issues_scoped）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_subtopic_scope(p_election_id integer, p_region text, p_issue text, p_ids uuid[])
RETURNS TABLE (policy_id uuid)
LANGUAGE sql
STABLE
SET statement_timeout = '10s'
AS $$
  SELECT DISTINCT s.policy_id
    FROM issues_scoped(p_election_id, p_region) s
   WHERE s.issue = p_issue AND s.policy_id = ANY (p_ids)
$$;
REVOKE ALL ON FUNCTION policy_subtopic_scope(integer, text, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_subtopic_scope(integer, text, text, uuid[]) TO service_role;

-- ------------------------------------------------------------
-- 3. 貢獻型別：新增 policy_subtopics（漏這個 CHECK 的話代理交件全被擋而測試全綠）
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'election_results', 'reassign_candidacy', 'regional_stat', 'cand_numbers', 'policy_subtopics'));

-- ------------------------------------------------------------
-- 4. 派工臂：issue_too_broad
-- ------------------------------------------------------------
-- 參數讀取不卡 activity_rules.enabled（同 regional_stats_missing 的慣例）：規則停用、窗口沒開交給外層 activity_open() 判斷。
CREATE OR REPLACE FUNCTION issue_too_broad_threshold() RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT (r.params ->> 'threshold')::INTEGER FROM activity_rules r WHERE r.activity = 'issue_too_broad' ORDER BY r.id LIMIT 1), 150)
$$;
CREATE OR REPLACE FUNCTION issue_too_broad_election() RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT (r.params ->> 'election_id')::INTEGER FROM activity_rules r WHERE r.activity = 'issue_too_broad' ORDER BY r.id LIMIT 1), 2026)
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_issue_too_broad()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH p AS (SELECT issue_too_broad_threshold() AS threshold, issue_too_broad_election() AS eid),
  -- 預篩縣市：一個議題底下的承諾必然是該縣市的承諾，縣市的承諾總數沒超過門檻，底下任何議題都不可能超過，
  -- 所以只對超過的縣市呼叫 issues_scoped（避免每次 seed 把 22 個縣市都算一遍）
  big AS (
    SELECT replace(r.region, '臺', '台') AS county
      FROM p
      JOIN policies po ON po.election_id = p.eid AND po.status = 'Campaign Pledge' AND po.removed_at IS NULL
      JOIN politician_elections pe ON pe.politician_id = po.politician_id AND pe.election_id = p.eid
      JOIN regions r ON r.id = pe.region_id
     WHERE issue_level_of(pe.election_type) IS NOT NULL
     GROUP BY replace(r.region, '臺', '台'), p.threshold
    HAVING count(DISTINCT po.id) > p.threshold
  ),
  -- 還沒有細項的 縣市×議題×承諾（拆分通過的承諾不再算）
  sc AS MATERIALIZED (
    SELECT b.county, s.*
      FROM p CROSS JOIN big b
      CROSS JOIN LATERAL issues_scoped(p.eid, b.county) s
     WHERE NOT EXISTS (SELECT 1 FROM policy_subtopics t WHERE t.policy_id = s.policy_id AND t.issue = s.issue)
  ),
  grp AS (
    SELECT sc.county, sc.issue, count(DISTINCT sc.policy_id) AS n
      FROM sc CROSS JOIN p
     GROUP BY sc.county, sc.issue, p.threshold
    HAVING count(DISTINCT sc.policy_id) > p.threshold
  ),
  -- 已經有人交了這個縣市×議題的拆分、還在等票的先不派
  queued AS (
    SELECT DISTINCT c.payload ->> 'region' AS region, c.payload ->> 'issue' AS issue
      FROM contributions c WHERE c.contribution_type = 'policy_subtopics' AND c.status IN ('pending', 'verified')
  )
  SELECT 'auto:issue_too_broad:' || p.eid || ':' || g.county || ':' || regexp_replace(g.issue, '\s+', '_', 'g'),
         'issue_too_broad',
         jsonb_build_object(
           'election_id', p.eid, 'region', g.county, 'issue', g.issue, 'total', g.n, 'threshold', p.threshold, 'list_cap', 200,
           'policies', (SELECT COALESCE(jsonb_agg(jsonb_build_object('policy_id', x.policy_id, 'title', x.title, 'level', x.level)
                                                  ORDER BY x.level_rank, x.proposed_date DESC NULLS LAST, x.policy_id), '[]'::JSONB)
                          FROM (SELECT d.* FROM (SELECT DISTINCT ON (s.policy_id) s.policy_id, s.title, s.level, s.level_rank, s.proposed_date
                                                   FROM sc s WHERE s.county = g.county AND s.issue = g.issue
                                                  ORDER BY s.policy_id) d
                                 ORDER BY d.level_rank, d.proposed_date DESC NULLS LAST, d.policy_id LIMIT 200) x),
           'existing_subtopics', (SELECT COALESCE(jsonb_agg(q.subtopic ORDER BY q.cnt DESC, q.subtopic), '[]'::JSONB)
                                    FROM (SELECT t.subtopic, count(*) AS cnt FROM policy_subtopics t WHERE t.issue = g.issue GROUP BY t.subtopic) q),
           'source_url', 'https://policy-tw.web.app/election/' || p.eid || '/' || g.county || '?view=issues'),
         g.county || '的「' || g.issue || '」議題在 ' || p.eid || ' 年有 ' || g.n || ' 筆承諾還沒有細項，超過 ' || p.threshold
           || ' 筆，一個大類太寬、各級承諾很難比到同一件事。請讀 target.policies 的承諾，提出 2～6 個細項標籤（每個 2～12 字，例如「托育」「敬老津貼」），'
           || '並逐筆歸類：**優先沿用 target.existing_subtopics 已存在的細項名**，真的沒有合適的才新取名；一筆承諾歸進最貼切的一個細項，'
           || '實在歸不進去的就不要放進 assignments（不要硬塞）。用 policy_subtopics 交一份：election_id、region、issue 照 target 原樣帶回，'
           || 'subtopics 是你用到的細項名（每個都要有承諾歸進去），assignments 是 [{policy_id, subtopic}]（subtopic 必須在 subtopics 裡）；'
           || '大類議題不會被改掉，細項只是在大類底下再分一層。source_urls 放 target.source_url。',
         ARRAY['https://policy-tw.web.app/election/' || p.eid || '/' || g.county || '?view=issues'],
         1, g.county
    FROM grp g CROSS JOIN p
   WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.region = g.county AND q.issue = g.issue)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_issue_too_broad IS
  '2026 縣市×議題的承諾數（還沒有細項的，範圍同 issues_scoped）超過門檻（activity_rules.params.threshold，預設 150）→ issue_too_broad 任務，一個縣市×議題一張，列出該批承諾與全站該議題已存在的細項名（policy-ops#173 P1）。條件不再成立時 seed 自動收回。';

-- ------------------------------------------------------------
-- 5. 臂名清單與總表：現行定義（總表＝20261101020000、臂名＝20261011120000）加一個名字／一行 UNION，其餘一字不改
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
    'issue_too_broad'
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
    FROM tagged g
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
-- 6. 規則：永遠開（沒有選舉窗口；門檻與屆別放 params，改一行即可）
-- ------------------------------------------------------------
INSERT INTO activity_rules (activity, window_kind, params, note)
SELECT 'issue_too_broad', 'always',
       '{"threshold":150,"election_id":2026}'::JSONB,
       '2026 縣市×議題的承諾數（還沒有細項的）超過 threshold 就派 issue_too_broad「拆分議題」（policy-ops#173 P1，小良哥 2026-11-02 定 150）。永遠開；threshold、election_id 改一行即可，不用改函式'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'issue_too_broad');

-- ------------------------------------------------------------
-- 7. 自我檢查：新臂漏登記規則、門檻不是正整數、總表漏了新臂都讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'issue_too_broad') THEN
    RAISE EXCEPTION 'issue_too_broad 沒有規則';
  END IF;
  IF issue_too_broad_threshold() IS NULL OR issue_too_broad_threshold() < 1 THEN
    RAISE EXCEPTION 'issue_too_broad 的 threshold 要是正整數';
  END IF;
  IF NOT ('issue_too_broad' = ANY (activity_arm_names())) THEN
    RAISE EXCEPTION '臂名清單漏了 issue_too_broad';
  END IF;
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'contribution_auto_tasks_issue_too_broad()') = 0 THEN
    RAISE EXCEPTION '總表沒有接上 issue_too_broad';
  END IF;
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'roster_unify_on()') = 0 THEN
    RAISE EXCEPTION '總表漏了名單清查收斂的閘（抄底錯版）';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 8. 票數預算影子排程的候選型別：TS 的 VOTE_DIMENSIONS 有 policy_subtopics，SQL 候選清單要同步
--    （以 20261030130000 的定義為底，只多 'policy_subtopics'）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link',
                                'party_info', 'election_results', 'reassign_candidacy', 'regional_stat', 'cand_numbers', 'policy_subtopics')
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget'
        AND (c.contribution_type <> 'no_change' OR j.state->'target' ? 'outcome')
    )
    AND (c.contribution_type <> 'no_change' OR (
      SELECT COUNT(*) FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget') < 2)
  -- 新的先：新件的影子結果之後才對得到它的實際結果；舊件一天內也會輪到
  ORDER BY c.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 60));
$$;

NOTIFY pgrst, 'reload schema';
