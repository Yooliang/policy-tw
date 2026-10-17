-- 主控台「派工隊列」頁的資料（唯讀）：隊列裡每一列現在是什麼狀態、隊頭長怎樣、24 小時真的派出多少
-- ============================================================
--
-- 一支唯讀函式 console_queue_state()，不動派工、seed、規則、排序鍵。照 console_passive 的權限寫法
-- （SECURITY DEFINER、釘 search_path、REVOKE ALL FROM PUBLIC、只 GRANT EXECUTE 給 anon／authenticated／service_role）。
-- 台灣站專用；日本站不做（頁面在日本站隱藏）。
--
-- 非驗證列（task_id 不是 'verify:' 開頭）依序分到唯一一個狀態，先符合先贏：
--   blocked（d.blocked）→ cooling（d.cooling 且 queue_at >= 2000-01-01）→ dead_end（有查無回報在等票或已通過，
--   條件同 queue_preview，20261011330000）→ saturated（在途交件 pending／verified／disputed ≥ 5）
--   → question_full（公民提問答案 answer_count＋在等票的 question_answer ≥ question_answer_cap()）→ ready
-- 來源 source：auto（task_id LIKE 'auto:%'）或手動任務的 contribution_tasks.source（manual／suggested／web_request／auto_dispute）。
-- 隊頭 head：依 (queue_at, task_id) 排的非 blocked、非 cooling 前 60 列；pos 是這個排序裡的名次。
-- 「實際派出」一律要 dispatch_count > 0：seed 也會動 last_dispatched_at，單看時間會把沒派過的算進去。

CREATE OR REPLACE FUNCTION console_queue_state() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH inflight AS (
    SELECT c.task_id, count(*) AS n
      FROM contributions c
     WHERE c.status IN ('pending', 'verified', 'disputed')
     GROUP BY c.task_id
  ),
  deadend AS (
    SELECT DISTINCT n.payload->>'task_id' AS task_id
      FROM contributions n
     WHERE n.contribution_type = 'no_change' AND n.status IN ('pending', 'verified')
  ),
  qa AS (
    SELECT t2.target->>'question_id' AS qid, count(*) AS n
      FROM contributions c
      JOIN contribution_tasks t2 ON t2.id::TEXT = c.task_id AND t2.task_type = 'question'
     WHERE c.contribution_type = 'question_answer' AND c.status IN ('pending', 'verified')
     GROUP BY 1
  ),
  q AS (
    SELECT d.task_id, d.task_type, d.target, d.queue_at, d.dispatch_count, d.last_dispatched_at,
           CASE WHEN d.task_id LIKE 'auto:%' THEN 'auto' ELSE COALESCE(t.source, 'manual') END AS source,
           CASE
             WHEN d.blocked THEN 'blocked'
             WHEN d.cooling AND d.queue_at >= TIMESTAMPTZ '2000-01-01' THEN 'cooling'
             WHEN de.task_id IS NOT NULL THEN 'dead_end'
             WHEN COALESCE(i.n, 0) >= 5 THEN 'saturated'
             WHEN d.task_type = 'question'
                  AND COALESCE(cq.answer_count, 0) + COALESCE(qa.n, 0) >= question_answer_cap() THEN 'question_full'
             ELSE 'ready'
           END AS status
      FROM task_dispatches d
      LEFT JOIN contribution_tasks t ON t.id::TEXT = d.task_id
      LEFT JOIN deadend de ON de.task_id = d.task_id
      LEFT JOIN inflight i ON i.task_id = d.task_id
      LEFT JOIN citizen_questions cq ON d.task_type = 'question' AND cq.id::TEXT = d.target->>'question_id'
      LEFT JOIN qa ON d.task_type = 'question' AND qa.qid = d.target->>'question_id'
     WHERE d.task_id NOT LIKE 'verify:%'
  ),
  ordered AS (
    SELECT row_number() OVER (ORDER BY q.queue_at, q.task_id)::INTEGER AS pos, q.*
      FROM q
     WHERE q.status NOT IN ('blocked', 'cooling')
  ),
  vq AS (
    SELECT v.contribution_type AS t,
           (v.score < COALESCE(v.target_score, contribution_effective_agree(v.id))
            OR (contribution_needs_two_ips(v.contribution_type, v.payload) AND v.voter_ips < 2)) AS ok
      FROM task_dispatches d
      JOIN contributions v ON d.task_id = 'verify:' || v.id AND v.status = 'pending'
     WHERE d.task_id LIKE 'verify:%'
  ),
  real AS (
    SELECT COALESCE(d.task_type, 'verify') AS task_type,
           CASE WHEN d.task_id LIKE 'verify:%' THEN 'verify' WHEN d.task_id LIKE 'auto:%' THEN 'auto' ELSE 'manual' END AS kind
      FROM task_dispatches d
     WHERE d.dispatch_count > 0 AND d.last_dispatched_at > now() - INTERVAL '24 hours'
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'by_type', (SELECT COALESCE(jsonb_agg(jsonb_build_object('task_type', x.task_type, 'source', x.source, 'status', x.status, 'n', x.n)
                                          ORDER BY x.task_type, x.source, x.status), '[]'::JSONB)
                  FROM (SELECT task_type, source, status, count(*) AS n FROM q GROUP BY 1, 2, 3) x),
    'verify', (SELECT jsonb_build_object(
                 'total', COALESCE(sum(x.n), 0),
                 'eligible', COALESCE(sum(x.e), 0),
                 'by_type', COALESCE(jsonb_agg(jsonb_build_object('contribution_type', x.t, 'n', x.n, 'eligible', x.e) ORDER BY x.n DESC, x.t), '[]'::JSONB))
                 FROM (SELECT t, count(*) AS n, count(*) FILTER (WHERE ok) AS e FROM vq GROUP BY t) x),
    'head', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'pos', o.pos, 'task_type', o.task_type, 'source', o.source, 'status', o.status,
                 'subject', COALESCE(NULLIF(o.target->>'name', ''), NULLIF(o.target->>'policy_title', ''), NULLIF(o.target->>'title', ''), ''),
                 'queue_at', o.queue_at, 'dispatch_count', o.dispatch_count, 'last_dispatched_at', o.last_dispatched_at) ORDER BY o.pos), '[]'::JSONB)
               FROM (SELECT * FROM ordered ORDER BY pos LIMIT 60) o),
    'first_ready_pos', (SELECT min(pos) FROM ordered WHERE status = 'ready'),
    'dispatched_24h', (SELECT COALESCE(jsonb_agg(jsonb_build_object('task_type', x.task_type, 'kind', x.kind, 'n', x.n) ORDER BY x.n DESC, x.task_type, x.kind), '[]'::JSONB)
                         FROM (SELECT task_type, kind, count(*) AS n FROM real GROUP BY 1, 2) x),
    'age_buckets', (SELECT jsonb_build_object(
                      'never', count(*) FILTER (WHERE dispatch_count = 0 OR last_dispatched_at IS NULL),
                      'lt_1h', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at >= now() - INTERVAL '1 hour'),
                      'h1_6', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at < now() - INTERVAL '1 hour' AND last_dispatched_at >= now() - INTERVAL '6 hours'),
                      'h6_24', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at < now() - INTERVAL '6 hours' AND last_dispatched_at >= now() - INTERVAL '24 hours'),
                      'd1_3', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at < now() - INTERVAL '24 hours' AND last_dispatched_at >= now() - INTERVAL '3 days'),
                      'gt_3d', count(*) FILTER (WHERE dispatch_count > 0 AND last_dispatched_at < now() - INTERVAL '3 days'))
                      FROM q WHERE status = 'ready')
  )
$$;
COMMENT ON FUNCTION console_queue_state IS '主控台派工隊列頁（唯讀）：非驗證列的狀態分布（blocked／cooling／dead_end／saturated／question_full／ready）、隊頭 60 列、驗證佇列、24 小時實際派出、可派列的距上次派出分桶。2026-10-17';

REVOKE ALL ON FUNCTION console_queue_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_queue_state() TO anon, authenticated, service_role;
