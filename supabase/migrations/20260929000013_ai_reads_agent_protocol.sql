-- AI 讀取：代理讀協議另外算（維護者 2026-09-29）
--
-- 「AI 當場來讀」原本 717 次全部是 Claude-User 讀 /skill.md——那是我們自己的貢獻代理領任務前讀協議，
-- 不是有人問 AI、AI 來讀正見。讀的是人物／政見頁才算「AI 當場來讀」；讀 /skill.md 的另成一類 agent_protocol。
-- Worker 端的分類見 cloudflare/ai-reads.js。

ALTER TABLE ai_reads_daily DROP CONSTRAINT IF EXISTS ai_reads_daily_kind_check;
ALTER TABLE ai_reads_daily ADD CONSTRAINT ai_reads_daily_kind_check
  CHECK (kind IN ('ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral', 'agent_protocol'));

CREATE OR REPLACE FUNCTION ai_read_hits(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r JSONB; v_n INTEGER; v_done INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LIMIT 200 LOOP
    CONTINUE WHEN (r->>'agent') IS NULL OR (r->>'agent') !~ '^[A-Za-z0-9._-]{1,40}$';
    CONTINUE WHEN (r->>'kind') NOT IN ('ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral', 'agent_protocol');
    CONTINUE WHEN (r->>'path_type') NOT IN ('politician', 'policy', 'election', 'skill', 'llms', 'sitemap', 'other');
    v_n := LEAST(GREATEST(COALESCE((r->>'n')::INTEGER, 1), 1), 100000);
    INSERT INTO ai_reads_daily (day, agent, kind, path_type, hits)
    VALUES ((now() AT TIME ZONE 'Asia/Taipei')::DATE, r->>'agent', r->>'kind', r->>'path_type', v_n)
    ON CONFLICT (day, agent, kind, path_type) DO UPDATE SET hits = ai_reads_daily.hits + EXCLUDED.hits;
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION ai_read_hits(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_read_hits(JSONB) TO anon, authenticated;

-- 舊資料改類：以前記成 ai_user 的 /skill.md 讀取（新類別還沒有任何列，不會撞主鍵）
UPDATE ai_reads_daily SET kind = 'agent_protocol' WHERE kind = 'ai_user' AND path_type = 'skill';

-- 圖表用：每天每一類的次數（最多 90 天 × 6 類 = 540 列，不到 PostgREST 1,000 列上限）
CREATE OR REPLACE FUNCTION ai_reads_series(p_days INTEGER DEFAULT 7)
RETURNS TABLE (day DATE, kind TEXT, hits BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.day, r.kind, SUM(r.hits)::BIGINT
    FROM ai_reads_daily r
   WHERE r.day > (now() AT TIME ZONE 'Asia/Taipei')::DATE - LEAST(GREATEST(COALESCE(p_days, 7), 1), 90)
   GROUP BY r.day, r.kind
   ORDER BY r.day, r.kind
$$;
GRANT EXECUTE ON FUNCTION ai_reads_series(INTEGER) TO anon, authenticated;
COMMENT ON FUNCTION ai_reads_series IS '統計頁「AI 讀取」圖表：最近 p_days 天（台北日期）每天每一類的次數';
