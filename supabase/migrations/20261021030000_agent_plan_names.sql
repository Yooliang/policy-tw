-- 官方代理的方案名稱改用正式名稱（維護者 2026-10-21）。Grok 的正式名還沒確認，維持「20x 方案」；DeepSeek 維持「API」。
UPDATE agent_plans SET plan = 'Max 20x', updated_at = now() WHERE provider = 'Claude';
UPDATE agent_plans SET plan = 'Google AI Pro', updated_at = now() WHERE provider = 'Gemini（Antigravity）';
UPDATE agent_plans SET plan = 'ChatGPT Plus', updated_at = now() WHERE provider = 'Codex';
