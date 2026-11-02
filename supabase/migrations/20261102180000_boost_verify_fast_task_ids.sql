-- /boost 逾時根因＋單一項目插隊（2026-11-02，正式環境 bug）
--   症狀：POST /boost 帶 politician_ids（或 kinds:["verify"]）回 internal_error「task_boost: canceling statement due to statement timeout」。
-- 根因（正式庫唯讀 EXPLAIN ANALYZE，2026-11-02）：task_boost_matches 的驗證那一半對每一筆待驗證貢獻（3,794 筆）呼叫 contribution_subject_politician；
--   它的 politician_elections 分支寫 `pe.id::TEXT = payload->>'target_id'`，對 id 做轉型 → 用不上 politician_elections_id_key，每筆掃一次整張表。
--   task_boost_matches 整體 9,654 毫秒（驗證那一半 9,548 毫秒；任務那一半 105 毫秒），PostgREST 的 statement_timeout 是 8 秒 → 每次逾時。
--   改成把 target_id 轉成整數去比（先用正則擋非數字，CASE 保證不會轉型出錯）→ 走索引，同一批 3,794 筆 20 毫秒。
-- 另：task_boost_matches 新增白名單條件 task_ids（佇列項的 task_id 陣列，含 verify:<貢獻 id>、auto:…、手動任務 id），可單獨使用，用來對單一項目插隊。
--   其餘（既有詞彙、驗證那一半、回傳）一字不動。
-- 附記：filter 的 task_types 對驗證票比的是 contribution_type（correction、roster_check…），不是母任務型別；
--   task_types:["region_mismatch"] 插不到驗證票是設計如此（昨天 #77～#81 matched_verifies＝0 的原因），要插驗證票請用 kinds／task_ids。

CREATE OR REPLACE FUNCTION contribution_subject_politician(p_payload jsonb)
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    uuid_or_null(p_payload->>'politician_id'),
    CASE p_payload->>'target_table'
      WHEN 'politicians' THEN uuid_or_null(p_payload->>'target_id')
      WHEN 'policies' THEN (SELECT p.politician_id FROM policies p WHERE p.id = uuid_or_null(p_payload->>'target_id'))
      WHEN 'politician_elections' THEN (SELECT pe.politician_id FROM politician_elections pe
                                         WHERE pe.id = CASE WHEN p_payload->>'target_id' ~ '^[0-9]{1,9}$' THEN (p_payload->>'target_id')::INT END)
      ELSE NULL
    END,
    uuid_or_null(p_payload->>'keep_id')
  );
$function$;

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
      CASE WHEN p_filter ? 'task_ids' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'task_ids')) END AS task_ids,
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
     AND (f.task_ids IS NULL OR s.task_id = ANY(f.task_ids))
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
