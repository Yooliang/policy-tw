-- /trace 重播頁的資料來源：trace_events()。不升協議版、不改 TS 端點。
--
-- 為什麼是函式、不是開表：派工真實流動散在八張表，其中交件（contributions）、投票（contribution_votes）、
-- 驗證票派出（verify_dispatches）、認領事件（lease_events）匿名讀不到（RLS 只開 service_role 或根本沒有 policy）。
-- 不開這些表，改用一支 SECURITY DEFINER 函式，只回「事件時間、種類、任務、交件、人物、顯示名、少量摘要」。
-- 不回投票與查核的備註原文（可能含人名或連結）、不回審核者原文（只分「自動」「人工」）。
-- 匿名可呼叫，所以函式自帶 3 秒 timeout（單次實測約 40～210 ms）。
-- 只回代理的顯示名（agent_name）；來源網段雜湊、憑證、序號、帳號識別一律不選、不進 detail。守門 _shared/trace-events.test.ts 守著。
--
-- 參數：
--   p_task_id           任務編號（auto:… 或手動任務 uuid 字串）；連同該任務底下的交件、投票、驗證票一起回
--   p_contribution_id   交件 id；連同它的任務、投票、驗證票一起回
--   p_politician_id     人物 id；該人名下的交件、缺口、網站請求一起回
--   p_since             起點，不得早於 now() - 14 天（函式內 GREATEST；驗證票與認領事件只保留 14 天）
--   p_limit             上限，最多 5000；超過取最近的
--   p_until             終點（不含），空＝不設；前端用它把時間切成小段分次取（PostgREST 單次最多回 1000 列）
--   三個對象參數都空 ＝ 全站（預設近 4 小時）
--
-- 事件種類（kind）：
--   gap_opened / gap_closed / gap_reopened   缺口出生／收回／重開（gap_events；detail.rekey_of＝換號前的舊編號）
--   lease_issued / lease_reported / lease_released / lease_expired   認領（lease_events，11-11 才開始有）
--   task_created / task_closed               手動任務建立／結案（detail.closed_reason）
--   request_merged                           網站請求併入缺口（web_request_coverage）
--   submitted / verified / applied / rejected   交件送出／驗證達標／落庫／退件（contributions）
--   verify_dispatched                        驗證票派給誰（verify_dispatches）
--   vote                                     一張投票（contribution_votes；detail.verdict）
--   check                                    查核（查無等）（task_checks；detail.outcome）
--
-- 引用到的既有物件：gap_events、lease_events（20261111120000）、contribution_tasks、web_request_coverage、
-- contributions、contribution_votes、verify_dispatches、task_checks、task_dispatches。


CREATE OR REPLACE FUNCTION trace_events(
  p_task_id         TEXT        DEFAULT NULL,
  p_contribution_id UUID        DEFAULT NULL,
  p_politician_id   UUID        DEFAULT NULL,
  p_since           TIMESTAMPTZ DEFAULT now() - interval '4 hours',
  p_limit           INT         DEFAULT 5000,
  p_until           TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE (
  at              TIMESTAMPTZ,
  kind            TEXT,
  task_id         TEXT,
  work_key        TEXT,
  contribution_id UUID,
  politician_id   UUID,
  agent_name      TEXT,
  detail          JSONB
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '3s' AS $$
#variable_conflict use_column
DECLARE
  v_since  TIMESTAMPTZ := GREATEST(coalesce(p_since, now() - interval '4 hours'), now() - interval '14 days');
  v_until  TIMESTAMPTZ := coalesce(p_until, 'infinity'::timestamptz);
  v_lim    INT := LEAST(GREATEST(coalesce(p_limit, 5000), 1), 5000);
  v_all    BOOLEAN := p_task_id IS NULL AND p_contribution_id IS NULL AND p_politician_id IS NULL;
  v_pid    TEXT := p_politician_id::text;
  v_tasks  TEXT[] := ARRAY[]::TEXT[];
  v_cids   UUID[] := ARRAY[]::UUID[];
BEGIN
  IF NOT v_all THEN
    IF p_task_id IS NOT NULL THEN
      v_tasks := v_tasks || p_task_id;
      v_cids := v_cids || coalesce((
        SELECT array_agg(c.id) FROM (
          SELECT c.id FROM contributions c
           WHERE c.task_id = p_task_id AND c.created_at >= now() - interval '14 days'
          UNION
          SELECT c.id FROM contributions c
           WHERE c.contribution_type = 'no_change' AND c.payload->>'task_id' = p_task_id
             AND c.created_at >= now() - interval '14 days'
          LIMIT 300
        ) c), ARRAY[]::UUID[]);
    END IF;
    IF p_contribution_id IS NOT NULL THEN
      v_cids := v_cids || p_contribution_id;
      v_tasks := v_tasks || coalesce((
        SELECT array_agg(DISTINCT coalesce(c.task_id, c.payload->>'task_id'))
          FROM contributions c WHERE c.id = p_contribution_id AND coalesce(c.task_id, c.payload->>'task_id') IS NOT NULL
      ), ARRAY[]::TEXT[]);
    END IF;
    IF p_politician_id IS NOT NULL THEN
      v_cids := v_cids || coalesce((
        SELECT array_agg(c.id) FROM (
          SELECT c.id FROM contributions c
           WHERE c.created_at >= now() - interval '14 days'
             AND (c.applied_politician_id = p_politician_id OR c.payload->>'politician_id' = v_pid)
           ORDER BY c.created_at DESC LIMIT 300
        ) c), ARRAY[]::UUID[]);
      v_tasks := v_tasks || coalesce((
        SELECT array_agg(DISTINCT t.tid) FROM (
          SELECT coalesce(c.task_id, c.payload->>'task_id') AS tid FROM contributions c WHERE c.id = ANY(v_cids)
          UNION
          SELECT g.task_id FROM gap_events g
           WHERE g.at >= now() - interval '14 days' AND g.task_id LIKE 'auto:%' AND position(v_pid in g.task_id) > 0
          UNION
          SELECT w.task_id::text FROM web_request_coverage w
           WHERE w.requested_at >= now() - interval '14 days' AND w.politician_id = v_pid
        ) t WHERE t.tid IS NOT NULL), ARRAY[]::TEXT[]);
    END IF;
  END IF;

  RETURN QUERY
  SELECT e.at, e.kind, e.task_id, e.work_key, e.contribution_id, e.politician_id, e.agent_name, e.detail
  FROM (
    -- 缺口出生／收回／重開
    (SELECT g.at AS at, 'gap_' || g.event AS kind, g.task_id AS task_id, d.work_key AS work_key, NULL::uuid AS contribution_id,
            NULL::uuid AS politician_id, NULL::text AS agent_name,
            jsonb_strip_nulls(jsonb_build_object('arm', g.task_type, 'reason', g.reason, 'rekey_of', g.detail->>'rekey_of',
                                                 'via', g.detail->>'via', 'contribution_id', g.detail->>'contribution_id')) AS detail
       FROM gap_events g LEFT JOIN task_dispatches d ON d.task_id = g.task_id
      WHERE g.at >= GREATEST(v_since, now() - interval '14 days') AND g.at < v_until AND (v_all OR g.task_id = ANY(v_tasks))
      ORDER BY g.at DESC LIMIT v_lim)
    UNION ALL
    -- 認領（lease_events 保留 14 天；回看 13 天＝保留天數減一天邊際，守門 lease-events.test.ts E2）
    (SELECT l.at, 'lease_' || l.event, l.task_id, NULL::text, NULL::uuid, NULL::uuid, l.agent_name,
            jsonb_strip_nulls(jsonb_build_object('by', l.meta->>'by', 'leased_until', l.meta->>'leased_until'))
       FROM lease_events l
      WHERE l.at >= GREATEST(v_since, now() - interval '13 days') AND l.at < v_until AND (v_all OR l.task_id = ANY(v_tasks))
      ORDER BY l.at DESC LIMIT v_lim)
    UNION ALL
    -- 手動任務建立
    (SELECT t.created_at, 'task_created', t.id::text, NULL::text, NULL::uuid, NULL::uuid, NULL::text,
            jsonb_strip_nulls(jsonb_build_object('task_type', t.task_type, 'source', t.source))
       FROM contribution_tasks t
      WHERE t.created_at >= GREATEST(v_since, now() - interval '14 days') AND t.created_at < v_until AND (v_all OR t.id::text = ANY(v_tasks))
      ORDER BY t.created_at DESC LIMIT v_lim)
    UNION ALL
    -- 手動任務結案
    (SELECT t.closed_at, 'task_closed', t.id::text, NULL::text, NULL::uuid, NULL::uuid, NULL::text,
            jsonb_strip_nulls(jsonb_build_object('task_type', t.task_type, 'closed_reason', t.closed_reason))
       FROM contribution_tasks t
      WHERE t.closed_at >= GREATEST(v_since, now() - interval '14 days') AND t.closed_at < v_until AND (v_all OR t.id::text = ANY(v_tasks))
      ORDER BY t.closed_at DESC LIMIT v_lim)
    UNION ALL
    -- 網站請求併入缺口
    (SELECT w.requested_at, 'request_merged', w.task_id::text, NULL::text, NULL::uuid,
            CASE WHEN w.politician_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN w.politician_id::uuid END,
            NULL::text,
            jsonb_strip_nulls(jsonb_build_object('gap_task_id', w.gap_task_id, 'gap_arm', w.gap_arm))
       FROM web_request_coverage w
      WHERE w.requested_at >= GREATEST(v_since, now() - interval '14 days') AND w.requested_at < v_until
        AND (v_all OR w.task_id::text = ANY(v_tasks) OR w.gap_task_id = ANY(v_tasks) OR w.politician_id = v_pid)
      ORDER BY w.requested_at DESC LIMIT v_lim)
    UNION ALL
    -- 交件送出
    (SELECT c.created_at, 'submitted', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id,
            coalesce(c.applied_politician_id, CASE WHEN c.payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (c.payload->>'politician_id')::uuid END),
            c.agent_name,
            jsonb_build_object('type', c.contribution_type, 'status', c.status)
       FROM contributions c
      WHERE c.created_at >= GREATEST(v_since, now() - interval '14 days') AND c.created_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY c.created_at DESC LIMIT v_lim)
    UNION ALL
    -- 驗證達標
    (SELECT c.verified_at, 'verified', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id, c.applied_politician_id, NULL::text,
            jsonb_build_object('type', c.contribution_type, 'agree', c.agree_count, 'disagree', c.disagree_count, 'unsure', c.unsure_count)
       FROM contributions c
      WHERE c.verified_at >= GREATEST(v_since, now() - interval '14 days') AND c.verified_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY c.verified_at DESC LIMIT v_lim)
    UNION ALL
    -- 落庫
    (SELECT c.applied_at, 'applied', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id, c.applied_politician_id, NULL::text,
            jsonb_strip_nulls(jsonb_build_object('type', c.contribution_type, 'reviewed_by', CASE WHEN c.reviewed_by IS NULL THEN NULL WHEN c.reviewed_by ~ '^(auto-|system:|cec-|soumu-|estat-|consensus|strong-adjudication$|adjudication$)|-auto$' THEN '自動' ELSE '人工' END))
       FROM contributions c
      WHERE c.applied_at >= GREATEST(v_since, now() - interval '14 days') AND c.applied_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY c.applied_at DESC LIMIT v_lim)
    UNION ALL
    -- 退件
    (SELECT c.reviewed_at, 'rejected', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id, c.applied_politician_id, NULL::text,
            jsonb_strip_nulls(jsonb_build_object('type', c.contribution_type, 'reviewed_by', CASE WHEN c.reviewed_by IS NULL THEN NULL WHEN c.reviewed_by ~ '^(auto-|system:|cec-|soumu-|estat-|consensus|strong-adjudication$|adjudication$)|-auto$' THEN '自動' ELSE '人工' END))
       FROM contributions c
      WHERE c.status = 'rejected' AND c.reviewed_at >= GREATEST(v_since, now() - interval '14 days') AND c.reviewed_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY c.reviewed_at DESC LIMIT v_lim)
    UNION ALL
    -- 驗證票派給誰（verify_dispatches 保留 14 天，但清理守門要求回看期 ≤ 派工綁定的 7 天加邊際，所以只看近 7 天）
    (SELECT vd.dispatched_at, 'verify_dispatched', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, vd.contribution_id, NULL::uuid, vd.agent_name,
            jsonb_build_object('type', c.contribution_type)
       FROM verify_dispatches vd JOIN contributions c ON c.id = vd.contribution_id
      WHERE vd.dispatched_at >= GREATEST(v_since, now() - interval '7 days') AND vd.dispatched_at < v_until AND (v_all OR vd.contribution_id = ANY(v_cids))
      ORDER BY vd.dispatched_at DESC LIMIT v_lim)
    UNION ALL
    -- 一張投票
    (SELECT v.created_at, 'vote', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, v.contribution_id, NULL::uuid, v.agent_name,
            jsonb_strip_nulls(jsonb_build_object('verdict', v.verdict, 'weight', v.weight, 'type', c.contribution_type,
                                                 'evidence_url', v.evidence_url))
       FROM contribution_votes v JOIN contributions c ON c.id = v.contribution_id
      WHERE v.created_at >= GREATEST(v_since, now() - interval '14 days') AND v.created_at < v_until AND (v_all OR v.contribution_id = ANY(v_cids))
      ORDER BY v.created_at DESC LIMIT v_lim)
    UNION ALL
    -- 查核（查無等）
    (SELECT k.checked_at, 'check', k.task_id, k.work_key, k.contribution_id, NULL::uuid, k.agent_name,
            jsonb_strip_nulls(jsonb_build_object('outcome', k.outcome))
       FROM task_checks k
      WHERE k.checked_at >= GREATEST(v_since, now() - interval '14 days') AND k.checked_at < v_until AND (v_all OR k.task_id = ANY(v_tasks))
      ORDER BY k.checked_at DESC LIMIT v_lim)
  ) e
  WHERE e.at IS NOT NULL
  ORDER BY e.at DESC
  LIMIT v_lim;
END;
$$;

COMMENT ON FUNCTION trace_events(TEXT, UUID, UUID, TIMESTAMPTZ, INT, TIMESTAMPTZ) IS
  '/trace 重播頁的事件來源（2026-11-11）。SECURITY DEFINER，只回事件時間、種類、任務、交件、人物、代理顯示名與少量摘要；回看期最多 14 天、最多 5000 筆。守門 _shared/trace-events.test.ts';

REVOKE ALL ON FUNCTION trace_events(TEXT, UUID, UUID, TIMESTAMPTZ, INT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trace_events(TEXT, UUID, UUID, TIMESTAMPTZ, INT, TIMESTAMPTZ) TO anon, authenticated, service_role;
