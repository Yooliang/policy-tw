-- 派工與排程的啟用時間窗，P0：里程碑表、規則表、覆寫表、判斷函式、缺口出生紀錄（2026-10-08，docs/PLAN-task-activation.md）
-- ============================================================
--
-- 起因：維護者說「台灣一年只有一次選舉，日本一年有很多次，不要一次一次手動調整」。時間窗的座標改成「每場選舉的里程碑日期」，
-- 每種活動只寫「相對於里程碑的規則」，新增一場選舉只要在 elections 填一列、補里程碑，所有時間窗自動成立。
-- 另外維護者 10-07 裁示（計畫 2.5）：每個缺口都要有一筆紀錄，說得出它什麼時候、因為哪一筆資料被開出來。
--
-- 這支只做 P0——「沒有人呼叫」：
--   * 沒有任何一支臂讀這些表（contribution_auto_tasks_arms() 與各臂一字沒動，那是 P1／P2）；
--   * elections 的 status／key 規則沒動（P4）；
--   * activity_rules 沒有種子（P1 才種「永遠開」）。
--   唯一碰到線上行為的是 seed_auto_task_queue()：同簽名、同回傳，派工列的內容與去留跟原本逐件相同，
--   只是多寫兩個新欄位（opened_at、opened_by）與一張只增不刪的流水（gap_events）。
--
-- 做了什麼（只加不刪、函式簽名都沒變，所以不用分兩次上）：
--   1. election_milestones：每場選舉×里程碑一列的窄表（裁示：另開一張表，不在 elections 上加寬欄位）。
--      polling（投票日）與 term_start／term_end（就任日、屆滿日）不存在這張表（CHECK 擋）——它們各有單一真相，
--      視圖 election_milestones_all 把兩邊 UNION 起來，規則讀的是這個視圖。
--   2. activity_rules：每支臂／排程一到多條「里程碑＋偏移天數」的規則；activity_overrides：例外覆寫（絕對日期只在這裡，reason 必填）。
--   3. activity_today()：台北時區的今天，可被 app.activity_today 覆寫（測試用；覆寫中會在 activity_health 現形）。
--   4. activity_open(活動, 選舉, 職位, 今天)：回傳「開窗的規則＋里程碑列」（零列＝關）；缺里程碑＝關；覆寫優先。
--   5. 視圖 activity_open_now（活動×選舉×職位 現在開不開、靠哪條規則哪個里程碑）與 activity_health（正常是空的）。
--   6. 回填里程碑：roster_check_scope.registration_closed_on → registration_close、list_announced_on → list_published
--      （election_type 填職位）；舊欄位保留，兩邊對不上時 activity_health 會列出來（milestone_scope_drift）。
--   7. 三張表各一個審計觸發器，寫 edit_history（照 sync_politician_office_from_election 的寫法：field='*'、整列 jsonb）。
--   8. 缺口出生紀錄（計畫 2.5）：task_dispatches.opened_at／opened_by；新表 gap_events（只增不刪，觸發器擋 UPDATE／DELETE／TRUNCATE）；
--      seed_auto_task_queue() 在新增派工列時寫 opened_at／opened_by 與一筆 opened（之前出現過又消失的寫 reopened）、
--      收回派工列時寫一筆 closed——同一個函式、同一個交易。P0 沒有規則在過濾，opened_by 先填 {"basis":"seed"}，欄位留給 P1。
--      既有的 auto: 派工列回填：opened_at＝LEAST(queue_at, refreshed_at)、opened_by.basis＝'backfill'，gap_events 補一筆 opened（標 backfill）。
--
-- 回填的一個偏離（已在 PR 說明）：插隊的派工列 queue_at 是 1980-01-01 的哨兵值（線上 865 筆），照 LEAST 會把「出生時間」
-- 填成 1980 年；這些列改取 refreshed_at（排程最早確認過它存在的時間），並在 opened_by 記 queue_at_sentinel。
--
-- 守門：supabase/functions/_shared/activity-windows.test.ts
--   * seed_auto_task_queue 新函式＝20261002000007 的現行定義加上標記起訖的事件寫入、兩處欄位清單，其餘一字不差（含還原驗證）；
--   * PGlite 跑舊函式與新函式，派工列逐件相同；
--   * 回填對照（新視圖與 roster_check_scope、elections、election_term_* 逐列相同）、假時鐘下開關邊界（含頭含尾、缺里程碑＝關）、
--     gap_events 有寫、只增不刪；每條守門都有還原驗證（拿掉被守的東西，確認會紅）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：elections(id, election_date, election_reason, election_types)、
-- roster_check_scope(election_id, election_type, registration_closed_on, list_announced_on)、sources(id)、edit_history(table_name, record_id,
-- field, old_value, new_value, agent_name)、task_dispatches(task_id, task_type, queue_at, refreshed_at)、election_term_start／end(integer, text)、
-- auth.role()、seed_auto_task_queue() 用到的 contribution_auto_tasks_arms／queue_slot／refresh_dispatch_blocked／refresh_verify_targets／
-- rebalance_queue／contribution_queue_at。

-- ------------------------------------------------------------
-- 1. 里程碑
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS election_milestones (
  id            BIGSERIAL PRIMARY KEY,
  election_id   INTEGER NOT NULL REFERENCES elections(id),
  kind          TEXT NOT NULL CHECK (kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                                              'bulletin_published', 'result_announced', 'certified')),
  election_type TEXT CHECK (election_type IS NULL OR election_type IN ('總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長',
                                                                       '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')),
  on_date       DATE NOT NULL,
  basis         TEXT NOT NULL CHECK (basis IN ('statutory', 'official', 'agent', 'override')),
  status        TEXT NOT NULL CHECK (status IN ('expected', 'announced', 'done')),
  source_id     BIGINT REFERENCES sources(id),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS election_milestones_uniq ON election_milestones (election_id, kind, (COALESCE(election_type, '')));
COMMENT ON TABLE election_milestones IS
  '每場選舉×里程碑一列的窄表（日期是當地時區的日曆日）。election_type 空＝整場選舉，填職位＝只對該職位有效。polling（投票日）與 term_start／term_end（任期起訖）不存這裡——'
  '單一真相在 elections.election_date 與 election_term_start／end()，由視圖 election_milestones_all 併進來。規則讀視圖，不直接讀這張表。2026-10-08（PLAN-task-activation 2.1）';
COMMENT ON COLUMN election_milestones.basis IS 'statutory＝法定推算｜official＝官方公告｜agent＝代理交件、投票通過｜override＝維護者例外覆寫';
COMMENT ON COLUMN election_milestones.status IS 'expected＝預估｜announced＝已公告｜done＝已發生。規則的 min_status 用它決定「預估的日期算不算數」；done 要有人（或之後的同步）維護，沒維護只是停在 announced，不影響開窗';

-- ------------------------------------------------------------
-- 2. 規則與覆寫
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_rules (
  id             BIGSERIAL PRIMARY KEY,
  activity       TEXT NOT NULL,
  window_kind    TEXT NOT NULL CHECK (window_kind IN ('event', 'term', 'recurring', 'always')),
  from_kind      TEXT CHECK (from_kind IS NULL OR from_kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                                                                 'bulletin_published', 'polling', 'result_announced', 'certified', 'term_start', 'term_end')),
  from_offset    INTEGER NOT NULL DEFAULT 0,
  until_kind     TEXT CHECK (until_kind IS NULL OR until_kind IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                                                                  'bulletin_published', 'polling', 'result_announced', 'certified', 'term_start', 'term_end')),
  until_offset   INTEGER NOT NULL DEFAULT 0,
  min_status     TEXT NOT NULL DEFAULT 'announced' CHECK (min_status IN ('expected', 'announced', 'done')),
  recur_months   INT4RANGE,
  reasons        TEXT[],
  levels         TEXT[],
  election_types TEXT[],
  jurisdictions  TEXT[],
  params         JSONB NOT NULL DEFAULT '{}'::JSONB,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT activity_rules_levels_known CHECK (levels IS NULL OR levels <@ ARRAY['national', 'regional', 'local']::TEXT[]),
  CONSTRAINT activity_rules_positions_known CHECK (
    election_types IS NULL OR election_types <@ ARRAY['總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']::TEXT[]
  ),
  -- 窗口的形狀：always 不掛里程碑；其餘至少掛一端；recurring 一定要有月份；event 掛事件、term／recurring 掛任期
  CONSTRAINT activity_rules_shape CHECK (
    (window_kind = 'always' AND from_kind IS NULL AND until_kind IS NULL AND recur_months IS NULL)
    OR (window_kind = 'event' AND (from_kind IS NOT NULL OR until_kind IS NOT NULL) AND recur_months IS NULL
        AND COALESCE(from_kind, '') NOT IN ('term_start', 'term_end') AND COALESCE(until_kind, '') NOT IN ('term_start', 'term_end'))
    OR (window_kind = 'term' AND (from_kind IS NOT NULL OR until_kind IS NOT NULL) AND recur_months IS NULL
        AND COALESCE(from_kind, 'term_start') IN ('term_start', 'term_end') AND COALESCE(until_kind, 'term_start') IN ('term_start', 'term_end'))
    OR (window_kind = 'recurring' AND recur_months IS NOT NULL AND (from_kind IS NOT NULL OR until_kind IS NOT NULL)
        AND COALESCE(from_kind, 'term_start') IN ('term_start', 'term_end') AND COALESCE(until_kind, 'term_start') IN ('term_start', 'term_end'))
  )
);
CREATE INDEX IF NOT EXISTS activity_rules_activity_idx ON activity_rules (activity) WHERE enabled;
COMMENT ON TABLE activity_rules IS
  '每支派工臂／排程一到多條「相對於里程碑的規則」（同一活動多條＝OR）。規則不指名選舉：對每一場符合範圍（reasons／levels／election_types／jurisdictions，空＝不限）的選舉各自算窗口。'
  '規則只走 migration（流程規則，維護者裁）；緊急止血或例外用 activity_overrides。窗口含頭含尾、日曆天、台北日界；缺里程碑＝關。2026-10-08（PLAN-task-activation 2.2）';
COMMENT ON COLUMN activity_rules.window_kind IS 'event＝相對事件（登記截止、投票日…）｜term＝相對任期（term_start／term_end）｜recurring＝任期內每年某幾個月（recur_months）｜always＝永遠開（也是一條有名字的規則列）';
COMMENT ON COLUMN activity_rules.min_status IS '起點里程碑（沒有起點就看迄點）至少要到這個確定程度才算數；預設 announced，預估日期不會讓窗口開';
COMMENT ON COLUMN activity_rules.params IS '臂自己的參數（term_policy_missing 的 positions、bulletin_hint、scope_note；roster_check 的 recheck_days、regions；cap 等），P2 起併入';

CREATE TABLE IF NOT EXISTS activity_overrides (
  id            BIGSERIAL PRIMARY KEY,
  activity      TEXT NOT NULL,
  election_id   INTEGER REFERENCES elections(id),
  election_type TEXT CHECK (election_type IS NULL OR election_type IN ('總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長',
                                                                       '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')),
  "force"       TEXT NOT NULL CHECK ("force" IN ('open', 'closed', 'window')),
  open_from     DATE,
  open_until    DATE,
  reason        TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    DATE,
  CONSTRAINT activity_overrides_window_dates CHECK (
    ("force" = 'window' AND (open_from IS NOT NULL OR open_until IS NOT NULL) AND (open_from IS NULL OR open_until IS NULL OR open_from <= open_until))
    OR ("force" <> 'window' AND open_from IS NULL AND open_until IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS activity_overrides_activity_idx ON activity_overrides (activity);
COMMENT ON TABLE activity_overrides IS
  '例外覆寫（絕對日期只在這裡）：closed＝一律關（優先於一切）；open＝一律開；window＝以 open_from～open_until（含頭含尾）取代規則。範圍空＝不限選舉／職位；expires_at（含當天）過了就失效。'
  'reason 必填；寫入走管理員端點（service_role），每筆進 edit_history。覆寫反覆出現代表規則寫錯了，回頭改規則。2026-10-08（PLAN-task-activation 2.3）';

-- RLS：照 election_task_config——公開讀、只有 service_role 寫
ALTER TABLE election_milestones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON election_milestones;
CREATE POLICY "Public read" ON election_milestones FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON election_milestones;
CREATE POLICY "Service role write" ON election_milestones FOR ALL USING (auth.role() = 'service_role');

ALTER TABLE activity_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON activity_rules;
CREATE POLICY "Public read" ON activity_rules FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON activity_rules;
CREATE POLICY "Service role write" ON activity_rules FOR ALL USING (auth.role() = 'service_role');

ALTER TABLE activity_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON activity_overrides;
CREATE POLICY "Public read" ON activity_overrides FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON activity_overrides;
CREATE POLICY "Service role write" ON activity_overrides FOR ALL USING (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 3. 審計與 updated_at（#425 的 election_task_config 的 updated_at 要靠人記得填，這三張表不靠人）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION activity_audit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES (TG_TABLE_NAME, to_jsonb(NEW)->>'id', '*', NULL, to_jsonb(NEW), 'activity-audit');
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES (TG_TABLE_NAME, to_jsonb(NEW)->>'id', '*', to_jsonb(OLD), to_jsonb(NEW), 'activity-audit');
    RETURN NEW;
  ELSE
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES (TG_TABLE_NAME, to_jsonb(OLD)->>'id', '*', to_jsonb(OLD), NULL, 'activity-audit');
    RETURN OLD;
  END IF;
END;
$$;
COMMENT ON FUNCTION activity_audit IS '里程碑、規則、覆寫三張表的審計：每次新增／修改／刪除各記一列 edit_history（field=*、整列 jsonb、agent_name=activity-audit）';

CREATE OR REPLACE FUNCTION activity_touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_election_milestones_touch ON election_milestones;
CREATE TRIGGER trg_election_milestones_touch BEFORE UPDATE ON election_milestones FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_activity_rules_touch ON activity_rules;
CREATE TRIGGER trg_activity_rules_touch BEFORE UPDATE ON activity_rules FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();

DROP TRIGGER IF EXISTS trg_election_milestones_audit ON election_milestones;
CREATE TRIGGER trg_election_milestones_audit AFTER INSERT OR UPDATE OR DELETE ON election_milestones FOR EACH ROW EXECUTE FUNCTION activity_audit();
DROP TRIGGER IF EXISTS trg_activity_rules_audit ON activity_rules;
CREATE TRIGGER trg_activity_rules_audit AFTER INSERT OR UPDATE OR DELETE ON activity_rules FOR EACH ROW EXECUTE FUNCTION activity_audit();
DROP TRIGGER IF EXISTS trg_activity_overrides_audit ON activity_overrides;
CREATE TRIGGER trg_activity_overrides_audit AFTER INSERT OR UPDATE OR DELETE ON activity_overrides FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ------------------------------------------------------------
-- 4. 今天、層級、管轄、確定程度
-- ------------------------------------------------------------
-- 台北時間的日界（取代散落各處的 CURRENT_DATE：那是資料庫 UTC 的日期，台灣 00:00～08:00 會慢一天）。
-- 測試用 SET app.activity_today = '2026-11-28' 覆寫；正式環境不該設，設了 activity_health 會列出 clock_overridden。
CREATE OR REPLACE FUNCTION activity_today(p_tz TEXT DEFAULT 'Asia/Taipei') RETURNS DATE
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.activity_today', true), '')::DATE, (now() AT TIME ZONE p_tz)::DATE)
$$;
COMMENT ON FUNCTION activity_today IS '規則用的「今天」：台北時區的日曆日；可被 app.activity_today 覆寫（假時鐘，只給測試）。elections.timezone 在 P4 才有，之前一律台北';

-- 層級（兩國共用的詞彙，計畫第 6 節）：台灣總統副總統、立法委員＝national，其餘七種＝local；regional 留給日本的都道府縣。P4 加 elections.level 後改讀欄位
CREATE OR REPLACE FUNCTION activity_level(p_election_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
           WHEN p_election_type IN ('總統副總統', '立法委員') THEN 'national'
           WHEN p_election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長') THEN 'local'
         END
$$;

-- 管轄：現在只有台灣（elections 沒有 jurisdiction 欄，P4 才加）；選舉不存在就是 NULL（限定管轄的規則不會比對到）
CREATE OR REPLACE FUNCTION activity_jurisdiction(p_election_id INTEGER) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT 'tw'::TEXT FROM elections e WHERE e.id = p_election_id
$$;

CREATE OR REPLACE FUNCTION activity_status_rank(p_status TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status WHEN 'expected' THEN 1 WHEN 'announced' THEN 2 WHEN 'done' THEN 3 ELSE 0 END
$$;

-- ------------------------------------------------------------
-- 5. 視圖 election_milestones_all：存的里程碑＋投票日（elections）＋任期起訖（election_term_*）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW election_milestones_all AS
  SELECT m.election_id, m.kind, m.election_type, m.on_date, m.basis, m.status, m.source_id, m.note,
         'table'::TEXT AS origin, m.id AS milestone_id
    FROM election_milestones m
  UNION ALL
  SELECT e.id, 'polling'::TEXT, NULL::TEXT, e.election_date, 'official'::TEXT,
         CASE WHEN e.election_date < activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'elections'::TEXT, NULL::BIGINT
    FROM elections e
   WHERE e.election_date IS NOT NULL
  UNION ALL
  SELECT e.id, 'term_start'::TEXT, t.election_type, election_term_start(e.id, t.election_type), 'statutory'::TEXT,
         CASE WHEN election_term_start(e.id, t.election_type) <= activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'function'::TEXT, NULL::BIGINT
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
   WHERE election_term_start(e.id, t.election_type) IS NOT NULL
  UNION ALL
  SELECT e.id, 'term_end'::TEXT, t.election_type, election_term_end(e.id, t.election_type), 'statutory'::TEXT,
         CASE WHEN election_term_end(e.id, t.election_type) <= activity_today() THEN 'done' ELSE 'announced' END,
         NULL::BIGINT, NULL::TEXT, 'function'::TEXT, NULL::BIGINT
    FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
   WHERE election_term_end(e.id, t.election_type) IS NOT NULL;
COMMENT ON VIEW election_milestones_all IS
  '規則讀的里程碑全貌：election_milestones（origin=table）＋投票日 polling（來自 elections.election_date）＋就任日／屆滿日 term_start／term_end（來自 election_term_start／end，一個職位一列；罷免沒有任期不列）。'
  '後兩者不重複存。polling／term 的 status：日期已過＝done，否則 announced。2026-10-08';

-- ------------------------------------------------------------
-- 6. 回填里程碑：roster_check_scope 的兩個日期（election_type 填職位）
-- ------------------------------------------------------------
INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT s.election_id, 'registration_close', s.election_type, s.registration_closed_on, 'official',
       CASE WHEN s.registration_closed_on <= activity_today() THEN 'done' ELSE 'announced' END,
       '2026-10-08 由 roster_check_scope.registration_closed_on 回填'
  FROM roster_check_scope s
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
SELECT s.election_id, 'list_published', s.election_type, s.list_announced_on, 'official',
       CASE WHEN s.list_announced_on <= activity_today() THEN 'done' ELSE 'announced' END,
       '2026-10-08 由 roster_check_scope.list_announced_on 回填'
  FROM roster_check_scope s
ON CONFLICT (election_id, kind, (COALESCE(election_type, ''))) DO NOTHING;

-- ------------------------------------------------------------
-- 7. activity_open：回傳開窗的規則＋里程碑列（零列＝關）
-- ------------------------------------------------------------
-- 覆寫優先：有生效的 closed → 一律關；有生效的 open／window → 以它們為準（window 不在區間內＝關，不退回規則）；沒有覆寫才看規則。
-- 規則：enabled、範圍符合（reasons／levels／election_types／jurisdictions，空＝不限；選舉或職位是 NULL 時，有限定的規則比對不到）、
--       起點里程碑存在且 today >= 起日、迄點里程碑存在且 today <= 迄日（含頭含尾）、recurring 的月份在範圍內、起點的 status 達 min_status。
--       里程碑查找：同一個選舉、同一個 kind，優先取「職位相同」的那一列，沒有才取「整場選舉」（election_type 空）的那一列。
--       起點或迄點掛了里程碑卻找不到＝關（缺里程碑＝fail closed）；always 規則不看里程碑。
-- 回傳多列＝多條規則（或覆寫）同時開著（OR），expected_open_on 最早的排前面。
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
COMMENT ON FUNCTION activity_open IS
  '這個活動對這場選舉（與職位）在 p_today 開不開：回傳開窗的規則（rule_id）＋里程碑列（milestone_kind／milestone_on_date／expected_open_on＝里程碑日期＋偏移／open_until），零列＝關。'
  '缺里程碑＝關；覆寫優先（closed＞open／window＞規則）；沒有選舉的活動傳 NULL，只有 always 規則（或全域覆寫）能開。要布林就 EXISTS (SELECT 1 FROM activity_open(...))。2026-10-08';

-- ------------------------------------------------------------
-- 8. 視圖 activity_open_now 與 activity_health
-- ------------------------------------------------------------
-- 活動×選舉×職位（含「整場選舉」與「不屬於任何選舉」）現在開不開，靠哪些規則、哪個里程碑
CREATE OR REPLACE VIEW activity_open_now AS
  WITH acts AS (
    SELECT activity FROM activity_rules UNION SELECT activity FROM activity_overrides
  ),
  targets AS (
    SELECT NULL::INTEGER AS election_id, NULL::TEXT AS election_type
    UNION ALL SELECT e.id, NULL::TEXT FROM elections e
    UNION ALL SELECT e.id, t.election_type FROM elections e CROSS JOIN LATERAL unnest(e.election_types) AS t(election_type)
  )
  SELECT a.activity, t.election_id, t.election_type, x.is_open, x.rule_ids, x.override_ids,
         x.milestone_kind, x.milestone_on_date, x.expected_open_on, x.open_until, activity_today() AS today
    FROM acts a
    CROSS JOIN targets t
    CROSS JOIN LATERAL (
      SELECT count(*) > 0 AS is_open,
             array_agg(o.rule_id) FILTER (WHERE o.rule_id IS NOT NULL) AS rule_ids,
             array_agg(o.override_id) FILTER (WHERE o.override_id IS NOT NULL) AS override_ids,
             (array_agg(o.milestone_kind ORDER BY o.expected_open_on NULLS LAST, o.rule_id NULLS LAST))[1] AS milestone_kind,
             (array_agg(o.milestone_on_date ORDER BY o.expected_open_on NULLS LAST, o.rule_id NULLS LAST))[1] AS milestone_on_date,
             min(o.expected_open_on) AS expected_open_on,
             max(o.open_until) AS open_until
        FROM activity_open(a.activity, t.election_id, t.election_type) o
    ) x;
COMMENT ON VIEW activity_open_now IS
  '每個有規則或覆寫的活動，對每場選舉（整場與各職位）與「不屬於任何選舉」現在開不開（is_open）、靠哪幾條規則（rule_ids）／覆寫（override_ids）、最早開窗的里程碑與日期。2026-10-08（PLAN-task-activation 3 風險第 2 點）';

-- 規則寫錯會讓整類任務無聲消失（沒有錯誤、只是沒派），所以這個視圖正常是空的；有列就是要看的事
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
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 與里程碑對不上、時鐘被覆寫。'
  '還沒做（P1 起有臂名清單後加）：每支臂至少一條規則。2026-10-08（PLAN-task-activation 3 風險第 2 點）';

-- ------------------------------------------------------------
-- 9. 缺口出生紀錄（計畫 2.5）
-- ------------------------------------------------------------
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
ALTER TABLE task_dispatches ADD COLUMN IF NOT EXISTS opened_by JSONB;
COMMENT ON COLUMN task_dispatches.opened_at IS
  '這一列派工列（auto: 缺口）被 seed_auto_task_queue 第一次排進佇列的時間，之後不改。缺口收回後又出現是新的一列、新的 opened_at；完整的出生與關閉歷史看 gap_events。verify: 列沒有';
COMMENT ON COLUMN task_dispatches.opened_by IS
  '缺口是因為哪一筆資料被開出來的：P0 是 {"basis":"seed"}（還沒有規則在過濾）；回填的既有列是 {"basis":"backfill"}；P1 起帶 rule_id、election_id、milestone_kind、milestone_on_date、expected_open_on（里程碑日期＋偏移）';

CREATE TABLE IF NOT EXISTS gap_events (
  id                BIGSERIAL PRIMARY KEY,
  task_id           TEXT NOT NULL,
  task_type         TEXT,
  event             TEXT NOT NULL CHECK (event IN ('opened', 'closed', 'reopened')),
  at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_id           BIGINT,
  election_id       INTEGER,
  milestone_kind    TEXT,
  milestone_on_date DATE,
  reason            TEXT CHECK (reason IS NULL OR reason IN ('window', 'filled', 'override', 'rule_change')),
  detail            JSONB
);
CREATE INDEX IF NOT EXISTS gap_events_task_idx ON gap_events (task_id, at);
CREATE INDEX IF NOT EXISTS gap_events_at_idx ON gap_events (at);
COMMENT ON TABLE gap_events IS
  '缺口的開關流水，只增不刪（觸發器擋 UPDATE／DELETE／TRUNCATE）：opened＝第一次排進佇列、closed＝收回、reopened＝收回後又出現。派工列被收回後，這裡仍查得到它何時出生、何時、為何關閉。'
  'rule_id 不設外鍵（規則將來可能被 migration 改掉，流水不能跟著消失）。由 seed_auto_task_queue 在新增／收回派工列的同一個交易裡寫入。2026-10-08（PLAN-task-activation 2.5）';
COMMENT ON COLUMN gap_events.reason IS '關閉的原因：window＝窗口關了｜filled＝缺口不存在了（補上了，或臂自己的條件不成立）｜override＝覆寫｜rule_change＝規則改了。P0 還沒有規則在過濾，收回一律記 filled；opened 不填';
COMMENT ON COLUMN gap_events.detail IS 'opened：出生依據（P0 {"basis":"seed"}／回填 {"basis":"backfill"}）；closed：這一列的 opened_at 與 opened_by';

CREATE OR REPLACE FUNCTION gap_events_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gap_events 只增不刪（PLAN-task-activation 2.5）：不能 %', TG_OP;
END;
$$;
DROP TRIGGER IF EXISTS trg_gap_events_append_only ON gap_events;
CREATE TRIGGER trg_gap_events_append_only BEFORE UPDATE OR DELETE ON gap_events FOR EACH ROW EXECUTE FUNCTION gap_events_append_only();
DROP TRIGGER IF EXISTS trg_gap_events_no_truncate ON gap_events;
CREATE TRIGGER trg_gap_events_no_truncate BEFORE TRUNCATE ON gap_events FOR EACH STATEMENT EXECUTE FUNCTION gap_events_append_only();

ALTER TABLE gap_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON gap_events;
CREATE POLICY "Public read" ON gap_events FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role insert" ON gap_events;
CREATE POLICY "Service role insert" ON gap_events FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- 回填既有的 auto: 派工列：opened_at＝LEAST(queue_at, refreshed_at)，不假裝知道真正的出生時間。
-- 例外：插隊的列 queue_at 是 1980-01-01 的哨兵值（task_dispatches 2026-09-20 才建，早於這天的 queue_at 一定不是出生時間），
-- 那種列只取 refreshed_at；兩個都沒有才用 now()。
UPDATE task_dispatches d
   SET opened_at = COALESCE(
         LEAST(CASE WHEN d.queue_at >= TIMESTAMPTZ '2026-09-20 00:00:00+00' THEN d.queue_at END, d.refreshed_at),
         now()),
       opened_by = CASE WHEN d.queue_at < TIMESTAMPTZ '2026-09-20 00:00:00+00'
                        THEN '{"basis":"backfill","queue_at_sentinel":true}'::JSONB
                        ELSE '{"basis":"backfill"}'::JSONB END
 WHERE d.task_id LIKE 'auto:%' AND d.opened_at IS NULL;

INSERT INTO gap_events (task_id, task_type, event, at, detail)
SELECT d.task_id, d.task_type, 'opened', d.opened_at, d.opened_by
  FROM task_dispatches d
 WHERE d.task_id LIKE 'auto:%'
   AND NOT EXISTS (SELECT 1 FROM gap_events e WHERE e.task_id = d.task_id);

-- seed_auto_task_queue：照 20261002000007 的現行定義（與正式庫 pg_get_functiondef 一字不差，2026-10-08 比對過），只機械式加入：
--   ① 收回前寫 closed（-- >>> gap_events 起訖標記之間）
--   ② 新增前寫 opened／reopened（同上）
--   ③ 新增派工列時多寫 opened_at、opened_by（INSERT 的欄位清單與 SELECT 清單各多兩項）
-- 其餘（算缺口、收回、更新、新增、驗證列、重排、回傳值）一字不動；守門見 activity-windows.test.ts。
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM contribution_auto_tasks_arms() g ORDER BY g.task_id;

  -- >>> gap_events：收回前記一筆 closed（同一個交易；P0 沒有規則在過濾，原因一律 filled）
  INSERT INTO gap_events (task_id, task_type, event, at, rule_id, election_id, milestone_kind, milestone_on_date, reason, detail)
  SELECT d.task_id, d.task_type, 'closed', now(), (d.opened_by->>'rule_id')::BIGINT, (d.opened_by->>'election_id')::INTEGER,
         d.opened_by->>'milestone_kind', (d.opened_by->>'milestone_on_date')::DATE, 'filled',
         jsonb_build_object('opened_at', d.opened_at, 'opened_by', d.opened_by)
    FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);
  -- <<< gap_events

  -- 已經不存在的缺口（補上了）：收回號碼牌
  DELETE FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%'
     AND NOT EXISTS (SELECT 1 FROM _gaps g WHERE g.task_id = d.task_id);

  -- 既有的只更新內容，不動排隊位置
  UPDATE task_dispatches d SET task_type = g.task_type, target = g.target, what_we_need = g.what_we_need,
         hint_sources = g.hint_sources, reward = g.reward, region = g.region, refreshed_at = now()
    FROM _gaps g WHERE g.task_id = d.task_id;

  -- 新缺口排進任務行列
  v_base := queue_slot('task');
  -- >>> gap_events：新增前記一筆 opened（以前出現過又消失的記 reopened）；判斷「新缺口」的條件與下面的 INSERT 相同
  INSERT INTO gap_events (task_id, task_type, event, at, detail)
  SELECT g.task_id, g.task_type,
         CASE WHEN EXISTS (SELECT 1 FROM gap_events e WHERE e.task_id = g.task_id) THEN 'reopened' ELSE 'opened' END,
         now(), '{"basis":"seed"}'::JSONB
    FROM _gaps g
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id);
  -- <<< gap_events
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, opened_by)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now(), now(), '{"basis":"seed"}'::JSONB
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

  PERFORM rebalance_queue();

  RETURN v_new + v_verify;
END;
$$;
