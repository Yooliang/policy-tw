-- seed 排程各段計時：把 seed_auto_task_queue() 每一段、派工總表每一支臂各花多少時間寫進小表 seed_arm_timings（只加量測，不改任何查詢邏輯與輸出）
--
-- 背景：pg_cron seed-auto-task-queue-10min 每 10 分鐘跑一輪，11-26 早上單輪 57～230 秒，但看不出慢在哪。擁有者點頭「第一刀：各臂各自計時寫小表，跑一天拿數字」。
-- 第二刀（照數字分檔降頻、拆排程）不在這支。
--
-- 結構（為什麼不能「每支臂前後各包一對時間戳」）：
--   seed_auto_task_queue() 只有一句 CREATE TEMP TABLE _gaps_all AS SELECT … FROM contribution_auto_tasks_arms()；
--   總表 contribution_auto_tasks_arms() 是「單一 SQL 敘述」：約 35 個 UNION ALL 臂放在同一個 CTE（tagged0），
--   後面的名單清查收斂、名單缺口、職位補齊、開窗（activity_open）、流量開窗全部串在同一條 CTE 鏈裡接著讀 tagged0。
--   臂與下游互相依賴、臂的執行時機由規劃器決定，在一個敘述裡沒有地方能量「某支臂花多久」。硬拆成逐臂暫存表等於重寫總表，違反「結果必須完全一樣」。
--   所以分兩路量：
--   (1) 即時：seed 本體每一段（建總表輸出、建缺口、流量提層、優先秒數、收回、更新、新增、驗證票、重整快照…）前後各記一筆，arm 欄是 'stage:…'，整輪是 'stage:total'。這是真實執行的時間，每 10 分鐘一筆。
--   (2) 逐臂：新函式 seed_arm_timing_probe() 在 seed 之外，把每支臂的函式各自單獨呼叫一次、記耗時與產出列數（arm 欄＝臂名）。
--       不放進 seed 本體，是因為 seed 有 280 秒的 statement_timeout，在同一個交易裡再加一輪全臂等於把單輪拉長一倍，最壞情況會讓整輪 seed 逾時回滾；
--       放在獨立的 pg_cron 工作（每小時 :35，避開 :30 起跑的 seed 與已有 :35 以外的工作），一天 24 筆樣本，失敗只記一筆、不影響 seed。
--       單獨呼叫的耗時是「該臂自己的成本」，與它在總表裡被規劃器夾在一起跑時可能略有出入（快取暖度、SQL 函式內嵌），要看趨勢與排名，不要當成與總表耗時逐秒相加。
--   名單清查收斂開關（roster_unify_on）會讓部分臂在總表裡被整支略過（township_gap 等七支 WHERE NOT roster_unify_on()）或只在開關開著時才算（roster_unit_findings 等三支）；
--   探針照同一個條件判斷：總表裡不會跑的就不跑、記 0 毫秒、error 欄寫「開關略過」，ok 仍是 true。
--
-- 小表 seed_arm_timings：id、run_started_at、arm、elapsed_ms、row_count、ok、error；索引 (run_started_at)；RLS 開、不給 anon／authenticated 任何權限（只有 service_role／postgres 讀得到）。
-- 每輪 seed 結束順手刪 7 天前的紀錄。
--
-- 回滾（一支遷移就夠）：
--   SELECT cron.unschedule('seed-arm-timing-probe-hourly');
--   然後把 seed_auto_task_queue() 換回 20261121193000_priority_bands.sql 的定義（CREATE OR REPLACE；SET statement_timeout = '280s'、SET work_mem = '16MB' 要一起帶）；
--   DROP FUNCTION seed_arm_timing_probe(); DROP FUNCTION seed_arm_timing_log(TIMESTAMPTZ, TEXT, TIMESTAMPTZ, INTEGER, BOOLEAN, TEXT); DROP TABLE seed_arm_timings;
--   三者互不影響，可以只做其中一部分（例如只 unschedule 探針）。
--
-- 風險：seed 每輪多約 12 次小表 INSERT 與一次 DELETE（毫秒級）；寫小表失敗只丟 WARNING，不讓 seed 掛掉。探針只做讀取（SELECT count(*) FROM 臂函式）。

CREATE TABLE IF NOT EXISTS seed_arm_timings (
  id             BIGSERIAL PRIMARY KEY,
  run_started_at TIMESTAMPTZ NOT NULL,
  arm            TEXT        NOT NULL,
  elapsed_ms     INTEGER     NOT NULL,
  row_count      INTEGER,
  ok             BOOLEAN     NOT NULL DEFAULT true,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS seed_arm_timings_run_started_at_idx ON seed_arm_timings (run_started_at);
ALTER TABLE seed_arm_timings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE seed_arm_timings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE seed_arm_timings_id_seq FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE seed_arm_timings IS 'seed 排程各段／各臂耗時（20261126150000）。arm＝stage:開頭是 seed 本體各段的即時計時、stage:total 是整輪；其餘是探針單獨呼叫每支臂函式的耗時。保留 7 天。沒有任何 policy＝只有 service_role／postgres 讀得到。';

-- 寫一筆計時：elapsed 從 p_started 算到現在。寫不進去只丟 WARNING，不能讓 seed 掛掉
CREATE OR REPLACE FUNCTION seed_arm_timing_log(p_run TIMESTAMPTZ, p_arm TEXT, p_started TIMESTAMPTZ, p_rows INTEGER DEFAULT NULL, p_ok BOOLEAN DEFAULT true, p_error TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO seed_arm_timings (run_started_at, arm, elapsed_ms, row_count, ok, error)
  VALUES (p_run, p_arm, GREATEST(0, round(EXTRACT(EPOCH FROM (clock_timestamp() - p_started)) * 1000))::INTEGER, p_rows, p_ok, p_error);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'seed_arm_timing_log：%', SQLERRM;
END;
$$;
REVOKE ALL ON FUNCTION seed_arm_timing_log(TIMESTAMPTZ, TEXT, TIMESTAMPTZ, INTEGER, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;

-- 探針：逐臂單獨呼叫、各記一筆。只讀、獨立交易（pg_cron 呼叫），不碰 seed 的交易
CREATE OR REPLACE FUNCTION seed_arm_timing_probe()
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '280s'
SET work_mem = '16MB'
AS $$
DECLARE r RECORD; v_run TIMESTAMPTZ := clock_timestamp(); v_t TIMESTAMPTZ; v_n INTEGER; v_cnt INTEGER := 0; v_unify BOOLEAN;
BEGIN
  v_unify := roster_unify_on();
  FOR r IN SELECT * FROM (VALUES
    ('raw', 'contribution_auto_tasks_raw()', null),
    ('dup', 'contribution_auto_tasks_dup()', null),
    ('legacy', 'contribution_auto_tasks_legacy()', null),
    ('mismatch', 'contribution_auto_tasks_mismatch()', null),
    ('policy_dup', 'contribution_auto_tasks_policy_dup()', null),
    ('not_running', 'contribution_auto_tasks_not_running()', null),
    ('mayor_policies', 'contribution_auto_tasks_mayor_policies()', null),
    ('term_policies', 'contribution_auto_tasks_term_policies()', null),
    ('roster_villages', 'contribution_auto_tasks_roster_villages()', null),
    ('township_gap', 'contribution_auto_tasks_township_gap()', 'off'),
    ('region_gap', 'contribution_auto_tasks_region_gap()', 'off'),
    ('elected_missing', 'contribution_auto_tasks_elected_missing()', 'off'),
    ('roster_cec_gap', 'contribution_auto_tasks_roster_cec_gap()', null),
    ('district_seats', 'contribution_auto_tasks_district_seats()', null),
    ('policy_elements', 'contribution_auto_tasks_policy_elements()', null),
    ('deadline_due', 'contribution_auto_tasks_deadline_due()', null),
    ('lineage_candidates', 'contribution_auto_tasks_lineage_candidates()', null),
    ('handover_missing', 'contribution_auto_tasks_handover_missing()', null),
    ('lineage_roles', 'contribution_auto_tasks_lineage_roles()', null),
    ('lineage_links', 'contribution_auto_tasks_lineage_links()', null),
    ('career_sources', 'contribution_auto_tasks_career_sources()', null),
    ('withdrawn_filing', 'contribution_auto_tasks_withdrawn_filing()', null),
    ('party_gap', 'contribution_auto_tasks_party_gap()', 'off'),
    ('party_roster', 'contribution_auto_tasks_party_roster()', 'off'),
    ('party_info', 'contribution_auto_tasks_party_info()', null),
    ('placeholder_politicians', 'contribution_auto_tasks_placeholder_politicians()', null),
    ('election_results', 'contribution_auto_tasks_election_results()', 'off'),
    ('owner_mismatch', 'contribution_auto_tasks_owner_mismatch()', 'off'),
    ('ballot_numbers', 'contribution_auto_tasks_ballot_numbers()', null),
    ('manual_visitor', 'contribution_auto_tasks_manual(true)', null),
    ('manual_open', 'contribution_auto_tasks_manual(false)', null),
    ('regional_stats_missing', 'contribution_auto_tasks_regional_stats_missing()', null),
    ('issue_too_broad', 'contribution_auto_tasks_issue_too_broad()', null),
    ('lineage_status', 'contribution_auto_tasks_lineage_status()', null),
    ('lineage_stances', 'contribution_auto_tasks_lineage_stances()', null),
    ('lineage_events', 'contribution_auto_tasks_lineage_events()', null),
    ('roster_unit_findings', 'roster_unit_findings()', 'on'),
    ('roster_gap_units', 'roster_gap_units()', 'on'),
    ('roster_gap_fresh_units', 'roster_gap_fresh_units()', 'on')
  ) AS a(arm, call_sql, gate) LOOP
    v_t := clock_timestamp();
    IF (r.gate = 'off' AND v_unify) OR (r.gate = 'on' AND NOT v_unify) THEN
      -- 總表裡這支臂被開關整支略過，不呼叫
      INSERT INTO seed_arm_timings (run_started_at, arm, elapsed_ms, row_count, ok, error) VALUES (v_run, r.arm, 0, NULL, true, '開關略過');
    ELSE
      BEGIN
        EXECUTE 'SELECT count(*)::INTEGER FROM ' || r.call_sql INTO v_n;
        PERFORM seed_arm_timing_log(v_run, r.arm, v_t, v_n);
      EXCEPTION WHEN OTHERS THEN
        PERFORM seed_arm_timing_log(v_run, r.arm, v_t, NULL, false, left(SQLERRM, 300));
      END;
    END IF;
    v_cnt := v_cnt + 1;
  END LOOP;
  PERFORM seed_arm_timing_log(v_run, 'stage:probe_total', v_run, v_cnt);
  RETURN v_cnt;
END;
$$;
REVOKE ALL ON FUNCTION seed_arm_timing_probe() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- seed 本體：以 20261121193000 的現行定義為底（正式庫 prosrc 的 md5 與該檔逐字相同），只多標 `各段計時` 的行
-- CREATE OR REPLACE 會洗掉函式層級的 SET，所以兩個 SET 一起寫進定義
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '280s'
SET work_mem = '16MB'
AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
  v_run TIMESTAMPTZ := clock_timestamp(); v_t TIMESTAMPTZ := clock_timestamp(); v_n INTEGER;  -- 各段計時（20261126150000）
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  -- >>> 暫存表瘦身：_gaps_all 保留總表完整輸出並加列號 rn（只讀、不改）；寬欄（what_we_need、hint_sources、task_type、reward、region）只留在這裡，後面要寫進 task_dispatches 時才用 rn 回來取
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT row_number() OVER ()::INTEGER AS rn, a.* FROM contribution_auto_tasks_arms() a;
  GET DIAGNOSTICS v_n = ROW_COUNT;  -- 各段計時（20261126150000）
  PERFORM seed_arm_timing_log(v_run, 'stage:arms_all', v_t, v_n); v_t := clock_timestamp();  -- 各段計時（20261126150000）
  CREATE UNIQUE INDEX ON _gaps_all (rn);
  -- <<< 暫存表瘦身
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  -- >>> 暫存表瘦身：_gaps 只帶後面會讀、會改的欄（task_id、arm、target、opened_by），加 src_rn 指回 _gaps_all 取寬欄。下面五次 UPDATE 每次都整列重寫，列越窄落碟越少
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.task_id, g.rn AS src_rn, g.arm, g.target, g.opened_by, g.task_type FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id, g.rn;
  GET DIAGNOSTICS v_n = ROW_COUNT;  -- 各段計時（20261126150000）
  PERFORM seed_arm_timing_log(v_run, 'stage:gaps', v_t, v_n); v_t := clock_timestamp();  -- 各段計時（20261126150000）
  -- <<< 暫存表瘦身

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;
  -- >>> 帶狀優先（20261121）：不再呼叫 activity_priority_seconds（規則秒數不再被讀，下面的優先秒數整個重新算）；priority_rule_id 維持 NULL，opened_by 不再記 priority_rule_id
  -- <<< 帶狀優先
  -- <<< 優先秒數

  -- >>> 流量提層：人物頁、政見頁近 window_days 天有真實流量（page_traffic_hot）的，名下缺口標 opened_by.traffic_boost（下一段給秒數）；page_traffic 與狀態都是空的就什麼都不做（參數與規則見 traffic_boost_settings、traffic_boost_apply）
  PERFORM traffic_boost_apply();
  PERFORM seed_arm_timing_log(v_run, 'stage:traffic_boost', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）
  -- <<< 流量提層
  -- >>> 帶狀優先（20261121）：優先秒數從這裡重新算——先清掉規則秒數（activity_rules 的優先秒數不再疊加），再給流量提層的比例制秒數：
  --     近 window_days 天不重複訪客數（opened_by.traffic_users，traffic_boost_apply 標的）× traffic_boost_settings.per_user_seconds；無門檻、無上限；沒有流量旗標＝0
  UPDATE _gaps g SET priority_seconds = CASE WHEN s.enabled AND g.opened_by->>'traffic_boost' = 'true'
                                             THEN COALESCE(NULLIF(g.opened_by->>'traffic_users', '')::BIGINT, 0) * s.per_user_seconds ELSE 0 END
    FROM traffic_boost_settings s WHERE s.id = 1;
  -- <<< 帶狀優先
  -- >>> 需求疊加（20261112070100）：同一張工作卡被不同人要過就加優先秒數（work_card_demand_seconds：單位數×2 天、上限 14 天、派出沒產出減半、冷卻中／結案為 0）。
  --     快照不論旗標都寫（乾跑視圖用）；demand_enabled 預設 false，關著時 priority_seconds 與前一版逐列相同。疊在流量提層（取最大）之後、選舉年（相加）之前
  BEGIN
    PERFORM work_card_demand_refresh();
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'work_card_demand_refresh：%', SQLERRM;  -- 快照失敗不能讓整個 seed 掛掉（旗標關著時更不行）
  END;
  IF COALESCE((SELECT q.demand_enabled FROM queue_settings q WHERE q.id = 1), false) THEN
    UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0) + c.demand_seconds::INTEGER
      FROM task_dispatches t
      JOIN work_cards c ON c.work_key = t.work_key AND c.demand_seconds > 0
     WHERE t.task_id = g.task_id;
  END IF;
  -- <<< 需求疊加
  -- >>> 帶狀優先（20261121）：優先秒數再加「屆基準 ＋ 層級 ＋ 種類」（task_year_priority_seconds、task_band_seconds）。
  --     屆基準：插隊中的缺口（既有列 boost_seconds > 0；新缺口是手動臂且 manual_front_seconds > 0）用最新一屆（latest_election_base_seconds），其餘用 target 自己那一屆（沒有選舉 id 當 2026）；
  --     層級與種類見 task_level_days／task_kind_days（lineage_* 用 target.level、有選舉類別的用職位、都沒有的查這個人的參選紀錄、「其他」組無層級）。
  --     疊在流量提層與需求疊加之後，所以排序鍵、冷卻判斷、驗證票沿用母任務的位置都自動吃到
  UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0)
         + task_year_priority_seconds(g.target, COALESCE((SELECT d.boost_seconds > 0 FROM task_dispatches d WHERE d.task_id = g.task_id),
                                                         g.arm LIKE 'manual\_%' AND COALESCE(manual_front_seconds(g.task_id), 0) > 0))
         + task_band_seconds(g.task_type, g.target);
  PERFORM seed_arm_timing_log(v_run, 'stage:priority', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）
  -- <<< 帶狀優先

  -- >>> 換號沿用排隊位置（20261019040000）：帶清單指紋的臂（task_rekey_arms）的 task_id 末段是那一格內容的指紋，格子裡任何一條政見一動指紋就變：
  --     舊列被收回、新列用新 task_id 出生，進隊時間重算＝排回隊尾（正式庫 10-19：佇列延遲約 14 天、這幾臂的列壽命中位數 12～21 小時，幾乎永遠輪不到）。
  --     收回之前先記下「穩定鍵」（task_id 去掉末段指紋）相同、這一輪就要被取代的舊列的排隊位置，下面新增時沿用；沒有舊列的新缺口照舊
  DROP TABLE IF EXISTS _rekey_prev;
  CREATE TEMP TABLE _rekey_prev ON COMMIT DROP AS
  WITH fresh AS MATERIALIZED (
    SELECT DISTINCT task_rekey_stable_key(g.task_id) AS skey
      FROM _gaps g
     WHERE task_rekey_stable_key(g.task_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM task_dispatches y WHERE y.task_id = g.task_id)
  )
  SELECT DISTINCT ON (d.skey) d.skey, d.task_id AS prev_task_id, d.last_dispatched_at, d.dispatch_count, d.boost_seconds,
         COALESCE((d.opened_by->>'chain_opened_at')::TIMESTAMPTZ, d.opened_at) AS chain_opened_at
    FROM (SELECT x.*, task_rekey_stable_key(x.task_id) AS skey FROM task_dispatches x WHERE x.task_id LIKE 'auto:%') d
    JOIN fresh f ON f.skey = d.skey
   WHERE NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND COALESCE((SELECT q.rekey_keep_position FROM queue_settings q WHERE q.id = 1), true)
   ORDER BY d.skey, d.queue_at, d.task_id;
  -- <<< 換號沿用排隊位置
  PERFORM seed_arm_timing_log(v_run, 'stage:rekey_prev', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

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
  PERFORM seed_arm_timing_log(v_run, 'stage:close_gaps', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- 既有的只更新內容，不動排隊位置
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE task_dispatches d SET task_type = a.task_type, target = g.target, what_we_need = a.what_we_need,
         hint_sources = a.hint_sources, reward = a.reward, region = a.region, refreshed_at = now()
    FROM _gaps g JOIN _gaps_all a ON a.rn = g.src_rn  -- 暫存表瘦身：寬欄從 _gaps_all 取
   WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, a.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數
  PERFORM seed_arm_timing_log(v_run, 'stage:update_existing', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority_seconds, boost_seconds)
  SELECT g.task_id, COALESCE(r.last_dispatched_at, now()), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', COALESCE(r.dispatch_count, 0),  -- 換號沿用排隊位置（queue_at 這個值觸發器會照進隊時間重算）
         a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, a.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds))
           || CASE WHEN r.skey IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('rekey_of', r.prev_task_id, 'chain_opened_at', r.chain_opened_at) END,  -- 換號沿用排隊位置
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE COALESCE(r.boost_seconds, 0) END  -- 換號沿用排隊位置
         -- <<< 優先秒數
    FROM _gaps g
    JOIN _gaps_all a ON a.rn = g.src_rn  -- 暫存表瘦身：寬欄從 _gaps_all 取
    LEFT JOIN _rekey_prev r ON r.skey = task_rekey_stable_key(g.task_id)  -- 換號沿用排隊位置
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;
  PERFORM seed_arm_timing_log(v_run, 'stage:insert_new', v_t, v_new); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- 觸發器漏掉的驗證列補進來
  -- >>> 驗證票跟著任務（20261017010000）：位置由觸發器 task_dispatches_queue_key 照 verify_queue_key 算，這裡不再呼叫 contribution_queue_at（原本給 1970）
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), now(), 0
  -- <<< 驗證票跟著任務
    FROM contributions c
   WHERE c.status = 'pending'
     -- >>> 一人一包（20261112065000）：還在包裡、不是載體（bundle_carrier_id）的條目沒有自己的票（票在載體上），不補；載體本身（含移轉後的新載體）照補
     AND NOT (c.bundle_id IS NOT NULL AND c.bundle_released_at IS NULL AND c.id IS DISTINCT FROM bundle_carrier_id(c.bundle_id))
     -- <<< 一人一包
     AND NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;
  PERFORM seed_arm_timing_log(v_run, 'stage:verify_insert', v_t, v_verify); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM refresh_verify_targets();
  PERFORM seed_arm_timing_log(v_run, 'stage:refresh_blocked_targets', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM manual_front_pull();
  -- <<< 固定時段插隊
  -- >>> 優先秒數（20261011320000）：不再重排（驗證：任務＝2:1 取消，維護者 10-13「什麼時候進隊伍就處理」）；
  --     queue_at 由觸發器 task_dispatches_queue_key 照排序鍵算，上面改到優先秒數、冷卻、插隊秒數的列已經跟著換了位置
  -- <<< 優先秒數
  -- >>> 驗證票跟著任務（20261017010000）：上面任務列的鍵可能剛換（秒數、冷卻、固定時段拉回），還跟著母任務的驗證票跟著換
  PERFORM refresh_verify_ticket_keys();
  -- <<< 驗證票跟著任務
  PERFORM seed_arm_timing_log(v_run, 'stage:front_pull_ticket_keys', v_t, NULL); v_t := clock_timestamp();  -- 各段計時（20261126150000）

  -- >>> 各段計時（20261126150000）：整輪總秒數＋清掉 7 天前的紀錄（只寫小表，不影響上面任何一步的結果）
  PERFORM seed_arm_timing_log(v_run, 'stage:total', v_run, v_new + v_verify);
  DELETE FROM seed_arm_timings WHERE run_started_at < now() - INTERVAL '7 days';
  -- <<< 各段計時

  RETURN v_new + v_verify;
END;
$$;

-- 逐臂探針：每小時 :35 一次（seed 在 :30 起跑、約 4 分鐘內跑完；:35 沒有別的工作，見 20261121002500 之後的錯開原則）
SELECT cron.unschedule('seed-arm-timing-probe-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'seed-arm-timing-probe-hourly');
SELECT cron.schedule('seed-arm-timing-probe-hourly', '35 * * * *', $$SELECT seed_arm_timing_probe();$$);

NOTIFY pgrst, 'reload schema';
