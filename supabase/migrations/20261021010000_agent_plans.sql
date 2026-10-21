-- 官方代理的月費設定表（維護者 2026-10-21）：捐款頁「官方代理（每月）」表格的資料來源。
-- 方案有變只改這張表（一行 UPDATE），頁面不用動。note 標「約」＝金額為估計值，頁面會加「約」字。
CREATE TABLE IF NOT EXISTS agent_plans (
  id           SERIAL PRIMARY KEY,
  provider     TEXT NOT NULL,
  plan         TEXT NOT NULL,
  qty          INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 0),
  monthly_usd  NUMERIC NOT NULL CHECK (monthly_usd >= 0),
  note         TEXT,
  sort         INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, plan)
);
COMMENT ON TABLE agent_plans IS '官方代理的訂閱方案與月費（單價 monthly_usd × 數量 qty）；捐款頁顯示用，公開唯讀';
ALTER TABLE agent_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_plans_public_read ON agent_plans;
CREATE POLICY agent_plans_public_read ON agent_plans FOR SELECT USING (true);

INSERT INTO agent_plans (provider, plan, qty, monthly_usd, note, sort) VALUES
  ('Claude', '20x 方案', 3, 200, NULL, 10),
  ('Grok', '20x 方案', 1, 200, NULL, 20),
  ('DeepSeek', 'API', 1, 65, '約', 30),
  ('Gemini（Antigravity）', '訂閱', 1, 20, NULL, 40),
  ('Codex', '訂閱', 1, 20, NULL, 50)
ON CONFLICT (provider, plan) DO NOTHING;
