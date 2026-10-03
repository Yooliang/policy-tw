-- 統計頁「各模型表現」（2026-10-03 維護者：各 AI 模型的交件與投票表現做成固定功能，不用每次叫主線手動查）
--
-- 1. model_display_name(agent_tool)：代理自填的「工具/模型」→「系列＋版本」顯示名稱。
--    規則表與 supabase/functions/_shared/model-name.ts 逐條一致（model-name.test.ts 盯著），改規則兩邊一起改。
--    要分到代別（Claude Sonnet 4.5 ≠ Claude Sonnet 5）；只寫系列沒版本的（claude-code/haiku）獨立成「未標版本」一列；
--    工具前綴不影響歸類；NULL／空白 →「未填」；對不上任何規則 →「其他」（原字串在彙總的 raw_tools 裡查得到）。
-- 2. model_contribution_stats(天數)：每個模型、每個模型×型別的交件結果。
-- 3. model_vote_stats(天數)：每個模型的投票，只算目標貢獻已有結果（applied／rejected）的票。
--
-- 只加新物件，不動既有的。公開讀（anon），只給彙總，不含 IP、不含代號。

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
      (46, 'gemini', 'Gemini（未標版本）')
      ) AS r(ord, pat, tpl)
      CROSS JOIN LATERAL (SELECT regexp_match(regexp_replace(lower(p_agent_tool), '[\s_]+', '-', 'g'), r.pat) AS m) x
     WHERE x.m IS NOT NULL
     ORDER BY r.ord LIMIT 1
  ), '其他') END
$$;
COMMENT ON FUNCTION model_display_name IS '代理自填的 agent_tool →「系列＋版本」顯示名稱（未標版本者獨立一列；NULL＝未填、認不出＝其他）。規則與 _shared/model-name.ts 一致';
GRANT EXECUTE ON FUNCTION model_display_name(TEXT) TO anon, authenticated;

-- 交件：每個模型一列（contribution_type 為 NULL），外加每個模型×型別一列。期間 1～90 天。
--   狀態全部分欄給（applied／rejected／pending／verified／disputed／superseded／withdrawn，
--   其餘 apply_failed／reverted 併成 other_status），各欄加總＝submitted。
--   上線率、退件率的分母是 applied＋rejected（維護者 2026-10-03）：superseded（被更新資料蓋過）、withdrawn（例如 9/18 整批撤回）
--   跟品質無關，拿全部交件當分母會把比例拉低，看起來像「一半沒結果」。這個除法在前端做，這裡只給件數。
--   no_change／no_change_missing：無異動的筆數、其中回查無／打不開（outcome not_found、unreachable）的筆數
--   data_decided／data_rejected：資料型（policy、politician、candidacy、correction）已有結果（applied＋rejected）的筆數、其中退件
--   raw_tools：模型列才有，歸進這一列的原始 agent_tool 與筆數（多到少，前 20 種），讓人查正規化歸得對不對
-- 先對 DISTINCT agent_tool 算一次顯示名稱再接回來（MATERIALIZED＋等號接回）：幾十種字串只跑幾十次規則表。
-- 沒有 MATERIALIZED 時規劃器會把它攤回每一列、IS NOT DISTINCT FROM 又只能巢狀迴圈，線上實測 30 天要 45 秒。
CREATE OR REPLACE FUNCTION model_contribution_stats(p_days INTEGER DEFAULT 14)
RETURNS TABLE (
  model TEXT, contribution_type TEXT, submitted BIGINT, applied BIGINT, rejected BIGINT, pending BIGINT, verified BIGINT, disputed BIGINT,
  superseded BIGINT, withdrawn BIGINT, other_status BIGINT, no_change BIGINT, no_change_missing BIGINT, data_decided BIGINT, data_rejected BIGINT, raw_tools JSONB
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH c AS (
    SELECT c.agent_tool, c.contribution_type, c.status, c.payload->>'outcome' AS outcome
      FROM contributions c
     WHERE c.created_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 90))
  ), t AS MATERIALIZED (
    SELECT d.tool_key, model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM c) d
  ), j AS (
    SELECT t.model, c.* FROM c JOIN t ON t.tool_key = COALESCE(c.agent_tool, '')
  ), agg AS (
    SELECT j.model, j.contribution_type,
           COUNT(*) AS submitted,
           COUNT(*) FILTER (WHERE j.status = 'applied') AS applied,
           COUNT(*) FILTER (WHERE j.status = 'rejected') AS rejected,
           COUNT(*) FILTER (WHERE j.status = 'pending') AS pending,
           COUNT(*) FILTER (WHERE j.status = 'verified') AS verified,
           COUNT(*) FILTER (WHERE j.status = 'disputed') AS disputed,
           COUNT(*) FILTER (WHERE j.status = 'superseded') AS superseded,
           COUNT(*) FILTER (WHERE j.status = 'withdrawn') AS withdrawn,
           COUNT(*) FILTER (WHERE j.status NOT IN ('applied', 'rejected', 'pending', 'verified', 'disputed', 'superseded', 'withdrawn')) AS other_status,
           COUNT(*) FILTER (WHERE j.contribution_type = 'no_change') AS no_change,
           COUNT(*) FILTER (WHERE j.contribution_type = 'no_change' AND j.outcome IN ('not_found', 'unreachable')) AS no_change_missing,
           COUNT(*) FILTER (WHERE j.contribution_type IN ('policy', 'politician', 'candidacy', 'correction') AND j.status IN ('applied', 'rejected')) AS data_decided,
           COUNT(*) FILTER (WHERE j.contribution_type IN ('policy', 'politician', 'candidacy', 'correction') AND j.status = 'rejected') AS data_rejected
      FROM j
     GROUP BY GROUPING SETS ((j.model), (j.model, j.contribution_type))
  ), raw AS (
    SELECT r.model, jsonb_agg(jsonb_build_object('tool', r.agent_tool, 'n', r.n) ORDER BY r.n DESC, r.agent_tool) AS raw_tools
      FROM (
        SELECT j.model, j.agent_tool, COUNT(*) AS n, row_number() OVER (PARTITION BY j.model ORDER BY COUNT(*) DESC, j.agent_tool) AS rk
          FROM j GROUP BY j.model, j.agent_tool
      ) r
     WHERE r.rk <= 20
     GROUP BY r.model
  )
  SELECT agg.model, agg.contribution_type, agg.submitted, agg.applied, agg.rejected, agg.pending, agg.verified, agg.disputed,
         agg.superseded, agg.withdrawn, agg.other_status, agg.no_change, agg.no_change_missing, agg.data_decided, agg.data_rejected,
         CASE WHEN agg.contribution_type IS NULL THEN raw.raw_tools END
    FROM agg LEFT JOIN raw ON raw.model = agg.model
   ORDER BY agg.model, agg.contribution_type NULLS FIRST
$$;
COMMENT ON FUNCTION model_contribution_stats IS '近 N 天（1～90）各模型的交件結果：模型列（型別 NULL）＋模型×型別列；含無異動查無率與資料型退件率的分子分母、歸進該列的原始 agent_tool。公開，不含 IP 與代號';
GRANT EXECUTE ON FUNCTION model_contribution_stats(INTEGER) TO anon, authenticated;

-- 投票：只算目標貢獻已有結果（applied／rejected）的票，期間以投票時間算。
--   wrong：事後證明投錯＝投 agree 但最後 rejected ＋ 投 disagree 但最後 applied；比例的分母是 agree＋disagree（unsure 不算對錯）
--   系統票（agent_name 以 jev 開頭、via 含 system、或 agent_tool 歸到 Jev）不歸到任何模型，單獨一列「系統票（Jev）」。
--   注意：Jev 的「系統來源票」主體不在 contribution_votes（在 jev_decisions，只在計票時生效），這裡數不到，這一列只是零星的轉投票。
CREATE OR REPLACE FUNCTION model_vote_stats(p_days INTEGER DEFAULT 14)
RETURNS TABLE (model TEXT, votes BIGINT, agree BIGINT, disagree BIGINT, unsure BIGINT, wrong BIGINT, raw_tools JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (
    SELECT v.agent_tool, v.verdict, c.status,
           (v.agent_name LIKE 'jev%' OR COALESCE(v.via, '') ILIKE '%system%') AS is_system
      FROM contribution_votes v
      JOIN contributions c ON c.id = v.contribution_id
     WHERE v.created_at > now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 14), 1), 90))
       AND c.status IN ('applied', 'rejected')
  ), t AS MATERIALIZED (
    SELECT d.tool_key, model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM v) d
  ), j AS (
    SELECT CASE WHEN v.is_system OR t.model = 'Jev（系統）' THEN '系統票（Jev）' ELSE t.model END AS model, v.*
      FROM v JOIN t ON t.tool_key = COALESCE(v.agent_tool, '')
  ), raw AS (
    SELECT r.model, jsonb_agg(jsonb_build_object('tool', r.agent_tool, 'n', r.n) ORDER BY r.n DESC, r.agent_tool) AS raw_tools
      FROM (
        SELECT j.model, j.agent_tool, COUNT(*) AS n, row_number() OVER (PARTITION BY j.model ORDER BY COUNT(*) DESC, j.agent_tool) AS rk
          FROM j GROUP BY j.model, j.agent_tool
      ) r
     WHERE r.rk <= 20
     GROUP BY r.model
  ), agg AS (
    SELECT j.model,
           COUNT(*) AS votes,
           COUNT(*) FILTER (WHERE j.verdict = 'agree') AS agree,
           COUNT(*) FILTER (WHERE j.verdict = 'disagree') AS disagree,
           COUNT(*) FILTER (WHERE j.verdict = 'unsure') AS unsure,
           COUNT(*) FILTER (WHERE (j.verdict = 'agree' AND j.status = 'rejected') OR (j.verdict = 'disagree' AND j.status = 'applied')) AS wrong
      FROM j GROUP BY j.model
  )
  SELECT agg.model, agg.votes, agg.agree, agg.disagree, agg.unsure, agg.wrong, raw.raw_tools
    FROM agg LEFT JOIN raw ON raw.model = agg.model
   ORDER BY agg.votes DESC, agg.model
$$;
COMMENT ON FUNCTION model_vote_stats IS '近 N 天（1～90）各模型的投票（只算目標已有結果的票）：票數、同意／反對／不確定、事後證明投錯；系統票單獨一列。公開，不含 IP 與代號';
GRANT EXECUTE ON FUNCTION model_vote_stats(INTEGER) TO anon, authenticated;
