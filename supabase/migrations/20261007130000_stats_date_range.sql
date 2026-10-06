-- 站務主控台要「台灣日曆日」的精確區間（今日＝台北今天 00:00 到現在、昨日＝昨天整天、近 7／30 日＝含今天的日曆日），
-- 但公開統計 RPC 只吃滾動天數（now() - N 天）。這支替四個 RPC 各加一個「區間」多載，只加不改既有行為。
--
-- 做法（只加不刪、不改簽名、不動舊函式）：
--   contribution_leaderboard(p_since, p_until)   貢獻榜（跟 contribution_leaderboard(p_days) 同規則，只換時間窗）
--   model_contribution_stats(p_since, p_until)   各模型交件結果（同 p_days 版）
--   model_vote_stats(p_since, p_until)           各模型投票（同 p_days 版）
--   ai_reads_summary(p_since, p_until)           AI 讀取（同 p_days 版）
-- 舊的 (p_days) 版一個字都沒動：前端、Edge Function、contribution_feed_summary 的既有呼叫結果不變。
--
-- 時間窗語意：半開區間 [p_since, p_until)。p_until 填 NULL＝不設上界（今日就是 p_since＝今天 00:00、p_until＝NULL 或 now()）。
--   * 貢獻榜：p_since 為 NULL＝不設下界（兩個都 NULL＝總榜，跟 p_days NULL 同）。
--   * 模型表現：下界一律不早於 now() - 90 天（舊版天數上限 90 天，公開 RPC 的成本上限一併沿用；p_since NULL＝90 天前）。
--   * AI 讀取：ai_reads_daily 以「台北日期」為粒度，所以區間換成台北日期：
--       含 p_since 當天、含 (p_until - 1 微秒) 當天——昨天整天＝ [昨天 00:00, 今天 00:00) 只會算到昨天；下界同樣不早於台北今天 - 89 日（共 90 日）。
--     這是日粒度的表，同一天只有一部分落在區間內時整天算進去（沒辦法拆）。
--
-- 為什麼是「多載」而不是在舊函式加 DEFAULT NULL 的參數，而且兩個參數都沒有預設值：
--   1. 舊函式 (p_days INTEGER) 與新函式若在同名、前面參數相同、後面都有預設值，呼叫 f(7) 會被 Postgres 判成「不唯一」而報錯。
--   2. contribution_feed_summary 的本體用 contribution_leaderboard(NULL)（未標型別的 NULL）呼叫舊版；
--      新多載若只要一個參數就能呼叫，NULL 會在整數與時間之間分不出來而整支統計掛掉。兩個參數都必填就不會跟任何一個單參數呼叫競爭。
--   所以新多載必須同時給兩個值（沒有上下界的那端明確傳 NULL）。PostgREST 具名參數呼叫：{ "p_since": "...", "p_until": null }。
-- 設定與舊版一樣：SECURITY DEFINER、search_path = public、STABLE，授權 anon／authenticated／service_role；
-- 回傳欄位與舊版相同，沒有新增任何欄位（不含 IP、不含代號以外的個資）。

CREATE OR REPLACE FUNCTION contribution_leaderboard(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH excluded AS (
  SELECT unnest(ARRAY[
    'test-deepseek','test-deepseek-1','test-deepseek-2','test-deepseek-3','test-deepseek-4','test-deepseek-5',
    'test-claude','test-gemini','xiaoliang-roster','xiaoliang-probe'
  ]) AS agent_name
),
sub AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name,
         COUNT(*) AS submitted,
         COUNT(*) FILTER (WHERE status = 'applied') AS applied
  FROM contributions
  WHERE (p_since IS NULL OR created_at >= p_since) AND (p_until IS NULL OR created_at < p_until)
  GROUP BY 1
),
vot AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, COUNT(*) AS verified_votes
  FROM contribution_votes
  WHERE (p_since IS NULL OR created_at >= p_since) AND (p_until IS NULL OR created_at < p_until)
  GROUP BY 1
),
merged AS (
  SELECT COALESCE(s.agent_name, v.agent_name) AS agent_name,
         COALESCE(s.submitted, 0) AS submitted,
         COALESCE(s.applied, 0) AS applied,
         COALESCE(v.verified_votes, 0) AS verified_votes
  FROM sub s FULL OUTER JOIN vot v ON v.agent_name = s.agent_name
)
SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'score')::int DESC, (x->>'applied')::int DESC, (x->>'submitted')::int DESC), '[]'::jsonb)
FROM (
  SELECT jsonb_build_object(
    'agent_name', agent_name,
    'submitted', submitted,
    'applied', applied,
    'verified_votes', verified_votes,
    'score', submitted + applied + verified_votes
  ) AS x
  FROM merged
  WHERE agent_name NOT IN (SELECT agent_name FROM excluded)
    AND submitted + applied + verified_votes > 0
  ORDER BY submitted + applied + verified_votes DESC, applied DESC, submitted DESC
  LIMIT 30
) t;
$$;

CREATE OR REPLACE FUNCTION model_contribution_stats(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (
  model TEXT, contribution_type TEXT, submitted BIGINT, applied BIGINT, rejected BIGINT, pending BIGINT, verified BIGINT, disputed BIGINT,
  superseded BIGINT, withdrawn BIGINT, other_status BIGINT, no_change BIGINT, no_change_missing BIGINT, data_decided BIGINT, data_rejected BIGINT, raw_tools JSONB
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH c AS (
    SELECT c.agent_tool, c.contribution_type, c.status, c.payload->>'outcome' AS outcome
      FROM contributions c
     WHERE c.created_at >= GREATEST(COALESCE(p_since, now() - INTERVAL '90 days'), now() - INTERVAL '90 days')
       AND (p_until IS NULL OR c.created_at < p_until)
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

CREATE OR REPLACE FUNCTION model_vote_stats(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (model TEXT, votes BIGINT, agree BIGINT, disagree BIGINT, unsure BIGINT, wrong BIGINT, raw_tools JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (
    SELECT v.agent_tool, v.verdict, c.status,
           (v.agent_name LIKE 'jev%' OR COALESCE(v.via, '') ILIKE '%system%') AS is_system
      FROM contribution_votes v
      JOIN contributions c ON c.id = v.contribution_id
     WHERE v.created_at >= GREATEST(COALESCE(p_since, now() - INTERVAL '90 days'), now() - INTERVAL '90 days')
       AND (p_until IS NULL OR v.created_at < p_until)
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

CREATE OR REPLACE FUNCTION ai_reads_summary(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (kind TEXT, agent TEXT, hits BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.kind, r.agent, SUM(r.hits)::BIGINT
    FROM ai_reads_daily r
   WHERE r.day >= GREATEST(COALESCE((p_since AT TIME ZONE 'Asia/Taipei')::DATE, DATE '0001-01-01'), (now() AT TIME ZONE 'Asia/Taipei')::DATE - 89)
     AND (p_until IS NULL OR r.day <= ((p_until - INTERVAL '1 microsecond') AT TIME ZONE 'Asia/Taipei')::DATE)
   GROUP BY r.kind, r.agent
$$;

COMMENT ON FUNCTION contribution_leaderboard(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '貢獻榜（區間版）：[p_since, p_until) 內的提交＋上線＋驗證票，規則同 contribution_leaderboard(p_days)；NULL＝該端不設界。';
GRANT EXECUTE ON FUNCTION contribution_leaderboard(TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;

COMMENT ON FUNCTION model_contribution_stats(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '各模型交件結果（區間版）：[p_since, p_until)，下界不早於 90 天前；規則同 model_contribution_stats(p_days)。公開，不含 IP 與代號';
GRANT EXECUTE ON FUNCTION model_contribution_stats(TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;

COMMENT ON FUNCTION model_vote_stats(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '各模型投票（區間版）：[p_since, p_until)，下界不早於 90 天前；規則同 model_vote_stats(p_days)。公開，不含 IP 與代號';
GRANT EXECUTE ON FUNCTION model_vote_stats(TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;

COMMENT ON FUNCTION ai_reads_summary(TIMESTAMPTZ, TIMESTAMPTZ) IS
  'AI 讀取（區間版）：把 [p_since, p_until) 換成台北日期（含起訖當天），下界不早於台北今天 - 89 日；規則同 ai_reads_summary(p_days)';
GRANT EXECUTE ON FUNCTION ai_reads_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO anon, authenticated, service_role;
