-- #490 日本站跟進：把正見 rebalance_queue 的「零驗證列時起點退回 1.5 秒」抄成 policy_jp.rebalance_queue
-- 抄自 20261009150000_rebalance_anchor_no_drift.sql；與 #498 同樣的允許差異（policy_jp. 前綴、search_path）。
-- CREATE OR REPLACE 保留原有權限（20261009130000 已 REVOKE／GRANT 給 service_role），不另動。
-- 走樣守門 policy-jp-dispatch-drift.test.ts 會把這支還原後與 public 現行定義逐字比對。

CREATE OR REPLACE FUNCTION policy_jp.rebalance_queue() RETURNS INTEGER
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_start TIMESTAMPTZ; v_ready INTEGER; v_n INTEGER := 0; v_c INTEGER;
BEGIN
  -- 起點＝兩條行列目前最前面那一筆的時間，不是 now()：重排只改內部交錯，不能讓整條往後退。
  -- 用 now() 的話，人建任務（contribution_tasks，照上次派出時間排、不參與重排）永遠比重排後的驗證早，
  -- 12 筆人建任務會一直輪流排在所有驗證前面（09-24 00:xx a-zhen 50 分鐘沒拿到一筆驗證）。
  SELECT COALESCE(LEAST(MIN(queue_at), now()), now()) INTO v_start FROM policy_jp.task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  -- >>> #490：沒有任何驗證列時，隊頭是任務列（排在 v_start＋1.5 秒），起點要退回 1.5 秒，不然每輪往後漂 1.5 秒
  IF NOT EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01')
     AND EXISTS (SELECT 1 FROM policy_jp.task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01') THEN
    SELECT LEAST(MIN(queue_at) - INTERVAL '1.5 seconds', now()) INTO v_start FROM policy_jp.task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  END IF;
  -- <<< #490
  DROP TABLE IF EXISTS _ready;
  CREATE TEMP TABLE _ready ON COMMIT DROP AS
    SELECT g.task_id FROM policy_jp.contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g WHERE g.queue_at >= TIMESTAMPTZ '2000-01-01';
  SELECT COUNT(*) INTO v_ready FROM _ready;

  WITH v AS (
    SELECT task_id, row_number() OVER (ORDER BY queue_at, task_id) - 1 AS rn FROM policy_jp.task_dispatches
     WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01'
  )
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + v.rn * INTERVAL '1 second' FROM v WHERE d.task_id = v.task_id
     AND d.queue_at IS DISTINCT FROM v_start + v.rn * INTERVAL '1 second'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  -- >>> 優先層：可派的任務依層加權交錯（第 k 筆的虛擬完成時間＝k／權重，同時間層號小的先；同一層內照 queue_at、task_id 先進先出）
  WITH w AS (
    SELECT d.task_id, d.queue_at, COALESCE(d.priority, (SELECT x.id FROM policy_jp.task_priority_tiers x WHERE x.is_default)) AS tier
      FROM policy_jp.task_dispatches d JOIN _ready r ON r.task_id = d.task_id
  ), k AS (
    SELECT w.task_id, w.queue_at, w.tier, row_number() OVER (PARTITION BY w.tier ORDER BY w.queue_at, w.task_id) AS k FROM w
  ), t AS (
    SELECT k.task_id, row_number() OVER (ORDER BY k.k::NUMERIC / COALESCE(tw.weight, 1), k.tier, k.queue_at, k.task_id) - 1 AS rn
      FROM k LEFT JOIN policy_jp.task_priority_tiers tw ON tw.id = k.tier
  )
  -- <<< 優先層
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds' FROM t WHERE d.task_id = t.task_id
     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  WITH t2 AS (
    SELECT d.task_id, row_number() OVER (ORDER BY d.queue_at, d.task_id) - 1 AS rn
      FROM policy_jp.task_dispatches d
     WHERE d.task_id NOT LIKE 'verify:%' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
       AND NOT EXISTS (SELECT 1 FROM _ready r WHERE r.task_id = d.task_id)
  )
  UPDATE policy_jp.task_dispatches d SET queue_at = v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds' FROM t2 WHERE d.task_id = t2.task_id
     AND d.queue_at IS DISTINCT FROM v_start + INTERVAL '1.5 seconds' + (v_ready + t2.rn) * INTERVAL '2 seconds'; -- #465：位置沒變的不重寫
  GET DIAGNOSTICS v_c = ROW_COUNT; v_n := v_n + v_c;

  RETURN v_n;
END;
$$;

NOTIFY pgrst, 'reload schema';
