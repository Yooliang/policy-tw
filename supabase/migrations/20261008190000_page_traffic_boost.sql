-- 頁面流量提層：人物頁、政見頁在一段時間內有真實流量時，把它們名下的缺口任務提到前段；流量退了自動回原層（2026-10-08）
-- ============================================================
--
-- 起因：維護者 10-08 同意「人物頁或政見頁有真實流量時，把它們名下的缺口任務提到前段」，並強調「一定時間內」——以滾動時間窗計算，效果有時效、不是永久。
-- 讀者實際在看的頁面，資料缺口該先補；沒人看的頁面維持原本的層。這支是 #443 優先層（task_priority_tiers／activity_rules.priority）的延伸，不另開一套排序。
--
-- 資料流（每小時）：
--   console-fetch（Edge Function，pg_cron 每小時第 17 分）在抓完 GA4 之後，多打一份 runReport：台灣站 property 521879439、近 N 天（N＝traffic_boost_settings.window_days）、
--   維度 pagePath、指標 totalUsers＋screenPageViews，只取路徑完整符合 /politician/<uuid> 或 /policy/<uuid> 的。正見.tw 與 web.app 兩個網域路徑相同，
--   GA 不分網域就已合併（沒有 hostName 維度，totalUsers 是跨網域去重後的人數）；萬一同一路徑出現多列（尾斜線、大小寫），函式端再合併加總。
--   → service_role RPC replace_page_traffic(rows, window_days) 整批覆寫 page_traffic（upsert，並清掉這次沒出現的）。GA 抓失敗就不呼叫（保留上一輪的數字，過了 stale_after_hours 就自動失效）。
--   → seed_auto_task_queue（每 10 分鐘）在算完每個缺口的層之後呼叫 traffic_boost_apply()，把達標頁面名下的缺口層提到 boost_tier；
--     下一步的 rebalance_queue 照新層交錯。/next 仍只讀佇列（09-23 事故的教訓：GA、Edge Function 失敗不能影響 /next）。
--
-- 規則（全部在 traffic_boost_settings 單列，函式裡沒有任何寫死的天數、人數、層號；改值是一行 UPDATE，走 activity_audit 進 edit_history）：
--   1. 達標：page_traffic 的 window_days 與設定一致、近 window_days 天不重複訪客 users ≥ min_users（初值 7 天、5 人），而且資料不比 stale_after_hours（初值 24 小時）舊。
--      任何一項不成立，下一輪 seed 就自動回原層——「一定時間內」由滾動時間窗決定，沒有永久的提層。
--   2. 提層方式：min(原層, boost_tier)。原層仍由 activity_rules 的優先規則算（取號碼最大的規則，#443）；流量只在那之後把層號往前壓，不改 activity_priority()。
--      boost_tier 初值 1（前段）。已經在前段（或更前）的缺口不受影響，也不開始計時。
--   3. 名下的缺口：派工列的 target 整份比對（#448 的做法）——target 文字裡出現達標頁面的 uuid（politician_id、policy_id、dup 的 a／b、handover 的 from_／to_politician_id、
--      lineage_roles 的 people[]、items[] 裡的每一項…各臂形狀不同，所以不挑鍵），或 politician_election_ids／politician_election_id 對得上達標人物的參選紀錄 id。
--      達標的人物頁也涵蓋他名下政見的缺口（target 只有 policy_id 的政見任務）。把 uuid 與參選紀錄 id 先展開成「鍵」，和達標頁的鍵做等值連接；
--      達標頁只有幾百列，不是對每個缺口逐一做子字串比對（#448 的 strpos 在達標頁很多時會是 缺口數 × 達標頁數）。
--   4. 無產出上限（避免沒有資料可補的熱門頁一直佔前段）：頁面因流量被提層後，若 no_yield_days（初值 14）天內它被提層的任務上沒有任何「有產出」的交件，
--      就暫停提層 pause_days（初值 14）天；暫停期滿重新計時（新的一期）。
--      「有產出」＝這些任務（task_id）上出現過型別不是 no_change／task_suggestion、狀態不是 rejected 的交件（contributions）。查無（no_change）與冷卻都不算產出：
--      代理查完回 no_change，缺口會因冷卻暫時消失，但這一頁其實沒有資料可補。每次有產出就把觀察起點往後推（滾動的「N 天沒產出」，不是只看第一天）。
--      頁面達標與否分開記：流量退了、再回來，只要距上次達標不到 no_yield_days，就接續同一期（不重新計時），所以在門檻附近忽上忽下的頁面繞不過這條上限。
--      距上次達標超過 no_yield_days 的狀態列會被清掉，下次達標是全新的一期。
--   5. 記錄：page_traffic_boosts 一頁一列（boosted_since、last_hot_at、last_yield_at、paused_until、lifted_task_ids）；視圖 page_traffic_boosted_tasks 看「現在被流量提層的派工列」。
--      新缺口出生時 opened_by 帶 traffic_boost:true（既有列不改 opened_by）。
--
-- 不做：
--   * 不改 activity_priority()、rebalance_queue()、任何派工臂與總表、/next、queue_slot、task_dispatched、/boost。
--   * 村里長等「預設不追蹤」的類別：目前還沒有限定職位的關窗規則（維護者還在決定），這次不做。以後可以用同一個流量訊號（page_traffic_hot）在新的開窗規則裡開窗。
--   * 不另存個別訪客資料：page_traffic 只有路徑對應的人數與瀏覽數（匿名的頁面統計），公開唯讀。
--
-- 上線順序：套用後 page_traffic 是空的、traffic_boost_apply() 一開頭就回 0，seed 與 rebalance 的輸出與舊版逐件相同；console-fetch 部署之後的下一小時才有數字。
--   migration 先於函式上線沒有風險（函式還沒呼叫 RPC）；函式先於 migration 上線也沒有風險（讀設定表失敗只記日誌，不影響 GA 抓取）。
--
-- 守門：supabase/functions/_shared/page-traffic-boost.test.ts（文字層：seed＝現行版加一處標記起訖的區塊；函式本體沒有寫死的數字；PGlite：達標提層、退了回層、
--   暫停規則、target 各種形狀、設定值改了行為跟著變、page_traffic 空時與舊 seed 逐件相同，每條守門都有還原驗證）、
--   supabase/functions/_shared/page-traffic.test.ts（GA 回應解析的純函式、請求形狀、整條流程的假 fetch）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：task_priority_tiers（#443）、activity_audit／activity_touch_updated_at（P0）、task_dispatches、contributions(task_id, contribution_type, status, created_at)、
-- politicians(id uuid)、policies(id, politician_id)、politician_elections(id, politician_id)、seed_auto_task_queue 現行版＝手動任務變一支臂那支（20261008165000）、auth.role()。

-- ------------------------------------------------------------
-- 1. 設定（單列）：時間窗、門檻、層、無產出觀察期、暫停天數、資料時效
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traffic_boost_settings (
  id                SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled           BOOLEAN NOT NULL DEFAULT true,
  window_days       INTEGER NOT NULL DEFAULT 7  CHECK (window_days BETWEEN 1 AND 90),
  min_users         INTEGER NOT NULL DEFAULT 5  CHECK (min_users >= 1),
  boost_tier        SMALLINT NOT NULL DEFAULT 1 REFERENCES task_priority_tiers(id),
  no_yield_days     INTEGER NOT NULL DEFAULT 14 CHECK (no_yield_days BETWEEN 1 AND 180),
  pause_days        INTEGER NOT NULL DEFAULT 14 CHECK (pause_days BETWEEN 1 AND 180),
  stale_after_hours INTEGER NOT NULL DEFAULT 24 CHECK (stale_after_hours BETWEEN 1 AND 720),
  note              TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE traffic_boost_settings IS
  '頁面流量提層的參數（單列 id=1）。改值一行 UPDATE，例：UPDATE traffic_boost_settings SET min_users = 8, note = ''…'' WHERE id = 1;（每次修改進 edit_history，agent_name=activity-audit）。'
  '函式裡沒有任何寫死的天數、人數、層號。2026-10-08（PLAN-task-activation 第 11 節）';
COMMENT ON COLUMN traffic_boost_settings.enabled IS 'false＝整個停掉：不提層、console-fetch 也不抓流量；已存的狀態列留著';
COMMENT ON COLUMN traffic_boost_settings.window_days IS '滾動時間窗（天）：GA4 runReport 取近幾天（含今天）。console-fetch 讀這個值；replace_page_traffic 收到不同值會拒絕，page_traffic.window_days 不符的列 seed 不採用';
COMMENT ON COLUMN traffic_boost_settings.min_users IS '門檻：近 window_days 天不重複訪客（GA4 totalUsers）至少幾人才算有真實流量';
COMMENT ON COLUMN traffic_boost_settings.boost_tier IS '達標頁面名下的缺口提到哪一層（task_priority_tiers.id）；取 min(原層, boost_tier)，只升不降';
COMMENT ON COLUMN traffic_boost_settings.no_yield_days IS '被流量提層後，這麼多天內提層的任務上沒有任何有產出的交件，就暫停提層；也是狀態列距上次達標多久後清掉';
COMMENT ON COLUMN traffic_boost_settings.pause_days IS '暫停提層的天數；期滿重新計時';
COMMENT ON COLUMN traffic_boost_settings.stale_after_hours IS '流量資料超過幾小時沒更新就失效（GA 抓失敗、console-fetch 停擺時，效果自己退掉，不會卡在上一輪的數字）';
INSERT INTO traffic_boost_settings (id, note) VALUES (1, '初值：近 7 天不重複訪客 ≥ 5 提到前段；14 天無產出暫停 14 天（維護者 2026-10-08）') ON CONFLICT (id) DO NOTHING;

ALTER TABLE traffic_boost_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON traffic_boost_settings;
CREATE POLICY "Public read" ON traffic_boost_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON traffic_boost_settings;
CREATE POLICY "Service role write" ON traffic_boost_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_traffic_boost_settings_touch ON traffic_boost_settings;
CREATE TRIGGER trg_traffic_boost_settings_touch BEFORE UPDATE ON traffic_boost_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_traffic_boost_settings_audit ON traffic_boost_settings;
CREATE TRIGGER trg_traffic_boost_settings_audit AFTER INSERT OR UPDATE OR DELETE ON traffic_boost_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ------------------------------------------------------------
-- 2. 流量（每小時整批覆寫）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_traffic (
  kind        TEXT NOT NULL CHECK (kind IN ('politician', 'policy')),
  target_id   TEXT NOT NULL CHECK (target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  users       INTEGER NOT NULL CHECK (users >= 0),
  views       INTEGER NOT NULL CHECK (views >= 0),
  window_days INTEGER NOT NULL CHECK (window_days >= 1),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, target_id)
);
COMMENT ON TABLE page_traffic IS
  '人物頁（/politician/<uuid>）、政見頁（/policy/<uuid>）近 window_days 天的流量（GA4 台灣站 property 521879439，正見.tw 與 web.app 路徑相同就合併）。users＝不重複訪客（totalUsers）、views＝瀏覽數（screenPageViews）。'
  '匿名的頁面統計，公開唯讀。每小時由 console-fetch 經 replace_page_traffic 整批覆寫（upsert、並清掉這次沒出現的）。2026-10-08';
COMMENT ON COLUMN page_traffic.target_id IS 'uuid 文字（小寫）。不設外鍵：頁面可能已被合併或刪除，流量表不阻擋；對不到人物或政見的列 seed 自然不會用到';
COMMENT ON COLUMN page_traffic.window_days IS '這批數字的時間窗（寫入當下的 traffic_boost_settings.window_days）；與設定不同的列 seed 不採用';

ALTER TABLE page_traffic ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON page_traffic;
CREATE POLICY "Public read" ON page_traffic FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON page_traffic;
CREATE POLICY "Service role write" ON page_traffic FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 寫入用的 RPC：只授權 service_role（console-fetch 以 Edge runtime 自帶的 service role key 呼叫）；search_path 清空、全部寫全名。
-- 整批覆寫：upsert 這次的所有列，清掉這次沒出現的；p_window_days 要等於設定（console-fetch 與設定表對不上時拒絕，不寫入不同窗口的數字）。
CREATE OR REPLACE FUNCTION public.replace_page_traffic(p_rows jsonb, p_window_days integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_window INTEGER; v_n INTEGER;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'replace_page_traffic：p_rows 必須是 JSON 陣列';
  END IF;
  SELECT s.window_days INTO v_window FROM public.traffic_boost_settings s WHERE s.id = 1;
  IF v_window IS NULL OR p_window_days IS DISTINCT FROM v_window THEN
    RAISE EXCEPTION 'replace_page_traffic：時間窗不符（收到 %，設定是 %）', p_window_days, v_window;
  END IF;

  DROP TABLE IF EXISTS _pt_src;
  CREATE TEMP TABLE _pt_src ON COMMIT DROP AS
    SELECT x.kind, lower(x.target_id) AS target_id, sum(x.users)::INTEGER AS users, sum(x.views)::INTEGER AS views
      FROM jsonb_to_recordset(p_rows) AS x(kind text, target_id text, users integer, views integer)
     GROUP BY x.kind, lower(x.target_id);

  INSERT INTO public.page_traffic (kind, target_id, users, views, window_days, updated_at)
  SELECT s.kind, s.target_id, s.users, s.views, p_window_days, now() FROM _pt_src s
  ON CONFLICT (kind, target_id) DO UPDATE
    SET users = EXCLUDED.users, views = EXCLUDED.views, window_days = EXCLUDED.window_days, updated_at = EXCLUDED.updated_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  DELETE FROM public.page_traffic t WHERE NOT EXISTS (SELECT 1 FROM _pt_src s WHERE s.kind = t.kind AND s.target_id = t.target_id);
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.replace_page_traffic(jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_page_traffic(jsonb, integer) FROM anon;
REVOKE ALL ON FUNCTION public.replace_page_traffic(jsonb, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_page_traffic(jsonb, integer) TO service_role;
COMMENT ON FUNCTION public.replace_page_traffic(jsonb, integer) IS
  'console-fetch 每小時呼叫：把近 p_window_days 天的人物頁／政見頁流量整批覆寫進 page_traffic（upsert 並清掉這次沒出現的）。p_rows＝[{kind,target_id,users,views}]；p_window_days 要等於 traffic_boost_settings.window_days，否則拒絕。只授權 service_role。2026-10-08';

-- 目前達標的頁面（滾動時間窗＋資料時效）。seed 與以後的開窗規則共用同一個訊號
CREATE OR REPLACE VIEW page_traffic_hot AS
SELECT t.kind, t.target_id, t.users, t.views, t.updated_at
  FROM page_traffic t
  JOIN traffic_boost_settings s ON s.id = 1
 WHERE s.enabled
   AND t.window_days = s.window_days
   AND t.users >= s.min_users
   AND t.updated_at > now() - make_interval(hours => s.stale_after_hours);
COMMENT ON VIEW page_traffic_hot IS
  '現在算「有真實流量」的頁面：近 window_days 天不重複訪客 ≥ min_users、時間窗與設定一致、資料不比 stale_after_hours 舊（參數都在 traffic_boost_settings）。'
  'seed 的流量提層用它；以後想用同一個流量訊號為村里長等預設不追蹤的類別開窗，也讀這個視圖。2026-10-08';

-- ------------------------------------------------------------
-- 3. 提層狀態：一頁一列
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_traffic_boosts (
  kind            TEXT NOT NULL CHECK (kind IN ('politician', 'policy')),
  target_id       TEXT NOT NULL,
  boosted_since   TIMESTAMPTZ NOT NULL,
  last_hot_at     TIMESTAMPTZ NOT NULL,
  last_yield_at   TIMESTAMPTZ,
  paused_until    TIMESTAMPTZ,
  lifted_task_ids TEXT[] NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, target_id)
);
COMMENT ON TABLE page_traffic_boosts IS
  '頁面流量提層的狀態（seed 每 10 分鐘維護，只有 traffic_boost_apply 寫）。boosted_since＝這一期開始提層的時間；last_hot_at＝最近一次達標；last_yield_at＝這一期內提層任務上最後一次有產出的交件；'
  'paused_until 有值且在未來＝因 no_yield_days 天沒產出而暫停提層；lifted_task_ids＝這一期被提層過的任務（算產出用）。距上次達標超過 no_yield_days 的列會被清掉。2026-10-08';
ALTER TABLE page_traffic_boosts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON page_traffic_boosts;
CREATE POLICY "Public read" ON page_traffic_boosts FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON page_traffic_boosts;
CREATE POLICY "Service role write" ON page_traffic_boosts FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE VIEW page_traffic_boosted_tasks AS
SELECT b.kind, b.target_id, b.boosted_since, d.task_id, d.task_type, d.priority
  FROM page_traffic_boosts b
  JOIN traffic_boost_settings s ON s.id = 1
  JOIN task_dispatches d ON d.task_id = ANY (b.lifted_task_ids)
 WHERE b.paused_until IS NULL AND d.priority <= s.boost_tier;
COMMENT ON VIEW page_traffic_boosted_tasks IS '現在因頁面流量而排在 boost_tier（或更前）的派工列：哪一頁、哪一件。暫停中的頁面不列。2026-10-08';

-- ------------------------------------------------------------
-- 4. traffic_boost_apply：seed 在算完每個缺口的層之後呼叫（讀暫存表 _gaps，把達標頁面名下的缺口層壓到 boost_tier）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION traffic_boost_apply() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE s traffic_boost_settings%ROWTYPE; v_lifted INTEGER := 0; v_default SMALLINT;
BEGIN
  SELECT * INTO s FROM traffic_boost_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.enabled THEN RETURN 0; END IF;
  SELECT t.id INTO v_default FROM task_priority_tiers t WHERE t.is_default;  -- _gaps.priority 還沒算出來（NULL）的，當預設層
  -- 沒有任何流量資料、也沒有狀態列：什麼都不做（上線當下與流量表是空的時候，seed 的輸出與舊版逐件相同）
  IF NOT EXISTS (SELECT 1 FROM page_traffic_hot) AND NOT EXISTS (SELECT 1 FROM page_traffic_boosts) THEN RETURN 0; END IF;

  DROP TABLE IF EXISTS _tb_hot;
  DROP TABLE IF EXISTS _tb_keys;
  DROP TABLE IF EXISTS _tb_pages;
  CREATE TEMP TABLE _tb_hot ON COMMIT DROP AS SELECT h.kind, h.target_id FROM page_traffic_hot h;

  -- 達標頁面的「鍵」：頁面本身的 uuid；人物頁另含他名下政見的 uuid 與他的參選紀錄 id（'pe:<id>'）
  CREATE TEMP TABLE _tb_keys ON COMMIT DROP AS
    SELECT h.kind, h.target_id, h.target_id AS key FROM _tb_hot h
    UNION
    SELECT h.kind, h.target_id, pl.id::TEXT FROM _tb_hot h JOIN policies pl ON pl.politician_id = h.target_id::UUID WHERE h.kind = 'politician'
    UNION
    SELECT h.kind, h.target_id, 'pe:' || pe.id FROM _tb_hot h JOIN politician_elections pe ON pe.politician_id = h.target_id::UUID WHERE h.kind = 'politician';

  -- 每個可提層的缺口（現在的層比 boost_tier 靠後）指到哪些達標頁：target 整份展開成鍵（任何位置的 uuid、參選紀錄 id 陣列與單值），和達標頁的鍵做等值連接
  CREATE TEMP TABLE _tb_pages ON COMMIT DROP AS
    SELECT DISTINCT gk.task_id, k.kind, k.target_id
      FROM (SELECT g.task_id, m[1] AS key
              FROM _gaps g, regexp_matches(g.target::TEXT, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') AS m
             WHERE COALESCE(g.priority, v_default) > s.boost_tier
            UNION
            SELECT g.task_id, 'pe:' || e
              FROM _gaps g,
                   jsonb_array_elements_text(CASE WHEN jsonb_typeof(g.target->'politician_election_ids') = 'array' THEN g.target->'politician_election_ids' ELSE '[]'::JSONB END) AS e
             WHERE COALESCE(g.priority, v_default) > s.boost_tier
            UNION
            SELECT g.task_id, 'pe:' || (g.target->>'politician_election_id')
              FROM _gaps g
             WHERE g.target->>'politician_election_id' IS NOT NULL AND COALESCE(g.priority, v_default) > s.boost_tier) gk
      JOIN _tb_keys k ON k.key = gk.key;

  -- a. 暫停期滿：新的一期（重新計時）
  UPDATE page_traffic_boosts
     SET paused_until = NULL, boosted_since = now(), last_yield_at = NULL, lifted_task_ids = '{}', updated_at = now()
   WHERE paused_until IS NOT NULL AND paused_until <= now();

  -- b. 達標就記下時間
  UPDATE page_traffic_boosts b SET last_hot_at = now(), updated_at = now()
    FROM _tb_hot h WHERE h.kind = b.kind AND h.target_id = b.target_id AND b.last_hot_at IS DISTINCT FROM now();

  -- c. 有可提層缺口的達標頁：開新的一期，或接續現在這一期（暫停中的不動）
  INSERT INTO page_traffic_boosts (kind, target_id, boosted_since, last_hot_at, lifted_task_ids)
  SELECT p.kind, p.target_id, now(), now(), array_agg(DISTINCT p.task_id) FROM _tb_pages p GROUP BY p.kind, p.target_id
  ON CONFLICT (kind, target_id) DO UPDATE
    SET lifted_task_ids = ARRAY(SELECT DISTINCT x FROM unnest(page_traffic_boosts.lifted_task_ids || EXCLUDED.lifted_task_ids) AS x ORDER BY x), updated_at = now()
    WHERE page_traffic_boosts.paused_until IS NULL;

  -- d. 產出：這一期提層過的任務上，最近一次型別不是 no_change／task_suggestion、狀態不是 rejected 的交件（查無與冷卻不算）
  UPDATE page_traffic_boosts b SET last_yield_at = y.at, updated_at = now()
    FROM (SELECT b2.kind, b2.target_id, max(c.created_at) AS at
            FROM page_traffic_boosts b2
            JOIN contributions c ON c.task_id = ANY (b2.lifted_task_ids)
           WHERE b2.paused_until IS NULL AND c.created_at >= b2.boosted_since
             AND c.contribution_type NOT IN ('no_change', 'task_suggestion') AND c.status <> 'rejected'
           GROUP BY b2.kind, b2.target_id) y
   WHERE y.kind = b.kind AND y.target_id = b.target_id AND b.last_yield_at IS DISTINCT FROM y.at;

  -- e. 暫停：現在達標、但從這一期開始（或最近一次有產出）起已經 no_yield_days 天沒有任何產出
  UPDATE page_traffic_boosts b SET paused_until = now() + make_interval(days => s.pause_days), updated_at = now()
   WHERE b.paused_until IS NULL
     AND EXISTS (SELECT 1 FROM _tb_hot h WHERE h.kind = b.kind AND h.target_id = b.target_id)
     AND GREATEST(b.boosted_since, COALESCE(b.last_yield_at, b.boosted_since)) <= now() - make_interval(days => s.no_yield_days);

  -- f. 距上次達標超過 no_yield_days 的狀態列清掉（暫停中的留到期滿）
  DELETE FROM page_traffic_boosts b WHERE b.paused_until IS NULL AND b.last_hot_at < now() - make_interval(days => s.no_yield_days);

  -- g. 提層：沒暫停的達標頁名下的缺口，層壓到 boost_tier（新缺口出生時 opened_by 帶 traffic_boost）
  UPDATE _gaps g SET priority = s.boost_tier, opened_by = COALESCE(g.opened_by, '{}'::JSONB) || '{"traffic_boost": true}'::JSONB
   WHERE g.task_id IN (SELECT p.task_id FROM _tb_pages p JOIN page_traffic_boosts b ON b.kind = p.kind AND b.target_id = p.target_id WHERE b.paused_until IS NULL);
  GET DIAGNOSTICS v_lifted = ROW_COUNT;
  RETURN v_lifted;
END;
$$;
COMMENT ON FUNCTION traffic_boost_apply IS
  '頁面流量提層（seed_auto_task_queue 每 10 分鐘呼叫，讀暫存表 _gaps）：達標頁面（page_traffic_hot）名下、現在的層比 boost_tier 靠後的缺口，層壓到 boost_tier；回傳提了幾件。'
  '狀態在 page_traffic_boosts：no_yield_days 天沒有產出就暫停 pause_days 天。參數全在 traffic_boost_settings。page_traffic 與狀態都是空的就直接回 0。2026-10-08';

-- ------------------------------------------------------------
-- 5. seed_auto_task_queue：照 #453（20261008165000）的現行定義，只機械式加入一個標記起訖的區塊（算完每個缺口的層之後、收回與更新之前）
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

  -- >>> 流量提層：人物頁、政見頁近 window_days 天有真實流量（page_traffic_hot）的，名下缺口的層壓到 boost_tier；page_traffic 與狀態都是空的就什麼都不做（參數與規則見 traffic_boost_settings、traffic_boost_apply）
  PERFORM traffic_boost_apply();
  -- <<< 流量提層

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

NOTIFY pgrst, 'reload schema';
