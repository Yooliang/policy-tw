-- history 函式（查核履歷）改單一 RPC：每次請求約 20 次內部 REST 降為 1 次
-- （Edge Function 內部 REST 瘦身 第 1 期 PR-1；設計見 docs/function-rest-slim-plan.md 第 5.1 節）。
--
-- history_bundle(p_target, p_id, p_limit) 一次撈齊 supabase/functions/_shared/history.ts 現在分多次查的資料，
-- 回傳與各查詢結果一一對應的 jsonb；TS 端只做原本的組裝（buildHistory、describeOrigin、buildWebRequests），輸出不變。
--
-- 回傳形狀：
--   limit           夾在 0～100 之後的 p_limit（保留欄位；分頁仍在 TS 端 buildHistory 之後做，total 要看全部）
--   contributions   履歷上的貢獻（HISTORY_ENTRY_COLUMNS 的欄位，含 score、effective_agree）：
--                   直接掛、payload 引用、correction、經 edit_history 補撈，去重
--   votes           contribution_votes（VOTE_COLUMNS）
--   edits           edit_history（EDIT_COLUMNS），依貢獻 id
--   adjudications   裁決貢獻（CONTRIBUTION_COLUMNS，不含分數欄）
--   tasks           task_type=adjudicate 的任務
--   summary         摘要用的名稱對照原料：politicians／policies／lineages／parties／elections／regions／originals
--   source_briefs   交件 source_urls 在出處表的等級與存檔網址（source_briefs() 的列）
--   origin_row      來源說明用的那一列（政見：含出處清單；人物：id、name；貢獻：null）
--   election_notes  人物的參選紀錄來源備註
--   web_requests    {rows, parked, reports}：網站請求任務、停放中的任務 id、掛在這些任務上的貢獻
--
-- 權限：history 函式用 service_role 讀（RLS 本來就放行），所以 RPC 只給 service_role，與現況同等；
-- SECURITY INVOKER（唯讀 RPC 不需要提權，docs/function-rest-slim-plan.md 第 7 節）。
-- Supabase 預設把新函式的 EXECUTE 開給 anon／authenticated，所以要明寫 REVOKE，不能只收 PUBLIC。
-- 不回 ip_hash：欄位清單與 history.ts 的 CONTRIBUTION_COLUMNS／VOTE_COLUMNS／EDIT_COLUMNS 一致。
--
-- 回滾：DROP FUNCTION history_bundle(text, text, int), history_json_uuid(jsonb), history_json_num(jsonb);
--       舊路徑還在（TS 端在 RPC 回錯時退回多次查詢），所以不需要先改程式。

-- ------------------------------------------------------------
-- 1. 小工具：從 payload 的欄位取 uuid／整數（與 summary-lookup.ts 的 uuid()／num() 同一套規則）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION history_json_uuid(j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(j) = 'string'
               AND (j #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN lower(j #>> '{}') END
$$;

CREATE OR REPLACE FUNCTION history_json_num(j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp AS $$
  SELECT CASE jsonb_typeof(j)
           WHEN 'number' THEN CASE WHEN (j #>> '{}')::numeric = trunc((j #>> '{}')::numeric) AND abs((j #>> '{}')::numeric) < 1e15
                                   THEN trunc((j #>> '{}')::numeric)::bigint::text END
           WHEN 'string' THEN CASE WHEN (j #>> '{}') ~ '^[0-9]{1,18}$' THEN ((j #>> '{}')::bigint)::text END
         END
$$;

-- ------------------------------------------------------------
-- 2. history_bundle
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION history_bundle(p_target text, p_id text, p_limit int DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
SET statement_timeout = '8s'
AS $$
DECLARE
  v_uuid uuid;
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 0), 100);
  v_main text;
  v_child text;
  v_ids uuid[];
  v_contribs jsonb;
  v_votes jsonb;
  v_edits jsonb;
  v_adjs jsonb;
  v_tasks jsonb;
  v_summary jsonb;
  v_briefs jsonb;
  v_origin jsonb := 'null'::jsonb;
  v_notes jsonb := '[]'::jsonb;
  v_web jsonb := jsonb_build_object('rows', '[]'::jsonb, 'parked', '[]'::jsonb, 'reports', '[]'::jsonb);
  v_urls text[];
  v_task_ids text[];
  v_rows jsonb;
  v_parked jsonb;
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('politician', 'policy', 'contribution') THEN
    RAISE EXCEPTION 'history_bundle: unsupported target %', p_target USING ERRCODE = '22023';
  END IF;
  v_uuid := p_id::uuid;
  v_main := CASE p_target WHEN 'policy' THEN 'policies' ELSE 'politicians' END;
  v_child := CASE p_target WHEN 'policy' THEN 'tracking_logs' ELSE 'politician_elections' END;

  -- 1. 履歷上的貢獻 id（有序：直接掛、payload 引用、correction、經修改紀錄補撈；同一筆只留最先出現的）
  IF p_target = 'contribution' THEN
    SELECT array_agg(c.id) INTO v_ids FROM (SELECT id FROM contributions WHERE id = v_uuid LIMIT 1) c;
  ELSE
    WITH s1 AS (
      (SELECT c.id, 1 AS seg, c.created_at FROM contributions c WHERE p_target = 'policy' AND c.applied_policy_id = v_uuid ORDER BY c.created_at DESC LIMIT 500)
      UNION ALL
      (SELECT c.id, 1, c.created_at FROM contributions c WHERE p_target = 'politician' AND c.applied_politician_id = v_uuid ORDER BY c.created_at DESC LIMIT 500)
    ), s2 AS (
      (SELECT c.id, 2 AS seg, c.created_at FROM contributions c WHERE p_target = 'policy' AND c.payload->>'policy_id' = p_id ORDER BY c.created_at DESC LIMIT 500)
      UNION ALL
      (SELECT c.id, 2, c.created_at FROM contributions c WHERE p_target = 'politician' AND c.payload->>'politician_id' = p_id ORDER BY c.created_at DESC LIMIT 500)
    ), s3 AS (
      SELECT c.id, 3 AS seg, c.created_at FROM contributions c
       WHERE c.contribution_type = 'correction' AND c.payload->>'target_table' = v_main AND c.payload->>'target_id' = p_id
       ORDER BY c.created_at DESC LIMIT 500
    ), children AS (
      (SELECT pe.id::text AS rid FROM politician_elections pe WHERE p_target = 'politician' AND pe.politician_id = v_uuid LIMIT 500)
      UNION ALL
      (SELECT tl.id::text FROM tracking_logs tl WHERE p_target = 'policy' AND tl.policy_id = v_uuid LIMIT 500)
    ), em AS (
      SELECT e.contribution_id, e.id AS eid FROM edit_history e WHERE e.table_name = v_main AND e.record_id = p_id ORDER BY e.id LIMIT 500
    ), ec AS (
      SELECT e.contribution_id, e.id AS eid FROM edit_history e
       WHERE e.table_name = v_child AND e.record_id = ANY (ARRAY(SELECT rid FROM children)) ORDER BY e.id LIMIT 500
    ), s4 AS (
      SELECT c.id, 4 AS seg, c.created_at
        FROM (SELECT contribution_id, eid FROM em UNION ALL SELECT contribution_id, eid FROM ec) x
        JOIN contributions c ON c.id = x.contribution_id
    ), allc AS (
      SELECT DISTINCT ON (id) id, seg, created_at FROM (
        SELECT * FROM s1 UNION ALL SELECT * FROM s2 UNION ALL SELECT * FROM s3 UNION ALL SELECT * FROM s4
      ) u ORDER BY id, seg
    )
    SELECT array_agg(id ORDER BY seg, created_at DESC, id) INTO v_ids FROM allc;
  END IF;
  v_ids := COALESCE(v_ids, '{}'::uuid[]);

  -- 2. 貢獻本體（與 PostgREST 計算欄位 effective_agree 同一個函式）
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id, 'contribution_type', c.contribution_type, 'payload', c.payload, 'source_urls', to_jsonb(c.source_urls),
           'note', c.note, 'agent_name', c.agent_name, 'agent_tool', c.agent_tool, 'status', c.status, 'review_notes', c.review_notes,
           'applied_at', c.applied_at, 'applied_politician_id', c.applied_politician_id, 'applied_policy_id', c.applied_policy_id,
           'created_at', c.created_at, 'agree_count', c.agree_count, 'disagree_count', c.disagree_count, 'unsure_count', c.unsure_count,
           'task_id', c.task_id, 'score', c.score, 'effective_agree', contribution_effective_agree(c.id)
         ) ORDER BY u.ord), '[]'::jsonb)
    INTO v_contribs
    FROM unnest(v_ids) WITH ORDINALITY u(id, ord) JOIN contributions c ON c.id = u.id;

  -- 3. 票、修改紀錄、裁決貢獻、裁決任務
  SELECT COALESCE(jsonb_agg(to_jsonb(v)), '[]'::jsonb) INTO v_votes FROM (
    SELECT cv.contribution_id, cv.verdict, cv.note, cv.evidence_url, cv.agent_name, cv.agent_tool, cv.resolved_politician_id, cv.created_at
      FROM contribution_votes cv WHERE cv.contribution_id = ANY (v_ids) ORDER BY cv.created_at LIMIT 1000) v;
  SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) INTO v_edits FROM (
    SELECT eh.id, eh.contribution_id, eh.table_name, eh.record_id, eh.field, eh.old_value, eh.new_value, eh.applied_at, eh.reverted_at, eh.reverted_by
      FROM edit_history eh WHERE eh.contribution_id = ANY (v_ids) ORDER BY eh.id LIMIT 1000) e;
  SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]'::jsonb) INTO v_adjs FROM (
    SELECT c.id, c.contribution_type, c.payload, c.source_urls, c.note, c.agent_name, c.agent_tool, c.status, c.review_notes,
           c.applied_at, c.applied_politician_id, c.applied_policy_id, c.created_at, c.agree_count, c.disagree_count, c.unsure_count, c.task_id
      FROM contributions c
     WHERE c.contribution_type = 'adjudication' AND c.payload->>'contribution_id' = ANY (v_ids::text[])
     ORDER BY c.created_at LIMIT 500) a;
  SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tasks FROM (
    SELECT ct.id, ct.task_type, ct.status, ct.target, ct.created_at, ct.closed_at
      FROM contribution_tasks ct
     WHERE ct.task_type = 'adjudicate' AND ct.target->>'contribution_id' = ANY (v_ids::text[])
     ORDER BY ct.created_at LIMIT 500) t;

  -- 4. 摘要用的名稱對照原料（規則同 summary-lookup.ts 的 collectSummaryIds／loadSummaryLookup）
  WITH src AS (
    SELECT c.contribution_type, c.payload, c.applied_politician_id, c.applied_policy_id FROM contributions c WHERE c.id = ANY (v_ids)
  ), first_adj AS (
    SELECT DISTINCT history_json_uuid(s.payload->'contribution_id')::uuid AS id FROM src s
     WHERE s.contribution_type = 'adjudication' AND history_json_uuid(s.payload->'contribution_id') IS NOT NULL
  ), originals AS (
    SELECT c.id, c.contribution_type, c.payload, c.applied_politician_id, c.applied_policy_id FROM contributions c WHERE c.id IN (SELECT id FROM first_adj)
  ), allsrc AS (
    SELECT contribution_type, payload, applied_politician_id, applied_policy_id FROM src
    UNION ALL
    SELECT contribution_type, payload, applied_politician_id, applied_policy_id FROM originals
  ), pairs AS (
    SELECT 'pol'::text AS k, s.applied_politician_id::text AS v FROM allsrc s WHERE s.applied_politician_id IS NOT NULL
    UNION ALL SELECT 'pol', history_json_uuid(s.payload->kk) FROM allsrc s CROSS JOIN unnest(ARRAY['politician_id', 'to_politician_id', 'from_politician_id', 'keep_id', 'remove_id']) kk
    UNION ALL SELECT 'pol', history_json_uuid(s.payload->'target_id') FROM allsrc s WHERE s.payload->>'target_table' = 'politicians'
    UNION ALL SELECT 'pcy', s.applied_policy_id::text FROM allsrc s WHERE s.applied_policy_id IS NOT NULL
    UNION ALL SELECT 'pcy', history_json_uuid(s.payload->'policy_id') FROM allsrc s
    UNION ALL SELECT 'pcy', history_json_uuid(s.payload->'target_id') FROM allsrc s WHERE s.payload->>'target_table' = 'policies'
    UNION ALL SELECT 'ele', history_json_num(s.payload->'target_id') FROM allsrc s WHERE s.payload->>'target_table' = 'politician_elections'
    UNION ALL SELECT 'ele', history_json_num(s.payload->'politician_election_id') FROM allsrc s
    UNION ALL SELECT 'lin', history_json_uuid(s.payload->kk) FROM allsrc s CROSS JOIN unnest(ARRAY['lineage_id', 'upper_lineage_id', 'lower_lineage_id']) kk
    UNION ALL SELECT 'par', history_json_num(it->kk) FROM allsrc s
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.payload->'parties') = 'array' THEN s.payload->'parties' ELSE '[]'::jsonb END) it
      CROSS JOIN unnest(ARRAY['party_id', 'predecessor_id']) kk
    -- 履歷的 party_id 變更要顯示政黨名稱：edit_history 裡的數字
    UNION ALL SELECT 'par', CASE WHEN jsonb_typeof(e->side) = 'number' THEN history_json_num(e->side) END
      FROM jsonb_array_elements(v_edits) e CROSS JOIN unnest(ARRAY['old_value', 'new_value']) side WHERE e->>'field' = 'party_id'
    UNION ALL SELECT 'reg', s.payload->>'admin_code' FROM allsrc s
     WHERE jsonb_typeof(s.payload->'admin_code') = 'string' AND s.payload->>'admin_code' ~ '^[0-9]+$'
  ), pol AS (
    SELECT x.id, x.name FROM politicians x WHERE x.id IN (SELECT v::uuid FROM pairs WHERE k = 'pol' AND v IS NOT NULL)
  ), pcy AS (
    SELECT x.id, x.title FROM policies x WHERE x.id IN (SELECT v::uuid FROM pairs WHERE k = 'pcy' AND v IS NOT NULL)
  ), lin AS (
    SELECT x.id, x.title FROM lineages x WHERE x.id IN (SELECT v::uuid FROM pairs WHERE k = 'lin' AND v IS NOT NULL)
  ), par AS (
    SELECT x.id, x.name FROM parties x WHERE x.id IN (SELECT v::bigint FROM pairs WHERE k = 'par' AND v IS NOT NULL)
  ), ele AS (
    SELECT pe.id, pe.election_id, pe.election_type, p.name AS politician_name
      FROM politician_elections pe LEFT JOIN politicians p ON p.id = pe.politician_id
     WHERE pe.id IN (SELECT v::bigint FROM pairs WHERE k = 'ele' AND v IS NOT NULL)
  ), reg AS (
    SELECT d.code, d.county, d.town, d.village FROM admin_divisions d WHERE d.code IN (SELECT v FROM pairs WHERE k = 'reg' AND v IS NOT NULL)
  )
  SELECT jsonb_build_object(
    'politicians', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name)) FROM pol), '[]'::jsonb),
    'policies', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'title', title)) FROM pcy), '[]'::jsonb),
    'lineages', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'title', title)) FROM lin), '[]'::jsonb),
    'parties', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name)) FROM par), '[]'::jsonb),
    'elections', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'election_id', election_id, 'election_type', election_type, 'politician_name', politician_name)) FROM ele), '[]'::jsonb),
    'regions', COALESCE((SELECT jsonb_agg(jsonb_build_object('code', code, 'county', county, 'town', town, 'village', village)) FROM reg), '[]'::jsonb),
    'originals', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'contribution_type', contribution_type, 'payload', payload,
                   'applied_politician_id', applied_politician_id, 'applied_policy_id', applied_policy_id)) FROM originals), '[]'::jsonb)
  ) INTO v_summary;

  -- 5. 交件網址在出處表的等級與存檔網址
  SELECT COALESCE(array_agg(DISTINCT u.url), '{}'::text[]) INTO v_urls FROM (
    SELECT regexp_replace(x, '^\s+|\s+$', '', 'g') AS url
      FROM contributions c CROSS JOIN LATERAL unnest(COALESCE(c.source_urls, '{}'::text[])) x
     WHERE c.id = ANY (v_ids)) u
   WHERE u.url <> '';
  SELECT COALESCE(jsonb_agg(to_jsonb(b)), '[]'::jsonb) INTO v_briefs FROM source_briefs(v_urls) b;

  -- 6. 來源說明用的那一列
  IF p_target = 'policy' THEN
    SELECT to_jsonb(r) INTO v_origin FROM (SELECT id, title, ai_extracted, proposed_date FROM policies WHERE id = v_uuid) r;
    IF v_origin IS NOT NULL THEN
      v_origin := v_origin || jsonb_build_object('sources', source_brief_list('policies', p_id)::jsonb);
    ELSE
      v_origin := 'null'::jsonb;
    END IF;
  ELSIF p_target = 'politician' THEN
    SELECT COALESCE(to_jsonb(r), 'null'::jsonb) INTO v_origin FROM (SELECT id, name FROM politicians WHERE id = v_uuid) r;
    SELECT COALESCE(jsonb_agg(n.source_note), '[]'::jsonb) INTO v_notes FROM (
      SELECT pe.source_note FROM politician_elections pe
       WHERE pe.politician_id = v_uuid AND pe.source_note IS NOT NULL AND pe.source_note <> '' LIMIT 50) n;
  END IF;
  v_origin := COALESCE(v_origin, 'null'::jsonb);

  -- 7. 網站請求（只有人物與政見）
  IF p_target IN ('politician', 'policy') THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_rows FROM (
      SELECT ct.id, ct.task_type, ct.status, ct.created_at, ct.closed_at FROM contribution_tasks ct
       WHERE ct.source = 'web_request'
         AND ct.target->>(CASE p_target WHEN 'policy' THEN 'policy_id' ELSE 'politician_id' END) = p_id
       ORDER BY ct.created_at DESC LIMIT 30) t;
    SELECT COALESCE(array_agg(r->>'id'), '{}'::text[]) INTO v_task_ids FROM jsonb_array_elements(v_rows) r;
    SELECT COALESCE(jsonb_agg(r->'id'), '[]'::jsonb) INTO v_parked FROM jsonb_array_elements(v_rows) r
     WHERE r->>'status' = 'open' AND web_request_parked((r->>'id')::uuid);
    v_web := jsonb_build_object('rows', v_rows, 'parked', v_parked, 'reports', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)) FROM (
        (SELECT c.id, c.task_id, c.payload, c.contribution_type, c.status, c.created_at, c.agent_name
           FROM contributions c WHERE c.task_id = ANY (v_task_ids) LIMIT 200)
        UNION ALL
        (SELECT c.id, c.task_id, c.payload, c.contribution_type, c.status, c.created_at, c.agent_name
           FROM contributions c WHERE c.contribution_type = 'no_change' AND c.task_id IS NULL AND c.payload->>'task_id' = ANY (v_task_ids) LIMIT 200)
      ) x), '[]'::jsonb));
  END IF;

  RETURN jsonb_build_object(
    'limit', v_limit, 'contributions', v_contribs, 'votes', v_votes, 'edits', v_edits, 'adjudications', v_adjs, 'tasks', v_tasks,
    'summary', v_summary, 'source_briefs', v_briefs, 'origin_row', v_origin, 'election_notes', v_notes, 'web_requests', v_web
  );
END
$$;

COMMENT ON FUNCTION history_bundle(text, text, int) IS
  '查核履歷一次撈齊（history 函式用，2026-11-27）：回傳形狀見本檔檔頭。唯讀、SECURITY INVOKER、只給 service_role。TS 端 RPC 出錯會退回多次查詢的舊路徑。';

-- 權限：Supabase 預設會把新函式開給 anon／authenticated，要明寫收回
REVOKE ALL ON FUNCTION history_bundle(text, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION history_bundle(text, text, int) TO service_role;
REVOKE ALL ON FUNCTION history_json_uuid(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION history_json_uuid(jsonb) TO service_role;
REVOKE ALL ON FUNCTION history_json_num(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION history_json_num(jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';
