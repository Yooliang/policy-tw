-- 主控台派工時間軸件數改成一次集合查詢（日本站那半，policy-ops #69，2026-10-10）
-- ============================================================
--
-- 正見那半是 20261010200000_console_timeline_fix.sql，原因看那支（#569 上線後 console_arm_status 401、console_timeline 500：
-- 逐列呼叫 SECURITY DEFINER 函式，正式庫 console_timeline('2026') 實測 22.8 秒，超過 anon 的 3 秒）。
-- 日本站的 console_arm_status 是 SECURITY DEFINER，沒有 401；派工列也少，但寫法一樣是逐列呼叫，跟著改：
--   * policy_jp.console_dispatch_rows()：一筆自動缺口派工列 → 臂、選舉、職位，一次集合查詢；規則跟 #569 的兩支逐列函式一字不差。
--   * console_arm_election_counts() 改讀它；console_arm_status() 的件數改讀 console_arm_election_counts()；console_timeline() 件數只算一遍。
--   * 刪掉 #569 的 policy_jp.console_dispatch_election、policy_jp.console_dispatch_arm。
-- 只動 policy_jp 的物件；登記在 policy-jp-dispatch-drift.test.ts 的 JP_ONLY。

CREATE OR REPLACE FUNCTION policy_jp.console_dispatch_rows()
RETURNS TABLE (task_id TEXT, arm TEXT, election_id TEXT, election_type TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH d AS (
    SELECT d.task_id, d.target, NULLIF(d.opened_by->>'arm', '') AS tagged, split_part(d.task_id, ':', 2) AS t,
           -- 歸屆：election_id → politician_election_id → politician_election_ids[0]
           COALESCE(e1.id, pe1.election_id, pe2.election_id) AS eid
      FROM policy_jp.task_dispatches d
      LEFT JOIN policy_jp.elections e1 ON e1.id = d.target->>'election_id'
      LEFT JOIN policy_jp.politician_elections pe1 ON pe1.id = d.target->>'politician_election_id'
      LEFT JOIN policy_jp.politician_elections pe2 ON jsonb_typeof(d.target->'politician_election_ids') = 'array'
                                                  AND pe2.id = d.target->'politician_election_ids'->>0
     WHERE d.task_id LIKE 'auto:%'
  )
  SELECT x.task_id, x.arm, x.eid, x.etype
    FROM (
      SELECT d.task_id, d.eid,
             -- 歸臂：opened_by.arm；沒有就照 task_id 的型別段（日本站的型別段就是臂名，不在臂清單的不算）
             COALESCE(d.tagged, CASE WHEN d.t = ANY (n.names) THEN d.t END) AS arm,
             -- 職位：target.election_type，沒有就是那場選舉的職位（一場選舉一個職位）
             CASE WHEN d.eid IS NULL THEN NULL ELSE COALESCE(NULLIF(d.target->>'election_type', ''), el.election_type) END AS etype
        FROM d
        CROSS JOIN (SELECT policy_jp.activity_arm_names() AS names) n
        LEFT JOIN policy_jp.elections el ON el.id = d.eid
    ) x
   WHERE x.arm IS NOT NULL
$$;
COMMENT ON FUNCTION policy_jp.console_dispatch_rows IS
  '主控台用：每一筆自動缺口派工列屬於哪支臂、哪一場選舉（NULL＝日常）、哪個職位。一次集合查詢；只給主控台算件數。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION policy_jp.console_dispatch_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.console_dispatch_rows() TO service_role;

CREATE OR REPLACE FUNCTION policy_jp.console_arm_election_counts()
RETURNS TABLE (arm TEXT, election_id TEXT, election_type TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  SELECT r.arm, r.election_id, r.election_type, count(*) FROM policy_jp.console_dispatch_rows() r GROUP BY 1, 2, 3
  UNION ALL
  SELECT 'manual_visitor', NULL::TEXT, NULL::TEXT, count(*)
    FROM policy_jp.task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM policy_jp.contribution_auto_tasks_manual(true) m)
  UNION ALL
  SELECT 'manual_open', NULL::TEXT, NULL::TEXT, count(*)
    FROM policy_jp.task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM policy_jp.contribution_auto_tasks_manual(false) m)
$$;

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

  -- 件數只算一遍（以前 v_counts、v_types 各呼叫一次 console_arm_election_counts）
  WITH c AS MATERIALIZED (SELECT * FROM policy_jp.console_arm_election_counts())
  SELECT
    (SELECT COALESCE(jsonb_object_agg(a.arm, jsonb_build_object('e', a.e, 'd', a.d)), '{}'::JSONB)
       FROM (SELECT x.arm, sum(x.n) FILTER (WHERE x.election_id = v_el.id) AS e, sum(x.n) FILTER (WHERE x.election_id IS NULL) AS d
               FROM c x GROUP BY x.arm) a),
    (SELECT COALESCE(jsonb_object_agg(a.arm, a.t), '{}'::JSONB)
       FROM (SELECT x.arm, jsonb_object_agg(COALESCE(x.election_type, ''), x.n) AS t
               FROM (SELECT y.arm, y.election_type, sum(y.n) AS n FROM c y WHERE y.election_id = v_el.id GROUP BY 1, 2) x
              GROUP BY x.arm) a)
    INTO v_counts, v_types;

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

-- console_arm_status：件數改讀 console_arm_election_counts()；其餘照 20261010140100
CREATE OR REPLACE FUNCTION policy_jp.console_arm_status()
RETURNS TABLE (arm TEXT, is_open BOOLEAN, via TEXT, queue_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH arms AS (SELECT a AS arm FROM unnest(policy_jp.activity_arm_names()) AS a),
  -- 「不屬於任何選舉」＋每場選舉整場＋每場選舉的職位（日本站一場選舉只有一個職位）
  targets AS (
    SELECT NULL::TEXT AS election_id, NULL::TEXT AS election_type
    UNION ALL SELECT e.id, NULL::TEXT FROM policy_jp.elections e
    UNION ALL SELECT e.id, e.election_type FROM policy_jp.elections e WHERE e.election_type IS NOT NULL
  ),
  opened AS (
    SELECT a.arm, t.election_id, x.is_open, x.via_override, x.via_rule
      FROM arms a
      CROSS JOIN targets t
      CROSS JOIN LATERAL (
        SELECT count(*) > 0 AS is_open,
               bool_or(o.override_id IS NOT NULL) AS via_override,
               bool_or(o.rule_id IS NOT NULL) AS via_rule
          FROM policy_jp.activity_open(a.arm, t.election_id, t.election_type) o
      ) x
  ),
  agg AS (
    SELECT o.arm, bool_or(o.is_open) AS is_open, bool_or(o.via_override) AS via_override, bool_or(o.via_rule) AS via_rule
      FROM opened o
     GROUP BY o.arm
  ),
  -- 全關的覆寫（force='closed'）在 activity_open() 裡回 0 列，這裡額外查：現在有生效中的 closed 覆寫蓋到這支臂就算 via=override
  closed_ov AS (
    SELECT DISTINCT o.activity FROM policy_jp.activity_overrides o
     WHERE o."force" = 'closed' AND (o.expires_at IS NULL OR o.expires_at >= policy_jp.activity_today())
  ),
  counts AS (
    SELECT c.arm, sum(c.n) AS n FROM policy_jp.console_arm_election_counts() c GROUP BY c.arm
  )
  SELECT ar.arm,
         COALESCE(ag.is_open, false) AS is_open,
         CASE WHEN COALESCE(ag.via_override, false) THEN 'override'
              WHEN COALESCE(ag.via_rule, false) THEN 'rule'
              WHEN co.activity IS NOT NULL THEN 'override'
              ELSE 'closed' END AS via,
         cn.n AS queue_count
    FROM arms ar
    LEFT JOIN agg ag ON ag.arm = ar.arm
    LEFT JOIN closed_ov co ON co.activity = ar.arm
    LEFT JOIN counts cn ON cn.arm = ar.arm
   ORDER BY ar.arm
$$;

DROP FUNCTION IF EXISTS policy_jp.console_dispatch_arm(TEXT, JSONB, JSONB);
DROP FUNCTION IF EXISTS policy_jp.console_dispatch_election(JSONB);
