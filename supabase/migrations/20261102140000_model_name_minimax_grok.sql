-- model_display_name 加 MiniMax、Grok 規則（2026-11-02，熱修）
--
-- /ai 各模型表現把 pi/minimax-m3.1-flash、grok-build/grok-4.7 顯示成「（未揭露模型）」，但這兩個都是明確模型。
-- 在最後一條「工具/產品名」通配規則前插入 5 條：MiniMax M<版本> [Flash]、MiniMax（未標版本）、Grok <版本> [後綴]、Grok <版本>。
-- 沒有版本號的 grok 不另立規則（會吃掉 grok-bot/grok-bot，它仍歸「grok-bot（未揭露模型）」）。
-- 原 47 條通配規則順延為 52；其餘 46 條與 20261018010000 逐字相同；與 _shared/model-name.ts 一致。日本站不跟。

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
      (47, 'minimax-m(\d+(?:\.\d+)?)-flash', 'MiniMax M\1 Flash'),
      (48, 'minimax-m(\d+(?:\.\d+)?)', 'MiniMax M\1'),
      (49, 'minimax', 'MiniMax（未標版本）'),
      (50, 'grok-(\d+(?:\.\d+)?)-([a-z]+)', 'Grok \1 \2'),
      (51, 'grok-(\d+(?:\.\d+)?)', 'Grok \1'),
      (52, '^[^/]+/([a-z0-9][a-z0-9.-]{1,39})$', '\1（未揭露模型）')
      ) AS r(ord, pat, tpl)
      CROSS JOIN LATERAL (SELECT regexp_match(regexp_replace(lower(p_agent_tool), '[\s_]+', '-', 'g'), r.pat) AS m) x
     WHERE x.m IS NOT NULL
     ORDER BY r.ord LIMIT 1
  ), '其他') END
$$;
COMMENT ON FUNCTION model_display_name IS '代理自填的 agent_tool →「系列＋版本」顯示名稱（未標版本者獨立一列；平台不揭露模型、只給「工具/產品名」的歸「產品名（未揭露模型）」；NULL＝未填、都對不上＝其他）。規則與 _shared/model-name.ts 一致';
GRANT EXECUTE ON FUNCTION model_display_name(TEXT) TO anon, authenticated;
