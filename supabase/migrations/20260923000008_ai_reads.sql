-- 被 AI 讀了幾次（小良哥 2026-09-23：AI 時代不只看瀏覽數，也看被 AI 讀取／引用、AI 帶來的訪客）
--
-- 正見.tw 的 Worker 依 User-Agent／Referer 分類（cloudflare/ai-reads.js），背景打 ai_read_hit() 加一。
-- 只存「哪一天、哪個代理、哪一類、讀哪一種頁」的計數，不存網址、不存 IP。
-- 被 Cloudflare 在邊緣直接擋掉的請求進不到 Worker，數不到。

CREATE TABLE IF NOT EXISTS ai_reads_daily (
  day        DATE    NOT NULL,
  agent      TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral')),
  path_type  TEXT    NOT NULL CHECK (path_type IN ('politician', 'policy', 'election', 'skill', 'llms', 'sitemap', 'other')),
  hits       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, agent, kind, path_type)
);
COMMENT ON TABLE ai_reads_daily IS '每日 AI／搜尋引擎讀取計數（Worker 分類後呼叫 ai_read_hit）。公開可讀；寫入只經 ai_read_hit。';

ALTER TABLE ai_reads_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_reads_daily_public_read ON ai_reads_daily;
CREATE POLICY ai_reads_daily_public_read ON ai_reads_daily FOR SELECT USING (true);

-- 加一。SECURITY DEFINER：anon 不能直接寫表，只能經過這裡；代理名稱限字元與長度，避免被灌亂七八糟的列。
-- 這是統計數字，不是正式資料：有人刻意灌票只會讓數字不準，不會碰到任何政見。
CREATE OR REPLACE FUNCTION ai_read_hit(p_agent TEXT, p_kind TEXT, p_path_type TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_agent IS NULL OR p_agent !~ '^[A-Za-z0-9._-]{1,40}$' THEN RETURN; END IF;
  IF p_kind NOT IN ('ai_user', 'ai_search', 'ai_training', 'search_engine', 'ai_referral') THEN RETURN; END IF;
  IF p_path_type NOT IN ('politician', 'policy', 'election', 'skill', 'llms', 'sitemap', 'other') THEN RETURN; END IF;
  INSERT INTO ai_reads_daily (day, agent, kind, path_type, hits)
  VALUES ((now() AT TIME ZONE 'Asia/Taipei')::DATE, p_agent, p_kind, p_path_type, 1)
  ON CONFLICT (day, agent, kind, path_type) DO UPDATE SET hits = ai_reads_daily.hits + 1;
END;
$$;
REVOKE ALL ON FUNCTION ai_read_hit(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_read_hit(TEXT, TEXT, TEXT) TO anon, authenticated;
COMMENT ON FUNCTION ai_read_hit IS '正見.tw Worker 對 AI／搜尋引擎讀取加一（cloudflare/ai-reads.js 分類）。只收白名單內的 kind／path_type。';
