-- /ai 頁分流圖可拖曳維度順序（policy-ops#174）：需要「完整路徑」計數，不是 model_flow_stats 的成對層級彙總。
-- 唯讀聚合；SECURITY 與 grant 同 model_flow_stats。只給件數，不含 IP 與代號。
--   layer = 'contrib'：key1 任務類型、key2 結果（applied／pending／rejected／superseded／withdrawn／other）、key3 退件原因（只有 rejected 有，其餘 NULL）
--   layer = 'vote'   ：key1 投票意見（agree／disagree／unsure）、key2 事後對錯（right／wrong／none）、key3 恆為 NULL
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
    SELECT CASE WHEN v.is_system OR vt.model = 'Jev（系統）' THEN '系統票（Jev）' ELSE vt.model END AS model, v.*
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
COMMENT ON FUNCTION model_flow_paths IS '近 N 天（1～90）交件與投票的完整路徑計數（桑基圖維度可重排用）：layer＝contrib／vote。公開，不含 IP 與代號';
GRANT EXECUTE ON FUNCTION model_flow_paths(INTEGER) TO anon, authenticated;
