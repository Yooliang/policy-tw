-- ============================================================
-- #490 rebalance_queue：沒有待驗證列時，隊伍每輪往後漂 1.5 秒
-- ============================================================
--
-- 起因（#488 審查發現的既有行為）：rebalance_queue 的起點 v_start 取整張表（queue_at >= 2000-01-01）的 MIN(queue_at)。
-- 驗證列排在 v_start＋rn 秒、任務列排在 v_start＋1.5 秒＋rn×2 秒。有驗證列時，隊頭是驗證列（rn=0 → v_start），MIN 就是 v_start，穩定。
-- 某一輪若表裡一筆 verify: 列都沒有，隊頭是任務列（v_start＋1.5 秒），下一輪 MIN 變成 v_start＋1.5，整條隊伍再排一次又往後 1.5 秒——
-- 每輪（10 分鐘）漂一次，所有列的 queue_at 都變，#465 的「位置沒變不寫」在這個狀態省不到。
--
-- 做法：只在「沒有任何 verify: 列（queue_at >= 2000-01-01）」時，把起點從隊頭往前推回 1.5 秒（隊頭是任務列，它自己就排在 v_start＋1.5 秒的位置）。
-- 有驗證列時一個字都沒變：起點仍是 MIN(queue_at)。隊頭被領走時，隊頭往後移到下一筆是真實的前進，不是漂移（有驗證列時也是如此）。
-- 不動：2:1 交錯（驗證每筆 1 秒、任務每筆 2 秒）、優先層權重交錯、1970／1980 年段的手動插隊（查詢條件 queue_at >= 2000-01-01 排除它們）、三段 UPDATE 的位置沒變不寫。
--
-- 唯讀實測（2026-10-09，正式庫）：現在 verify: 列 4,840、任務列 8,321，MIN(queue_at)＝2026-09-24 06:40:17.63（驗證列），min 任務列＝06:40:19.13（差 1.5 秒，吻合），
-- 所以正式庫目前沒有漂移；cron 近 7 天 seed 每天 144 輪、0 失敗。歷史上有沒有出現過零驗證列的時段，task_dispatches 沒有留 verify: 列數的紀錄（gap_events 只記 auto: 列），查不到。
--
-- 只換 rebalance_queue 一支函式，沒有 schema 變動。

CREATE OR REPLACE FUNCTION rebalance_queue() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_start TIMESTAMPTZ; v_ready INTEGER; v_n INTEGER := 0; v_c INTEGER;
BEGIN
  -- 起點＝兩條行列目前最前面那一筆的時間，不是 now()：重排只改內部交錯，不能讓整條往後退。
  -- 用 now() 的話，人建任務（contribution_tasks，照上次派出時間排、不參與重排）永遠比重排後的驗證早，
  -- 12 筆人建任務會一直輪流排在所有驗證前面（09-24 00:xx a-zhen 50 分鐘沒拿到一筆驗證）。
  SELECT COALESCE(LEAST(MIN(queue_at), now()), now()) INTO v_start FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  -- >>> #490：沒有任何驗證列時，隊頭是任務列（排在 v_start＋1.5 秒），起點要退回 1.5 秒，不然每輪往後漂 1.5 秒
  IF NOT EXISTS (SELECT 1 FROM task_dispatches WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01')
     AND EXISTS (SELECT 1 FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01') THEN
    SELECT LEAST(MIN(queue_at) - INTERVAL '1.5 seconds', now()) INTO v_start FROM task_dispatches WHERE queue_at >= TIMESTAMPTZ '2000-01-01';
  END IF;
  -- <<< #490
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

COMMENT ON FUNCTION rebalance_queue IS
  '把佇列重排成 驗證：派得出去的任務＝2:1（seed_auto_task_queue 每 10 分鐘呼叫）；插隊的不動。可派的任務依優先層（task_dispatches.priority，NULL＝預設層）用各層的權重（優先層表的 weight）加權交錯，'
  '同一層內先進先出；任務位置的間距仍是每筆 2 秒，所以 2:1 不變。位置沒變的列不重寫，回傳值＝真的改了位置的列數。沒有任何驗證列時起點退回 1.5 秒（隊頭是任務列），隊伍不會每輪往後漂。2026-10-09（#465、#490）';

NOTIFY pgrst, 'reload schema';
