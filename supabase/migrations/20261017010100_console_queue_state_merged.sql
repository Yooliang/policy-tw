-- 主控台「派工隊列」頁的資料：隊頭改成任務與驗證票合成一條、另列停放中的任務（2026-10-17，policy-ops docs/work/2026-10-17-派工隊頭堵塞.md 第二步第 6 項）
-- ============================================================
--
-- 接 20261017010000（驗證票的排序跟著任務、任務有交件在途就停放）。唯讀，只換 console_queue_state() 的定義；簽名、權限、回傳 JSON 的既有欄位一字不動，只新增：
--   * head 每列多 kind（'task'｜'verify'）；head 改成任務與「可派的驗證票」照 /next 實際順序合成一條（queue_at，同一刻驗證票先、其次任務、再 task_id），最多 60 列。
--     驗證票那一列：task_type＝交件型別（contribution_type）、source＝'verify'、status＝'ready'、subject＝人物名或政見標題。
--     first_ready_pos 因此是合成順序裡第一個 ready 的名次（原本只算任務）。
--   * by_type 多一種狀態 parked（停放中）：任務底下有在途交件（pending／verified／disputed，經 task_id 欄或 payload.task_id），不停放的三型（question、adjudicate、
--     roster_check）除外——與 contribution_queue_tasks 的「合格：任務停放」同一條件。狀態先符合先贏，parked 排在 dead_end 前面（有查無回報在等票的任務同時也是停放中，
--     所以 dead_end／saturated 現在只剩不停放的三型）。停放中的列不進 head。
--   * parked：停放中的任務前 60 名（task_id、task_type、source、subject、queue_at、inflight＝在途交件數、verify_waiting＝等票中的交件數，也就是它在等幾張驗證票）；parked_total 是全部筆數。
-- 其餘（by_type 的其他狀態、verify、dispatched_24h、age_buckets）不變。台灣站專用。

CREATE OR REPLACE FUNCTION console_queue_state() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH inflight AS (
    SELECT c.task_id, count(*) AS n
      FROM contributions c
     WHERE c.status IN ('pending', 'verified', 'disputed')
     GROUP BY c.task_id
  ),
  -- 停放：任務編號看 task_id 欄，欄是空的看 payload.task_id（同 contribution_queue_tasks 的「合格：任務停放」）
  parkable AS (
    SELECT COALESCE(c.task_id, c.payload->>'task_id') AS task_id, count(*) AS n, count(*) FILTER (WHERE c.status = 'pending') AS waiting
      FROM contributions c
     WHERE c.status IN ('pending', 'verified', 'disputed')
     GROUP BY 1
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
           COALESCE(pk.n, 0) AS inflight_n, COALESCE(pk.waiting, 0) AS waiting_n,
           CASE
             WHEN d.blocked THEN 'blocked'
             WHEN d.cooling AND d.queue_at >= TIMESTAMPTZ '2000-01-01' THEN 'cooling'
             WHEN COALESCE(pk.n, 0) > 0 AND d.task_type NOT IN ('question', 'adjudicate', 'roster_check') THEN 'parked'
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
      LEFT JOIN parkable pk ON pk.task_id = d.task_id
      LEFT JOIN citizen_questions cq ON d.task_type = 'question' AND cq.id::TEXT = d.target->>'question_id'
      LEFT JOIN qa ON d.task_type = 'question' AND qa.qid = d.target->>'question_id'
     WHERE d.task_id NOT LIKE 'verify:%'
  ),
  -- 驗證票：等票中的貢獻；可派＝分數還沒到目標（或兩台機器的型別還差一台），同 contribution_verify_pool 不看呼叫者的那幾條
  vt AS (
    SELECT d.task_id, d.queue_at, d.dispatch_count, d.last_dispatched_at, v.contribution_type, v.payload,
           (v.score < COALESCE(v.target_score, d.verify_target, contribution_effective_agree(v.id))
            OR (contribution_needs_two_ips(v.contribution_type, v.payload) AND v.voter_ips < 2)) AS ok
      FROM task_dispatches d
      JOIN contributions v ON d.task_id = 'verify:' || v.id AND v.status = 'pending'
     WHERE d.task_id LIKE 'verify:%'
  ),
  -- /next 實際順序：queue_at，同一刻驗證票先、任務次之（HEAD_ORDER），再 task_id
  ordered AS (
    SELECT row_number() OVER (ORDER BY m.queue_at, m.tie, m.task_id)::INTEGER AS pos, m.*
      FROM (SELECT 'task'::TEXT AS kind, o.task_id, o.task_type, o.source, o.status, o.target, NULL::JSONB AS payload,
                   o.queue_at, o.dispatch_count, o.last_dispatched_at, 1 AS tie
              FROM q o WHERE o.status NOT IN ('blocked', 'cooling', 'parked')
            UNION ALL
            SELECT 'verify', v.task_id, v.contribution_type, 'verify', 'ready', NULL::JSONB, v.payload,
                   v.queue_at, v.dispatch_count, v.last_dispatched_at, 0
              FROM vt v WHERE v.ok) m
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
                 FROM (SELECT contribution_type AS t, count(*) AS n, count(*) FILTER (WHERE ok) AS e FROM vt GROUP BY 1) x),
    'head', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'pos', o.pos, 'kind', o.kind, 'task_type', o.task_type, 'source', o.source, 'status', o.status,
                 'subject', CASE WHEN o.kind = 'verify'
                                 THEN COALESCE(NULLIF(o.payload->>'name', ''),
                                               (SELECT p.name FROM politicians p WHERE p.id = contribution_subject_politician(o.payload)),
                                               (SELECT pl.title FROM policies pl WHERE pl.id = uuid_or_null(o.payload->>'policy_id')),
                                               NULLIF(o.payload->>'title', ''), '')
                                 ELSE COALESCE(NULLIF(o.target->>'name', ''), NULLIF(o.target->>'policy_title', ''), NULLIF(o.target->>'title', ''), '') END,
                 'queue_at', o.queue_at, 'dispatch_count', o.dispatch_count, 'last_dispatched_at', o.last_dispatched_at) ORDER BY o.pos), '[]'::JSONB)
               FROM (SELECT * FROM ordered ORDER BY pos LIMIT 60) o),
    'first_ready_pos', (SELECT min(pos) FROM ordered WHERE status = 'ready'),
    'parked_total', (SELECT count(*) FROM q WHERE status = 'parked'),
    'parked', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'task_id', p.task_id, 'task_type', p.task_type, 'source', p.source,
                 'subject', COALESCE(NULLIF(p.target->>'name', ''), NULLIF(p.target->>'policy_title', ''), NULLIF(p.target->>'title', ''), ''),
                 'queue_at', p.queue_at, 'inflight', p.inflight_n, 'verify_waiting', p.waiting_n) ORDER BY p.queue_at, p.task_id), '[]'::JSONB)
               FROM (SELECT * FROM q WHERE status = 'parked' ORDER BY queue_at, task_id LIMIT 60) p),
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
COMMENT ON FUNCTION console_queue_state IS '主控台派工隊列頁（唯讀）：非驗證列的狀態分布（blocked／cooling／parked／dead_end／saturated／question_full／ready）、隊頭 60 列（任務與可派的驗證票照 /next 順序合成，每列 kind）、停放中的任務與各等幾張驗證票、驗證佇列、24 小時實際派出、可派列的距上次派出分桶。2026-10-17';

REVOKE ALL ON FUNCTION console_queue_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_queue_state() TO anon, authenticated, service_role;
