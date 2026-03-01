-- policy_sources: 政見的新聞來源連結
CREATE TABLE policy_sources (
  id SERIAL PRIMARY KEY,
  policy_id UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  source_name TEXT,          -- 媒體名稱（中央通訊社、聯合報等）
  published_date DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_policy_sources_policy_id ON policy_sources(policy_id);

-- 防止同一政見的重複 URL
CREATE UNIQUE INDEX idx_policy_sources_unique_url ON policy_sources(policy_id, url);

-- RLS: 公開讀取、service_role 寫入
ALTER TABLE policy_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON policy_sources FOR SELECT USING (true);
CREATE POLICY "Service role write" ON policy_sources FOR ALL USING (auth.role() = 'service_role');
