-- 總表輔助函式 roster_unit_findings、roster_gap_units 切 live：總表的 fnd、gapu 兩個 CTE 改讀常駐表（2026-11-28）
--
-- 為什麼：
--   seed 每輪 26～32 秒裡 stage:arms_all（總表）佔 15～20 秒，是剩下最大的一塊。每小時探針量到 roster_unit_findings 單獨呼叫 7～9 秒，
--   總表的 MATERIALIZED CTE fnd（roster_unit_findings）與 gapu（roster_gap_units）每輪整表重算它們。
--   第 2 期 PR-1（20261127044503）已給這兩支事件觸發器、按鍵重算函式與常駐表 dispatch_gaps（shadow），
--   但當時 dispatch_gap_set_mode 拒絕它們 live，理由是「總表不會讀它們的常駐表」。這支補上這一半：總表讀它們。
--
-- 為什麼現在可以還原（不是只存了 task_id）：
--   load_fresh 存進常駐表的 payload ＝ to_jsonb(整列輸出) - task_id - arm - opened_by，也就是這兩支函式輸出的每一欄
--   （election_id、election_type、county、town、unit、voted、items、items_count、kinds、origin_task_ids、target、what_we_need、hint_sources）
--   都在 payload 裡；arm 欄是 voted／職位的純函式（roster_cec_gap／roster_villages／raw:roster_check），還原時同一個 CASE 重算。
--   所以兩支新的還原函式 dispatch_gap_rows_roster_unit_findings()／dispatch_gap_rows_roster_gap_units() 的輸出與原函式逐列逐欄相同；
--   本檔的自我檢查在切 live 之前做雙向 EXCEPT，不一樣整支失敗回滾。
--   fnd／gapu 裡沒有任何依 now() 即時算的欄位（時間只出現在 roster_gap_units 內部的 3 天新鮮度過濾，決定「哪些單位進來」，不是輸出欄），
--   所以與其他 live 臂同等級：常駐表內容最晚落後 1 小時（每小時比對修正）、每日 03:32 對帳兜底。
--
-- 做了什麼（一個交易）：
--   1. dispatch_gap_set_mode 以 20261127044503 版為底，多放行這兩支輔助函式切 live（原本只放行 activity_arm_names() 裡的臂）。
--   2. 兩支還原函式（見上）。
--   3. 總表本體 contribution_auto_tasks_arms_tail 以 20261128040000 版為底，只改三處：
--        · fnd：mode 不是 live 照舊即時算 roster_unit_findings()；是 live 讀還原函式（二段式，一次性條件剪掉沒用的那一支）。
--        · gapu：同上，roster_gap_units()。
--        · 底下的通用 live 分支（把 dispatch_gap_rows_all() 的列當臂輸出）排除這兩支：它們的列不是臂輸出（沒有 task_type），不能進 tagged0。
--      其餘逐字相同（守門測試比對）。總表 contribution_auto_tasks_arms() 不動（仍呼叫 tail）。
--   4. 兩支各先 dispatch_gap_reconcile_arm(臂, true, 'reconcile', '0 seconds') 對齊常駐表，再 set_mode(臂, 'live')，檢查開著的列數等於對帳當下即時筆數。
--   5. 自我檢查：兩支都是 live、還原函式輸出與原函式雙向差集 0、tail 的 SET 都帶、總表在 live 下跑得動。
--
-- 行為變更：這兩支（名單差異彙總、名單缺口彙總）的內容最晚 1 小時更新，同其他 live 臂；其餘不變。
-- 預估：stage:arms_all 每輪少算 roster_unit_findings 約 7～9 秒（roster_gap_units 另約 1～2 秒），以部署後 seed_arm_timings 為準。
-- 每日呼叫量變化：0（沒有新排程、觸發器或對外呼叫；每小時 :42 的比對本來就在跑這兩支，只是從只記錄變成套用）
--
-- 回滾（每支一行，下一輪 seed 生效，常駐表與事件照舊維護所以隨時可再切）：
--   SELECT dispatch_gap_set_mode('roster_unit_findings', 'shadow', '回滾');
--   SELECT dispatch_gap_set_mode('roster_gap_units',     'shadow', '回滾');
--   （tail 與還原函式留著不用動：mode 不是 live 時 tail 就是 20261128040000 的行為。）
--
-- 風險：
--   · live 之後總表看的是常駐表，事件漏接會讓名單差異與缺口晚更新，最久 1 小時（每小時比對現在對 live 臂是套用），03:32 對帳兜底。
--     每小時比對 shadow 期間每輪有 2～4 列內容不同，這支沒有查它是哪幾欄（要看 dispatch_gap_reconcile_runs.diff_sample）；
--     live 之後那幾列最晚 1 小時由比對套用修正，同其他 live 臂。
--   · roster_gap_units 內部 3 天新鮮度過期沒有事件，靠每小時比對。

SET LOCAL statement_timeout = '300s';
SET LOCAL work_mem = '16MB';

-- ------------------------------------------------------------
-- 1. 切模式：以 20261127044503 版為底，多放行兩支輔助函式切 live
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_set_mode(p_arm TEXT, p_mode TEXT, p_note TEXT DEFAULT NULL) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF p_mode NOT IN ('off', 'shadow', 'live') THEN
    RAISE EXCEPTION 'dispatch_gap_set_mode：模式只能是 off／shadow／live，收到 %', p_mode;
  END IF;
  IF p_mode <> 'off' AND NOT EXISTS (SELECT 1 FROM dispatch_gap_arm_keys k WHERE k.arm = p_arm) THEN
    RAISE EXCEPTION 'dispatch_gap_set_mode：臂 % 還沒登記在 dispatch_gap_arm_keys，不能切成 %', p_arm, p_mode;
  END IF;
  -- 20261128070000：roster_unit_findings、roster_gap_units 是總表輔助函式（fnd／gapu），不是 UNION 分支；現在總表會讀它們的常駐表
  -- （tail 的 fnd／gapu 二段式），所以可以 live。其他不在 activity_arm_names() 的名字照舊不能 live。
  IF p_mode = 'live' AND NOT (p_arm = ANY (activity_arm_names()) OR p_arm IN ('roster_unit_findings', 'roster_gap_units')) THEN
    RAISE EXCEPTION 'dispatch_gap_set_mode：% 不是派工總表的 UNION 分支或名單輔助函式，總表不會讀它的常駐表，不能切成 live；只能 shadow 或 off', p_arm;
  END IF;
  INSERT INTO dispatch_gap_arms (arm, mode, updated_at, note) VALUES (p_arm, p_mode, now(), p_note)
  ON CONFLICT (arm) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now(), note = COALESCE(EXCLUDED.note, dispatch_gap_arms.note);
  RETURN p_mode;
END;
$$;
REVOKE ALL ON FUNCTION dispatch_gap_set_mode(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. 還原函式：常駐表開著的列 → roster_unit_findings()／roster_gap_units() 的輸出形狀
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_rows_roster_unit_findings()
RETURNS TABLE (task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT, voted BOOLEAN,
               items JSONB, items_count INTEGER, kinds JSONB, origin_task_ids TEXT[], target JSONB, what_we_need TEXT, hint_sources TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT g.gap_key,
         CASE WHEN (g.payload ->> 'voted')::BOOLEAN THEN 'roster_cec_gap' WHEN g.payload ->> 'election_type' = '村里長' THEN 'roster_villages' ELSE 'raw:roster_check' END,
         (g.payload ->> 'election_id')::INTEGER, g.payload ->> 'election_type', g.payload ->> 'county', g.payload ->> 'town', g.payload ->> 'unit',
         (g.payload ->> 'voted')::BOOLEAN, g.payload -> 'items', (g.payload ->> 'items_count')::INTEGER, NULLIF(g.payload -> 'kinds', 'null'::JSONB),
         CASE WHEN jsonb_typeof(g.payload -> 'origin_task_ids') = 'array'
              THEN ARRAY(SELECT e.v FROM jsonb_array_elements_text(g.payload -> 'origin_task_ids') WITH ORDINALITY AS e(v, n) ORDER BY e.n)
              ELSE ARRAY[]::TEXT[] END,
         g.payload -> 'target', g.payload ->> 'what_we_need',
         CASE WHEN jsonb_typeof(g.payload -> 'hint_sources') = 'array'
              THEN ARRAY(SELECT e.v FROM jsonb_array_elements_text(g.payload -> 'hint_sources') WITH ORDINALITY AS e(v, n) ORDER BY e.n) END
    FROM dispatch_gaps g
   WHERE g.arm = 'roster_unit_findings' AND g.closed_at IS NULL
$$;
REVOKE ALL ON FUNCTION dispatch_gap_rows_roster_unit_findings() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION dispatch_gap_rows_roster_unit_findings() IS '20261128070000：dispatch_gaps 開著的 roster_unit_findings 列還原成 roster_unit_findings() 的輸出（欄位、順序、型別相同）。總表 fnd 在該臂 live 時讀它。';

CREATE OR REPLACE FUNCTION dispatch_gap_rows_roster_gap_units()
RETURNS TABLE (task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT,
               items JSONB, items_count INTEGER, kinds JSONB, target JSONB, what_we_need TEXT, hint_sources TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT g.gap_key,
         CASE WHEN g.payload ->> 'election_type' = '村里長' THEN 'roster_villages' ELSE 'raw:roster_check' END,
         (g.payload ->> 'election_id')::INTEGER, g.payload ->> 'election_type', g.payload ->> 'county', g.payload ->> 'town', g.payload ->> 'unit',
         g.payload -> 'items', (g.payload ->> 'items_count')::INTEGER, NULLIF(g.payload -> 'kinds', 'null'::JSONB),
         g.payload -> 'target', g.payload ->> 'what_we_need',
         CASE WHEN jsonb_typeof(g.payload -> 'hint_sources') = 'array'
              THEN ARRAY(SELECT e.v FROM jsonb_array_elements_text(g.payload -> 'hint_sources') WITH ORDINALITY AS e(v, n) ORDER BY e.n) END
    FROM dispatch_gaps g
   WHERE g.arm = 'roster_gap_units' AND g.closed_at IS NULL
$$;
REVOKE ALL ON FUNCTION dispatch_gap_rows_roster_gap_units() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION dispatch_gap_rows_roster_gap_units() IS '20261128070000：dispatch_gaps 開著的 roster_gap_units 列還原成 roster_gap_units() 的輸出（欄位、順序、型別相同）。總表 gapu 在該臂 live 時讀它。';

-- ------------------------------------------------------------
-- 3. 總表本體：以 20261128040000 版為底，只改 fnd、gapu 與通用 live 分支三處
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms_tail(p_arms TEXT[] DEFAULT NULL, p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE SET work_mem = '16MB' SET hash_mem_multiplier = '1' AS $$
  WITH -- >>> 缺口二段式（20261126180000）：模式是 live 的臂名（全 off 時是空集合）；這些臂改讀 dispatch_gaps 開著的列，其餘照舊即時算
       live_arms AS MATERIALIZED (SELECT a.arm FROM dispatch_gap_arms a WHERE a.mode = 'live'),
       -- <<< 缺口二段式
       raw AS (SELECT r0.* FROM contribution_auto_tasks_raw() r0
                WHERE ('raw:' || r0.task_type) NOT IN (SELECT l.arm FROM live_arms l)  -- 缺口二段式：raw 各任務型別各自的模式
               UNION ALL
               SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region FROM dispatch_gap_rows_all() g
                WHERE g.arm LIKE 'raw:%' AND g.arm IN (SELECT l.arm FROM live_arms l)),
       due AS (SELECT d0.* FROM contribution_auto_tasks_deadline_due() d0
                WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'deadline_due')  -- 缺口二段式
               UNION ALL
               SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region FROM dispatch_gap_rows_all() g
                WHERE g.arm = 'deadline_due' AND EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'deadline_due')),
       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）
       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),
       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),
       -- >>> 名單清查收斂：名冊類差異按單位彙總（開關關著就不算）；原臂在開關開著時停用，單位清查掛 items（見 20261101020000）
       -- 20261128070000：roster_unit_findings 是 live 時讀常駐表的還原函式，否則照舊即時算（兩段各有一次性條件，只會跑其中一支）
       fnd AS MATERIALIZED (SELECT * FROM roster_unit_findings() WHERE roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_unit_findings')
                            UNION ALL
                            SELECT * FROM dispatch_gap_rows_roster_unit_findings() WHERE roster_unify_on() AND EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_unit_findings')),
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
  UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'dup') AND contribution_arm_selected(p_arms, 'dup')
  UNION ALL SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'legacy') AND contribution_arm_selected(p_arms, 'legacy')
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM contribution_auto_tasks_mismatch() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'mismatch') AND contribution_arm_selected(p_arms, 'mismatch')
  UNION ALL SELECT 'policy_dup' AS arm, t.* FROM contribution_auto_tasks_policy_dup() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'policy_dup') AND contribution_arm_selected(p_arms, 'policy_dup')
  UNION ALL SELECT 'not_running' AS arm, t.* FROM contribution_auto_tasks_not_running() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'not_running') AND contribution_arm_selected(p_arms, 'not_running')
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'mayor_policies') AND contribution_arm_selected(p_arms, 'mayor_policies')
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'term_policies') AND contribution_arm_selected(p_arms, 'term_policies')
  UNION ALL SELECT 'roster_villages' AS arm, t.* FROM contribution_auto_tasks_roster_villages() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_villages') AND contribution_arm_selected(p_arms, 'roster_villages')
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'township_gap') AND contribution_arm_selected(p_arms, 'township_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'region_gap') AND contribution_arm_selected(p_arms, 'region_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'elected_missing') AND contribution_arm_selected(p_arms, 'elected_missing')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'roster_cec_gap' AS arm, t.* FROM contribution_auto_tasks_roster_cec_gap() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_cec_gap') AND contribution_arm_selected(p_arms, 'roster_cec_gap')
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM contribution_auto_tasks_district_seats() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'district_seats') AND contribution_arm_selected(p_arms, 'district_seats')
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM contribution_auto_tasks_policy_elements() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'policy_elements') AND contribution_arm_selected(p_arms, 'policy_elements')
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t WHERE contribution_arm_selected(p_arms, 'deadline_due')
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM contribution_auto_tasks_lineage_candidates() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_candidates') AND contribution_arm_selected(p_arms, 'lineage_candidates')
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM contribution_auto_tasks_handover_missing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'handover_missing') AND contribution_arm_selected(p_arms, 'handover_missing')
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM contribution_auto_tasks_lineage_roles() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_roles') AND contribution_arm_selected(p_arms, 'lineage_roles')
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM contribution_auto_tasks_lineage_links() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_links') AND contribution_arm_selected(p_arms, 'lineage_links')
  UNION ALL SELECT 'career_sources' AS arm, t.* FROM contribution_auto_tasks_career_sources() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'career_sources') AND contribution_arm_selected(p_arms, 'career_sources')
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM contribution_auto_tasks_withdrawn_filing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'withdrawn_filing') AND contribution_arm_selected(p_arms, 'withdrawn_filing')
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_gap') AND contribution_arm_selected(p_arms, 'party_gap')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_roster') AND contribution_arm_selected(p_arms, 'party_roster')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'party_info') AND contribution_arm_selected(p_arms, 'party_info')
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'placeholder_politicians') AND contribution_arm_selected(p_arms, 'placeholder_politicians')
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'election_results') AND contribution_arm_selected(p_arms, 'election_results')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t WHERE NOT roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'owner_mismatch') AND contribution_arm_selected(p_arms, 'owner_mismatch')  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'ballot_numbers') AND contribution_arm_selected(p_arms, 'ballot_numbers')
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'manual_visitor') AND contribution_arm_selected(p_arms, 'manual_visitor')
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'manual_open') AND contribution_arm_selected(p_arms, 'manual_open')
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'regional_stats_missing') AND contribution_arm_selected(p_arms, 'regional_stats_missing')
  UNION ALL SELECT 'issue_too_broad' AS arm, t.* FROM contribution_auto_tasks_issue_too_broad() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'issue_too_broad') AND contribution_arm_selected(p_arms, 'issue_too_broad')
  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_status') AND contribution_arm_selected(p_arms, 'lineage_status')
  UNION ALL SELECT 'lineage_stances' AS arm, t.* FROM contribution_auto_tasks_lineage_stances() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_stances') AND contribution_arm_selected(p_arms, 'lineage_stances')
  UNION ALL SELECT 'lineage_events' AS arm, t.* FROM contribution_auto_tasks_lineage_events() t WHERE NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'lineage_events') AND contribution_arm_selected(p_arms, 'lineage_events')
  -- >>> 缺口二段式：模式是 live 的臂（raw 與 deadline_due 已在各自的 CTE 處理）改讀常駐表開著的列；名單清查收斂開關開著時，原本被閘掉的七支臂維持被閘掉
  -- 20261128070000：roster_unit_findings、roster_gap_units 的列不是臂輸出（沒有 task_type），由 fnd／gapu 讀，這裡排除
  UNION ALL SELECT g.arm, g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region
    FROM dispatch_gap_rows_all() g
   WHERE g.arm IN (SELECT l.arm FROM live_arms l)
     AND g.arm NOT LIKE 'raw:%' AND g.arm <> 'deadline_due' AND g.arm NOT IN ('roster_unit_findings', 'roster_gap_units') AND contribution_arm_selected(p_arms, g.arm)
     AND (g.arm NOT IN ('township_gap', 'region_gap', 'elected_missing', 'party_gap', 'party_roster', 'election_results', 'owner_mismatch') OR NOT roster_unify_on())
  -- <<< 缺口二段式
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
       -- 20261128070000：roster_gap_units 是 live 時讀還原函式，否則照舊即時算
       gapu AS MATERIALIZED (SELECT * FROM roster_gap_units() WHERE roster_unify_on() AND NOT EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_gap_units')
                             UNION ALL
                             SELECT * FROM dispatch_gap_rows_roster_gap_units() WHERE roster_unify_on() AND EXISTS (SELECT 1 FROM live_arms l WHERE l.arm = 'roster_gap_units')),
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
         k.task_id, k.task_type, k.target, k.what_we_need, k.hint_sources, k.reward, k.region, k.eid, k.etype,
         k.arm AS src_arm  -- 臂與鍵篩選：改名成 traffic: 之前的來源臂名（20261128040000）
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
     -- >>> 臂與鍵篩選（20261128040000）：p_arms／p_keys 都是 NULL＝全量；給了就只回這批臂（輸出臂名或來源臂名在 p_arms 內）、這批鍵（'*' 不限）的列
     AND (p_arms IS NULL OR g.arm = ANY (p_arms) OR g.src_arm = ANY (p_arms))
     AND (p_keys IS NULL OR '*' = ANY (p_keys) OR dispatch_gap_scope_key(g.src_arm, g.task_id) = ANY (p_keys))
     -- <<< 臂與鍵篩選
$$;
REVOKE ALL ON FUNCTION contribution_auto_tasks_arms_tail FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION contribution_auto_tasks_arms_tail IS '派工總表本體（20261128040000 從 contribution_auto_tasks_arms 抽出；20261128070000 起 fnd／gapu 在 roster_unit_findings、roster_gap_units 是 live 時讀常駐表）。p_arms／p_keys 都是 NULL＝全量，與 contribution_auto_tasks_arms() 逐列相同；給了就只回這批臂與鍵的列（子集＝全量用同樣條件過濾）。臂集合對 roster_villages、roster_cec_gap、raw:roster_check 一律不剪。';

-- ------------------------------------------------------------
-- 4. 對齊常駐表、檢查還原函式與原函式輸出逐列相同、切 live
-- ------------------------------------------------------------
-- 還原函式 vs 原函式：先對齊（reconcile 套用），再雙向 EXCEPT 都要是 0；同一交易內 now() 固定，所以時間型過濾不會造成假差異
DO $$
DECLARE
  v_run_f dispatch_gap_reconcile_runs;
  v_run_g dispatch_gap_reconcile_runs;
  v_n     BIGINT;
BEGIN
  v_run_f := dispatch_gap_reconcile_arm('roster_unit_findings', true, 'reconcile', '0 seconds');
  v_run_g := dispatch_gap_reconcile_arm('roster_gap_units', true, 'reconcile', '0 seconds');

  SELECT count(*) INTO v_n FROM (SELECT * FROM roster_unit_findings() EXCEPT SELECT * FROM dispatch_gap_rows_roster_unit_findings()) x;
  IF v_n <> 0 THEN RAISE EXCEPTION '切 live 前檢查失敗：roster_unit_findings 有 % 列即時輸出在還原函式裡沒有或內容不同', v_n; END IF;
  SELECT count(*) INTO v_n FROM (SELECT * FROM dispatch_gap_rows_roster_unit_findings() EXCEPT SELECT * FROM roster_unit_findings()) x;
  IF v_n <> 0 THEN RAISE EXCEPTION '切 live 前檢查失敗：roster_unit_findings 還原函式有 % 列即時輸出沒有', v_n; END IF;
  SELECT count(*) INTO v_n FROM (SELECT * FROM roster_gap_units() EXCEPT SELECT * FROM dispatch_gap_rows_roster_gap_units()) x;
  IF v_n <> 0 THEN RAISE EXCEPTION '切 live 前檢查失敗：roster_gap_units 有 % 列即時輸出在還原函式裡沒有或內容不同', v_n; END IF;
  SELECT count(*) INTO v_n FROM (SELECT * FROM dispatch_gap_rows_roster_gap_units() EXCEPT SELECT * FROM roster_gap_units()) x;
  IF v_n <> 0 THEN RAISE EXCEPTION '切 live 前檢查失敗：roster_gap_units 還原函式有 % 列即時輸出沒有', v_n; END IF;

  SELECT count(*) INTO v_n FROM dispatch_gaps g WHERE g.arm = 'roster_unit_findings' AND g.closed_at IS NULL;
  IF v_n <> v_run_f.live_count THEN RAISE EXCEPTION '切 live 前對齊失敗：roster_unit_findings 常駐表開著 % 列，即時輸出 % 列', v_n, v_run_f.live_count; END IF;
  SELECT count(*) INTO v_n FROM dispatch_gaps g WHERE g.arm = 'roster_gap_units' AND g.closed_at IS NULL;
  IF v_n <> v_run_g.live_count THEN RAISE EXCEPTION '切 live 前對齊失敗：roster_gap_units 常駐表開著 % 列，即時輸出 % 列', v_n, v_run_g.live_count; END IF;

  PERFORM dispatch_gap_set_mode('roster_unit_findings', 'live', '2026-11-28 總表 fnd 改讀常駐表；回滾：dispatch_gap_set_mode(''roster_unit_findings'',''shadow'')');
  PERFORM dispatch_gap_set_mode('roster_gap_units', 'live', '2026-11-28 總表 gapu 改讀常駐表；回滾：dispatch_gap_set_mode(''roster_gap_units'',''shadow'')');
  RAISE NOTICE '切 live：roster_unit_findings 對齊前 missing=% extra=% changed=%；roster_gap_units 對齊前 missing=% extra=% changed=%',
    v_run_f.missing, v_run_f.extra, v_run_f.changed, v_run_g.missing, v_run_g.extra, v_run_g.changed;
END
$$;

-- ------------------------------------------------------------
-- 5. 自我檢查
-- ------------------------------------------------------------
DO $$
DECLARE
  r      RECORD;
  v_fn   TEXT;
  v_bad  TEXT := '';
  v_rows BIGINT;
BEGIN
  IF (SELECT count(*) FROM dispatch_gap_arms a WHERE a.mode = 'live' AND a.arm IN ('roster_unit_findings', 'roster_gap_units')) <> 2 THEN
    RAISE EXCEPTION '兩支名單輔助函式都應該是 live';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.contribution_auto_tasks_arms()', 'public.contribution_auto_tasks_arms_tail(text[],text[])'] LOOP
    SELECT p.proconfig INTO r FROM pg_proc p WHERE p.oid = v_fn::regprocedure;
    IF NOT ('hash_mem_multiplier=1' = ANY (COALESCE(r.proconfig, ARRAY[]::TEXT[]))) THEN v_bad := v_bad || ' ' || v_fn || ':hash_mem_multiplier'; END IF;
    IF NOT ('work_mem=16MB' = ANY (COALESCE(r.proconfig, ARRAY[]::TEXT[]))) THEN v_bad := v_bad || ' ' || v_fn || ':work_mem'; END IF;
  END LOOP;
  IF v_bad <> '' THEN RAISE EXCEPTION '總表函式層級 SET 沒帶全：%', v_bad; END IF;

  SELECT count(*) INTO v_rows FROM contribution_auto_tasks_arms();
  RAISE NOTICE '切 live 後總表輸出 % 列', v_rows;
END
$$;
