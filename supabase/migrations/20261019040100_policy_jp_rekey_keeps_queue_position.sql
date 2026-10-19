-- 日本站：帶清單指紋的派工臂換號時沿用排隊位置（正見 20261019040000 的日本版，#670 第 8、9 點）
-- ============================================================
--
-- 結構與正見一樣：lineage_candidate（auto:lineage_candidate:<格の鍵 12 字>:<清單指紋 8 字>）、lineage_link_candidate（auto:lineage_link_candidate:<下級の脈絡 id>:<指紋 8 字>）、
-- duplicate_policy（auto:duplicate_policy:<参選紀錄 id>:<清單指紋 md5 32 字>）的 task_id 末段是那一格內容的指紋，指紋一變 seed 收回舊列、新列出生當下進隊＝排回隊尾。
-- 日本站今天這三臂還沒有列（正式庫 2026-10-19 唯讀：policy_jp.task_dispatches 116 列、這三臂 0 列、gap_events 沒有它們的事件），所以現在沒有症狀；
-- 脈絡臂的規則是開著的（有跨任期的政策格就會出生）、duplicate_policy 的規則預設關：趁還沒出現先套同一個做法，免得重蹈正見 10-19 的覆轍。
--
-- 同形套用（正見 seed 的同樣幾處機械式替換，rekey-position-edits.ts 的 REKEY_EDITS_JP＝加 policy_jp. 前綴）：
--   * policy_jp.seed_auto_task_queue()：收回之前先記下穩定鍵相同、這一輪就要被取代的舊列的排隊位置（進隊時間、派出次數、插隊秒數），新列出生時沿用；opened_by 記 rekey_of／chain_opened_at。
--   * policy_jp.task_rekey_arms()／policy_jp.task_rekey_stable_key()：臂清單與穩定鍵，逐字複本（走樣守門 policy-jp-dispatch-drift.test.ts 的 PAIRS）。
--   * policy_jp.queue_settings.rekey_keep_position（預設 true）：開關。
-- 不跟的：慢性停擺檢查（dispatch_chronic_stall／activity_health 的 dispatch_chronic_stall，主控台讀正見的 activity_health；日本站的 activity_health 是另一個視圖，
--   日本站這三臂還沒有列，要的時候另開）、queue_settings 的 stall_* 三欄。這個「不跟」登記在 policy-jp-dispatch-drift.test.ts（一條測試：日本站不得定義 dispatch_chronic_stall／dispatch_queue_delay_seconds，要跟就改登記）。
-- 不碰 public、不碰臂本體與 policy_jp 的觸發器；簽名與回傳型別一字不動（CREATE OR REPLACE）。

ALTER TABLE policy_jp.queue_settings ADD COLUMN IF NOT EXISTS rekey_keep_position BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN policy_jp.queue_settings.rekey_keep_position IS '帶清單指紋的臂換號（task_id 末段指紋變了）時，新列沿用同一個穩定鍵舊列的排隊位置（進隊時間、派出次數、插隊秒數）；false＝新列出生當下進隊（舊行為）。同正見，2026-10-19';

CREATE OR REPLACE FUNCTION policy_jp.task_rekey_arms() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['lineage_candidate', 'lineage_link_candidate', 'duplicate_policy']::TEXT[] $$;
COMMENT ON FUNCTION policy_jp.task_rekey_arms IS '帶清單指紋的派工臂（task_id＝auto:<臂>:<鍵>:<指紋>）：換號時新列沿用舊列的排隊位置（task_rekey_stable_key）。清單只有這一處。同正見，2026-10-19';

CREATE OR REPLACE FUNCTION policy_jp.task_rekey_stable_key(p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_task_id ~ '^auto:[a-z_]+:[^:]+:[0-9a-f]{8,32}$' AND split_part(p_task_id, ':', 2) = ANY (policy_jp.task_rekey_arms())
              THEN regexp_replace(p_task_id, ':[0-9a-f]{8,32}$', '') END
$$;
COMMENT ON FUNCTION policy_jp.task_rekey_stable_key IS '帶清單指紋的臂的穩定鍵＝task_id 去掉末段指紋（auto:<臂>:<格鍵／参選紀錄／脈絡>）；同一格換指紋前後的 task_id 穩定鍵相同。其餘一律 NULL。同正見，2026-10-19';

CREATE OR REPLACE FUNCTION policy_jp.seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 policy_jp.task_dispatches
  DROP TABLE IF EXISTS _gaps;
  -- >>> gap_events window／filled：總表的完整輸出（含被規則濾掉的列，那些列的 opened_by 是 NULL）只算一次——被濾掉的列用來分辨收回原因是「窗口關了」還是「缺口補上了」
  DROP TABLE IF EXISTS _gaps_all;
  PERFORM set_config('gap.arms_all', 'on', true);
  CREATE TEMP TABLE _gaps_all ON COMMIT DROP AS SELECT * FROM policy_jp.contribution_auto_tasks_arms();
  PERFORM set_config('gap.arms_all', '', true);
  -- <<< gap_events window／filled
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM _gaps_all g WHERE g.opened_by IS NOT NULL ORDER BY g.task_id;

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小；20261011350000 起相符的規則 id 也從這裡記，不再另算層）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority_seconds = p.seconds, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.seconds, x.rule_id
            FROM (SELECT DISTINCT y.arm, policy_jp.election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL policy_jp.activity_priority_seconds(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM policy_jp.election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先秒數

  -- >>> 日本版：選舉發現的層
  -- 鏈上的臂裡「還沒有選舉列＝沒有 polling 里程碑」的缺口（選舉發現；等團體落庫的選舉的團體任務），規則算不出秒數，改用 target 的日期
  -- （election_date，沒有就 vote_window_from）定層：60 天內前段、180 天內中段、更遠後段（policy_jp.chain_date_tier），秒數取那一層的 policy_jp.task_priority_tiers.seconds。有 polling 里程碑的照上面規則算的
  UPDATE _gaps g SET priority_seconds = (SELECT t.seconds FROM policy_jp.task_priority_tiers t WHERE t.id = policy_jp.chain_date_tier(policy_jp.chain_sort_date(g.task_id, g.target))), priority_rule_id = NULL
   WHERE g.arm IN ('election_discovery', 'local_government_missing', 'regional_stats_missing')
     AND NOT EXISTS (SELECT 1 FROM policy_jp.election_milestones_all m WHERE m.election_id = NULLIF(g.target->>'election_id', '') AND m.kind = 'polling');
  -- <<< 日本版：選舉發現的層

  -- >>> 換號沿用排隊位置（20261019040000）：帶清單指紋的臂（task_rekey_arms）的 task_id 末段是那一格內容的指紋，格子裡任何一條政見一動指紋就變：
  --     舊列被收回、新列用新 task_id 出生，進隊時間重算＝排回隊尾（正式庫 10-19：佇列延遲約 14 天、這幾臂的列壽命中位數 12～21 小時，幾乎永遠輪不到）。
  --     收回之前先記下「穩定鍵」（task_id 去掉末段指紋）相同、這一輪就要被取代的舊列的排隊位置，下面新增時沿用；沒有舊列的新缺口照舊
  DROP TABLE IF EXISTS _rekey_prev;
  CREATE TEMP TABLE _rekey_prev ON COMMIT DROP AS
  WITH fresh AS MATERIALIZED (
    SELECT DISTINCT policy_jp.task_rekey_stable_key(g.task_id) AS skey
      FROM _gaps g
     WHERE policy_jp.task_rekey_stable_key(g.task_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches y WHERE y.task_id = g.task_id)
  )
  SELECT DISTINCT ON (d.skey) d.skey, d.task_id AS prev_task_id, d.last_dispatched_at, d.dispatch_count, d.boost_seconds,
         COALESCE((d.opened_by->>'chain_opened_at')::TIMESTAMPTZ, d.opened_at) AS chain_opened_at
    FROM (SELECT x.*, policy_jp.task_rekey_stable_key(x.task_id) AS skey FROM policy_jp.task_dispatches x WHERE x.task_id LIKE 'auto:%') d
    JOIN fresh f ON f.skey = d.skey
   WHERE NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND COALESCE((SELECT q.rekey_keep_position FROM policy_jp.queue_settings q WHERE q.id = 1), true)
   ORDER BY d.skey, d.queue_at, d.task_id;
  -- <<< 換號沿用排隊位置

  -- >>> gap_events window：臂自己還算得出來這個缺口、只是規則的窗口關了（例：party_roster 過了投票日）→ 收回，原因記 window（交給觸發器寫進 closed 事件）
  PERFORM set_config('gap.close_reason', 'window', true);
  PERFORM set_config('gap.close_detail', '{"via":"seed_window"}', true);
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id)
     AND EXISTS (SELECT 1 FROM _gaps_all a WHERE a.task_id = d.task_id);
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  -- <<< gap_events window

  -- 已經不存在的缺口（補上了）：收回號碼牌（上面 window 收走的不在這裡；剩下的才是臂已經算不出來的，原因走觸發器的預設 filled）
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id NOT LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  -- >>> 內容沒變不重寫（#465）：六個內容欄任一欄真的變了才更新；沒變的列不碰（每 10 分鐘約 8,000 列整列重寫的成本，幾乎都是白做）。refreshed_at 的語意因此是「內容最後一次被改寫的時間」
  UPDATE policy_jp.task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id
     AND (d.task_type, d.target, d.what_we_need, d.hint_sources, d.reward, d.region) IS DISTINCT FROM (g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region);
  -- <<< 內容沒變不重寫

  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE policy_jp.task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數

  -- 新缺口排進任務行列
  v_base := policy_jp.queue_slot('task');
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority_seconds, boost_seconds)
  SELECT g.task_id, COALESCE(r.last_dispatched_at, now()), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', COALESCE(r.dispatch_count, 0),  -- 換號沿用排隊位置（queue_at 這個值觸發器會照進隊時間重算）
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds))
           || CASE WHEN r.skey IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('rekey_of', r.prev_task_id, 'chain_opened_at', r.chain_opened_at) END,  -- 換號沿用排隊位置
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 policy_jp.manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(policy_jp.manual_front_seconds(g.task_id), 0) ELSE COALESCE(r.boost_seconds, 0) END  -- 換號沿用排隊位置
         -- <<< 優先秒數
    FROM _gaps g
    LEFT JOIN _rekey_prev r ON r.skey = policy_jp.task_rekey_stable_key(g.task_id)  -- 換號沿用排隊位置
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;

  -- 觸發器漏掉的驗證列補進來
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), policy_jp.contribution_queue_at(c.contribution_type, c.task_id, c.created_at), 0
    FROM policy_jp.contributions c
   WHERE c.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches d WHERE d.task_id = 'verify:' || c.id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_verify = ROW_COUNT;

  -- 已經不是 pending 的貢獻，它的驗證列沒有意義了
  DELETE FROM policy_jp.task_dispatches d
   WHERE d.task_id LIKE 'verify:%'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c WHERE c.status = 'pending' AND 'verify:' || c.id = d.task_id);

  -- 「正在被處理」的任務先標起來，/next 只看這個欄位，不再每次逐筆查（2026-10-02）
  PERFORM policy_jp.refresh_dispatch_blocked();
  -- 待驗證貢獻的目標分數也算好放進快照，驗證池不再逐筆現算（2026-10-02）
  PERFORM policy_jp.refresh_verify_targets();

  -- >>> 網站請求／公民提問固定時段插隊（台北 00:00、06:00、12:00、18:00 各前 20 分鐘）：時段內才動，其餘時段什麼都不做
  PERFORM policy_jp.manual_front_pull();
  -- <<< 固定時段插隊
  -- >>> 優先秒數（20261011320000）：不再重排（驗證：任務＝2:1 取消，維護者 10-13「什麼時候進隊伍就處理」）；
  --     queue_at 由觸發器 policy_jp.task_dispatches_queue_key 照排序鍵算，上面改到優先秒數、冷卻、插隊秒數的列已經跟著換了位置
  -- <<< 優先秒數

  RETURN v_new + v_verify;
END;
$$;
COMMENT ON FUNCTION policy_jp.seed_auto_task_queue IS '排程每 10 分鐘：重算缺口，新缺口發號碼牌、內容寫進 task_dispatches（內容沒變的列不重寫）、補上的收回；算每個缺口的優先秒數（選舉鏈上沒有 polling 里程碑的照日期定層）；補驗證列、清掉已定案的；不再重排（queue_at＝排序鍵，觸發器算）。帶清單指紋的臂換號時（穩定鍵相同、舊列這一輪被取代），新列沿用舊列的進隊時間、派出次數、插隊秒數（_rekey_prev，policy_jp.queue_settings.rekey_keep_position 可關）。同正見，2026-10-19';
