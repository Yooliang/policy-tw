-- 手動任務也是一支派工臂：網站請求與公民提問排在所有加推之前，固定時段再插隊一次（2026-10-08，維護者）
-- ============================================================
--
-- 起因（維護者 10-08）：「網站請求裡面的任務每 6 小時幫忙插隊一次，因為這個是有人在關注的東西」，公民提問一起照辦；「網站請求也可以視為一種缺口」。
-- 正式庫唯讀盤點：沒派過的 web_request 在 TS 的 manualQueueAt 是 1980-01-01，但 task_boost 把加推設成 1980 減 n 分鐘，加推排在前面；
-- 57 筆 open 的 web_request（policy_missing 34、profile_gap 21、progress_stale 2）被擠到後面，最早一筆 09-26 建的。
-- 先前的做法（#453 第一版）在 /next 現撈 contribution_tasks 清單、現算 manualQueueAt，違反 09-23 Disk IO 事故後的裁決（#233／#234：缺口內容由排程寫進
-- task_dispatches、/next 只讀佇列）。這支改成：
--
-- 一、open 的手動任務（contribution_tasks）是派工臂，走跟其他缺口完全一樣的路
--   * 臂本體 contribution_auto_tasks_manual(p_visitor)：輸出 open 的任務。task_id＝任務 uuid（不加 auto: 前綴）、task_type／target／hint_sources／reward／region 從任務表帶，
--     what_we_need＝description（沒有就用 title）。target 另外帶 title、region（/queue 預覽的顯示用），公民提問帶 stance_up（支持度，排程算好）；原 target 的鍵優先，不被覆蓋。
--   * 兩個活動名（總表貼臂名）：manual_visitor＝網站請求（source=web_request）與公民提問（task_type=question）、manual_open＝其餘（維護者建、裁決、外部提議…）。
--     照 P1 的三處登記：總表加分支、activity_arm_names() 加名字、activity_rules 種「永遠開」的規則。
--     出生／收回紀錄（gap_events）、任務關閉＝缺口消失（seed 收回）、優先層（#443）全部自動適用：
--     優先層規則 priority:manual_visitor＝前段（層 1），網站請求與公民提問平常就進前段的加權交錯。
--   * task_dispatches 的觸發器（gap_events 出生／收回）原本只管 auto: 列，WHEN 條件改成「不是 verify:」，其餘與 P0 一字不差。
--   * seed_auto_task_queue 的兩處收回原本只看 auto: 列，改成「不是 verify:」（手動任務關閉＝缺口消失，與自動缺口補上同一條路）。
--     任務一關閉，contribution_tasks 上的觸發器也立刻收回它的派工列（不等 10 分鐘），否則關掉的任務還能被領走。
--   * 新增 contribution_queue_tasks()：contribution_auto_tasks 現行版（20261002000006）的複本，只差兩件事——任務列範圍從 auto: 擴到「不是 verify:」，
--     同一個 queue_at 內公民提問依 stance_up 高的先（再依進佇列時間）。/next、rebalance_queue、queue_preview 改讀它；
--     contribution_auto_tasks 本身一個字不動（/tasks、/request-task 照舊只回自動缺口，輸出不變）。
--
-- 二、queue_at 怎麼算（SQL 單一真相，全部在 seed 裡）
--   * 新進佇列：網站請求與公民提問（open）＝1970-01-01（比任何加推都早：加推是 1980-01-01 減 n 分鐘，要 5,258,880 次才追得上）；
--     維護者建的（manual）與裁決（auto_dispute）＝1980-01-01（沿用 manualQueueAt 的 FRONT_SOURCES，一次性）；其餘（suggested）排任務行列的隊尾（跟其他缺口一樣）。
--     這支 migration 套上後第一輪 seed 把 57 筆 open 的 web_request 全部排到 1970（不管以前派過幾次）。
--   * 派出後：task_dispatched() 照所有缺口一樣回到隊尾（queue_slot('task')），回到自己那一層的加權交錯。
--   * 固定時段插隊（維護者）：台北時間每 6 小時（00:00、06:00、12:00、18:00）起的前 20 分鐘，跑在這個時段內的 seed（每 10 分鐘一次，所以時段內跑兩次：:00、:10；:20 已經出時段）
--     把網站請求與公民提問中「本時段開始後還沒派出過」的 open 任務排回 1970；其他時段的 seed 完全不動它們的位置。
--     冪等規則：只拉 dispatch_count＝0（從沒派過）或 last_dispatched_at < 本時段開始時間的列。第二次 seed（:10）時，:00 拉上去之後在時段內被領走的任務
--     last_dispatched_at ≥ 時段開始，不會又被拉回最前；還沒被領走的，再拉一次也是同一個值（不動）。
--     時段定義（每 6 小時、前 20 分鐘、台北時區）是具名函式 visitor_front_slot_hours()、visitor_front_window_minutes()、visitor_front_slot_start()；
--     「現在」讀 queue_now()，測試用 SET app.queue_now = '<timestamptz>' 覆寫（跟 activity_today() 的 app.activity_today 同一套做法；正式環境不該設）。
--   * rebalance_queue 只改一處：可派任務的集合改讀 contribution_queue_tasks，所以手動任務列（queue_at ≥ 2000 的）一起進優先層的加權交錯；
--     queue_at < 2000 的（1970／1980 年段，含加推）照舊不進重排（#443 的做法）。
--
-- 三、/next 只讀佇列
--   TS 端（supabase/functions/next/index.ts）不再撈 contribution_tasks 清單、不再算 manualQueueAt：任務清單改呼叫 contribution_queue_tasks；
--   選中的是手動任務時，用 id 單筆查那一筆的描述等內容（單筆查，不撈清單）。派出時 task_dispatched 蓋章（跟所有缺口一樣），不再寫 contribution_tasks.last_dispatched_at。
--
-- 四、審查補強（agy 審查，維護者 2026-10-08）
--   * 已收滿答案的公民提問不是缺口：任務本身永遠 open（KEEP_OPEN_TASK_TYPES 含 question），不排除就會被寫進佇列、固定時段又被拉回 1970，/next 前 30 筆全被「已滿額」濾掉而回 none。
--     臂本體排除（滿額定義＝TS 的 fullQuestionIdsOf：answer_count＋同一題底下在等票的答案 ≥ question_answer_cap()＝3）；manual_front_pull 只拉臂的輸出，所以也不拉。
--   * 新建（或重開）的手動任務由觸發器 contribution_tasks_insert_dispatch 即時入列（用臂本體的 p_id 只取那一筆），seed 只對帳。
--   * task_dispatches_drop_applied 納入手動任務：這筆貢獻上線就算做完的才即時收回（manual_task_closes_on_applied，同 TS 的 shouldCloseOnApplied；question／adjudicate／roster_check 一題多份，不收）；
--     任務真的被 closeTaskIfFulfilled 關掉時，contribution_tasks 上的觸發器立刻收回。
--   * task_boost_matches 拿掉 contribution_tasks 那一段（總表已含手動任務，不拿掉會算兩次）。
--   * contribution_queue_task_counts()：/next 的 open_tasks 讀佇列計數（全部，不是 30 筆切片）。
--   * activity_health 加 queue_clock_overridden（app.queue_now 假時鐘被設了）。
--   * /next 隊頭手動任務在併發下查不到（剛被關掉）：跳過、往下挑（最多 5 筆），不直接回 none。
--   注意：即時入列的觸發器不經過總表層的過濾（測試名人物隔離等），那些由下一輪 seed 對帳收回——最多 10 分鐘。

-- 沒動：contribution_auto_tasks／其他 28 支臂的內容、refresh_dispatch_blocked（手動任務的飽和／回報查無仍在 TS 過濾，行為不變）、task_dispatched、queue_slot、task_boost（加推手動任務
--   現在改成作用在它的派工列上，LEAST(queue_at, 加推時間)，跟自動缺口一樣）。
-- 守門：supabase/functions/_shared/manual-open-arm.test.ts（每一處替換對現行定義做機械比對；PGlite 跑真的 seed／rebalance／觸發器；假時鐘；還原驗證）。
-- 協議 1.77.0（skill.md 只動佇列順序的說明）。

-- ------------------------------------------------------------
-- 1. 時間、常數與臂本體（單一真相在 SQL）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION queue_now() RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.queue_now', true), '')::TIMESTAMPTZ, now())
$$;
COMMENT ON FUNCTION queue_now IS '派工佇列用的「現在」：預設 now()；測試用 SET app.queue_now 覆寫（假時鐘，跟 activity_today() 的 app.activity_today 同一套）。正式環境不該設。2026-10-08';

CREATE OR REPLACE FUNCTION visitor_front_slot_hours() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$;
COMMENT ON FUNCTION visitor_front_slot_hours IS '網站請求／公民提問固定時段插隊：每幾小時一個時段（台北 00:00、06:00、12:00、18:00 起）。2026-10-08';
CREATE OR REPLACE FUNCTION visitor_front_window_minutes() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 20 $$;
COMMENT ON FUNCTION visitor_front_window_minutes IS '網站請求／公民提問固定時段插隊：每個時段的前幾分鐘內跑的 seed 才動它們。2026-10-08';
CREATE OR REPLACE FUNCTION visitor_front_at() RETURNS TIMESTAMPTZ LANGUAGE sql IMMUTABLE AS $$ SELECT TIMESTAMPTZ '1970-01-01 00:00:00+00' $$;
COMMENT ON FUNCTION visitor_front_at IS '網站請求／公民提問的最前位置：比任何加推（1980-01-01 減 n 分鐘）都早。2026-10-08';

-- 現在若在插隊時段內，回本時段的開始時間（台北時區的整點）；不在時段內回 NULL
CREATE OR REPLACE FUNCTION visitor_front_slot_start(p_now TIMESTAMPTZ DEFAULT queue_now(), p_tz TEXT DEFAULT 'Asia/Taipei') RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN extract(hour FROM l.t)::INTEGER % visitor_front_slot_hours() = 0
               AND extract(minute FROM l.t)::INTEGER < visitor_front_window_minutes()
              THEN date_trunc('hour', l.t) AT TIME ZONE p_tz END
    FROM (SELECT p_now AT TIME ZONE p_tz AS t) l
$$;
COMMENT ON FUNCTION visitor_front_slot_start IS '現在若在固定插隊時段內（台北每 6 小時的前 20 分鐘）回本時段開始時間，否則 NULL。2026-10-08';

-- 有人在網站上等著的任務：網站請求（source=web_request）與公民提問（task_type=question）
CREATE OR REPLACE FUNCTION manual_task_is_visitor(p_source TEXT, p_task_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_source = 'web_request', false) OR COALESCE(p_task_type = 'question', false) $$;
COMMENT ON FUNCTION manual_task_is_visitor IS '派工臂 manual_visitor 的範圍：網站請求（source=web_request）與公民提問（task_type=question）。2026-10-08';

-- 手動任務第一次進佇列的位置：網站請求／公民提問＝1970；維護者建的與裁決＝1980（一次性）；其餘 NULL（排隊尾，跟其他缺口一樣）
CREATE OR REPLACE FUNCTION manual_front_at(p_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN manual_task_is_visitor(t.source, t.task_type) THEN visitor_front_at()
              WHEN t.source IN ('manual', 'auto_dispute') THEN TIMESTAMPTZ '1980-01-01 00:00:00+00' END
    FROM contribution_tasks t WHERE t.id::TEXT = p_task_id
$$;
COMMENT ON FUNCTION manual_front_at IS '手動任務第一次進佇列的位置（seed 新增派工列用）：網站請求／公民提問 1970、維護者建的與裁決 1980、其餘 NULL（排隊尾）。2026-10-08';

-- 一題公民提問最多收幾份答案（已上線＋還在等票的都算）：TS 的 QUESTION_ANSWER_CAP（dispatch.ts）的 SQL 這一份，守門測試對兩邊
CREATE OR REPLACE FUNCTION question_answer_cap() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;
COMMENT ON FUNCTION question_answer_cap IS '一題公民提問最多收幾份答案（已上線的 citizen_questions.answer_count＋還在等票的 question_answer 貢獻）；跟 TS 的 QUESTION_ANSWER_CAP 同一個數字，滿了就不再派。2026-10-08';

-- 臂本體：open 的手動任務。p_visitor＝true 取網站請求與公民提問、false 取其餘；p_id 只取那一筆（新任務即時入列的觸發器用）
-- 已收滿答案的公民提問不算缺口：任務本身永遠是 open（KEEP_OPEN_TASK_TYPES 含 question），不排除的話它們會佔住隊頭，
-- 固定時段又被拉回 1970，/next 拿前 30 筆全被「已滿額」濾掉就回 none（滿額定義照 fullQuestionIdsOf：answer_count＋同一題所有任務底下還在等票的答案 ≥ 上限）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_manual(p_visitor BOOLEAN, p_id UUID DEFAULT NULL)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT t.id::TEXT, t.task_type,
         jsonb_strip_nulls(jsonb_build_object(
           'title', t.title, 'region', t.region,
           'stance_up', CASE WHEN t.task_type = 'question'
                             THEN COALESCE((SELECT q.stance_up FROM citizen_questions q WHERE q.id::TEXT = t.target->>'question_id'), 0) END)) || t.target,
         COALESCE(NULLIF(t.description, ''), t.title), t.hint_sources, t.reward, t.region
    FROM contribution_tasks t
   WHERE t.status = 'open' AND manual_task_is_visitor(t.source, t.task_type) = p_visitor
     AND (p_id IS NULL OR t.id = p_id)
     AND NOT (t.task_type = 'question' AND t.target->>'question_id' IS NOT NULL
              AND COALESCE((SELECT q.answer_count FROM citizen_questions q WHERE q.id::TEXT = t.target->>'question_id'), 0)
                  + (SELECT count(*) FROM contributions c
                      WHERE c.contribution_type = 'question_answer' AND c.status IN ('pending', 'verified')
                        AND c.task_id IN (SELECT t2.id::TEXT FROM contribution_tasks t2 WHERE t2.task_type = 'question' AND t2.target->>'question_id' = t.target->>'question_id'))
                  >= question_answer_cap())
$$;
COMMENT ON FUNCTION contribution_auto_tasks_manual IS
  '派工臂 manual_visitor（p_visitor＝true：網站請求與公民提問）／manual_open（false：維護者建、裁決、外部提議…）：contribution_tasks 裡 open 的任務。task_id＝任務 uuid，關閉＝缺口消失（seed 收回）。'
  'target 在原 target 之外補 title、region（/queue 顯示用）與公民提問的 stance_up（支持度，排序用）；原 target 的鍵優先。已收滿答案的公民提問不出現（見函式上方說明）。p_id 只取那一筆。2026-10-08';

-- 固定時段插隊（seed 每輪呼叫）：不在時段內什麼都不做；時段內把「本時段開始後還沒派出過」的 open 網站請求／公民提問排回最前（已收滿答案的提問不是缺口，不拉）
CREATE OR REPLACE FUNCTION manual_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_slot TIMESTAMPTZ := visitor_front_slot_start(); n INTEGER;
BEGIN
  IF v_slot IS NULL THEN RETURN 0; END IF;
  UPDATE task_dispatches d SET queue_at = visitor_front_at()
   WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(true) m)
     AND (d.dispatch_count = 0 OR d.last_dispatched_at < v_slot)
     AND d.queue_at <> visitor_front_at();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION manual_front_pull IS
  '固定時段插隊（維護者 2026-10-08）：台北 00:00、06:00、12:00、18:00 各前 20 分鐘內跑的 seed，把仍 open 的網站請求與公民提問（臂 manual_visitor 的輸出，已收滿答案的提問不在裡面）中「從沒派過、或最後派出時間早於本時段開始」的派工列排回 1970（比加推早）。'
  '時段內第二次 seed 冪等：本時段開始後被領走的（last_dispatched_at ≥ 時段開始）不再拉；其他時段什麼都不做，派出後照常回隊尾。';


-- ------------------------------------------------------------
-- 2. 活動名（派工臂登記）與規則：先種規則，再換總表（否則總表會把新臂整支濾光）
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
    'manual_open'
  ]::TEXT[]
$$;

-- 規則種子：每個活動名一條「永遠開」（行為不變）
INSERT INTO activity_rules (activity, window_kind, note)
SELECT a.arm, 'always', '手動任務臂（20261008165000）：永遠開；任務關閉＝缺口消失'
  FROM unnest(activity_arm_names()) AS a(arm)
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm);

-- 優先層（#443）：網站請求與公民提問平常就在前段（層 1）。想改回預設層就刪這一條規則（走 migration）
INSERT INTO activity_rules (activity, window_kind, priority, note)
SELECT 'priority:manual_visitor', 'always', 1,
       '前段：有人在網站上等著的請求與提問（維護者 2026-10-08）。永遠開、不指名選舉；固定時段的插隊（visitor_front_slot_start）是另一回事，那是 queue_at 排到 1970。'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'priority:manual_visitor');

-- 萬一沒種齊，換掉總表就會把新臂整支濾光、seed 隔一輪就把派工列全收回——寧可讓這支 migration 失敗
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(activity_arm_names()) AS a(arm)
              WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm AND r.enabled)) THEN
    RAISE EXCEPTION '手動任務臂：有活動沒有啟用中的規則，不能換總表';
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 4. 總表 contribution_auto_tasks_arms：20261008150000 的現行定義＋兩行 UNION ALL
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
-- 5. /next 與 rebalance、/queue 讀的函式：contribution_auto_tasks 現行版（20261002000006）的複本，只差「任務列的範圍」與同位次的排序
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_queue_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.queue_at
  FROM task_dispatches d
  WHERE d.task_id NOT LIKE 'verify:%' AND d.task_type IS NOT NULL
    AND NOT d.blocked
    -- 插隊的（queue_at 早於 2000 年）跳過冷卻：人明確要求先做的，冷卻不該擋
    AND (NOT d.cooling OR d.queue_at < '2000-01-01T00:00:00Z')
    AND (p_type IS NULL OR d.task_type = p_type)
    AND (p_region IS NULL OR d.region = p_region)
    -- 下面兩項跟「是誰來領」有關，排程算不了；只對照時間走到的那幾筆查，到 p_limit 就停
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = d.task_id OR l.target_key = task_target_key(d.task_id, d.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = d.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
  -- 同一個 queue_at 內：公民提問依支持度（target.stance_up，排程寫入）高的先、再依進佇列時間；自動缺口沒有 stance_up，這兩個鍵對它們全是 NULL，順序與 contribution_auto_tasks 一樣
  ORDER BY d.queue_at ASC,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN (d.target->>'stance_up')::NUMERIC END DESC NULLS LAST,
           CASE WHEN jsonb_typeof(d.target->'stance_up') = 'number' THEN d.opened_at END ASC NULLS LAST,
           d.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_queue_tasks IS
  '/next、rebalance_queue、queue_preview 拿隊頭：task_dispatches 裡所有「任務」列（自動缺口 auto: 與 open 的手動任務 uuid，不含 verify:），照 queue_at 取，跳過 blocked、冷卻中（插隊的除外）、對這台機器不合格的。'
  'contribution_auto_tasks（/tasks、/request-task 用）仍只回 auto: 列，輸出不變。同 queue_at 內公民提問依 target.stance_up 高的先。2026-10-08';

-- ------------------------------------------------------------
-- 6. rebalance_queue：20261008090000 的現行定義＋一處機械式替換（可派任務的集合改讀 contribution_queue_tasks，手動任務列一起進加權交錯）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION rebalance_queue() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_start TIMESTAMPTZ; v_ready INTEGER; v_n INTEGER := 0; v_c INTEGER;
BEGIN
  -- 起點＝兩條行列目前最前面那一筆的時間，不是 now()：重排只改內部交錯，不能讓整條往後退。
  -- 用 now() 的話，人建任務（contribution_tasks，照上次派出時間排、不參與重排）永遠比重排後的驗證早，
  -- 12 筆人建任務會一直輪流排在所有驗證前面（09-24 00:xx a-zhen 50 分鐘沒拿到一筆驗證）。
  SELECT COALESCE(LEAST(MIN(queue_at), now()), now()) INTO v_start FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  DROP TABLE IF EXISTS _ready;
  CREATE TEMP TABLE _ready ON COMMIT DROP AS
    SELECT g.task_id FROM contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';
  SELECT COUNT(*) INTO v_ready FROM _ready;

  WITH v AS (
    SELECT task_id, row_number() OVER (ORDER BY queue_at, task_id) - 1 AS rn FROM task_dispatches
     WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01'
  )
  UPDATE task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '1 second' FROM v WHERE d.task_id = v.task_id;
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  -- >>> 優先層：可派的任務依層加權交錯（第 k 筆的虛擬完成時間＝k／權重，同時間層號小的先；同一層內照 queue_at、task_id 先進先出）
  WITH w AS (
    SELECT d.task_id, d.queue_at, COALESCE(d.priority, (SELECT x.id FROM task_priority_tiers x WHERE x.is_default)) AS tier
      FROM task_dispatches d JOIN _ready r ON r.task_id = d.task_id
  ), k AS (
    SELECT w.task_id, w.queue_at, w.tier, row_number() OVER (PARTITION BY w.tier ORDER BY w.queue_at, w.task_id) AS k FROM w
  ), t AS (
    SELECT k.task_id, row_number() OVER (ORDER BY k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at, k.task_id) - 1 AS rn
      FROM k LEFT JOIN task_priority_tiers tw ON tw.id = k.tier
  )
  -- <<< 優先層
  UPDATE task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds' FROM t WHERE d.task_id = t.task_id;
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  WITH t2 AS (
    SELECT d.task_id, row_number() OVER (ORDER BY d.queue_at, d.task_id) - 1 AS rn
      FROM task_dispatches d
     WHERE d.task_id NOT LIKE 'verify:%' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
       AND NOT EXISTS (SELECT 1 FROM _ready r WHERE r.task_id = d.task_id)
  )
  UPDATE task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds' FROM t2 WHERE d.task_id = t2.task_id;
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  RETURN v_n;
END;
$$;

-- ------------------------------------------------------------
-- 7. queue_preview（/queue 頁）：20261006034900 的現行定義，手動任務那一段拿掉（它們現在就在任務列裡）、任務列改讀 contribution_queue_tasks
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION queue_preview(p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (pos INTEGER, kind TEXT, task_id TEXT, task_type TEXT, subject TEXT, region TEXT, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH items AS (
    SELECT 'task'::TEXT AS kind, g.task_id, g.task_type,
           COALESCE(NULLIF(g.target->>'name', ''), NULLIF(g.target->>'policy_title', ''), NULLIF(g.target->>'title', ''), '') AS subject,
           g.target->>'region' AS region, g.queue_at, 2 AS tie
      FROM contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g
    UNION ALL
    SELECT 'verify', 'verify:' || v.id, v.contribution_type,
           COALESCE(NULLIF(v.payload->>'name', ''),
                    (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(v.payload)),
                    (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(v.payload->>'policy_id')),
                    NULLIF(v.payload->>'title', ''), ''),
           COALESCE(v.payload->>'region', (SELECT p.region FROM politicians p WHERE p.id = contribution_subject_politician(v.payload))),
           COALESCE(d.queue_at, v.created_at), 0
      FROM contributions v
      LEFT JOIN task_dispatches d ON d.task_id = 'verify:' || v.id
     WHERE v.status = 'pending'
       -- 跟驗證池同一條可派條件（分數未達標，或高風險型別還不到兩台機器）；不用驗證池本身，因為它一次最多回 200 筆
       AND (v.score < COALESCE(v.target_score, contribution_effective_agree(v.id))
            OR (contribution_needs_two_ips(v.contribution_type, v.payload) AND v.voter_ips < 2))
  )
  SELECT row_number() OVER (ORDER BY i.queue_at, i.tie, i.task_id)::INTEGER AS pos,
         i.kind, i.task_id, i.task_type, i.subject, i.region, i.queue_at
    FROM items i
   ORDER BY i.queue_at, i.tie, i.task_id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 2000));
$$;
COMMENT ON FUNCTION queue_preview IS '派工佇列預覽（/queue 頁）：跟 /next 同一個時間軸（task_dispatches.queue_at，進表時已按驗證：任務 2:1 排好）。手動任務（網站請求、公民提問、維護者任務…）也是派工臂 manual_visitor／manual_open 的缺口，不再另算（20261008165000）';
REVOKE ALL ON FUNCTION queue_preview(INTEGER) FROM public;
GRANT EXECUTE ON FUNCTION queue_preview(INTEGER) TO anon, authenticated;

-- ------------------------------------------------------------
-- 8. 缺口出生／收回的觸發器：從「只管 auto:」改成「所有任務列（不含 verify:）」，WHEN 條件以外與 P0 一字不差
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_task_dispatches_gap_before_insert ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_gap_before_insert BEFORE INSERT ON task_dispatches
  FOR EACH ROW WHEN (NEW.task_id NOT LIKE 'verify:%') EXECUTE FUNCTION task_dispatches_gap_before_insert();
DROP TRIGGER IF EXISTS trg_task_dispatches_gap_after_insert ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_gap_after_insert AFTER INSERT ON task_dispatches
  FOR EACH ROW WHEN (NEW.task_id NOT LIKE 'verify:%') EXECUTE FUNCTION task_dispatches_gap_after_insert();
DROP TRIGGER IF EXISTS trg_task_dispatches_gap_after_delete ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_gap_after_delete AFTER DELETE ON task_dispatches
  FOR EACH ROW WHEN (OLD.task_id NOT LIKE 'verify:%') EXECUTE FUNCTION task_dispatches_gap_after_delete();

-- ------------------------------------------------------------
-- 9. seed_auto_task_queue：20261008121000 的現行定義＋四處機械式替換
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
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
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
  SELECT g.task_id, now(), COALESCE(CASE WHEN g.arm LIKE 'manual\_%' THEN manual_front_at(g.task_id) END,
                                    v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds'), 0,
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

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM manual_front_pull();
  -- <<< 固定時段插隊
  PERFORM rebalance_queue();

  RETURN v_new + v_verify;
END;
$$;

DO $$
DECLARE v_old TEXT := obj_description('contribution_auto_tasks_arms()'::regprocedure, 'pg_proc');
BEGIN
  IF v_old IS NOT NULL AND v_old NOT LIKE '%20261008165000%' THEN
    EXECUTE format('COMMENT ON FUNCTION contribution_auto_tasks_arms IS %L',
                   v_old || '｜2026-10-08（20261008165000）：加第 30、31 個分支 manual_visitor、manual_open（open 的手動任務，task_id＝任務 uuid；總表現在 31 個分支、39 個活動名）');
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 10. 任務關閉（或刪除）就立刻收回它的派工列，不等 10 分鐘的 seed（否則關掉的任務還能被領走）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_tasks_drop_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('gap.close_detail', '{"via":"task_closed"}', true);
  DELETE FROM task_dispatches WHERE task_id = OLD.id::TEXT;
  PERFORM set_config('gap.close_detail', '', true);
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_contribution_tasks_close_dispatch ON contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_close_dispatch AFTER UPDATE OF status ON contribution_tasks
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status <> 'open') EXECUTE FUNCTION contribution_tasks_drop_dispatch();
DROP TRIGGER IF EXISTS trg_contribution_tasks_delete_dispatch ON contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_delete_dispatch AFTER DELETE ON contribution_tasks
  FOR EACH ROW EXECUTE FUNCTION contribution_tasks_drop_dispatch();

-- 新任務即時入列（維護者 2026-10-08 審查）：contribution_tasks 一建立（或重開成 open）就用臂本體（contribution_auto_tasks_manual，p_id 只取這一筆）寫進佇列，
-- 不等最多 10 分鐘的 seed——訪客按完按鈕，下一秒代理打 /next 就領得到。queue_at 照臂的規則（網站請求／公民提問 1970、維護者建的與裁決 1980、其餘隊尾）；
-- 臂本體的條件一樣適用（已收滿答案的提問不入列）。seed 只負責對帳（內容、優先層、測試名人物等總表層的過濾由它在下一輪補上或收回）。
CREATE OR REPLACE FUNCTION contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority)
  SELECT m.task_id, now(), COALESCE(manual_front_at(m.task_id), queue_slot('task')), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         (SELECT x.priority FROM activity_priority(CASE WHEN manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1)
    FROM contribution_auto_tasks_manual(manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION contribution_tasks_insert_dispatch IS '新建（或重開）的手動任務即時排進佇列（臂 manual_visitor／manual_open 的一筆）；出生紀錄 basis＝task_insert。seed 每 10 分鐘對帳。2026-10-08';
DROP TRIGGER IF EXISTS trg_contribution_tasks_insert_dispatch ON contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_insert_dispatch AFTER INSERT ON contribution_tasks
  FOR EACH ROW WHEN (NEW.status = 'open') EXECUTE FUNCTION contribution_tasks_insert_dispatch();
DROP TRIGGER IF EXISTS trg_contribution_tasks_reopen_dispatch ON contribution_tasks;
CREATE TRIGGER trg_contribution_tasks_reopen_dispatch AFTER UPDATE OF status ON contribution_tasks
  FOR EACH ROW WHEN (OLD.status <> 'open' AND NEW.status = 'open') EXECUTE FUNCTION contribution_tasks_insert_dispatch();

-- /next 的 open_tasks（回給代理的「現在有多少缺口任務」）：讀佇列的計數，不撈清單（contribution_auto_task_counts 的複本，改讀 contribution_queue_tasks，含手動任務；
-- /tasks、/request-task 照舊用只算自動缺口的 contribution_auto_task_counts）
CREATE OR REPLACE FUNCTION contribution_queue_task_counts(p_region TEXT DEFAULT NULL)
RETURNS TABLE (task_type TEXT, total BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT t.task_type, COUNT(*) FROM contribution_queue_tasks(NULL, p_region, 100000, '') t GROUP BY t.task_type ORDER BY 1;
$$;
COMMENT ON FUNCTION contribution_queue_task_counts IS '佇列上各型別的任務數（自動缺口＋open 的手動任務，跳過 blocked、冷卻中）。/next 的 open_tasks 用。2026-10-08';

-- ------------------------------------------------------------
-- 11. 審查補強（維護者 2026-10-08）
-- ------------------------------------------------------------
-- 手動任務被貢獻補完時即時收回派工列：判斷同 TS 的 shouldCloseOnApplied（task-fulfilment.ts；守門測試對兩邊的型別清單）。
-- 一題多份的（question、adjudicate、roster_check）與自己收尾的貢獻型別不收——任務還是 open，派工列要留著；任務真的關掉時由 contribution_tasks 上的觸發器收回。
CREATE OR REPLACE FUNCTION manual_task_closes_on_applied(p_task_id TEXT, p_contribution_type TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM contribution_tasks t
                  WHERE t.id::TEXT = p_task_id AND t.status = 'open'
                    AND t.task_type NOT IN ('question', 'adjudicate', 'roster_check')
                    AND p_contribution_type NOT IN ('no_change', 'adjudication', 'task_suggestion', 'question_answer', 'roster_check'))
$$;
COMMENT ON FUNCTION manual_task_closes_on_applied IS '這筆貢獻上線後，它所屬的手動任務該不該關（同 TS 的 shouldCloseOnApplied）。task_dispatches_drop_applied 用它即時收回派工列。2026-10-08';

-- task_dispatches_drop_applied：補號次版（20261008150000）的現行定義＋一處機械式替換（納入手動任務）
CREATE OR REPLACE FUNCTION task_dispatches_drop_applied() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.task_id IS NOT NULL AND (
       (NEW.task_id LIKE 'auto:%'
        -- 補號次與重查是一個單位一件、代理一位一筆交：一筆落庫不代表整件做完，由 seed 依缺口還在不在收回（補號次 20261008150000）
        AND NEW.task_id NOT LIKE 'auto:candidacy_source_missing:cand_no%')
       -- 手動任務（task_id＝任務 uuid）：這筆貢獻上線就算做完的才收回（判斷同 TS 的 shouldCloseOnApplied；公民提問、裁決、名單清查是一題多份，不收）
       OR manual_task_closes_on_applied(NEW.task_id, NEW.contribution_type)) THEN
    -- >>> gap_events：收回原因與是哪一筆貢獻，交給 task_dispatches 的 AFTER DELETE 觸發器記進 closed 事件
    PERFORM set_config('gap.close_reason', 'filled', true);
    PERFORM set_config('gap.close_detail', jsonb_build_object('via', 'drop_applied', 'contribution_id', NEW.id)::TEXT, true);
    -- <<< gap_events
    DELETE FROM task_dispatches WHERE task_id = NEW.task_id;
    -- >>> gap_events：用完就清，不影響同一個交易裡之後的刪除
    PERFORM set_config('gap.close_reason', '', true);
    PERFORM set_config('gap.close_detail', '', true);
    -- <<< gap_events
  END IF;
  RETURN NEW;
END;
$$;

-- task_boost_matches：20261007030000 的現行定義拿掉 contribution_tasks 那一段——手動任務現在就在總表裡（臂 manual_visitor／manual_open），不拿掉會算兩次
CREATE OR REPLACE FUNCTION task_boost_matches(p_filter jsonb)
RETURNS TABLE(task_id text, kind text)
LANGUAGE sql STABLE AS $$
  WITH f AS (
    SELECT
      CASE WHEN p_filter ? 'regions' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'regions')) END AS regions,
      NULLIF(p_filter->>'election_id', '')::INT AS election_id,
      CASE WHEN p_filter ? 'election_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'election_types')) END AS election_types,
      CASE WHEN p_filter ? 'task_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'task_types')) END AS task_types,
      COALESCE((p_filter->>'missing_avatar')::BOOLEAN, false) AS missing_avatar,
      CASE WHEN p_filter ? 'politician_ids' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'politician_ids')::UUID) END AS politician_ids,
      COALESCE(CASE WHEN p_filter ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'kinds')) END, ARRAY['task', 'verify']) AS kinds
  ),
  subjects AS (
    -- 每一個佇列項目的主角、縣市、屆別、型別
    SELECT g.task_id, 'task'::TEXT AS kind, g.task_type AS type_key,
           uuid_or_null(g.target->>'politician_id') AS politician_id,
           COALESCE(g.region, g.target->>'region') AS region,
           election_id_or_null(g.target->>'election_id') AS election_id,
           g.target->>'election_type' AS election_type
      FROM contribution_auto_tasks_arms() g
    UNION ALL
    SELECT 'verify:' || c.id, 'verify', c.contribution_type,
           contribution_subject_politician(c.payload),
           c.payload->>'region',
           election_id_or_null(c.payload->>'election_id'),
           c.payload->>'election_type'
      FROM contributions c WHERE c.status = 'pending'
  )
  SELECT s.task_id, s.kind
    FROM subjects s
    CROSS JOIN f
    LEFT JOIN politicians p ON p.id = s.politician_id
   WHERE s.kind = ANY(f.kinds)
     AND (f.task_types IS NULL OR s.type_key = ANY(f.task_types))
     AND (f.politician_ids IS NULL OR s.politician_id = ANY(f.politician_ids))
     AND (NOT f.missing_avatar OR (p.id IS NOT NULL AND COALESCE(p.avatar_url, '') = ''))
     AND (f.regions IS NULL OR COALESCE(s.region, p.region) = ANY(f.regions))
     AND (f.election_id IS NULL OR s.election_id = f.election_id
          OR (s.election_id IS NULL AND p.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM politician_elections pe WHERE pe.politician_id = p.id AND pe.election_id = f.election_id)))
     AND (f.election_types IS NULL OR s.election_type = ANY(f.election_types) OR (p.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM politician_elections pe
             WHERE pe.politician_id = p.id AND pe.election_type::TEXT = ANY(f.election_types)
               AND (f.election_id IS NULL OR pe.election_id = f.election_id))));
$$;

-- activity_health：補號次版（20261008150000）的現行定義＋一行（app.queue_now 假時鐘也要被抓出來）
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
  SELECT 'bulletin_milestone_missing', e.id::TEXT,
         '選舉有公報資料夾（bulletin_dir）、還沒投票，卻沒有整場的 bulletin_published 里程碑：bulletin-watch 不會偵測它（bulletin_watch_targets 只看有里程碑列的選舉），「公報之前」的降級規則也開不起來。新增選舉時要在 election_milestones 補那一列（預估用 expected／statutory；公報已上架就補 done／official）'
    FROM elections e
   WHERE e.bulletin_dir IS NOT NULL
     AND e.election_date >= activity_today()
     AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL)
  UNION ALL
  SELECT 'ballot_number_anomaly', a.election_id || ' / ' || a.election_type,
         count(*) || ' 個號次單位的號次有重複或跳號（重複 ' || count(*) FILTER (WHERE a.kind = 'duplicate') || '、跳號 ' || count(*) FILTER (WHERE a.kind = 'gap') || '）：看視圖 ballot_number_anomalies；名單缺人時也會這樣，派工臂 cand_no_recheck 會請代理對公告重查'
    FROM ballot_number_anomalies a JOIN elections e ON e.id = a.election_id
   WHERE e.election_date >= activity_today()
   GROUP BY a.election_id, a.election_type
  UNION ALL
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL
  UNION ALL
  SELECT 'queue_clock_overridden', current_setting('app.queue_now', true), '派工時鐘被 app.queue_now 覆寫了：所有固定時段插隊都在用這個假時間（只該出現在測試）'
   WHERE NULLIF(current_setting('app.queue_now', true), '') IS NOT NULL;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 與里程碑對不上、派工臂沒有任何規則（arm_without_rule，P1）、'
  '有公報資料夾又還沒投票的選舉缺整場的 bulletin_published 里程碑（bulletin_milestone_missing，2026-10-08 公報偵測）、號次單位有重複或跳號（ballot_number_anomaly，還沒投票的選舉，補號次 20261008150000）、時鐘被覆寫。2026-10-08（PLAN-task-activation 3 風險第 2 點）'
  '｜20261008165000：加 queue_clock_overridden——app.queue_now 假時鐘被設了（固定時段插隊用的時鐘，只該出現在測試）。';

-- 套上就先算一次：手動任務排進佇列，不用等下一輪排程（新的 /next 只讀佇列）
SELECT seed_auto_task_queue();

NOTIFY pgrst, 'reload schema';
