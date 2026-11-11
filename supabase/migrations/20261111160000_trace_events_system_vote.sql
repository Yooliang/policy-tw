-- /trace 的系統票：trace_events() 多兩種事件，來源是 jev_decisions（不是投票表）。不升協議版、不改 TS 端點。
--
-- 系統票（Jev 判來源撐不撐得住這件交件）不記在 contribution_votes，而是 jev_decisions 的 question='source_support'
-- （choice：supported／not_supported／cannot_tell；state->>'supported_sources'＝核得過的獨立來源數，由
-- contribution_effective_agree 拿來降目標，見 20261009320000_independent_sources_target.sql）。
--   system_vote   source_support 的判定（agent_name 固定 'Jev'；detail：choice、supported_sources、type）
--   system_check  追問、新人物、第二來源、釐清分類的判定（detail：question、choice、type）
-- 只回選項與來源數，不回 state 的其他內容、模型名稱、費用、機率。時限用 asked_at，14 天下限，各自 LIMIT。
-- 名冊逐位核對、結果整批補、改掛、號次重複等系統票是用系統身分投在投票表的，已在原本的 vote 事件裡。
--
-- 其餘與 20261111140000 的版本相同（CREATE OR REPLACE 整支）。
-- 引用到的既有物件：jev_decisions(subject_type, subject_id, question, choice, state, asked_at)、contributions 與其他在 20261111140000 列出的表。

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
    -- Jev 系統票：來源是否撐得住這件交件（jev_decisions，不在投票表；contribution_effective_agree 拿它降目標）。只回選項與核得過的來源數
    (SELECT j.asked_at, 'system_vote', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id, c.applied_politician_id, 'Jev',
            jsonb_strip_nulls(jsonb_build_object('choice', j.choice,
              'supported_sources', CASE WHEN jsonb_typeof(j.state->'supported_sources') = 'number' THEN j.state->'supported_sources' END,
              'type', c.contribution_type))
       FROM jev_decisions j JOIN contributions c ON c.id::text = j.subject_id
      WHERE j.subject_type = 'contribution' AND j.question = 'source_support'
        AND j.asked_at >= GREATEST(v_since, now() - interval '14 days') AND j.asked_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY j.asked_at DESC LIMIT v_lim)
    UNION ALL
    -- Jev 的其他系統判定（追問、新人物、第二來源、釐清分類）：只回問題與選項
    (SELECT j.asked_at, 'system_check', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id, c.applied_politician_id, 'Jev',
            jsonb_build_object('question', j.question, 'choice', j.choice, 'type', c.contribution_type)
       FROM jev_decisions j JOIN contributions c ON c.id::text = j.subject_id
      WHERE j.subject_type = 'contribution' AND j.question IN ('followup', 'new_person', 'second_source', 'clarify_kind')
        AND j.asked_at >= GREATEST(v_since, now() - interval '14 days') AND j.asked_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY j.asked_at DESC LIMIT v_lim)
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
  '/trace 重播頁的事件來源（2026-11-11；160000 起多 Jev 系統票與系統判定）。SECURITY DEFINER，只回事件時間、種類、任務、交件、人物、代理顯示名與少量摘要；回看期最多 14 天、最多 5000 筆。守門 _shared/trace-events.test.ts';

REVOKE ALL ON FUNCTION trace_events(TEXT, UUID, UUID, TIMESTAMPTZ, INT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trace_events(TEXT, UUID, UUID, TIMESTAMPTZ, INT, TIMESTAMPTZ) TO anon, authenticated, service_role;
