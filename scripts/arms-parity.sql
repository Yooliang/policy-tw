SET default_transaction_read_only = on;
-- 派工臂總表（contribution_auto_tasks_arms）改前改後的「逐件不變」守門：正式庫唯讀快照（給 scripts/arms-parity.ts 灌進 PGlite）
-- 用法：
--   npx supabase db query --linked -f scripts/arms-parity.sql -o json > snapshot.json   （外層是 { rows: [ { j } ] }；ts 腳本兩種格式都吃）
--   deno run --node-modules-dir=none --allow-read --allow-net --allow-env scripts/arms-parity.ts snapshot.json
-- 一個 SELECT＝一個查詢快照：總表現行輸出的筆數與全欄雜湊、28 個分支各自的輸出、elections、roster_check_scope 是同一個時間點。
-- 做法：PGlite 裡 28 個分支函式換成「回放這個快照裡該分支的輸出」的 stub，其餘（總表本身、roster_scope_covers、整個啟用時間窗的表與函式）跑真的；
-- 所以測的是「總表的組合方式」（貼臂名＋規則過濾）在正式庫真實輸出上有沒有改變結果，各臂內部（不在這次範圍）不重算。
-- 每個分支的輸出轉成「文字」放進去：外層 JSON 被 JS 解析再寫回時數字會被正規化（jsonb 裡的 0.80 變 0.8，整列雜湊就對不上），文字不會。
-- 只讀：快照只含派工輸出（本來就是公開資料與任務說明）與兩張小設定表，不含金鑰或個資。
SELECT json_build_object(
  'taken_at', now(),
  'n', (SELECT count(*) FROM contribution_auto_tasks_arms()),
  'hash', (SELECT md5(string_agg(to_jsonb(t)::text, '' ORDER BY t.task_id COLLATE "C")) FROM contribution_auto_tasks_arms() t),
  -- 逐件指紋：全欄雜湊對不上時，用它找出是哪幾件走樣（[task_id, md5(整列 jsonb 文字)]）
  'row_hashes', (SELECT json_agg(json_build_array(t.task_id, md5(to_jsonb(t)::text)) ORDER BY t.task_id COLLATE "C") FROM contribution_auto_tasks_arms() t),
  'elections', (SELECT json_agg(json_build_object('id', id, 'election_key', election_key, 'election_date', election_date, 'election_reason', election_reason, 'election_types', election_types, 'notice_date', notice_date)) FROM elections),
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
    'owner_mismatch', (SELECT coalesce(json_agg(row_to_json(x)), '[]'::json)::text FROM contribution_auto_tasks_owner_mismatch() x)
  )
) AS j;
