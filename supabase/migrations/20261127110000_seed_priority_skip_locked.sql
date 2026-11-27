-- ============================================================
-- seed_auto_task_queue() 鎖 task_dispatches 的兩句 UPDATE 改 FOR UPDATE SKIP LOCKED（2026-11-27）
--
-- 為什麼：
--   正式庫 cron.job_run_details 今天兩次（11:50、18:30，訊息相同），seed-auto-task-queue-10min 整輪死在 deadlock：
--     ERROR: deadlock detected
--     DETAIL: Process A waits for ShareLock on transaction X; blocked by process B. Process B waits for ShareLock on transaction Y; blocked by process A.
--     CONTEXT: while locking tuple (24,4) in relation "task_dispatches"
--     SQL statement "UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
--      FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0)"
--     PL/pgSQL function seed_auto_task_queue() line 123 at SQL statement
--   整輪 seed 在這一句被殺，後面的臂重算與缺口事件消化都沒跑，事件積到 133 筆。
--   對手程序不確定（可能是派工函式 next／request-task／reassign-check 更新 task_dispatches 的交易），
--   所以修法是「不管對手是誰，seed 都不在這兩句上等別人的列鎖」。
--
-- 改了哪幾句（共 2 句，其餘一字不改）：
--   1. 內容 UPDATE（task_type、target、what_we_need… 六欄任一欄變了才更新）
--   2. 優先秒數 UPDATE（priority_seconds 跟著缺口換）
--   做法：原本的 UPDATE 條件保留，再加 d.task_id IN (子查詢)；子查詢用同一組「真的有變」的條件挑列，
--   ORDER BY d2.task_id FOR UPDATE OF d2 SKIP LOCKED。被別的交易鎖住的列這一輪跳過、下一輪（10 分鐘後）再補：
--   priority_seconds 是每 10 分鐘整批重算的軟欄位，內容欄位也是每輪對帳，晚一輪不影響正確性；
--   挑列時按 task_id 排序取鎖，兩個 seed 同時跑也不會互相交叉。
--
-- 沒改的（刻意）：
--   · 三句 DELETE FROM task_dispatches（window 收回、filled 收回、驗證列清理）：window 與 filled 兩句靠「臂還算不算得出來」
--     分原因，被跳過的列在同輪第二句會被記成另一個原因（gap_events 的 reason），不是單純的軟欄位，另案處理。
--   · INSERT … ON CONFLICT DO NOTHING：不等鎖（遇到衝突直接略過）。
--
-- 回滾：重跑前一版定義＝ 20261126180000_dispatch_gaps_phase0b.sql 第 5 節整支 seed 函式定義
--   （函式層級兩個 SET 要一起帶）。
--
-- 以 20261126180000_dispatch_gaps_phase0b.sql 的 seed 函式為底，重新定義會洗掉函式層級的 SET，所以兩個 SET 一起寫進定義
-- ============================================================
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '280s'
SET work_mem = '16MB'
AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
  v_run TIMESTAMPTZ := clock_timestamp(); v_t TIMESTAMPTZ := clock_timestamp(); v_n INTEGER;  -- 各段計時（20261126150000）
BEGIN
  -- >>> 缺口表 drain（20261126180000）：總開關 dispatch_gap_settings.seed_drain_enabled 預設 false；關著時這一段什麼都不做。drain 失敗只丟 WARNING，不讓 seed 掛掉
  IF dispatch_gap_seed_drain_enabled() THEN
    BEGIN
      PERFORM dispatch_gap_drain();
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'dispatch_gap_drain：%', SQLERRM;
    END;
    PERFORM seed_arm_timing_log(v_run, 'stage:gap_drain', v_t, NULL); v_t := clock_timestamp();
  END IF;
  -- <<< 缺口表 drain
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
  -- >>> 不等列鎖（20261127110000）：先用子查詢按 task_id 排序挑出「真的有變」的列並 FOR UPDATE SKIP LOCKED，被別的交易鎖住的列這一輪跳過、下一輪再補（今天兩次 deadlock 整輪 seed 被殺）
  UPDATE task_dispatches d SET task_type = a.task_type, target = g.target, what_we_need = a.what_we_need,
         hint_sources = a.hint_sources, reward = a.reward, region = a.region, refreshed_at = now()
    FROM _gaps g JOIN _gaps_all a ON a.rn = g.src_rn  -- 暫存表瘦身：寬欄從 _gaps_all 取
   WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (a.task_type, g.target, a.what_we_need, a.hint_sources, a.reward, a.region)
     AND d.task_id IN (
       SELECT d2.task_id FROM task_dispatches d2
         JOIN _gaps g2 ON g2.task_id = d2.task_id
         JOIN _gaps_all a2 ON a2.rn = g2.src_rn
        WHERE (d2.task_type, d2.target, d2.what_we_need, d2.hint_sources, d2.reward, d2.region) IS DISTINCT FROM (a2.task_type, g2.target, a2.what_we_need, a2.hint_sources, a2.reward, a2.region)
        ORDER BY d2.task_id FOR UPDATE OF d2 SKIP LOCKED);
  -- <<< 不等列鎖
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  -- >>> 不等列鎖（20261127110000）：同上，先挑列並 FOR UPDATE SKIP LOCKED（priority_seconds 每 10 分鐘重算，被鎖住的列下一輪補）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0)
     AND d.task_id IN (
       SELECT d2.task_id FROM task_dispatches d2 JOIN _gaps g2 ON g2.task_id = d2.task_id
        WHERE d2.priority_seconds IS DISTINCT FROM COALESCE(g2.priority_seconds, 0)
        ORDER BY d2.task_id FOR UPDATE OF d2 SKIP LOCKED);
  -- <<< 不等列鎖
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
