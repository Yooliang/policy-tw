-- 主控台派工時間軸：日常與當屆選舉拆開（日本站那半，policy-ops #69，2026-10-10）
-- ============================================================
--
-- 正見那半是 20261010140000_console_timeline_per_election.sql，說明看那支；這支是 policy_jp 同形的一套，只動 policy_jp 的物件。
-- 跟正見不同的地方：
--   * 選舉 id 是文字；console_dispatch_election 依序看 target 的 election_id、politician_election_id、politician_election_ids 的第一筆。
--   * 一場選舉一個職位：各職位件數（by_type）的職位就是 target.election_type，沒有就是那場選舉的 election_type。
--   * 沒有任期里程碑：2 參選期 → 告示日（announced，沒有就投票日）、3 → 投票日、4 開票 → 投票日 +30、其他段不會過段（NULL）。
-- 登記在 policy-jp-dispatch-drift.test.ts 的 JP_ONLY（正見沒有對應的被抄函式）。

CREATE OR REPLACE FUNCTION policy_jp.console_dispatch_election(p_target JSONB) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  SELECT COALESCE(
    (SELECT e.id FROM policy_jp.elections e WHERE e.id = p_target->>'election_id'),
    (SELECT pe.election_id FROM policy_jp.politician_elections pe WHERE pe.id = p_target->>'politician_election_id'),
    (SELECT pe.election_id FROM policy_jp.politician_elections pe
      WHERE jsonb_typeof(p_target->'politician_election_ids') = 'array' AND pe.id = p_target->'politician_election_ids'->>0)
  )
$$;
COMMENT ON FUNCTION policy_jp.console_dispatch_election IS
  '主控台用：一筆派工列（target）屬於哪一場選舉；election_id → politician_election_id → politician_election_ids[0]，都沒有＝NULL（日常）。只給主控台算件數。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION policy_jp.console_dispatch_election(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.console_dispatch_election(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION policy_jp.console_arm_election_counts()
RETURNS TABLE (arm TEXT, election_id TEXT, election_type TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  SELECT x.arm, x.eid,
         CASE WHEN x.eid IS NULL THEN NULL
              ELSE COALESCE(NULLIF(x.target->>'election_type', ''), (SELECT e.election_type FROM policy_jp.elections e WHERE e.id = x.eid)) END,
         count(*)
    FROM (SELECT d.opened_by->>'arm' AS arm, policy_jp.console_dispatch_election(d.target) AS eid, d.target
            FROM policy_jp.task_dispatches d
           WHERE d.task_id LIKE 'auto:%' AND d.opened_by ? 'arm') x
   GROUP BY 1, 2, 3
  UNION ALL
  SELECT 'manual_visitor', NULL::TEXT, NULL::TEXT, count(*)
    FROM policy_jp.task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM policy_jp.contribution_auto_tasks_manual(true) m)
  UNION ALL
  SELECT 'manual_open', NULL::TEXT, NULL::TEXT, count(*)
    FROM policy_jp.task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM policy_jp.contribution_auto_tasks_manual(false) m)
$$;
COMMENT ON FUNCTION policy_jp.console_arm_election_counts IS
  '主控台用：每支派工臂 × 每場選舉 × 職位的佇列件數（election_id 空＝日常）。手動兩臂算日常。公開唯讀。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION policy_jp.console_arm_election_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION policy_jp.console_arm_election_counts() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION policy_jp.console_stage_end(p_election_id TEXT, p_stage SMALLINT) RETURNS DATE
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH m AS (SELECT m.kind, max(m.on_date) AS d FROM policy_jp.election_milestones_all m WHERE m.election_id = p_election_id GROUP BY m.kind),
  e AS (SELECT e.election_date AS d FROM policy_jp.elections e WHERE e.id = p_election_id)
  SELECT CASE p_stage
    WHEN 2 THEN COALESCE((SELECT d FROM m WHERE kind = 'announced'), (SELECT d FROM m WHERE kind = 'polling'), (SELECT d FROM e))
    WHEN 3 THEN COALESCE((SELECT d FROM m WHERE kind = 'polling'), (SELECT d FROM e))
    WHEN 4 THEN COALESCE((SELECT d FROM m WHERE kind = 'polling'), (SELECT d FROM e)) + 30
    ELSE NULL END
$$;
COMMENT ON FUNCTION policy_jp.console_stage_end IS
  '主控台用：某場選舉的某一段在哪一天結束。2→告示日（沒有就投票日）、3→投票日、4→投票日 +30、其他→NULL（日本站沒有任期里程碑）。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION policy_jp.console_stage_end(TEXT, SMALLINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION policy_jp.console_stage_end(TEXT, SMALLINT) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION policy_jp.console_timeline(p_election_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_el policy_jp.elections%ROWTYPE;
  v_today DATE := policy_jp.activity_today();
  v_counts JSONB;
  v_types JSONB;
BEGIN
  SELECT * INTO v_el FROM policy_jp.elections e WHERE e.id = p_election_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 臂 → {e: 這一屆的件數, d: 日常的件數}；一次掃描
  SELECT COALESCE(jsonb_object_agg(c.arm, jsonb_build_object('e', c.e, 'd', c.d)), '{}'::JSONB) INTO v_counts
    FROM (SELECT x.arm, sum(x.n) FILTER (WHERE x.election_id = v_el.id) AS e, sum(x.n) FILTER (WHERE x.election_id IS NULL) AS d
            FROM policy_jp.console_arm_election_counts() x GROUP BY x.arm) c;
  -- 臂 → {職位: 這一屆的件數}
  SELECT COALESCE(jsonb_object_agg(c.arm, c.t), '{}'::JSONB) INTO v_types
    FROM (SELECT x.arm, jsonb_object_agg(COALESCE(x.election_type, ''), x.n) AS t
            FROM (SELECT y.arm, y.election_type, sum(y.n) AS n FROM policy_jp.console_arm_election_counts() y
                   WHERE y.election_id = v_el.id GROUP BY 1, 2) x GROUP BY x.arm) c;

  RETURN jsonb_build_object(
    'today', v_today,
    'election', jsonb_build_object('id', v_el.id, 'date', v_el.election_date, 'reason', v_el.election_reason,
                                   'types', jsonb_build_array(v_el.election_type), 'name', v_el.name),
    'election_total', COALESCE((SELECT sum((v.value->>'e')::BIGINT) FROM jsonb_each(v_counts) v), 0),
    'daily_total', COALESCE((SELECT sum((v.value->>'d')::BIGINT) FROM jsonb_each(v_counts) v), 0),
    'milestones', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind', m.kind, 'election_type', m.election_type, 'on_date', m.on_date, 'status', m.status)
                       ORDER BY m.on_date, m.kind, m.election_type)
        FROM policy_jp.election_milestones_all m WHERE m.election_id = v_el.id
    ), '[]'::JSONB),
    'arms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'arm', s.arm, 'stage', s.stage, 'stage_source', s.stage_source,
               'is_open', EXISTS (SELECT 1 FROM policy_jp.activity_open(s.arm, v_el.id, NULL))
                          OR EXISTS (SELECT 1 FROM policy_jp.activity_open(s.arm, v_el.id, v_el.election_type)),
               'overridden', EXISTS (
                 SELECT 1 FROM policy_jp.activity_overrides o
                  WHERE o.activity = s.arm AND (o.election_id IS NULL OR o.election_id = v_el.id)
                    AND (o.expires_at IS NULL OR o.expires_at >= v_today)
                    AND (o."force" <> 'window' OR o.open_until IS NULL OR o.open_until >= v_today)),
               'via', st.via, 'queue_count', st.queue_count,
               'election_count', COALESCE((v_counts->s.arm->>'e')::BIGINT, 0),
               'daily_count', COALESCE((v_counts->s.arm->>'d')::BIGINT, 0),
               'stage_end', se.d,
               'stale', COALESCE((v_counts->s.arm->>'e')::BIGINT, 0) > 0 AND se.d IS NOT NULL AND se.d < v_today,
               'by_type', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'election_type', NULLIF(ty.t, ''),
                          'n', COALESCE((v_types->s.arm->>ty.t)::BIGINT, 0),
                          'is_open', EXISTS (SELECT 1 FROM policy_jp.activity_open(s.arm, v_el.id, NULLIF(ty.t, ''))),
                          'overridden', EXISTS (
                            SELECT 1 FROM policy_jp.activity_overrides o
                             WHERE o.activity = s.arm AND (o.election_id IS NULL OR o.election_id = v_el.id)
                               AND (o.election_type IS NULL OR o.election_type = NULLIF(ty.t, ''))
                               AND (o.expires_at IS NULL OR o.expires_at >= v_today)
                               AND (o."force" <> 'window' OR o.open_until IS NULL OR o.open_until >= v_today)))
                          ORDER BY (NULLIF(ty.t, '') = v_el.election_type) DESC NULLS LAST, ty.t)
                   FROM (SELECT v_el.election_type AS t
                          UNION SELECT k FROM jsonb_object_keys(COALESCE(v_types->s.arm, '{}'::JSONB)) k) ty
               ), '[]'::JSONB),
               'windows', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'rule_id', r.id, 'window_kind', r.window_kind, 'election_types', to_jsonb(r.election_types),
                          'from_kind', r.from_kind, 'until_kind', r.until_kind,
                          'from', CASE WHEN r.window_kind = 'always' THEN NULL ELSE f.d + r.from_offset END,
                          'until', CASE WHEN r.window_kind = 'always' THEN NULL ELSE u.d + r.until_offset END,
                          'missing_milestone', r.window_kind <> 'always'
                            AND ((r.from_kind IS NOT NULL AND f.d IS NULL) OR (r.until_kind IS NOT NULL AND u.d IS NULL)))
                          ORDER BY r.id)
                   FROM policy_jp.activity_rules r
                   LEFT JOIN LATERAL (
                     SELECT min(m.on_date) AS d FROM policy_jp.election_milestones_all m
                      WHERE m.election_id = v_el.id AND m.kind = r.from_kind
                   ) f ON true
                   LEFT JOIN LATERAL (
                     SELECT max(m.on_date) AS d FROM policy_jp.election_milestones_all m
                      WHERE m.election_id = v_el.id AND m.kind = r.until_kind
                   ) u ON true
                  WHERE r.enabled AND r.activity = s.arm
                    AND (r.reasons IS NULL OR v_el.election_reason = ANY (r.reasons))
                    AND (r.election_types IS NULL OR v_el.election_type = ANY (r.election_types))
               ), '[]'::JSONB))
             ORDER BY s.stage, s.arm)
        FROM policy_jp.console_arm_stages() s
        LEFT JOIN policy_jp.console_arm_status() st ON st.arm = s.arm
        LEFT JOIN LATERAL (SELECT policy_jp.console_stage_end(v_el.id, s.stage) AS d) se ON true
    ), '[]'::JSONB)
  );
END
$$;
COMMENT ON FUNCTION policy_jp.console_timeline IS
  '主控台時間軸（日本站）：一場選舉的今天、里程碑、每支臂的段／開關／覆寫／佇列件數（全站 queue_count、這一屆 election_count、日常 daily_count）、'
  '段的結束日 stage_end、過段仍在派 stale、每條規則的開放區間。找不到選舉回 NULL。公開唯讀。2026-10-10（policy-ops #63、#69）';
REVOKE ALL ON FUNCTION policy_jp.console_timeline(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION policy_jp.console_timeline(TEXT) TO anon, authenticated, service_role;
