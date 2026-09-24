-- 名冊逐位核對的結果分布，公開給工頭自己量（2026-09-24：「規則要用量的人拿得到的欄位寫」）
-- 每一種核對結果（支持／不支持＋原因類別）的貢獻現在是什麼狀態；不含 IP。
CREATE OR REPLACE FUNCTION roster_batch_status()
RETURNS TABLE (verdict TEXT, reason_kind TEXT, status TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (
    SELECT DISTINCT ON (j.subject_id) j.subject_id, j.choice, j.state->>'reason' AS reason
      FROM jev_decisions j
     WHERE j.subject_type = 'contribution' AND j.question = 'source_support' AND j.model LIKE 'policy-tw/roster-batch%'
     ORDER BY j.subject_id, j.asked_at DESC
  )
  SELECT d.choice,
         CASE WHEN d.choice = 'supported' THEN '對得上'
              WHEN d.reason LIKE '%找不到%' THEN '名冊上找不到姓名'
              WHEN d.reason LIKE '%縣市是%' THEN '縣市對不上'
              WHEN d.reason LIKE '%政黨是%' THEN '政黨對不上'
              ELSE '其他' END,
         c.status, COUNT(*)
    FROM d JOIN contributions c ON c.id::TEXT = d.subject_id
   GROUP BY 1, 2, 3
   ORDER BY 1, 2, 3
$$;
GRANT EXECUTE ON FUNCTION roster_batch_status() TO anon, authenticated;
COMMENT ON FUNCTION roster_batch_status IS '中選會名冊逐位核對的結果 × 貢獻現況（公開，不含 IP）';
