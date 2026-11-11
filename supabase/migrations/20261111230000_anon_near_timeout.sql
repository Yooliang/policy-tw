-- 效能：platform_cost_public 與 console_timeline 逼近 anon 3 秒逾時（2026-11-12）
-- ============================================================
-- anon 的 statement_timeout 是 3 秒。實測（正式庫，唯讀 EXPLAIN ANALYZE，函式內容逐字比對）：
--   * platform_cost_public()：4 個子查詢各掃一遍 jev_decisions 本月 7 萬列、每列跑 4 次正則 → 4.5～5.3 秒
--     改成「本月依 model 分組一次」再對每個 model（個位數）分類 → 單次聚合 46 毫秒（索引只讀掃描）／約 110 毫秒（現有索引）。
--     回傳欄位、簽名、權限、語意不變。沒有新增索引（不需要，也避免鎖表）。
--   * console_timeline(text)（pg_stat_statements 那支帶 p_election_id 的函式，平均 1.85 秒、最慢 2.96 秒）：
--     件數已算一遍，但 console_arm_status() 又把 console_arm_election_counts()（掃 2 萬列派工列，約 400 毫秒）再算一遍。
--     新增 console_arm_via()（開關與依據，不含件數），時間軸的件數合計從同一份 CTE 取；console_arm_status() 改由 via＋件數組成，輸出不變。
--     實測 1.0 秒 → 0.47 秒；輸出 jsonb 與舊版逐位相同（正式庫 election_id=2026 比對）。
-- 簽名不變、不刪欄位、不 DROP（新增一支函式），不必分兩次上。不寫任何資料。

CREATE OR REPLACE FUNCTION platform_cost_public()
RETURNS TABLE (
  balance_level TEXT,
  openrouter_month_calls BIGINT,
  openrouter_month_usd NUMERIC,
  typesafe_month_calls BIGINT,
  typesafe_month_usd NUMERIC,
  db_bytes BIGINT,
  refreshed_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH month_start AS (
    SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei') AS t
  ),
  -- 本月依 model 分組只掃一遍（model 只有個位數種），再對每組分類；舊寫法 4 個子查詢各掃 7 萬列、每列跑正則
  g AS (
    SELECT j.model, COUNT(*) AS c, SUM(j.cost_usd) AS u
      FROM jev_decisions j, month_start m
     WHERE j.asked_at >= m.t
     GROUP BY j.model
  ),
  agg AS (
    SELECT COALESCE(SUM(c) FILTER (WHERE jev_model_is_openrouter_jev(model)), 0) AS oc,
           COALESCE(SUM(u) FILTER (WHERE jev_model_is_openrouter_jev(model)), 0) AS ou,
           COALESCE(SUM(c) FILTER (WHERE jev_model_is_typesafe_direct(model)), 0) AS tc,
           COALESCE(SUM(u) FILTER (WHERE jev_model_is_typesafe_direct(model)), 0) AS tu
      FROM g
  )
  SELECT platform_balance_level((SELECT openrouter_credits - openrouter_usage FROM platform_costs WHERE id = 1)),
         (SELECT oc::BIGINT FROM agg),
         (SELECT ROUND(ou::NUMERIC, 2) FROM agg),
         (SELECT tc::BIGINT FROM agg),
         (SELECT ROUND(tu::NUMERIC, 2) FROM agg),
         pg_database_size(current_database()),
         (SELECT p.refreshed_at FROM platform_costs p WHERE p.id = 1)
$$;
REVOKE ALL ON FUNCTION platform_cost_public() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_cost_public() TO anon, authenticated;

CREATE OR REPLACE FUNCTION console_arm_via()
RETURNS TABLE (arm TEXT, is_open BOOLEAN, via TEXT)
LANGUAGE sql STABLE AS $$
  WITH arms AS (SELECT a AS arm FROM unnest(activity_arm_names()) AS a),
  agg AS (
    SELECT o.activity,
           bool_or(o.is_open) AS is_open,
           bool_or(o.is_open AND o.override_ids IS NOT NULL) AS via_override,
           bool_or(o.is_open AND o.rule_ids IS NOT NULL) AS via_rule
      FROM activity_open_now o
     GROUP BY o.activity
  ),
  -- 全關的覆寫（force='closed'）在 activity_open() 裡回 0 列（跟「沒有規則」一樣看不出來），這裡額外查一次：
  -- 現在有沒有一筆生效中的 closed 覆寫蓋到這支臂，有就算 via=override（即使因此整支臂是關的）
  closed_ov AS (
    SELECT DISTINCT o.activity FROM activity_overrides o
     WHERE o."force" = 'closed' AND (o.expires_at IS NULL OR o.expires_at >= activity_today())
  )
  SELECT ar.arm,
         COALESCE(ag.is_open, false) AS is_open,
         CASE WHEN COALESCE(ag.via_override, false) THEN 'override'
              WHEN COALESCE(ag.via_rule, false) THEN 'rule'
              WHEN co.activity IS NOT NULL THEN 'override'
              ELSE 'closed' END AS via
    FROM arms ar
    LEFT JOIN agg ag ON ag.activity = ar.arm
    LEFT JOIN closed_ov co ON co.activity = ar.arm
   ORDER BY ar.arm
$$;
REVOKE ALL ON FUNCTION console_arm_via() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_arm_via() TO anon, authenticated, service_role;
COMMENT ON FUNCTION console_arm_via IS '主控台用：每支派工臂現在開不開、依據（override／rule／closed）。不含件數（件數讀 console_arm_election_counts）。2026-11-12';

CREATE OR REPLACE FUNCTION console_arm_status()
RETURNS TABLE (arm TEXT, is_open BOOLEAN, via TEXT, queue_count BIGINT)
LANGUAGE sql STABLE AS $$
  -- 開關與依據讀 console_arm_via()；件數讀 console_arm_election_counts()（SECURITY DEFINER、公開）：這支是 SECURITY INVOKER，
  -- 不能直接呼叫只給 service_role 的 console_dispatch_rows()
  SELECT v.arm, v.is_open, v.via, cn.n AS queue_count
    FROM console_arm_via() v
    LEFT JOIN (SELECT c.arm, sum(c.n) AS n FROM console_arm_election_counts() c GROUP BY c.arm) cn ON cn.arm = v.arm
   ORDER BY v.arm
$$;

CREATE OR REPLACE FUNCTION console_timeline(p_election_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id INTEGER;
  v_el elections%ROWTYPE;
  v_today DATE := activity_today();
  v_counts JSONB;
  v_types JSONB;
  v_totals JSONB;
BEGIN
  IF p_election_id IS NULL OR p_election_id !~ '^[0-9]+$' THEN RETURN NULL; END IF;
  v_id := p_election_id::INTEGER;
  SELECT * INTO v_el FROM elections e WHERE e.id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 件數只算一遍（以前 v_counts、v_types 各呼叫一次 console_arm_election_counts，加上 console_arm_status 共掃三遍）
  WITH c AS MATERIALIZED (SELECT * FROM console_arm_election_counts())
  SELECT
    -- 臂 → {e: 這一屆的件數, d: 日常的件數}
    (SELECT COALESCE(jsonb_object_agg(a.arm, jsonb_build_object('e', a.e, 'd', a.d)), '{}'::JSONB)
       FROM (SELECT x.arm, sum(x.n) FILTER (WHERE x.election_id = v_id) AS e, sum(x.n) FILTER (WHERE x.election_id IS NULL) AS d
               FROM c x GROUP BY x.arm) a),
    -- 臂 → {職位: 這一屆的件數}（職位空記成 ''＝不分職位）
    (SELECT COALESCE(jsonb_object_agg(a.arm, a.t), '{}'::JSONB)
       FROM (SELECT x.arm, jsonb_object_agg(COALESCE(x.election_type, ''), x.n) AS t
               FROM (SELECT y.arm, y.election_type, sum(y.n) AS n FROM c y WHERE y.election_id = v_id GROUP BY 1, 2) x
              GROUP BY x.arm) a),
    -- 臂 → 全部選舉＋日常的件數合計（原本讀 console_arm_status 的 queue_count，那支會把派工列再掃一遍）
    (SELECT COALESCE(jsonb_object_agg(a.arm, a.n), '{}'::JSONB) FROM (SELECT x.arm, sum(x.n) AS n FROM c x GROUP BY x.arm) a)
    INTO v_counts, v_types, v_totals;

  RETURN jsonb_build_object(
    'today', v_today,
    'election', jsonb_build_object('id', v_el.id::TEXT, 'date', v_el.election_date, 'reason', v_el.election_reason,
                                   'types', to_jsonb(v_el.election_types), 'name', v_el.name),
    'election_total', COALESCE((SELECT sum((v.value->>'e')::BIGINT) FROM jsonb_each(v_counts) v), 0),
    'daily_total', COALESCE((SELECT sum((v.value->>'d')::BIGINT) FROM jsonb_each(v_counts) v), 0),
    'milestones', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind', m.kind, 'election_type', m.election_type, 'on_date', m.on_date, 'status', m.status)
                       ORDER BY m.on_date, m.kind, m.election_type)
        FROM election_milestones_all m WHERE m.election_id = v_id
    ), '[]'::JSONB),
    'arms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'arm', s.arm, 'stage', s.stage, 'stage_source', s.stage_source,
               'is_open', EXISTS (SELECT 1 FROM activity_open(s.arm, v_id, NULL))
                          OR EXISTS (SELECT 1 FROM unnest(v_el.election_types) t(x), activity_open(s.arm, v_id, t.x)),
               'overridden', EXISTS (
                 SELECT 1 FROM activity_overrides o
                  WHERE o.activity = s.arm AND (o.election_id IS NULL OR o.election_id = v_id)
                    AND (o.expires_at IS NULL OR o.expires_at >= v_today)
                    AND (o."force" <> 'window' OR o.open_until IS NULL OR o.open_until >= v_today)),
               'via', st.via, 'queue_count', (v_totals->>s.arm)::BIGINT,
               'election_count', COALESCE((v_counts->s.arm->>'e')::BIGINT, 0),
               'daily_count', COALESCE((v_counts->s.arm->>'d')::BIGINT, 0),
               'stage_end', se.d,
               'stale', COALESCE((v_counts->s.arm->>'e')::BIGINT, 0) > 0 AND se.d IS NOT NULL AND se.d < v_today,
               'by_type', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'election_type', NULLIF(ty.t, ''),
                          'n', COALESCE((v_types->s.arm->>ty.t)::BIGINT, 0),
                          'is_open', EXISTS (SELECT 1 FROM activity_open(s.arm, v_id, NULLIF(ty.t, ''))),
                          'overridden', EXISTS (
                            SELECT 1 FROM activity_overrides o
                             WHERE o.activity = s.arm AND (o.election_id IS NULL OR o.election_id = v_id)
                               AND (o.election_type IS NULL OR o.election_type = NULLIF(ty.t, ''))
                               AND (o.expires_at IS NULL OR o.expires_at >= v_today)
                               AND (o."force" <> 'window' OR o.open_until IS NULL OR o.open_until >= v_today)))
                          ORDER BY array_position(v_el.election_types, NULLIF(ty.t, '')) NULLS LAST, ty.t)
                   FROM (SELECT x AS t FROM unnest(v_el.election_types) x
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
                   FROM activity_rules r
                   LEFT JOIN LATERAL (
                     SELECT min(m.on_date) AS d FROM election_milestones_all m
                      WHERE m.election_id = v_id AND m.kind = r.from_kind
                        AND (r.election_types IS NULL OR m.election_type IS NULL OR m.election_type = ANY (r.election_types))
                   ) f ON true
                   LEFT JOIN LATERAL (
                     SELECT max(m.on_date) AS d FROM election_milestones_all m
                      WHERE m.election_id = v_id AND m.kind = r.until_kind
                        AND (r.election_types IS NULL OR m.election_type IS NULL OR m.election_type = ANY (r.election_types))
                   ) u ON true
                  WHERE r.enabled AND r.activity = s.arm
                    AND (r.reasons IS NULL OR v_el.election_reason = ANY (r.reasons))
                    AND (r.election_types IS NULL OR r.election_types && v_el.election_types)
               ), '[]'::JSONB))
             ORDER BY s.stage, s.arm)
        FROM console_arm_stages() s
        LEFT JOIN console_arm_via() st ON st.arm = s.arm
        LEFT JOIN LATERAL (SELECT console_stage_end(v_id, s.stage) AS d) se ON true
    ), '[]'::JSONB)
  );
END
$$;
REVOKE ALL ON FUNCTION console_timeline(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_timeline(TEXT) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
