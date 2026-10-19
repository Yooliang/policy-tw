-- 帶清單指紋的派工臂換號時沿用排隊位置＋慢性停擺檢查（2026-10-19，#670 政策脈絡檢討第 8、9 點）
-- ============================================================
--
-- 根因（正式庫唯讀實測 2026-10-19）：
--   帶「清單指紋」的派工臂，task_id 末段是那一格內容的指紋——lineage_candidate（auto:lineage_candidate:<格鍵 12>:<指紋 8>，一格＝層級×縣市×鄉鎮×類別）、
--   lineage_link_candidate（auto:lineage_link_candidate:<下級脈絡 id>:<指紋 8>）、duplicate_policy（auto:duplicate_policy:<人物 id>:<指紋 8>，一個人的政見清單）。
--   格子裡任何一條政見新增、改標題、參選紀錄異動，指紋就變 → seed 把舊列收回、新列以新 task_id 出生；進隊時間（last_dispatched_at）＝出生當下，
--   queue_at＝進隊時間 − 優先秒數 → 排回隊尾。目前佇列延遲約 14 天（隊頭非插隊列的 queue_at 距現在 13.9 天），這幾臂的列壽命中位數 12～21 小時，所以幾乎永遠輪不到：
--   lineage_candidate 279 列有 277 列 dispatch_count=0、duplicate_policy 698 列有 680 列從未派出，10-12 起交件各 0／8；
--   gap_events 自 10-07 收回 1,925 列；10-12 之後這三臂因 seed 收回的 1,458 列（不含 drop_applied），有 1,450 列在「同一個 seed 交易裡」由同一個穩定鍵的新指紋接手（新列 opened 與舊列 closed 同一個時間戳）。
--   換號本身是對的（內容變了，要請代理看新的清單）；錯的是「換號就把排隊位置重算」。
--
-- 這支做三件事：
--   1. 換號沿用排隊位置。seed_auto_task_queue() 在收回舊列之前，先記下「穩定鍵」（task_id 去掉末段指紋＝auto:<臂>:<格鍵／人物／脈絡>）相同、這一輪就要被取代的舊列的排隊位置
--      （進隊時間 last_dispatched_at、派出次數 dispatch_count、插隊秒數 boost_seconds），新列出生時沿用。queue_at 不直接寫死——它仍由觸發器 task_dispatches_queue_key 照進隊時間算，
--      所以優先秒數換了、冷卻、插隊的規則全部照舊。
--      * 前一列被派出過：派出時 last_dispatched_at 就是派出時間（回隊尾），沿用它＝新列也在「那一次派出之後」的位置，不會反覆插到最前面；派出時插隊秒數早已歸零，所以插隊也不會被繼承（沒被派出過就被插隊的，插隊跟著走）。
--      * 不同格子、沒有指紋的臂、舊列不是這一輪被取代的（早就收回、或另一個交易）：照舊，出生當下進隊。
--      * 這一輪「已完成而收回」的不算：貢獻 applied 由 task_dispatches_drop_applied 當場刪列，不在 seed 的取代範圍。
--      * gap_events 照舊：舊列記 closed、新列記 opened，新列的 opened_by 多 rekey_of（舊 task_id）與 chain_opened_at（整串換號的第一次出生時間，慢性停擺檢查用）。
--      * 在途交件比對（臂內用完整 task_id 含指紋比對 pending 交件）一個字不動。
--      * queue_settings.rekey_keep_position（預設 true）是開關：false＝回到舊行為（一行 migration 的 UPDATE，進 edit_history）。
--   2. 慢性停擺檢查。activity_health 多一項 dispatch_chronic_stall（主控台看得到，不擋派工）：某一類自動缺口近 stall_window_days 天因「缺口內容變了」被換掉的列夠多（stall_min_closed）、
--      列的壽命（整串換號合計）中位數短於目前的佇列延遲（隊頭非插隊列的 queue_at 距現在）、而且這段期間交件數 ≤ stall_max_contributions（0）→ 一列。
--      「窗口關了」（reason window）與「做完了」（drop_applied）不算被換掉。參數全在 queue_settings（stall_*），改值一行 migration 的 UPDATE、進 edit_history。
--   3. 守門測試 rekey-keeps-queue-position.test.ts（PGlite 實跑：同格換指紋 queue_at 不晚於舊列、派出過的不插隊、不同格不互相繼承、沒有指紋的臂不變、慢性停擺列得出來；還原驗證拿掉繼承會紅）。
--
-- 這支不碰：lineage_candidate_scope() 與脈絡的收件規則（#670 PR 2 在改）、三支臂本體、task_dispatches_queue_key 觸發器、日本站（20261019040100 另外跟）。
-- 不升協議版號（代理端行為不變）。簽名與回傳型別一字不動（CREATE OR REPLACE），seed 與觸發器本來就在 DB 裡，可以單獨先上。

-- ------------------------------------------------------------
-- 1. 設定（單列表 queue_settings 加欄）
-- ------------------------------------------------------------
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS rekey_keep_position BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS stall_window_days INTEGER NOT NULL DEFAULT 7 CHECK (stall_window_days BETWEEN 1 AND 90);
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS stall_min_closed INTEGER NOT NULL DEFAULT 10 CHECK (stall_min_closed >= 1);
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS stall_max_contributions INTEGER NOT NULL DEFAULT 0 CHECK (stall_max_contributions >= 0);
COMMENT ON COLUMN queue_settings.rekey_keep_position IS '帶清單指紋的臂換號（task_id 末段指紋變了）時，新列沿用同一個穩定鍵舊列的排隊位置（進隊時間、派出次數、插隊秒數）；false＝新列出生當下進隊（舊行為）。2026-10-19';
COMMENT ON COLUMN queue_settings.stall_window_days IS '慢性停擺檢查（activity_health 的 dispatch_chronic_stall）的觀察天數：看這麼久之內被換掉的列與交件。2026-10-19';
COMMENT ON COLUMN queue_settings.stall_min_closed IS '慢性停擺檢查：這段期間至少有這麼多列因缺口內容變了被換掉才判斷（太少的類型壽命中位數沒有意義）。2026-10-19';
COMMENT ON COLUMN queue_settings.stall_max_contributions IS '慢性停擺檢查：這段期間交件數不超過這個值才算停擺（0＝一件都沒有）。2026-10-19';

-- ------------------------------------------------------------
-- 2. 穩定鍵
-- ------------------------------------------------------------
-- 帶清單指紋的臂（task_id 末段是那一格內容的指紋）：新增這類臂時加在這裡，守門測試 rekey-keeps-queue-position.test.ts 會掃 migration 裡「task_id 末段是 .fp」的臂，漏了會紅
CREATE OR REPLACE FUNCTION task_rekey_arms() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY['lineage_candidate', 'lineage_link_candidate', 'duplicate_policy']::TEXT[] $$;
COMMENT ON FUNCTION task_rekey_arms IS '帶清單指紋的派工臂（task_id＝auto:<臂>:<鍵>:<指紋>）：換號時新列沿用舊列的排隊位置（task_rekey_stable_key）。清單只有這一處。2026-10-19';

-- 穩定鍵：task_id 去掉末段指紋（auto:<臂>:<鍵>）；不是帶指紋的臂、或末段不像指紋（8～32 碼小寫十六進位）＝NULL
CREATE OR REPLACE FUNCTION task_rekey_stable_key(p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_task_id ~ '^auto:[a-z_]+:[^:]+:[0-9a-f]{8,32}$' AND split_part(p_task_id, ':', 2) = ANY (task_rekey_arms())
              THEN regexp_replace(p_task_id, ':[0-9a-f]{8,32}$', '') END
$$;
COMMENT ON FUNCTION task_rekey_stable_key IS '帶清單指紋的臂的穩定鍵＝task_id 去掉末段指紋（auto:<臂>:<格鍵／人物／脈絡>）；同一格換指紋前後的 task_id 穩定鍵相同。其餘一律 NULL。2026-10-19';

-- ------------------------------------------------------------
-- 3. seed：以 20261017010000 的現行定義為底，只做 rekey-position-edits.ts 登記的機械式替換（標「換號沿用排隊位置」）
--    底與正式庫一字不差：2026-10-19 唯讀比對 pg_proc.prosrc 的 sha256，seed_auto_task_queue（6,044 字，822948b1…）、
--    task_dispatches_queue_key（916 字）、task_queue_key（164 字）都與 migration 現行定義相同。
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
COMMENT ON FUNCTION seed_auto_task_queue IS '排程每 10 分鐘：重算全站缺口，新缺口發號碼牌、內容寫進 task_dispatches（內容沒變的列不重寫）、補上的收回；算每個缺口的優先秒數（與相符的規則 id）；補驗證列、清掉已定案的；不重排（queue_at＝排序鍵，觸發器算）；最後讓還跟著母任務的驗證票換位置（refresh_verify_ticket_keys）。帶清單指紋的臂換號時（穩定鍵相同、舊列這一輪被取代），新列沿用舊列的進隊時間、派出次數、插隊秒數（_rekey_prev，queue_settings.rekey_keep_position 可關）。2026-10-19';

-- ------------------------------------------------------------
-- 4. 慢性停擺檢查
-- ------------------------------------------------------------
-- 目前的佇列延遲（秒）：可派的隊頭（合格條件都過了之後、非插隊的第一筆）的排序鍵距現在多久。
-- 要看「合格之後」所以走 contribution_queue_tasks（跟 /next、queue_head_stale 同一個定義）；前 100 筆夠跳過 10 筆左右的插隊列與公民提問的前段
CREATE OR REPLACE FUNCTION dispatch_queue_delay_seconds() RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT extract(epoch FROM now() - min(h.queue_at))
    FROM contribution_queue_tasks(NULL, NULL, 100, '', NULL, NULL) h
    JOIN task_dispatches d ON d.task_id = h.task_id
   WHERE d.boost_seconds = 0
$$;
COMMENT ON FUNCTION dispatch_queue_delay_seconds IS '目前的佇列延遲（秒）：可派的隊頭（contribution_queue_tasks 前 100 筆裡、非插隊的第一筆）的 queue_at 距現在；佇列是空的＝NULL。慢性停擺檢查用。2026-10-19';

-- 一類自動缺口（task_id 第二段）近 stall_window_days 天：被換掉的列（gap_events closed、reason＝filled、不是 drop_applied 做完收回的；窗口關了的不算）
-- 壽命＝收回時間 − 整串換號的第一次出生時間（opened_by.chain_opened_at，沒有就是這一列自己的出生時間）；中位數短於佇列延遲，而且這段期間交件 ≤ stall_max_contributions → 一列。
-- 交件算法：contributions.task_id（空的看 payload.task_id）屬於這一類的，所有狀態都算。
CREATE OR REPLACE FUNCTION dispatch_chronic_stall()
RETURNS TABLE (arm TEXT, closed_rows INTEGER, median_life_hours NUMERIC, queue_delay_hours NUMERIC, contributions INTEGER, window_days INTEGER)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT q.stall_window_days AS w, q.stall_min_closed AS m, q.stall_max_contributions AS mx FROM queue_settings q WHERE q.id = 1
  ), dly AS (
    SELECT dispatch_queue_delay_seconds() AS secs
  ), life AS (
    SELECT split_part(e.task_id, ':', 2) AS arm,
           extract(epoch FROM e.at - COALESCE((e.detail->'opened_by'->>'chain_opened_at')::TIMESTAMPTZ, (e.detail->>'opened_at')::TIMESTAMPTZ)) AS secs
      FROM gap_events e CROSS JOIN s
     WHERE e.event = 'closed' AND e.reason = 'filled' AND e.at > now() - make_interval(days => s.w)
       AND e.task_id LIKE 'auto:%' AND COALESCE(e.detail->>'via', '') <> 'drop_applied'
  ), agg AS (
    SELECT l.arm, count(*)::INTEGER AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY l.secs) AS med FROM life l GROUP BY l.arm
  ), contrib AS (
    SELECT split_part(COALESCE(c.task_id, c.payload->>'task_id'), ':', 2) AS arm, count(*)::INTEGER AS n
      FROM contributions c CROSS JOIN s
     WHERE c.created_at > now() - make_interval(days => s.w) AND COALESCE(c.task_id, c.payload->>'task_id') LIKE 'auto:%'
     GROUP BY 1
  )
  SELECT a.arm, a.n, round((a.med / 3600)::NUMERIC, 1), round((d.secs / 3600)::NUMERIC, 1), COALESCE(c.n, 0), s.w
    FROM agg a CROSS JOIN s CROSS JOIN dly d LEFT JOIN contrib c ON c.arm = a.arm
   WHERE a.n >= s.m AND a.med < d.secs AND COALESCE(c.n, 0) <= s.mx
$$;
COMMENT ON FUNCTION dispatch_chronic_stall IS '慢性停擺：某一類自動缺口（task_id 第二段）近 stall_window_days 天因缺口內容變了被換掉的列 ≥ stall_min_closed、壽命（整串換號合計）中位數短於目前的佇列延遲、交件 ≤ stall_max_contributions → 一列；正常沒有列。activity_health 的 dispatch_chronic_stall（2026-10-19，#670 第 9 點）';

-- ------------------------------------------------------------
-- 5. activity_health：以 20261017000301 的現行定義為底，多一個 UNION 分支（dispatch_chronic_stall）
-- ------------------------------------------------------------
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
         'roster_check_scope 的五個日期欄（登記截止、名單公告、資格審查、抽號次、直轄市長名單公告）與 election_milestones 對不上：它們該由里程碑衍生（觸發器 roster_scope_derive_dates），對不上表示觸發器被停掉或繞過了'
    FROM roster_check_scope s
   WHERE s.registration_closed_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'registration_close', s.election_type)
      OR s.list_announced_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', s.election_type)
      OR s.qualification_review_by IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'qualification_review', s.election_type)
      OR s.ballot_draw_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'draw', s.election_type)
      OR s.municipal_mayor_list_on IS DISTINCT FROM roster_scope_milestone_date(s.election_id, 'list_published', '直轄市長', false)
  UNION ALL
  SELECT 'arm_without_rule', a.arm, '派工臂「' || a.arm || '」沒有任何規則：contribution_auto_tasks_arms() 對它的每一列都會因為沒有開窗的規則而被濾掉（整支臂無聲消失）'
    FROM unnest(activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = a.arm)
  UNION ALL
  SELECT 'bulletin_milestone_missing', e.id::TEXT,
         '選舉有公報資料夾（bulletin_dir）、還沒投票，卻沒有整場的 bulletin_published 里程碑：bulletin-watch 不會偵測它（bulletin_watch_targets 只看有里程碑列的選舉），「公報之前」的降級規則也開不起來。新增選舉時要在 election_milestones 補那一列（預估用 expected／statutory；公報已上架就補 done／official）'
    FROM elections e
   WHERE e.bulletin_dir IS NOT NULL
     AND e.election_date >= activity_today()
     AND NOT EXISTS (SELECT 1 FROM election_milestones m WHERE m.election_id = e.id AND m.kind = 'bulletin_published' AND m.election_type IS NULL)
  UNION ALL
  SELECT 'ballot_number_anomaly', a.election_id || ' / ' || a.election_type,
         count(*) || ' 個號次單位的號次有重複或跳號（重複 ' || count(*) FILTER (WHERE a.kind = 'duplicate') || '、跳號 ' || count(*) FILTER (WHERE a.kind = 'gap') || '）：看視圖 ballot_number_anomalies；名單缺人時也會這樣，派工臂 cand_no_recheck 會請代理對公告重查'
    FROM ballot_number_anomalies a JOIN elections e ON e.id = a.election_id
   WHERE e.election_date >= activity_today()
   GROUP BY a.election_id, a.election_type
  UNION ALL
  SELECT 'clock_overridden', current_setting('app.activity_today', true), '時鐘被 app.activity_today 覆寫了：所有時間窗都在用這個假日期（只該出現在測試）'
   WHERE NULLIF(current_setting('app.activity_today', true), '') IS NOT NULL
  UNION ALL
  SELECT 'queue_clock_overridden', current_setting('app.queue_now', true), '派工時鐘被 app.queue_now 覆寫了：所有固定時段插隊都在用這個假時間（只該出現在測試）'
   WHERE NULLIF(current_setting('app.queue_now', true), '') IS NOT NULL
  UNION ALL
  SELECT 'system_vote_stalled', 'jev_decisions',
         '最近一筆來源核對系統票是 ' || COALESCE(to_char(s.last_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') || '（台北）', '（沒有）')
           || '，之後有 ' || s.waiting || ' 筆等待中的合格貢獻沒有被判：system-one precheck 可能在失敗（看 net._http_response 的 status_code 與 failures）'
    FROM system_vote_stall() s
  UNION ALL
  SELECT 'queue_head_stale', s.head_task_id,
         '派工佇列隊頭停擺：可派的隊頭是 ' || s.head_task_id || '（' || s.head_task_type || '），但最近一次任務派出是 '
           || COALESCE(to_char(s.last_dispatch_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') || '（台北）', '（從來沒有）')
           || '，已超過 ' || queue_head_stale_hours() || ' 小時：看 /next 的 log 有沒有「過濾後沒有任務」，或隊頭是不是又被某個條件釘死（10-17 事故）'
    FROM queue_head_stale() s
  UNION ALL
  SELECT 'dispatch_chronic_stall', s.arm,
         '派工類型「' || s.arm || '」近 ' || s.window_days || ' 天有 ' || s.closed_rows || ' 列因缺口內容變了被換掉，列的壽命（整串換號合計）中位數只有 ' || s.median_life_hours
           || ' 小時，短於目前的佇列延遲 ' || s.queue_delay_hours || ' 小時，而且這段期間沒有任何交件：還沒輪到就被換掉，幾乎永遠派不出去。看 gap_events 的 closed 事件與派工列 opened_by 的 rekey_of'
    FROM dispatch_chronic_stall() s;
COMMENT ON VIEW activity_health IS
  '派工時間窗的健康檢查，正常是空的：選舉缺投票日、活動的規則全停用、覆寫指到沒有規則的活動、窗口起迄顛倒、roster_check_scope 的五個日期與里程碑對不上、派工臂沒有任何規則（arm_without_rule，P1）、'
  '有公報資料夾又還沒投票的選舉缺整場的 bulletin_published 里程碑（bulletin_milestone_missing，2026-10-08 公報偵測）、號次單位有重複或跳號（ballot_number_anomaly，還沒投票的選舉，補號次 20261008150000）、時鐘被覆寫。2026-10-08（PLAN-task-activation 3 風險第 2 點）'
  '｜20261008165000：加 queue_clock_overridden——app.queue_now 假時鐘被設了（固定時段插隊用的時鐘，只該出現在測試）。'
  '｜2026-10-10：加 system_vote_stalled——來源核對系統票超過 3 小時沒有新的、之後又有等待中的合格貢獻（10-09 寫入失敗無聲停擺 16 小時的教訓）。'
  '｜2026-10-17：加 queue_head_stale——有可派的隊頭卻 6 小時沒有任何任務派出（隊頭堵塞的教訓，queue_head_stale()）。'
  '｜2026-10-19：加 dispatch_chronic_stall——某一類自動缺口近 N 天被換掉的列夠多、壽命中位數短於佇列延遲、又沒有任何交件（#670 第 9 點；參數在 queue_settings 的 stall_*）。';

NOTIFY pgrst, 'reload schema';
