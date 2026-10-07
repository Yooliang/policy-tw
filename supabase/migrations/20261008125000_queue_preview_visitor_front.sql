-- /queue 預覽跟上派工：網站請求與公民提問排在所有加推之前，派出超過 6 小時還沒解決就回到最前（2026-10-08）
-- ============================================================
--
-- 維護者 10-08：「網站請求裡面的任務每 6 小時幫忙插隊一次，因為這個是有人在關注的東西」，公民提問一起照辦。
-- 派工（supabase/functions/_shared/dispatch.ts 的 manualQueueAt）這次改了：
--   * source = 'web_request' 或 task_type = 'question' 的 open 任務，沒派過、或 last_dispatched_at 超過 6 小時 → 1970-01-01
--     （加推是 1980-01-01 減 n 分鐘，永遠比 1970 晚；2026-10-08 有 307 筆加推排在 1979-12-31 之前，網站請求被擠到後面）
--   * 6 小時內剛派過的 → last_dispatched_at（隊尾，照舊）
-- /queue 頁讀的是 queue_preview 的手動任務那一支，原本寫死「沒派過 → manual／auto_dispute／web_request 是 1980」，
-- 不改的話網站上的順序會跟實際派工對不上。
--
-- 只動 queue_preview 的手動任務分支的 queue_at 運算式，其餘（自動缺口、驗證、排序、LIMIT、SECURITY DEFINER、授權）
-- 與 20261006034900 的現行定義一字不差。6 小時寫死在這裡，跟 dispatch.ts 的 VISITOR_REQUEUE_HOURS 一致，
-- 守門測試 visitor-front-queue.test.ts 對兩邊做比對。
--
-- 不動 task_dispatches／task_boost／contribution_queue_at（驗證列的 1970 早就是這個規則）；不動任何資料。
-- 手動任務列沒有 task_dispatches 的列，所以不需要回填。

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
           CASE WHEN (t.source = 'web_request' OR t.task_type = 'question')
                     AND (t.last_dispatched_at IS NULL OR t.last_dispatched_at < now() - INTERVAL '6 hours')
                THEN TIMESTAMPTZ '1970-01-01'
                ELSE COALESCE(t.last_dispatched_at,
                    CASE WHEN t.source IN ('manual', 'auto_dispute', 'web_request') THEN TIMESTAMPTZ '1980-01-01' ELSE t.created_at END)
           END, 1
      FROM contribution_tasks t
     WHERE t.status = 'open'
    UNION ALL
    SELECT 'verify', 'verify:' || v.id, v.contribution_type,
           COALESCE(NULLIF(v.payload->>'name', ''),
                    (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(v.payload)),
                    (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(v.payload->>'policy_id')),
                    NULLIF(v.payload->>'title', ''), ''),
           COALESCE(v.payload->>'region', (SELECT p.region FROM politicians p WHERE p.id = contribution_subject_politician(v.payload))),
           COALESCE(d.queue_at, v.created_at), 0
      FROM contributions v
      LEFT JOIN task_dispatches d ON d.task_id = 'verify:' || v.id
     WHERE v.status = 'pending'
       -- 跟驗證池同一條可派條件（分數未達標，或高風險型別還不到兩台機器）；不用驗證池本身，因為它一次最多回 200 筆
       AND (v.score < COALESCE(v.target_score, contribution_effective_agree(v.id))
            OR (contribution_needs_two_ips(v.contribution_type, v.payload) AND v.voter_ips < 2))
  )
  SELECT row_number() OVER (ORDER BY i.queue_at, i.tie, i.task_id)::INTEGER AS pos,
         i.kind, i.task_id, i.task_type, i.subject, i.region, i.queue_at
    FROM items i
   ORDER BY i.queue_at, i.tie, i.task_id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 1000), 2000));
$$;
COMMENT ON FUNCTION queue_preview IS '派工佇列預覽（/queue 頁）：跟 /next 同一個時間軸（task_dispatches.queue_at，進表時已按驗證：任務 2:1 排好）。網站請求與公民提問（open）沒派過或派出超過 6 小時＝1970，排在所有加推之前（20261008125000）';
REVOKE ALL ON FUNCTION queue_preview(INTEGER) FROM public;
GRANT EXECUTE ON FUNCTION queue_preview(INTEGER) TO anon, authenticated;
