-- 日本站（policy_jp）的派工排序跟上正見的「優先級秒數」（2026-10-13，維護者「a b 都作吧」的 b；
-- 正見那一套見 20261011320000_queue_priority_seconds.sql、20261011350000_queue_priority_cleanup.sql 與裁決 docs/decisions/2026-10-13-派工排序改秒數.md）
-- ============================================================
--
-- 一句話：跟正見一樣，每筆派工列的 queue_at 就是排序鍵（觸發器 policy_jp.task_dispatches_queue_key 算），越早越先派；
--   晚於「現在＋一天」（policy_jp.queue_settings.dispatch_horizon_seconds）的 cooling＝true、先不派。
--   任務列＝GREATEST(進隊時間 − 優先秒數, 冷卻結束時間) − 插隊秒數；驗證列＝進隊時間 − 任務的優先秒數（負的當 0）− 14 天。
--   不再有層的加權交錯（6:3:1）、驗證：任務＝2:1 的重排（rebalance_queue）。
--
-- 正見的複本（以正見 20261011350000 的最後一版為底，只換 schema、search_path、election_id 的型別，加標記的日本專屬片段；走樣守門 policy-jp-dispatch-drift.test.ts）：
--   task_queue_key、activity_priority_seconds、manual_front_seconds、verify_inherited_priority_seconds、task_dispatches_queue_key（＋觸發器）、
--   refresh_dispatch_blocked（日本版：unreachable 另一個冷卻天數、roster_check 的 not_found 在告示日打斷冷卻，同 20261010120000）、
--   seed_auto_task_queue（日本版：沒有流量提層；選舉鏈上還沒有 polling 里程碑的缺口照日期定層，秒數取那一層的秒數，同 20261009300000）、
--   manual_front_pull、contribution_tasks_insert_dispatch
-- 日本專屬：
--   task_boost／task_boost_remaining：驗證列照舊排到 1980 年段；任務列改成加插隊秒數（正見 20261011320000 同一個改法）
--   主控台的規則總表（shared.dispatch_plan）讓日本的規則也能改 priority_seconds：另一支 20261011360100_dispatch_plan_jp_priority_seconds.sql
--   （它讀 public 的表，日本站的測試環境只載 policy_jp 的 migration，所以分開）
-- 刪掉（正式庫 pg_proc／pg_depend 唯讀查過：除了這支換掉的 seed 與手動任務入列，沒有函式呼叫，也沒有視圖依賴）：
--   policy_jp.rebalance_queue()、policy_jp.activity_priority()、policy_jp.manual_front_at()、policy_jp.task_dispatches.priority、policy_jp.task_priority_tiers.weight
-- 少掉的：日本版 rebalance_queue 在同一層裡照「步驟順位 → 選舉日期」排（20261009300000「最近的選舉先派」）；秒數化之後同一個秒數的照進隊時間先進先出，
--   跟正見一樣。最近的選舉照舊靠規則把它放到前段（priority: 規則與 chain_date_tier）。policy_jp.chain_step_rank 保留（各步的 migration 照舊加 WHEN），只是不再影響排序。
--   正式庫 2026-10-13 唯讀實測：任務列 116（前段 10、中段 106）、驗證列 150，沒有任務列在 1970／1980 年段。
-- 協議（policy-jp public/skill.md）沒有寫 2:1 或層，插隊的說法（一度だけ先頭へ、派出後回到最後尾）照舊成立，不升版。
-- jp-next 的每台機器 2:1 同一個 PR 拿掉（正見 20261011330000 同一個做法）。

-- ------------------------------------------------------------
-- 1. 設定與欄位（同正見 20261011320000 第 1 節；日本站沒有流量提層）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_jp.queue_settings (
  id                       SMALLINT PRIMARY KEY CHECK (id = 1),
  boost_seconds            BIGINT  NOT NULL DEFAULT 157680000 CHECK (boost_seconds > 0),
  visitor_front_seconds    BIGINT  NOT NULL DEFAULT 315360000 CHECK (visitor_front_seconds >= 0),
  manual_front_seconds     BIGINT  NOT NULL DEFAULT 157680000 CHECK (manual_front_seconds >= 0),
  verify_priority_seconds  INTEGER NOT NULL DEFAULT 1209600   CHECK (verify_priority_seconds BETWEEN 0 AND 31536000),
  dispatch_horizon_seconds INTEGER NOT NULL DEFAULT 86400     CHECK (dispatch_horizon_seconds BETWEEN 0 AND 604800),
  verify_inherit_negative  BOOLEAN NOT NULL DEFAULT false,
  note                     TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE policy_jp.queue_settings IS
  '派工排序的參數（單列，同正見的 queue_settings，2026-10-13）：插隊秒數、驗證另加的秒數、可派視界。改值＝一行 migration 的 UPDATE，進 policy_jp.edit_history';
INSERT INTO policy_jp.queue_settings (id, note) VALUES (1, '初值（同正見 2026-10-13：插隊 5 年、網站請求 10 年、驗證 14 天、只派明天以前的）') ON CONFLICT (id) DO NOTHING;
ALTER TABLE policy_jp.queue_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON policy_jp.queue_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON policy_jp.queue_settings TO service_role;
DROP TRIGGER IF EXISTS trg_queue_settings_touch ON policy_jp.queue_settings;
CREATE TRIGGER trg_queue_settings_touch BEFORE UPDATE ON policy_jp.queue_settings FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_queue_settings_audit ON policy_jp.queue_settings;
CREATE TRIGGER trg_queue_settings_audit AFTER INSERT OR UPDATE OR DELETE ON policy_jp.queue_settings FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_audit();

ALTER TABLE policy_jp.task_priority_tiers ADD COLUMN IF NOT EXISTS seconds INTEGER;
UPDATE policy_jp.task_priority_tiers SET seconds = CASE id WHEN 1 THEN 259200 WHEN 3 THEN -2592000 ELSE 0 END WHERE seconds IS NULL;
ALTER TABLE policy_jp.task_priority_tiers ALTER COLUMN seconds SET NOT NULL;
COMMENT ON COLUMN policy_jp.task_priority_tiers.seconds IS '這一層的優先秒數（2026-10-13 起排序看秒數）：規則沒填 priority_seconds 時用這個值；預設層＝沒有規則相符的任務；選舉鏈上沒有 polling 里程碑的缺口照 chain_date_tier 取這個值';

ALTER TABLE policy_jp.activity_rules ADD COLUMN IF NOT EXISTS priority_seconds INTEGER;
ALTER TABLE policy_jp.activity_rules DROP CONSTRAINT IF EXISTS activity_rules_priority_seconds_check;
ALTER TABLE policy_jp.activity_rules ADD CONSTRAINT activity_rules_priority_seconds_check
  CHECK (priority_seconds IS NULL OR (priority IS NOT NULL AND priority_seconds BETWEEN -315360000 AND 315360000));
COMMENT ON COLUMN policy_jp.activity_rules.priority_seconds IS
  '優先秒數（只有 priority: 規則填）：任務的排序鍵＝進隊時間減這個值，正的往前、負的往後；多條規則相符取最小；沒填用 priority 那一層的 task_priority_tiers.seconds。主控台可改（同正見，2026-10-13）';
UPDATE policy_jp.activity_rules r SET priority_seconds = t.seconds FROM policy_jp.task_priority_tiers t WHERE r.priority = t.id AND r.priority_seconds IS NULL;

ALTER TABLE policy_jp.task_dispatches ADD COLUMN IF NOT EXISTS priority_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policy_jp.task_dispatches ADD COLUMN IF NOT EXISTS boost_seconds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE policy_jp.task_dispatches ADD COLUMN IF NOT EXISTS cool_until TIMESTAMPTZ;
COMMENT ON COLUMN policy_jp.task_dispatches.priority_seconds IS '任務列：這一輪 seed 算出的優先秒數。驗證列：入列時沿用它那筆任務的（verify_inherited_priority_seconds），另加 queue_settings.verify_priority_seconds';
COMMENT ON COLUMN policy_jp.task_dispatches.boost_seconds IS '插隊秒數（/boost、網站請求的首次與固定時段拉回、維護者建的首次）；派出就歸零';
COMMENT ON COLUMN policy_jp.task_dispatches.cool_until IS '冷卻結束時間（task_checks 的查核時間＋冷卻天數，同一個任務取最晚）；refresh_dispatch_blocked 每 10 分鐘算，冷卻已過的是 NULL';
COMMENT ON COLUMN policy_jp.task_dispatches.queue_at IS '排序鍵（2026-10-13 起由觸發器 task_dispatches_queue_key 算，見 task_queue_key）；越早越先派，1970／1980 年段只剩驗證列';

-- ------------------------------------------------------------
-- 2. 排序鍵（正見複本）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.task_queue_key(p_entered TIMESTAMPTZ, p_priority_seconds INTEGER, p_cool_until TIMESTAMPTZ, p_boost_seconds BIGINT)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(p_entered - make_interval(secs => COALESCE(p_priority_seconds, 0)), p_cool_until)
         - make_interval(secs => COALESCE(p_boost_seconds, 0))
$$;

CREATE OR REPLACE FUNCTION policy_jp.activity_priority_seconds(
  p_activity TEXT, p_election_id TEXT DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT policy_jp.activity_today()
) RETURNS TABLE (seconds INTEGER, rule_id BIGINT)
LANGUAGE sql STABLE AS $$
  WITH hit AS (
    SELECT COALESCE(r.priority_seconds, t.seconds) AS s, o.rule_id AS rid
      FROM (SELECT * FROM policy_jp.activity_open('priority:' || p_activity, p_election_id, p_election_type, p_today)
            UNION ALL SELECT * FROM policy_jp.activity_open('priority:*', p_election_id, p_election_type, p_today)) o
      JOIN policy_jp.activity_rules r ON r.id = o.rule_id
      LEFT JOIN policy_jp.task_priority_tiers t ON t.id = r.priority
     WHERE r.priority IS NOT NULL
     ORDER BY COALESCE(r.priority_seconds, t.seconds) ASC NULLS LAST, o.rule_id
     LIMIT 1
  )
  SELECT h.s, h.rid FROM hit h
  UNION ALL
  SELECT COALESCE((SELECT t.seconds FROM policy_jp.task_priority_tiers t WHERE t.is_default), 0), NULL::BIGINT WHERE NOT EXISTS (SELECT 1 FROM hit)
$$;

CREATE OR REPLACE FUNCTION policy_jp.manual_front_seconds(p_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN policy_jp.manual_task_is_visitor(t.source, t.task_type) THEN q.visitor_front_seconds
              WHEN t.source IN ('manual', 'auto_dispute') THEN q.manual_front_seconds
              ELSE 0 END
    FROM policy_jp.contribution_tasks t CROSS JOIN policy_jp.queue_settings q
   WHERE q.id = 1 AND t.id::TEXT = p_task_id
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_inherited_priority_seconds(p_verify_task_id TEXT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT CASE WHEN q.verify_inherit_negative THEN d.priority_seconds ELSE GREATEST(d.priority_seconds, 0) END
      FROM policy_jp.contributions c
      JOIN policy_jp.task_dispatches d ON d.task_id = COALESCE(c.task_id, c.payload->>'task_id')
      CROSS JOIN policy_jp.queue_settings q
     WHERE 'verify:' || c.id = p_verify_task_id AND q.id = 1
     LIMIT 1), 0)
$$;

CREATE OR REPLACE FUNCTION policy_jp.task_dispatches_queue_key() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count THEN
    NEW.boost_seconds := 0;  -- 插隊是一次性的：派出就歸零，回隊尾
  END IF;
  IF NEW.task_id LIKE 'verify:%' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.priority_seconds := policy_jp.verify_inherited_priority_seconds(NEW.task_id);
    END IF;
    -- 驗證列：1970（網站請求、公民提問的交件）、1980（/boost）年段照舊不動，其餘＝進隊時間 − 任務的優先秒數 − 驗證另加的秒數
    IF NEW.queue_at IS NULL OR NEW.queue_at >= TIMESTAMPTZ '2000-01-01' THEN
      NEW.queue_at := COALESCE(NEW.last_dispatched_at, now())
                      - make_interval(secs => COALESCE(NEW.priority_seconds, 0)
                                              + COALESCE((SELECT q.verify_priority_seconds FROM policy_jp.queue_settings q WHERE q.id = 1), 0));
    END IF;
  ELSE
    NEW.queue_at := policy_jp.task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_dispatches_queue_key ON policy_jp.task_dispatches;
CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON policy_jp.task_dispatches
  FOR EACH ROW EXECUTE FUNCTION policy_jp.task_dispatches_queue_key();

-- ------------------------------------------------------------
-- 3. 派工函式（正見複本）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  WITH saturated AS (
    SELECT c.task_id FROM policy_jp.contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed')
    GROUP BY c.task_id HAVING COUNT(*) >= 5
  ), nochange AS (
    SELECT DISTINCT c.payload->>'task_id' AS task_id FROM policy_jp.contributions c
    WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified')
      AND c.payload->>'task_id' IS NOT NULL
  ), b AS (
    SELECT task_id FROM saturated UNION SELECT task_id FROM nochange
  )
  , cool AS (
    -- >>> 優先秒數（20261011320000）：冷卻結束時間＝查核時間＋冷卻天數（同一個任務取最晚的那筆）
    SELECT tc.task_id, max(tc.checked_at + (CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days')::INTERVAL) AS until
      FROM policy_jp.task_checks tc
    -- <<< 優先秒數
    WHERE tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days')::INTERVAL
      AND NOT policy_jp.roster_not_found_released(tc.task_id, tc.outcome, tc.checked_at)  -- 日本版：roster_check の not_found だけ告示日で冷卻を打ち切る
    GROUP BY tc.task_id
  )
  -- >>> 優先秒數：blocked 照舊只管 auto: 列；冷卻改成「排序鍵晚於 現在＋可派視界（policy_jp.queue_settings.dispatch_horizon_seconds，一天）就先不派」，
  --     排序鍵＝policy_jp.task_queue_key（進隊時間 − 優先秒數，冷卻結束時間當下限，再減插隊秒數），所有任務列（不含驗證列）都算
  , x AS (
    SELECT d.task_id,
           CASE WHEN d.task_id LIKE 'auto:%' THEN EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id) ELSE d.blocked END AS blocked,
           c.until,
           policy_jp.task_queue_key(d.last_dispatched_at, d.priority_seconds, c.until, d.boost_seconds)
             > now() + make_interval(secs => (SELECT q.dispatch_horizon_seconds FROM policy_jp.queue_settings q WHERE q.id = 1)) AS cooling
      FROM policy_jp.task_dispatches d LEFT JOIN cool c ON c.task_id = d.task_id
     WHERE d.task_id NOT LIKE 'verify:%'
  )
  UPDATE policy_jp.task_dispatches d
     SET blocked = x.blocked, cool_until = x.until, cooling = COALESCE(x.cooling, false)
    FROM x
   WHERE x.task_id = d.task_id
     AND (d.blocked, d.cool_until, d.cooling) IS DISTINCT FROM (x.blocked, x.until, COALESCE(x.cooling, false));
  -- <<< 優先秒數
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

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
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds)),
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 policy_jp.manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(policy_jp.manual_front_seconds(g.task_id), 0) ELSE 0 END
         -- <<< 優先秒數
    FROM _gaps g
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

CREATE OR REPLACE FUNCTION policy_jp.manual_front_pull() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_slot TIMESTAMPTZ := policy_jp.visitor_front_slot_start(); n INTEGER;
BEGIN
  IF v_slot IS NULL THEN RETURN 0; END IF;
  -- >>> 優先秒數（20261011320000）：拉回前段＝插隊一次（visitor_front_seconds，原本排到 1970）；已經拉過的（插隊秒數已達這個值）不重複加
  UPDATE policy_jp.task_dispatches d SET boost_seconds = q.visitor_front_seconds
    FROM policy_jp.queue_settings q
   WHERE q.id = 1
     AND d.task_id IN (SELECT m.task_id FROM policy_jp.contribution_auto_tasks_manual(true) m)
     AND (d.dispatch_count = 0 OR d.last_dispatched_at < v_slot)
     AND d.boost_seconds < q.visitor_front_seconds;
  -- <<< 優先秒數
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority_seconds, boost_seconds)
  SELECT m.task_id, now(), policy_jp.queue_slot('task'), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         -- >>> 優先秒數：規則的優先秒數；第一次進佇列＝插隊一次（原本 1970／1980），馬上排到任務行列最前面
         COALESCE((SELECT x.seconds FROM policy_jp.activity_priority_seconds(CASE WHEN policy_jp.manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1), 0),
         COALESCE(policy_jp.manual_front_seconds(m.task_id), 0)
         -- <<< 優先秒數
    FROM policy_jp.contribution_auto_tasks_manual(policy_jp.manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION policy_jp.seed_auto_task_queue IS '排程每 10 分鐘：重算缺口，新缺口發號碼牌、內容寫進 task_dispatches（內容沒變的列不重寫）、補上的收回；算每個缺口的優先秒數（選舉鏈上沒有 polling 里程碑的照日期定層）；補驗證列、清掉已定案的；不再重排（queue_at＝排序鍵，觸發器算）。同正見，2026-10-13';

-- ------------------------------------------------------------
-- 4. 插隊（日本專屬：同正見 20261011320000 的改法）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  -- 還沒發號碼牌的先發，不然排不到
  PERFORM policy_jp.seed_auto_task_queue();
  INSERT INTO policy_jp.task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  -- 最新的插隊最前：第 n 次 → 1980-01-01 減 n 分鐘
  v_at := TIMESTAMPTZ '1980-01-01' - (v_id * INTERVAL '1 minute');
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM policy_jp.task_boost_matches(p_filter);
  UPDATE policy_jp.contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  -- >>> 優先秒數（20261011360000）：驗證列照舊排到 1980 年段；任務列改成加插隊秒數（queue_settings.boost_seconds，插幾次加幾份，派出就歸零），
  --     queue_at 由觸發器照排序鍵馬上重算；插隊的不受冷卻擋（跟 1980 年段一樣）
  UPDATE policy_jp.task_dispatches d SET queue_at = LEAST(d.queue_at, v_at)
    FROM _boost_hits h WHERE h.task_id = d.task_id AND h.kind = 'verify';
  UPDATE policy_jp.task_dispatches d SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
    FROM _boost_hits h, policy_jp.queue_settings q WHERE q.id = 1 AND h.task_id = d.task_id AND h.kind = 'task';
  -- <<< 優先秒數
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE policy_jp.task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.task_boost_remaining(p_id BIGINT)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT jsonb_build_object(
    'tasks', count(*) FILTER (WHERE m.kind = 'task' AND (d.queue_at < TIMESTAMPTZ '1990-01-01' OR d.boost_seconds > 0)),  -- 20261011360000：任務列的插隊改成秒數
    'verifies', count(*) FILTER (WHERE m.kind = 'verify' AND d.queue_at < TIMESTAMPTZ '1990-01-01')
  )
  FROM policy_jp.task_boosts b
  JOIN LATERAL policy_jp.task_boost_matches(b.filter) m ON true
  LEFT JOIN policy_jp.task_dispatches d ON d.task_id = m.task_id
  WHERE b.id = p_id;
$$;

-- ------------------------------------------------------------
-- 5. 既有的派工列換算（同正見 20261011320000 第 5 節）
-- ------------------------------------------------------------
UPDATE policy_jp.task_dispatches d
   SET boost_seconds = CASE WHEN d.queue_at < TIMESTAMPTZ '1971-01-01' THEN q.visitor_front_seconds
                            ELSE q.boost_seconds + GREATEST(0, floor(extract(epoch FROM TIMESTAMPTZ '1980-01-01 00:00:00+00' - d.queue_at)))::BIGINT END
  FROM policy_jp.queue_settings q
 WHERE q.id = 1 AND d.task_id NOT LIKE 'verify:%' AND d.queue_at < TIMESTAMPTZ '2000-01-01';
UPDATE policy_jp.task_dispatches d SET priority_seconds = t.seconds
  FROM policy_jp.task_priority_tiers t
 WHERE d.task_id NOT LIKE 'verify:%'
   AND t.id = COALESCE(d.priority, (SELECT x.id FROM policy_jp.task_priority_tiers x WHERE x.is_default));
UPDATE policy_jp.task_dispatches v SET priority_seconds = policy_jp.verify_inherited_priority_seconds(v.task_id)
 WHERE v.task_id LIKE 'verify:%' AND v.priority_seconds IS DISTINCT FROM policy_jp.verify_inherited_priority_seconds(v.task_id);
SELECT policy_jp.refresh_dispatch_blocked();
UPDATE policy_jp.task_dispatches SET queue_at = queue_at;  -- 觸發器照排序鍵重算每一列（驗證列的 1970／1980 年段不動）

-- ------------------------------------------------------------
-- 6. 刪掉不再影響排序的（同正見 20261011350000）
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS policy_jp.rebalance_queue();
DROP FUNCTION IF EXISTS policy_jp.activity_priority(TEXT, TEXT, TEXT, DATE);
DROP FUNCTION IF EXISTS policy_jp.manual_front_at(TEXT);
ALTER TABLE policy_jp.task_dispatches DROP COLUMN IF EXISTS priority;
ALTER TABLE policy_jp.task_priority_tiers DROP COLUMN IF EXISTS weight;
COMMENT ON TABLE policy_jp.task_priority_tiers IS '佇列的優先層（同正見）：id 越小越前面；seconds＝這一層的優先秒數；is_default＝沒有規則相符時的層（只能一列）';

-- ------------------------------------------------------------
-- 7. 權限：日本站的函式只給 service_role（同 20261009130000）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.task_queue_key(TIMESTAMPTZ, INTEGER, TIMESTAMPTZ, BIGINT), policy_jp.activity_priority_seconds(TEXT, TEXT, TEXT, DATE),
  policy_jp.manual_front_seconds(TEXT), policy_jp.verify_inherited_priority_seconds(TEXT), policy_jp.task_dispatches_queue_key()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.task_queue_key(TIMESTAMPTZ, INTEGER, TIMESTAMPTZ, BIGINT), policy_jp.activity_priority_seconds(TEXT, TEXT, TEXT, DATE),
  policy_jp.manual_front_seconds(TEXT), policy_jp.verify_inherited_priority_seconds(TEXT), policy_jp.task_dispatches_queue_key()
  TO service_role;

-- ------------------------------------------------------------
-- 8. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM policy_jp.queue_settings WHERE id = 1) THEN
    RAISE EXCEPTION 'policy_jp.queue_settings 沒有 id=1 那一列';
  END IF;
  IF EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE task_id NOT LIKE 'verify:%' AND queue_at < TIMESTAMPTZ '2000-01-01') THEN
    RAISE EXCEPTION '日本站還有任務列留在 1970／1980 年段';
  END IF;
  IF EXISTS (SELECT 1 FROM policy_jp.task_dispatches
              WHERE task_id NOT LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM policy_jp.task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds)) THEN
    RAISE EXCEPTION '日本站有任務列的 queue_at 不是排序鍵';
  END IF;
  IF EXISTS (SELECT 1 FROM policy_jp.activity_rules WHERE priority IS NOT NULL AND priority_seconds IS NULL) THEN
    RAISE EXCEPTION '日本站有 priority: 規則沒有優先秒數';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'policy_jp' AND p.proname IN ('rebalance_queue', 'activity_priority', 'manual_front_at')) THEN
    RAISE EXCEPTION '日本站的舊排序函式沒刪乾淨';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'policy_jp' AND p.prosrc ~ '(rebalance_queue|activity_priority|manual_front_at)\(') THEN
    RAISE EXCEPTION '還有函式呼叫日本站已刪掉的排序函式';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.task_queue_key(timestamptz, integer, timestamptz, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon 不該能執行 policy_jp.task_queue_key';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
