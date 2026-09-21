-- 派工改成單一時間軸（使用者 2026-09-21）
--
--   「像裁決在被建立的時候，就應該使用最舊的時間排入任務裡，這樣它就會被優先派發出去。
--     新的任務出來（比如說明確定義新缺口出來的那些任務），用的都是現在的時間，
--     所以會被排在比較後面。所以我們手動要求的那一些…都會被設置成很舊的資料。
--     加進任務佇列裡面，就有一個參數決定它要放在最前面還是最後面。」
--
-- 這條規則要成立，前提是**每一筆任務進佇列時都有一個時間**。現在沒有：
-- 自動缺口是即時算出來的，沒派過就沒有 task_dispatches 的列，排序用
-- `last_dispatched_at ASC NULLS FIRST` 把 NULL 當成無限舊——所以 1,168 筆缺口
-- **全部並列最前**，誰先誰後實際上是 task_id 的字典序決定的，那是隨機不是設計。
-- 而「2026 縣市長最前面」只好另外開一個維度（task_priority_tier）去壓它們。
--
-- 這支給 task_dispatches 加 queue_at：缺口第一次被看到就記一個時間。
--   - 使用者指定要最先做的（2026 縣市長的基本資料與政見）→ 1980-01-01
--   - 其餘新缺口 → now()，排到隊伍後面
--   - 任何任務派出去 → 蓋成 now()，回到隊尾
-- 有了它，task_priority_tier 這個第二維度就可以退場，排序只剩一個 ORDER BY。
--
-- 為什麼這樣比「沒派過的優先」好（使用者的理由，值得留著）：
--   「我們要的是盡可能覆蓋任務數量…輪了 900 次之後，我們就有可能出現 300 筆
--     上線的資料；可是你如果把一筆複雜的任務卡在前面，900 筆過後可能只有 50 筆。」
-- 領完就走，簡單的當場結案離開池子，複雜的自然被推到下一輪。

ALTER TABLE task_dispatches
  ADD COLUMN IF NOT EXISTS queue_at TIMESTAMPTZ NOT NULL DEFAULT now();
COMMENT ON COLUMN task_dispatches.queue_at IS
  '這筆任務在佇列裡的位置（唯一的排序鍵）。第一次看到缺口時寫入：使用者指定優先的寫 1980-01-01、其餘寫 now()；每次派出去蓋成 now() 回到隊尾。';

-- 既有的列用 last_dispatched_at 回填，不要讓它們被當成「剛進佇列」而洗掉輪替狀態
UPDATE task_dispatches SET queue_at = last_dispatched_at WHERE queue_at <> last_dispatched_at;

-- 派出就蓋章：last_dispatched_at 留著當稽核用（真的派過幾次、何時），queue_at 才是排序鍵
CREATE OR REPLACE FUNCTION task_dispatched(p_task_id TEXT) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  VALUES (p_task_id, now(), now(), 1)
  ON CONFLICT (task_id) DO UPDATE
    SET last_dispatched_at = now(), queue_at = now(), dispatch_count = task_dispatches.dispatch_count + 1
$$;

-- ------------------------------------------------------------
-- 缺口第一次被看到就發號碼牌。由 pg_cron 定時跑（使用者：「我們只要有一個排程，
-- 定時檢查有沒有新的自動缺口」）。只寫沒見過的，已經有列的一律不動——
-- 重跑不會把別人的輪替狀態洗掉。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER;
BEGIN
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  SELECT g.task_id,
         now(),  -- 稽核欄位，沒有意義的初值；真的派出去時才會被蓋成當下
         CASE
           -- 使用者明確指定要最先做的：2026 縣市長的基本資料與政見
           WHEN task_priority_tier(g.task_type, g.target) IN (0, 1) THEN TIMESTAMPTZ '1980-01-01'
           ELSE now()
         END,
         0
    FROM contribution_auto_tasks_arms() g
   WHERE NOT EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = g.task_id)
  ON CONFLICT (task_id) DO NOTHING;
  GET DIAGNOSTICS v_new = ROW_COUNT;
  RETURN v_new;
END;
$$;
COMMENT ON FUNCTION seed_auto_task_queue IS
  '新出現的自動缺口發一個 queue_at：使用者指定優先的給 1980-01-01，其餘給 now()（排隊尾）。已經有列的不動。由 pg_cron 每 10 分鐘呼叫。';

SELECT cron.unschedule('seed-auto-task-queue-10min')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'seed-auto-task-queue-10min');
SELECT cron.schedule('seed-auto-task-queue-10min', '*/10 * * * *', 'SELECT seed_auto_task_queue();');

-- 現有的 1,168 筆缺口先發一輪號碼牌，不必等下一個十分鐘整
SELECT seed_auto_task_queue();

-- ------------------------------------------------------------
-- 派工排序改成單一時間軸：task_priority_tier 這個第二維度退場，
-- 「2026 縣市長最前」改由它們的 queue_at = 1980 表達（上面 seed_auto_task_queue()）。
--
-- Jev 的一次性插隊留著：它跟「誰先誰後」是同一件事，而且只作用在沒派過的那一次，
-- 派過之後就回到時間軸上，不會變成永久特權。
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS contribution_auto_tasks(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH t AS (SELECT * FROM contribution_auto_tasks_arms()),
  inflight AS (
    SELECT c.task_id, COUNT(*) AS n FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed') GROUP BY c.task_id
  )
  -- 內連接，不是左連接：**沒被排程收進佇列的缺口就還沒進佇列，不派。**
  -- 使用者 2026-09-21：「我們自動缺口…要從排程裡面把它加到佇列裡面來，
  -- 加入排程的時間就是它的現在時間。」用 COALESCE 給個預設值就等於繞過佇列，
  -- 那條規則會變成裝飾。代價是新缺口最多晚 10 分鐘才派得出去，這是對的代價。
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward, d.queue_at
  FROM t
  JOIN task_dispatches d ON d.task_id = t.task_id
  LEFT JOIN inflight f ON f.task_id = t.task_id
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id
        AND tc.checked_at > now() - (
          CASE WHEN tc.outcome = 'unreachable' THEN task_unreachable_cooldown_days() ELSE task_check_cooldown_days() END || ' days'
        )::INTERVAL
    )
    AND COALESCE(f.n, 0) < 5
    AND NOT EXISTS (
      SELECT 1 FROM contributions c WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified') AND c.payload->>'task_id' = t.task_id
    )
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = t.task_id OR l.target_key = task_target_key(t.task_id, t.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = t.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
  ORDER BY
    -- Jev 高信心又還沒派過的，那一次插到最前；派過就回到時間軸，不是永久特權
    CASE WHEN d.task_id IS NULL AND system_one_priority_enabled() AND (
      EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'election' AND j.choice <> 'unknown'
          AND j.probability >= system_one_min_probability()
          AND t.task_id IN ('auto:policy_election_missing:' || j.subject_id, 'auto:policy_election_mismatch:' || j.subject_id))
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.choice = 'same'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:duplicate_politician:' || j.subject_id)
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'source_support' AND j.choice IN ('supported', 'not_supported')
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:legacy_audit:' || j.subject_id)
    ) THEN 0 ELSE 1 END,
    -- 唯一的排序鍵：佇列時間。1980＝使用者指定最先做，排程加進來的當下＝排最後，
    -- 派出去就蓋成 now() 回到隊尾。
    d.queue_at ASC,
    t.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_auto_tasks IS
  '自動任務派工。排序只有一個時間軸 queue_at（1980＝使用者指定最先做、now()＝剛進佇列排最後、派出即蓋成 now()），加上 Jev 對沒派過那一次的插隊。2026-09-21 起 task_priority_tier 不再參與排序。';
