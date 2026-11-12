-- 派工：選舉年優先（年後兩碼 × 100 天）、關 2022 補政見派工（2026-11-12，維護者群組 #448／#450 裁決）
-- ============================================================
--
-- 公式：queue_at ＝ GREATEST(進隊時間 − priority_seconds, cool_until) − boost_seconds（task_queue_key，一字不動）；
--       這支只讓 priority_seconds 多一項「選舉年優先」：
--           election_year_priority_seconds(選舉 id) ＝ (選舉年 % 100) × 100 天（以秒計）
--           2022 → 2200 天、2024 → 2400 天、2026 → 2600 天、2028 自動 2800 天（不用再改任何東西）
--       越新的選舉天然排前面；同一屆內原本的職位優先（規則秒數，前段 +3 天／後段 −30 天）、驗證票 −14 天、插隊（手動 5 年、網站請求 10 年）照舊疊加。
--       沒有選舉年的件（網站請求、名冊、基本資料、合併…，target 沒有 election_id）一律當 2026（2600 天）——否則 5 年插隊（1826 天）會輸給沒插隊的 2026 件。
--       cool_until 的邏輯不動（GREATEST 仍把冷卻結束時間當下限）。
--
-- 選舉 id → 年份：elections.id 是 SERIAL，但正式庫的三屆例行選舉 id 剛好就是年份（2022／2024／2026），另有 4＝2022-12-18 嘉義市長重行選舉。
--       所以不能把 id 當年份用，一律查 elections.election_date 的年（重行選舉 id 4 → 2022；查無這個 id 或 id 是空的 → 2026）。
--
-- 為什麼疊在 priority_seconds 而不是改排序鍵：priority_seconds 是所有消費者的共同輸入——排序鍵觸發器 task_dispatches_queue_key、
--       refresh_dispatch_blocked 的 cooling 判斷、任務派出時記的 dispatch_base_at（驗證票沿用母任務位置的基準）都直接讀這一欄，
--       寫進這一欄就全部一致，不必改這幾支大函式（也就不跟別的 PR 重貼同一支函式撞）。寫 priority_seconds 的地方只有三處，這支各改一處：
--         1. seed_auto_task_queue()（每 10 分鐘，44 臂總表 contribution_auto_tasks_arms() 的輸出都經過它）：流量提層之後多一行 UPDATE _gaps（標 >>> 選舉年優先）
--         2. contribution_tasks_insert_dispatch()（手動任務——網站請求／提議／指定——第一次進佇列）：規則秒數後面 + 選舉年優先
--         3. 驗證票：沿用母任務的位置（母任務列的 priority_seconds 已含選舉年）；「新增」型交件與沒有基準的票，基準是交件建立時間，
--            verify_ticket_base 在這兩種情況改成「建立時間 − 這份交件選舉年的秒數」（交件 payload.election_id，沒有就 2026）
--       contribution_queue_row（驗證票入列的觸發器）本身不動——它只插一列，位置全由 task_dispatches_queue_key 算。
--       opened_by.priority_seconds（開缺口當下記的）現在含選舉年這一項。
--       整支重貼的兩支函式（seed、contribution_tasks_insert_dispatch）都是從上一版逐字抽出、只差標記的那幾行（守門測試 election-year-priority.test.ts 逐字比對）。
--
-- 日本站（policy_jp）：不跟。日本站沒有「選舉年後兩碼」這回事（選舉 id 是 election_key 字串）；drift 守門把 contribution_tasks_insert_dispatch 的比對改讀這支之前的版本
--       （policy-jp-dispatch-drift.test.ts，登記為「日本站暫不跟」，與 TW_VERIFY_TICKET 同一種處理）；seed 本來就登記讀 20261017010000 之前的版本，不受影響。
--
-- 這支做的事：
--   1. 新函式 election_year_priority_seconds(p_election_id INTEGER) → BIGINT（STABLE：讀 elections）
--   2. seed_auto_task_queue()、contribution_tasks_insert_dispatch()、verify_ticket_base() 各疊加一項
--   3. election_task_config 2022 那列 enabled=false（term_policy_missing 不再派 2022 屆；2024／2026 不動；已派出的照做完）
--   4. 一次性重算現有 task_dispatches 任務列的 priority_seconds（觸發器跟著重算 queue_at），前後各量一次最小 queue_at（見檔尾）
--   不升協議版號、不改 TS。
--
-- 已在佇列裡的驗證票（verify:…）：基準 dispatch_base_at 在入列時已凍結（20261104120000），不會自己吃到選舉年，所以尾段的一次性重算也把它們套上
--   （2026-11-12 協調者要求：佇列裡約 1,010 張 2022 公報政見的驗證票佔住隊頭，只重算任務列等於沒解）：依該票交件的選舉（payload.election_id，沒有就看母任務列的
--   target.election_id，再沒有當 2026）把 election_year_priority_seconds 從基準往前減（排序鍵＝基準 − 14 天 − 插隊 ＋ 步長 × 領走次數；基準的其他部分、−14 天、步長、插隊都保留，只加這項），
--   priority_seconds 同步加上（記錄用），觸發器重算 queue_at。已被領走過（dispatch_count > 0）的票也套：隊頭那批大多是領走過又回隊的，只套未領走的票等於沒解。

-- ------------------------------------------------------------
-- 1. 選舉年優先秒數
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION election_year_priority_seconds(p_election_id INTEGER) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT ((COALESCE((SELECT EXTRACT(YEAR FROM e.election_date)::INTEGER FROM elections e WHERE e.id = p_election_id), 2026) % 100) * 100)::BIGINT * 86400
$$;
COMMENT ON FUNCTION election_year_priority_seconds IS
  '選舉年優先秒數（2026-11-12，維護者 #448／#450）：(選舉年後兩碼 × 100) 天，以秒計——2022＝2200 天、2024＝2400、2026＝2600、2028＝2800。選舉年取 elections.election_date 的年（重行選舉、補選照自己的投票日）；'
  '選舉 id 是空的或查無＝當 2026。疊在 priority_seconds 上（seed、手動任務進隊、驗證票基準），排序鍵的公式不動。';

-- ------------------------------------------------------------
-- 2a. 驗證票基準：新增型與沒有基準的票，建立時間 − 這份交件選舉年的秒數
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_ticket_election_seconds(p_verify_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT election_year_priority_seconds((
    SELECT COALESCE(election_id_or_null(b.payload->>'election_id'),
                    (SELECT election_id_or_null(p.target->>'election_id') FROM task_dispatches p WHERE p.task_id = COALESCE(b.task_id, b.payload->>'task_id')))
      FROM contributions b WHERE b.id = uuid_or_null(substr(p_verify_task_id, 8))))
$$;
COMMENT ON FUNCTION verify_ticket_election_seconds IS '一張驗證票（task_id＝verify:<貢獻 id>）那份交件的選舉年優先秒數：交件 payload.election_id，沒有就看母任務列的 target.election_id；都沒有＝2026。只給 verify_ticket_base 的「沒有母任務位置可沿用」分支用。2026-11-12';

-- 以 20261104120000 的現行定義為底，只差兩處（標 >>> 選舉年優先）：新增型與沒有基準的退路，建立時間再減選舉年秒數
CREATE OR REPLACE FUNCTION verify_ticket_base(p_verify_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN t.contribution_type IS NULL THEN NULL
           WHEN t.is_new THEN COALESCE(t.created_at, now()) - make_interval(secs => verify_ticket_election_seconds(p_verify_task_id))  -- >>> 選舉年優先
           ELSE COALESCE((SELECT p.dispatch_base_at FROM task_dispatches p
                           WHERE p.task_id = t.parent_id AND p.dispatch_base_at IS NOT NULL
                             AND p.last_dispatched_at <= COALESCE(t.created_at, now())),
                         COALESCE(t.created_at, now()) - make_interval(secs => verify_ticket_election_seconds(p_verify_task_id)))  -- >>> 選舉年優先
         END
    FROM (SELECT 1) x LEFT JOIN verify_ticket_parent(p_verify_task_id) t ON true
$$;

-- ------------------------------------------------------------
-- 2b. 手動任務進隊（以 20261011350000 的現行定義為底，只差標記那一行）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_tasks_insert_dispatch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('gap.open_basis', 'task_insert', true);
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at, opened_at, priority_seconds, boost_seconds)
  SELECT m.task_id, now(), queue_slot('task'), 0, m.task_type, m.target, m.what_we_need, m.hint_sources, m.reward, m.region, now(), now(),
         -- >>> 優先秒數：規則的優先秒數；第一次進佇列＝插隊一次（原本 1970／1980），馬上排到任務行列最前面
         COALESCE((SELECT x.seconds FROM activity_priority_seconds(CASE WHEN manual_task_is_visitor(NEW.source, NEW.task_type) THEN 'manual_visitor' ELSE 'manual_open' END, NULL, NULL) x LIMIT 1), 0)
           + election_year_priority_seconds(election_id_or_null(m.target->>'election_id')),  -- 選舉年優先（20261112005000）：沒有選舉 id 的當 2026
         COALESCE(manual_front_seconds(m.task_id), 0)
         -- <<< 優先秒數
    FROM contribution_auto_tasks_manual(manual_task_is_visitor(NEW.source, NEW.task_type), NEW.id) m
  ON CONFLICT (task_id) DO NOTHING;
  PERFORM set_config('gap.open_basis', '', true);
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------
-- 2c. seed（以 20261019040000 的現行定義為底，只差標記 >>> 選舉年優先 那一段）
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
  -- >>> 選舉年優先（20261112005000）：優先秒數再加「選舉年後兩碼 × 100 天」（election_year_priority_seconds）；缺口 target 沒有選舉 id 的（網站請求、名冊、基本資料、合併…）當 2026。
  --     疊在規則秒數與流量提層之後，所以排序鍵、冷卻判斷、驗證票沿用母任務的位置都自動吃到
  UPDATE _gaps g SET priority_seconds = COALESCE(g.priority_seconds, 0) + election_year_priority_seconds(election_id_or_null(g.target->>'election_id'));
  -- <<< 選舉年優先

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

-- ------------------------------------------------------------
-- 3. 2022「補該屆政見」關掉（election_task_config.enabled；term_policy_missing 兩個來源都不派 2022 屆）
--    2024、2026 不動；已派出、已有交件在途的任務照做完（停派只是臂不再輸出，在途的交件與驗證不受影響）
-- ------------------------------------------------------------
UPDATE election_task_config SET enabled = false, updated_at = now(), note = COALESCE(note || '；', '') || '2026-11-12 維護者 #448／#450：2022 屆不再補政見派工（選舉年優先排最後之外，直接關掉）'
 WHERE election_id = 2022 AND enabled;

-- ------------------------------------------------------------
-- 4. 一次性重算現有任務列的 priority_seconds（觸發器 task_dispatches_queue_key 跟著重算 queue_at）
--    先重算任務列（task_id 不是 verify: 開頭的全部是任務列）；驗證票見下，沒有選舉 id 的當 2026。
--    前後各量一次「未插隊、未被擋、有最小 queue_at」的 2026 件與 2022 件（正式庫唯讀實測 2026-11-12，同一個公式）：
--      2026 件（含沒有選舉 id 的）：最小 queue_at 2026-10-14 10:30 → 2019-09-01 10:30，中位數 2026-10-30 20:10 → 2019-09-17 20:10（15,583 件）
--      2022 件：                    最小 queue_at 2026-10-11 03:50 → 2020-10-02 03:50，中位數 2026-11-27 10:20 → 2020-11-18 10:20（1,495 件）
--      2024 件：                    最小 queue_at 2026-10-20 12:20 → 2020-03-25 12:20，中位數 2026-11-05 03:50 → 2020-04-10 03:50（194 件）
--    重算前 2022 件的最小 queue_at（10-11）比 2026 件（10-14）還早＝2022 排在 2026 前面；重算後 2022 的最小（2020-10-02）晚於 2026 的最小（2019-09-01），而且 2022 全體（中位數 2020-11-18）
--    排在 2026 的中位數（2019-09-17）之後。這個結果也由下面的 NOTICE 在套用當下印出（前、後各一次）。
-- ------------------------------------------------------------
--
--    驗證票（verify:，task_id 開頭）同一段一併重算：基準 dispatch_base_at 減選舉年秒數、priority_seconds 加同一項，觸發器照 verify_ticket_key 重算 queue_at。
--    前後各量一次「未插隊的驗證票」按選舉年的最小／中位 queue_at（正式庫唯讀實測 2026-11-12）：
--      2022：1,010 張，最小 2026-10-28 21:10 → 2020-10-19 21:10，中位數 2026-11-04 18:23 → 2020-10-26 18:23
--      2024：  122 張，最小 2026-10-28 22:18 → 2020-04-02 22:18，中位數 2026-11-04 18:10 → 2020-04-09 18:10
--      2026：   31 張（含無選舉 id），中位數 2026-11-04 12:14 → 2019-09-22 12:14
--    （目前佇列共 1,194 張驗證票：未領走 279、領走過 915，全部套用；重算後 2022 票的中位數晚於 2026 票。）
--    冪等：重算只做一次，做完在 queue_settings.election_year_priority_applied_at 記時間，有值就整段跳過（migration 重跑不會疊加）。
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS election_year_priority_applied_at TIMESTAMPTZ;
COMMENT ON COLUMN queue_settings.election_year_priority_applied_at IS '選舉年優先的一次性重算（20261112005000）做完的時間；有值＝已套用，重跑 migration 不再疊加。2026-11-12';

DO $$
DECLARE r RECORD; v_n INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM queue_settings WHERE id = 1 AND election_year_priority_applied_at IS NOT NULL) THEN
    RAISE NOTICE '選舉年優先的一次性重算已套用過，略過';
    RETURN;
  END IF;
  FOR r IN SELECT (verify_ticket_election_seconds(d.task_id) / 86400)::INTEGER AS days, count(*) AS n, min(d.queue_at) AS min_q,
                  percentile_disc(0.5) WITHIN GROUP (ORDER BY d.queue_at) AS med_q
             FROM task_dispatches d WHERE d.task_id LIKE 'verify:%' AND d.boost_seconds = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '重算前 驗證票 選舉年優先 % 天：% 張，最小 queue_at %，中位 %', r.days, r.n, r.min_q, r.med_q;
  END LOOP;

  FOR r IN SELECT y.yr, count(*) AS n, min(d.queue_at) AS min_q
             FROM task_dispatches d
             CROSS JOIN LATERAL (SELECT COALESCE((SELECT EXTRACT(YEAR FROM e.election_date)::INTEGER FROM elections e WHERE e.id = election_id_or_null(d.target->>'election_id')), 2026) AS yr) y
            WHERE d.task_id NOT LIKE 'verify:%' AND d.boost_seconds = 0 AND NOT d.blocked
            GROUP BY y.yr ORDER BY y.yr LOOP
    RAISE NOTICE '重算前 選舉年 %：% 件，最小 queue_at %', r.yr, r.n, r.min_q;
  END LOOP;

  UPDATE task_dispatches d
     SET priority_seconds = d.priority_seconds + election_year_priority_seconds(election_id_or_null(d.target->>'election_id'))
   WHERE d.task_id NOT LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 列任務列的 priority_seconds', v_n;

  FOR r IN SELECT y.yr, count(*) AS n, min(d.queue_at) AS min_q
             FROM task_dispatches d
             CROSS JOIN LATERAL (SELECT COALESCE((SELECT EXTRACT(YEAR FROM e.election_date)::INTEGER FROM elections e WHERE e.id = election_id_or_null(d.target->>'election_id')), 2026) AS yr) y
            WHERE d.task_id NOT LIKE 'verify:%' AND d.boost_seconds = 0 AND NOT d.blocked
            GROUP BY y.yr ORDER BY y.yr LOOP
    RAISE NOTICE '重算後 選舉年 %：% 件，最小 queue_at %', r.yr, r.n, r.min_q;
  END LOOP;

  -- 現有驗證票：基準往前減選舉年秒數（沒有基準的舊列先用現在的 queue_at 反推，同觸發器的退路），priority_seconds 同步加
  UPDATE task_dispatches v
     SET dispatch_base_at = COALESCE(v.dispatch_base_at, verify_ticket_freeze_base(v.queue_at, v.dispatch_count, v.boost_seconds, verify_ticket_step_seconds(v.task_id)))
                            - make_interval(secs => verify_ticket_election_seconds(v.task_id))
   WHERE v.task_id LIKE 'verify:%';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '重算 % 張驗證票的基準', v_n;

  FOR r IN SELECT (verify_ticket_election_seconds(d.task_id) / 86400)::INTEGER AS days, count(*) AS n, min(d.queue_at) AS min_q,
                  percentile_disc(0.5) WITHIN GROUP (ORDER BY d.queue_at) AS med_q
             FROM task_dispatches d WHERE d.task_id LIKE 'verify:%' AND d.boost_seconds = 0 GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '重算後 驗證票 選舉年優先 % 天：% 張，最小 queue_at %，中位 %', r.days, r.n, r.min_q, r.med_q;
  END LOOP;

  -- 自我檢查：任務列的 queue_at 仍是排序鍵（觸發器已重算）
  IF EXISTS (SELECT 1 FROM task_dispatches WHERE task_id NOT LIKE 'verify:%'
                AND queue_at IS DISTINCT FROM task_queue_key(last_dispatched_at, priority_seconds, cool_until, boost_seconds)) THEN
    RAISE EXCEPTION '有任務列的 queue_at 不是排序鍵';
  END IF;

  UPDATE queue_settings SET election_year_priority_applied_at = now() WHERE id = 1;
END;
$$;

NOTIFY pgrst, 'reload schema';
