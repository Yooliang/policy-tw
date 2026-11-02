-- /ai 頁分流圖（policy-ops#174）：交件 4 層（模型→任務類型→交件結果→退件原因）與投票 4 層（模型→投票→同意／不同意／不確定→事後對錯）的流量。
-- 唯讀聚合；SECURITY 與 grant 同 model_contribution_stats。只給件數，不含 IP 與代號。
--   layer = 'contrib'：key1 任務類型、key2 結果（applied／pending（含 verified、disputed）／rejected／superseded／withdrawn／other）
--   layer = 'reject' ：key1 退件原因（timeout 逾時／duplicate 重複／no_change_missing 無異動查無／score 同儕票退件／data 資料錯）；model 為 NULL 以外仍帶模型
--   layer = 'vote'   ：key1 投票意見（agree／disagree／unsure）、key2 事後對錯（right／wrong／none；unsure 恆為 none）
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
    SELECT CASE WHEN v.is_system OR vt.model = 'Jev（系統）' THEN '系統票（Jev）' ELSE vt.model END AS model, v.*
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
COMMENT ON FUNCTION model_flow_stats IS '近 N 天（1～90）交件與投票的分流量（桑基圖用）：layer＝contrib／reject／vote。公開，不含 IP 與代號';
GRANT EXECUTE ON FUNCTION model_flow_stats(INTEGER) TO anon, authenticated;
