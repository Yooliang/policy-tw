-- 派工佇列預覽（/queue）不列「等查無回報」的任務（2026-10-13，小良回報：照片二選一一直排在前面卻沒人做）
--
-- 原因：正式庫唯讀查，/queue 前段的「照片二選一」52 筆裡 49 筆都有一張查無回報（no_change）在等票；
-- /next 對這種任務一律跳過（filterReportedDeadEnds：查無回報通過或退件前不再派），可是 queue_preview 沒有同一條件，
-- 所以頁面上看起來排在最前面、實際上沒有人領得到。這支只讓預覽跟 /next 用同一條件；派工本身不變。
-- 同一個 PR 另外拿掉 /next 的「每台機器 2:1」（20261011320000 已取消全站 2:1，那一段漏了，Edge Function 改動）。
--
-- 以 20261008165000 的 queue_preview 為底，只加一段 WHERE（標 >>> 等查無回報）。

CREATE OR REPLACE FUNCTION queue_preview(p_limit INTEGER DEFAULT 1000)
RETURNS TABLE (pos INTEGER, kind TEXT, task_id TEXT, task_type TEXT, subject TEXT, region TEXT, queue_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH items AS (
    SELECT 'task'::TEXT AS kind, g.task_id, g.task_type,
           COALESCE(NULLIF(g.target->>'name', ''), NULLIF(g.target->>'policy_title', ''), NULLIF(g.target->>'title', ''), '') AS subject,
           g.target->>'region' AS region, g.queue_at, 2 AS tie
      FROM contribution_queue_tasks(NULL, NULL, 100000, '', NULL, NULL) g
     -- >>> 等查無回報：有人回報查無（no_change）還在等票或已通過、還沒落庫的任務，/next 不會派給任何人（filterReportedDeadEnds），
     --     預覽也不列，免得看起來排在前面卻一直沒人做；那張查無回報本身的驗證照常列在佇列裡
     WHERE NOT EXISTS (SELECT 1 FROM contributions n
                        WHERE n.contribution_type = 'no_change' AND n.status IN ('pending', 'verified')
                          AND n.payload->>'task_id' = g.task_id)
     -- <<< 等查無回報
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
COMMENT ON FUNCTION queue_preview IS '派工佇列預覽（/queue 頁）：跟 /next 同一個時間軸（task_dispatches.queue_at，排序鍵見 20261011320000）。手動任務也是派工臂 manual_visitor／manual_open 的缺口；有查無回報在等票或已通過的任務 /next 不派，這裡也不列（20261011330000）';
REVOKE ALL ON FUNCTION queue_preview(INTEGER) FROM public;
GRANT EXECUTE ON FUNCTION queue_preview(INTEGER) TO anon, authenticated;
