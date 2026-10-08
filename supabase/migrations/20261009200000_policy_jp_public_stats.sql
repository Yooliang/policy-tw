-- 日本站（政策の系譜）給站務主控台（policy-console）讀的公開統計：貢獻統計與榜、各模型交件與投票、管線快照
-- （policy-jp #41；接在 20261009130100_policy_jp_election_discovery.sql 之後）
-- ============================================================
--
-- 為什麼：主控台的「貢獻」「AI」兩頁正見已經有了，日本站要看同一組數字。主控台只有 Supabase 公開金鑰（anon），
-- 所以日本站也要有「anon 可呼叫、只回彙總」的函式；正見是同一個做法（SECURITY DEFINER 的統計 RPC）。
--
-- 原則（照 #495／#500）：anon 不開任何表。連 pipeline_snapshots 也不給 Public read——所有公開數字一律經 SECURITY DEFINER 函式讀，
--   函式只回彙總（件數、比例、貢獻者顯示名、模型名），不回 ip_hash（contributor_ip_hash／verifier_ip_hash 不出現在任何輸出）、
--   不回貢獻內容（payload、note、source_urls）、不回任務與人物 id。
--
-- 回傳了哪些身份相關欄位（逐一列出，與正見同名函式的輸出欄位一致，沒有多出任何原始欄位）：
--   * contribution_leaderboard（兩個多載）與 contribution_feed_summary 裡的三個榜：agent_name＝代理自報的顯示名
--     （btrim 後，空白＝'(unknown)'，排除 excluded_agents，前 30 名；正見的 /contributions 頁公開同樣的欄位）。其餘欄位全是計數：submitted、applied、verified_votes、score
--   * model_contribution_stats／model_vote_stats：model＝model_display_name() 正規化後的模型顯示名（不是原字串）；
--     raw_tools[].tool＝代理自填的 agent_tool 原字串（只在「模型列」、前 20 種、附筆數 n；正見同樣公開，主控台不讀它）
--   * contribution_activity、pipeline_snapshots_since：沒有任何身份欄位（時間桶／快照時間、計數、各類缺口件數）
--
-- 抄法（同 20261009130000 的慣例）：函式本體逐字抄自正見現行定義，只做一份固定清單的機械式替換；之後正見改了被抄的函式，
--   supabase/functions/_shared/policy-jp-public-stats.test.ts 的走樣守門會紅，要決定日本版跟不跟。
--   替換清單（守門測試逐支還原比對）：
--     R1  物件名加 policy_jp. 前綴（表與函式）
--     R2  SECURITY DEFINER 的函式釘 SET search_path = policy_jp, pg_temp（正見是 SET search_path = public；pipeline_take_snapshot 正見沒釘，這裡補上）
--   各函式另有的偏離（對正見定義的精確替換，守門測試的對照表逐條登記）：
--     pipeline_take_snapshot：拿掉 questions（日本站沒有公民提問）；政策、人物只數 review_status = 'published'（日本站沒有 removed_at，未發布的不是站上看得到的資料）
--     pipeline_snapshots（表）：拿掉 questions 欄；不抄 "Public read"／"Service role write" 兩條 policy（見上，anon 不開表）
--   時區：contribution_activity／contribution_feed_summary 的日期桶沿用 Asia/Taipei——主控台的「日曆日」全站統一用台北時間，兩站要放在同一張圖上比。日本站前端若要自己用 daily_last_7，再另開函式
--   沒有抄 model_contribution_stats／model_vote_stats 的 (p_days) 多載：主控台只用區間版，日本站前端還沒有用到的地方
--   型別：日本站的人物、政見 id 是 TEXT，但這些函式只數列數與狀態，不碰 id，沒有需要換型別的地方
--
-- 沒有抄的（日本站沒有對應的資料）：ai_reads_summary／ai_reads_series（沒有 ai_reads_daily，AI 爬蟲讀取量）、news_daily_stats（沒有新聞管線）。
--   主控台對日本站隱藏「AI 讀取」「新聞追蹤」兩個分頁。
--
-- 非複本（日本站自己的）：pipeline_snapshots_since——正見把 pipeline_snapshots 開成 Public read 表，主控台直接 REST 讀；
--   日本站不開表，改成這支 SECURITY DEFINER 函式，回主控台用到的五個欄位（taken_at、tasks_by_type、pending、applied、votes_total）。
--
-- 權限：統計函式共 7 支 GRANT EXECUTE 給 anon、authenticated、service_role（contribution_leaderboard 兩個多載、contribution_feed_summary、
--   contribution_activity、model_contribution_stats、model_vote_stats、pipeline_snapshots_since）；model_display_name、contribution_auto_task_counts、
--   pipeline_take_snapshot 只給 service_role（排程以擁有者身分跑，不需要授權；正見的 pipeline_take_snapshot 沒收回 PUBLIC 的 EXECUTE，匿名也能呼叫，日本站不照抄這個疏漏）。
--   表 excluded_agents、pipeline_snapshots 是內部表：anon 讀不到。
-- 獨立於正見：不引用任何 public 物件（守門測試在沒有正見物件的資料庫上跑）。

-- ------------------------------------------------------------
-- 1. 內部表（RLS 開、不加 policy、不給 anon／authenticated 任何權限；service_role 全權）
-- ------------------------------------------------------------
-- 抄自 20261008000010_excluded_agents.sql。日本站沒有種子（正見的 10 個是維護者在台灣開的測試代號）：空表＝沒有人被排除；
-- 要排除某個代號就 INSERT 一列，貢獻榜與「貢獻者」數字立刻生效。內部表慣例：沒有 "Public read"（函式是 SECURITY DEFINER，讀得到）。
CREATE TABLE IF NOT EXISTS policy_jp.excluded_agents (
  agent_name TEXT PRIMARY KEY CHECK (agent_name = btrim(agent_name) AND agent_name <> ''),
  reason TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE policy_jp.excluded_agents IS
  '不列入貢獻榜與「貢獻者」數字的代號（維護者自己開的測試與探測代理）。比對的是 btrim 後的 agent_name，要明列代號（不用前綴）。日本站出廠是空的；內部表，anon 讀不到，統計函式（SECURITY DEFINER）會讀';

-- 抄自 20260912000018_pipeline_snapshots.sql。拿掉 questions 欄（日本站沒有公民提問）。
-- 欄位 votes_total／voters 是「驗證票」（外部代理對貢獻的投票）的累計與人數，不是選舉得票；名稱照正見，主控台讀的就是這個名字。
-- 正見的 "Public read" 與 "Service role write" 兩條 policy 都不抄：公開讀改走 pipeline_snapshots_since()，寫入只有排程（擁有者）與 service_role（BYPASSRLS）。
CREATE TABLE IF NOT EXISTS policy_jp.pipeline_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 任務池：總數與各類缺口的細目
  tasks_open    INTEGER NOT NULL DEFAULT 0,
  tasks_by_type JSONB   NOT NULL DEFAULT '{}'::jsonb,
  -- 貢獻佇列
  pending       INTEGER NOT NULL DEFAULT 0,
  applied       INTEGER NOT NULL DEFAULT 0,
  disputed      INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0,
  -- 驗證：累計票數，以及投過票的人數
  votes_total   INTEGER NOT NULL DEFAULT 0,
  voters        INTEGER NOT NULL DEFAULT 0,
  -- 正式資料量，看管線到底有沒有讓資料長出來
  policies      INTEGER NOT NULL DEFAULT 0,
  politicians   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pipeline_snapshots_taken_idx ON policy_jp.pipeline_snapshots (taken_at DESC);
COMMENT ON TABLE policy_jp.pipeline_snapshots IS '每小時一筆的管線健康度快照（日本站）；內部表，公開讀走 pipeline_snapshots_since()';

ALTER TABLE policy_jp.excluded_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_jp.pipeline_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON policy_jp.excluded_agents, policy_jp.pipeline_snapshots FROM PUBLIC, anon, authenticated;
GRANT ALL ON policy_jp.excluded_agents, policy_jp.pipeline_snapshots TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA policy_jp TO service_role;

-- ------------------------------------------------------------
-- 2. 統計函式（複本）
-- ------------------------------------------------------------
-- 抄自 20261003000003_model_quality_stats.sql
CREATE OR REPLACE FUNCTION policy_jp.model_display_name(p_agent_tool TEXT) RETURNS TEXT
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

-- 抄自 20261008000010_excluded_agents.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_leaderboard(p_days integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = policy_jp, pg_temp
AS $$
WITH excluded AS (
  -- 測試與探測代號讀 excluded_agents（以前是這裡寫死的一串名字，同一串抄在三支函式裡）
  SELECT agent_name FROM policy_jp.excluded_agents
),
since AS (SELECT CASE WHEN p_days IS NULL THEN NULL ELSE now() - make_interval(days => p_days) END AS ts),
sub AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name,
         COUNT(*) AS submitted,
         COUNT(*) FILTER (WHERE status = 'applied') AS applied
  FROM policy_jp.contributions
  WHERE (SELECT ts FROM since) IS NULL OR created_at >= (SELECT ts FROM since)
  GROUP BY 1
),
vot AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, COUNT(*) AS verified_votes
  FROM policy_jp.contribution_votes
  WHERE (SELECT ts FROM since) IS NULL OR created_at >= (SELECT ts FROM since)
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

-- 抄自 20261008000010_excluded_agents.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_leaderboard(p_since timestamp with time zone, p_until timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = policy_jp, pg_temp
AS $$
WITH excluded AS (
  -- 測試與探測代號讀 excluded_agents（以前是這裡寫死的一串名字，同一串抄在三支函式裡）
  SELECT agent_name FROM policy_jp.excluded_agents
),
sub AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name,
         COUNT(*) AS submitted,
         COUNT(*) FILTER (WHERE status = 'applied') AS applied
  FROM policy_jp.contributions
  WHERE (p_since IS NULL OR created_at >= p_since) AND (p_until IS NULL OR created_at < p_until)
  GROUP BY 1
),
vot AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, COUNT(*) AS verified_votes
  FROM policy_jp.contribution_votes
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

-- 抄自 20261009200000_policy_jp_public_stats.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_feed_summary()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path = policy_jp, pg_temp
AS $$
WITH excluded AS (
  -- 測試與探測代號讀 excluded_agents（以前是這裡寫死的一串名字，同一串抄在三支函式裡）
  SELECT agent_name FROM policy_jp.excluded_agents
),
c AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, status, created_at
  FROM policy_jp.contributions
),
v AS (
  SELECT COALESCE(NULLIF(btrim(agent_name), ''), '(unknown)') AS agent_name, created_at
  FROM policy_jp.contribution_votes
),
by_status AS (
  SELECT jsonb_object_agg(status, n) AS obj FROM (SELECT status, COUNT(*) n FROM c GROUP BY status) t
),
days AS (
  SELECT ((now() AT TIME ZONE 'Asia/Taipei')::date - i) AS d FROM generate_series(0, 6) i
),
daily AS (
  SELECT jsonb_agg(jsonb_build_object('date', to_char(d.d, 'YYYY-MM-DD'), 'count', s.n, 'verifications', vv.n) ORDER BY d.d) AS arr
  FROM days d
  LEFT JOIN LATERAL (SELECT COUNT(*) n FROM c WHERE (c.created_at AT TIME ZONE 'Asia/Taipei')::date = d.d) s ON TRUE
  LEFT JOIN LATERAL (SELECT COUNT(*) n FROM v WHERE (v.created_at AT TIME ZONE 'Asia/Taipei')::date = d.d) vv ON TRUE
),
contributors AS (
  SELECT COUNT(DISTINCT c.agent_name) AS n
  FROM c WHERE c.created_at >= now() - INTERVAL '30 days'
    AND c.agent_name NOT IN (SELECT agent_name FROM excluded)
),
contributors_all AS (
  SELECT COUNT(DISTINCT c.agent_name) AS n
  FROM c WHERE c.agent_name NOT IN (SELECT agent_name FROM excluded)
),
adjudicating AS (
  SELECT COUNT(*) AS n FROM policy_jp.contribution_tasks WHERE task_type = 'adjudicate' AND status = 'open'
)
SELECT jsonb_build_object(
  'total', (SELECT COUNT(*) FROM c),
  'by_status', COALESCE((SELECT obj FROM by_status), '{}'::jsonb),
  'needs_attention', jsonb_build_object(
    'total', (SELECT COUNT(*) FROM c WHERE status = 'disputed'),
    'disputed', (SELECT COUNT(*) FROM c WHERE status = 'disputed'),
    'retrying', (SELECT COUNT(*) FROM c WHERE status = 'apply_failed')
  ),
  'adjudicating', (SELECT n FROM adjudicating),
  'contributors_30d', (SELECT n FROM contributors),
  'contributors_total', (SELECT n FROM contributors_all),
  'daily_last_7', COALESCE((SELECT arr FROM daily), '[]'::jsonb),
  'leaderboard', policy_jp.contribution_leaderboard(NULL),
  'leaderboard_30d', policy_jp.contribution_leaderboard(30),
  'leaderboard_7d', policy_jp.contribution_leaderboard(7)
);
$$;

-- 抄自 20261009200000_policy_jp_public_stats.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_activity(p_hours INTEGER DEFAULT 168)
RETURNS TABLE (bucket TEXT, submissions BIGINT, verifications BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT LEAST(GREATEST(COALESCE(p_hours, 168), 1), 24 * 90) AS h
  ),
  unit AS (SELECT CASE WHEN h <= 48 THEN 'hour' ELSE 'day' END AS u, h FROM p),
  series AS (
    SELECT generate_series(
             date_trunc((SELECT u FROM unit), (now() AT TIME ZONE 'Asia/Taipei') - make_interval(hours => (SELECT h FROM unit) - 1)),
             date_trunc((SELECT u FROM unit), now() AT TIME ZONE 'Asia/Taipei'),
             CASE WHEN (SELECT u FROM unit) = 'hour' THEN INTERVAL '1 hour' ELSE INTERVAL '1 day' END) AS b
  ),
  s AS (
    SELECT date_trunc((SELECT u FROM unit), c.created_at AT TIME ZONE 'Asia/Taipei') AS b, COUNT(*) AS n
      FROM policy_jp.contributions c
     WHERE c.created_at > now() - make_interval(hours => (SELECT h FROM unit))
     GROUP BY 1
  ),
  v AS (
    SELECT date_trunc((SELECT u FROM unit), x.created_at AT TIME ZONE 'Asia/Taipei') AS b, COUNT(*) AS n
      FROM policy_jp.contribution_votes x
     WHERE x.created_at > now() - make_interval(hours => (SELECT h FROM unit))
     GROUP BY 1
  )
  SELECT CASE WHEN (SELECT u FROM unit) = 'hour' THEN to_char(series.b, 'HH24:00') ELSE to_char(series.b, 'MM-DD') END,
         COALESCE(s.n, 0), COALESCE(v.n, 0)
    FROM series LEFT JOIN s ON s.b = series.b LEFT JOIN v ON v.b = series.b
   ORDER BY series.b
$$;

-- 抄自 20261009200000_policy_jp_public_stats.sql
CREATE OR REPLACE FUNCTION policy_jp.model_contribution_stats(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (
  model TEXT, contribution_type TEXT, submitted BIGINT, applied BIGINT, rejected BIGINT, pending BIGINT, verified BIGINT, disputed BIGINT,
  superseded BIGINT, withdrawn BIGINT, other_status BIGINT, no_change BIGINT, no_change_missing BIGINT, data_decided BIGINT, data_rejected BIGINT, raw_tools JSONB
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH c AS (
    SELECT c.agent_tool, c.contribution_type, c.status, c.payload->>'outcome' AS outcome
      FROM policy_jp.contributions c
     WHERE c.created_at >= GREATEST(COALESCE(p_since, now() - INTERVAL '90 days'), now() - INTERVAL '90 days')
       AND (p_until IS NULL OR c.created_at < p_until)
  ), t AS MATERIALIZED (
    SELECT d.tool_key, policy_jp.model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM c) d
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

-- 抄自 20261009200000_policy_jp_public_stats.sql
CREATE OR REPLACE FUNCTION policy_jp.model_vote_stats(p_since TIMESTAMPTZ, p_until TIMESTAMPTZ)
RETURNS TABLE (model TEXT, votes BIGINT, agree BIGINT, disagree BIGINT, unsure BIGINT, wrong BIGINT, raw_tools JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH v AS (
    SELECT v.agent_tool, v.verdict, c.status,
           (v.agent_name LIKE 'jev%' OR COALESCE(v.via, '') ILIKE '%system%') AS is_system
      FROM policy_jp.contribution_votes v
      JOIN policy_jp.contributions c ON c.id = v.contribution_id
     WHERE v.created_at >= GREATEST(COALESCE(p_since, now() - INTERVAL '90 days'), now() - INTERVAL '90 days')
       AND (p_until IS NULL OR v.created_at < p_until)
       AND c.status IN ('applied', 'rejected')
  ), t AS MATERIALIZED (
    SELECT d.tool_key, policy_jp.model_display_name(NULLIF(d.tool_key, '')) AS model FROM (SELECT DISTINCT COALESCE(agent_tool, '') AS tool_key FROM v) d
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

-- ------------------------------------------------------------
-- 3. 管線快照：計數函式與採樣函式（複本）、公開讀取函式（非複本）、排程
-- ------------------------------------------------------------
-- 抄自 20260912000023_fix_task_count_cap.sql
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_task_counts(p_region TEXT DEFAULT NULL)
RETURNS TABLE (task_type TEXT, total BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT t.task_type, COUNT(*) FROM policy_jp.contribution_auto_tasks(NULL, p_region, 100000, '') t GROUP BY t.task_type ORDER BY 1;
$$;

-- 抄自 20260912000018_pipeline_snapshots.sql（扣掉登記的片段：questions、政策與人物只數 published）
CREATE OR REPLACE FUNCTION policy_jp.pipeline_take_snapshot() RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_by_type JSONB;
  v_auto    INTEGER;
  v_manual  INTEGER;
  v_id      BIGINT;
BEGIN
  -- 各類自動缺口。contribution_auto_tasks 是即時算的，所以這裡拿到的是當下真實缺口。
  SELECT COALESCE(jsonb_object_agg(task_type, total), '{}'::jsonb), COALESCE(SUM(total), 0)
    INTO v_by_type, v_auto
    FROM policy_jp.contribution_auto_task_counts(NULL);

  SELECT COUNT(*) INTO v_manual FROM policy_jp.contribution_tasks WHERE status = 'open';
  v_by_type := v_by_type || jsonb_build_object('manual_open', v_manual);

  INSERT INTO policy_jp.pipeline_snapshots (
    tasks_open, tasks_by_type, pending, applied, disputed, rejected,
    votes_total, voters, policies, politicians
  )
  SELECT
    v_auto + v_manual,
    v_by_type,
    (SELECT COUNT(*) FROM policy_jp.contributions WHERE status = 'pending'),
    (SELECT COUNT(*) FROM policy_jp.contributions WHERE status = 'applied'),
    (SELECT COUNT(*) FROM policy_jp.contributions WHERE status = 'disputed'),
    (SELECT COUNT(*) FROM policy_jp.contributions WHERE status = 'rejected'),
    (SELECT COUNT(*) FROM policy_jp.contribution_votes),
    (SELECT COUNT(DISTINCT agent_name) FROM policy_jp.contribution_votes),
    (SELECT COUNT(*) FROM policy_jp.policies WHERE review_status = 'published'),
    (SELECT COUNT(*) FROM policy_jp.politicians WHERE review_status = 'published')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- 非複本：公開讀快照（日本站自己的）。正見把 pipeline_snapshots 開成 Public read 表；日本站不對 anon 開表，所以由這支函式代讀。
--   * 只回主控台用到的五個欄位（taken_at、tasks_by_type、pending、applied、votes_total），都是計數或各類缺口件數
--   * 下界不早於 90 天前（公開 RPC 的成本上限，同模型統計）；p_since 空白＝近 31 天
--   * 最多 1000 筆（同 PostgREST 的上限）：取「最近的」1000 筆再由舊到新排，視窗再長也不會砍掉最新的
CREATE OR REPLACE FUNCTION policy_jp.pipeline_snapshots_since(p_since TIMESTAMPTZ)
RETURNS TABLE (taken_at TIMESTAMPTZ, tasks_by_type JSONB, pending INTEGER, applied INTEGER, votes_total INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  SELECT s.taken_at, s.tasks_by_type, s.pending, s.applied, s.votes_total
    FROM (
      SELECT x.taken_at, x.tasks_by_type, x.pending, x.applied, x.votes_total
        FROM policy_jp.pipeline_snapshots x
       WHERE x.taken_at >= GREATEST(COALESCE(p_since, now() - INTERVAL '31 days'), now() - INTERVAL '90 days')
       ORDER BY x.taken_at DESC
       LIMIT 1000
    ) s
   ORDER BY s.taken_at
$$;

-- ------------------------------------------------------------
-- 排程：每小時採樣一次（正見是 pipeline-snapshot-hourly）。pg_cron 不在的環境（本機、測試）略過，不讓 migration 失敗
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('policy-jp-pipeline-snapshot-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'policy-jp-pipeline-snapshot-hourly')$q$;
    EXECUTE $q$SELECT cron.schedule('policy-jp-pipeline-snapshot-hourly', '0 * * * *', 'SELECT policy_jp.pipeline_take_snapshot();')$q$;
  END IF;
END
$$;

-- 先寫一筆，主控台的圖表不要一開始是空的（正見也是這樣）
SELECT policy_jp.pipeline_take_snapshot();

-- ------------------------------------------------------------
-- 說明
-- ------------------------------------------------------------
COMMENT ON FUNCTION policy_jp.contribution_leaderboard(INTEGER) IS
  '貢獻榜（日本站，正見的複本）：分數 = 提交 + 上線 + 驗證票，同分先看上線再看提交，取前 30；excluded_agents 的代號不上榜。p_days NULL＝總榜。只回代號顯示名與計數，anon 可呼叫';
COMMENT ON FUNCTION policy_jp.contribution_leaderboard(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '貢獻榜區間版（日本站，正見的複本）：[p_since, p_until) 內的提交＋上線＋驗證票；NULL＝該端不設界。兩個參數都必填（沒有預設值）。anon 可呼叫';
COMMENT ON FUNCTION policy_jp.contribution_feed_summary() IS
  '貢獻統計（日本站，正見的複本）：總數、各狀態、近 7 日、貢獻者數、貢獻榜三個時間窗。只回計數與代號顯示名，anon 可呼叫（主控台直接呼叫這支 RPC，不經 Edge Function）';
COMMENT ON FUNCTION policy_jp.contribution_activity(INTEGER) IS
  '提交與驗證（日本站，正見的複本）：最近 p_hours 小時，48 小時內按小時、以上按天（台北時間）。anon 可呼叫';
COMMENT ON FUNCTION policy_jp.model_contribution_stats(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '各模型交件結果（日本站，正見的複本，區間版）：[p_since, p_until)，下界不早於 90 天前。不含 IP 與代號，raw_tools 是代理自填的 agent_tool 原字串。anon 可呼叫';
COMMENT ON FUNCTION policy_jp.model_vote_stats(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '各模型投票（日本站，正見的複本，區間版）：[p_since, p_until)，下界不早於 90 天前，只算目標貢獻已有結果的票。不含 IP 與代號。anon 可呼叫';
COMMENT ON FUNCTION policy_jp.model_display_name(TEXT) IS
  '代理自填的 agent_tool →「系列＋版本」顯示名稱（正見的複本；規則與 _shared/model-name.ts 一致）。只給 service_role 與統計函式內部用';
COMMENT ON FUNCTION policy_jp.contribution_auto_task_counts(TEXT) IS '各類自動缺口的數量（正見的複本）；pipeline_take_snapshot 用。只給 service_role';
COMMENT ON FUNCTION policy_jp.pipeline_take_snapshot() IS '寫入一筆管線快照（日本站）；由 pg_cron 每小時呼叫一次。只給 service_role';
COMMENT ON FUNCTION policy_jp.pipeline_snapshots_since(TIMESTAMPTZ) IS
  '管線快照的公開讀取（日本站自己的，非複本）：p_since 之後的快照由舊到新，最多 1000 筆，下界不早於 90 天前。只回五個計數欄位。anon 可呼叫';

-- ------------------------------------------------------------
-- 權限：統計函式給 anon／authenticated，其餘只給 service_role；一律先收回 PUBLIC
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION
  policy_jp.model_display_name(TEXT),
  policy_jp.contribution_leaderboard(INTEGER),
  policy_jp.contribution_leaderboard(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.contribution_feed_summary(),
  policy_jp.contribution_activity(INTEGER),
  policy_jp.model_contribution_stats(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.model_vote_stats(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.contribution_auto_task_counts(TEXT),
  policy_jp.pipeline_take_snapshot(),
  policy_jp.pipeline_snapshots_since(TIMESTAMPTZ)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  policy_jp.model_display_name(TEXT),
  policy_jp.contribution_leaderboard(INTEGER),
  policy_jp.contribution_leaderboard(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.contribution_feed_summary(),
  policy_jp.contribution_activity(INTEGER),
  policy_jp.model_contribution_stats(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.model_vote_stats(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.contribution_auto_task_counts(TEXT),
  policy_jp.pipeline_take_snapshot(),
  policy_jp.pipeline_snapshots_since(TIMESTAMPTZ)
TO service_role;
GRANT EXECUTE ON FUNCTION
  policy_jp.contribution_leaderboard(INTEGER),
  policy_jp.contribution_leaderboard(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.contribution_feed_summary(),
  policy_jp.contribution_activity(INTEGER),
  policy_jp.model_contribution_stats(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.model_vote_stats(TIMESTAMPTZ, TIMESTAMPTZ),
  policy_jp.pipeline_snapshots_since(TIMESTAMPTZ)
TO anon, authenticated;

-- ------------------------------------------------------------
-- 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  -- 新表開 RLS、anon／authenticated／PUBLIC 沒有任何權限（連 SELECT 都不行：anon 不開任何表）
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'policy_jp' AND c.relname IN ('excluded_agents', 'pipeline_snapshots') AND NOT c.relrowsecurity;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 公開統計：這些表沒開 RLS：%', bad; END IF;

  SELECT string_agg(DISTINCT g.table_name || ':' || g.grantee || ':' || g.privilege_type, ', ') INTO bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'policy_jp' AND g.grantee IN ('anon', 'authenticated', 'PUBLIC')
     AND g.table_name IN ('excluded_agents', 'pipeline_snapshots');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 公開統計：anon／authenticated 不該有任何表權限：%', bad; END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'policy_jp' AND tablename IN ('excluded_agents', 'pipeline_snapshots')) THEN
    RAISE EXCEPTION 'policy_jp 公開統計：內部表不該有 policy（不開 Public read）';
  END IF;

  -- 函式：anon／authenticated 只准有 tables migration 的兩支加這支的 7 支統計函式
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'policy_jp'
     AND p.proname NOT IN ('lg_code_valid', 'election_level', 'contribution_leaderboard', 'contribution_feed_summary', 'contribution_activity',
                           'model_contribution_stats', 'model_vote_stats', 'pipeline_snapshots_since')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 公開統計：anon／authenticated 不該能執行這些函式：%', bad; END IF;

  -- 對 anon 開的統計函式一律 SECURITY DEFINER 且釘死 search_path（否則 anon 讀不到表，或被搜尋路徑注入）
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'policy_jp'
     AND p.proname IN ('contribution_leaderboard', 'contribution_feed_summary', 'contribution_activity', 'model_contribution_stats', 'model_vote_stats', 'pipeline_snapshots_since')
     AND NOT (p.prosecdef AND p.proconfig @> ARRAY['search_path=policy_jp, pg_temp']);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 公開統計：這些函式不是 SECURITY DEFINER＋釘 search_path：%', bad; END IF;

  -- 這支的函式本體沒有任何一個提到 public.（獨立於正見）
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'policy_jp' AND p.prosrc ~ 'public\.'
     AND p.proname IN ('model_display_name', 'contribution_leaderboard', 'contribution_feed_summary', 'contribution_activity', 'model_contribution_stats',
                       'model_vote_stats', 'contribution_auto_task_counts', 'pipeline_take_snapshot', 'pipeline_snapshots_since');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp 公開統計：函式本體提到 public.：%', bad; END IF;
END
$$;

NOTIFY pgrst, 'reload schema';

