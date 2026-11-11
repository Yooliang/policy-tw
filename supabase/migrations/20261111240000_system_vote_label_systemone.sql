-- 統計：系統票那一列的顯示標籤 Jev → SystemOne（維護者 2026-11-12 裁示：給人看的「Jev」一律改叫「SystemOne」）。
-- 只改函式輸出的標籤字串：'系統票（Jev）' → '系統票（SystemOne）'。
-- 不動：表名 jev_decisions、question 值、agent_tool／agents.model 既有資料值 'Jev（系統）'
--      （model_display_name 照舊回 'Jev（系統）'；比對條件新舊兩個名稱都認，之後資料值改名也不用再動這裡）。
-- 簽名不變、SECURITY／search_path 原樣；CREATE OR REPLACE 不動既有 GRANT／COMMENT，不用分兩次上。
-- 前端（lib/model-quality.ts、lib/model-flow.ts）與主控台（policy-console #143）新舊標籤都認。
-- 涵蓋：model_vote_stats(INTEGER)（抄自 20261003000003）、model_vote_stats(TIMESTAMPTZ, TIMESTAMPTZ)（抄自 20261007160000）、model_flow_stats（20261102030000）、model_flow_paths（20261102160000）、
--       policy_jp.model_vote_stats（20261009200000，標籤與正見同一字串；日本站沒有天數版）。
-- 注意：檔名不含 _policy_jp_，policy-jp-dispatch-drift 的 migration 掃描不會掃這份（日本版跟進靠 policy-jp-public-stats.test.ts 的 STATS_FOLLOWED）。

CREATE OR REPLACE FUNCTION model_vote_stats(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (model TEXT, votes BIGINT, agree BIGINT, disagree BIGINT, unsure BIGINT, wrong BIGINT, raw_tools JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (
    SELECT v.agent_tool, v.verdict, c.status,
           (v.agent_name LIKE 'jev%' OR COALESCE(v.via, '') ILIKE '%system%') AS is_system
      FROM contribution_votes v
      JOIN contributions c ON c.id = v.contribution_id
     WHERE v.created_at >= GREATEST(COALESCE(p_since, now() - INTERVAL '90 days'), now() - INTERVAL '90 days')
       AND (p_until IS NULL OR v.created_at < p_until)
       AND c.status IN ('applied', 'rejected')
  ), t AS MATERIALIZED (
    SELECT d.tool_key, model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM v) d
  ), j AS (
    SELECT CASE WHEN v.is_system OR t.model IN ('Jev（系統）', 'SystemOne（系統）') THEN '系統票（SystemOne）' ELSE t.model END AS model, v.*
      FROM v JOIN t ON t.tool_key = COALESCE(v.agent_tool, '')
  ), raw AS (
    SELECT r.model, jsonb_agg(jsonb_build_object('tool', r.agent_tool, 'n', r.n) ORDER BY r.n DESC, r.agent_tool) AS raw_tools
      FROM (
        SELECT j.model, j.agent_tool, COUNT(*) AS n, row_number() OVER (PARTITION BY j.model ORDER BY COUNT(*) DESC, j.agent_tool) AS rk
          FROM j GROUP BY j.model, j.agent_tool
      ) r
     WHERE r.rk <= 20
     GROUP BY r.model
  ), agg AS (
    SELECT j.model,
           COUNT(*) AS votes,
           COUNT(*) FILTER (WHERE j.verdict = 'agree') AS agree,
           COUNT(*) FILTER (WHERE j.verdict = 'disagree') AS disagree,
           COUNT(*) FILTER (WHERE j.verdict = 'unsure') AS unsure,
           COUNT(*) FILTER (WHERE (j.verdict = 'agree' AND j.status = 'rejected') OR (j.verdict = 'disagree' AND j.status = 'applied')) AS wrong
      FROM j GROUP BY j.model
  )
  SELECT agg.model, agg.votes, agg.agree, agg.disagree, agg.unsure, agg.wrong, raw.raw_tools
    FROM agg LEFT JOIN raw ON raw.model = agg.model
   ORDER BY agg.votes DESC, agg.model
$$;

-- 抄自 20261003000003_model_quality_stats.sql（天數版；/stats 的 ModelQualityPanel 用的就是這支：rpc('model_vote_stats', { p_days })）
CREATE OR REPLACE FUNCTION model_vote_stats(p_days INTEGER DEFAULT 14)
RETURNS TABLE (model TEXT, votes BIGINT, agree BIGINT, disagree BIGINT, unsure BIGINT, wrong BIGINT, raw_tools JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (
    SELECT v.agent_tool, v.verdict, c.status,
           (v.agent_name LIKE 'jev%' OR COALESCE(v.via, '') ILIKE '%system%') AS is_system
      FROM contribution_votes v
      JOIN contributions c ON c.id = v.contribution_id
     WHERE v.created_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 90))
       AND c.status IN ('applied', 'rejected')
  ), t AS MATERIALIZED (
    SELECT d.tool_key, model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM v) d
  ), j AS (
    SELECT CASE WHEN v.is_system OR t.model IN ('Jev（系統）', 'SystemOne（系統）') THEN '系統票（SystemOne）' ELSE t.model END AS model, v.*
      FROM v JOIN t ON t.tool_key = COALESCE(v.agent_tool, '')
  ), raw AS (
    SELECT r.model, jsonb_agg(jsonb_build_object('tool', r.agent_tool, 'n', r.n) ORDER BY r.n DESC, r.agent_tool) AS raw_tools
      FROM (
        SELECT j.model, j.agent_tool, COUNT(*) AS n, row_number() OVER (PARTITION BY j.model ORDER BY COUNT(*) DESC, j.agent_tool) AS rk
          FROM j GROUP BY j.model, j.agent_tool
      ) r
     WHERE r.rk <= 20
     GROUP BY r.model
  ), agg AS (
    SELECT j.model,
           COUNT(*) AS votes,
           COUNT(*) FILTER (WHERE j.verdict = 'agree') AS agree,
           COUNT(*) FILTER (WHERE j.verdict = 'disagree') AS disagree,
           COUNT(*) FILTER (WHERE j.verdict = 'unsure') AS unsure,
           COUNT(*) FILTER (WHERE (j.verdict = 'agree' AND j.status = 'rejected') OR (j.verdict = 'disagree' AND j.status = 'applied')) AS wrong
      FROM j GROUP BY j.model
  )
  SELECT agg.model, agg.votes, agg.agree, agg.disagree, agg.unsure, agg.wrong, raw.raw_tools
    FROM agg LEFT JOIN raw ON raw.model = agg.model
   ORDER BY agg.votes DESC, agg.model
$$;

CREATE OR REPLACE FUNCTION model_flow_stats(p_days INTEGER DEFAULT 14)
RETURNS TABLE (layer TEXT, model TEXT, key1 TEXT, key2 TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH c AS (
    SELECT c.agent_tool, c.contribution_type, c.status, c.review_notes, c.payload->>'outcome' AS outcome
      FROM contributions c
     WHERE c.created_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 90))
  ), t AS MATERIALIZED (
    SELECT d.tool_key, model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM c) d
  ), j AS (
    SELECT t.model, c.* FROM c JOIN t ON t.tool_key = COALESCE(c.agent_tool, '')
  ), contrib AS (
    SELECT 'contrib'::text AS layer, j.model, j.contribution_type AS key1,
           CASE WHEN j.status IN ('applied', 'rejected', 'superseded', 'withdrawn') THEN j.status
                WHEN j.status IN ('pending', 'verified', 'disputed') THEN 'pending' ELSE 'other' END AS key2,
           COUNT(*) AS n
      FROM j GROUP BY 2, 3, 4
  ), rej AS (
    SELECT 'reject'::text AS layer, j.model,
           CASE WHEN j.review_notes ~* '(statement timeout|canceling statement|逾時)' THEN 'timeout'
                WHEN j.review_notes LIKE '%重複%' THEN 'duplicate'
                WHEN j.contribution_type = 'no_change' AND j.outcome IN ('not_found', 'unreachable') THEN 'no_change_missing'
                WHEN j.review_notes LIKE '%分數%退件門檻%' THEN 'score'
                ELSE 'data' END AS key1,
           NULL::text AS key2, COUNT(*) AS n
      FROM j WHERE j.status = 'rejected' GROUP BY 2, 3
  ), v AS (
    SELECT v.agent_tool, v.verdict, c.status,
           (v.agent_name LIKE 'jev%' OR COALESCE(v.via, '') ILIKE '%system%') AS is_system
      FROM contribution_votes v
      JOIN contributions c ON c.id = v.contribution_id
     WHERE v.created_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 90))
       AND c.status IN ('applied', 'rejected')
  ), vt AS MATERIALIZED (
    SELECT d.tool_key, model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM v) d
  ), vj AS (
    SELECT CASE WHEN v.is_system OR vt.model IN ('Jev（系統）', 'SystemOne（系統）') THEN '系統票（SystemOne）' ELSE vt.model END AS model, v.*
      FROM v JOIN vt ON vt.tool_key = COALESCE(v.agent_tool, '')
  ), vote AS (
    SELECT 'vote'::text AS layer, vj.model, vj.verdict AS key1,
           CASE WHEN vj.verdict = 'agree' THEN CASE WHEN vj.status = 'applied' THEN 'right' ELSE 'wrong' END
                WHEN vj.verdict = 'disagree' THEN CASE WHEN vj.status = 'rejected' THEN 'right' ELSE 'wrong' END
                ELSE 'none' END AS key2,
           COUNT(*) AS n
      FROM vj GROUP BY 2, 3, 4
  )
  SELECT * FROM contrib UNION ALL SELECT * FROM rej UNION ALL SELECT * FROM vote
$$;

CREATE OR REPLACE FUNCTION model_flow_paths(p_days INTEGER DEFAULT 14)
RETURNS TABLE (layer TEXT, model TEXT, key1 TEXT, key2 TEXT, key3 TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH c AS (
    SELECT c.agent_tool, c.contribution_type, c.status, c.review_notes, c.payload->>'outcome' AS outcome
      FROM contributions c
     WHERE c.created_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 90))
  ), t AS MATERIALIZED (
    SELECT d.tool_key, model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM c) d
  ), j AS (
    SELECT t.model, c.* FROM c JOIN t ON t.tool_key = COALESCE(c.agent_tool, '')
  ), contrib AS (
    SELECT 'contrib'::text AS layer, j.model, j.contribution_type AS key1,
           CASE WHEN j.status IN ('applied', 'rejected', 'superseded', 'withdrawn') THEN j.status
                WHEN j.status IN ('pending', 'verified', 'disputed') THEN 'pending' ELSE 'other' END AS key2,
           CASE WHEN j.status <> 'rejected' THEN NULL
                WHEN j.review_notes ~* '(statement timeout|canceling statement|逾時)' THEN 'timeout'
                WHEN j.review_notes LIKE '%重複%' THEN 'duplicate'
                WHEN j.contribution_type = 'no_change' AND j.outcome IN ('not_found', 'unreachable') THEN 'no_change_missing'
                WHEN j.review_notes LIKE '%分數%退件門檻%' THEN 'score'
                ELSE 'data' END AS key3,
           COUNT(*) AS n
      FROM j GROUP BY 2, 3, 4, 5
  ), v AS (
    SELECT v.agent_tool, v.verdict, c.status,
           (v.agent_name LIKE 'jev%' OR COALESCE(v.via, '') ILIKE '%system%') AS is_system
      FROM contribution_votes v
      JOIN contributions c ON c.id = v.contribution_id
     WHERE v.created_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 90))
       AND c.status IN ('applied', 'rejected')
  ), vt AS MATERIALIZED (
    SELECT d.tool_key, model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM v) d
  ), vj AS (
    SELECT CASE WHEN v.is_system OR vt.model IN ('Jev（系統）', 'SystemOne（系統）') THEN '系統票（SystemOne）' ELSE vt.model END AS model, v.*
      FROM v JOIN vt ON vt.tool_key = COALESCE(v.agent_tool, '')
  ), vote AS (
    SELECT 'vote'::text AS layer, vj.model, vj.verdict AS key1,
           CASE WHEN vj.verdict = 'agree' THEN CASE WHEN vj.status = 'applied' THEN 'right' ELSE 'wrong' END
                WHEN vj.verdict = 'disagree' THEN CASE WHEN vj.status = 'rejected' THEN 'right' ELSE 'wrong' END
                ELSE 'none' END AS key2,
           NULL::text AS key3,
           COUNT(*) AS n
      FROM vj GROUP BY 2, 3, 4
  )
  SELECT * FROM contrib UNION ALL SELECT * FROM vote
$$;

-- 抄自 20261009200000_policy_jp_public_stats.sql
CREATE OR REPLACE FUNCTION policy_jp.model_vote_stats(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (model TEXT, votes BIGINT, agree BIGINT, disagree BIGINT, unsure BIGINT, wrong BIGINT, raw_tools JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH v AS (
    SELECT v.agent_tool, v.verdict, c.status,
           (v.agent_name LIKE 'jev%' OR COALESCE(v.via, '') ILIKE '%system%') AS is_system
      FROM policy_jp.contribution_votes v
      JOIN policy_jp.contributions c ON c.id = v.contribution_id
     WHERE v.created_at >= GREATEST(COALESCE(p_since, now() - INTERVAL '90 days'), now() - INTERVAL '90 days')
       AND (p_until IS NULL OR v.created_at < p_until)
       AND c.status IN ('applied', 'rejected')
  ), t AS MATERIALIZED (
    SELECT d.tool_key, policy_jp.model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM v) d
  ), j AS (
    SELECT CASE WHEN v.is_system OR t.model IN ('Jev（系統）', 'SystemOne（系統）') THEN '系統票（SystemOne）' ELSE t.model END AS model, v.*
      FROM v JOIN t ON t.tool_key = COALESCE(v.agent_tool, '')
  ), raw AS (
    SELECT r.model, jsonb_agg(jsonb_build_object('tool', r.agent_tool, 'n', r.n) ORDER BY r.n DESC, r.agent_tool) AS raw_tools
      FROM (
        SELECT j.model, j.agent_tool, COUNT(*) AS n, row_number() OVER (PARTITION BY j.model ORDER BY COUNT(*) DESC, j.agent_tool) AS rk
          FROM j GROUP BY j.model, j.agent_tool
      ) r
     WHERE r.rk <= 20
     GROUP BY r.model
  ), agg AS (
    SELECT j.model,
           COUNT(*) AS votes,
           COUNT(*) FILTER (WHERE j.verdict = 'agree') AS agree,
           COUNT(*) FILTER (WHERE j.verdict = 'disagree') AS disagree,
           COUNT(*) FILTER (WHERE j.verdict = 'unsure') AS unsure,
           COUNT(*) FILTER (WHERE (j.verdict = 'agree' AND j.status = 'rejected') OR (j.verdict = 'disagree' AND j.status = 'applied')) AS wrong
      FROM j GROUP BY j.model
  )
  SELECT agg.model, agg.votes, agg.agree, agg.disagree, agg.unsure, agg.wrong, raw.raw_tools
    FROM agg LEFT JOIN raw ON raw.model = agg.model
   ORDER BY agg.votes DESC, agg.model
$$;

-- ------------------------------------------------------------
-- 3. 管線快照：計數函式與採樣函式（複本）、公開讀取函式（非複本）、排程
-- ------------------------------------------------------------
