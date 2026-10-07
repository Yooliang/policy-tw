-- 派工與排程的啟用時間窗，P1：派工臂總表貼臂名並過規則、每支臂一條「永遠開」規則、缺口出生紀錄接上規則（2026-10-08，docs/PLAN-task-activation.md）
-- ============================================================
--
-- P0（20261008001000）建了里程碑／規則／覆寫三張表、activity_open() 與缺口出生紀錄，但「沒有人呼叫」。這支讓 contribution_auto_tasks_arms()
-- 開始呼叫 activity_open()，同時把每個活動的規則種子種成「永遠開」——所以**派工輸出逐件不變**（守門見下）。
--
-- 做了什麼：
--   1. activity_arm_names()：36 個「活動名」＝總表的 28 個 UNION 分支（raw 一支函式產出 9 種任務型別，各自一個活動 raw:<任務型別>；其餘 27 支用函式名去掉
--      contribution_auto_tasks_ 前綴，deadline_due 那個 CTE 也叫 deadline_due）。這是健康檢查「每支臂至少一條規則」的清單；
--      守門測試比對它與總表本體裡實際貼的標籤、與 raw 函式實際會產出的任務型別，不會各說各話。
--   2. activity_rules 種子：每個活動一條 window_kind='always' 的規則（note 寫明是 P1 種子）。always 也是一筆規則列，不是程式裡的常數
--      （計畫 2.5 第 1 點）；P2 起一支臂一個 PR，把它換成相對里程碑的窗口。
--   3. contribution_auto_tasks_arms()：本體＝20261006141600 的現行定義（與正式庫 pg_get_functiondef 一字不差，2026-10-08 比對過）加機械式替換——
--      每個 UNION 分支貼臂名（SELECT * FROM f() → SELECT 'f' AS arm, t.* FROM f() t；第一個分支前面多一欄 'raw:' || task_type、說明欄補一個欄名），
--      整串 UNION 包進 CTE tagged，其後多一段 keyed／opened（對「臂×選舉×職位」各問一次 activity_open）與最後的 JOIN（沒有開窗的規則＝濾掉）。
--      28 支臂的簽名與內容一字沒動。
--      回傳多兩欄（arm、opened_by）：opened_by＝開窗的規則＋里程碑列（basis／rule_id／override_id／election_id／milestone_kind／milestone_on_date／
--      expected_open_on，沒有的欄位不寫），給 seed 寫進 task_dispatches.opened_by（計畫 2.5 第 2 點）。
--      **這一步改了回傳型別**，所以是 DROP FUNCTION＋CREATE（CREATE OR REPLACE 不能改 RETURNS TABLE）。CLAUDE.md 的「改 SQL 函式簽名要分兩次上」
--      是為了「CI 先 db push、中間幾分鐘舊的 Edge Function 碰到新簽名會炸」——2026-10-08 唯讀查正式庫：呼叫它的只有 seed_auto_task_queue()（pg_cron）與
--      task_boost_matches(jsonb)（兩者都用欄位名取值、不靠欄位數量；task_boost_matches 在這支 migration 之後仍是原樣可用），沒有 Edge Function 直接 RPC
--      它，也沒有視圖或其他物件相依，所以同一支 migration 內 DROP＋CREATE＋改 seed 是安全的（單一交易，沒有中間狀態）。
--   4. seed_auto_task_queue()：本體＝P0 的定義，只機械式把新增派工列時的 opened_by 從寫死的 '{"basis":"seed"}' 改成 g.opened_by（規則帶來的出生資訊）。
--      P0 的觸發器把 opened_by 抄進 gap_events（rule_id、election_id、milestone_kind、milestone_on_date）。
--   5. activity_health 加「arm_without_rule」（每支臂至少一條規則）；新視圖 gap_open_lateness（計畫 2.5 第 4 點的對帳：expected_open_on 與實際 opened 時間
--      差 > 1 天的缺口，P1 全是「永遠開」所以沒有 expected_open_on，視圖是空的，P2 起才有東西）。
--
-- 沒做（不在這一期）：各臂內部的日期條件（P2，一臂一個 PR）；elections 的 status／key（P4）；gap_events 的關閉原因分 window／filled
--   （要等第一支真的用窗口關掉缺口的臂，P2 才分得出來——現在規則都是永遠開，收回只可能是缺口補上了）。
--
-- 守門：supabase/functions/_shared/activity-arms.test.ts（文字層：arms／seed／health 都是前一版加機械式替換，臂名清單與本體一致、
--   raw 的任務型別都有活動名；PGlite：28 個分支 stub 回放資料，新舊總表逐件相同、關掉規則守門會紅、每條都有還原驗證）；
--   scripts/arms-parity.ts：正式庫唯讀快照（28 個分支的真實輸出）灌進 PGlite，新舊總表筆數與全欄雜湊三方相等（不進 CI，PR 說明有結果）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：contribution_auto_tasks_raw／deadline_due 與 26 支臂、roster_scope_covers(text, text)、
-- election_id_or_null(text)、P0 的 activity_rules／activity_open／activity_health／gap_events／task_dispatches.opened_at／opened_by、unnest。

-- ------------------------------------------------------------
-- 1. 活動名清單（健康檢查用）
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
    'owner_mismatch'
  ]::TEXT[]
$$;
COMMENT ON FUNCTION activity_arm_names IS
  '派工總表 contribution_auto_tasks_arms() 的活動名清單（28 個 UNION 分支；raw 依任務型別拆成 raw:<型別>）。新增一支臂時：這裡加名字、總表加分支與標籤、activity_rules 種一條規則——'
  '漏任何一步，activity_health 的 arm_without_rule 或守門測試會紅。2026-10-08（PLAN-task-activation 3.1）';

-- ------------------------------------------------------------
-- 2. 規則種子：每個活動一條「永遠開」（行為不變）
-- ------------------------------------------------------------
INSERT INTO activity_rules (activity, window_kind, note)
SELECT a.arm, 'always', 'P1 種子：永遠開（派工輸出與沒有時間窗時逐件相同）；P2 起一支臂一個 PR，換成相對里程碑的窗口'
  FROM unnest(activity_arm_names()) AS a(arm)
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm);

-- 萬一上面沒種齊，下面換掉總表就會把整支臂濾光，seed 隔一輪就把派工列全收回——寧可讓這支 migration 失敗
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(activity_arm_names()) AS a(arm)
              WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm AND r.enabled)) THEN
    RAISE EXCEPTION 'P1：有活動沒有啟用中的規則，不能換總表（會把那支臂的缺口整批濾掉）';
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 3. contribution_auto_tasks_arms：貼臂名＋過規則（回傳多 arm、opened_by 兩欄）
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS contribution_auto_tasks_arms();
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),
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
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on
    FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d) k
    CROSS JOIN LATERAL (
      SELECT * FROM activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on)) AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '全站自動缺口總表：28 個分支 UNION，每個分支貼臂名（arm），再依 activity_rules／activity_overrides 過濾（沒有開窗的規則＝濾掉；P1 規則都是永遠開，輸出與前一版逐件相同）。'
  'opened_by＝開窗的規則＋里程碑（seed 寫進 task_dispatches.opened_by）。seed_auto_task_queue() 每 10 分鐘算一次（約 1.5 秒）。2026-10-08';

-- ------------------------------------------------------------
-- 4. seed_auto_task_queue：新增派工列時 opened_by 帶規則（其餘照 P0）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM contribution_auto_tasks_arms() g ORDER BY g.task_id;

  -- 已經不存在的缺口（補上了）：收回號碼牌
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id;

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(), g.opened_by
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
-- 5. 健康檢查與對帳
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW activity_health AS
  SELECT 'election_without_polling'::TEXT AS check_name, e.id::TEXT AS subject, '選舉沒有投票日（elections.election_date 是空的），所有以投票日為起點的規則都開不起來'::TEXT AS detail
    FROM elections e WHERE e.election_date IS NULL
  UNION ALL
  SELECT 'activity_all_rules_disabled', r.activity, '這個活動的規則全部停用，等於整類任務不派（要停就用覆寫 closed 留下理由）'
    FROM activity_rules r GROUP BY r.activity HAVING NOT bool_or(r.enabled)
  UNION ALL
  SELECT 'override_without_rule', o.activity, '有覆寫但這個活動沒有任何規則（拼錯活動名？）'
    FROM activity_overrides o WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = o.activity) GROUP BY o.activity
  UNION ALL
  SELECT 'window_inverted', 'rule ' || r.id || ' / election ' || f.election_id,
         '起日 ' || (f.on_date + r.from_offset) || ' 晚於迄日 ' || (u.on_date + r.until_offset) || '，這條規則在這場選舉永遠不會開'
    FROM activity_rules r
    JOIN election_milestones_all f ON f.kind = r.from_kind
    JOIN election_milestones_all u ON u.kind = r.until_kind AND u.election_id = f.election_id
         AND (u.election_type IS NOT DISTINCT FROM f.election_type OR u.election_type IS NULL OR f.election_type IS NULL)
   WHERE r.enabled AND f.on_date + r.from_offset > u.on_date + r.until_offset
  UNION ALL
  SELECT 'milestone_scope_drift', s.election_id || ' / ' || s.election_type,
         'roster_check_scope 的登記截止／名單公告日與 election_milestones 對不上（兩份真相）：改了舊欄位沒同步到里程碑，或相反'
    FROM roster_check_scope s
   WHERE NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = s.election_id AND m.kind = 'registration_close'
                        AND m.election_type = s.election_type AND m.on_date = s.registration_closed_on)
      OR NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = s.election_id AND m.kind = 'list_published'
                        AND m.election_type = s.election_type AND m.on_date = s.list_announced_on)
  UNION ALL
  SELECT 'arm_without_rule', a.arm, '派工臂「' || a.arm || '」沒有任何規則：contribution_auto_tasks_arms() 對它的每一列都會因為沒有開窗的規則而被濾掉（整支臂無聲消失）'
    FROM unnest(activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm)
  UNION ALL
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 與里程碑對不上、'
  '派工臂沒有任何規則（arm_without_rule，P1）、時鐘被覆寫。2026-10-08（PLAN-task-activation 3 風險第 2 點）';

-- 規則說「該開」的日子與缺口實際出生的日子差超過 1 天的缺口（台北日界）。差距＝排程漏跑、規則寫錯，或資料本身晚到（例：窗口 11-29 開，但那位候選人 12-20 才進資料庫）——
-- 後者不是 bug，所以這是「要看的清單」不是警報；沒有 expected_open_on 的（永遠開、只有迄點的規則）不列。P1 的規則全是永遠開，所以現在是空的
CREATE OR REPLACE VIEW gap_open_lateness AS
  SELECT e.task_id, e.task_type, e.event, e.at, e.rule_id, e.election_id, e.milestone_kind, e.milestone_on_date,
         (e.detail->>'expected_open_on')::DATE AS expected_open_on,
         (e.at AT TIME ZONE 'Asia/Taipei')::DATE - (e.detail->>'expected_open_on')::DATE AS late_days
    FROM gap_events e
   WHERE e.event IN ('opened', 'reopened')
     AND e.detail ? 'expected_open_on'
     AND (e.at AT TIME ZONE 'Asia/Taipei')::DATE - (e.detail->>'expected_open_on')::DATE > 1;
COMMENT ON VIEW gap_open_lateness IS
  '缺口出生對帳（計畫 2.5 第 4 點）：expected_open_on（里程碑日期＋偏移＝規則說該開的日子）與 opened／reopened 事件時間（台北日界）差超過 1 天的缺口。'
  'P1 規則全是永遠開、沒有 expected_open_on，所以是空的；P2 起每條相對里程碑的規則才有東西。差距可能是排程漏跑、規則寫錯，也可能只是資料晚到。2026-10-08';

COMMENT ON COLUMN task_dispatches.opened_by IS
  '缺口是因為哪一筆資料被開出來的：seed 寫 contribution_auto_tasks_arms() 帶來的 {"basis":"rule","arm":臂名,"rule_id":…,"election_id":…,"milestone_kind":…,"milestone_on_date":…,"expected_open_on":…}（沒有的欄位不寫；'
  '覆寫開的是 basis=override＋override_id）；回填的既有列是 {"basis":"backfill"}；/next 的 task_dispatched 新增的列是 {"basis":"insert"}';
