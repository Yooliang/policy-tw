-- 有人看才追：「頁面有流量才開」從規則旗標拆成獨立派工臂，哪些職位走它由 traffic_watch_levels 一個職位一列開關（維護者 2026-10-12）
-- ============================================================
--
-- 起因：#470（20261009010000）把村里長的進度追蹤與補該屆政見做成「同一個活動兩條規則」：一般那條（rule 5、24、36）排除村里長，
--   另一條（rule 45、46、47）只管村里長、旗標 requires_traffic（頁面在 page_traffic_hot 才開）。兩條同名，主控台時間軸看起來像規則重疊，
--   也看不出哪一條是「依瀏覽量」。維護者 10-12：這兩種性質不同，明確拆開，另立一支臂；而且「有流量才開」要有職位層級的開關。
--
-- 做法：
--   1. 新表 traffic_watch_levels：一個職位一列（九種職位都種），enabled＝這個職位改走「有人看才追」。初值只有村里長開（＝現況）。
--      改值＝一行 migration 的 UPDATE（每次修改進 edit_history，同 traffic_boost_settings 的慣例）。
--   2. 三支流量臂：traffic:progress_stale、traffic:deadline_due、traffic:term_policies。來源臂 raw:progress_stale、deadline_due、term_policies
--      （清單在 traffic_watch_source_arms()）裡、職位在開著的層級的列，總表在 keyed 這一段把臂名換成流量臂（task_id、型別、target、說明一個字不變），
--      其餘列照舊。流量臂的列在列層要該頁在 page_traffic_hot 才開（原本的 requires_traffic 判斷，改看臂名）。
--      為什麼是三支不是一支：三個來源的時間窗不同（補該屆政見要投票日 +1 起，進度兩支不分時期），一支臂只能掛一組窗口。
--   3. 規則：rule 45、46、47 原地改活動名（rule_id 不變，窗口不變），拿掉 election_types 與 requires_traffic——層級交給設定表；
--      rule 5、24、36 拿掉 except_election_types——村里長的列已經不在這三支臂裡，關掉某職位的「有人看才追」時，它的列回到一般臂照一般規則派。
--   4. 主控台：console_arm_stage_map 三列（照來源臂的時期）。
--
-- 派工輸出：今天逐件不變（正式庫 10-12 唯讀：rule 45、46、47 開出的派工列 0 件；村里長的列換了臂名、開不開的條件相同）。
-- requires_traffic 欄位留著不刪（沒有程式讀它了；migration 自己檢查沒有任何規則還開著它）。要刪另開一支。
-- 不改：臂本體、seed、rebalance、優先層、冷卻（task_cooldown_settings 照任務型別，流量臂的任務型別沒變）、policy_no_public_progress（照任務型別）。
-- 優先層：流量臂沒有 priority:<臂名> 規則，落在預設層；達標頁面名下的缺口照舊由 traffic_boost_apply() 提到前段。

-- ------------------------------------------------------------
-- 1. 層級開關
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traffic_watch_levels (
  id            SERIAL PRIMARY KEY,
  election_type TEXT NOT NULL UNIQUE CHECK (election_type IN ('總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長',
                                                               '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')),
  enabled       BOOLEAN NOT NULL DEFAULT false,
  note          TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE traffic_watch_levels IS
  '有人看才追的職位開關（一個職位一列）：enabled 的職位，進度追蹤、期限到期、補該屆政見三種缺口改歸流量臂 traffic:<型別>，頁面在 page_traffic_hot 才派；'
  '沒開的職位照一般臂的規則派。改值走 migration（UPDATE ... SET enabled = ..., note = ...），每次修改進 edit_history。2026-10-12';
ALTER TABLE traffic_watch_levels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON traffic_watch_levels;
CREATE POLICY "Public read" ON traffic_watch_levels FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON traffic_watch_levels;
CREATE POLICY "Service role write" ON traffic_watch_levels FOR ALL USING (auth.role() = 'service_role');
GRANT SELECT ON traffic_watch_levels TO anon, authenticated;
DROP TRIGGER IF EXISTS trg_traffic_watch_levels_touch ON traffic_watch_levels;
CREATE TRIGGER trg_traffic_watch_levels_touch BEFORE UPDATE ON traffic_watch_levels FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_traffic_watch_levels_audit ON traffic_watch_levels;
CREATE TRIGGER trg_traffic_watch_levels_audit AFTER INSERT OR UPDATE OR DELETE ON traffic_watch_levels FOR EACH ROW EXECUTE FUNCTION activity_audit();

INSERT INTO traffic_watch_levels (election_type, enabled, note)
SELECT t, t = '村里長', CASE WHEN t = '村里長' THEN '#470：村里長只收政見與結果，有人看才追（10-12 從規則旗標搬來）' END
  FROM unnest(ARRAY['總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']) AS t
ON CONFLICT (election_type) DO NOTHING;

-- ------------------------------------------------------------
-- 2. 來源臂與流量臂的對照
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION traffic_watch_source_arms() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['raw:progress_stale', 'deadline_due', 'term_policies']::TEXT[]
$$;
COMMENT ON FUNCTION traffic_watch_source_arms IS '有人看才追的來源臂：這幾支臂裡、職位在 traffic_watch_levels 開著的列改歸流量臂（traffic_watch_arm）。新增來源臂要同時在 activity_arm_names() 加流量臂名、種一條規則。2026-10-12';

CREATE OR REPLACE FUNCTION traffic_watch_arm(p_source TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'traffic:' || regexp_replace(p_source, '^raw:', '')
$$;
COMMENT ON FUNCTION traffic_watch_arm IS '來源臂 → 流量臂名：raw:progress_stale → traffic:progress_stale、deadline_due → traffic:deadline_due、term_policies → traffic:term_policies。2026-10-12';

-- ------------------------------------------------------------
-- 3. 總表（前一版＝20261009240100_regional_stats_arm.sql；只改 needs_etype、keyed、opened、列層四處，標記 >>> 有人看才追）
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
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t
       ),
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
-- 4. 臂名清單（前一版＝20261010170000_retire_single_election_result.sql，最後多三個名字）
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
    'traffic:term_policies'
  ]::TEXT[]
$$;
-- ------------------------------------------------------------
-- 5. 規則：rule 45、46、47 改名成流量臂；rule 5、24、36 不再排除職位
-- ------------------------------------------------------------
UPDATE activity_rules SET activity = 'traffic:progress_stale', election_types = NULL, requires_traffic = false,
       note = '有人看才追（10-12 從 rule 45「村里長、要流量」改名）：不分時期（一般那條是就職日起；之後在 traffic_watch_levels 開其他職位，那些職位也改成不分時期）；哪些職位走這支看 traffic_watch_levels，頁面在 page_traffic_hot 才派'
 WHERE id = 45 AND activity = 'raw:progress_stale';
UPDATE activity_rules SET activity = 'traffic:deadline_due', election_types = NULL, requires_traffic = false,
       note = '有人看才追（10-12 從 rule 46「村里長、要流量」改名）：不分時期（一般那條是就職日起；之後在 traffic_watch_levels 開其他職位，那些職位也改成不分時期）；哪些職位走這支看 traffic_watch_levels，頁面在 page_traffic_hot 才派'
 WHERE id = 46 AND activity = 'deadline_due';
UPDATE activity_rules SET activity = 'traffic:term_policies', election_types = NULL, requires_traffic = false,
       note = '有人看才追（10-12 從 rule 47「村里長、要流量」改名）：投票日 +1 起（同一般那條 rule 36）；哪些職位走這支看 traffic_watch_levels，頁面在 page_traffic_hot 才派'
 WHERE id = 47 AND activity = 'term_policies';
UPDATE activity_rules SET except_election_types = NULL,
       note = regexp_replace(note, '；?排除村里長（村里長看 rule 4[567] 有流量才開）', '') || '；有人看才追的職位（traffic_watch_levels）已改歸 traffic: 臂（10-12）'
 WHERE id IN (5, 24, 36) AND activity IN ('raw:progress_stale', 'deadline_due', 'term_policies');

-- ------------------------------------------------------------
-- 6. 主控台時期（照來源臂）
-- ------------------------------------------------------------
INSERT INTO console_arm_stage_map (arm, stage, note) VALUES
  ('traffic:progress_stale', 6, '有人看才追：進度追蹤'),
  ('traffic:deadline_due', 6, '有人看才追：到期檢查'),
  ('traffic:term_policies', 5, '有人看才追：補該屆政見')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 7. 自我檢查
-- ------------------------------------------------------------
DO $$
DECLARE v INTEGER;
BEGIN
  SELECT count(*) INTO v FROM activity_rules WHERE id IN (45, 46, 47) AND activity LIKE 'traffic:%' AND election_types IS NULL AND NOT requires_traffic AND enabled;
  IF v <> 3 THEN RAISE EXCEPTION '流量臂規則只改到 % 條（應為 3）', v; END IF;
  IF EXISTS (SELECT 1 FROM activity_rules WHERE requires_traffic) THEN
    RAISE EXCEPTION '還有規則開著 requires_traffic：總表已經不讀這個旗標，那條規則的流量條件會被無聲忽略';
  END IF;
  IF EXISTS (SELECT 1 FROM activity_rules WHERE id IN (5, 24, 36) AND except_election_types IS NOT NULL) THEN
    RAISE EXCEPTION '一般那三條還排除職位：關掉某職位的有人看才追時，它的列會被整批關掉';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(traffic_watch_source_arms()) s(arm)
              WHERE NOT traffic_watch_arm(s.arm) = ANY (activity_arm_names())
                 OR NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = traffic_watch_arm(s.arm))
                 OR NOT EXISTS (SELECT 1 FROM console_arm_stage_map m WHERE m.arm = traffic_watch_arm(s.arm))) THEN
    RAISE EXCEPTION '有來源臂的流量臂沒登記齊（臂名清單、規則、主控台時期）';
  END IF;
  IF (SELECT count(*) FROM traffic_watch_levels) <> 9 OR NOT EXISTS (SELECT 1 FROM traffic_watch_levels WHERE election_type = '村里長' AND enabled)
     OR EXISTS (SELECT 1 FROM traffic_watch_levels WHERE election_type <> '村里長' AND enabled) THEN
    RAISE EXCEPTION '層級開關初值不對（應為九列、只有村里長開著）';
  END IF;
END $$;
