-- 2026 缺政見任務在公報上架前停派（縣市長除外）（2026-11-13，維護者 11-13 群組裁決）
-- ============================================================
--
-- 裁決：2026 的缺政見自動任務（auto:policy_missing:*、auto:term_policy_missing:*）在「該場選舉公報尚未上架」時不派；縣市長（含直轄市長）照派。
-- 公報上架後（bulletin_published 里程碑翻 done）這些任務自動回到佇列，不需要人動手。
--
-- 「公報已上架」的單一真相＝election_milestones 的 kind='bulletin_published' AND election_type IS NULL AND status='done'（20261008113000 bulletin_watch）。
-- 不能看 elections.bulletin_published_on：它是里程碑的衍生快取，預估日（status=expected）也會填進去（2026 那列目前就是預估的 2026-11-18）。
-- bulletin-watch 偵測到公報資料夾時（bulletin_watch_mark_published）把那一列改成偵測當天、status=done、basis=official，觸發器再把 bulletin_published_on 同步成實際日期。
--
-- 改了什麼（全部在總表這一層，因為 auto:* 派工列只有 seed_auto_task_queue 會寫，而 seed 吃的是總表 contribution_auto_tasks_arms() 的輸出）：
--   1. election_bulletin_published(p_election_id)：這場選舉的公報里程碑是不是 done（STABLE）。
--   2. policy_gap_held(p_election_id, p_election_type)：這場選舉的這個職位，缺政見任務現在要不要擋——縣市長類（讀規則 mayor_policies 的 election_types）不擋、還沒投票、
--      有整場的公報里程碑而且不是 done 才擋；職位或選舉不明、沒有公報里程碑、已經投票的一律不擋（寧可開著也不無聲關掉，同 activity_open 的 open_when_unknown 精神）。
--   3. contribution_auto_tasks_arms()（前一版 20261105200000）：多一個 held CTE（每組選舉×職位問 policy_gap_held 一次），並在 w.ok（流量開窗那一處）多一個條件。
--      被擋的列跟「窗口關著」同一條路：旗標 gap.arms_all 開著時留下、opened_by 是 NULL，seed 收回已存在的派工列時原因記 window；
--      旗標沒開（預設）就是不輸出。里程碑翻 done 的下一輪 seed（每 10 分鐘），缺口以新列出生。
--   機械替換只有兩處（守門 policy-gap-hold.test.ts 把替換倒回去必須一字不差回到前一版）；task_id、reward、hint_sources、其他臂、seed 一字不動。
--
-- 不動：mayor_policies 臂（縣市長）、raw／term_policies 臂本體、activity_rules、web_request_parked（網站請求停放，仍用 bulletin_published_on 判斷；之後可改用 election_bulletin_published）。
--
-- 為什麼放總表、不放各臂：
--   * 兩支臂（raw 的 policy_missing、term_policies）各有一組「重貼＋機械替換」的守門測試，各臂加條件要動兩支大函式；總表只有一處。
--   * 派工列的來源只有 seed←總表。工作卡（work_key，#944～#946）、需求疊加、插隊（task_boost、visitor 插隊、web_request_gap_boost）都是對「已經存在的 task_dispatches 列」或請求本身動作，
--     沒有列就沒有東西可疊、可插；驗證票跟著母任務。所以擋在出生處，後面各層自然沒有東西。
--   * 擋在 w.ok 而不是把列從總表拿掉：seed 靠「_gaps_all 有、_gaps 沒有」分辨「窗口關了」與「缺口補上了」（gap_events 的 closed 原因）；已存在的列因此以 window 收回，不誤記成 filled。
--   * 規則（activity_rules）只能對「臂×選舉×職位」開時間窗，term_policies 又跨 2022／2024／2026 三屆（沒有公報里程碑的舊屆加「公報上架日起」的規則會把它們關掉）。helper 只對還沒投票、有公報里程碑的選舉生效。
--   * 既有村里長、鄉鎮市民代表的規則（rule 3 之外那條 from=bulletin_published、min_status=done，20261019110000）不衝突：兩者都要求里程碑 done，這次只是把同一個要求擴到其他非縣市長職位。
--
-- 副作用（PR 說明另寫）：
--   * 缺政見任務已在派工列上、職位是議員／鄉鎮市長／區長等的，下一輪 seed 會以 window 收回；公報上架後以新列出生（排隊位置從隊尾重算）。
--   * 網站請求（contribution_tasks source=web_request）：缺政見請求目前若被缺口覆蓋（#912，web_request_coverage）就不單獨派；缺口被擋後請求不再被覆蓋，
--     非村里長／市代的請求會照舊單獨派（維護者要停放它們另案改 web_request_parked，這支不動）。
--   * 只動 2026（還沒投票且有公報里程碑的選舉）；2022／2024 沒有公報里程碑、已投票，不受影響。
-- 只加函式與換總表本體（同簽名 CREATE OR REPLACE，不用分兩次上）；不改協議的任務欄位。

-- ------------------------------------------------------------
-- 1. 公報是否已上架（單一真相＝里程碑 done）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION election_bulletin_published(p_election_id INTEGER) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM election_milestones m
     WHERE m.election_id = p_election_id AND m.kind = 'bulletin_published' AND m.election_type IS NULL AND m.status = 'done')
$$;
COMMENT ON FUNCTION election_bulletin_published IS
  '這場選舉的選舉公報上架了嗎：election_milestones 有整場的 bulletin_published 且 status=done（bulletin-watch 偵測到才會改成 done）。預估日（expected）、announced 都不算。'
  '不要改看 elections.bulletin_published_on——那是衍生快取，預估日也會填進去。2026-11-13';
REVOKE ALL ON FUNCTION election_bulletin_published(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION election_bulletin_published(INTEGER) TO service_role;

-- ------------------------------------------------------------
-- 2. 缺政見任務要不要擋
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_gap_held(p_election_id INTEGER, p_election_type TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  WITH mayor AS (
    -- 縣市長類職位讀規則 mayor_policies 的 params（跟 raw、mayor_policies 臂同一來源）；讀不到或空的就用預設兩個
    SELECT COALESCE(NULLIF(
             (SELECT ARRAY(SELECT jsonb_array_elements_text(r.params->'election_types'))
                FROM activity_rules r
               WHERE r.activity = 'mayor_policies' AND r.priority IS NULL
               ORDER BY r.enabled DESC, r.id LIMIT 1),
             ARRAY[]::TEXT[]), ARRAY['縣市長', '直轄市長']) AS types
  )
  SELECT p_election_id IS NOT NULL AND p_election_type IS NOT NULL
     AND NOT (p_election_type = ANY ((SELECT mayor.types FROM mayor)::TEXT[]))
     AND EXISTS (SELECT 1 FROM elections e WHERE e.id = p_election_id AND e.election_date >= activity_today())
     AND EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = p_election_id AND m.kind = 'bulletin_published' AND m.election_type IS NULL)
     AND NOT election_bulletin_published(p_election_id)
$$;
COMMENT ON FUNCTION policy_gap_held IS
  '缺政見任務（policy_missing、term_policy_missing）在這場選舉、這個職位現在要不要擋（維護者 2026-11-13）：不是縣市長類、選舉還沒投票、有整場的公報里程碑、而且公報還沒上架（里程碑不是 done）才擋。'
  '選舉或職位不明（NULL）、沒有公報里程碑（舊屆）、已投票一律不擋。總表 contribution_auto_tasks_arms 的 held CTE 用它。2026-11-13';
REVOKE ALL ON FUNCTION policy_gap_held(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_gap_held(INTEGER, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 3. 總表（前一版 20261105200000；兩處機械替換，見檔頭）
-- ------------------------------------------------------------
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
  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t
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
       -- >>> 公報上架前停派（20261113100000，維護者 2026-11-13）：2026 的缺政見任務（policy_missing、term_policy_missing），縣市長以外的職位，在該場選舉的公報里程碑還不是 done 之前不輸出。
       --     每組（選舉×職位）問 policy_gap_held 一次；被擋的列走下面的 w.ok＝false，跟「窗口關著」同一條路（旗標 gap.arms_all 開著時留下、opened_by 是 NULL，seed 收回時原因記 window）。
       --     里程碑翻 done 後 policy_gap_held 回 false，下一輪 seed 缺口自動開出來
       held AS MATERIALIZED (
  SELECT x.eid, x.etype
    FROM (SELECT DISTINCT k.eid, k.etype FROM keyed k WHERE k.task_type IN ('policy_missing', 'term_policy_missing')) x
   WHERE policy_gap_held(x.eid, x.etype)
       ),
       -- <<< 公報上架前停派
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
            WHERE (h.kind = 'politician' AND h.target_id = g.target->>'politician_id') OR (h.kind = 'policy' AND h.target_id = g.target->>'policy_id')))
           -- >>> 公報上架前停派：被 held 擋住的缺政見列不開
           AND NOT (g.task_type IN ('policy_missing', 'term_policy_missing')
                    AND EXISTS (SELECT 1 FROM held hd WHERE hd.eid IS NOT DISTINCT FROM g.eid AND hd.etype IS NOT DISTINCT FROM g.etype))
           -- <<< 公報上架前停派
           AS ok) w
    -- <<< 流量開窗
   WHERE (w.ok OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
     AND (g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT)))
$$;

-- ------------------------------------------------------------
-- 4. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF election_bulletin_published(-1) THEN RAISE EXCEPTION 'election_bulletin_published(-1) should be false'; END IF;
  IF policy_gap_held(NULL, '縣市議員') OR policy_gap_held(-1, NULL) OR policy_gap_held(-1, '縣市議員') THEN
    RAISE EXCEPTION 'policy_gap_held should not hold unknown election or type';
  END IF;
  IF policy_gap_held(2026, '縣市長') OR policy_gap_held(2026, '直轄市長') THEN
    RAISE EXCEPTION 'policy_gap_held should never hold mayor types';
  END IF;
END $$;
