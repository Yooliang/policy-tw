SET default_transaction_read_only = on;
SET statement_timeout = '30s';
-- 20261010200000 的 console_dispatch_rows() 本體（唯讀），量一次集合查詢要多久。目標：anon 的 3 秒內，最好 1 秒以下。
-- 用法：npx supabase db query --linked -f scripts/console-timeline-fix-explain.sql
-- 合併前跑：只量新本體（函式還沒上）；合併上線後跑最後兩段，量 console_arm_status() 與 console_timeline('2026')。
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
SELECT r.arm, r.election_id, r.election_type, count(*) FROM (
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
  SELECT x.task_id, x.arm, x.eid AS election_id, x.etype AS election_type
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
) r GROUP BY 1, 2, 3;

-- 新本體與上線中的 #569 版本逐列歸臂、歸屆是否一致（應為 0 列；#569 的三支逐列函式還在時才跑得動）
WITH n AS (WITH pol AS (
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
  SELECT x.task_id, x.arm, x.eid AS election_id, x.etype AS election_type
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
   WHERE x.arm IS NOT NULL),
o AS (SELECT d.task_id, console_dispatch_arm(d.task_id, d.target, d.opened_by) AS arm, console_dispatch_election(d.target) AS eid,
             CASE WHEN console_dispatch_election(d.target) IS NULL THEN NULL ELSE console_dispatch_election_type(d.target) END AS etype
        FROM task_dispatches d WHERE d.task_id LIKE 'auto:%')
SELECT o.task_id, o.arm, n.arm, o.eid, n.election_id, o.etype, n.election_type
  FROM o FULL JOIN n ON n.task_id = o.task_id
 WHERE (o.arm IS NOT NULL OR n.task_id IS NOT NULL)
   AND (o.arm IS DISTINCT FROM n.arm OR o.eid IS DISTINCT FROM n.election_id OR o.etype IS DISTINCT FROM n.election_type)
 LIMIT 20;

-- 上線後：
-- EXPLAIN (ANALYZE, TIMING OFF) SELECT * FROM console_arm_status();
-- EXPLAIN (ANALYZE, TIMING OFF) SELECT console_timeline('2026');
