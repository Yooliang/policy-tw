-- /trace 讀取在線上被 statement timeout 砍掉（單段 3～4 秒）：修函式效能。不升協議版、不改回傳內容。
--
-- 原因（正式庫以 SET ROLE anon 逐分支實測，前後數字在 PR 說明）：
--   jev_decisions／contribution_tasks／contributions 的對應條件寫成「c.id::text = j.subject_id」這種把 uuid 欄位轉成文字再比的形式，
--   索引用不上，contributions 整表（約 1.1 萬頁）被掃一遍；單一分支就要 1.3 秒，其餘分支各 < 60 ms 加起來才 3～4 秒。
-- 修法：
--   1. trace_uuid(text)：文字轉 uuid，不是 uuid 格式回 NULL（IMMUTABLE，格式不對不會讓整支失敗）；對應條件改成「c.id = trace_uuid(…)」，走 contributions 主鍵。
--   2. 函式 statement_timeout 3s → 8s（保險）；plan_cache_mode = force_custom_plan：plpgsql 同一連線跑到第 6 次會改用通用計畫，
--      通用計畫看不到 p_since／p_until 的實際值、時間條件挑不到索引（PostgREST 連線池會重用連線）；每次都按實際參數重新規劃，規劃只要不到 1 ms。
--   3. verify_dispatches 加 dispatched_at 單欄索引：回看 7 天的時間範圍掃描原本只有 (contribution_id, dispatched_at) 與按來源查的索引，共兩個。
--      這張表有清理排程（保留 14 天），列數不大；一般 CREATE INDEX 會在建立期間擋寫入（秒級），派工寫入端容許。
-- 其餘與 20261111200000 相同（CREATE OR REPLACE 整支）。

CREATE OR REPLACE FUNCTION trace_uuid(p_text TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::uuid END
$$;
REVOKE ALL ON FUNCTION trace_uuid(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trace_uuid(TEXT) TO anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS verify_dispatches_at_idx ON verify_dispatches (dispatched_at);

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
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '8s' SET plan_cache_mode = force_custom_plan AS $$
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
       FROM jev_decisions j JOIN contributions c ON c.id = trace_uuid(j.subject_id)
      WHERE j.subject_type = 'contribution' AND j.question = 'source_support'
        AND j.asked_at >= GREATEST(v_since, now() - interval '14 days') AND j.asked_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY j.asked_at DESC LIMIT v_lim)
    UNION ALL
    -- Jev 的其他系統判定（追問、新人物、第二來源、釐清分類）：只回問題與選項
    (SELECT j.asked_at, 'system_check', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id, c.applied_politician_id, 'Jev',
            jsonb_build_object('question', j.question, 'choice', j.choice, 'type', c.contribution_type)
       FROM jev_decisions j JOIN contributions c ON c.id = trace_uuid(j.subject_id)
      WHERE j.subject_type = 'contribution' AND j.question IN ('followup', 'new_person', 'second_source', 'clarify_kind')
        AND j.asked_at >= GREATEST(v_since, now() - interval '14 days') AND j.asked_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY j.asked_at DESC LIMIT v_lim)
    UNION ALL
    -- 轉裁決（爭議）：交件被轉成 disputed 的時間。優先用裁決任務的建立時間（投太多輪停派、超過 3 天沒結果、系統開的強模型任務都會開一件 adjudicate 任務）；
    -- 還沒開任務、而且狀態還停在 disputed 的，用狀態變更時間（觸發器維護的 last_activity_at，last_activity='status:disputed'）
    (SELECT t.created_at, 'disputed', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id, c.applied_politician_id, NULL::text,
            jsonb_strip_nulls(jsonb_build_object('type', c.contribution_type, 'overvoted', t.target->>'reason' = '投太多輪',
                                                 'strong', t.target->>'requires_tier' = 'strong'))
       FROM contribution_tasks t JOIN contributions c ON c.id = trace_uuid(t.target->>'contribution_id')
      WHERE t.task_type = 'adjudicate' AND t.created_at >= GREATEST(v_since, now() - interval '14 days') AND t.created_at < v_until AND (v_all OR c.id = ANY(v_cids))
      ORDER BY t.created_at DESC LIMIT v_lim)
    UNION ALL
    (SELECT c.last_activity_at, 'disputed', coalesce(c.task_id, c.payload->>'task_id'), NULL::text, c.id, c.applied_politician_id, NULL::text,
            jsonb_build_object('type', c.contribution_type)
       FROM contributions c
      WHERE c.status = 'disputed' AND c.last_activity = 'status:disputed' AND c.contribution_type <> 'adjudication'
        AND c.last_activity_at >= GREATEST(v_since, now() - interval '14 days') AND c.last_activity_at < v_until AND (v_all OR c.id = ANY(v_cids))
        AND NOT EXISTS (SELECT 1 FROM contribution_tasks t2 WHERE t2.task_type = 'adjudicate' AND t2.target->>'contribution_id' = c.id::text)
      ORDER BY c.last_activity_at DESC LIMIT v_lim)
    UNION ALL
    -- 強模型專線認領：強模型任務（requires_tier=strong）被持鑰匙者領走。顯示名來自租約
    (SELECT l.at, 'strong_claim', l.task_id, NULL::text, c.id, c.applied_politician_id, l.agent_name,
            jsonb_strip_nulls(jsonb_build_object('type', c.contribution_type))
       FROM lease_events l JOIN contribution_tasks st ON st.id = trace_uuid(l.task_id) AND st.target->>'requires_tier' = 'strong'
            LEFT JOIN contributions c ON c.id = trace_uuid(st.target->>'contribution_id')
      WHERE l.event = 'issued' AND l.at >= GREATEST(v_since, now() - interval '13 days') AND l.at < v_until AND (v_all OR c.id = ANY(v_cids) OR l.task_id = ANY(v_tasks))
      ORDER BY l.at DESC LIMIT v_lim)
    UNION ALL
    -- 強模型定案（一）：強模型的裁決交件（reviewed_by='strong-adjudication'）
    (SELECT a.created_at, 'strong_finalized', coalesce(a.task_id, a.payload->>'task_id'), NULL::text, o.id, o.applied_politician_id, NULL::text,
            jsonb_strip_nulls(jsonb_build_object('verdict', a.payload->>'verdict', 'type', o.contribution_type))
       FROM contributions a LEFT JOIN contributions o ON o.id = trace_uuid(a.payload->>'contribution_id')
      WHERE a.contribution_type = 'adjudication' AND a.reviewed_by = 'strong-adjudication'
        AND a.created_at >= GREATEST(v_since, now() - interval '14 days') AND a.created_at < v_until AND (v_all OR a.id = ANY(v_cids) OR o.id = ANY(v_cids))
      ORDER BY a.created_at DESC LIMIT v_lim)
    UNION ALL
    -- 強模型定案（二）：強模型裁決表的 finalized，同一件原交件在前後 30 分鐘內已有上面那種裁決交件的不重複算
    (SELECT s.finalized_at, 'strong_finalized', s.task_id, NULL::text, o.id, o.applied_politician_id, NULL::text,
            jsonb_strip_nulls(jsonb_build_object('verdict', s.verdict, 'type', o.contribution_type))
       FROM strong_adjudications s LEFT JOIN contributions o ON o.id = trace_uuid(s.contribution_id)
      WHERE s.status = 'finalized' AND s.finalized_at >= GREATEST(v_since, now() - interval '14 days') AND s.finalized_at < v_until AND (v_all OR o.id = ANY(v_cids) OR s.task_id = ANY(v_tasks))
        AND NOT EXISTS (SELECT 1 FROM contributions a2 WHERE a2.contribution_type = 'adjudication' AND a2.reviewed_by = 'strong-adjudication'
                           AND a2.payload->>'contribution_id' = s.contribution_id AND abs(extract(epoch FROM a2.created_at - s.finalized_at)) < 1800)
      ORDER BY s.finalized_at DESC LIMIT v_lim)
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
  '/trace 重播頁的事件來源（2026-11-11；160000 起多 Jev 系統票與系統判定、200000 起多爭議與強模型事件、210000 起改用不繞過索引的寫法）。SECURITY DEFINER，只回事件時間、種類、任務、交件、人物、代理顯示名與少量摘要；回看期最多 14 天、最多 5000 筆。守門 _shared/trace-events.test.ts';

REVOKE ALL ON FUNCTION trace_events(TEXT, UUID, UUID, TIMESTAMPTZ, INT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trace_events(TEXT, UUID, UUID, TIMESTAMPTZ, INT, TIMESTAMPTZ) TO anon, authenticated, service_role;
