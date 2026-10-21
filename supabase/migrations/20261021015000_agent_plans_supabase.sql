-- 運轉成本表格加一列 Supabase（資料庫）：方案與月費維護者還沒定，先留空（頁面顯示「—」、不計入合計）。
-- 定了之後一行 UPDATE：UPDATE agent_plans SET plan = '…', monthly_usd = 25, updated_at = now() WHERE provider = 'Supabase';
ALTER TABLE agent_plans ALTER COLUMN plan DROP NOT NULL;
ALTER TABLE agent_plans ALTER COLUMN monthly_usd DROP NOT NULL;

INSERT INTO agent_plans (provider, plan, qty, monthly_usd, note, sort)
SELECT 'Supabase', NULL, 1, NULL, NULL, 60
WHERE NOT EXISTS (SELECT 1 FROM agent_plans WHERE provider = 'Supabase');
