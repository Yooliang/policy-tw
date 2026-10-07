-- AI 讀取：Markdown 版（人物／縣市／分類／縣市×分類或主題的 .md）另外算（維護者 2026-10-07 同意這支小 migration；
-- 計畫 docs/PLAN-markdown-views.md 第 8 節）
--
-- 之前 .md 會被歸到 path_type = 'other'：能計數，但看不出是 .md、也看不出是哪一類讀者。
-- 這裡加兩個值，Worker 端的分類見 cloudflare/ai-reads.js：
--   path_type = 'markdown'   讀的是 Markdown 版（正見.tw 上 /politician、/election、/category、/data 底下的 .md）
--   kind      = 'unknown_md' 讀 .md 的人認不出是哪個 AI／搜尋引擎（NotebookLM、使用者貼網址進 AI 工具時 UA 常常不認得；
--                            .md 本來就不是給一般瀏覽器開的，所以不認得的也值得記一筆）
-- 白名單同時在三處：表的兩個 CHECK、ai_read_hit()、ai_read_hits()；改一處要三處同步（測試盯 migration 文字）。
-- 只記每日計數，不記網址與 IP——不變。

ALTER TABLE ai_reads_daily DROP CONSTRAINT IF EXISTS ai_reads_daily_kind_check;
ALTER TABLE ai_reads_daily ADD CONSTRAINT ai_reads_daily_kind_check
  CHECK (kind IN ('ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral', 'agent_protocol', 'unknown_md'));

ALTER TABLE ai_reads_daily DROP CONSTRAINT IF EXISTS ai_reads_daily_path_type_check;
ALTER TABLE ai_reads_daily ADD CONSTRAINT ai_reads_daily_path_type_check
  CHECK (path_type IN ('politician', 'policy', 'election', 'skill', 'llms', 'sitemap', 'markdown', 'other'));

-- 批次寫入（Worker 累加一分鐘後呼叫；最新一版是 20260929000013，這裡只加兩個白名單值）
CREATE OR REPLACE FUNCTION ai_read_hits(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r JSONB; v_n INTEGER; v_done INTEGER := 0;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN RETURN 0; END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LIMIT 200 LOOP
    CONTINUE WHEN (r->>'agent') IS NULL OR (r->>'agent') !~ '^[A-Za-z0-9._-]{1,40}$';
    CONTINUE WHEN (r->>'kind') NOT IN ('ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral', 'agent_protocol', 'unknown_md');
    CONTINUE WHEN (r->>'path_type') NOT IN ('politician', 'policy', 'election', 'skill', 'llms', 'sitemap', 'markdown', 'other');
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

-- 單筆加一（Worker 已不用，但函式還在、白名單也要同步，不然兩處講的不一樣）
-- 20260923000008 那一版的 kind 白名單少了 agent_protocol，這裡一併補齊
CREATE OR REPLACE FUNCTION ai_read_hit(p_agent TEXT, p_kind TEXT, p_path_type TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_agent IS NULL OR p_agent !~ '^[A-Za-z0-9._-]{1,40}$' THEN RETURN; END IF;
  IF p_kind NOT IN ('ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral', 'agent_protocol', 'unknown_md') THEN RETURN; END IF;
  IF p_path_type NOT IN ('politician', 'policy', 'election', 'skill', 'llms', 'sitemap', 'markdown', 'other') THEN RETURN; END IF;
  INSERT INTO ai_reads_daily (day, agent, kind, path_type, hits)
  VALUES ((now() AT TIME ZONE 'Asia/Taipei')::DATE, p_agent, p_kind, p_path_type, 1)
  ON CONFLICT (day, agent, kind, path_type) DO UPDATE SET hits = ai_reads_daily.hits + 1;
END;
$$;
REVOKE ALL ON FUNCTION ai_read_hit(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_read_hit(TEXT, TEXT, TEXT) TO anon, authenticated;
