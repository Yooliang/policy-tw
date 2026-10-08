SET default_transaction_read_only = on;
-- seed_auto_task_queue／rebalance_queue「內容沒變不重寫」（#465）改前改後的 parity 與耗時：正式庫唯讀快照（給 scripts/seed-skip-parity.ts 灌進 PGlite）
-- 用法：
--   npx supabase db query --linked -f scripts/seed-skip-parity.sql -o json > snapshot.json
--   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/seed-skip-parity.ts snapshot.json
-- 一個 SELECT＝一個查詢快照：28＋1 個分支各自的輸出（seed 的缺口來源）、現有的派工列（task_dispatches 全表）、open 的手動任務與公民提問、待驗證與答案貢獻、elections、roster_check_scope。
-- 每個大塊都轉成「文字」放進去（jsonb 裡的 0.80 經 JS 解析再寫回會變 0.8）。只讀；內容都是公開資料與任務說明，不含金鑰或個資（貢獻只取 id、狀態、型別、任務 id、時間）。
SELECT json_build_object(
  'taken_at', now(),
  'n', (SELECT count(*) FROM contribution_auto_tasks_arms()),
  'hash', (SELECT md5(string_agg((to_jsonb(t) - 'arm' - 'opened_by')::text, '' ORDER BY t.task_id COLLATE "C")) FROM contribution_auto_tasks_arms() t),
  'elections', (SELECT json_agg(json_build_object('id', id, 'election_key', election_key, 'election_date', election_date, 'election_reason', election_reason, 'election_types', election_types, 'notice_date', notice_date)) FROM elections),
  -- 派工列分成每 1000 列一塊、每塊轉成「文字」：PGlite 一次吃不下十幾 MB 的參數，而且文字不經 JS 解析（target 裡的 0.90 不會變 0.9）
  'task_dispatches', (SELECT coalesce(json_agg(c.chunk::text ORDER BY c.b), '[]'::json)
                        FROM (SELECT x.b, json_agg(row_to_json(x.d) ORDER BY x.task_id COLLATE "C") AS chunk
                                FROM (SELECT t.task_id, t AS d, (row_number() OVER (ORDER BY t.task_id COLLATE "C") - 1) / 1000 AS b FROM task_dispatches t) x GROUP BY x.b) c),
  'contribution_tasks', (SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.id), '[]'::json)::text FROM contribution_tasks t WHERE t.status = 'open'),
  'citizen_questions', (SELECT coalesce(json_agg(json_build_object('id', q.id, 'stance_up', q.stance_up, 'answer_count', q.answer_count)), '[]'::json)::text FROM citizen_questions q),
  'contributions', (SELECT coalesce(json_agg(json_build_object('id', c.id, 'status', c.status, 'contribution_type', c.contribution_type, 'task_id', c.task_id, 'created_at', c.created_at)), '[]'::json)::text
                      FROM contributions c WHERE c.status = 'pending' OR (c.contribution_type = 'question_answer' AND c.status IN ('pending', 'verified'))),
  'roster_check_scope', (SELECT json_agg(row_to_json(s)) FROM roster_check_scope s),
  'branches', json_build_object(
    'raw', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_raw() x),
    'dup', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_dup() x),
    'legacy', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_legacy() x),
    'mismatch', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_mismatch() x),
    'policy_dup', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_policy_dup() x),
    'not_running', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_not_running() x),
    'mayor_policies', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_mayor_policies() x),
    'term_policies', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_term_policies() x),
    'roster_villages', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_roster_villages() x),
    'township_gap', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_township_gap() x),
    'region_gap', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_region_gap() x),
    'elected_missing', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_elected_missing() x),
    'roster_cec_gap', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_roster_cec_gap() x),
    'district_seats', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_district_seats() x),
    'policy_elements', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_policy_elements() x),
    'deadline_due', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_deadline_due() x),
    'lineage_candidates', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_lineage_candidates() x),
    'handover_missing', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_handover_missing() x),
    'lineage_roles', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_lineage_roles() x),
    'lineage_links', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_lineage_links() x),
    'career_sources', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_career_sources() x),
    'withdrawn_filing', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_withdrawn_filing() x),
    'party_gap', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_party_gap() x),
    'party_roster', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_party_roster() x),
    'party_info', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_party_info() x),
    'placeholder_politicians', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_placeholder_politicians() x),
    'election_results', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_election_results() x),
    'ballot_numbers', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_ballot_numbers() x),
    'owner_mismatch', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_owner_mismatch() x)
  )
) AS j;
