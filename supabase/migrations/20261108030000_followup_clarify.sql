-- Jev 釐清模糊的跟進任務（2026-11-08，維護者核准）
--   system-one?action=followups 從驗證備註／提交說明開出的 task_type=other 任務（created_by 'jev-followup'），標題只有
--   「核對這筆資料的參選紀錄（驗證者備註提到）」、target 只有 {followup_kind, followup_of_vote}。
--   新動作 system-one?action=followup_clarify 一張任務問 Jev 一次三題（問題類型／交件型別／是否已解決），
--   結果：已解決或其實沒問題（≥0.95）→ 關任務；有把握 → 改寫成具體指令並補 target.politician_id／politician_election_id；其餘只蓋「問過」的章。
--   釐清之後做重複檢查：同一筆貢獻同一類問題、同人物＋同動作已有結構化任務／自動缺口／名冊分組任務／待驗貢獻的，關掉。
--
-- 本檔只做四件事，都不碰資料表（人物、參選紀錄、政見…）：
--   1. jev_decisions.question 的 CHECK 加三個題名（clarify_kind／clarify_deliverable／clarify_resolved）
--   2. 讀取用的重複計畫函式（STABLE，只讀）：followup_exact_duplicates()、followup_duplicate_plan()
--   3. 寫 contribution_tasks 的兩支窄函式：followup_close()、followup_rewrite()——只動 created_by='jev-followup' 且 open 的任務；
--      關閉理由寫進 target.closed_reason（contribution_tasks 沒有理由欄）與說明末尾
--   4. pg_cron 每 10 分鐘叫一次（limit=30；不帶金鑰，跟 followups 同做法，成本由端點的批量上限守）
--
-- 重複的「動作」（act）跟 _shared/followup-clarify.ts 的 ClarifyAction 同一組：
--   add_profile／correct_politician／correct_candidacy／candidacy／reassign／merge／correct_policy

-- 1. 題名白名單
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget', 'followup', 'news_relevance', 'bio_education', 'bio_experience', 'ask_screen', 'clarify_kind', 'clarify_deliverable', 'clarify_resolved'));

-- 2. 小工具：安全轉型（壞字串回 NULL，不丟錯）
CREATE OR REPLACE FUNCTION followup_uuid(p_text TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::UUID END
$$;
CREATE OR REPLACE FUNCTION followup_int(p_text TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_text ~ '^[1-9][0-9]{0,8}$' THEN p_text::INTEGER END
$$;

-- 3. 同一筆貢獻、同一類問題的重複（釐清前就能做，省 Jev）：每組留一張（先留已改寫的，再留最早的）
CREATE OR REPLACE FUNCTION followup_exact_duplicates()
RETURNS TABLE (task_id UUID, keep_id UUID)
LANGUAGE sql STABLE AS $fn$
  WITH x AS (
    SELECT t.id, t.created_at, t.target->>'followup_kind' AS kind,
           (t.target #>> '{clarify,status}' = 'rewritten') AS rewritten,
           COALESCE(t.target->>'followup_of_contribution',
                    (SELECT v.contribution_id::TEXT FROM contribution_votes v WHERE v.id = followup_uuid(t.target->>'followup_of_vote'))) AS cid
      FROM contribution_tasks t
     WHERE t.status = 'open' AND t.created_by = 'jev-followup'
  ), r AS (
    SELECT x.id, first_value(x.id) OVER (PARTITION BY x.cid, x.kind ORDER BY x.rewritten DESC, x.created_at, x.id) AS keep
      FROM x WHERE x.cid IS NOT NULL AND x.kind IS NOT NULL
  )
  SELECT r.id, r.keep FROM r WHERE r.id <> r.keep
$fn$;
COMMENT ON FUNCTION followup_exact_duplicates IS '開著的 jev-followup 任務裡，同一筆底下貢獻＋同一個 followup_kind 的重複（保留已改寫的、其次最早的）。只讀。2026-11-08';

-- 4. 釐清後的重複計畫：已改寫（有動作）的 jev-followup 任務 vs 其他任務／缺口／待驗貢獻
CREATE OR REPLACE FUNCTION followup_duplicate_plan()
RETURNS TABLE (task_id UUID, keep_ref TEXT, reason TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH j AS (
    SELECT t.id, t.created_at,
           followup_uuid(t.target->>'politician_id') AS pid,
           followup_int(t.target->>'politician_election_id') AS pe,
           t.target #>> '{clarify,action}' AS act,
           COALESCE(t.target->>'followup_of_contribution',
                    (SELECT v.contribution_id::TEXT FROM contribution_votes v WHERE v.id = followup_uuid(t.target->>'followup_of_vote'))) AS cid
      FROM contribution_tasks t
     WHERE t.status = 'open' AND t.created_by = 'jev-followup'
       AND t.target #>> '{clarify,status}' = 'rewritten' AND t.target #>> '{clarify,action}' IS NOT NULL
  ), claims AS (
    -- (a) 自動缺口（task_dispatches）
    SELECT 'auto'::TEXT AS src, d.task_id AS ref, 'add_profile'::TEXT AS act, followup_uuid(d.target->>'politician_id') AS pid, NULL::INTEGER AS pe, NULL::TEXT AS cid
      FROM task_dispatches d WHERE d.task_id ~ '^auto:(profile_gap|profile_detail_gap):'
    UNION ALL
    SELECT 'auto', d.task_id, 'merge', followup_uuid(d.target #>> '{a,id}'), NULL, NULL
      FROM task_dispatches d WHERE d.task_id LIKE 'auto:duplicate_politician:%'
    UNION ALL
    SELECT 'auto', d.task_id, 'merge', followup_uuid(d.target #>> '{b,id}'), NULL, NULL
      FROM task_dispatches d WHERE d.task_id LIKE 'auto:duplicate_politician:%'
    UNION ALL
    SELECT 'auto', d.task_id, 'reassign', followup_uuid(d.target->>'politician_id'), followup_int(split_part(d.task_id, ':', 3)), NULL
      FROM task_dispatches d WHERE d.task_id ~ '^auto:candidacy_owner_mismatch:[0-9]+$'
    UNION ALL
    SELECT 'auto', d.task_id,
           CASE WHEN d.task_id LIKE 'auto:candidacy_source_missing:party:%' THEN 'correct_politician' ELSE 'candidacy' END,
           followup_uuid(d.target->>'politician_id'),
           followup_int(CASE WHEN d.task_id LIKE 'auto:candidacy_source_missing:party:%' THEN split_part(d.task_id, ':', 4) ELSE split_part(d.task_id, ':', 3) END), NULL
      FROM task_dispatches d WHERE d.task_id ~ '^auto:candidacy_source_missing:(party:)?[0-9]+$'
    UNION ALL
    SELECT 'auto', d.task_id, 'candidacy', followup_uuid(i->>'politician_id'), followup_int(i->>'politician_election_id'), NULL
      FROM task_dispatches d CROSS JOIN LATERAL jsonb_array_elements(d.target->'items') i
     WHERE d.task_id LIKE 'auto:candidacy_source_missing:cand_no%' AND jsonb_typeof(d.target->'items') = 'array'
    -- (b) 名冊分組任務（多人）
    UNION ALL
    SELECT 'roster', t.id::TEXT,
           CASE COALESCE(p->>'action', t.target->>'action')
             WHEN 'missing' THEN 'candidacy' WHEN 'cand_no' THEN 'candidacy'
             WHEN 'county' THEN 'correct_candidacy' WHEN 'town' THEN 'correct_candidacy' WHEN 'extra' THEN 'correct_candidacy'
             WHEN 'wrong_owner' THEN 'reassign' WHEN 'party' THEN 'correct_politician' WHEN 'dup' THEN 'merge' END,
           followup_uuid(p->>'politician_id'), followup_int(p->>'politician_election_id'), NULL
      FROM contribution_tasks t CROSS JOIN LATERAL jsonb_array_elements(t.target->'people') p
     WHERE t.status = 'open' AND t.target->>'origin' = 'roster_group' AND jsonb_typeof(t.target->'people') = 'array'
    -- 其他開著的手動任務（有明確型別的才比；type=other 的意思不明，不比）
    UNION ALL
    SELECT 'manual', t.id::TEXT,
           CASE t.task_type WHEN 'candidate_status_stale' THEN 'correct_candidacy' WHEN 'duplicate_politician' THEN 'merge'
                            WHEN 'candidacy_owner_mismatch' THEN 'reassign' WHEN 'candidacy_source_missing' THEN 'candidacy' WHEN 'profile_gap' THEN 'add_profile' END,
           followup_uuid(t.target->>'politician_id'), followup_int(t.target->>'politician_election_id'), NULL
      FROM contribution_tasks t
     WHERE t.status = 'open' AND t.created_by IS DISTINCT FROM 'jev-followup' AND COALESCE(t.target->>'origin', '') <> 'roster_group'
       AND t.task_type IN ('candidate_status_stale', 'duplicate_politician', 'candidacy_owner_mismatch', 'candidacy_source_missing', 'profile_gap')
    -- (c) 已經在做同一件事、還沒落庫的貢獻
    UNION ALL
    SELECT 'pending', c.id::TEXT, 'candidacy', followup_uuid(c.payload->>'politician_id'), NULL, c.id::TEXT
      FROM contributions c WHERE c.status IN ('pending', 'verified', 'disputed') AND c.contribution_type = 'candidacy'
    UNION ALL
    SELECT 'pending', c.id::TEXT, 'add_profile', followup_uuid(c.payload->>'politician_id'), NULL, c.id::TEXT
      FROM contributions c WHERE c.status IN ('pending', 'verified', 'disputed') AND c.contribution_type = 'politician'
    UNION ALL
    SELECT 'pending', c.id::TEXT,
           CASE c.payload->>'target_table' WHEN 'politicians' THEN 'correct_politician' ELSE 'correct_candidacy' END,
           CASE WHEN c.payload->>'target_table' = 'politicians' THEN followup_uuid(c.payload->>'target_id') END,
           CASE WHEN c.payload->>'target_table' = 'politician_elections' THEN followup_int(c.payload->>'target_id') END, c.id::TEXT
      FROM contributions c WHERE c.status IN ('pending', 'verified', 'disputed') AND c.contribution_type = 'correction'
       AND c.payload->>'target_table' IN ('politicians', 'politician_elections')
    UNION ALL
    SELECT 'pending', c.id::TEXT, 'reassign', followup_uuid(c.payload->>'from_politician_id'), followup_int(c.payload->>'politician_election_id'), c.id::TEXT
      FROM contributions c WHERE c.status IN ('pending', 'verified', 'disputed') AND c.contribution_type = 'reassign_candidacy'
    UNION ALL
    SELECT 'pending', c.id::TEXT, 'merge', followup_uuid(c.payload->>'keep_id'), NULL, c.id::TEXT
      FROM contributions c WHERE c.status IN ('pending', 'verified', 'disputed') AND c.contribution_type = 'merge_politician'
    UNION ALL
    SELECT 'pending', c.id::TEXT, 'merge', followup_uuid(c.payload->>'remove_id'), NULL, c.id::TEXT
      FROM contributions c WHERE c.status IN ('pending', 'verified', 'disputed') AND c.contribution_type = 'merge_politician'
  ), structured AS (
    SELECT DISTINCT ON (j.id) j.id, c.src || ':' || c.ref AS keep_ref
      FROM j JOIN claims c ON c.act = j.act
       AND ((j.pid IS NOT NULL AND c.pid = j.pid) OR (j.pe IS NOT NULL AND c.pe = j.pe))
       AND (j.pe IS NULL OR c.pe IS NULL OR j.pe = c.pe)
       AND c.cid IS DISTINCT FROM j.cid
     ORDER BY j.id, CASE c.src WHEN 'pending' THEN 0 WHEN 'auto' THEN 1 WHEN 'roster' THEN 2 ELSE 3 END, c.ref
  ), sibling AS (
    -- (a) 其他已釐清的 jev-followup：同人物＋同動作，留最早的
    SELECT DISTINCT ON (b.id) b.id, 'jev-followup:' || a.id::TEXT AS keep_ref
      FROM j b JOIN j a ON a.act = b.act AND a.id <> b.id
       AND ((b.pid IS NOT NULL AND a.pid = b.pid) OR (b.pe IS NOT NULL AND a.pe = b.pe))
       AND (b.pe IS NULL OR a.pe IS NULL OR a.pe = b.pe)
       AND (a.created_at, a.id) < (b.created_at, b.id)
     ORDER BY b.id, a.created_at, a.id
  )
  SELECT s.id, s.keep_ref, 'duplicate'::TEXT FROM structured s
  UNION ALL
  SELECT b.id, b.keep_ref, 'duplicate'::TEXT FROM sibling b WHERE NOT EXISTS (SELECT 1 FROM structured s WHERE s.id = b.id)
$fn$;
COMMENT ON FUNCTION followup_duplicate_plan IS '已釐清並改寫（target.clarify.status=rewritten、有動作）的開著的 jev-followup 任務，跟同人物＋同動作的其他任務重複的：自動缺口、名冊分組任務、有明確型別的手動任務、待驗貢獻（結構化的優先），其次是更早的另一張 jev-followup。只讀。2026-11-08';

-- 5. 窄的寫入函式：只動 jev-followup 且 open 的任務
CREATE OR REPLACE FUNCTION followup_close(p_task UUID, p_reason JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  UPDATE contribution_tasks
     SET status = 'closed', closed_at = now(),
         target = target || jsonb_build_object('closed_reason', p_reason || jsonb_build_object('at', now(), 'by', 'followup-clarify')),
         description = COALESCE(description, '') || E'\n\n【系統關閉】' || COALESCE(p_reason->>'text', p_reason->>'code', '')
   WHERE id = p_task AND status = 'open' AND created_by = 'jev-followup';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$$;
COMMENT ON FUNCTION followup_close IS '關掉一張開著的 jev-followup 任務，理由寫進 target.closed_reason 與說明末尾。只動 contribution_tasks。2026-11-08';

CREATE OR REPLACE FUNCTION followup_rewrite(p_task UUID, p_title TEXT, p_description TEXT, p_patch JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  UPDATE contribution_tasks
     SET title = COALESCE(p_title, title), description = COALESCE(p_description, description), target = target || COALESCE(p_patch, '{}'::JSONB)
   WHERE id = p_task AND status = 'open' AND created_by = 'jev-followup';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$$;
COMMENT ON FUNCTION followup_rewrite IS '改寫一張開著的 jev-followup 任務的標題／說明／target（p_patch 併進 target，標題與說明給 NULL 就不動）。只動 contribution_tasks。2026-11-08';

REVOKE ALL ON FUNCTION followup_exact_duplicates() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION followup_duplicate_plan() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION followup_close(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION followup_rewrite(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION followup_exact_duplicates() TO service_role;
GRANT EXECUTE ON FUNCTION followup_duplicate_plan() TO service_role;
GRANT EXECUTE ON FUNCTION followup_close(UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION followup_rewrite(UUID, TEXT, TEXT, JSONB) TO service_role;

-- 6. 排程：每 10 分鐘 30 張（約 $0.006／輪；2,000 多張約 12 小時清完，之後只剩新進的）
SELECT cron.unschedule('system-one-followup-clarify-10min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-followup-clarify-10min');
SELECT cron.schedule(
  'system-one-followup-clarify-10min',
  '3,13,23,33,43,53 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=followup_clarify&limit=30',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
