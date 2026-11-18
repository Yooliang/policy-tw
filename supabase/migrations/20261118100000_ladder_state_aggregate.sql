-- 派工排程效能（#981）：查核階梯狀態改成「對 task_checks 一次集合運算」，不再逐張工作卡呼叫 work_key_ladder_state。2026-11-18
--
-- 現象：pg_cron seed-auto-task-queue-10min（seed_auto_task_queue()，語句逾時 120 秒）11-18 下午 70～120 秒、多數逾時，
--   17:40 一輪跑到 77 秒時資料庫 server restarted。
-- 原因：refresh_dispatch_blocked 的 cool 區塊對 30 天內有查核的約 1.3 萬張工作卡逐卡呼叫 work_key_ladder_state（每卡掃一次 task_checks，
--   列內再呼叫 task_check_cooldown_days_for／task_check_ladder_exempt），b 區塊引用的視圖 task_ladder_closed 對全部約 1.45 萬張卡再逐卡呼叫一次，
--   roster_group_person_status() 又引用該視圖。task_checks 一天長 3 千多筆，成本隨表線性上升。
-- 做法：
--   1. 新增 work_key_ladder_states()：回傳每張有查核的卡的階梯狀態，欄位與 work_key_ladder_state 完全相同（外加 work_key），
--      語意逐欄一致——「第幾次」與「冷卻天數」用視窗函數按卡累計（同 work_key、(checked_at, id) 排序），不再逐筆子查詢。
--   2. task_ladder_closed 視圖改讀它（欄位、語意不變）。
--   3. refresh_dispatch_blocked：開頭把它物化成 ls 一次，b（結案的 auto: 任務）與 cool（冷卻結束時間）都讀 ls；另外把 x 區塊「逐列 EXISTS (SELECT 1 FROM b …)」
--      （每列重跑一次 b，約 2.9 萬列×1.6 毫秒＝47 秒）改成 LEFT JOIN b。其餘一字不差。
-- 沒改：work_key_ladder_state(text)、task_check_cooldown_days_for、task_in_check_cooldown（單卡呼叫者：/next、插隊拉回、出生觸發器照舊）、
--   任何規則與資料列。不碰 #977 規則 D（已回滾，另案）。
-- 回滾：把 task_ladder_closed 與 refresh_dispatch_blocked 用 20261111100000_work_key.sql 的定義 CREATE OR REPLACE 還原；
--   work_key_ladder_states() 沒人引用後可 DROP。

CREATE OR REPLACE FUNCTION work_key_ladder_states()
RETURNS TABLE (work_key TEXT, checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH cfg AS (
    -- 常數只讀一次（單卡版每一筆都重新呼叫）；LEFT JOIN 讓設定列不存在時行為同 task_check_cooldown_days_for
    SELECT s.enabled AS rep_on, s.task_types, s.not_found_repeat_days AS rep_days,
           task_unreachable_cooldown_days() AS unreach_days, task_not_found_cooldown_days() AS nf_days,
           task_check_cooldown_days() AS default_days, make_interval(days => task_cooldown_max_days()) AS max_window
      FROM (SELECT 1) AS one LEFT JOIN task_cooldown_settings s ON s.id = 1
  ), t AS MATERIALIZED (
    SELECT tc.id, tc.work_key, tc.task_id, tc.outcome, tc.checked_at,
           (tc.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(tc.task_id)) AS laddered,
           -- 同卡累計到這一筆為止（含這一筆；(checked_at, id) 全序）：not_found＋confirmed 合計（含例外任務，同 task_check_cooldown_days_for）、only not_found
           count(*) FILTER (WHERE tc.outcome IN ('not_found', 'confirmed')) OVER w AS cnt_nc,
           count(*) FILTER (WHERE tc.outcome = 'not_found') OVER w AS cnt_nf
      FROM task_checks tc
     WHERE tc.work_key IS NOT NULL
    WINDOW w AS (PARTITION BY tc.work_key ORDER BY tc.checked_at, tc.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  ), n AS MATERIALIZED (
    SELECT t.*,
           -- 階梯次序：只數套階梯的那幾筆（例外任務不算），同 work_key_ladder_state
           CASE WHEN t.laddered THEN row_number() OVER (PARTITION BY t.work_key, t.laddered ORDER BY t.checked_at, t.id) END AS n
      FROM t
  ), d AS MATERIALIZED (
    SELECT n.*,
           -- 這一筆的冷卻天數：task_check_cooldown_days_for 的同一個 CASE，計數改取上面的視窗值
           (CASE WHEN n.outcome = 'unreachable' THEN cfg.unreach_days
                 WHEN n.laddered THEN
                   COALESCE(task_check_ladder_days(n.outcome, n.cnt_nc),
                            (SELECT l.days[cardinality(l.days)] FROM task_check_ladder_settings l WHERE l.outcome = n.outcome))
                 WHEN n.outcome = 'not_found' AND cfg.rep_on AND split_part(n.task_id, ':', 2) = ANY (cfg.task_types) AND n.cnt_nf >= 2
                   THEN cfg.rep_days
                 WHEN n.outcome = 'not_found' THEN cfg.nf_days
                 ELSE cfg.default_days
            END || ' days')::INTERVAL AS dur,
           CASE WHEN n.laddered THEN task_check_ladder_days(n.outcome, n.n) END AS ladder_days
      FROM n CROSS JOIN cfg
  )
  SELECT d.work_key,
         count(*) FILTER (WHERE d.laddered),
         COALESCE(bool_or(d.laddered AND d.ladder_days IS NULL), FALSE),
         min(d.checked_at) FILTER (WHERE d.laddered AND d.ladder_days IS NULL),
         max(d.checked_at) FILTER (WHERE d.laddered),
         max(d.checked_at + d.dur) FILTER (WHERE d.checked_at > now() - d.dur AND d.checked_at > now() - (SELECT max_window FROM cfg)),
         max(d.checked_at + d.dur) FILTER (WHERE d.outcome IN ('not_found', 'confirmed') AND d.checked_at > now() - d.dur
                                            AND d.checked_at > now() - (SELECT max_window FROM cfg))
    FROM d
   GROUP BY d.work_key
$$;
COMMENT ON FUNCTION work_key_ladder_states IS '全部有查核紀錄的工作卡的階梯與冷卻狀態，一次對 task_checks 做集合運算（#981）。每張卡的結果與 work_key_ladder_state(work_key) 逐欄一致；seed 排程（refresh_dispatch_blocked）與視圖 task_ladder_closed 用它，不再逐卡呼叫單卡版。單卡呼叫者（/next、task_in_check_cooldown）仍用 work_key_ladder_state。2026-11-18';

-- 結案清單：定義與 20261111100000 相同，只把「逐卡 LATERAL 呼叫」換成讀集合結果
CREATE OR REPLACE VIEW task_ladder_closed AS
SELECT m.task_id, s.checks, s.closed_at, s.last_checked_at,
       CASE WHEN m.task_id LIKE 'auto:%' THEN split_part(m.task_id, ':', 2) ELSE 'manual' END AS task_kind
  FROM work_key_ladder_states() s
  JOIN (SELECT tc.work_key AS wk, tc.task_id FROM task_checks tc WHERE tc.work_key IS NOT NULL
        UNION
        SELECT d.work_key, d.task_id FROM task_dispatches d WHERE d.work_key IS NOT NULL AND d.task_id NOT LIKE 'verify:%') m ON m.wk = s.work_key
 WHERE s.closed;

COMMENT ON VIEW task_ladder_closed IS '被查核階梯結案的任務（同一張工作卡 work_key 的 not_found＋confirmed 累計超過階梯格數，2026-11-11 起；之前按 task_id）：每個掛在這張卡上的任務代號一列。auto: 任務由 refresh_dispatch_blocked 永久 blocked。手動任務只在「它自己的查核」超過階梯格數時才被關（refresh_dispatch_blocked 開頭，維持改前行為）。維護者覆核用；要放回去＝刪掉那幾筆 task_checks（或改設定表 days）。2026-11-18 起讀 work_key_ladder_states() 集合結果';

-- refresh_dispatch_blocked：與 20261111100000 的定義相比只有四處不同（以 #981 標註）：
--   ① 開頭物化 ls；② b 的結案 auto: 任務改讀 ls；③ cool 改讀 ls；④ 逐列 EXISTS (SELECT 1 FROM b …) 改成 LEFT JOIN b（同一份結果，只算一次）。其餘一字不差。
CREATE OR REPLACE FUNCTION refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  -- >>> 查核階梯：手動任務（uuid）結案＝關閉（open 的才動）。只看「它自己的」查核（按自己的 task_id 累計，維持 work_key 之前的行為）：
  --     同一張卡（同人同 need）被 auto: 任務的查核結案時，手動任務（網站請求、提議）留 open、不關
  UPDATE contribution_tasks t SET status = 'closed', closed_at = now()
   WHERE t.status = 'open'
     AND EXISTS (
       SELECT 1 FROM (SELECT x.outcome, row_number() OVER (ORDER BY x.checked_at, x.id) AS n
                        FROM task_checks x
                       WHERE x.task_id = t.id::text AND x.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(x.task_id)) z
        WHERE task_check_ladder_days(z.outcome, z.n) IS NULL);
  -- <<< 查核階梯
  -- >>> #981：階梯狀態對 task_checks 一次集合運算（物化一次，b 與 cool 共用；取代逐卡呼叫 work_key_ladder_state 與視圖 task_ladder_closed）
  WITH ls AS MATERIALIZED (SELECT * FROM work_key_ladder_states()),
  saturated AS (
    SELECT c.task_id FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed')
    GROUP BY c.task_id HAVING COUNT(*) >= 5
  ), nochange AS (
    SELECT DISTINCT c.payload->>'task_id' AS task_id FROM contributions c
    WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified')
      AND c.payload->>'task_id' IS NOT NULL
  ), b AS (
    SELECT task_id FROM saturated UNION SELECT task_id FROM nochange
    -- >>> 查核階梯：結案的 auto: 任務永久不派
    --     （與視圖 task_ladder_closed 同一份定義：結案卡上每一個任務代號，查核紀錄出現過的加派工列掛著這個 work_key 的）
    UNION SELECT m.task_id
            FROM ls
            JOIN (SELECT tc.work_key AS wk, tc.task_id FROM task_checks tc WHERE tc.work_key IS NOT NULL
                  UNION
                  SELECT d.work_key, d.task_id FROM task_dispatches d WHERE d.work_key IS NOT NULL AND d.task_id NOT LIKE 'verify:%') m ON m.wk = ls.work_key
           WHERE ls.closed AND m.task_id LIKE 'auto:%'
    -- <<< 查核階梯
  )
  , cool AS (
    -- 工作卡鍵（20261111100000）：同一張卡的查核一起算，冷卻取最晚的一筆（換號、換臂、手動任務與自動缺口都延續）；每個鍵只掃自己的 task_checks
    -- cool_until 非空必有一筆窗口內的查核，所以不用另外濾「30 天內有查核的鍵」
    SELECT ls.work_key, ls.cool_until AS until FROM ls WHERE ls.cool_until IS NOT NULL
  )
  -- >>> 多人分組任務：逐人冷卻
  , st AS MATERIALIZED (SELECT * FROM roster_group_person_status())
  , gp AS (
    SELECT t.id::TEXT AS task_id, COALESCE(s.closed, FALSE) AS closed, s.cool_until AS until
      FROM contribution_tasks t
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.target->'people', '[]'::JSONB)) e
      LEFT JOIN st s ON s.cid = roster_group_check_task_id(e->>'key', e->>'action', e->>'politician_election_id')
     WHERE t.status = 'open' AND t.target->>'origin' = 'roster_group'
  ), g AS (
    SELECT gp.task_id,
           CASE WHEN count(*) FILTER (WHERE NOT gp.closed) > 0
                 AND count(*) FILTER (WHERE NOT gp.closed AND NOT COALESCE(gp.until > now(), FALSE)) = 0
                THEN min(gp.until) FILTER (WHERE NOT gp.closed) END AS until
      FROM gp GROUP BY gp.task_id
  )
  -- <<< 多人分組任務
  , x AS (
    SELECT d.task_id,
           CASE WHEN d.task_id LIKE 'auto:%' THEN b.task_id IS NOT NULL ELSE d.blocked END AS blocked,
           CASE WHEN g.task_id IS NOT NULL THEN g.until ELSE c.until END AS until,
           task_queue_key(d.last_dispatched_at, d.priority_seconds, CASE WHEN g.task_id IS NOT NULL THEN g.until ELSE c.until END, d.boost_seconds)
             > now() + make_interval(secs => (SELECT q.dispatch_horizon_seconds FROM queue_settings q WHERE q.id = 1)) AS cooling
      FROM task_dispatches d LEFT JOIN cool c ON c.work_key = COALESCE(d.work_key, 'task:' || d.task_id) LEFT JOIN g ON g.task_id = d.task_id
           -- #981：原本是逐列 EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id)，每一列都重跑一次 b（約 2.9 萬列 × 1.6 毫秒＝47 秒）；b 是 UNION 已去重，改成 LEFT JOIN 只算一次，結果相同
           LEFT JOIN b ON b.task_id = d.task_id
     WHERE d.task_id NOT LIKE 'verify:%'
  )
  UPDATE task_dispatches d
     SET blocked = x.blocked, cool_until = x.until, cooling = COALESCE(x.cooling, false)
    FROM x
   WHERE x.task_id = d.task_id
     AND (d.blocked, d.cool_until, d.cooling) IS DISTINCT FROM (x.blocked, x.until, COALESCE(x.cooling, false));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
