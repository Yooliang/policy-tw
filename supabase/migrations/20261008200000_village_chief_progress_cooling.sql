-- 村里長不主動追進度；有人看才追；查無公開進度冷卻遞增，政見頁標「查無公開進度」（#470，2026-10-08 維護者裁示）
-- ============================================================
--
-- 起因：村里長人多（2026 登記 14,100 人）、媒體少，進度追蹤任務查不到就冷卻、14 天後再派，一直重複。維護者 10-08 裁示四點：
--   1. 村里長只收政見與結果，不主動派進度追蹤（用規則限定職位關窗）。維護者同日追加：村里長的「補該屆政見」term_policy_missing 也先停
--   2. 有人關心才追蹤：網站請求、公民提問已經是手動任務臂（#453），不受影響；村里長的人物頁或政見頁在 page_traffic_hot（#474）達標也開窗
--   3. 查無公開進度時冷卻遞增：同一個任務第一次查無（outcome=not_found）冷卻 14 天，第二次起 30 天；天數放設定表、可調
--   4. 政見處於這個冷卻中時，政見頁與人物頁的進度區塊標「查無公開進度」（只放標籤，冷卻結束或缺口消失自動消失）
--
-- 做法（逐點）：
--
--   1. 關窗＝規則，不改臂本體。進度追蹤的兩個活動 raw:progress_stale、deadline_due，加上維護者追加要先停的 term_policies（補該屆政見，產出 term_policy_missing）——三個活動的 P1「永遠開」規則（rule_id 不變）原地加上 except_election_types＝{村里長}。
--      為什麼新增「排除」欄而不是用 election_types 列出其餘 8 種職位：這兩支臂的 target 沒有 election_type（只有 policy_id、politician_id、election_id），
--      activity_open 對「職位未知」的處理是「有限定職位的規則比對不到」，列出其餘職位會讓所有職位未知的列（2026-10-08 正式庫 43 件 progress_stale 缺口裡有 3 件在那一屆沒有參選紀錄）被無聲關掉；
--      排除欄在職位未知時不排除，寧可開著。日後新增職位（例如新的選舉別）也不會被正向清單漏掉。
--      職位從哪來：總表 keyed 那一段，臂有「要看職位」的規則（except_election_types 有值）時，target 沒有 election_type 的列，職位改取這個人在這一屆（target.election_id）的參選紀錄
--      politician_elections.election_type（一個人一屆一個職位；查不到就維持未知）。其餘臂的分組一個字不變，target 本身也不動，所以派工輸出逐件不變。
--      term_policies 的 target 自己帶 election_type，不需要補查。
--      暫時無法限定的（進度兩支臂）：target 沒有 election_id 的列（沒標屆別的政見）、人物在那一屆沒有參選紀錄的列——它們維持開著（照舊）。2026-10-08 正式庫：這兩種都沒有村里長的政見。
--      收回走既有機制：窗口關了，seed 下一輪把派工列收回，原因記 window。
--
--   2. 流量開窗＝同一個活動多一條規則（OR），規則多一個旗標 requires_traffic：活動 raw:progress_stale、deadline_due、term_policies 各種一條「職位＝村里長、永遠開、requires_traffic」的規則。
--      為什麼不在 activity_open 裡 OR 流量訊號：activity_open 是「臂×選舉×職位」一組問一次（約 84 組），流量訊號卻是「這一頁」的（人物或政見），
--      放進去就要改它的簽名（多一個人物／政見參數）而且每組變成每列問一次；而且它分不出「被排除職位關著」與「窗口沒到關著」——流量只該打開前者。
--      做法：規則只回答「這一組（臂×選舉×職位）有沒有一條規則願意開」，旗標 requires_traffic 讓總表在列這一層再加一道：這一列 target 的 politician_id 在 page_traffic_hot
--      （kind＝politician）或 policy_id 在 page_traffic_hot（kind＝policy）才算開。流量退了（或資料過期）下一輪 seed 照 window 收回。activity_open 簽名、回傳欄位不動。
--      代價與量測見 PLAN 第 11 節：總表多一個 CTE（needs_etype）、keyed 多一個只對進度兩支臂查的子查詢、opened 每組多一次規則表查詢、列層多一個 LATERAL（只有旗標為真的列才查 page_traffic_hot）。
--
--   3. 冷卻遞增＝只套進度追蹤類（設定表 task_cooldown_settings.task_types，初值 progress_stale、deadline_due）。現行冷卻（refresh_dispatch_blocked → task_dispatches.cooling）
--      對所有 auto: 任務一律 task_checks 14 天（unreachable 2 天）；為了「不改既有其他任務行為」，其他任務型別、其他 outcome 一個字不變。
--      新函式 task_check_cooldown_days_for(task_id, outcome, checked_at, id) 回傳「這一筆查核紀錄」的冷卻天數：unreachable 照舊 2 天；
--      型別在 task_types、outcome＝not_found、設定開著 → 這是該任務第幾次 not_found（照 checked_at、id 排）：第 1 次 not_found_first_days（14）、第 2 次起 not_found_repeat_days（30）；其餘照舊 14 天。
--      refresh_dispatch_blocked 只把原本的 CASE 換成這個函式呼叫（現行定義＋一處機械替換）。天數與型別名單全在表裡，函式裡沒有寫死的天數。
--      「查無」＝outcome='not_found'。confirmed（確認無誤，例：進度沒變）、unreachable（打不開）、NULL（2026-09-21 之前沒有 outcome 的舊資料）都不算查無、不累計。
--      追溯：歷史上已經有兩次 not_found 的任務，第二次那筆就是 30 天（正式庫目前 2 件，見 PLAN 第 11 節）。
--
--   4. 標籤＝既有讀取端多一欄。視圖 policies_with_logs 最後多 no_public_progress（boolean），由函式 policy_no_public_progress(政見 id) 算：
--      這條政見的 progress_stale／deadline_due 缺口現在還在派工列裡（task_dispatches 有這一列＝缺口還沒補上；新進度上線缺口消失、seed 收回，標籤跟著消失），
--      而且它有一筆 not_found 的查核紀錄還在冷卻內（天數同第 3 點的函式）。前端（政見頁、人物頁的政見卡）只讀這一欄，不另外查清單，只放標籤、不放說明文字。
--
-- 不做：不改臂本體（contribution_auto_tasks_raw／deadline_due 一個字不動）、不改 seed_auto_task_queue、rebalance_queue、task_dispatched、優先層；
--   （term_policy_missing 本來不在這支的範圍，維護者 10-08 追加後併入：村里長一次最多 term_policy_village_cap() 件的補該屆政見也先停，正式庫現行 300 件在下一輪 seed 以 window 收回；村里長的 2026 補政見 policy_missing、補基本資料、選舉結果不受影響。）
--
-- 同簽名：activity_open、contribution_auto_tasks_arms、refresh_dispatch_blocked 都是 CREATE OR REPLACE 同簽名、同回傳型別；policies_with_logs 只在最後多一欄；
--   新欄位／新函式／新表都是只加不刪，先於程式上線沒有風險（前端讀不到 no_public_progress 時當 false）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：activity_rules（含 id 5、24 的 P1 種子規則）、page_traffic_hot（#474）、task_checks(id, task_id, checked_at, outcome)、
--   task_dispatches(task_id, cooling)、politician_elections(id, politician_id, election_id, election_type)、uuid_or_null、election_id_or_null、task_check_cooldown_days()、task_unreachable_cooldown_days()、
--   activity_audit()、activity_touch_updated_at()、auth.role()。

-- ------------------------------------------------------------
-- 1. activity_rules：排除職位、要流量才開（只加欄位）
-- ------------------------------------------------------------
ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS except_election_types TEXT[];
ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS requires_traffic BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE activity_rules DROP CONSTRAINT IF EXISTS activity_rules_except_known;
ALTER TABLE activity_rules ADD CONSTRAINT activity_rules_except_known CHECK (
  except_election_types IS NULL OR (
    cardinality(except_election_types) > 0
    AND except_election_types <@ ARRAY['總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']::TEXT[]
    AND election_types IS NULL)  -- 正向清單與排除清單二選一，不同時用
);
ALTER TABLE activity_rules DROP CONSTRAINT IF EXISTS activity_rules_traffic_shape;
ALTER TABLE activity_rules ADD CONSTRAINT activity_rules_traffic_shape CHECK (NOT requires_traffic OR activity NOT LIKE 'priority:%');  -- 優先層規則只管排序，沒有「流量才開」
COMMENT ON COLUMN activity_rules.except_election_types IS
  '排除的職位（election_types 的反面，二選一）：這條規則對這些職位不成立。職位未知（NULL）時不排除。例：進度追蹤對村里長關窗＝「永遠開、排除村里長」＋另一條「只有村里長、要流量」。2026-10-08（#470）';
COMMENT ON COLUMN activity_rules.requires_traffic IS
  'true＝這條規則開窗的前提是「這一列任務的人物頁或政見頁現在在 page_traffic_hot（#474）」。activity_open 只回答這一組（臂×選舉×職位）有沒有規則願意開；流量是列層的條件，由總表 contribution_auto_tasks_arms 在列這一層判斷。2026-10-08（#470）';

-- ------------------------------------------------------------
-- 2. activity_open：20261008001000（P0）的現行定義＋一行（排除職位）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION activity_open(
  p_activity TEXT, p_election_id INTEGER DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT activity_today()
) RETURNS TABLE (
  source TEXT, rule_id BIGINT, override_id BIGINT, election_id INTEGER, election_type TEXT,
  milestone_kind TEXT, milestone_on_date DATE, expected_open_on DATE, open_until DATE
)
LANGUAGE sql STABLE AS $$
  WITH el AS (SELECT e.id, e.election_reason FROM elections e WHERE e.id = p_election_id),
  ov AS (
    SELECT o.id, o."force", o.open_from, o.open_until
      FROM activity_overrides o
     WHERE o.activity = p_activity
       AND (o.election_id IS NULL OR o.election_id = p_election_id)
       AND (o.election_type IS NULL OR o.election_type = p_election_type)
       AND (o.expires_at IS NULL OR p_today <= o.expires_at)
  ),
  ov_open AS (
    SELECT o.* FROM ov o
     WHERE o."force" = 'open'
        OR (o."force" = 'window' AND (o.open_from IS NULL OR p_today >= o.open_from) AND (o.open_until IS NULL OR p_today <= o.open_until))
  ),
  rule_rows AS (
    SELECT r.id AS rid, f.kind AS mkind, f.on_date AS mdate,
           CASE WHEN f.on_date IS NOT NULL THEN f.on_date + r.from_offset END AS xopen,
           CASE WHEN u.on_date IS NOT NULL THEN u.on_date + r.until_offset END AS xuntil
      FROM activity_rules r
      LEFT JOIN el ON true
      LEFT JOIN LATERAL (
        SELECT m.kind, m.on_date, m.status FROM election_milestones_all m
         WHERE m.election_id = p_election_id AND m.kind = r.from_kind
           AND (m.election_type IS NOT DISTINCT FROM p_election_type OR m.election_type IS NULL)
         ORDER BY (m.election_type IS NULL) LIMIT 1
      ) f ON true
      LEFT JOIN LATERAL (
        SELECT m.kind, m.on_date, m.status FROM election_milestones_all m
         WHERE m.election_id = p_election_id AND m.kind = r.until_kind
           AND (m.election_type IS NOT DISTINCT FROM p_election_type OR m.election_type IS NULL)
         ORDER BY (m.election_type IS NULL) LIMIT 1
      ) u ON true
     WHERE r.enabled
       AND r.activity = p_activity
       AND (r.reasons IS NULL OR el.election_reason = ANY (r.reasons))
       AND (r.levels IS NULL OR activity_level(p_election_type) = ANY (r.levels))
       AND (r.election_types IS NULL OR p_election_type = ANY (r.election_types))
       AND (r.except_election_types IS NULL OR p_election_type IS NULL OR NOT (p_election_type = ANY (r.except_election_types)))  -- 排除職位：職位未知（NULL）時不排除，寧可開著也不無聲關掉
       AND (r.jurisdictions IS NULL OR EXISTS (
              SELECT 1 FROM unnest(r.jurisdictions) AS j(x)
               WHERE activity_jurisdiction(p_election_id) = j.x OR activity_jurisdiction(p_election_id) LIKE j.x || ':%'))
       AND (
         r.window_kind = 'always'
         OR (
           (r.from_kind IS NULL OR (f.on_date IS NOT NULL AND p_today >= f.on_date + r.from_offset))
           AND (r.until_kind IS NULL OR (u.on_date IS NOT NULL AND p_today <= u.on_date + r.until_offset))
           AND (r.recur_months IS NULL OR EXTRACT(MONTH FROM p_today)::INTEGER <@ r.recur_months)
           AND activity_status_rank(CASE WHEN r.from_kind IS NOT NULL THEN f.status ELSE u.status END) >= activity_status_rank(r.min_status)
         )
       )
  )
  SELECT x.source, x.rule_id, x.override_id, x.election_id, x.election_type, x.milestone_kind, x.milestone_on_date, x.expected_open_on, x.open_until
    FROM (
      SELECT 'override'::TEXT AS source, NULL::BIGINT AS rule_id, o.id AS override_id, p_election_id AS election_id, p_election_type AS election_type,
             NULL::TEXT AS milestone_kind, NULL::DATE AS milestone_on_date, o.open_from AS expected_open_on, o.open_until AS open_until
        FROM ov_open o
       WHERE NOT EXISTS (SELECT 1 FROM ov WHERE ov."force" = 'closed')
      UNION ALL
      SELECT 'rule'::TEXT, rr.rid, NULL::BIGINT, p_election_id, p_election_type, rr.mkind, rr.mdate, rr.xopen, rr.xuntil
        FROM rule_rows rr
       WHERE NOT EXISTS (SELECT 1 FROM ov)
    ) x
   ORDER BY x.expected_open_on NULLS LAST, x.rule_id NULLS LAST, x.override_id NULLS LAST
$$;

-- ------------------------------------------------------------
-- 3. 規則：進度追蹤兩個活動與補該屆政見（term_policies）對村里長關窗，村里長的頁面有流量才開
--    P1 的「永遠開」種子規則原地（rule_id 不變）加排除；新增一條只有村里長、要流量的規則
-- ------------------------------------------------------------
UPDATE activity_rules
   SET except_election_types = ARRAY['村里長'],
       note = '#470：永遠開，但不含村里長（村里長只收政見與結果，不主動追進度；有流量才開見同一活動的另一條規則）。原 P1 種子，rule_id 不變'
 WHERE activity IN ('raw:progress_stale', 'deadline_due', 'term_policies')
   AND window_kind = 'always' AND election_types IS NULL AND except_election_types IS NULL AND NOT requires_traffic;

INSERT INTO activity_rules (activity, window_kind, election_types, requires_traffic, note)
SELECT a.activity, 'always', ARRAY['村里長'], true,
       '#470：村里長的進度追蹤（含補該屆政見）只在「這一列的人物頁或政見頁現在在 page_traffic_hot（#474）」時才開；流量退了、資料過期，下一輪 seed 照 window 收回'
  FROM (VALUES ('raw:progress_stale'), ('deadline_due'), ('term_policies')) AS a(activity)
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.activity AND r.requires_traffic AND r.election_types = ARRAY['村里長']);

-- 沒有 P1 種子可更新（例如被人刪了）就整支失敗，不替人決定
DO $$
DECLARE v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM activity_rules r
   WHERE r.activity IN ('raw:progress_stale', 'deadline_due', 'term_policies') AND r.window_kind = 'always' AND r.except_election_types = ARRAY['村里長'] AND r.enabled;
  IF v_n <> 3 THEN RAISE EXCEPTION '村里長進度：預期 raw:progress_stale、deadline_due、term_policies 各有一條「永遠開、排除村里長」的規則，實際 % 條', v_n; END IF;
  SELECT count(*) INTO v_n FROM activity_rules r
   WHERE r.activity IN ('raw:progress_stale', 'deadline_due', 'term_policies') AND r.requires_traffic AND r.election_types = ARRAY['村里長'] AND r.enabled;
  IF v_n <> 3 THEN RAISE EXCEPTION '村里長進度：預期三個活動各有一條「村里長、要流量」的規則，實際 % 條', v_n; END IF;
END
$$;

-- ------------------------------------------------------------
-- 4. 總表 contribution_auto_tasks_arms：20261008165000 的現行定義＋三處機械替換
--    ① keyed：臂有「要看職位」的規則時，target 沒有職位的列從參選紀錄補 ② opened：帶出規則的 requires_traffic ③ 列層：requires_traffic 的規則要這一列的頁面在 page_traffic_hot
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
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       -- >>> 村里長進度：target 沒有職位的臂（進度追蹤的 progress_stale、deadline_due），若這支臂有規則要看職位（except_election_types），職位從人物在那一屆的參選紀錄補；其餘臂的分組一個字不變
       needs_etype AS MATERIALIZED (SELECT DISTINCT r.activity FROM activity_rules r WHERE r.enabled AND r.except_election_types IS NOT NULL),
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
-- 5. 查無公開進度的冷卻遞增：設定表、冷卻天數函式、refresh_dispatch_blocked
-- ------------------------------------------------------------
-- 為什麼另建一張表而不是加進 traffic_boost_settings：那張是頁面流量提層的參數（單列、欄位全是流量），冷卻跟流量無關；
-- 做法照它的慣例（單列 id=1、CHECK、公開讀／service_role 寫、updated_at 與審計觸發器），改值是一行 UPDATE 並進 edit_history。
CREATE TABLE IF NOT EXISTS task_cooldown_settings (
  id                    SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled               BOOLEAN NOT NULL DEFAULT true,
  not_found_first_days  INTEGER NOT NULL DEFAULT 14 CHECK (not_found_first_days BETWEEN 1 AND 365),
  not_found_repeat_days INTEGER NOT NULL DEFAULT 30 CHECK (not_found_repeat_days BETWEEN 1 AND 365),
  task_types            TEXT[] NOT NULL DEFAULT ARRAY['progress_stale', 'deadline_due'] CHECK (cardinality(task_types) > 0),
  note                  TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE task_cooldown_settings IS
  '查無公開進度的冷卻遞增（單列 id=1）。task_types 裡的任務型別（初值 progress_stale、deadline_due，task_id 是 auto:<型別>:<政見 id>）：同一個任務第一次回報 not_found 冷卻 not_found_first_days 天，第二次起 not_found_repeat_days 天；'
  '其他任務型別、其他 outcome（confirmed、unreachable、舊資料 NULL）的冷卻不受影響（task_check_cooldown_days()＝14、task_unreachable_cooldown_days()＝2）。改值一行 UPDATE（每次修改進 edit_history，agent_name=activity-audit）。2026-10-08（#470）';
COMMENT ON COLUMN task_cooldown_settings.enabled IS 'false＝回到所有任務一律 14 天（not_found 不遞增、也不套 task_types）';
COMMENT ON COLUMN task_cooldown_settings.task_types IS '套用遞增的任務型別；要是 policy_missing 那種以政見 id 為鍵的任務才有「政見處於冷卻」可標（policy_no_public_progress 也讀這份名單）';
INSERT INTO task_cooldown_settings (id, note) VALUES (1, '初值：進度追蹤類（progress_stale、deadline_due）第一次查無 14 天、第二次起 30 天（維護者 2026-10-08，#470）') ON CONFLICT (id) DO NOTHING;

ALTER TABLE task_cooldown_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON task_cooldown_settings;
CREATE POLICY "Public read" ON task_cooldown_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON task_cooldown_settings;
CREATE POLICY "Service role write" ON task_cooldown_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_task_cooldown_settings_touch ON task_cooldown_settings;
CREATE TRIGGER trg_task_cooldown_settings_touch BEFORE UPDATE ON task_cooldown_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_task_cooldown_settings_audit ON task_cooldown_settings;
CREATE TRIGGER trg_task_cooldown_settings_audit AFTER INSERT OR UPDATE OR DELETE ON task_cooldown_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- 一筆查核紀錄（task_checks 一列）的冷卻天數。第幾次 not_found 照 (checked_at, id) 排；只數同一個 task_id 的 not_found。
CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()
           WHEN p_outcome = 'not_found' AND s.enabled AND split_part(p_task_id, ':', 2) = ANY (s.task_types)
             THEN CASE WHEN (SELECT count(*) FROM task_checks x
                              WHERE x.task_id = p_task_id AND x.outcome = 'not_found' AND (x.checked_at, x.id) <= (p_checked_at, p_id)) >= 2
                       THEN s.not_found_repeat_days ELSE s.not_found_first_days END
           ELSE task_check_cooldown_days()
         END
    FROM (SELECT 1) AS one LEFT JOIN task_cooldown_settings s ON s.id = 1
$$;
COMMENT ON FUNCTION task_check_cooldown_days_for IS
  '一筆 task_checks 的冷卻天數：unreachable＝task_unreachable_cooldown_days()；型別在 task_cooldown_settings.task_types 且 outcome＝not_found 且設定開著＝第一次 not_found_first_days、第二次起 not_found_repeat_days；'
  '其餘＝task_check_cooldown_days()（與 20261002000006 之前一字不差的行為）。refresh_dispatch_blocked 與 policy_no_public_progress 共用。2026-10-08（#470）';

-- refresh_dispatch_blocked：20261002000006 的現行定義＋一處機械替換（冷卻天數的 CASE 改問函式）
CREATE OR REPLACE FUNCTION refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  WITH saturated AS (
    SELECT c.task_id FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed')
    GROUP BY c.task_id HAVING COUNT(*) >= 5
  ), nochange AS (
    SELECT DISTINCT c.payload->>'task_id' AS task_id FROM contributions c
    WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified')
      AND c.payload->>'task_id' IS NOT NULL
  ), b AS (
    SELECT task_id FROM saturated UNION SELECT task_id FROM nochange
  )
  , cool AS (
    SELECT DISTINCT tc.task_id FROM task_checks tc
    WHERE tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL
  )
  UPDATE task_dispatches d
     SET blocked = EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id),
         cooling = EXISTS (SELECT 1 FROM cool c WHERE c.task_id = d.task_id)
   WHERE d.task_id LIKE 'auto:%'
     AND (d.blocked IS DISTINCT FROM EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id)
       OR d.cooling IS DISTINCT FROM EXISTS (SELECT 1 FROM cool c WHERE c.task_id = d.task_id));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 6. 「查無公開進度」標籤：政見處於查無冷卻中（視圖 policies_with_logs 最後一欄 no_public_progress）
-- ------------------------------------------------------------
-- 條件（缺一不可）：① 這條政見的進度追蹤缺口現在還在派工列裡（task_dispatches 有 auto:<型別>:<政見 id>；新進度上線、缺口補上，seed 收回，標籤跟著消失）
--   ② 同一個 task_id 有一筆 outcome＝not_found 的 task_checks 還在它自己的冷卻內（天數＝task_check_cooldown_days_for，冷卻結束標籤就消失）
-- 型別名單讀 task_cooldown_settings.task_types（task_id 是 auto:<型別>:<政見 id> 的那些）。設定關掉（enabled＝false）時 not_found 回到 14 天，標籤照 14 天算。
CREATE OR REPLACE FUNCTION policy_no_public_progress(p_policy_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM task_cooldown_settings s
      CROSS JOIN LATERAL unnest(s.task_types) AS t(task_type)
      JOIN task_dispatches d ON d.task_id = 'auto:' || t.task_type || ':' || p_policy_id::TEXT
      JOIN task_checks c ON c.task_id = d.task_id AND c.outcome = 'not_found'
     WHERE s.id = 1
       AND c.checked_at > now() - (task_check_cooldown_days_for(c.task_id, c.outcome, c.checked_at, c.id) || ' days')::INTERVAL
  )
$$;
COMMENT ON FUNCTION policy_no_public_progress IS
  '這條政見現在是不是「查無公開進度」：進度追蹤缺口（task_cooldown_settings.task_types 的任務型別）還在派工列，而且有一筆 not_found 的查核紀錄還在冷卻內。policies_with_logs.no_public_progress 用它；前端只讀那一欄、只放標籤。2026-10-08（#470）';

-- 視圖：20261007150000 的現行定義，只在最後多一欄（CREATE OR REPLACE VIEW 只能在最後加欄；policies 的欄位沒變，p.* 展開與現行視圖前 24 欄一致）
CREATE OR REPLACE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object('id', tl.id, 'date', tl.date, 'event', tl.event, 'description', tl.description,
                        'sources', source_brief_list('tracking_logs', tl.id::text))
      ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'element', e.element, 'stated', e.stated, 'text', e.text, 'deadline_date', e.deadline_date,
        'source_locator', e.source_locator, 'source_url', e.source_url, 'updated_at', e.updated_at,
        'source', (SELECT json_build_object('url', s.url, 'title', s.title, 'publisher', s.publisher,
                                            'kind', s.source_kind, 'archive_url', s.archive_url)
                     FROM source_refs r JOIN sources s ON s.id = r.source_id
                    WHERE r.target_table = 'policy_elements' AND r.target_id = e.id::text AND r.role = 'primary'
                    LIMIT 1)
      )
      ORDER BY array_position(ARRAY['target', 'deadline', 'funding'], e.element)
    )
    FROM policy_elements e
    WHERE e.policy_id = p.id),
    '[]'::json
  ) AS elements,
  (SELECT json_build_object('id', l.id, 'title', l.title, 'level', l.level, 'region', l.region, 'sub_region', l.sub_region,
                            'category', l.category, 'summary', l.summary)
     FROM lineages l WHERE l.id = p.lineage_id) AS lineage,
  source_brief_list('policies', p.id::text) AS sources,
  policy_no_public_progress(p.id) AS no_public_progress
FROM policies p;
ALTER VIEW policies_with_logs SET (security_invoker = on);
GRANT SELECT ON policies_with_logs TO anon, authenticated;
COMMENT ON VIEW policies_with_logs IS
  '政見＋進度紀錄＋相關政見＋三要素＋脈絡＋出處＋查無公開進度標記。新欄位一律接在最後（目前最後是 no_public_progress，#470；之前是 sources，#347 第二階段 A）；policies 加欄位時 p.* 會插在中間，要 DROP＋CREATE。'
  '#347 第二階段 B-2 起 policies 沒有 source_url 欄、logs[] 沒有舊鍵 source_url：出處一律讀 sources。no_public_progress＝這條政見的進度追蹤正處於「查無」的冷卻中（task_cooldown_settings），前端只標「查無公開進度」';

-- ------------------------------------------------------------
-- 7. 結尾自檢（對不上整支退回）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM task_cooldown_settings WHERE id = 1) THEN RAISE EXCEPTION 'task_cooldown_settings 沒有 id=1 這一列'; END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'policies_with_logs' AND column_name = 'no_public_progress') <> 1 THEN
    RAISE EXCEPTION 'policies_with_logs 沒有 no_public_progress 這一欄';
  END IF;
  IF (SELECT ordinal_position FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'policies_with_logs' AND column_name = 'no_public_progress')
     <> (SELECT max(ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'policies_with_logs') THEN
    RAISE EXCEPTION 'no_public_progress 必須是視圖的最後一欄';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
