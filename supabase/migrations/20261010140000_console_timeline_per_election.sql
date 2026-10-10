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
--   * console_dispatch_election_type(target)：一筆派工列是哪個職位。target 的 election_type；沒有就從參選紀錄
--     （politician_election_id、politician_election_ids 的第一筆、politician_id＋election_id）補；都沒有＝NULL（不分職位）。
--   * console_arm_election_counts()：每支臂 × 每場選舉 × 職位的派工件數（election_id 空＝日常），一次掃 task_dispatches。
--     維護者 10-10 追加：件數由資料端照「屆別 × 職位」算好，畫面預設照一屆彙總、每支臂可點開看各職位（policy-ops #69）。
--     自動缺口的臂照 console_dispatch_arm（opened_by.arm，舊列照 task_id 的型別段歸回）；
--     兩支手動臂（manual_visitor／manual_open）一律算日常。
--   * console_stage_end(選舉, 段)：這場選舉的某一段在哪一天結束（之後還有件數＝「過段仍在派」，主控台標紅）。
--       2 參選期 → 登記截止（各職位取最晚；沒有就投票日）
--       3 登記後到投票 → 投票日
--       4 開票 → 就職日（各職位取最晚；沒有就投票日 +30）
--       5 就任、6 任期中 → 任期屆滿（就任段的任務〔補該屆政見〕整個任期都有效，不算過段）
--       1 常時、7 卸任交接 → 不會過段（NULL）
--   * console_timeline(選舉)：每支臂多 election_count（這一屆的件數）、daily_count（不屬於任何一屆的件數）、
--     stage_end、stale（這一屆的件數 > 0 而且這一段已經結束）、by_type（這一屆各職位：件數、今天對這個職位開不開、有沒有覆寫蓋到；
--     列出這場選舉的每個職位，加上件數裡出現的職位與「不分職位」〔election_type 空〕）；最上層多 election_total、daily_total。
--     queue_count（全站）照舊。
--
--   * console_arm_status()：佇列件數改照 console_dispatch_arm 歸臂（主線 10-10：沒有臂名的舊列以前不算，開票結果顯示「—」、
--     補當選結果少算），其餘照 20261009260000。
--   * console_arm_stage_map：名單清查（raw:roster_check、roster_villages）從 2 參選期改到 3 登記後到投票（維護者 10-10 決定卡「移到第 3 段」：
--     名單清查是照登記彙總表核對，登記截止之後才有東西可查）。名冊缺口 roster_cec_gap 留在 2。
-- 不動的：派工、seed、規則、覆寫、console_arm_stages()；不回 created_by 或任何帳號資料。
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

CREATE OR REPLACE FUNCTION console_dispatch_election_type(p_target JSONB) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(
    NULLIF(p_target->>'election_type', ''),
    (SELECT pe.election_type FROM politician_elections pe WHERE pe.id = election_id_or_null(p_target->>'politician_election_id')),
    (SELECT pe.election_type FROM politician_elections pe
      WHERE jsonb_typeof(p_target->'politician_election_ids') = 'array'
        AND pe.id = election_id_or_null(p_target->'politician_election_ids'->>0)),
    (SELECT pe.election_type FROM politician_elections pe
      WHERE p_target->>'politician_id' ~ '^[0-9a-fA-F-]{36}$' AND pe.politician_id::TEXT = p_target->>'politician_id'
        AND pe.election_id = console_dispatch_election(p_target)
      ORDER BY pe.id LIMIT 1)
  )
$$;
COMMENT ON FUNCTION console_dispatch_election_type IS
  '主控台用：一筆派工列（target）是哪個職位；target.election_type → 參選紀錄（politician_election_id、politician_election_ids[0]、人物＋選舉）；都沒有＝NULL（不分職位）。'
  '只給主控台算件數，不影響派工。2026-10-10（policy-ops #69）';
REVOKE ALL ON FUNCTION console_dispatch_election_type(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console_dispatch_election_type(JSONB) TO service_role;

-- 派工列 → 臂。P1（20261008060000）之後出生的列 opened_by 有 arm；之前回填的舊列沒有，原本 console_arm_status 整批不算
-- （主線 #569 審查：election_results 實際 404 件顯示「—」、raw:election_result_missing 實際 55 件顯示 9）。
-- 沒有臂名的照 task_id 的型別段（auto:<型別>:<子類>:…）歸回產生它的臂；同一個型別有兩支臂在派的，用跟臂本體一樣的條件分：
--   election_result_missing：名下有政見的是 raw 那支在派（election_results 的個別分支明寫不重複派這些），其餘是 election_results
--   candidacy_source_missing:party：投票日之後是 party_gap、之前是 party_roster（兩支規則的窗口）
-- 分不出來的（policy_missing、roster_check、candidacy_source_missing 其他子類）歸 raw 那支——它們本來就是 raw 型別、量最大。
-- 逐筆精確版（照臂本體重算）另案，這支只讓件數不再漏算。
CREATE OR REPLACE FUNCTION console_dispatch_arm(p_task_id TEXT, p_target JSONB, p_opened_by JSONB) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH k AS (
    SELECT split_part(p_task_id, ':', 2) AS t, split_part(p_task_id, ':', 3) AS sub
  )
  SELECT COALESCE(
    NULLIF(p_opened_by->>'arm', ''),
    (SELECT CASE
       WHEN k.t = 'election_results_missing' THEN 'election_results'
       WHEN k.t = 'election_result_missing' AND k.sub = 'cec' THEN 'elected_missing'
       WHEN k.t = 'election_result_missing' THEN
         CASE WHEN EXISTS (SELECT 1 FROM policies pl
                            WHERE pl.politician_id::TEXT = p_target->>'politician_id' AND pl.removed_at IS NULL)
              THEN 'raw:election_result_missing' ELSE 'election_results' END
       WHEN k.t = 'candidacy_source_missing' AND k.sub IN ('cand_no', 'cand_no_recheck') THEN 'ballot_numbers'
       WHEN k.t = 'candidacy_source_missing' AND k.sub = 'party' THEN
         CASE WHEN (SELECT e.election_date FROM elections e WHERE e.id = console_dispatch_election(p_target)) < activity_today()
              THEN 'party_gap' ELSE 'party_roster' END
       WHEN k.t = 'not_running_recheck' AND k.sub = 'filing' THEN 'withdrawn_filing'
       WHEN k.t = 'not_running_recheck' THEN 'not_running'
       WHEN k.t = 'term_policy_missing' THEN 'term_policies'
       WHEN k.t = 'district_seats_missing' THEN 'district_seats'
       WHEN k.t = 'policy_elements_missing' THEN 'policy_elements'
       WHEN k.t = 'lineage_candidate' THEN 'lineage_candidates'
       WHEN k.t = 'lineage_roles_missing' THEN 'lineage_roles'
       WHEN k.t = 'lineage_link_candidate' THEN 'lineage_links'
       WHEN k.t = 'profile_detail_gap' AND k.sub = 'sources' THEN 'career_sources'
       WHEN k.t = 'party_info_missing' THEN 'party_info'
       WHEN k.t = 'placeholder_politician' THEN 'placeholder_politicians'
       WHEN k.t = 'candidacy_owner_mismatch' THEN 'owner_mismatch'
       WHEN k.t = 'regional_stat_missing' THEN 'regional_stats_missing'
       WHEN k.t = 'duplicate_politician' THEN 'dup'
       WHEN k.t = 'duplicate_policy' THEN 'policy_dup'
       WHEN k.t = 'legacy_audit' THEN 'legacy'
       WHEN k.t = 'policy_election_mismatch' THEN 'mismatch'
       WHEN ('raw:' || k.t) = ANY (activity_arm_names()) THEN 'raw:' || k.t
       WHEN k.t = ANY (activity_arm_names()) THEN k.t
     END FROM k)
  )
$$;
COMMENT ON FUNCTION console_dispatch_arm IS
  '主控台用：一筆派工列屬於哪一支臂。opened_by.arm；沒有（P1 之前回填的舊列）就照 task_id 的型別段歸回，兩支臂共用的型別照臂本體的條件分。'
  '只給主控台算件數，不影響派工。2026-10-10（policy-tw #569 審查）';
REVOKE ALL ON FUNCTION console_dispatch_arm(TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION console_dispatch_arm(TEXT, JSONB, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION console_arm_election_counts()
RETURNS TABLE (arm TEXT, election_id INTEGER, election_type TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.arm, x.eid, CASE WHEN x.eid IS NULL THEN NULL ELSE console_dispatch_election_type(x.target) END, count(*)
    FROM (SELECT console_dispatch_arm(d.task_id, d.target, d.opened_by) AS arm, console_dispatch_election(d.target) AS eid, d.target
            FROM task_dispatches d
           WHERE d.task_id LIKE 'auto:%') x
   WHERE x.arm IS NOT NULL
   GROUP BY 1, 2, 3
  UNION ALL
  SELECT 'manual_visitor', NULL::INTEGER, NULL::TEXT, count(*)
    FROM task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(true) m)
  UNION ALL
  SELECT 'manual_open', NULL::INTEGER, NULL::TEXT, count(*)
    FROM task_dispatches d WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(false) m)
$$;
COMMENT ON FUNCTION console_arm_election_counts IS
  '主控台用：每支派工臂 × 每場選舉 × 職位的佇列件數（election_id 空＝日常，不屬於任何一屆，職位也是空；職位空而 election_id 有值＝這一屆不分職位）。自動缺口照 console_dispatch_arm 分臂（舊列照型別歸回）；'
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
  v_types JSONB;
BEGIN
  IF p_election_id IS NULL OR p_election_id !~ '^[0-9]+$' THEN RETURN NULL; END IF;
  v_id := p_election_id::INTEGER;
  SELECT * INTO v_el FROM elections e WHERE e.id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 臂 → {e: 這一屆的件數, d: 日常的件數}；一次掃描
  SELECT COALESCE(jsonb_object_agg(c.arm, jsonb_build_object('e', c.e, 'd', c.d)), '{}'::JSONB) INTO v_counts
    FROM (SELECT x.arm, sum(x.n) FILTER (WHERE x.election_id = v_id) AS e, sum(x.n) FILTER (WHERE x.election_id IS NULL) AS d
            FROM console_arm_election_counts() x GROUP BY x.arm) c;
  -- 臂 → {職位: 這一屆的件數}（職位空記成 ''＝不分職位）
  SELECT COALESCE(jsonb_object_agg(c.arm, c.t), '{}'::JSONB) INTO v_types
    FROM (SELECT x.arm, jsonb_object_agg(COALESCE(x.election_type, ''), x.n) AS t
            FROM (SELECT y.arm, y.election_type, sum(y.n) AS n FROM console_arm_election_counts() y
                   WHERE y.election_id = v_id GROUP BY 1, 2) x GROUP BY x.arm) c;

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
  '段的結束日 stage_end、過段仍在派 stale、每條規則在這場選舉的開放區間。找不到選舉回 NULL。公開唯讀。2026-10-10（policy-ops #63、#69）';
REVOKE ALL ON FUNCTION console_timeline(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_timeline(TEXT) TO anon, authenticated, service_role;

-- console_arm_status：件數改用 console_dispatch_arm（沒有臂名的舊列照型別歸回，不再漏算）；其餘一個字不變（照 20261009260000 的現行定義）
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
  -- 「auto:」缺口的件數一次用 GROUP BY 算好（一次掃描 task_dispatches），不要每支臂各自掃一次全表
  -- （agy 審查第 7 點：37 支臂 × 全表掃描，改成單次掃描＋分組）
  auto_counts AS (
    SELECT x.arm, count(*) AS n
      FROM (SELECT console_dispatch_arm(d.task_id, d.target, d.opened_by) AS arm
              FROM task_dispatches d
             WHERE d.task_id LIKE 'auto:%') x
     WHERE x.arm IS NOT NULL
     GROUP BY x.arm
  ),
  -- 手動任務（manual_visitor／manual_open）沒有 auto: 前綴、opened_by 也不保證有 arm 鍵，仍要各查一次臂本體；
  -- 只有這兩支（資料量遠小於 task_dispatches 全表），不是 37 次
  manual_counts AS (
    SELECT 'manual_visitor'::TEXT AS arm, count(*) AS n
      FROM task_dispatches d
     WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(true) m)
    UNION ALL
    SELECT 'manual_open'::TEXT, count(*)
      FROM task_dispatches d
     WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(false) m)
  )
  SELECT ar.arm,
         COALESCE(ag.is_open, false) AS is_open,
         CASE WHEN COALESCE(ag.via_override, false) THEN 'override'
              WHEN COALESCE(ag.via_rule, false) THEN 'rule'
              WHEN co.activity IS NOT NULL THEN 'override'
              ELSE 'closed' END AS via,
         COALESCE(ac.n, mc.n) AS queue_count
    FROM arms ar
    LEFT JOIN agg ag ON ag.activity = ar.arm
    LEFT JOIN closed_ov co ON co.activity = ar.arm
    LEFT JOIN auto_counts ac ON ac.arm = ar.arm
    LEFT JOIN manual_counts mc ON mc.arm = ar.arm
   ORDER BY ar.arm
$$;

-- 名單清查改到第 3 段（維護者 10-10）
UPDATE console_arm_stage_map
   SET stage = 3,
       note = CASE arm WHEN 'raw:roster_check' THEN '名單清查（照登記彙總表核對，登記截止後才有得查；10-10 由 2 改 3）'
                       ELSE '村里名單清查（10-10 由 2 改 3）' END
 WHERE arm IN ('raw:roster_check', 'roster_villages');
