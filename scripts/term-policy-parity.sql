SET default_transaction_read_only = on;
-- term_policy_missing 派工清單的「部署前後差集」守門：正式庫唯讀快照（給 scripts/term-policy-parity.ts 灌進 PGlite）
-- 用法：
--   npx supabase db query --linked -f scripts/term-policy-parity.sql > snapshot.json
--   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/term-policy-parity.ts snapshot.json
-- 一個 SELECT＝一個查詢快照：hash／n 與各表資料是同一個時間點，PGlite 跑出來的舊函式輸出必須對得上這兩個數字（確認 stub 表沒走樣）。
-- 只讀：快照只含派工函式用到的欄位（姓名、政黨、縣市是公開資料），不含任何金鑰或個資。
SELECT json_build_object(
  'taken_at', now(),
  'n', (SELECT count(*) FROM contribution_auto_tasks_term_policies()),
  'hash', (SELECT md5(string_agg(to_jsonb(t)::text, '' ORDER BY t.task_id)) FROM contribution_auto_tasks_term_policies() t),
  'village_cap', term_policy_village_cap(),
  'elections', (SELECT json_agg(json_build_object('id', id)) FROM elections),
  'politicians', (SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'party', p.party, 'merged_into', p.merged_into, 'region', p.region))
                    FROM politicians p WHERE p.id IN (SELECT politician_id FROM politician_elections WHERE election_id IN (SELECT id FROM elections))),
  'regions', (SELECT json_agg(json_build_object('id', id, 'region', region)) FROM regions),
  'politician_elections', (SELECT json_agg(json_build_object('id', id, 'politician_id', politician_id, 'election_id', election_id,
                                                              'election_type', election_type, 'region_id', region_id, 'candidacy_status', candidacy_status))
                             FROM politician_elections),
  'policies', (SELECT json_agg(json_build_object('politician_id', politician_id, 'election_id', election_id, 'removed_at', removed_at))
                 FROM policies WHERE removed_at IS NULL),
  'politician_bulletins', (SELECT json_agg(row_to_json(b)) FROM politician_bulletins b),
  'task_dispatches', (SELECT json_agg(json_build_object('task_id', task_id)) FROM task_dispatches WHERE task_id LIKE 'auto:term_policy_missing:%')
) AS j;
