-- 領任務只看佇列最前面一段＋清掉 profile_gap 的舊冷卻（2026-10-02 事故修復）
--
-- 事故：/next 不帶 region 回 500「auto tasks: canceling statement due to statement timeout」，或 12~13 秒勉強過。
-- 根因（量出來的，不是推的）：contribution_auto_tasks 每次被呼叫都把 task_dispatches 整份快照
-- （2,459 筆）每一筆跑過 task_checks／inflight／no_change／lease／自己 IP 的檢查再排序，最後只取前幾筆。
-- 依型別計時，耗時跟筆數成正比，每筆約 7 毫秒；整份約 17 秒。
-- 這跟佇列的設計相反：排程每 10 分鐘排好快照，領的時候應該只拿最前面的。
-- 今天之前就在邊緣；20261002000002 清掉 417 張佔位圖讓 profile_gap 從 32 變 320，把它推過時間上限。
--
-- 🔴 前一支止血（20261002000004，把 profile_detail_gap 從 arms() 拿掉）打錯地方：arms() 只有
-- 排程會呼叫，領任務的路徑讀的是 task_dispatches，根本不碰 arms()。
--
-- 這一支做兩件事：
--   ① contribution_auto_tasks 先照 queue_at 取前段（窗口跟著 p_limit 走），只檢查那一段。
--      排序本來就只看 queue_at，所以派出順序不變。同簽名、同回傳欄位。
--   ② 清掉 profile_gap 在佔位圖修正**之前**記下的冷卻（task_checks）：那時這些人「有照片」，
--      代理查的是出生年／現職，查不到就冷卻 14 天；佔位圖清掉後他們真的缺照片了，
--      舊冷卻會擋住真正該做的新工作，而且會卡在佇列最前面（插隊的缺照片 404 筆）讓 ① 的窗口派不出東西。
--      只清 profile_gap、只清修正前的；原值存進 task_checks_cleared，要還原就搬回去。
--   ③ task_dispatches(queue_at, task_id) 加索引，讓 ① 取前段不用排整張表。

CREATE INDEX IF NOT EXISTS task_dispatches_queue_at_idx ON task_dispatches (queue_at, task_id);

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  -- 只看佇列最前面一段（2026-10-02）：佇列是排程每 10 分鐘排好的快照，領任務該是「拿最前面的」，
  -- 但原本是把整份快照（2,459 筆）每一筆都跑完下面的檢查再排序取前幾筆 —— 實測每筆約 7 毫秒，
  -- 整份 17 秒，超過時間上限讓 /next 回 500。依型別實測：10 筆 0.39s／28 筆 0.77s／113 筆 1.36s／236 筆以上超時。
  -- 排序本來就只看 queue_at（下面 jev 那段開頭是 d.task_id IS NULL，d 是 INNER JOIN 永遠不為 NULL，恆為 1），
  -- 所以先照 queue_at 取前段不會改變派出的順序。
  -- 窗口跟著 p_limit 走：next 要 30 筆 → 看前 150；request-task 用 p_limit=100000 撈某型全部缺口找特定人物，
  -- 窗口 500000 等於不限，它的行為完全不變。
  WITH t AS (
    SELECT task_id, task_type, target, what_we_need, hint_sources, reward, region FROM task_dispatches
    WHERE task_id LIKE 'auto:%' AND task_type IS NOT NULL
      AND (p_type IS NULL OR task_type = p_type)
      AND (p_region IS NULL OR region = p_region)
    ORDER BY queue_at ASC, task_id
    LIMIT GREATEST(LEAST(COALESCE(p_limit, 20), 100000) * 5, 150)
  ),
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

-- ② 清 profile_gap 的舊冷卻（存檔可還原）
CREATE TABLE IF NOT EXISTS task_checks_cleared (LIKE task_checks);
ALTER TABLE task_checks_cleared ADD COLUMN IF NOT EXISTS cleared_at   TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE task_checks_cleared ADD COLUMN IF NOT EXISTS clear_reason TEXT;
COMMENT ON TABLE task_checks_cleared IS
  '被清掉的冷卻紀錄原值（2026-10-02 起）。要還原：INSERT INTO task_checks SELECT <task_checks 的欄位> FROM task_checks_cleared WHERE …';
ALTER TABLE task_checks_cleared ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_checks_cleared_public_read ON task_checks_cleared;
CREATE POLICY task_checks_cleared_public_read ON task_checks_cleared FOR SELECT USING (true);

DO $$
DECLARE n INTEGER;
BEGIN
  INSERT INTO task_checks_cleared
  SELECT tc.*, now(), '佔位圖修正（20261002000002）前記下的 profile_gap 冷卻；那時這些人被誤判為有照片'
  FROM task_checks tc
  WHERE tc.task_id LIKE 'auto:profile_gap:%' AND tc.checked_at < '2026-10-02T03:30:00Z';
  DELETE FROM task_checks
  WHERE task_id LIKE 'auto:profile_gap:%' AND checked_at < '2026-10-02T03:30:00Z';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '清掉 profile_gap 舊冷卻：% 筆', n;
END $$;
