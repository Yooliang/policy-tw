-- 每 10 分鐘的 seed_auto_task_queue 不整列重寫內容沒變的派工列（#465，2026-10-09）
-- ============================================================
--
-- 起因：#458 量測，一輪 seed 約 7 秒，其中約 2 秒花在「UPDATE task_dispatches … FROM _gaps」把約 7,900 列整列重寫，加上 rebalance_queue 的三段 UPDATE queue_at。
-- task_dispatches 累計 2,000 多萬次更新，只有約 15% 是 HOT 更新（UPDATE 一列＝寫一個新版本的 heap tuple、queue_at 有索引時還要動索引）。
-- 唯讀實測（2026-10-09，正式庫）：existing 8,183 列裡內容真的變了的是 0 列（六個內容欄逐欄 IS DISTINCT FROM，task_type／target／what_we_need／hint_sources／reward／region 都是 0）。
-- 另外 task_dispatches 上沒有 UPDATE 觸發器（只有 INSERT 前後、DELETE 後三個，都只管 auto: 列的 opened／closed 事件），所以「每列觸發觸發器」不成立，這支不影響 gap_events。
--
-- 做法（照現行定義＋機械式替換，不動別的）：
--   1. seed_auto_task_queue()：現行版＝20261008190000_page_traffic_boost.sql。「既有的只更新內容」那一句 UPDATE 加一個條件——六個內容欄（task_type、target、what_we_need、hint_sources、reward、region）
--      以列比較 IS DISTINCT FROM（NULL 安全）只要任一欄不同才更新；全部相同的列這一輪不碰。其他一個字都沒動（優先層那句 UPDATE 本來就有 IS DISTINCT FROM）。
--   2. rebalance_queue()：現行版＝20261008165000_manual_tasks_as_arm.sql。三段 UPDATE queue_at 各加「d.queue_at IS DISTINCT FROM 新值」。
--      回傳值 v_n 原本是「寫了幾列」，現在是「真的改了位置的列數」（沒有呼叫者讀它：seed 用 PERFORM、pg_cron 與 TS 都沒有讀）。
--
-- refreshed_at 的處理（先 grep 清楚才改的）：
--   * 沒有任何程式讀 task_dispatches.refreshed_at：repo 內 TS／Vue／Edge Function 零處；正式庫 pg_proc 裡提到 refreshed_at 的三支函式只有 seed（寫）、contribution_tasks_insert_dispatch（INSERT 時寫）
--     與 platform_cost_summary（讀的是 platform_costs.refreshed_at，另一張表）；pg_views 沒有；5,127 列是 NULL（非 auto 列從來沒寫過）。
--   * 所以保留「在更新內容的同一句裡寫 now()」：refreshed_at 的語意由「最近一輪 seed 掃過這列」變成「這列的內容最後一次被改寫的時間」，這才是欄位名與當初（20260924000001）的本意。
--     沒有拿它當新鮮度的程式，不需要另開欄位；以前它每輪全部列都是同一個值，等於沒有資訊。
--   * 新缺口 INSERT 時仍寫 now()（不動）。
--
-- 不做：
--   * 不改 queue_at 的算法。實測（見 PR）rebalance 的位置是「起點＋名次」的絕對值，只要有一筆被領走或新增／收回，後面的名次全部位移一格，所以活躍時段幾乎所有列的 queue_at 每輪都會變，
--     這一半的守衛主要在沒有任何領取、缺口也沒變動的時段（夜間）才省得到寫入。要在活躍時段也省下，得改成相對順序（例如間隔式的 queue_at），那會改變 queue_at 的數值，不在 parity 範圍內。
--   * 不改 fillfactor、不動索引、不動觸發器。
--
-- 只換兩支函式，沒有 schema 變動；同一個交易，沒有資料遷移。

-- ------------------------------------------------------------
-- 1. rebalance_queue：照 #453（20261008165000）的現行定義，三段 UPDATE 各加一個位置有變才更新的條件
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION rebalance_queue() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_start TIMESTAMPTZ; v_ready INTEGER; v_n INTEGER := 0; v_c INTEGER;
BEGIN
  -- 起點＝兩條行列目前最前面那一筆的時間，不是 now()：重排只改內部交錯，不能讓整條往後退。
  -- 用 now() 的話，人建任務（contribution_tasks，照上次派出時間排、不參與重排）永遠比重排後的驗證早，
  -- 12 筆人建任務會一直輪流排在所有驗證前面（09-24 00:xx a-zhen 50 分鐘沒拿到一筆驗證）。
  SELECT COALESCE(LEAST(MIN(queue_at), now()), now()) INTO v_start FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  DROP TABLE IF EXISTS _ready;
  CREATE TEMP TABLE _ready ON COMMIT DROP AS
    SELECT g.task_id FROM contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';
  SELECT COUNT(*) INTO v_ready FROM _ready;

  WITH v AS (
    SELECT task_id, row_number() OVER (ORDER BY queue_at, task_id) - 1 AS rn FROM task_dispatches
     WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01'
  )
  UPDATE task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '1 second' FROM v WHERE d.task_id = v.task_id
     AND d.queue_at IS DISTINCT FROM v_start + v.rn * INTERVAL '1 second'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  -- >>> 優先層：可派的任務依層加權交錯（第 k 筆的虛擬完成時間＝k／權重，同時間層號小的先；同一層內照 queue_at、task_id 先進先出）
  WITH w AS (
    SELECT d.task_id, d.queue_at, COALESCE(d.priority, (SELECT x.id FROM task_priority_tiers x WHERE x.is_default)) AS tier
      FROM task_dispatches d JOIN _ready r ON r.task_id = d.task_id
  ), k AS (
    SELECT w.task_id, w.queue_at, w.tier, row_number() OVER (PARTITION BY w.tier ORDER BY w.queue_at, w.task_id) AS k FROM w
  ), t AS (
    SELECT k.task_id, row_number() OVER (ORDER BY k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at, k.task_id) - 1 AS rn
      FROM k LEFT JOIN task_priority_tiers tw ON tw.id = k.tier
  )
  -- <<< 優先層
  UPDATE task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds' FROM t WHERE d.task_id = t.task_id
     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  WITH t2 AS (
    SELECT d.task_id, row_number() OVER (ORDER BY d.queue_at, d.task_id) - 1 AS rn
      FROM task_dispatches d
     WHERE d.task_id NOT LIKE 'verify:%' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
       AND NOT EXISTS (SELECT 1 FROM _ready r WHERE r.task_id = d.task_id)
  )
  UPDATE task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds' FROM t2 WHERE d.task_id = t2.task_id
     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  RETURN v_n;
END;
$$;

-- ------------------------------------------------------------
-- 2. seed_auto_task_queue：照 20261008190000 的現行定義，只在內容 UPDATE 加一個內容有變才更新的條件
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

COMMENT ON FUNCTION seed_auto_task_queue IS '排程每 10 分鐘：重算全站缺口，新缺口發號碼牌、內容寫進 task_dispatches（內容沒變的列不重寫，refreshed_at＝內容最後一次被改寫的時間）、補上的收回；補驗證列、清掉已定案的';
COMMENT ON FUNCTION rebalance_queue IS
  '把佇列重排成 驗證：派得出去的任務＝2:1（seed_auto_task_queue 每 10 分鐘呼叫）；插隊的不動。可派的任務依優先層（task_dispatches.priority，NULL＝預設層）用各層的權重（優先層表的 weight）加權交錯，'
  '同一層內先進先出；任務位置的間距仍是每筆 2 秒，所以 2:1 不變。位置沒變的列不重寫，回傳值＝真的改了位置的列數。2026-10-09（#465）';

NOTIFY pgrst, 'reload schema';
