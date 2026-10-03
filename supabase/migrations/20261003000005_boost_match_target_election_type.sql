-- 插隊的「選舉別」條件也看項目自己標的選舉別（2026-10-03）
--
-- 名單清查（roster_check）這類任務沒有主角人物，選舉別寫在 target.election_type。
-- 原本 election_types 只透過人物的參選紀錄比對，沒有人物的項目永遠對不上：
-- 10-03 插隊「2026 鄉鎮市長・原住民區長 名單清查」回 matched_tasks 0（17 筆任務明明在快照裡）。
-- 改成：項目自己標的選舉別對得上，或主角人物有那種參選紀錄，兩者其一即可。其餘條件不動。

CREATE OR REPLACE FUNCTION task_boost_matches(p_filter JSONB)
RETURNS TABLE (task_id TEXT, kind TEXT)
LANGUAGE sql STABLE AS $$
  WITH f AS (
    SELECT
      CASE WHEN p_filter ? 'regions' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'regions')) END AS regions,
      NULLIF(p_filter->>'election_id', '')::INT AS election_id,
      CASE WHEN p_filter ? 'election_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'election_types')) END AS election_types,
      CASE WHEN p_filter ? 'task_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'task_types')) END AS task_types,
      COALESCE((p_filter->>'missing_avatar')::BOOLEAN, false) AS missing_avatar,
      CASE WHEN p_filter ? 'politician_ids' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'politician_ids')::UUID) END AS politician_ids,
      COALESCE(CASE WHEN p_filter ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'kinds')) END, ARRAY['task', 'verify']) AS kinds
  ),
  subjects AS (
    -- 每一個佇列項目的主角、縣市、屆別、型別
    SELECT g.task_id, 'task'::TEXT AS kind, g.task_type AS type_key,
           uuid_or_null(g.target->>'politician_id') AS politician_id,
           COALESCE(g.region, g.target->>'region') AS region,
           year_or_null(g.target->>'election_id') AS election_id,
           g.target->>'election_type' AS election_type
      FROM contribution_auto_tasks_arms() g
    UNION ALL
    SELECT t.id::TEXT, 'task', t.task_type,
           uuid_or_null(t.target->>'politician_id'),
           COALESCE(t.region, t.target->>'region'),
           year_or_null(t.target->>'election_id'),
           t.target->>'election_type'
      FROM contribution_tasks t WHERE t.status = 'open'
    UNION ALL
    SELECT 'verify:' || c.id, 'verify', c.contribution_type,
           contribution_subject_politician(c.payload),
           c.payload->>'region',
           year_or_null(c.payload->>'election_id'),
           c.payload->>'election_type'
      FROM contributions c WHERE c.status = 'pending'
  )
  SELECT s.task_id, s.kind
    FROM subjects s
    CROSS JOIN f
    LEFT JOIN politicians p ON p.id = s.politician_id
   WHERE s.kind = ANY(f.kinds)
     AND (f.task_types IS NULL OR s.type_key = ANY(f.task_types))
     AND (f.politician_ids IS NULL OR s.politician_id = ANY(f.politician_ids))
     AND (NOT f.missing_avatar OR (p.id IS NOT NULL AND COALESCE(p.avatar_url, '') = ''))
     AND (f.regions IS NULL OR COALESCE(s.region, p.region) = ANY(f.regions))
     AND (f.election_id IS NULL OR s.election_id = f.election_id
          OR (s.election_id IS NULL AND p.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM politician_elections pe WHERE pe.politician_id = p.id AND pe.election_id = f.election_id)))
     AND (f.election_types IS NULL OR s.election_type = ANY(f.election_types) OR (p.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM politician_elections pe
             WHERE pe.politician_id = p.id AND pe.election_type::TEXT = ANY(f.election_types)
               AND (f.election_id IS NULL OR pe.election_id = f.election_id))));
$$;
