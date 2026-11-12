-- 工作卡①：需求疊加成卡優先級（暗上線，旗標預設關）（2026-11-12，docs/PLAN-workcard-123.md 項目①）
-- ============================================================
--
-- 想法：同一張工作卡（work_key）被越多「不同的人」要過，就該越早被派；但派出去沒產出就要減半，免得被洗版。
--   需求秒數 ＝ min(上限, 單位數 × 每單位秒數) × 0.5^(自上次有產出以來被派出幾次)
--   單位數   ＝ 不同的請求者＋不同的提議者＋名冊差異（kind＝request／suggest／roster 各一筆算一單位）
--              ＋ 頁面項 max(0, floor(不同瀏覽者 ÷ demand_view_unit) − 1)（kind＝view；減 1＝第一個單位已由流量提層的 GREATEST 領過，不重複算）
--   查無冷卻中（work_key_ladder_state.check_cool_until > now()）或階梯已結案 → 0；減半次數到 demand_halving_max → 0
-- 疊在 seed 已有的 priority_seconds 加法鏈：規則秒數 → 流量提層 GREATEST → ＋需求（20261112070100）→ ＋選舉年。
-- 排序鍵 task_queue_key／驗證票鍵不動；boost_seconds 仍在鍵最外層、派出歸零，需求在 priority 層、派出不歸零。
--
-- 暗上線：queue_settings.demand_enabled 預設 false。關著時 seed 的 priority_seconds 與前一版逐列相同，
--   但 work_cards 照樣記錄派出次數與需求秒數快照，work_card_demand_preview 視圖可乾跑看「若開了會怎樣」。
--   回滾＝UPDATE queue_settings SET demand_enabled = false（下一輪 seed、最多 10 分鐘，priority_seconds 全數退回），表與觸發器可留著。
--
-- 這支只提供資料面：訊號進點（request-task／提議／頁面瀏覽）不接，併卡（PR3）時才接；先給冪等的 SQL 函式 work_card_signal_add。
-- 不改 TS、不改協議。日本站不跟（沒有 work_key）。新表與函式都不給 anon／authenticated；視圖給 anon 讀但不含 actor。

-- ------------------------------------------------------------
-- 1. 設定欄（單列表 queue_settings）
-- ------------------------------------------------------------
ALTER TABLE queue_settings
  ADD COLUMN IF NOT EXISTS demand_enabled        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS demand_unit_seconds   INTEGER NOT NULL DEFAULT 172800  CHECK (demand_unit_seconds >= 0),
  ADD COLUMN IF NOT EXISTS demand_cap_seconds    INTEGER NOT NULL DEFAULT 1209600 CHECK (demand_cap_seconds BETWEEN 0 AND 7776000),  -- 上限 90 天：seed 把它轉 INTEGER 加進 priority_seconds，不能溢位
  ADD COLUMN IF NOT EXISTS demand_signal_days    INTEGER NOT NULL DEFAULT 30      CHECK (demand_signal_days >= 1),
  ADD COLUMN IF NOT EXISTS demand_halving_max    INTEGER NOT NULL DEFAULT 6       CHECK (demand_halving_max >= 1),
  ADD COLUMN IF NOT EXISTS demand_view_unit      INTEGER NOT NULL DEFAULT 5       CHECK (demand_view_unit >= 1);
COMMENT ON COLUMN queue_settings.demand_enabled IS '工作卡需求疊加開關（20261112070000）：false（預設）＝只記錄、不影響排序；true＝seed 把 work_cards.demand_seconds 加進 priority_seconds。回滾＝改回 false。2026-11-12';
COMMENT ON COLUMN queue_settings.demand_unit_seconds IS '每個需求單位的秒數（初值 2 天）。2026-11-12';
COMMENT ON COLUMN queue_settings.demand_cap_seconds IS '需求項總上限（初值 14 天，遠小於選舉年一級的 200 天，不會翻掉 2024／2026 次序）。2026-11-12';
COMMENT ON COLUMN queue_settings.demand_signal_days IS '需求訊號有效天數（初值 30）：created_at 超過就不算。2026-11-12';
COMMENT ON COLUMN queue_settings.demand_halving_max IS '派出沒產出的減半次數上限（初值 6）：每次派出沒產出需求減半，次數到這個值就視同 0。2026-11-12';
COMMENT ON COLUMN queue_settings.demand_view_unit IS '頁面項：每幾位不同瀏覽者一個單位（初值 5）；只算超過流量提層門檻（第一個單位）的部分。2026-11-12';

-- ------------------------------------------------------------
-- 2. 兩張表
-- ------------------------------------------------------------
-- 一列＝一個人對一張卡表示過一次需求。actor 是請求者 IP 雜湊／代理名這類識別，不對外
CREATE TABLE IF NOT EXISTS work_card_signals (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_key    TEXT NOT NULL CHECK (work_key <> ''),
  kind        TEXT NOT NULL CHECK (kind IN ('request', 'view', 'suggest', 'roster')),
  actor       TEXT NOT NULL CHECK (actor <> ''),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (work_key, kind, actor)
);
CREATE INDEX IF NOT EXISTS work_card_signals_created_idx ON work_card_signals (created_at);
COMMENT ON TABLE work_card_signals IS '工作卡需求訊號（20261112070000）：同一人（actor）對同一張卡同一類（kind）只算一次，超過 queue_settings.demand_signal_days 天不算。私有表：RLS 開、只有 service_role policy，anon／authenticated 無權限。2026-11-12';

-- 每張被派出過或有需求的卡一列：觀測快照與「沒產出」記帳，不是排序真相（排序真相是 seed 每輪從訊號重算）
CREATE TABLE IF NOT EXISTS work_cards (
  work_key              TEXT PRIMARY KEY,
  no_output_dispatches  INTEGER NOT NULL DEFAULT 0 CHECK (no_output_dispatches >= 0),
  demand_seconds        BIGINT NOT NULL DEFAULT 0,
  last_dispatched_at    TIMESTAMPTZ,
  last_output_at        TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE work_cards IS '工作卡記帳（20261112070000）：no_output_dispatches＝自上次有產出以來被派出幾次（需求減半用）、demand_seconds＝seed 每輪寫的需求秒數快照。demand_enabled 關著時照樣記錄。2026-11-12';

ALTER TABLE work_card_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "work_card_signals service write" ON work_card_signals;
CREATE POLICY "work_card_signals service write" ON work_card_signals FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
ALTER TABLE work_cards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "work_cards public read" ON work_cards;
CREATE POLICY "work_cards public read" ON work_cards FOR SELECT USING (true);
DROP POLICY IF EXISTS "work_cards service write" ON work_cards;
CREATE POLICY "work_cards service write" ON work_cards FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON work_card_signals FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON work_cards FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. 需求秒數（一張卡）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION work_card_demand_seconds(p_work_key TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  WITH s AS (SELECT * FROM queue_settings WHERE id = 1),
  sig AS (
    SELECT count(*) FILTER (WHERE x.kind <> 'view') AS direct,
           count(*) FILTER (WHERE x.kind = 'view')  AS views
      FROM work_card_signals x, s
     WHERE x.work_key = p_work_key AND x.created_at > now() - make_interval(days => s.demand_signal_days)
  ),
  st AS (SELECT * FROM work_key_ladder_state(p_work_key)),
  card AS (SELECT COALESCE((SELECT c.no_output_dispatches FROM work_cards c WHERE c.work_key = p_work_key), 0) AS n)
  SELECT CASE
           WHEN p_work_key IS NULL THEN 0
           WHEN (SELECT st.closed OR COALESCE(st.check_cool_until > now(), FALSE) FROM st) THEN 0   -- 防線①：冷卻中、階梯已結案不疊
           WHEN card.n >= s.demand_halving_max THEN 0                                                -- 防線②：減半到上限視同 0
           ELSE floor(LEAST(s.demand_cap_seconds::NUMERIC,
                            (sig.direct + GREATEST(0, sig.views / s.demand_view_unit - 1)) * s.demand_unit_seconds::NUMERIC)
                      * power(0.5::NUMERIC, card.n))::BIGINT
         END
    FROM s, sig, card
$$;
COMMENT ON FUNCTION work_card_demand_seconds IS '一張工作卡的需求秒數：min(上限, 單位數×每單位) × 0.5^沒產出派出次數；冷卻中、階梯已結案、減半到上限回 0。不看 demand_enabled（乾跑用），旗標只管 seed 要不要加。2026-11-12';

-- seed 每輪呼叫：把有訊號（或原本有需求）的卡的需求秒數寫進 work_cards 快照（值沒變不寫）。回寫了幾列
CREATE OR REPLACE FUNCTION work_card_demand_refresh() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH keys AS (
    SELECT x.work_key FROM work_card_signals x
     WHERE x.created_at > now() - make_interval(days => (SELECT demand_signal_days FROM queue_settings WHERE id = 1))
    UNION
    SELECT c.work_key FROM work_cards c WHERE c.demand_seconds <> 0
  ), calc AS (
    SELECT k.work_key, work_card_demand_seconds(k.work_key) AS sec FROM keys k
  )
  INSERT INTO work_cards (work_key, demand_seconds)
  SELECT work_key, sec FROM calc
  ON CONFLICT (work_key) DO UPDATE SET demand_seconds = EXCLUDED.demand_seconds, updated_at = now()
   WHERE work_cards.demand_seconds IS DISTINCT FROM EXCLUDED.demand_seconds;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION work_card_demand_refresh IS 'seed 每輪呼叫：重算有訊號的卡的需求秒數並寫 work_cards.demand_seconds 快照（IS DISTINCT FROM 才寫）。不論 demand_enabled。2026-11-12';

-- ------------------------------------------------------------
-- 4. 訊號與記帳函式（冪等）
-- ------------------------------------------------------------
-- 寫一筆需求訊號。同一人同卡同類重複呼叫只算一次；已過期的舊訊號再次出現會續期。回傳是否新增或續期
CREATE OR REPLACE FUNCTION work_card_signal_add(p_work_key TEXT, p_kind TEXT, p_actor TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  IF COALESCE(p_work_key, '') = '' OR COALESCE(p_actor, '') = '' THEN RETURN FALSE; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('request', 'view', 'suggest', 'roster') THEN RAISE EXCEPTION 'work_card_signal_add：未知的 kind %', p_kind; END IF;
  INSERT INTO work_card_signals (work_key, kind, actor) VALUES (p_work_key, p_kind, p_actor)
  ON CONFLICT (work_key, kind, actor) DO UPDATE SET created_at = now()
   WHERE work_card_signals.created_at <= now() - make_interval(days => (SELECT demand_signal_days FROM queue_settings WHERE id = 1));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;
COMMENT ON FUNCTION work_card_signal_add IS '工作卡需求訊號寫入（冪等）：(work_key, kind, actor) 唯一；未過期的重複呼叫回 false，過期的續期回 true。訊號進點由併卡 PR 接。2026-11-12';

-- 被派出一次（沒交件前都算沒產出）
CREATE OR REPLACE FUNCTION work_card_mark_dispatched(p_work_key TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO work_cards (work_key, no_output_dispatches, last_dispatched_at) SELECT p_work_key, 1, now() WHERE COALESCE(p_work_key, '') <> ''
  ON CONFLICT (work_key) DO UPDATE SET no_output_dispatches = work_cards.no_output_dispatches + 1, last_dispatched_at = now(), updated_at = now()
$$;
COMMENT ON FUNCTION work_card_mark_dispatched IS '這張卡被派出一次：no_output_dispatches＋1（需求減半用）。2026-11-12';

-- 有產出（回滿）
CREATE OR REPLACE FUNCTION work_card_mark_output(p_work_key TEXT) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO work_cards (work_key, no_output_dispatches, last_output_at) SELECT p_work_key, 0, now() WHERE COALESCE(p_work_key, '') <> ''
  ON CONFLICT (work_key) DO UPDATE SET no_output_dispatches = 0, last_output_at = now(), updated_at = now()
$$;
COMMENT ON FUNCTION work_card_mark_output IS '這張卡有產出：no_output_dispatches 歸零（需求回滿）。2026-11-12';

-- ------------------------------------------------------------
-- 5. 觸發器：派出（task_dispatched 把 dispatch_count＋1）與交件落庫（pending）
-- ------------------------------------------------------------
-- 記帳失敗不能擋派出或交件：吞掉並留 WARNING
CREATE OR REPLACE FUNCTION work_card_on_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM work_card_mark_dispatched(NEW.work_key);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'work_card_on_dispatch：%', SQLERRM;
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION work_card_on_output() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM work_card_mark_output((SELECT d.work_key FROM task_dispatches d WHERE d.task_id = NEW.task_id));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'work_card_on_output：%', SQLERRM;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION work_card_on_dispatch IS '派出觸發器：dispatch_count 變大（task_dispatches 被領走）的非驗證列，這張卡 no_output_dispatches＋1。seed 新增列不走 UPDATE，不算派出。2026-11-12';
COMMENT ON FUNCTION work_card_on_output IS '交件觸發器：貢獻以 pending 落庫、有母任務、型別不是 no_change／task_suggestion，這張卡 no_output_dispatches 歸零。「有產出」的定義與流量提層一致（查無不算）。2026-11-12';

DROP TRIGGER IF EXISTS trg_work_card_dispatch ON task_dispatches;
CREATE TRIGGER trg_work_card_dispatch AFTER UPDATE OF dispatch_count ON task_dispatches
  FOR EACH ROW WHEN (NEW.dispatch_count > OLD.dispatch_count AND NEW.work_key IS NOT NULL AND NEW.task_id NOT LIKE 'verify:%')
  EXECUTE FUNCTION work_card_on_dispatch();
DROP TRIGGER IF EXISTS trg_work_card_output ON contributions;
CREATE TRIGGER trg_work_card_output AFTER INSERT ON contributions
  FOR EACH ROW WHEN (NEW.status = 'pending' AND NEW.task_id IS NOT NULL AND NEW.contribution_type NOT IN ('no_change', 'task_suggestion'))
  EXECUTE FUNCTION work_card_on_output();

REVOKE ALL ON FUNCTION work_card_demand_seconds(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_demand_refresh() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_signal_add(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_mark_dispatched(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_mark_output(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_on_dispatch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_on_output() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION work_card_demand_seconds(TEXT), work_card_demand_refresh(), work_card_signal_add(TEXT, TEXT, TEXT),
  work_card_mark_dispatched(TEXT), work_card_mark_output(TEXT) TO service_role;

-- ------------------------------------------------------------
-- 6. 乾跑視圖（給主控台看；不含 actor，不論 demand_enabled 都能查）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW work_card_demand_preview AS
SELECT s.work_key, s.requests, s.views, s.suggests, s.rosters,
       work_card_demand_seconds(s.work_key) AS demand_seconds,
       (SELECT max(d.priority_seconds) FROM task_dispatches d WHERE d.work_key = s.work_key AND d.task_id NOT LIKE 'verify:%') AS priority_seconds,
       (SELECT q.demand_enabled FROM queue_settings q WHERE q.id = 1) AS demand_enabled
  FROM (SELECT x.work_key,
               count(*) FILTER (WHERE x.kind = 'request') AS requests,
               count(*) FILTER (WHERE x.kind = 'view')    AS views,
               count(*) FILTER (WHERE x.kind = 'suggest') AS suggests,
               count(*) FILTER (WHERE x.kind = 'roster')  AS rosters
          FROM work_card_signals x
         WHERE x.created_at > now() - make_interval(days => (SELECT demand_signal_days FROM queue_settings WHERE id = 1))
         GROUP BY x.work_key) s;
COMMENT ON VIEW work_card_demand_preview IS '工作卡需求乾跑：每張有有效訊號的卡一列（各類訊號數、算出的需求秒數、目前任務列的 priority_seconds、旗標狀態）。不含訊號來源（actor）。旗標關著時 priority_seconds 不含需求。2026-11-12';
GRANT SELECT ON work_card_demand_preview TO anon, authenticated, service_role;
