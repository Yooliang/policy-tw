-- 插隊端點 /boost 逾時（工作單 Yooliang/policy-ops#71，2026-10-10）
-- 主線照維護者指示插隊「早期匯入核對 47 筆」（filter {task_types:["legacy_audit"]}）連兩次 500 statement timeout。
-- 唯讀量測（10-10）：task_boost 開頭的 seed_auto_task_queue() 近 6 小時平均 3.3 秒、最慢 8.0 秒；
-- task_boost_matches 展開整張派工總表 contribution_auto_tasks_arms() 約 3.0 秒；PostgREST 的 statement_timeout 是 8 秒。
-- 做法：task_boost_matches 的任務那一半改讀佇列 task_dispatches（seed 寫進去的同一份 task_type／target／region），
-- 其餘（篩選詞彙、驗證那一半、回傳）一字不動（task-boost-fast.test.ts 逐字比對前一版＋這一處替換）。
-- task_boost 本身不動（日本站 policy-jp-boost.test.ts 拿它跟日本版對骨架）；它開頭的 seed 照舊，新出生的缺口一樣插得到。

CREATE OR REPLACE FUNCTION task_boost_matches(p_filter jsonb)
RETURNS TABLE(task_id text, kind text)
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
    -- 任務直接讀佇列 task_dispatches（seed 每 10 分鐘把總表寫進來，同一份 task_type／target／region），不再重算整張派工總表：
    -- 總表一次約 3 秒，加上 task_boost 開頭的 seed，插隊超過 8 秒的逾時（OPS #71，2026-10-10）
    SELECT g.task_id, 'task'::TEXT AS kind, g.task_type AS type_key,
           uuid_or_null(g.target->>'politician_id') AS politician_id,
           COALESCE(g.region, g.target->>'region') AS region,
           election_id_or_null(g.target->>'election_id') AS election_id,
           g.target->>'election_type' AS election_type
      FROM task_dispatches g WHERE g.task_id NOT LIKE 'verify:%'
    UNION ALL
    SELECT 'verify:' || c.id, 'verify', c.contribution_type,
           contribution_subject_politician(c.payload),
           c.payload->>'region',
           election_id_or_null(c.payload->>'election_id'),
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
