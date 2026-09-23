-- 驗證與任務 2:1，在「進表時」就排好（小良哥 2026-09-24：選 B，「進表時可以優化一下排列順序」「他們兩個都有進表吧」）
--
-- 09-21 起派工只看一個時間軸（task_dispatches.queue_at，等最久的先）。09-24 實查：最舊的待驗證是 09-22 16:39，
-- 排在它前面還有 728 個 09-21 建佇列時一起放進來的缺口任務——代理每次領到的都是任務，14:00Z 起投票幾乎歸零、
-- 18:00Z 後完全停；做完任務交出的新貢獻又排到隊尾，等票的只會越堆越多。
--
-- 驗證列（verify:）和缺口任務（auto:）本來就在同一張 task_dispatches。所以不在派工時另外數次數，而是在進表時
-- 給排隊時間（加權公平排隊）：
--   驗證的下一個位置＝max(現在, 驗證行列最後一個) + 1 秒；任務的下一個位置＝max(現在, 任務行列最後一個) + 2 秒。
-- 兩邊都有積壓時，時間軸上每 2 秒有 2 筆驗證、1 筆任務＝2:1；只有一邊有積壓時，新進的另一邊照現在時間插進去，不會被餓死。
-- 派過放回隊尾也走同一條規則。/next 的 pickQueueHead 不用改（照舊誰最早誰先），/queue 照 queue_at 排就是派出的順序。
-- 插隊（1970／1980 年段：人明確要求先做、網站訪客的提問）照舊最先，不進這套比例。

CREATE OR REPLACE FUNCTION queue_slot(p_kind TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(now(), COALESCE((
           SELECT max(d.queue_at) FROM task_dispatches d
            WHERE d.queue_at >= TIMESTAMPTZ '2000-01-01'
              AND CASE WHEN p_kind = 'verify' THEN d.task_id LIKE 'verify:%' ELSE d.task_id NOT LIKE 'verify:%' END
         ), now()))
         + CASE WHEN p_kind = 'verify' THEN INTERVAL '1 second' ELSE INTERVAL '2 seconds' END
$$;
COMMENT ON FUNCTION queue_slot IS '進表時的排隊位置：驗證行列每筆 +1 秒、任務行列每筆 +2 秒（2:1），起點不早於現在';

-- 新貢獻的驗證列：插隊類照舊 1970，其餘排進驗證行列
CREATE OR REPLACE FUNCTION contribution_queue_at(p_contribution_type TEXT, p_task_id TEXT, p_created_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_contribution_type = 'question_answer' THEN TIMESTAMPTZ '1970-01-01'
    WHEN EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = p_task_id AND t.source = 'web_request') THEN TIMESTAMPTZ '1970-01-01'
    ELSE queue_slot('verify')
  END;
$$;

-- 派過放回隊尾：同一條規則
CREATE OR REPLACE FUNCTION task_dispatched(p_task_id TEXT) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  VALUES (p_task_id, now(), queue_slot(CASE WHEN p_task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END), 1)
  ON CONFLICT (task_id) DO UPDATE
    SET last_dispatched_at = now(),
        queue_at = queue_slot(CASE WHEN p_task_id LIKE 'verify:%' THEN 'verify' ELSE 'task' END),
        dispatch_count = task_dispatches.dispatch_count + 1
$$;

-- 排程：新缺口一筆一筆排進任務行列（同一輪進來的也各隔 2 秒，不擠在同一個時間點）
CREATE OR REPLACE FUNCTION seed_auto_task_queue()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_new INTEGER; v_verify INTEGER; v_base TIMESTAMPTZ;
BEGIN
  -- 全站缺口只在這裡算（重，約 1.5 秒）；/next 只讀 task_dispatches
  DROP TABLE IF EXISTS _gaps;
  CREATE TEMP TABLE _gaps ON COMMIT DROP AS SELECT DISTINCT ON (g.task_id) g.* FROM contribution_auto_tasks_arms() g ORDER BY g.task_id;

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
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count, task_type, target, what_we_need, hint_sources, reward, region, refreshed_at)
  SELECT g.task_id, now(), v_base + (row_number() OVER (ORDER BY g.task_id) - 1) * INTERVAL '2 seconds', 0,
         g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, now()
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

  RETURN v_new + v_verify;
END;
$$;

-- 現有積壓重排一次：兩條行列各自保持原本的先後，交錯成 驗 驗 任 驗 驗 任…
WITH v AS (
  SELECT task_id, row_number() OVER (ORDER BY queue_at, task_id) - 1 AS rn FROM task_dispatches
   WHERE task_id LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01'
)
UPDATE task_dispatches d SET queue_at = now() + v.rn * INTERVAL '1 second' FROM v WHERE d.task_id = v.task_id;
WITH t AS (
  SELECT task_id, row_number() OVER (ORDER BY queue_at, task_id) - 1 AS rn FROM task_dispatches
   WHERE task_id NOT LIKE 'verify:%' AND queue_at >= TIMESTAMPTZ '2000-01-01'
)
UPDATE task_dispatches d SET queue_at = now() + INTERVAL '1.5 seconds' + t.rn * INTERVAL '2 seconds' FROM t WHERE d.task_id = t.task_id;

-- /queue：跟 /next 同一套——任務讀 contribution_auto_tasks（派工佇列＋共同過濾）與開放的手動任務，驗證讀驗證池；
-- 照 queue_at 排，同一時刻驗證先、手動次之、自動最後（_shared/dispatch.ts 的 HEAD_ORDER）。
-- 不含每台機器各自的排除（自己交過、自己投過、認領中）。
CREATE OR REPLACE FUNCTION queue_preview(p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (pos INTEGER, kind TEXT, task_id TEXT, task_type TEXT, subject TEXT, region TEXT, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH items AS (
    SELECT 'task'::TEXT AS kind, g.task_id, g.task_type,
           COALESCE(NULLIF(g.target->>'name', ''), NULLIF(g.target->>'policy_title', ''), NULLIF(g.target->>'title', ''), '') AS subject,
           g.target->>'region' AS region, g.queue_at, 2 AS tie
      FROM contribution_auto_tasks(NULL, NULL, 100000, '', NULL, NULL) g
    UNION ALL
    SELECT 'task', t.id::TEXT, t.task_type, t.title, t.region,
           COALESCE(t.last_dispatched_at,
                    CASE WHEN t.source IN ('manual', 'auto_dispute', 'web_request') THEN TIMESTAMPTZ '1980-01-01' ELSE t.created_at END), 1
      FROM contribution_tasks t
     WHERE t.status = 'open'
    UNION ALL
    SELECT 'verify', 'verify:' || v.id, v.contribution_type,
           COALESCE(NULLIF(v.payload->>'name', ''),
                    (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(v.payload)),
                    (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(v.payload->>'policy_id')),
                    NULLIF(v.payload->>'title', ''), ''),
           COALESCE(v.payload->>'region', (SELECT p.region FROM politicians p WHERE p.id = contribution_subject_politician(v.payload))),
           v.queue_at, 0
      FROM contribution_verify_pool(NULL, NULL, 2000, NULL) v
  )
  SELECT row_number() OVER (ORDER BY i.queue_at, i.tie, i.task_id)::INTEGER AS pos,
         i.kind, i.task_id, i.task_type, i.subject, i.region, i.queue_at
    FROM items i
   ORDER BY i.queue_at, i.tie, i.task_id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 2000));
$$;
COMMENT ON FUNCTION queue_preview IS '派工佇列預覽（/queue 頁）：跟 /next 同一個時間軸（task_dispatches.queue_at，進表時已按驗證：任務 2:1 排好）';
