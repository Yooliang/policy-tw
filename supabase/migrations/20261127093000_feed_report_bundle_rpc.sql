-- contributions-feed 與 report 的讀取改單一 RPC（Edge Function 內部 REST 瘦身 第 1 期 PR-2；
-- 設計見 docs/function-rest-slim-plan.md 第 5.2、5.3 節；PR-1 的做法見 20261127073000_history_bundle_rpc.sql）。
--
-- 兩支 RPC，TS 端出錯會自己退回原本的多次查詢（回傳形狀不對、函式不存在、例外都退）：
--
-- 1. contributions_feed_bundle(p_params jsonb)：contributions-feed 一次請求原本約 6～10 次 REST
--    （清單、第一頁的筆數與統計、名稱對照兩輪、出處摘要），合成 1 次。
--    p_params：status, agent_name, actor_id, type, limit（夾 1～50）, cursor, want_count, want_summary（缺的當預設）。
--    回傳：rows（多撈一筆判斷 has_more，欄位同 FEED_COLUMNS）、total（want_count 才有，否則 null）、
--          summary（want_summary 才有 contribution_feed_summary() 的結果，否則 null）、
--          lookup（名稱對照原料，形狀同 history_bundle 的 summary，只對前 limit 筆）、source_briefs（前 limit 筆的出處摘要）。
--
-- 2. report_context_bundle(p_kind text, p_params jsonb)：report 的讀取端。只合併「讀」，寫入一個字沒動。
--    p_kind＝verify_pre：驗證投票前要讀的（額度計數、被驗貢獻、裁決的原貢獻、派工綁定、既有票、自己上一票的備註）
--      p_params：contribution_id, quota_column（actor_id｜verifier_ip_hash）, quota_value, window_start,
--                want_original（貢獻是裁決時 TS 端不知道型別，所以 SQL 端自己判斷，這個旗標固定 true）,
--                binding（{ip_hash}，null＝不查；時限寫死 7 天＝VERIFY_BINDING_DAYS）, prev（{column: actor_id｜agent_name, value}，null＝不查）
--      回傳：used, contribution（null＝查無）, original, dispatched（0 或 1 列）,
--            existing（這筆的全部票：id, agent_name, actor_id, verifier_ip_hash, note, verdict, resolved_politician_id；
--            verdict 與 resolved_politician_id 給 identity-pick-gate 的「已有人指認」用）, prev（最近一張票的 note 或 null）
--    p_kind＝verify_post：投票後重讀（貢獻最新狀態與分數、目標分數 contribution_effective_agree）
--      p_params：contribution_id；回傳：after（null＝查無）, effective（int 或 null）
--    p_kind＝contribute_pre：交件前要讀的（額度計數、這批任務的型別與多人任務內容、同 IP 在排隊的貢獻）
--      p_params：quota_column（actor_id｜contributor_ip_hash）, quota_value, window_start, task_ids（uuid 字串，最多 400 個）,
--                inflight_task_ids（含 auto: 的完整 task_id）, ip_hash
--      回傳：used, tasks（[{id, task_type, multi_person, target（只有 multi_person 才帶）}]）, in_flight（同 IP 排隊中的 task_id）
--
-- 權限：SECURITY INVOKER、只給 service_role（report／contributions-feed 都用 service role 讀，RLS 本來就放行），
-- 不開給 anon／authenticated（Supabase 預設會開，要明寫 REVOKE）；SET statement_timeout = '8s'；limit 夾 100／50。
-- 不回 ip_hash 以外的敏感欄位：verify_pre 回的 contributor_ip_hash、verifier_ip_hash 是 verify-handler 現在就在讀、拿來比對本人用的，
-- 只在函式內部 TS 使用，不進回應（與現況同）。
--
-- 回滾：DROP FUNCTION contributions_feed_bundle(jsonb), report_context_bundle(text, jsonb), feed_summary_material(uuid[]);
--       舊路徑還在，不需要先改程式。

-- ------------------------------------------------------------
-- 1. 名稱對照原料（規則同 summary-lookup.ts 的 collectSummaryIds／loadSummaryLookup；history_bundle 第 4 段同一套，這裡沒有修改紀錄）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION feed_summary_material(p_ids uuid[]) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH src AS (
    SELECT c.contribution_type, c.payload, c.applied_politician_id, c.applied_policy_id FROM contributions c WHERE c.id = ANY (p_ids)
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
  )
$$;

-- ------------------------------------------------------------
-- 2. contributions_feed_bundle
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contributions_feed_bundle(p_params jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
SET statement_timeout = '8s'
AS $$
DECLARE
  v_status text := COALESCE(NULLIF(p_params->>'status', ''), 'all');
  v_agent text := NULLIF(p_params->>'agent_name', '');
  v_actor text := NULLIF(p_params->>'actor_id', '');
  v_type text := NULLIF(p_params->>'type', '');
  v_limit int := LEAST(GREATEST(COALESCE((p_params->>'limit')::int, 20), 1), 50);
  v_cursor timestamptz := NULLIF(p_params->>'cursor', '')::timestamptz;
  v_want_count boolean := COALESCE((p_params->>'want_count')::boolean, false);
  v_want_summary boolean := COALESCE((p_params->>'want_summary')::boolean, false);
  v_rows jsonb;
  v_page_ids uuid[];
  v_total bigint := NULL;
  v_summary jsonb := NULL;
  v_urls text[];
  v_briefs jsonb;
BEGIN
  -- 清單：多撈一筆判斷 has_more（欄位同 contributions-feed 的 FEED_COLUMNS，含 score、effective_agree）。
  -- 篩選規則逐項對應 index.ts：attention＝ATTENTION_STATUSES（disputed）；voting＝pending 且任一票數 > 0 或分數 <> 0
  WITH filtered AS (
    SELECT c.* FROM contributions c
     WHERE (v_status <> 'attention' OR c.status = ANY (ARRAY['disputed']))
       AND (v_status <> 'voting' OR (c.status = 'pending' AND (c.agree_count > 0 OR c.disagree_count > 0 OR c.unsure_count > 0 OR c.score <> 0)))
       AND (v_status IN ('all', 'attention', 'voting') OR c.status = v_status)
       AND (v_agent IS NULL OR c.agent_name = v_agent)
       AND (v_actor IS NULL OR c.actor_id = v_actor)
       AND (v_type IS NULL OR c.contribution_type = v_type)
       AND (v_cursor IS NULL OR c.last_activity_at < v_cursor)
  ), page AS (
    SELECT f.* FROM filtered f ORDER BY f.last_activity_at DESC LIMIT v_limit + 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', p.id, 'contribution_type', p.contribution_type, 'payload', p.payload, 'status', p.status,
           'score', p.score, 'effective_agree', contribution_effective_agree(p.id),
           'agree_count', p.agree_count, 'disagree_count', p.disagree_count, 'unsure_count', p.unsure_count,
           'agent_name', p.agent_name, 'agent_tool', p.agent_tool, 'source_urls', to_jsonb(p.source_urls), 'note', p.note,
           'task_id', p.task_id, 'created_at', p.created_at, 'applied_at', p.applied_at, 'review_notes', p.review_notes,
           'applied_politician_id', p.applied_politician_id, 'applied_policy_id', p.applied_policy_id,
           'last_activity_at', p.last_activity_at, 'last_activity', p.last_activity
         ) ORDER BY p.last_activity_at DESC), '[]'::jsonb)
    INTO v_rows FROM page p;

  IF v_want_count THEN
    SELECT count(*) INTO v_total FROM contributions c
     WHERE (v_status <> 'attention' OR c.status = ANY (ARRAY['disputed']))
       AND (v_status <> 'voting' OR (c.status = 'pending' AND (c.agree_count > 0 OR c.disagree_count > 0 OR c.unsure_count > 0 OR c.score <> 0)))
       AND (v_status IN ('all', 'attention', 'voting') OR c.status = v_status)
       AND (v_agent IS NULL OR c.agent_name = v_agent)
       AND (v_actor IS NULL OR c.actor_id = v_actor)
       AND (v_type IS NULL OR c.contribution_type = v_type)
       AND (v_cursor IS NULL OR c.last_activity_at < v_cursor);
  END IF;
  IF v_want_summary THEN
    v_summary := contribution_feed_summary();
  END IF;

  -- 名稱對照與出處摘要只對「前 limit 筆」（第 limit+1 筆只用來判斷有沒有下一頁，不顯示）
  SELECT COALESCE(array_agg((r->>'id')::uuid ORDER BY ord), '{}'::uuid[]) INTO v_page_ids
    FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(r, ord) WHERE ord <= v_limit;

  -- 出處網址：依頁面順序、去前後空白與空字串、去重、最多 500 個（同 fetchSourceBriefs）
  SELECT COALESCE(array_agg(u.url ORDER BY u.first_ord), '{}'::text[]) INTO v_urls FROM (
    SELECT x.url, min(x.ord) AS first_ord FROM (
      SELECT regexp_replace(w.u, '^\s+|\s+$', '', 'g') AS url, (t.ord * 100000 + w.n) AS ord
        FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(r, ord)
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.r->'source_urls') = 'array' THEN t.r->'source_urls' ELSE '[]'::jsonb END) WITH ORDINALITY w(u, n)
       WHERE t.ord <= v_limit) x
     WHERE x.url <> '' GROUP BY x.url ORDER BY min(x.ord) LIMIT 500) u;
  SELECT COALESCE(jsonb_agg(to_jsonb(b)), '[]'::jsonb) INTO v_briefs FROM source_briefs(v_urls) b;

  RETURN jsonb_build_object(
    'rows', v_rows, 'total', v_total, 'summary', v_summary,
    'lookup', feed_summary_material(v_page_ids), 'source_briefs', v_briefs
  );
END
$$;

COMMENT ON FUNCTION contributions_feed_bundle(jsonb) IS
  '貢獻看板一次撈齊（contributions-feed 用，2026-11-27）：回傳形狀見本檔檔頭。唯讀、SECURITY INVOKER、只給 service_role。TS 端 RPC 出錯會退回多次查詢的舊路徑。';

-- ------------------------------------------------------------
-- 3. report_context_bundle
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION report_context_bundle(p_kind text, p_params jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
SET statement_timeout = '8s'
AS $$
DECLARE
  v_ws timestamptz;
  v_col text;
  v_val text;
  v_used bigint;
  v_cid uuid;
  v_contribution jsonb;
  v_original jsonb := NULL;
  v_orig_id text;
  v_dispatched jsonb := '[]'::jsonb;
  v_existing jsonb;
  v_prev jsonb := NULL;
  v_after jsonb;
  v_eff int := NULL;
  v_tasks jsonb;
  v_inflight jsonb;
  v_task_ids uuid[];
  v_inflight_ids text[];
BEGIN
  IF p_kind = 'verify_pre' THEN
    v_col := p_params->>'quota_column';
    v_val := p_params->>'quota_value';
    v_ws := (p_params->>'window_start')::timestamptz;
    v_cid := (p_params->>'contribution_id')::uuid;
    IF v_col = 'actor_id' THEN
      SELECT count(*) INTO v_used FROM contribution_votes cv WHERE cv.actor_id = v_val AND cv.created_at >= v_ws;
    ELSIF v_col = 'verifier_ip_hash' THEN
      SELECT count(*) INTO v_used FROM contribution_votes cv WHERE cv.verifier_ip_hash = v_val AND cv.created_at >= v_ws;
    ELSE
      RAISE EXCEPTION 'report_context_bundle: bad quota_column %', v_col USING ERRCODE = '22023';
    END IF;

    SELECT to_jsonb(r) INTO v_contribution FROM (
      SELECT c.id, c.status, c.task_id, c.contribution_type, c.payload, c.source_urls, c.agent_name, c.contributor_ip_hash, c.actor_id,
             c.agree_count, c.disagree_count, c.unsure_count, c.score, c.bundle_id, c.bundle_released_at
        FROM contributions c WHERE c.id = v_cid) r;

    -- 裁決的驗證：原貢獻的提交者也不能投（原貢獻 id 不是 uuid 格式就當查不到，同舊路徑查詢出錯被忽略）
    IF v_contribution IS NOT NULL AND v_contribution->>'contribution_type' = 'adjudication'
       AND jsonb_typeof(v_contribution->'payload'->'contribution_id') = 'string' THEN
      v_orig_id := history_json_uuid(v_contribution->'payload'->'contribution_id');
      IF v_orig_id IS NOT NULL THEN
        SELECT to_jsonb(r) INTO v_original FROM (
          SELECT c.agent_name, c.contributor_ip_hash, c.actor_id FROM contributions c WHERE c.id = v_orig_id::uuid) r;
      END IF;
    END IF;

    IF p_params->'binding' IS NOT NULL AND jsonb_typeof(p_params->'binding') = 'object' THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_dispatched FROM (
        SELECT vd.contribution_id, vd.agent_name FROM verify_dispatches vd
         WHERE vd.contribution_id = v_cid AND vd.ip_hash = p_params->'binding'->>'ip_hash'
           -- 時限：只認派出後 7 天內的紀錄＝verify-handler 的 VERIFY_BINDING_DAYS（_shared/dispatch.ts；dispatch-records-purge.test.ts
           -- 會從這裡抽回看期、核對保留天數與常數）。派工紀錄定時清理的保留天數必須大於這個，改常數要連這裡一起改
           AND vd.dispatched_at >= now() - interval '7 days' LIMIT 2) r;
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_existing FROM (
      SELECT cv.id, cv.agent_name, cv.actor_id, cv.verifier_ip_hash, cv.note, cv.verdict, cv.resolved_politician_id
        FROM contribution_votes cv WHERE cv.contribution_id = v_cid ORDER BY cv.created_at, cv.id LIMIT 1000) r;

    IF p_params->'prev' IS NOT NULL AND jsonb_typeof(p_params->'prev') = 'object' THEN
      IF p_params->'prev'->>'column' = 'actor_id' THEN
        SELECT to_jsonb(r) INTO v_prev FROM (
          SELECT cv.note FROM contribution_votes cv WHERE cv.actor_id = p_params->'prev'->>'value' ORDER BY cv.created_at DESC LIMIT 1) r;
      ELSIF p_params->'prev'->>'column' = 'agent_name' THEN
        SELECT to_jsonb(r) INTO v_prev FROM (
          SELECT cv.note FROM contribution_votes cv WHERE cv.agent_name = p_params->'prev'->>'value' ORDER BY cv.created_at DESC LIMIT 1) r;
      ELSE
        RAISE EXCEPTION 'report_context_bundle: bad prev column' USING ERRCODE = '22023';
      END IF;
    END IF;

    RETURN jsonb_build_object('used', v_used, 'contribution', COALESCE(v_contribution, 'null'::jsonb),
      'original', COALESCE(v_original, 'null'::jsonb), 'dispatched', v_dispatched, 'existing', v_existing,
      'prev', COALESCE(v_prev, 'null'::jsonb));

  ELSIF p_kind = 'verify_post' THEN
    v_cid := (p_params->>'contribution_id')::uuid;
    SELECT to_jsonb(r) INTO v_after FROM (
      SELECT c.status, c.agree_count, c.disagree_count, c.unsure_count, c.score FROM contributions c WHERE c.id = v_cid) r;
    -- 目標分數：舊路徑的 rpc 出錯會被忽略（舊 DB 沒這支函式就退回原門檻），這裡同樣包起來
    BEGIN
      v_eff := contribution_effective_agree(v_cid);
    EXCEPTION WHEN OTHERS THEN
      v_eff := NULL;
    END;
    RETURN jsonb_build_object('after', COALESCE(v_after, 'null'::jsonb), 'effective', to_jsonb(v_eff));

  ELSIF p_kind = 'contribute_pre' THEN
    v_col := p_params->>'quota_column';
    v_val := p_params->>'quota_value';
    v_ws := (p_params->>'window_start')::timestamptz;
    IF v_col = 'actor_id' THEN
      SELECT count(*) INTO v_used FROM contributions c WHERE c.actor_id = v_val AND c.created_at >= v_ws;
    ELSIF v_col = 'contributor_ip_hash' THEN
      SELECT count(*) INTO v_used FROM contributions c WHERE c.contributor_ip_hash = v_val AND c.created_at >= v_ws;
    ELSE
      RAISE EXCEPTION 'report_context_bundle: bad quota_column %', v_col USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(array_agg(x::uuid), '{}'::uuid[]) INTO v_task_ids
      FROM (SELECT DISTINCT t.x FROM jsonb_array_elements_text(COALESCE(p_params->'task_ids', '[]'::jsonb)) t(x)
             WHERE t.x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 400) q;
    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_tasks FROM (
      SELECT ct.id, ct.task_type, COALESCE(ct.target->>'multi_person' = 'true', false) AS multi_person,
             CASE WHEN ct.target->>'multi_person' = 'true' THEN ct.target END AS target
        FROM contribution_tasks ct WHERE ct.id = ANY (v_task_ids)) r;

    SELECT COALESCE(array_agg(x), '{}'::text[]) INTO v_inflight_ids
      FROM (SELECT DISTINCT t.x FROM jsonb_array_elements_text(COALESCE(p_params->'inflight_task_ids', '[]'::jsonb)) t(x) LIMIT 400) q;
    SELECT COALESCE(jsonb_agg(d.task_id), '[]'::jsonb) INTO v_inflight FROM (
      SELECT DISTINCT c.task_id FROM contributions c
       WHERE c.contributor_ip_hash = p_params->>'ip_hash' AND c.task_id = ANY (v_inflight_ids)
         AND c.status IN ('pending', 'verified', 'disputed') LIMIT 1000) d;

    RETURN jsonb_build_object('used', v_used, 'tasks', v_tasks, 'in_flight', v_inflight);
  ELSE
    RAISE EXCEPTION 'report_context_bundle: unsupported kind %', p_kind USING ERRCODE = '22023';
  END IF;
END
$$;

COMMENT ON FUNCTION report_context_bundle(text, jsonb) IS
  'report 讀取端一次撈齊（verify_pre／verify_post／contribute_pre，2026-11-27）：回傳形狀見本檔檔頭。只讀、SECURITY INVOKER、只給 service_role。TS 端 RPC 出錯會退回多次查詢的舊路徑。';

-- 權限：Supabase 預設會把新函式開給 anon／authenticated，要明寫收回
REVOKE ALL ON FUNCTION contributions_feed_bundle(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION contributions_feed_bundle(jsonb) TO service_role;
REVOKE ALL ON FUNCTION report_context_bundle(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION report_context_bundle(text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION feed_summary_material(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION feed_summary_material(uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';
