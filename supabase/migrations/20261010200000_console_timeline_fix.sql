-- 主控台派工頁上線後壞掉的修正：console_arm_status 回 401、console_timeline 回 500（policy-ops #69，2026-10-10）
-- ============================================================
--
-- 維護者 10-10 回報 #569 上線後主控台派工頁「console_arm_status 401」「時間軸讀不到（console_timeline 500）」。
--   * 401：console_arm_status() 是 SECURITY INVOKER（20261009260000 起，照既有公開 RPC 的預設權限），#569 讓它逐列呼叫
--     console_dispatch_arm()，那支只 GRANT 給 service_role，anon 呼叫就是 permission denied（42501，PostgREST 對匿名回 401）。
--     PGlite 測試以超級使用者跑，權限測試只查了 console_timeline／console_arm_election_counts，沒查 console_arm_status。
--   * 500：#569 的件數逐列呼叫三支 SECURITY DEFINER 的 SQL 函式（console_dispatch_arm／_election／_election_type，每支裡面
--     還有好幾個子查詢；SECURITY DEFINER 不能 inline），console_timeline 又把件數算了三遍（v_counts、v_types、console_arm_status），
--     正式庫的 task_dispatches 上萬列，推斷是超過 anon 的 statement_timeout（雲端連不到正式庫，未實測；查法寫在 PR）。
--
-- 這支：
--   * console_dispatch_rows()：一筆自動缺口派工列 → 臂、選舉、職位，改成一次集合查詢（elections／politician_elections／policies
--     各 join 一次），歸臂與歸屆的規則跟 #569 的三支逐列函式一字不差（守門測試照舊）。只給 service_role（呼叫它的都是 SECURITY DEFINER）。
--   * console_arm_election_counts()：改讀 console_dispatch_rows()。
--   * console_arm_status()：件數改讀 console_arm_election_counts()（公開的 SECURITY DEFINER），自己仍是 SECURITY INVOKER、其餘不變。
--   * console_timeline()：件數只算一遍（MATERIALIZED CTE），其餘不變。
--   * 刪掉 #569 的三支逐列函式（console_dispatch_election、console_dispatch_election_type、console_dispatch_arm）：只有上面這幾支
--     SQL 在用、沒有 Edge Function 或前端呼叫，留著會變成兩份歸臂規則。
-- 日本站不動：policy_jp.console_arm_status 是 SECURITY DEFINER（沒有 401），派工列也少。
-- 守門：supabase/functions/_shared/console-timeline-per-election.test.ts（多一條：以 anon 身分呼叫 console_arm_status／console_timeline）。

CREATE OR REPLACE FUNCTION console_dispatch_rows()
RETURNS TABLE (task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH pol AS (
    SELECT DISTINCT pl.politician_id::TEXT AS pid FROM policies pl WHERE pl.removed_at IS NULL
  ),
  pe_by AS (  -- 人物＋選舉 → 職位（同一人同一屆多筆時取 id 最小的）
    SELECT DISTINCT ON (pe.politician_id::TEXT, pe.election_id) pe.politician_id::TEXT AS pid, pe.election_id, pe.election_type
      FROM politician_elections pe
     ORDER BY pe.politician_id::TEXT, pe.election_id, pe.id
  ),
  d0 AS (
    SELECT d.task_id, d.target, NULLIF(d.opened_by->>'arm', '') AS tagged,
           split_part(d.task_id, ':', 2) AS t, split_part(d.task_id, ':', 3) AS sub,
           -- 歸屆：election_id（數字或 election_key 都認）→ election_key → politician_election_id → politician_election_ids[0]
           COALESCE(e1.id, e2.id, e3.id, pe1.election_id, pe2.election_id) AS eid,
           NULLIF(d.target->>'election_type', '') AS t_type, pe1.election_type AS pe1_type, pe2.election_type AS pe2_type,
           (pol.pid IS NOT NULL) AS has_policy
      FROM task_dispatches d
      LEFT JOIN elections e1 ON e1.id = election_id_or_null(d.target->>'election_id')
      LEFT JOIN elections e2 ON e2.election_key = d.target->>'election_id'
      LEFT JOIN elections e3 ON e3.election_key = d.target->>'election_key'
      LEFT JOIN politician_elections pe1 ON pe1.id = election_id_or_null(d.target->>'politician_election_id')
      LEFT JOIN politician_elections pe2 ON jsonb_typeof(d.target->'politician_election_ids') = 'array'
                                        AND pe2.id = election_id_or_null(d.target->'politician_election_ids'->>0)
      LEFT JOIN pol ON pol.pid = d.target->>'politician_id'
     WHERE d.task_id LIKE 'auto:%'
  ),
  d AS (
    SELECT d0.*, el.election_date, activity_today() AS today, n.names,
           -- 歸職位：target.election_type → 參選紀錄（politician_election_id、politician_election_ids[0]、人物＋選舉）；只有歸得到屆才看
           CASE WHEN d0.eid IS NULL THEN NULL ELSE COALESCE(d0.t_type, d0.pe1_type, d0.pe2_type, pb.election_type) END AS etype
      FROM d0
      CROSS JOIN (SELECT activity_arm_names() AS names) n
      LEFT JOIN elections el ON el.id = d0.eid
      LEFT JOIN pe_by pb ON d0.eid IS NOT NULL AND pb.pid = d0.target->>'politician_id' AND pb.election_id = d0.eid
  )
  SELECT x.task_id, x.arm, x.eid, x.etype
    FROM (
      SELECT d.task_id, d.eid, d.etype,
             -- 歸臂：opened_by.arm；沒有（P1 之前回填的舊列）就照 task_id 的型別段歸回，兩支臂共用的型別照臂本體的條件分
             COALESCE(d.tagged, CASE
           WHEN d.t = 'election_results_missing' THEN 'election_results'
           WHEN d.t = 'election_result_missing' AND d.sub = 'cec' THEN 'elected_missing'
           WHEN d.t = 'election_result_missing' THEN
             CASE WHEN d.has_policy THEN 'raw:election_result_missing' ELSE 'election_results' END
           WHEN d.t = 'candidacy_source_missing' AND d.sub IN ('cand_no', 'cand_no_recheck') THEN 'ballot_numbers'
           WHEN d.t = 'candidacy_source_missing' AND d.sub = 'party' THEN
             CASE WHEN d.election_date < d.today THEN 'party_gap' ELSE 'party_roster' END
           WHEN d.t = 'not_running_recheck' AND d.sub = 'filing' THEN 'withdrawn_filing'
           WHEN d.t = 'not_running_recheck' THEN 'not_running'
           WHEN d.t = 'term_policy_missing' THEN 'term_policies'
           WHEN d.t = 'district_seats_missing' THEN 'district_seats'
           WHEN d.t = 'policy_elements_missing' THEN 'policy_elements'
           WHEN d.t = 'lineage_candidate' THEN 'lineage_candidates'
           WHEN d.t = 'lineage_roles_missing' THEN 'lineage_roles'
           WHEN d.t = 'lineage_link_candidate' THEN 'lineage_links'
           WHEN d.t = 'profile_detail_gap' AND d.sub = 'sources' THEN 'career_sources'
           WHEN d.t = 'party_info_missing' THEN 'party_info'
           WHEN d.t = 'placeholder_politician' THEN 'placeholder_politicians'
           WHEN d.t = 'candidacy_owner_mismatch' THEN 'owner_mismatch'
           WHEN d.t = 'regional_stat_missing' THEN 'regional_stats_missing'
           WHEN d.t = 'duplicate_politician' THEN 'dup'
           WHEN d.t = 'duplicate_policy' THEN 'policy_dup'
           WHEN d.t = 'legacy_audit' THEN 'legacy'
           WHEN d.t = 'policy_election_mismatch' THEN 'mismatch'
           WHEN ('raw:' || d.t) = ANY (d.names) THEN 'raw:' || d.t
           WHEN d.t = ANY (d.names) THEN d.t
             END) AS arm
        FROM d
    ) x
   WHERE x.arm IS NOT NULL
$$;
COMMENT ON FUNCTION console_dispatch_rows IS
  '主控台用：每一筆自動缺口派工列（auto:）屬於哪支臂、哪一場選舉（NULL＝日常）、哪個職位（NULL＝不分職位）。一次集合查詢；'
  '歸臂：opened_by.arm，舊列照 task_id 的型別段；歸屆：election_id → election_key → 參選紀錄。只給主控台算件數，不影響派工。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION console_dispatch_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console_dispatch_rows() TO service_role;

CREATE OR REPLACE FUNCTION console_arm_election_counts()
RETURNS TABLE (arm TEXT, election_id INTEGER, election_type TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.arm, r.election_id, r.election_type, count(*) FROM console_dispatch_rows() r GROUP BY 1, 2, 3
  UNION ALL
  SELECT 'manual_visitor', NULL::INTEGER, NULL::TEXT, count(*)
    FROM task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(true) m)
  UNION ALL
  SELECT 'manual_open', NULL::INTEGER, NULL::TEXT, count(*)
    FROM task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(false) m)
$$;
COMMENT ON FUNCTION console_arm_election_counts IS
  '主控台用：每支派工臂 × 每場選舉 × 職位的佇列件數（election_id 空＝日常，不屬於任何一屆，職位也是空；職位空而 election_id 有值＝這一屆不分職位）。'
  '自動缺口讀 console_dispatch_rows（舊列照型別歸回）；手動兩臂算日常。公開唯讀。2026-10-10（policy-ops #69）';

CREATE OR REPLACE FUNCTION console_arm_status()
RETURNS TABLE (arm TEXT, is_open BOOLEAN, via TEXT, queue_count BIGINT)
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
  ),
  -- 件數讀 console_arm_election_counts()（SECURITY DEFINER、公開）：這支是 SECURITY INVOKER，不能直接呼叫只給 service_role 的
  -- console_dispatch_rows()（#569 直接呼叫 console_dispatch_arm，anon 沒有權限，主控台回 401）
  counts AS (
    SELECT c.arm, sum(c.n) AS n FROM console_arm_election_counts() c GROUP BY c.arm
  )
  SELECT ar.arm,
         COALESCE(ag.is_open, false) AS is_open,
         CASE WHEN COALESCE(ag.via_override, false) THEN 'override'
              WHEN COALESCE(ag.via_rule, false) THEN 'rule'
              WHEN co.activity IS NOT NULL THEN 'override'
              ELSE 'closed' END AS via,
         cn.n AS queue_count
    FROM arms ar
    LEFT JOIN agg ag ON ag.activity = ar.arm
    LEFT JOIN closed_ov co ON co.activity = ar.arm
    LEFT JOIN counts cn ON cn.arm = ar.arm
   ORDER BY ar.arm
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
              GROUP BY x.arm) a)
    INTO v_counts, v_types;

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
               'via', st.via, 'queue_count', st.queue_count,
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
        LEFT JOIN console_arm_status() st ON st.arm = s.arm
        LEFT JOIN LATERAL (SELECT console_stage_end(v_id, s.stage) AS d) se ON true
    ), '[]'::JSONB)
  );
END
$$;
COMMENT ON FUNCTION console_timeline IS
  '主控台時間軸：一場選舉的今天、里程碑、每支臂的段／開關／覆寫／佇列件數（全站 queue_count、這一屆 election_count、日常 daily_count）、'
  '段的結束日 stage_end、過段仍在派 stale、每條規則在這場選舉的開放區間。找不到選舉回 NULL。公開唯讀。2026-10-10（policy-ops #63、#69；件數只掃一遍）';
REVOKE ALL ON FUNCTION console_timeline(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_timeline(TEXT) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS console_dispatch_arm(TEXT, JSONB, JSONB);
DROP FUNCTION IF EXISTS console_dispatch_election_type(JSONB);
DROP FUNCTION IF EXISTS console_dispatch_election(JSONB);
