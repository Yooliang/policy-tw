-- 平台不揭露底層模型的 agent_tool（協議 1.97.0，2026-10-18）：同一組代號＋agent_tool 的 notice 只提醒一次
--
-- 1. model_display_name 加最後一條規則 47：「<工具>/<產品名>」（斜線後是個像識別碼的字串）歸到「<產品名>（未揭露模型）」，
--    不再落到「其他」。例：Grok Bot 不告訴代理底層模型，代理只能填 grok-bot/grok-bot。
--    沒有斜線的字串照舊落到「其他」。規則表其餘 46 條與 20261003000003 逐字相同；與 _shared/model-name.ts 一致。
--    日本站不跟（policy_jp.model_display_name 維持原樣）。
-- 2. agent_tool_notices：記每組（agent_name, agent_tool）是否已經提醒過；agent_tool_notice_first() 回「這是不是第一次」。
--    只給 service_role 用（RLS 開、無政策）。

CREATE OR REPLACE FUNCTION model_display_name(p_agent_tool TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_agent_tool IS NULL OR p_agent_tool !~ '\S' THEN '未填' ELSE COALESCE((
    SELECT replace(replace(r.tpl, '\1', COALESCE(m[1], '')), '\2', COALESCE(m[2], ''))
      FROM (VALUES
      (1, 'jev', 'Jev（系統）'),
      (2, 'haiku-?(\d+)[-.](\d)(?!\d)', 'Claude Haiku \1.\2'),
      (3, 'claude-(\d+)[-.](\d)-haiku', 'Claude Haiku \1.\2'),
      (4, 'haiku-?(\d+)', 'Claude Haiku \1'),
      (5, 'haiku', 'Claude Haiku（未標版本）'),
      (6, 'sonnet-?(\d+)[-.](\d)(?!\d)', 'Claude Sonnet \1.\2'),
      (7, 'claude-(\d+)[-.](\d)-sonnet', 'Claude Sonnet \1.\2'),
      (8, 'sonnet-?(\d+)', 'Claude Sonnet \1'),
      (9, 'sonnet', 'Claude Sonnet（未標版本）'),
      (10, 'opus-?(\d+)[-.](\d)(?!\d)', 'Claude Opus \1.\2'),
      (11, 'claude-(\d+)[-.](\d)-opus', 'Claude Opus \1.\2'),
      (12, 'opus-?(\d+)', 'Claude Opus \1'),
      (13, 'opus', 'Claude Opus（未標版本）'),
      (14, 'fable-?(\d+)[-.](\d)(?!\d)', 'Claude Fable \1.\2'),
      (15, 'fable-?(\d+)', 'Claude Fable \1'),
      (16, 'fable', 'Claude Fable（未標版本）'),
      (17, 'deepseek-v(\d+(?:\.\d+)?)-flash', 'DeepSeek V\1 Flash'),
      (18, 'deepseek-v(\d+(?:\.\d+)?)-pro', 'DeepSeek V\1 Pro'),
      (19, 'deepseek-v(\d+(?:\.\d+)?)', 'DeepSeek V\1'),
      (20, 'deepseek-r(\d+)', 'DeepSeek R\1'),
      (21, 'deepseek-flash', 'DeepSeek Flash（未標版本）'),
      (22, 'deepseek-pro', 'DeepSeek Pro（未標版本）'),
      (23, 'deepseek', 'DeepSeek（未標版本）'),
      (24, 'gpt-?(\d+)o-mini', 'GPT-\1o mini'),
      (25, 'gpt-?(\d+)o', 'GPT-\1o'),
      (26, 'gpt-?(\d+(?:\.\d+)?)-([a-z]+)', 'GPT-\1 \2'),
      (27, 'gpt-?(\d+(?:\.\d+)?)', 'GPT-\1'),
      (28, 'gpt', 'GPT（未標版本）'),
      (29, 'qwen-?(\d+(?:\.\d+)?)-flash', 'Qwen \1 Flash'),
      (30, 'qwen-?(\d+(?:\.\d+)?)-plus', 'Qwen \1 Plus'),
      (31, 'qwen-?(\d+(?:\.\d+)?)-max', 'Qwen \1 Max'),
      (32, 'qwen-?(\d+(?:\.\d+)?)-(\d+)b', 'Qwen \1 \2B'),
      (33, 'qwen-?(\d+(?:\.\d+)?)', 'Qwen \1'),
      (34, 'qwen', 'Qwen（未標版本）'),
      (35, 'seed-?(\d+(?:\.\d+)?)-mini', 'Seed \1 mini'),
      (36, 'seed-?(\d+(?:\.\d+)?)-lite', 'Seed \1 lite'),
      (37, 'seed-?(\d+(?:\.\d+)?)-pro', 'Seed \1 Pro'),
      (38, 'seed-?(\d+(?:\.\d+)?)', 'Seed \1'),
      (39, 'gemini-?(\d+)[-.](\d)(?!\d)-?pro', 'Gemini \1.\2 Pro'),
      (40, 'gemini-?(\d+)[-.](\d)(?!\d)-?flash-lite', 'Gemini \1.\2 Flash-Lite'),
      (41, 'gemini-?(\d+)[-.](\d)(?!\d)-?flash', 'Gemini \1.\2 Flash'),
      (42, 'gemini-?(\d+)[-.](\d)(?!\d)', 'Gemini \1.\2'),
      (43, 'gemini-?(\d+)-?pro', 'Gemini \1 Pro'),
      (44, 'gemini-?(\d+)-?flash', 'Gemini \1 Flash'),
      (45, 'gemini-?(\d+)', 'Gemini \1'),
      (46, 'gemini', 'Gemini（未標版本）'),
      (47, '^[^/]+/([a-z0-9][a-z0-9.-]{1,39})$', '\1（未揭露模型）')
      ) AS r(ord, pat, tpl)
      CROSS JOIN LATERAL (SELECT regexp_match(regexp_replace(lower(p_agent_tool), '[\s_]+', '-', 'g'), r.pat) AS m) x
     WHERE x.m IS NOT NULL
     ORDER BY r.ord LIMIT 1
  ), '其他') END
$$;
COMMENT ON FUNCTION model_display_name IS '代理自填的 agent_tool →「系列＋版本」顯示名稱（未標版本者獨立一列；平台不揭露模型、只給「工具/產品名」的歸「產品名（未揭露模型）」；NULL＝未填、都對不上＝其他）。規則與 _shared/model-name.ts 一致';
GRANT EXECUTE ON FUNCTION model_display_name(TEXT) TO anon, authenticated;

CREATE TABLE IF NOT EXISTS agent_tool_notices (
  agent_name TEXT NOT NULL,
  agent_tool TEXT NOT NULL DEFAULT '',
  first_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_name, agent_tool)
);
COMMENT ON TABLE agent_tool_notices IS '回應的 agent_tool notice 已對哪些（代號, agent_tool）組合出現過；每組只提醒一次。只給 service_role（RLS 開、無政策）。2026-10-18';
ALTER TABLE agent_tool_notices ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION agent_tool_notice_first(p_agent_name TEXT, p_agent_tool TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_rows INTEGER;
BEGIN
  INSERT INTO agent_tool_notices (agent_name, agent_tool)
  VALUES (p_agent_name, COALESCE(btrim(p_agent_tool), ''))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;
COMMENT ON FUNCTION agent_tool_notice_first IS '第一次見到這組（代號, agent_tool）回 true（並記下），之後回 false。回應是否附 agent_tool notice 看它。只給 service_role。2026-10-18';
REVOKE ALL ON FUNCTION agent_tool_notice_first(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION agent_tool_notice_first(TEXT, TEXT) TO service_role;
