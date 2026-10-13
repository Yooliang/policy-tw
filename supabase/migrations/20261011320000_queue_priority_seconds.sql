-- 派工排序改成「優先級秒數」、取消驗證：任務＝2:1（2026-10-13，維護者 10:36 決策卡選「改成秒數」、10:37「插隊每次減 5 年」、
-- 10:52「查無變化改加秒數」、10:54「派工只出明天前的工」、11:01「2:1 取消，什麼時候進隊伍就處理」；裁決 docs/decisions/2026-10-13-派工排序改秒數.md）
-- ============================================================
--
-- 一句話：每筆派工列的 queue_at 就是它的排序鍵，鍵越早越先派；鍵晚於「現在＋一天」的先不派（冷卻）。
--
--   任務列（auto:、手動任務）的排序鍵＝task_queue_key：
--     GREATEST(進隊時間 − 優先秒數, 冷卻結束時間) − 插隊秒數
--     · 進隊時間＝last_dispatched_at（出生＝出生當下，派出後＝派出當下，跟以前一樣回隊尾）
--     · 優先秒數＝規則（activity_rules 的 priority: 規則）給的秒數，seed 每輪重算；多條相符取最小（跟以前「取層號最大」同一個方向：
--       投票前 180 天內的前段 vs 公報前的 policy_missing 中段 → 中段；投票後 181 天的後段 vs 沒有規則 → 後段）。
--       規則沒填 priority_seconds 的用它那一層（task_priority_tiers.seconds）的秒數，沒有規則相符＝預設層的秒數（0）
--     · 冷卻結束時間＝查核時間＋冷卻天數（task_checks，天數照舊由 task_check_cooldown_days_for 決定）。冷卻當下限：優先秒數不會讓冷卻提早結束
--     · 插隊秒數＝/boost 每次加 queue_settings.boost_seconds（5 年）；網站請求／公民提問第一次進佇列與固定時段拉回＝visitor_front_seconds（10 年，原本的 1970），
--       維護者建的與裁決第一次進佇列＝manual_front_seconds（5 年，原本的 1980）。一次性：派出就歸零（觸發器）
--   驗證列的排序鍵＝進隊時間 − 它那筆任務的優先秒數（負的當 0）− queue_settings.verify_priority_seconds（預設 14 天：任務佇列一輪約 8 天，
--     不給秒數的話新交件要等一週才有人投票；沿用任務的秒數是維護者 11:08 的意見，驗證跟同一批任務一起排）；
--     1970 年段（網站請求、公民提問的交件，verify_front_*）與 1980 年段（/boost 的驗證）照舊
--   可派＝排序鍵早於 現在＋queue_settings.dispatch_horizon_seconds（一天）；晚於的 cooling＝true，/next 不派（refresh_dispatch_blocked 每 10 分鐘算）。
--     負的優先秒數（後段 −30 天）推到一天以後的，一樣先擋著，時間到自然放出來
--
-- 取代：優先層加權交錯（6:3:1）、驗證：任務＝2:1 的重排（seed 不再呼叫 rebalance_queue；函式留著不刪，第二支 migration 再收）、
--   任務列的 1970／1980 年段（manual_front_at 不再被呼叫）、流量提層的「壓到 boost_tier」改成「至少 traffic_boost_settings.boost_seconds」。
--   task_dispatches.priority、activity_rules.priority、task_priority_tiers 照舊算、照舊記在 opened_by／gap_events（只是不再影響排序），第二支 migration 再刪。
--
-- 初值（正式庫唯讀實測 2026-10-13 10:53：可派任務約 8,800，前段 2,598／中段 3,144／後段 3,034；24 小時派出 490／514／51，一輪約 8 天）：
--   前段 +3 天（259,200）、中段 0、後段 −30 天（−2,592,000；後段每筆約 30 天輪一次、每天約 100 筆。−60 天才會跟現在每天約 51 筆相當，
--   但後段 3,034 筆幾乎都是近 15 天內派過的，−60 天會整整停派約 50 天才開始輪，所以取中間）、流量提層至少 +3 天（原本提到前段）。
--   這是改規則不是重構，派工輸出不會逐件不變；PR 附各層派出比例的前後比較。
--
-- 舊的 Edge Function（next、boost）不用改也不用重部署：/next 照 queue_at 取隊頭、task_dispatched 照舊寫，位置由這支的觸發器重算。
-- 日本站（policy_jp）的派工是另一套複本，這支不動。

-- ------------------------------------------------------------
-- 1. 設定與欄位
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queue_settings (
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
COMMENT ON TABLE queue_settings IS
  '派工排序的參數（單列 id=1，2026-10-13）。改值一行 UPDATE，例：UPDATE queue_settings SET verify_priority_seconds = 0, note = ''…'' WHERE id = 1;（每次修改進 edit_history，agent_name=activity-audit）。';
COMMENT ON COLUMN queue_settings.boost_seconds IS '/boost 插隊一次加幾秒（5 年）；插兩次加兩份；派出就歸零';
COMMENT ON COLUMN queue_settings.visitor_front_seconds IS '網站請求／公民提問第一次進佇列、固定時段拉回時的插隊秒數（10 年，比 /boost 前面，等同原本的 1970）';
COMMENT ON COLUMN queue_settings.manual_front_seconds IS '維護者建的手動任務與裁決第一次進佇列的插隊秒數（5 年，等同原本的 1980）';
COMMENT ON COLUMN queue_settings.verify_priority_seconds IS '驗證列另加的優先秒數（14 天）：排序鍵＝進隊時間 − 它那筆任務的優先秒數 − 這個值。0＝不另加（新交件會排在整條任務佇列後面）';
COMMENT ON COLUMN queue_settings.verify_inherit_negative IS '驗證列沿用任務的優先秒數時，負的（後段）要不要照算；false＝當 0（維護者 10-13：已經交的件不要等一個多月才有人投票）';
COMMENT ON COLUMN queue_settings.dispatch_horizon_seconds IS '可派視界（一天）：排序鍵晚於 現在＋這個秒數 的任務先不派（cooling）';
INSERT INTO queue_settings (id, note) VALUES (1, '初值（維護者 2026-10-13：插隊 5 年、網站請求 10 年、驗證 14 天、只派明天以前的）') ON CONFLICT (id) DO NOTHING;
ALTER TABLE queue_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON queue_settings;
CREATE POLICY "Public read" ON queue_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON queue_settings;
CREATE POLICY "Service role write" ON queue_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_queue_settings_touch ON queue_settings;
CREATE TRIGGER trg_queue_settings_touch BEFORE UPDATE ON queue_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_queue_settings_audit ON queue_settings;
CREATE TRIGGER trg_queue_settings_audit AFTER INSERT OR UPDATE OR DELETE ON queue_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

ALTER TABLE task_priority_tiers ADD COLUMN IF NOT EXISTS seconds INTEGER;
UPDATE task_priority_tiers SET seconds = CASE id WHEN 1 THEN 259200 WHEN 3 THEN -2592000 ELSE 0 END WHERE seconds IS NULL;
ALTER TABLE task_priority_tiers ALTER COLUMN seconds SET NOT NULL;
COMMENT ON COLUMN task_priority_tiers.seconds IS '這一層的優先秒數（2026-10-13 起排序看秒數，不看 weight）：規則沒填 priority_seconds 時用這個值；預設層＝沒有規則相符的任務';

ALTER TABLE activity_rules ADD COLUMN IF NOT EXISTS priority_seconds INTEGER;
ALTER TABLE activity_rules DROP CONSTRAINT IF EXISTS activity_rules_priority_seconds_check;
ALTER TABLE activity_rules ADD CONSTRAINT activity_rules_priority_seconds_check
  CHECK (priority_seconds IS NULL OR (priority IS NOT NULL AND priority_seconds BETWEEN -315360000 AND 315360000));
COMMENT ON COLUMN activity_rules.priority_seconds IS
  '優先秒數（只有 priority: 規則填）：任務的排序鍵＝進隊時間減這個值，正的往前、負的往後；多條規則相符取最小；沒填用 priority 那一層的 task_priority_tiers.seconds。主控台可改（2026-10-13）';
UPDATE activity_rules r SET priority_seconds = t.seconds FROM task_priority_tiers t WHERE r.priority = t.id AND r.priority_seconds IS NULL;

ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS priority_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS boost_seconds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS cool_until TIMESTAMPTZ;
COMMENT ON COLUMN task_dispatches.priority_seconds IS '任務列：這一輪 seed 算出的優先秒數（規則＋流量提層）。驗證列：入列時沿用它那筆任務的（verify_inherited_priority_seconds），另加 queue_settings.verify_priority_seconds';
COMMENT ON COLUMN task_dispatches.boost_seconds IS '插隊秒數（/boost、網站請求的首次與固定時段拉回、維護者建的首次）；派出就歸零';
COMMENT ON COLUMN task_dispatches.cool_until IS '冷卻結束時間（task_checks 的查核時間＋冷卻天數，同一個任務取最晚）；refresh_dispatch_blocked 每 10 分鐘算，冷卻已過的是 NULL';
COMMENT ON COLUMN task_dispatches.queue_at IS '排序鍵（2026-10-13 起由觸發器 task_dispatches_queue_key 算，見 task_queue_key）；越早越先派，1970／1980 年段只剩驗證列';

ALTER TABLE traffic_boost_settings ADD COLUMN IF NOT EXISTS boost_seconds INTEGER NOT NULL DEFAULT 259200 CHECK (boost_seconds BETWEEN 0 AND 315360000);
COMMENT ON COLUMN traffic_boost_settings.boost_seconds IS '達標頁面名下的缺口的優先秒數至少給這麼多（2026-10-13 起取代 boost_tier 對排序的作用；boost_tier 仍決定哪些缺口算「可提層」）';

-- ------------------------------------------------------------
-- 2. 排序鍵
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_queue_key(p_entered TIMESTAMPTZ, p_priority_seconds INTEGER, p_cool_until TIMESTAMPTZ, p_boost_seconds BIGINT)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(p_entered - make_interval(secs => COALESCE(p_priority_seconds, 0)), p_cool_until)
         - make_interval(secs => COALESCE(p_boost_seconds, 0))
$$;
COMMENT ON FUNCTION task_queue_key(TIMESTAMPTZ, INTEGER, TIMESTAMPTZ, BIGINT) IS
  '任務列的排序鍵（2026-10-13）：GREATEST(進隊時間 − 優先秒數, 冷卻結束時間) − 插隊秒數。越早越先派；晚於 現在＋queue_settings.dispatch_horizon_seconds 的先不派';

CREATE OR REPLACE FUNCTION activity_priority_seconds(
  p_activity TEXT, p_election_id INTEGER DEFAULT NULL, p_election_type TEXT DEFAULT NULL, p_today DATE DEFAULT activity_today()
) RETURNS TABLE (seconds INTEGER, rule_id BIGINT)
LANGUAGE sql STABLE AS $$
  WITH hit AS (
    SELECT COALESCE(r.priority_seconds, t.seconds) AS s, o.rule_id AS rid
      FROM (SELECT * FROM activity_open('priority:' || p_activity, p_election_id, p_election_type, p_today)
            UNION ALL SELECT * FROM activity_open('priority:*', p_election_id, p_election_type, p_today)) o
      JOIN activity_rules r ON r.id = o.rule_id
      LEFT JOIN task_priority_tiers t ON t.id = r.priority
     WHERE r.priority IS NOT NULL
     ORDER BY COALESCE(r.priority_seconds, t.seconds) ASC NULLS LAST, o.rule_id
     LIMIT 1
  )
  SELECT h.s, h.rid FROM hit h
  UNION ALL
  SELECT COALESCE((SELECT t.seconds FROM task_priority_tiers t WHERE t.is_default), 0), NULL::BIGINT WHERE NOT EXISTS (SELECT 1 FROM hit)
$$;
COMMENT ON FUNCTION activity_priority_seconds IS
  '這個缺口（活動名＝派工臂名、選舉、職位）在 p_today 的優先秒數：priority: 規則（窗口由 activity_open 算）相符的取最小（最往後的那條，跟 activity_priority 取層號最大同一個方向），'
  '規則沒填 priority_seconds 用它那一層的秒數；都不相符＝預設層的秒數。永遠回傳剛好一列。seed_auto_task_queue 每輪呼叫。2026-10-13';

CREATE OR REPLACE FUNCTION manual_front_seconds(p_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN manual_task_is_visitor(t.source, t.task_type) THEN q.visitor_front_seconds
              WHEN t.source IN ('manual', 'auto_dispute') THEN q.manual_front_seconds
              ELSE 0 END
    FROM contribution_tasks t CROSS JOIN queue_settings q
   WHERE q.id = 1 AND t.id::TEXT = p_task_id
$$;
COMMENT ON FUNCTION manual_front_seconds IS '手動任務第一次進佇列的插隊秒數（取代 manual_front_at 的 1970／1980）：網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds、其餘 0。2026-10-13';

-- 驗證列沿用它那筆任務的優先秒數（維護者 10-13 11:08：驗證跟同一批任務一起排，比較平衡）；任務列已經收回的就是 0
CREATE OR REPLACE FUNCTION verify_inherited_priority_seconds(p_verify_task_id TEXT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT CASE WHEN q.verify_inherit_negative THEN d.priority_seconds ELSE GREATEST(d.priority_seconds, 0) END
      FROM contributions c
      JOIN task_dispatches d ON d.task_id = COALESCE(c.task_id, c.payload->>'task_id')
      CROSS JOIN queue_settings q
     WHERE 'verify:' || c.id = p_verify_task_id AND q.id = 1
     LIMIT 1), 0)
$$;
COMMENT ON FUNCTION verify_inherited_priority_seconds IS '驗證列的優先秒數＝它那筆任務（task_dispatches）現在的優先秒數，負的當 0（queue_settings.verify_inherit_negative 可改）；找不到任務列＝0。驗證列入列時算一次。2026-10-13';

-- queue_at＝排序鍵：所有寫入 task_dispatches 的路徑（seed、/next 的 task_dispatched、手動任務入列、/boost、冷卻）都經過這裡，不用各自算位置
CREATE OR REPLACE FUNCTION task_dispatches_queue_key() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count THEN
    NEW.boost_seconds := 0;  -- 插隊是一次性的：派出就歸零，回隊尾
  END IF;
  IF NEW.task_id LIKE 'verify:%' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.priority_seconds := verify_inherited_priority_seconds(NEW.task_id);
    END IF;
    -- 驗證列：1970（網站請求、公民提問的交件）、1980（/boost）年段照舊不動，其餘＝進隊時間 − 任務的優先秒數 − 驗證另加的秒數
    IF NEW.queue_at IS NULL OR NEW.queue_at >= TIMESTAMPTZ '2000-01-01' THEN
      NEW.queue_at := COALESCE(NEW.last_dispatched_at, now())
                      - make_interval(secs => COALESCE(NEW.priority_seconds, 0)
                                              + COALESCE((SELECT q.verify_priority_seconds FROM queue_settings q WHERE q.id = 1), 0));
    END IF;
  ELSE
    NEW.queue_at := task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION task_dispatches_queue_key IS
  'task_dispatches 的 BEFORE INSERT／UPDATE 觸發器（2026-10-13）：queue_at 一律照排序鍵重算（任務列 task_queue_key、驗證列 進隊時間 − 任務的優先秒數 − verify_priority_seconds，驗證列的 1970／1980 年段不動）；派出時插隊秒數歸零。'
  '名字排在 verify_front_* 前面，所以網站請求交件的驗證列仍由那兩支排到 1970 年段';
DROP TRIGGER IF EXISTS trg_task_dispatches_queue_key ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_queue_key BEFORE INSERT OR UPDATE ON task_dispatches
  FOR EACH ROW EXECUTE FUNCTION task_dispatches_queue_key();

-- ------------------------------------------------------------
-- 3. 派工函式（各自以現行定義為底，只做機械式替換，標 >>> 優先秒數）
-- ------------------------------------------------------------
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
    -- >>> 優先秒數（20261011320000）：冷卻結束時間＝查核時間＋冷卻天數（同一個任務取最晚的那筆）
    SELECT tc.task_id, max(tc.checked_at + (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL) AS until
      FROM task_checks tc
    -- <<< 優先秒數
    WHERE tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL
    -- 比任何一種冷卻都長的歷史紀錄不用逐筆問天數（task_checks 只會越積越多；agy 審查 #480）：上限是一個 InitPlan，只算一次
      AND tc.checked_at > now() - make_interval(days => (SELECT task_cooldown_max_days()))
    GROUP BY tc.task_id
  )
  -- >>> 優先秒數：blocked 照舊只管 auto: 列；冷卻改成「排序鍵晚於 現在＋可派視界（queue_settings.dispatch_horizon_seconds，一天）就先不派」，
  --     排序鍵＝task_queue_key（進隊時間 − 優先秒數，冷卻結束時間當下限，再減插隊秒數），所有任務列（不含驗證列）都算
  , x AS (
    SELECT d.task_id,
           CASE WHEN d.task_id LIKE 'auto:%' THEN EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id) ELSE d.blocked END AS blocked,
           c.until,
           task_queue_key(d.last_dispatched_at, d.priority_seconds, c.until, d.boost_seconds)
             > now() + make_interval(secs => (SELECT q.dispatch_horizon_seconds FROM queue_settings q WHERE q.id = 1)) AS cooling
      FROM task_dispatches d LEFT JOIN cool c ON c.task_id = d.task_id
     WHERE d.task_id NOT LIKE 'verify:%'
  )
  UPDATE task_dispatches d
     SET blocked = x.blocked, cool_until = x.until, cooling = COALESCE(x.cooling, false)
    FROM x
   WHERE x.task_id = d.task_id
     AND (d.blocked, d.cool_until, d.cooling) IS DISTINCT FROM (x.blocked, x.until, COALESCE(x.cooling, false));
  -- <<< 優先秒數
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
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

  -- >>> 優先秒數（20261011320000）：每個缺口的優先秒數（每組「臂×選舉×職位」問一次；多條規則相符取最小，跟優先層「取最後面那層」同一個方向）
  ALTER TABLE _gaps ADD COLUMN priority_seconds INTEGER;
  UPDATE _gaps g SET priority_seconds = p.seconds
    FROM (SELECT k.arm, k.eid, k.etype, x.seconds
            FROM (SELECT DISTINCT y.arm, election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL activity_priority_seconds(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先秒數

  -- >>> 流量提層：人物頁、政見頁近 window_days 天有真實流量（page_traffic_hot）的，名下缺口的層壓到 boost_tier；page_traffic 與狀態都是空的就什麼都不做（參數與規則見 traffic_boost_settings、traffic_boost_apply）
  PERFORM traffic_boost_apply();
  -- <<< 流量提層
  -- >>> 優先秒數：流量提層的缺口（opened_by.traffic_boost）至少給 traffic_boost_settings.boost_seconds
  UPDATE _gaps g SET priority_seconds = GREATEST(COALESCE(g.priority_seconds, 0), s.boost_seconds)
    FROM traffic_boost_settings s
   WHERE s.id = 1 AND s.enabled AND g.opened_by->>'traffic_boost' = 'true';
  -- <<< 優先秒數

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

  -- >>> 優先層：既有的派工列跟著規則換層（排隊時間不動；下一步的 rebalance 依新的層交錯）
  UPDATE task_dispatches d SET priority = g.priority
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority IS DISTINCT FROM g.priority;
  -- <<< 優先層
  -- >>> 優先秒數：既有的派工列跟著規則換秒數（queue_at 由觸發器照排序鍵重算）
  UPDATE task_dispatches d SET priority_seconds = COALESCE(g.priority_seconds, 0)
    FROM _gaps g WHERE g.task_id = d.task_id AND d.priority_seconds IS DISTINCT FROM COALESCE(g.priority_seconds, 0);
  -- <<< 優先秒數

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by, priority, priority_seconds, boost_seconds)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(),
         g.opened_by || jsonb_strip_nulls(jsonb_build_object('priority', g.priority, 'priority_rule_id', g.priority_rule_id, 'priority_seconds', g.priority_seconds)), g.priority,
         -- >>> 優先秒數：手動任務第一次進佇列＝插隊一次（網站請求／公民提問 visitor_front_seconds、維護者建的與裁決 manual_front_seconds；原本排到 1970／1980）
         COALESCE(g.priority_seconds, 0), CASE WHEN g.arm LIKE 'manual\_%' THEN COALESCE(manual_front_seconds(g.task_id), 0) ELSE 0 END
         -- <<< 優先秒數
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

  RETURN v_new + v_verify;
END;
$$;
COMMENT ON FUNCTION seed_auto_task_queue IS '排程每 10 分鐘：重算全站缺口，新缺口發號碼牌、內容寫進 task_dispatches（內容沒變的列不重寫）、補上的收回；算每個缺口的優先秒數；補驗證列、清掉已定案的；不再重排（queue_at＝排序鍵，觸發器算）。2026-10-13';

CREATE OR REPLACE FUNCTION manual_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_slot TIMESTAMPTZ := visitor_front_slot_start(); n INTEGER;
BEGIN
  IF v_slot IS NULL THEN RETURN 0; END IF;
  -- >>> 優先秒數（20261011320000）：拉回前段＝插隊一次（visitor_front_seconds，原本排到 1970）；已經拉過的（插隊秒數已達這個值）不重複加
  UPDATE task_dispatches d SET boost_seconds = q.visitor_front_seconds
    FROM queue_settings q
   WHERE q.id = 1
     AND d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(true) m)
     AND (d.dispatch_count = 0 OR d.last_dispatched_at < v_slot)
     AND d.boost_seconds < q.visitor_front_seconds;
  -- <<< 優先秒數
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority, priority_seconds, boost_seconds)
  SELECT m.task_id, now(), queue_slot('task'), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         (SELECT x.priority FROM activity_priority(CASE WHEN manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1),
         -- >>> 優先秒數：規則的優先秒數；第一次進佇列＝插隊一次（原本 1970／1980），馬上排到任務行列最前面
         COALESCE((SELECT x.seconds FROM activity_priority_seconds(CASE WHEN manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1), 0),
         COALESCE(manual_front_seconds(m.task_id), 0)
         -- <<< 優先秒數
    FROM contribution_auto_tasks_manual(manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  PERFORM seed_auto_task_queue();
  INSERT INTO task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  -- 最新的插隊最前：第 n 次 → 1980-01-01 減 n 分鐘
  v_at := TIMESTAMPTZ '1980-01-01' - (v_id * INTERVAL '1 minute');
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM task_boost_matches(p_filter);
  UPDATE contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  -- >>> 優先秒數（20261011320000）：驗證列照舊排到 1980 年段；任務列改成加插隊秒數（queue_settings.boost_seconds，插幾次加幾份，派出就歸零），
  --     queue_at 由觸發器照排序鍵馬上重算；插隊的不受冷卻擋（跟 1980 年段一樣）
  UPDATE task_dispatches d SET queue_at = LEAST(d.queue_at, v_at)
    FROM _boost_hits h WHERE h.task_id = d.task_id AND h.kind = 'verify';
  UPDATE task_dispatches d SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
    FROM _boost_hits h, queue_settings q WHERE q.id = 1 AND h.task_id = d.task_id AND h.kind = 'task';
  -- <<< 優先秒數
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;

CREATE OR REPLACE FUNCTION task_boost_remaining(p_id BIGINT)
RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'tasks', count(*) FILTER (WHERE m.kind = 'task' AND (d.queue_at < TIMESTAMPTZ '1990-01-01' OR d.boost_seconds > 0)),  -- 20261011320000：任務列的插隊改成秒數
    'verifies', count(*) FILTER (WHERE m.kind = 'verify' AND d.queue_at < TIMESTAMPTZ '1990-01-01')
  )
  FROM task_boosts b
  JOIN LATERAL task_boost_matches(b.filter) m ON true
  LEFT JOIN task_dispatches d ON d.task_id = m.task_id
  WHERE b.id = p_id;
$$;

-- ------------------------------------------------------------
-- 4. 主控台：規則總表與存檔多一欄 priority_seconds（日本站 activity_rules 沒有這欄，視圖給 NULL、寫入擋非 NULL）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW shared.dispatch_plan AS
  SELECT 'tw'::TEXT AS site, r.id, r.activity, r.window_kind, r.from_kind, r.from_offset, r.until_kind, r.until_offset, r.min_status,
         r.recur_months, r.reasons, r.levels, r.election_types, r.except_election_types, r.jurisdictions, r.priority,
         r.requires_traffic, NULL::TEXT AS after_step, r.params, r.enabled, r.note, r.created_at, r.updated_at, r.priority_seconds
    FROM public.activity_rules r
  UNION ALL
  SELECT 'jp'::TEXT, r.id, r.activity, r.window_kind, r.from_kind, r.from_offset, r.until_kind, r.until_offset, r.min_status,
         r.recur_months, r.reasons, r.levels, r.election_types, NULL::TEXT[], r.jurisdictions, r.priority,
         false, r.after_step, r.params, r.enabled, r.note, r.created_at, r.updated_at, NULL::INTEGER
    FROM policy_jp.activity_rules r;

CREATE OR REPLACE FUNCTION shared.dispatch_plan_write() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.site ELSE NEW.site END;
  new_id BIGINT;
BEGIN
  IF s IS NULL OR s NOT IN ('tw', 'jp') THEN
    RAISE EXCEPTION 'dispatch_plan：site 只能是 tw 或 jp（收到 %）', COALESCE(s, 'NULL');
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.site IS DISTINCT FROM OLD.site THEN
    RAISE EXCEPTION 'dispatch_plan：規則不能換站（% → %），要搬就刪掉再新增', OLD.site, NEW.site;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'dispatch_plan：規則 id 不能改（gap_events 與 opened_by 記著它）';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF s = 'jp' AND (NEW.except_election_types IS NOT NULL OR COALESCE(NEW.requires_traffic, false) OR NEW.priority_seconds IS NOT NULL) THEN
      RAISE EXCEPTION 'dispatch_plan：except_election_types、requires_traffic、priority_seconds 是台灣專用的欄位，日本的規則不能填';
    END IF;
    IF s = 'tw' AND NEW.after_step IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch_plan：after_step（選舉鏈）是日本專用的欄位，台灣的規則不能填';
    END IF;
  END IF;

  IF s = 'tw' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.activity_rules (id, activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, recur_months,
                                         reasons, levels, election_types, except_election_types, jurisdictions, priority, requires_traffic,
                                         params, enabled, note, priority_seconds)
      VALUES (COALESCE(NEW.id, nextval(pg_get_serial_sequence('public.activity_rules', 'id'))), NEW.activity, NEW.window_kind, NEW.from_kind,
              COALESCE(NEW.from_offset, 0), NEW.until_kind, COALESCE(NEW.until_offset, 0), COALESCE(NEW.min_status, 'announced'), NEW.recur_months,
              NEW.reasons, NEW.levels, NEW.election_types, NEW.except_election_types, NEW.jurisdictions, NEW.priority,
              COALESCE(NEW.requires_traffic, false), COALESCE(NEW.params, '{}'::JSONB), COALESCE(NEW.enabled, true), NEW.note, NEW.priority_seconds)
      RETURNING id INTO new_id;
    ELSIF TG_OP = 'UPDATE' THEN
      UPDATE public.activity_rules SET activity = NEW.activity, window_kind = NEW.window_kind, from_kind = NEW.from_kind, from_offset = NEW.from_offset,
             until_kind = NEW.until_kind, until_offset = NEW.until_offset, min_status = NEW.min_status, recur_months = NEW.recur_months,
             reasons = NEW.reasons, levels = NEW.levels, election_types = NEW.election_types, except_election_types = NEW.except_election_types,
             jurisdictions = NEW.jurisdictions, priority = NEW.priority, requires_traffic = NEW.requires_traffic, params = NEW.params,
             enabled = NEW.enabled, note = NEW.note, priority_seconds = NEW.priority_seconds
       WHERE id = OLD.id;
    ELSE
      DELETE FROM public.activity_rules WHERE id = OLD.id;
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      INSERT INTO policy_jp.activity_rules (id, activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, recur_months,
                                            reasons, levels, election_types, jurisdictions, priority, after_step, params, enabled, note)
      VALUES (COALESCE(NEW.id, nextval(pg_get_serial_sequence('policy_jp.activity_rules', 'id'))), NEW.activity, NEW.window_kind, NEW.from_kind,
              COALESCE(NEW.from_offset, 0), NEW.until_kind, COALESCE(NEW.until_offset, 0), COALESCE(NEW.min_status, 'announced'), NEW.recur_months,
              NEW.reasons, NEW.levels, NEW.election_types, NEW.jurisdictions, NEW.priority, NEW.after_step,
              COALESCE(NEW.params, '{}'::JSONB), COALESCE(NEW.enabled, true), NEW.note)
      RETURNING id INTO new_id;
    ELSIF TG_OP = 'UPDATE' THEN
      UPDATE policy_jp.activity_rules SET activity = NEW.activity, window_kind = NEW.window_kind, from_kind = NEW.from_kind, from_offset = NEW.from_offset,
             until_kind = NEW.until_kind, until_offset = NEW.until_offset, min_status = NEW.min_status, recur_months = NEW.recur_months,
             reasons = NEW.reasons, levels = NEW.levels, election_types = NEW.election_types, jurisdictions = NEW.jurisdictions,
             priority = NEW.priority, after_step = NEW.after_step, params = NEW.params, enabled = NEW.enabled, note = NEW.note
       WHERE id = OLD.id;
    ELSE
      DELETE FROM policy_jp.activity_rules WHERE id = OLD.id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.id := new_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION console_admin_rule_save(
  p_site TEXT, p_id BIGINT, p_rule JSONB, p_reason TEXT, p_set_by TEXT
) RETURNS shared.dispatch_plan
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  allowed CONSTANT TEXT[] := ARRAY['activity', 'window_kind', 'from_kind', 'from_offset', 'until_kind', 'until_offset', 'min_status',
                                   'election_types', 'except_election_types', 'jurisdictions', 'levels', 'reasons', 'priority',
                                   'priority_seconds', 'requires_traffic', 'after_step', 'params', 'enabled', 'note'];
  bad TEXT[];
  cur shared.dispatch_plan;
  v_row shared.dispatch_plan;
  v_id BIGINT;
  v_activity TEXT;
  base_name TEXT;
  known BOOLEAN;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  IF p_site IS NULL OR p_site NOT IN ('tw', 'jp') THEN
    RAISE EXCEPTION 'site 只能是 tw 或 jp';
  END IF;
  IF p_rule IS NULL OR jsonb_typeof(p_rule) <> 'object' THEN
    RAISE EXCEPTION 'rule 要是一個物件（要改的欄位：值）';
  END IF;
  SELECT array_agg(k ORDER BY k) INTO bad FROM jsonb_object_keys(p_rule) AS k WHERE k <> ALL (allowed);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '這些欄位不能從主控台改：%（能改的：%）', array_to_string(bad, '、'), array_to_string(allowed, '、');
  END IF;

  IF p_id IS NULL THEN
    -- 新增
    v_activity := btrim(COALESCE(p_rule->>'activity', ''));
    IF v_activity = '' THEN
      RAISE EXCEPTION '新增規則要給 activity';
    END IF;
    IF NOT (p_rule ? 'window_kind') THEN
      RAISE EXCEPTION '新增規則要給 window_kind（always／event／term／recurring）';
    END IF;
    base_name := CASE WHEN v_activity LIKE 'priority:%' THEN substr(v_activity, 10) ELSE v_activity END;
    IF p_site = 'tw' THEN
      known := base_name = '*' AND v_activity LIKE 'priority:%'
            OR base_name = ANY (public.activity_arm_names())
            OR EXISTS (SELECT 1 FROM public.activity_rules r WHERE r.activity IN (base_name, v_activity));
    ELSE
      known := base_name = '*' AND v_activity LIKE 'priority:%'
            OR base_name = ANY (policy_jp.activity_arm_names())
            OR EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity IN (base_name, v_activity));
    END IF;
    IF NOT known THEN
      RAISE EXCEPTION '「%」不是%站認得的任務名（要新增一種任務，得先寫派工臂，走 migration）', v_activity, CASE p_site WHEN 'tw' THEN '台灣' ELSE '日本' END;
    END IF;

    INSERT INTO shared.dispatch_plan
      SELECT * FROM jsonb_populate_record(NULL::shared.dispatch_plan, p_rule || jsonb_build_object('site', p_site, 'activity', v_activity))
    RETURNING id INTO v_id;
  ELSE
    -- 修改：只動有給的欄位
    IF p_rule ? 'activity' THEN
      RAISE EXCEPTION '既有規則的 activity 不能改（要換任務就停用這條、另外新增）';
    END IF;
    SELECT * INTO cur FROM shared.dispatch_plan WHERE site = p_site AND id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '找不到%站的規則 %', CASE p_site WHEN 'tw' THEN '台灣' ELSE '日本' END, p_id;
    END IF;
    SELECT * INTO v_row FROM jsonb_populate_record(cur, p_rule);
    UPDATE shared.dispatch_plan
       SET window_kind = v_row.window_kind, from_kind = v_row.from_kind, from_offset = v_row.from_offset,
           until_kind = v_row.until_kind, until_offset = v_row.until_offset, min_status = v_row.min_status,
           election_types = v_row.election_types, except_election_types = v_row.except_election_types,
           jurisdictions = v_row.jurisdictions, levels = v_row.levels, reasons = v_row.reasons, priority = v_row.priority, priority_seconds = v_row.priority_seconds,
           requires_traffic = v_row.requires_traffic, after_step = v_row.after_step, params = v_row.params,
           enabled = v_row.enabled, note = v_row.note
     WHERE site = p_site AND id = p_id;
    v_id := p_id;
  END IF;

  -- 誰、為什麼（activity_audit 已經記了改前改後，這一筆補上理由）
  IF p_site = 'tw' THEN
    INSERT INTO public.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES ('activity_rules', v_id::TEXT, 'reason', NULL, to_jsonb(btrim(p_reason)), 'console:' || COALESCE(p_set_by, '未知'));
  ELSE
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES ('activity_rules', v_id::TEXT, 'reason', NULL, to_jsonb(btrim(p_reason)), 'console:' || COALESCE(p_set_by, '未知'));
  END IF;

  SELECT * INTO v_row FROM shared.dispatch_plan WHERE site = p_site AND id = v_id;
  RETURN v_row;
END;
$$;

-- ------------------------------------------------------------
-- 5. 既有的派工列換算
-- ------------------------------------------------------------
-- 層 → 秒數；任務列的 1970／1980 年段 → 插隊秒數（1980 年段裡越早的＝越晚插隊的，多給幾秒保留先後）；然後算冷卻、全部重算排序鍵
-- 先換年段（觸發器一碰到任務列就會照排序鍵重算 queue_at，年段的資訊要在那之前讀）
UPDATE task_dispatches d
   SET boost_seconds = CASE WHEN d.queue_at < TIMESTAMPTZ '1971-01-01' THEN q.visitor_front_seconds
                            ELSE q.boost_seconds + GREATEST(0, floor(extract(epoch FROM TIMESTAMPTZ '1980-01-01 00:00:00+00' - d.queue_at)))::BIGINT END
  FROM queue_settings q
 WHERE q.id = 1 AND d.task_id NOT LIKE 'verify:%' AND d.queue_at < TIMESTAMPTZ '2000-01-01';
UPDATE task_dispatches d SET priority_seconds = t.seconds
  FROM task_priority_tiers t
 WHERE d.task_id NOT LIKE 'verify:%'
   AND t.id = COALESCE(d.priority, (SELECT x.id FROM task_priority_tiers x WHERE x.is_default));
-- 驗證列沿用它那筆任務的優先秒數（負的當 0，除非 verify_inherit_negative）
UPDATE task_dispatches v SET priority_seconds = verify_inherited_priority_seconds(v.task_id)
 WHERE v.task_id LIKE 'verify:%' AND v.priority_seconds IS DISTINCT FROM verify_inherited_priority_seconds(v.task_id);
SELECT refresh_dispatch_blocked();
UPDATE task_dispatches SET queue_at = queue_at;  -- 觸發器照排序鍵重算每一列（驗證列的 1970／1980 年段不動）

-- ------------------------------------------------------------
-- 6. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM queue_settings WHERE id = 1) THEN
    RAISE EXCEPTION 'queue_settings 沒有 id=1 那一列';
  END IF;
  IF EXISTS (SELECT 1 FROM task_dispatches WHERE task_id NOT LIKE 'verify:%' AND queue_at < TIMESTAMPTZ '2000-01-01') THEN
    RAISE EXCEPTION '還有任務列留在 1970／1980 年段（應該都換成插隊秒數了）';
  END IF;
  IF EXISTS (SELECT 1 FROM task_dispatches
              WHERE task_id NOT LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds)) THEN
    RAISE EXCEPTION '有任務列的 queue_at 不是排序鍵';
  END IF;
  IF EXISTS (SELECT 1 FROM activity_rules WHERE priority IS NOT NULL AND priority_seconds IS NULL) THEN
    RAISE EXCEPTION '有 priority: 規則沒有優先秒數';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
