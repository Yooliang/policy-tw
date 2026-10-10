-- 主控台派工時間軸：日常與當屆選舉拆開，選哪一屆只算那一屆（policy-ops #69，2026-10-10）
-- ============================================================
--
-- 維護者 10-10：「日常的跟當屆選舉的這兩個要拆得非常清楚」。原本時間軸每支臂只有一個全站件數（console_arm_status 的 queue_count），
-- 各屆的任務混在一起：2022 還有開票結果、名單清查在派，選 2022 或 2026 看到的都是同一個數字。
--
-- 這支只加唯讀的東西、改寫 console_timeline() 的回傳內容（簽名不變，CREATE OR REPLACE；舊鍵都留著，前端舊版照常能讀）：
--   * console_dispatch_election(target)：一筆派工列屬於哪一場選舉。依序看 target 的 election_id（數字或 election_key 都認）、
--     election_key、politician_election_id、politician_election_ids 的第一筆（同一件的參選紀錄都在同一場）；都沒有＝NULL＝日常。
--     規則開窗（contribution_auto_tasks_arms 的 keyed）只看 target.election_id；這裡多認參選紀錄，是為了把「補政見」這類只帶
--     參選紀錄的任務也歸到它的那一屆（只影響主控台的件數，不影響派工）。
--   * console_arm_election_counts()：每支臂 × 每場選舉的派工件數（election_id 空＝日常），一次掃 task_dispatches。
--     自動缺口的臂名照 console_arm_status 讀 opened_by.arm（P1 之前回填的舊列沒有這個鍵、不計，同一個已知落差）；
--     兩支手動臂（manual_visitor／manual_open）一律算日常。
--   * console_stage_end(選舉, 段)：這場選舉的某一段在哪一天結束（之後還有件數＝「過段仍在派」，主控台標紅）。
--       2 參選期 → 登記截止（各職位取最晚；沒有就投票日）
--       3 登記後到投票 → 投票日
--       4 開票 → 就職日（各職位取最晚；沒有就投票日 +30）
--       5 就任、6 任期中 → 任期屆滿（就任段的任務〔補該屆政見〕整個任期都有效，不算過段）
--       1 常時、7 卸任交接 → 不會過段（NULL）
--   * console_timeline(選舉)：每支臂多 election_count（這一屆的件數）、daily_count（不屬於任何一屆的件數）、
--     stage_end、stale（這一屆的件數 > 0 而且這一段已經結束）；最上層多 election_total、daily_total。queue_count（全站）照舊。
--
-- 不動的：派工、seed、規則、覆寫、console_arm_status()、console_arm_stages()；不回 created_by 或任何帳號資料。
-- 權限：照 20261010110000，SECURITY DEFINER、釘 search_path、REVOKE ALL FROM PUBLIC，公開的只 GRANT EXECUTE 給 anon／authenticated／service_role；
--   console_dispatch_election 只給內部用（不 GRANT）。
-- 已過段仍在派的任務要不要關，另案（policy-ops #69 決定的附註），這支只負責看得見。
-- 守門：supabase/functions/_shared/console-timeline-per-election.test.ts；日本站同形的一套在 20261010140100_policy_jp_console_timeline_per_election.sql。

CREATE OR REPLACE FUNCTION console_dispatch_election(p_target JSONB) RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    (SELECT e.id FROM elections e WHERE e.id = election_id_or_null(p_target->>'election_id')),
    (SELECT e.id FROM elections e WHERE e.election_key = p_target->>'election_id'),
    (SELECT e.id FROM elections e WHERE e.election_key = p_target->>'election_key'),
    (SELECT pe.election_id FROM politician_elections pe WHERE pe.id = election_id_or_null(p_target->>'politician_election_id')),
    (SELECT pe.election_id FROM politician_elections pe
      WHERE jsonb_typeof(p_target->'politician_election_ids') = 'array'
        AND pe.id = election_id_or_null(p_target->'politician_election_ids'->>0))
  )
$$;
COMMENT ON FUNCTION console_dispatch_election IS
  '主控台用：一筆派工列（target）屬於哪一場選舉；election_id → election_key → politician_election_id → politician_election_ids[0]，都沒有＝NULL（日常）。'
  '只給主控台算件數，不影響派工。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION console_dispatch_election(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console_dispatch_election(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION console_arm_election_counts()
RETURNS TABLE (arm TEXT, election_id INTEGER, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.opened_by->>'arm', console_dispatch_election(d.target), count(*)
    FROM task_dispatches d
   WHERE d.task_id LIKE 'auto:%' AND d.opened_by ? 'arm'
   GROUP BY 1, 2
  UNION ALL
  SELECT 'manual_visitor', NULL::INTEGER, count(*)
    FROM task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(true) m)
  UNION ALL
  SELECT 'manual_open', NULL::INTEGER, count(*)
    FROM task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(false) m)
$$;
COMMENT ON FUNCTION console_arm_election_counts IS
  '主控台用：每支派工臂 × 每場選舉的佇列件數（election_id 空＝日常，不屬於任何一屆）。自動缺口照 opened_by.arm 分臂（P1 之前回填的舊列不計，同 console_arm_status）；'
  '手動兩臂算日常。公開唯讀。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION console_arm_election_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_arm_election_counts() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION console_stage_end(p_election_id INTEGER, p_stage SMALLINT) RETURNS DATE
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH m AS (SELECT m.kind, max(m.on_date) AS d FROM election_milestones_all m WHERE m.election_id = p_election_id GROUP BY m.kind),
  e AS (SELECT e.election_date AS d FROM elections e WHERE e.id = p_election_id)
  SELECT CASE p_stage
    WHEN 2 THEN COALESCE((SELECT d FROM m WHERE kind = 'registration_close'), (SELECT d FROM m WHERE kind = 'polling'), (SELECT d FROM e))
    WHEN 3 THEN COALESCE((SELECT d FROM m WHERE kind = 'polling'), (SELECT d FROM e))
    WHEN 4 THEN COALESCE((SELECT d FROM m WHERE kind = 'term_start'), COALESCE((SELECT d FROM m WHERE kind = 'polling'), (SELECT d FROM e)) + 30)
    WHEN 5 THEN (SELECT d FROM m WHERE kind = 'term_end')
    WHEN 6 THEN (SELECT d FROM m WHERE kind = 'term_end')
    ELSE NULL END
$$;
COMMENT ON FUNCTION console_stage_end IS
  '主控台用：某場選舉的某一段（console_arm_stages 的 1～7）在哪一天結束；之後這一屆還有件數＝過段仍在派。'
  '2→登記截止（沒有就投票日）、3→投票日、4→就職日（沒有就投票日 +30）、5、6→任期屆滿、1、7→NULL（不會過段）。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION console_stage_end(INTEGER, SMALLINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_stage_end(INTEGER, SMALLINT) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION console_timeline(p_election_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id INTEGER;
  v_el elections%ROWTYPE;
  v_today DATE := activity_today();
  v_counts JSONB;
BEGIN
  IF p_election_id IS NULL OR p_election_id !~ '^[0-9]+$' THEN RETURN NULL; END IF;
  v_id := p_election_id::INTEGER;
  SELECT * INTO v_el FROM elections e WHERE e.id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 臂 → {e: 這一屆的件數, d: 日常的件數}；一次掃描
  SELECT COALESCE(jsonb_object_agg(c.arm, jsonb_build_object('e', c.e, 'd', c.d)), '{}'::JSONB) INTO v_counts
    FROM (SELECT x.arm, sum(x.n) FILTER (WHERE x.election_id = v_id) AS e, sum(x.n) FILTER (WHERE x.election_id IS NULL) AS d
            FROM console_arm_election_counts() x GROUP BY x.arm) c;

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
  '段的結束日 stage_end、過段仍在派 stale、每條規則在這場選舉的開放區間。找不到選舉回 NULL。公開唯讀。2026-10-10（policy-ops #63、#69）';
REVOKE ALL ON FUNCTION console_timeline(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_timeline(TEXT) TO anon, authenticated, service_role;
