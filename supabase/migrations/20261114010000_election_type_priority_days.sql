-- 派工：依選舉類別提前天數（2026-11-14，維護者裁示：層級做成設定，改數字不改程式）
-- ============================================================
--
-- 背景：11-14 小良哥問「層級（縣市長／議員／代表／村里長）會不會加減優先」，目前不會；裁示做成設定。
-- 公式：priority_seconds 在「選舉年優先」（20261112005000）之後再加一項
--           election_type_priority_seconds(target) ＝ queue_settings.election_type_priority_days[職位] × 86400
--       排序鍵 task_queue_key 一字不動；職位優先（activity_rules 的規則秒數）、驗證票 −14 天、插隊照舊疊加。
--
-- 設定：queue_settings.election_type_priority_days（JSONB，鍵＝職位中文名＝elections／politician_elections 的 election_type，值＝提前天數；沒列的職位＝0）
--       預設：縣市長 6、直轄市長 6、縣市議員 4、直轄市議員 4、鄉鎮市長 3、直轄市山地原住民區長 3、鄉鎮市民代表 2、直轄市山地原住民區民代表 2、村里長 0
--       改數字只要 UPDATE queue_settings SET election_type_priority_days = ... WHERE id = 1；下一輪 seed（每 10 分鐘）既有的派工列自動跟著換秒數，不用改程式。
--
-- 職位怎麼對上任務：target.election_type（職位優先規則也是讀這個）；沒有就用 target.politician_id＋target.election_id 查 politician_elections。
--       兩條都對不上（網站請求、名冊、基本資料…沒有職位的任務）加 0。
--
-- 寫 priority_seconds 的兩處各加一項（跟選舉年優先同一批）：
--   1. seed_auto_task_queue()：選舉年優先那一段之後多一段（標 >>> 選舉類別提前天數），其餘與上一版（20261112070100）逐字相同
--   2. contribution_tasks_insert_dispatch()（手動任務第一次進佇列）：規則秒數 + 選舉年優先 + 選舉類別提前天數
--   驗證票：沿用母任務的位置（母任務列的 priority_seconds 已含這一項），這支不動 verify_ticket_base；
--   已凍結基準的現有驗證票不回頭改（跟新建的驗證票之間會有數天差，隨票處理完自然消失）。
-- 不升協議版號、不改 TS；日本站不跟（沒有這種職位分級）。

ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS election_type_priority_days JSONB NOT NULL DEFAULT '{"縣市長": 6, "直轄市長": 6, "縣市議員": 4, "直轄市議員": 4, "鄉鎮市長": 3, "直轄市山地原住民區長": 3, "鄉鎮市民代表": 2, "直轄市山地原住民區民代表": 2, "村里長": 0}'::JSONB;
COMMENT ON COLUMN queue_settings.election_type_priority_days IS '依選舉類別的優先提前天數（20261114010000）：鍵＝職位中文名、值＝天數（可為負），沒列＝0。priority_seconds 再加 天數×86400。改數字直接 UPDATE，下一輪 seed 生效。2026-11-14';
ALTER TABLE queue_settings DROP CONSTRAINT IF EXISTS queue_settings_election_type_priority_days_obj;
ALTER TABLE queue_settings ADD CONSTRAINT queue_settings_election_type_priority_days_obj CHECK (jsonb_typeof(election_type_priority_days) = 'object');

CREATE OR REPLACE FUNCTION election_type_priority_seconds(p_target JSONB) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT CASE WHEN jsonb_typeof(s.election_type_priority_days->t.etype) = 'number'  -- 填成字串之類的當 0，不讓一個壞值拖垮整支 seed
                THEN round((s.election_type_priority_days->>t.etype)::NUMERIC * 86400)::BIGINT END
      FROM queue_settings s
     CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(p_target->>'election_type', ''),
                                         (SELECT pe.election_type::TEXT FROM politician_elections pe
                                           WHERE pe.politician_id = uuid_or_null(p_target->>'politician_id') AND pe.election_id = election_id_or_null(p_target->>'election_id')
                                           ORDER BY pe.id LIMIT 1)) AS etype) t
     WHERE s.id = 1 AND t.etype IS NOT NULL
  ), 0)
$$;
COMMENT ON FUNCTION election_type_priority_seconds IS '依選舉類別提前的優先秒數（20261114010000）：queue_settings.election_type_priority_days[職位] × 86400；職位取 target.election_type，沒有就查 politician_elections；對不上＝0。2026-11-14';

CREATE OR REPLACE FUNCTION contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority_seconds, boost_seconds)
  SELECT m.task_id, now(), queue_slot('task'), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         -- >>> 優先秒數：規則的優先秒數；第一次進佇列＝插隊一次（原本 1970／1980），馬上排到任務行列最前面
         COALESCE((SELECT x.seconds FROM activity_priority_seconds(CASE WHEN manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1), 0)
           + election_year_priority_seconds(election_id_or_null(m.target->>'election_id'))  -- 選舉年優先（20261112005000）：沒有選舉 id 的當 2026
           + election_type_priority_seconds(m.target),  -- 選舉類別提前天數（20261114010000）：對不上職位的加 0
         COALESCE(manual_front_seconds(m.task_id), 0)
         -- <<< 優先秒數
    FROM contribution_auto_tasks_manual(manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

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

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority_seconds = p.seconds, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.seconds, x.rule_id
            FROM (SELECT DISTINCT y.arm, election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL activity_priority_seconds(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先秒數

  -- >>> 流量提層：人物頁、政見頁近 window_days 天有真實流量（page_traffic_hot）的，名下缺口標 opened_by.traffic_boost（下一段給秒數）；page_traffic 與狀態都是空的就什麼都不做（參數與規則見 traffic_boost_settings、traffic_boost_apply）
  PERFORM traffic_boost_apply();
  -- <<< 流量提層
  -- >>> 優先秒數：流量提層的缺口（opened_by.traffic_boost）至少給 traffic_boost_settings.boost_seconds
  UPDATE _gaps g SET priority_seconds = GREATEST(COALESCE(g.priority_seconds, 0), s.boost_seconds)
    FROM traffic_boost_settings s
   WHERE s.id = 1 AND s.enabled AND g.opened_by->>'traffic_boost' = 'true';
  -- <<< 優先秒數
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
  -- >>> 選舉年優先（20261112005000）：優先秒數再加「選舉年後兩碼 × 100 天」（election_year_priority_seconds）；缺口 target 沒有選舉 id 的（網站請求、名冊、基本資料、合併…）當 2026。
  --     疊在規則秒數與流量提層之後，所以排序鍵、冷卻判斷、驗證票沿用母任務的位置都自動吃到
  UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0) + election_year_priority_seconds(election_id_or_null(g.target->>'election_id'));
  -- <<< 選舉年優先
  -- >>> 選舉類別提前天數（20261114010000）：優先秒數再加 queue_settings.election_type_priority_days 裡這個職位的天數 × 86400（election_type_priority_seconds）；
  --     職位取缺口 target.election_type，沒有就用 politician_id＋election_id 查 politician_elections；對不上職位的件加 0。疊在選舉年優先之後，一樣吃進排序鍵、冷卻判斷與驗證票母任務位置
  UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0) + election_type_priority_seconds(g.target);
  -- <<< 選舉類別提前天數

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
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority_seconds, boost_seconds)
  SELECT g.task_id, COALESCE(r.last_dispatched_at, now()), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', COALESCE(r.dispatch_count, 0),  -- 換號沿用排隊位置（queue_at 這個值觸發器會照進隊時間重算）
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds))
           || CASE WHEN r.skey IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('rekey_of', r.prev_task_id, 'chain_opened_at', r.chain_opened_at) END,  -- 換號沿用排隊位置
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE COALESCE(r.boost_seconds, 0) END  -- 換號沿用排隊位置
         -- <<< 優先秒數
    FROM _gaps g
    LEFT JOIN _rekey_prev r ON r.skey = task_rekey_stable_key(g.task_id)  -- 換號沿用排隊位置
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

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

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM refresh_verify_targets();

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM manual_front_pull();
  -- <<< 固定時段插隊
  -- >>> 優先秒數（20261011320000）：不再重排（驗證：任務＝2:1 取消，維護者 10-13「什麼時候進隊伍就處理」）；
  --     queue_at 由觸發器 task_dispatches_queue_key 照排序鍵算，上面改到優先秒數、冷卻、插隊秒數的列已經跟著換了位置
  -- <<< 優先秒數
  -- >>> 驗證票跟著任務（20261017010000）：上面任務列的鍵可能剛換（秒數、冷卻、固定時段拉回），還跟著母任務的驗證票跟著換
  PERFORM refresh_verify_ticket_keys();
  -- <<< 驗證票跟著任務

  RETURN v_new + v_verify;
END;
$$;

NOTIFY pgrst, 'reload schema';
