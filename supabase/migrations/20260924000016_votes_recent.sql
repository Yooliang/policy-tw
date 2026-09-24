-- 最近 N 分鐘的投票活動（2026-09-24，leatherback 經工頭轉）
--
-- 「有沒有人在投票」從公開端點看不出來，今天四個人次為此講錯（看總數沒看活動時間、把提交者當成投票者、沒查就講）。
-- 跟 roster_batch_status()／gate_rejection_summary() 同一個用意：答案放在公開端點上，不必每輪回頭問主線。
-- 只給彙總：依同意／反對／存疑、依貢獻型別分組，外加幾個來源在投、最近一張票的時間。
-- 不含 IP、不含投票者代號、不含票的內容。

CREATE OR REPLACE FUNCTION votes_recent(p_minutes INTEGER DEFAULT 60)
RETURNS TABLE (contribution_type TEXT, verdict TEXT, votes BIGINT, sources BIGINT, contributions BIGINT, last_vote_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- ROLLUP：每個型別×verdict 一列、每個型別一列（verdict 為 NULL）、最後一列是全部（兩欄都 NULL）
  SELECT c.contribution_type, v.verdict, COUNT(*), COUNT(DISTINCT v.verifier_ip_hash), COUNT(DISTINCT v.contribution_id), MAX(v.created_at)
    FROM contribution_votes v
    JOIN contributions c ON c.id = v.contribution_id
   WHERE v.created_at > now() - make_interval(mins => LEAST(GREATEST(COALESCE(p_minutes, 60), 1), 10080))
   GROUP BY ROLLUP (c.contribution_type, v.verdict)
   ORDER BY c.contribution_type NULLS FIRST, v.verdict NULLS FIRST
$$;
COMMENT ON FUNCTION votes_recent IS '最近 N 分鐘（最多 7 天）的投票彙總：依型別與 verdict 分組、幾個來源、幾筆貢獻、最近一張票的時間；不含 IP 與代號。第一列（兩欄都 NULL）是全部';
GRANT EXECUTE ON FUNCTION votes_recent(INTEGER) TO anon, authenticated;
