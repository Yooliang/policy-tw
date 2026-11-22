-- 日本站派工：驗證票排序鍵＋選舉月基準（補齊台灣站已有、日本站「暫不跟」的兩項）（2026-11-22，維護者 17:10 點頭設計）
-- ============================================================
--
-- 兩項放同一支（一個交易，不會出現「票用新鍵、函式還沒到」的中間態）：
--   (a) 驗證票排序鍵——正見 20261104120000（policy-ops#198）的日本版
--   (b) 選舉月基準——正見 20261112005000「選舉年優先」的日本版（日本沒有年後兩碼的算法，改成選舉「月」），取代日本站原本的「選舉鏈排序（最近的選舉先派）」
--
-- ── (a) 驗證票排序鍵 ──
--   驗證票 queue_at ＝ 基準 B − verify_priority_seconds(14 天) − 自己的 boost_seconds ＋ 步長 × 被領走的次數（步長：一般票 7 天、no_change 14 天）。
--   B ＝ 母任務被派出（dispatch_count 變動）當下、派出前的排序位置（含插隊秒數，記在任務列的新欄位 task_dispatches.dispatch_base_at）；
--   「新增」型交件（verify_ticket_is_new）與母任務沒有基準的（沒經過 /next 派出就交件、母任務列已不在）＝交件建立時間（再減選舉月基準，見 (b)）。
--   票入列時把 B 凍結在自己的列上，之後不再看母任務；票被領走時插隊不再歸零（任務列照舊歸零回隊尾）。
--   舊的日本站做法（任務被派出後票排在「進隊時間 − 母任務優先秒數 − 14 天」、網站請求交件另留 1970／1980 年段）整套換掉：觸發器 task_dispatches_queue_key 驗證列一律走 verify_ticket_key，
--   task_boost 對驗證票改加插隊秒數（原本 LEAST(queue_at, 1980 年段)，新觸發器會蓋掉它）。
--   新函式：uuid_or_null、verify_ticket_is_new／parent／priority_seconds／step_seconds／key／freeze_base／base／election_seconds、refresh_verify_ticket_keys；新欄位：
--   task_dispatches.dispatch_base_at、queue_settings.verify_redispatch_seconds（7 天）、verify_no_change_redispatch_seconds（14 天）。
--   日本站沒有的：verify_follows_task 欄（正見 20261017 的過渡旗標，20261104 起不再有作用）→ 觸發器拿掉那一段；驗證先於任務（正見 20261119100000）與基準夾限（20261114070100）暫不跟。
--
-- ── (b) 選舉月基準 ──
--   公式不動：queue_at ＝ GREATEST(進隊時間 − priority_seconds, cool_until) − boost_seconds（task_queue_key）；這支只讓 priority_seconds 多一項「選舉月基準」：
--     M ＝ (選舉年 % 100) × 12 ＋ 月（elections.election_date 的投票日）
--     未來的選舉（投票日 ≥ 今天，日本時間）：base ＝ (1200 − M) × 200 天——越近要投的越大、越先派；相鄰月差 200 天，剛好容納之後的層級×種類 0～199 天
--     已投完的選舉：base ＝ M × 200 − 300,000 天——一律排在所有未來選舉之後，已投完的之間較近的先
--     沒掛選舉的件（網站請求、人物、合併…）：當「最近一場未來選舉」的月；選舉發現／等團體落庫的缺口沒有選舉列，用 target 自己的日期（election_date、vote_window_from）。
--   例：2026-11 的未來選舉 base ＝ 175,400 天、2027-02 ＝ 174,800 天；2026-10 已投完的 ＝ −235,600 天。
--   疊進 priority_seconds 的地方跟正見的選舉年一樣三處：seed_auto_task_queue（每 10 分鐘，缺口）、contribution_tasks_insert_dispatch（手動任務第一次進佇列）、
--   驗證票（沿用母任務位置＝母任務列的 priority_seconds 已含這一項；新增型／沒基準的退路＝建立時間 − 那份交件選舉的 base）。
--   priority_seconds 與 task_queue_key 的優先秒數參數因此從 INTEGER 改 BIGINT（base 最大約 1.5×10^10 秒，INTEGER 上限 2.1×10^9）；queue_at 會落在公元 1500 年前後，
--   所以 task_boost_remaining 不再用「queue_at 早於 1990 年」判斷插隊（改看 boost_seconds）；其他用 2000-01-01 的判斷只在冷卻列（queue_at ≥ 冷卻結束時間）上，不受影響。
--
-- ── 取代舊的「選舉鏈排序」（不是疊加） ──
--   舊做法（20261009300000 ／ 20261011360000）＝①activity_rules 的 priority:<臂> 規則：投票日前 60 天內 +3 天、181 天以上 −30 天（30 條，from/until＝polling −60／−181）；
--   ②seed 對選舉發現、等團體落庫的缺口用 target 日期定層（chain_date_tier：60 天內前段、180 天內中段、更遠後段）。兩者都是「離投票日多近」的粗分三層，選舉月基準按月分 200 天一階，
--   疊在一起會互相干擾，所以：①這支把那 30 條規則 enabled=false（不刪，備份在 priority_backup_20261122_rules）；②seed 拿掉日期定層那一段。
--   不是日期定層的 priority: 規則（manual_visitor +3 天、news_discovery、placeholder_politicians、duplicate_policy、term_policies、投票日後 +1 的 elected_missing／election_results）照舊。
--   chain_date_tier／chain_sort_date／chain_step_rank 函式保留（沒人呼叫排序了，函式留著不動）。
--
-- ── 一次性重算（第 5、6 節） ──
--   既有 verify 列先把基準凍結（queue_at 不變，自我檢查：任何一張變了整支失敗）；再套選舉月基準：任務列 priority_seconds ＝（auto: 缺口 0、手動任務保留原規則秒數）＋ base，
--   驗證票基準減那份交件選舉的 base。改前值備份在 policy_jp.priority_backup_20261122（任務列與驗證列）、policy_jp.priority_backup_20261122_rules（規則）。
--   前後隊頭對照見 PR 描述。冪等：queue_settings.election_month_priority_applied_at 有值就略過。
--
-- ── 回滾 ──
--   ① UPDATE policy_jp.activity_rules r SET enabled = b.enabled FROM policy_jp.priority_backup_20261122_rules b WHERE b.id = r.id;
--   ② UPDATE policy_jp.task_dispatches d SET priority_seconds = b.priority_seconds FROM policy_jp.priority_backup_20261122 b WHERE b.task_id = d.task_id; 之後 queue_at 由觸發器重算
--      （任務列＝舊值；驗證列要把觸發器換回舊版才會回到舊位置：用 20261011360000 的 task_dispatches_queue_key、verify_inherited_priority_seconds、task_queue_key、seed_auto_task_queue
--      （20261019040100 版）、contribution_tasks_insert_dispatch、task_boost／task_boost_remaining 的定義 CREATE OR REPLACE 回去，INTEGER 版的 task_queue_key 要重建）；
--      最後 UPDATE policy_jp.task_dispatches d SET queue_at = b.queue_at FROM policy_jp.priority_backup_20261122 b WHERE b.task_id = d.task_id AND d.task_id LIKE 'verify:%';
--   ③ queue_settings.election_month_priority_applied_at 設回 NULL。新欄位與函式留著無害（沒人呼叫）。
--   priority_seconds 欄的 BIGINT 不必退回（INTEGER 放不下 base 的值，退回前先把值改小）。
--
-- 只動日本站（policy_jp），不碰 public；不升協議版號、不改 TS。

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── 0. 改前備份（回滾用）：任務列與驗證列的排序欄位、被停用的規則 ──────────────────────────────
CREATE TABLE IF NOT EXISTS policy_jp.priority_backup_20261122 AS
  SELECT task_id, priority_seconds, queue_at, dispatch_count, boost_seconds, last_dispatched_at, cool_until, now() AS backed_up_at FROM policy_jp.task_dispatches;
CREATE TABLE IF NOT EXISTS policy_jp.priority_backup_20261122_rules AS
  SELECT id, activity, enabled, from_kind, from_offset, until_kind, until_offset, priority_seconds FROM policy_jp.activity_rules WHERE activity LIKE 'priority:%';
ALTER TABLE policy_jp.priority_backup_20261122 ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_jp.priority_backup_20261122_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON policy_jp.priority_backup_20261122, policy_jp.priority_backup_20261122_rules FROM PUBLIC, anon, authenticated;
GRANT ALL ON policy_jp.priority_backup_20261122, policy_jp.priority_backup_20261122_rules TO service_role;
COMMENT ON TABLE policy_jp.priority_backup_20261122 IS '20261122 驗證票排序鍵＋選舉月基準改前的 task_dispatches 排序欄位（回滾用）；確認沒事後可 DROP';
COMMENT ON TABLE policy_jp.priority_backup_20261122_rules IS '20261122 改前的 priority: 規則（enabled 欄是改前的值；回滾時照它把被停用的規則開回來）';

-- ── 1. 欄位與參數 ──────────────────────────────────────────
-- priority_seconds 要放得下選舉月基準（最大約 1.5×10^10 秒，超過 INTEGER 的 2.1×10^9）：欄位與用到它的函式一起改 BIGINT
ALTER TABLE policy_jp.task_dispatches ALTER COLUMN priority_seconds TYPE BIGINT;
ALTER TABLE policy_jp.queue_settings
  ADD COLUMN IF NOT EXISTS verify_redispatch_seconds INTEGER NOT NULL DEFAULT 604800
    CHECK (verify_redispatch_seconds BETWEEN 0 AND 31536000);
COMMENT ON COLUMN policy_jp.queue_settings.verify_redispatch_seconds IS '驗證票每被領走一次往後排的秒數（預設 7 天；no_change 的票用 verify_no_change_redispatch_seconds）：queue_at ＝ 基準 − verify_priority_seconds − boost_seconds ＋ 步長 × dispatch_count。2026-11-22（正見 20261104120000 的日本版）';
ALTER TABLE policy_jp.queue_settings
  ADD COLUMN IF NOT EXISTS verify_no_change_redispatch_seconds INTEGER NOT NULL DEFAULT 1209600
    CHECK (verify_no_change_redispatch_seconds BETWEEN 0 AND 31536000);
COMMENT ON COLUMN policy_jp.queue_settings.verify_no_change_redispatch_seconds IS 'no_change 驗證票每被領走一次往後排的秒數（預設 14 天；其他票用 verify_redispatch_seconds）。2026-11-22';
ALTER TABLE policy_jp.queue_settings ADD COLUMN IF NOT EXISTS election_month_priority_applied_at TIMESTAMPTZ;
COMMENT ON COLUMN policy_jp.queue_settings.election_month_priority_applied_at IS '選舉月基準的一次性重算（20261122）做完的時間；有值＝已套用，重跑 migration 不再疊加。2026-11-22';
ALTER TABLE policy_jp.task_dispatches ADD COLUMN IF NOT EXISTS dispatch_base_at TIMESTAMPTZ;
COMMENT ON COLUMN policy_jp.task_dispatches.dispatch_base_at IS '任務列：最近一次被派出（dispatch_count 變動）當下、派出前的排序位置（含插隊秒數；負的優先秒數照 verify_inherit_negative），給之後交件產生的驗證票當基準；驗證列：入列時凍結的基準（之後不再看母任務）。沒經過 /next 派出的任務列是 NULL。2026-11-22';

-- ── 2. 函式：參數／回傳型別變了的先刪舊簽名（內容照舊，只是 INTEGER → BIGINT） ───────────────
DROP FUNCTION IF EXISTS policy_jp.task_queue_key(TIMESTAMPTZ, INTEGER, TIMESTAMPTZ, BIGINT);
DROP FUNCTION IF EXISTS policy_jp.verify_inherited_priority_seconds(TEXT);

-- 選舉月基準（日本專屬，取代台灣的選舉年優先）
CREATE OR REPLACE FUNCTION policy_jp.election_month_seconds(p_election_id TEXT, p_target JSONB DEFAULT NULL) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT (CASE WHEN d.v >= policy_jp.activity_today() THEN (1200 - d.m)::BIGINT * 200
               ELSE d.m::BIGINT * 200 - 300000 END) * 86400
    FROM (SELECT x.v, ((EXTRACT(YEAR FROM x.v)::INTEGER % 100) * 12 + EXTRACT(MONTH FROM x.v)::INTEGER) AS m
            FROM (SELECT COALESCE(
                    (SELECT e.election_date FROM policy_jp.elections e WHERE e.id = p_election_id),
                    policy_jp.date_or_null(p_target->>'election_date'),
                    policy_jp.date_or_null(p_target->>'vote_window_from'),
                    (SELECT min(e2.election_date) FROM policy_jp.elections e2 WHERE e2.election_date >= policy_jp.activity_today()),
                    policy_jp.activity_today()) AS v) x) d
$$;
COMMENT ON FUNCTION policy_jp.election_month_seconds IS '選舉月基準秒數（2026-11-22，維護者 11-22 17:10 定案）：M＝(選舉年 % 100) × 12 + 月（投票日）。未來的選舉（投票日 >= 今天，日本時間）＝(1200 − M) × 200 天，越近越大、越先派，相鄰月差 200 天剛好容納之後的層級×種類 0～199 天；已投完的選舉＝M × 200 − 300,000 天，一律排在所有未來選舉之後、較近的先。'
  '選舉日期取 elections.election_date（p_election_id）；沒有選舉 id 的件看 target 自己的日期（election_date、vote_window_from，選舉發現／等團體落庫的缺口）；都沒有（網站請求、人物、合併…）當最近一場未來選舉的月。疊進 priority_seconds，排序鍵 task_queue_key 不動。';

CREATE OR REPLACE FUNCTION policy_jp.uuid_or_null(p_text TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::UUID ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_election_seconds(p_verify_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT policy_jp.election_month_seconds(x.eid, x.tgt)
    FROM (SELECT 1) s
    LEFT JOIN LATERAL (
      SELECT COALESCE(policy_jp.election_id_or_null(b.payload->>'election_id'), policy_jp.election_id_or_null(p.target->>'election_id')) AS eid, p.target AS tgt
        FROM policy_jp.contributions b
        LEFT JOIN policy_jp.task_dispatches p ON p.task_id = COALESCE(b.task_id, b.payload->>'task_id')
       WHERE b.id = policy_jp.uuid_or_null(substr(p_verify_task_id, 8))) x ON true
$$;
COMMENT ON FUNCTION policy_jp.verify_ticket_election_seconds IS '一張驗證票（task_id＝verify:<貢獻 id>）那份交件的選舉月基準秒數：交件 payload.election_id，沒有就看母任務列的 target.election_id（連同 target 日期）；都沒有＝最近一場未來選舉的月。只給 verify_ticket_base 的「沒有母任務位置可沿用」分支與一次性重算用。2026-11-22';

-- 以下是正見現行定義的複本（逐字比對在 policy-jp-dispatch-drift.test.ts，登記在 PAIRS／KEY_FOLLOWED）：
--   task_queue_key／verify_inherited_priority_seconds／verify_ticket_priority_seconds 的 INTEGER 換成 BIGINT（日本站的優先秒數放得下選舉月基準）；
--   task_dispatches_queue_key 拿掉 verify_follows_task 那一段（日本站沒有這一欄）；其餘逐字。
--   取正見 20261104120000／20261112005000 當時的版本（之後正見又加了「驗證先於任務」（20261119100000）與層級×種類帶狀（20261121193000），日本站暫不跟）。

CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_is_new(p_contribution_type TEXT, p_task_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_contribution_type IN ('policy', 'question_answer', 'task_suggestion')
      OR (p_contribution_type IN ('candidacy', 'politician') AND p_task_type = 'roster_check')
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_parent(p_verify_task_id TEXT)
RETURNS TABLE (contribution_type TEXT, created_at TIMESTAMPTZ, parent_id TEXT, parent_task_type TEXT, is_new BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT c.contribution_type, c.created_at, c.pid, c.ptype, policy_jp.verify_ticket_is_new(c.contribution_type, c.ptype)
    FROM (SELECT x.contribution_type, x.created_at, x.pid,
                 COALESCE((SELECT p.task_type FROM policy_jp.task_dispatches p WHERE p.task_id = x.pid),
                          CASE WHEN x.pid LIKE 'auto:%' THEN split_part(x.pid, ':', 2) END,
                          (SELECT t.task_type FROM policy_jp.contribution_tasks t WHERE t.id = policy_jp.uuid_or_null(x.pid))) AS ptype
            FROM (SELECT b.contribution_type, b.created_at, COALESCE(b.task_id, b.payload->>'task_id') AS pid
                    FROM policy_jp.contributions b WHERE b.id = policy_jp.uuid_or_null(substr(p_verify_task_id, 8))) x) c
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_inherited_priority_seconds(p_verify_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT CASE WHEN q.verify_inherit_negative THEN d.priority_seconds ELSE GREATEST(d.priority_seconds, 0) END
      FROM policy_jp.contributions c
      JOIN policy_jp.task_dispatches d ON d.task_id = COALESCE(c.task_id, c.payload->>'task_id')
      CROSS JOIN policy_jp.queue_settings q
     WHERE 'verify:' || c.id = p_verify_task_id AND q.id = 1
     LIMIT 1), 0)
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_priority_seconds(p_verify_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN COALESCE((SELECT t.is_new FROM policy_jp.verify_ticket_parent(p_verify_task_id) t), false) THEN 0
              ELSE policy_jp.verify_inherited_priority_seconds(p_verify_task_id) END
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_step_seconds(p_verify_task_id TEXT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM policy_jp.contributions c WHERE c.id = policy_jp.uuid_or_null(substr(p_verify_task_id, 8)) AND c.contribution_type = 'no_change')
              THEN q.verify_no_change_redispatch_seconds ELSE q.verify_redispatch_seconds END
    FROM policy_jp.queue_settings q WHERE q.id = 1
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_key(p_base TIMESTAMPTZ, p_dispatch_count INTEGER, p_boost_seconds BIGINT, p_step_seconds INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p_base, now())
         - make_interval(secs => s.vs + COALESCE(p_boost_seconds, 0))
         + make_interval(secs => COALESCE(p_step_seconds, 0)::double precision * COALESCE(p_dispatch_count, 0))
    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM policy_jp.queue_settings q WHERE q.id = 1), 0) AS vs) s
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_freeze_base(p_queue_at TIMESTAMPTZ, p_dispatch_count INTEGER, p_boost_seconds BIGINT, p_step_seconds INTEGER)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT p_queue_at
         + make_interval(secs => s.vs + COALESCE(p_boost_seconds, 0))
         - make_interval(secs => COALESCE(p_step_seconds, 0)::double precision * COALESCE(p_dispatch_count, 0))
    FROM (SELECT COALESCE((SELECT q.verify_priority_seconds FROM policy_jp.queue_settings q WHERE q.id = 1), 0) AS vs) s
$$;

CREATE OR REPLACE FUNCTION policy_jp.verify_ticket_base(p_verify_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN t.contribution_type IS NULL THEN NULL
           WHEN t.is_new THEN COALESCE(t.created_at, now()) - make_interval(secs => policy_jp.verify_ticket_election_seconds(p_verify_task_id))  -- >>> 選舉年優先
           ELSE COALESCE((SELECT p.dispatch_base_at FROM policy_jp.task_dispatches p
                           WHERE p.task_id = t.parent_id AND p.dispatch_base_at IS NOT NULL
                             AND p.last_dispatched_at <= COALESCE(t.created_at, now())),
                         COALESCE(t.created_at, now()) - make_interval(secs => policy_jp.verify_ticket_election_seconds(p_verify_task_id)))  -- >>> 選舉年優先
         END
    FROM (SELECT 1) x LEFT JOIN policy_jp.verify_ticket_parent(p_verify_task_id) t ON true
$$;

CREATE OR REPLACE FUNCTION policy_jp.task_dispatches_queue_key() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  -- >>> 驗證票排序（20261104120000）：驗證列的插隊不因派出歸零；任務列派出時先記下派出前的位置（給之後交件的驗證票當基準）再歸零
  IF TG_OP = 'UPDATE' AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count AND NEW.task_id NOT LIKE 'verify:%' THEN
    NEW.dispatch_base_at := policy_jp.task_queue_key(
      COALESCE(OLD.last_dispatched_at, now()),
      CASE WHEN COALESCE((SELECT q.verify_inherit_negative FROM policy_jp.queue_settings q WHERE q.id = 1), false) THEN OLD.priority_seconds ELSE GREATEST(OLD.priority_seconds, 0) END,
      OLD.cool_until, OLD.boost_seconds);
    NEW.boost_seconds := 0;  -- 插隊是一次性的：派出就歸零，回隊尾
  END IF;
  -- <<< 驗證票排序
  IF NEW.task_id LIKE 'verify:%' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.priority_seconds := policy_jp.verify_ticket_priority_seconds(NEW.task_id);
    END IF;
    -- no_change 的 1～2 天延後（20261028140000）不再用：改成 no_change 的步長 14 天；defer_seconds 欄位保留、觸發器不再寫它
    -- >>> 驗證票排序（20261104120000）：入列時凍結基準；遇到沒有基準的舊列（UPDATE）就用現在的 queue_at 反推，不讓票跳位
    IF NEW.dispatch_base_at IS NULL THEN
      IF TG_OP = 'INSERT' THEN
        NEW.dispatch_base_at := COALESCE(policy_jp.verify_ticket_base(NEW.task_id), now());
      ELSE
        NEW.dispatch_base_at := policy_jp.verify_ticket_freeze_base(OLD.queue_at, OLD.dispatch_count, OLD.boost_seconds, policy_jp.verify_ticket_step_seconds(NEW.task_id));
      END IF;
    END IF;
    NEW.queue_at := policy_jp.verify_ticket_key(NEW.dispatch_base_at, NEW.dispatch_count, NEW.boost_seconds, policy_jp.verify_ticket_step_seconds(NEW.task_id));
    -- <<< 驗證票排序
  ELSE
    NEW.queue_at := policy_jp.task_queue_key(COALESCE(NEW.last_dispatched_at, now()), NEW.priority_seconds, NEW.cool_until, NEW.boost_seconds);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.refresh_verify_ticket_keys() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE policy_jp.task_dispatches d
     SET queue_at = policy_jp.verify_ticket_key(d.dispatch_base_at, d.dispatch_count, d.boost_seconds, policy_jp.verify_ticket_step_seconds(d.task_id))
   WHERE d.task_id LIKE 'verify:%' AND d.dispatch_base_at IS NOT NULL
     AND d.queue_at IS DISTINCT FROM policy_jp.verify_ticket_key(d.dispatch_base_at, d.dispatch_count, d.boost_seconds, policy_jp.verify_ticket_step_seconds(d.task_id));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_queue_row() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
    VALUES ('verify:' || NEW.id, now(), now(), 0)
    ON CONFLICT (task_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION policy_jp.task_queue_key(p_entered TIMESTAMPTZ, p_priority_seconds BIGINT, p_cool_until TIMESTAMPTZ, p_boost_seconds BIGINT)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(p_entered - make_interval(secs => COALESCE(p_priority_seconds, 0)), p_cool_until)
         - make_interval(secs => COALESCE(p_boost_seconds, 0))
$$;

COMMENT ON FUNCTION policy_jp.verify_ticket_step_seconds IS '驗證票每被領走一次往後排的秒數（2026-11-22）：no_change 14 天、其餘 7 天（queue_settings 兩個參數）';
COMMENT ON FUNCTION policy_jp.verify_ticket_key IS '驗證票的排序鍵（2026-11-22）：基準 − verify_priority_seconds − 自己的 boost_seconds ＋ 步長 × dispatch_count（步長見 verify_ticket_step_seconds）。不看母任務、不看派出時間';
COMMENT ON FUNCTION policy_jp.verify_ticket_freeze_base IS '用 verify_ticket_key 的反運算把基準凍結成「新公式在這一刻剛好等於現在的 queue_at」的值（2026-11-22 過渡）';
COMMENT ON FUNCTION policy_jp.verify_ticket_base IS '驗證票入列時的基準 B（2026-11-22）：新增型＝交件建立時間 − 選舉月基準；一般任務＝母任務列的 dispatch_base_at（交件之後才又被派出的不採用）；沒有基準＝交件建立時間 − 選舉月基準；找不到貢獻回 NULL（觸發器改用 now()）';
COMMENT ON FUNCTION policy_jp.task_dispatches_queue_key IS 'task_dispatches 的 BEFORE INSERT／UPDATE 觸發器：queue_at 一律照排序鍵重算（任務列 task_queue_key；驗證列 verify_ticket_key＝入列時凍結的基準 − 14 天 − 自己的插隊秒數 ＋ 步長 × 領走次數，步長 7 天、no_change 14 天）。任務列派出時記下派出前的位置（dispatch_base_at）、插隊歸零回隊尾；驗證列的插隊不因派出歸零。2026-11-22（正見 20261104120000 的日本版）';
COMMENT ON FUNCTION policy_jp.refresh_verify_ticket_keys IS '驗證票的 queue_at 依列上凍結的基準與設定重算（不看母任務，母任務被插隊不會讓已存在的票移位）；回傳換了位置的張數。2026-11-22';
COMMENT ON FUNCTION policy_jp.task_queue_key IS '排序鍵：GREATEST(進隊時間 − 優先秒數, 冷卻結束時間) − 插隊秒數。2026-11-22 優先秒數參數改 BIGINT（放得下選舉月基準）';

-- ── 3. 手動任務進隊、seed、插隊（日本站的差異都標在函式內） ─────────────────────────
-- contribution_tasks_insert_dispatch：以正見 20261112005000 的現行定義為底，選舉年優先換成選舉月基準（日本專屬，標記那一行）
CREATE OR REPLACE FUNCTION policy_jp.contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority_seconds, boost_seconds)
  SELECT m.task_id, now(), policy_jp.queue_slot('task'), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         -- >>> 優先秒數：規則的優先秒數；第一次進佇列＝插隊一次（原本 1970／1980），馬上排到任務行列最前面
         COALESCE((SELECT x.seconds FROM policy_jp.activity_priority_seconds(CASE WHEN policy_jp.manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1), 0)
           + policy_jp.election_month_seconds(policy_jp.election_id_or_null(m.target->>'election_id'), m.target),  -- 選舉月基準（20261122，日本站）：沒掛選舉的當最近一場未來選舉的月
         COALESCE(policy_jp.manual_front_seconds(m.task_id), 0)
         -- <<< 優先秒數
    FROM policy_jp.contribution_auto_tasks_manual(policy_jp.manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

-- seed_auto_task_queue：以日本站 20261019040100 的現行定義為底（＝正見 20261112005000 版去掉流量提層），機械式替換四處：
--   ① _gaps.priority_seconds 改 BIGINT ② 拿掉「日本版：選舉發現的層」（日期定層）換成「選舉月基準」一行（取代舊的選舉鏈排序）
--   ③ 補驗證列不再呼叫 contribution_queue_at（位置由觸發器算）④ 最後多 refresh_verify_ticket_keys（③④ 同正見 20261017010000）
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
  ALTER TABLE _gaps ADD COLUMN priority_seconds BIGINT, ADD COLUMN priority_rule_id BIGINT;
  UPDATE _gaps g SET priority_seconds = p.seconds, priority_rule_id = p.rule_id
    FROM (SELECT k.arm, k.eid, k.etype, x.seconds, x.rule_id
            FROM (SELECT DISTINCT y.arm, policy_jp.election_id_or_null(y.target->>'election_id') AS eid, NULLIF(y.target->>'election_type', '') AS etype FROM _gaps y) k
            CROSS JOIN LATERAL policy_jp.activity_priority_seconds(k.arm, k.eid, k.etype) x) p
   WHERE p.arm = g.arm
     AND p.eid IS NOT DISTINCT FROM policy_jp.election_id_or_null(g.target->>'election_id')
     AND p.etype IS NOT DISTINCT FROM NULLIF(g.target->>'election_type', '');
  -- <<< 優先秒數

  -- >>> 選舉月基準（20261122，日本站；取代台灣的選舉年優先）：優先秒數再加「選舉月基準」（election_month_seconds）：未來的選舉 (1200 − M) × 200 天（越近越大、越先派）、已投完的 M × 200 − 300,000 天（一律排在所有未來選舉之後）；M＝(選舉年 % 100) × 12 + 月。
  --     缺口 target 沒有選舉的（網站請求、名冊、基本資料…）當最近一場未來選舉的月。取代舊的「選舉鏈排序」（規則的前段 +3 天／後段 −30 天與選舉發現的日期定層），疊在規則秒數之後，所以排序鍵、冷卻判斷、驗證票沿用母任務的位置都自動吃到
  UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0) + policy_jp.election_month_seconds(policy_jp.election_id_or_null(g.target->>'election_id'), g.target);
  -- <<< 選舉月基準

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
  -- >>> 驗證票跟著任務（20261017010000）：位置由觸發器 task_dispatches_queue_key 照 verify_queue_key 算，這裡不再呼叫 contribution_queue_at（原本給 1970）
  INSERT INTO policy_jp.task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT 'verify:' || c.id, now(), now(), 0
  -- <<< 驗證票跟著任務
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
  -- >>> 驗證票跟著任務（20261017010000）：上面任務列的鍵可能剛換（秒數、冷卻、固定時段拉回），還跟著母任務的驗證票跟著換
  PERFORM policy_jp.refresh_verify_ticket_keys();
  -- <<< 驗證票跟著任務

  RETURN v_new + v_verify;
END;
$$;

-- 插隊：驗證票也改成插隊秒數（日本專屬函式，只換驗證那一段）；task_boost_remaining 不再用年份判斷（選舉月基準讓很多列的 queue_at 早於 1990 年）
CREATE OR REPLACE FUNCTION policy_jp.task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  -- 還沒發號碼牌的先發，不然排不到
  PERFORM policy_jp.seed_auto_task_queue();
  INSERT INTO policy_jp.task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM policy_jp.task_boost_matches(p_filter);
  UPDATE policy_jp.contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  -- >>> 驗證票排序（20261122，正見 20261017010000／20261104120000 的日本版）：任務列與驗證票一樣加插隊秒數（queue_settings.boost_seconds，插幾次加幾份，派出就歸零），
  --     queue_at 由觸發器照排序鍵馬上重算；插隊的不受冷卻擋。驗證票原本 LEAST(queue_at, v_at) 排到 1980 年段——新的觸發器一律照排序鍵重算 queue_at，那一行會被蓋掉，所以拿掉
  UPDATE policy_jp.task_dispatches d SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
    FROM _boost_hits h, policy_jp.queue_settings q WHERE q.id = 1 AND h.task_id = d.task_id;
  -- 母任務剛被插隊的，它還跟著它的驗證票跟著走
  PERFORM policy_jp.refresh_verify_ticket_keys();
  -- 回傳值的 queue_at：這次插隊命中的列現在最前面的排序鍵（原本是 1980 年段的位置；沒有命中的列就是 NULL）
  SELECT min(d.queue_at) INTO v_at FROM policy_jp.task_dispatches d JOIN _boost_hits h ON h.task_id = d.task_id;
  -- <<< 驗證票排序
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE policy_jp.task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;

CREATE OR REPLACE FUNCTION policy_jp.task_boost_remaining(p_id BIGINT)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT jsonb_build_object(
    'tasks', count(*) FILTER (WHERE m.kind = 'task' AND d.boost_seconds > 0),  -- 20261122：任務列與驗證票都是插隊秒數（選舉月基準讓 queue_at 早於 1990 年的列很多，不能再用年份判斷）
    'verifies', count(*) FILTER (WHERE m.kind = 'verify' AND d.boost_seconds > 0)
  )
  FROM policy_jp.task_boosts b
  JOIN LATERAL policy_jp.task_boost_matches(b.filter) m ON true
  LEFT JOIN policy_jp.task_dispatches d ON d.task_id = m.task_id
  WHERE b.id = p_id;
$$;

-- ── 4. 權限：日本站的函式只給 service_role（同 20261009130000） ─────────────────────────────
REVOKE EXECUTE ON FUNCTION
  policy_jp.uuid_or_null(TEXT), policy_jp.verify_ticket_is_new(TEXT, TEXT), policy_jp.verify_ticket_parent(TEXT), policy_jp.verify_inherited_priority_seconds(TEXT),
  policy_jp.verify_ticket_priority_seconds(TEXT), policy_jp.verify_ticket_step_seconds(TEXT), policy_jp.verify_ticket_key(TIMESTAMPTZ, INTEGER, BIGINT, INTEGER),
  policy_jp.verify_ticket_freeze_base(TIMESTAMPTZ, INTEGER, BIGINT, INTEGER), policy_jp.verify_ticket_base(TEXT), policy_jp.verify_ticket_election_seconds(TEXT),
  policy_jp.election_month_seconds(TEXT, JSONB), policy_jp.refresh_verify_ticket_keys(), policy_jp.task_queue_key(TIMESTAMPTZ, BIGINT, TIMESTAMPTZ, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  policy_jp.uuid_or_null(TEXT), policy_jp.verify_ticket_is_new(TEXT, TEXT), policy_jp.verify_ticket_parent(TEXT), policy_jp.verify_inherited_priority_seconds(TEXT),
  policy_jp.verify_ticket_priority_seconds(TEXT), policy_jp.verify_ticket_step_seconds(TEXT), policy_jp.verify_ticket_key(TIMESTAMPTZ, INTEGER, BIGINT, INTEGER),
  policy_jp.verify_ticket_freeze_base(TIMESTAMPTZ, INTEGER, BIGINT, INTEGER), policy_jp.verify_ticket_base(TEXT), policy_jp.verify_ticket_election_seconds(TEXT),
  policy_jp.election_month_seconds(TEXT, JSONB), policy_jp.refresh_verify_ticket_keys(), policy_jp.task_queue_key(TIMESTAMPTZ, BIGINT, TIMESTAMPTZ, BIGINT)
  TO service_role;

-- ── 5. 既有的驗證票：凍結基準，位置不動（自我檢查：任何一張變了就整支失敗） ──────────────────
DO $$
DECLARE v_moved INTEGER; v_rows INTEGER;
BEGIN
  LOCK TABLE policy_jp.task_dispatches IN SHARE ROW EXCLUSIVE MODE;
  CREATE TEMP TABLE _verify_before ON COMMIT DROP AS SELECT task_id, queue_at FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%';
  UPDATE policy_jp.task_dispatches d
     SET dispatch_base_at = policy_jp.verify_ticket_freeze_base(d.queue_at, d.dispatch_count, d.boost_seconds, policy_jp.verify_ticket_step_seconds(d.task_id))
   WHERE d.task_id LIKE 'verify:%' AND d.dispatch_base_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT count(*) INTO v_moved FROM _verify_before b JOIN policy_jp.task_dispatches d ON d.task_id = b.task_id WHERE d.queue_at IS DISTINCT FROM b.queue_at;
  IF v_moved > 0 THEN
    RAISE EXCEPTION '驗證票排序過渡失敗：% 張票的 queue_at 變了（共回填 % 張）', v_moved, v_rows;
  END IF;
  RAISE NOTICE '驗證票排序過渡：回填 % 張票的基準，位置沒動', v_rows;
END
$$;

-- ── 6. 選舉月基準：停用舊的選舉鏈規則、一次性重算現有的列 ──────────────────────────────────
-- 取代舊的「選舉鏈排序（最近的選舉先派）」：舊的做法是 activity_rules 的 priority:<臂> 規則（投票日前 60 天內 +3 天、181 天以上 −30 天，30 條）與 seed 對沒有選舉列的缺口
-- 用 target 日期定層（前段 +3 天／中段 0／後段 −30 天）。選舉月基準本身就按月分 200 天一階，舊的前後段加減會跟它疊加，所以停用這 30 條規則（enabled=false，備份在
-- priority_backup_20261122_rules），seed 的日期定層一段已在上面的 seed 拿掉。其餘 priority: 規則（manual_visitor、news_discovery、placeholder_politicians、duplicate_policy、
-- term_policies、投票日後 +1 的 elected_missing／election_results）不是日期定層，照舊。
-- 重算：任務列的 priority_seconds ＝（auto: 缺口 0、手動任務保留原本規則的秒數）＋ 選舉月基準；seed 每 10 分鐘會依規則＋選舉月基準重算一次，兩邊算出來的值一樣，
--   這裡先算一次是為了不等下一輪 seed（排序鍵由觸發器馬上重算）。
--   驗證票：基準 dispatch_base_at 減掉那份交件選舉的選舉月基準、priority_seconds 同步加（記錄用），觸發器照 verify_ticket_key 重算 queue_at；已被領走過的票也套。
-- 冪等：做完在 queue_settings.election_month_priority_applied_at 記時間，有值就整段跳過。
DO $$
DECLARE r RECORD; v_n INTEGER; v_rules INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM policy_jp.queue_settings WHERE id = 1 AND election_month_priority_applied_at IS NOT NULL) THEN
    RAISE NOTICE '選舉月基準的一次性重算已套用過，略過';
    RETURN;
  END IF;
  FOR r IN SELECT CASE WHEN task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END AS kind, count(*) AS n, min(queue_at) AS min_q, percentile_disc(0.5) WITHIN GROUP (ORDER BY queue_at) AS med_q
             FROM policy_jp.task_dispatches WHERE boost_seconds = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '重算前 %：% 件，最小 queue_at %，中位 %', r.kind, r.n, r.min_q, r.med_q;
  END LOOP;

  UPDATE policy_jp.activity_rules SET enabled = false
   WHERE activity LIKE 'priority:%' AND enabled
     AND ((from_kind = 'polling' AND from_offset = -60) OR (until_kind = 'polling' AND until_offset = -181));
  GET DIAGNOSTICS v_rules = ROW_COUNT;
  RAISE NOTICE '停用 % 條舊的選舉鏈（前段／後段）規則', v_rules;

  UPDATE policy_jp.task_dispatches d
     SET priority_seconds = (CASE WHEN d.task_id LIKE 'auto:%' THEN 0 ELSE d.priority_seconds END)
                            + policy_jp.election_month_seconds(policy_jp.election_id_or_null(d.target->>'election_id'), d.target)
   WHERE d.task_id NOT LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 列任務列的 priority_seconds', v_n;

  UPDATE policy_jp.task_dispatches v
     SET dispatch_base_at = COALESCE(v.dispatch_base_at, policy_jp.verify_ticket_freeze_base(v.queue_at, v.dispatch_count, v.boost_seconds, policy_jp.verify_ticket_step_seconds(v.task_id)))
                            - make_interval(secs => policy_jp.verify_ticket_election_seconds(v.task_id)),
         priority_seconds = v.priority_seconds + policy_jp.verify_ticket_election_seconds(v.task_id)
   WHERE v.task_id LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 張驗證票的基準', v_n;

  FOR r IN SELECT CASE WHEN task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END AS kind, count(*) AS n, min(queue_at) AS min_q, percentile_disc(0.5) WITHIN GROUP (ORDER BY queue_at) AS med_q
             FROM policy_jp.task_dispatches WHERE boost_seconds = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '重算後 %：% 件，最小 queue_at %，中位 %', r.kind, r.n, r.min_q, r.med_q;
  END LOOP;

  -- 自我檢查：任務列與驗證列的 queue_at 都等於各自的排序鍵（觸發器已重算）
  IF EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE task_id NOT LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM policy_jp.task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds)) THEN
    RAISE EXCEPTION '有任務列的 queue_at 不是排序鍵';
  END IF;
  IF EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM policy_jp.verify_ticket_key(dispatch_base_at, dispatch_count, boost_seconds, policy_jp.verify_ticket_step_seconds(task_id))) THEN
    RAISE EXCEPTION '有驗證票的 queue_at 不是排序鍵';
  END IF;

  UPDATE policy_jp.queue_settings SET election_month_priority_applied_at = now() WHERE id = 1;
END;
$$;

NOTIFY pgrst, 'reload schema';
