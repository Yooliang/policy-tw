-- 日本站「選舉鏈」第 1 步：鏈的骨架＋兩支全國掃描臂改成只做「開著的選舉」
-- ============================================================
--
-- 計畫：policy-jp docs/PLAN-election-chain.md（#57／#58／#59）第 5 節第 1 步。主線條件（P-小正見，policy-jp #57 留言）：
--   a. activity_rules 只多 after_step 一欄（參數放既有的 params）；「前一步完成」的判斷集中在視圖
--      election_chain_progress(election_id, lg_code, step, done, done_at)，總表在 seed 時算一次（MATERIALIZED），
--      在列層放行；開著的列 opened_by 記 chain_gate（做法同正見的 traffic_gate）。不讓每支臂各自去查前一步。
--   b. 每一步都有逃生門：「前一步完成，或已到後備里程碑」。後備里程碑寫在規則的 params.chain_fallback = {"kind": 里程碑, "offset": 天數}。
--   c. 已經開過的不收回：前一步之後又變回未完成（例：查無的冷卻到期），開過的任務（gap_events 有 opened／reopened）照開。
--   d. gate 寫成通用的：總表那一段（>>> 選舉鏈 … <<< 選舉鏈）不提日本的型別或時區；站別專用的只有
--      「列屬於哪個範圍」（activity_chain_scope）、步驟清單（election_chain_steps）與視圖本身。
--      正見之後加同一段的空轉版（另一個 PR，由主線審；正見不設 after_step 就什麼都不擋），兩邊總表的那一段逐字相同。
--
-- 這支做的事：
-- 1. activity_rules.after_step（NULL＝不在鏈上）；值要在 election_chain_steps() 裡、params.chain_fallback 的形狀，都用 CHECK 擋。
-- 2. 視圖 chain_open_elections（開著的選舉）：已上線（published）的地方選舉，加上「已通過驗證、只在等團體落庫」的選舉交件——
--    不加會死結：選舉要等團體進來才能落庫（外鍵，#503 c），團體的任務又要等選舉上線才開。
--    投票日後 chain_close_after_days 天關閉（頭 election_discovery 規則的 params，90 天）。國政選舉沒有團體，不在這裡。
-- 3. 視圖 election_chain_progress：開著的選舉×它的團體×步驟，一列一個 done。步驟（election_chain_steps()）：
--      discovery         頭：選舉已發現（開著的選舉一律 done）
--      local_government  團體和它所屬的都道府県都在 local_governments（或那一件回報查無、還在冷卻中）
--      regional_stats    團體的統計齊了（判準跟臂同一支函式 chain_regional_stats_missing；或回報查無、還在冷卻中；行政区不收統計＝done）
--      region            第 1 步「地區資料」完成＝local_government 而且 regional_stats；第 2 步（參選人）之後的規則掛在這裡
--    「查無並在冷卻中」＝task_checks 有 outcome=not_found、還在 task_check_cooldown_days() 內（計畫第 2 節「前一步完成」的定義）。
-- 4. 總表（20261009210100 的版本＋「選舉鏈」一段，其餘一字不改；守門做替換比對）：開這一組的規則有 after_step 時，列要過 gate：
--      done（視圖說前一步完成）→ fallback（後備里程碑到了）→ sticky（這個任務開過）；都不是＝擋下（旗標 gap.arms_all 開著時留下、opened_by 是 NULL）。
--    過了的列 opened_by.chain_gate = {after_step, via}。
-- 5. 兩支臂改成鏈上的一步（task_id 不變：auto:local_government_missing:<團體碼>、auto:regional_stats_missing:<團體碼>；輸出欄位照正見的臂）：
--      local_government_missing：開著的選舉的團體與所屬都道府県，不在 local_governments 的。名稱讀總務省團體碼表（lg_code_registry，只拿來寫說明）。
--      regional_stats_missing：開著的選舉的團體，統計不齊的。團體還沒進 local_governments 的也算得出來，由 gate 決定什麼時候開。
--      target 多 election_id、election_type、chain_lg_code（這一列屬於哪一場選舉的哪個團體）、chain_step；
--      同一個團體碼在好幾場開著的選舉裡時，掛在投票日最早的那一場。都道府県先，再依投票日。
-- 6. 規則：
--      local_government_missing  after_step=discovery（鏈的起點，沒有後備里程碑：開著的選舉 discovery 一律 done）
--      regional_stats_missing    after_step=local_government、後備＝投票日前 45 天。第 1 步裡的先後：統計的外鍵指向團體，
--                                團體沒進來時交了也只能等（apply_waiting），所以團體進來才開；團體卡住時投票日前 45 天照開（交件等外鍵，團體一進來就落）。
--      election_discovery        params 加 chain_close_after_days（90）。
--      regional_stats_missing 的 min_year：人口・面積・高齢化率 2020 → 2025（令和7年国勢調査 2026-09-29 已公表）。交 2025 年的值才對得上
--        機器核對（20261009250200）；日本站沒有其他代理投票，交 2020 年的會一直停在 pending。歳出照舊 2023。
--    常駐的全國掃描不做了（計畫第 1 節）：沒有開著的選舉，這兩支臂一列都不出。
--
-- 不做的（之後的步驟）：第 2 步以後的臂、往回補／往後接（lookback_years、deep_levels）、新聞線（#59：排在骨架之後）。
-- 已知的限制：
--   * 已上線的選舉，團體一定已經在 local_governments（外鍵），所以第 1 步裡「統計等團體」實際只對「在等團體的選舉」起作用；
--     那種選舉還沒有 elections 列、也就沒有投票日里程碑，後備（投票日前 45 天）對它不會到。也就是說第 1 步的後備在現況下不會觸發，
--     留著是因為主線條件「每一步都有逃生門」（自我檢查擋沒有後備的規則），第 2 步以後的後備才會真的用到。
--   * sticky 看的是 task_id 有沒有開過（gap_events）。第 1 步的 task_id 是一個團體一個（不分選舉），所以同一個團體以前開過，之後的選舉也不再擋。

-- ------------------------------------------------------------
-- 1. 步驟清單、after_step 欄位與形狀
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.election_chain_steps() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY['discovery', 'local_government', 'regional_stats', 'region']::TEXT[]
$$;
COMMENT ON FUNCTION policy_jp.election_chain_steps IS '選舉鏈的步驟（election_chain_progress.step 的值）；activity_rules.after_step 只能是這裡的值。加步驟＝改這裡＋視圖多一段';

ALTER TABLE policy_jp.activity_rules ADD COLUMN IF NOT EXISTS after_step TEXT;
COMMENT ON COLUMN policy_jp.activity_rules.after_step IS
  '選舉鏈：這條規則開的列，要等 election_chain_progress 的這一步 done（同一場選舉、同一個範圍）才開；或 params.chain_fallback 的後備里程碑到了；或這個任務開過。NULL＝不在鏈上（照舊只看窗口）';

ALTER TABLE policy_jp.activity_rules DROP CONSTRAINT IF EXISTS activity_rules_chain_shape;
ALTER TABLE policy_jp.activity_rules ADD CONSTRAINT activity_rules_chain_shape CHECK (
  (after_step IS NULL OR (priority IS NULL AND after_step = ANY (policy_jp.election_chain_steps())))
  -- COALESCE(…, false)：缺 kind 或缺 offset 時條件算出 NULL，CHECK 會把 NULL 當通過——那樣逃生門寫錯了也收得進來、而且永遠不會到
  AND (NOT (params ? 'chain_fallback') OR COALESCE(
    after_step IS NOT NULL
    AND jsonb_typeof(params->'chain_fallback') = 'object'
    AND (params->'chain_fallback'->>'kind') IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                                                 'bulletin_published', 'polling', 'result_announced', 'certified')
    AND jsonb_typeof(params->'chain_fallback'->'offset') = 'number'
    AND (params->'chain_fallback'->>'offset') ~ '^-?[0-9]+$', false))
);

-- ------------------------------------------------------------
-- 2. 小工具
-- ------------------------------------------------------------
-- 交件 payload 裡的日期（文字）→ DATE；格式不對、不是真的有這一天＝NULL（視圖不能因為一筆壞資料整支丟例外）
CREATE OR REPLACE FUNCTION policy_jp.date_or_null(p_text TEXT) RETURNS DATE
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF p_text IS NULL OR p_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
  RETURN p_text::DATE;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- 派工列屬於鏈上的哪個範圍（日本＝團體碼）：臂在 target 寫 chain_lg_code；沒寫就用 lg_code
CREATE OR REPLACE FUNCTION policy_jp.activity_chain_scope(p_target JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT COALESCE(NULLIF(p_target->>'chain_lg_code', ''), NULLIF(p_target->>'lg_code', ''))
$$;
COMMENT ON FUNCTION policy_jp.activity_chain_scope IS '選舉鏈：派工列的範圍鍵（election_chain_progress.lg_code 對的那個值）。總表的 gate 只透過它取，站別的鍵名不寫進總表';

-- 逃生門：前一步沒完成時，後備里程碑到了（fallback）或這個任務開過（sticky）就照開；都不是回 NULL
CREATE OR REPLACE FUNCTION policy_jp.activity_chain_escape(
  p_fallback JSONB, p_election_id TEXT, p_election_type TEXT, p_task_id TEXT, p_today DATE DEFAULT policy_jp.activity_today()
) RETURNS TEXT
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN jsonb_typeof(p_fallback) = 'object' AND EXISTS (
                  SELECT 1 FROM policy_jp.election_milestones_all m
                   WHERE m.election_id = p_election_id AND m.kind = p_fallback->>'kind'
                     AND (m.election_type IS NULL OR m.election_type IS NOT DISTINCT FROM p_election_type)
                     AND m.on_date + (p_fallback->>'offset')::INTEGER <= p_today)
             THEN 'fallback'
           WHEN EXISTS (SELECT 1 FROM policy_jp.gap_events e WHERE e.task_id = p_task_id AND e.event IN ('opened', 'reopened'))
             THEN 'sticky'
         END
$$;
COMMENT ON FUNCTION policy_jp.activity_chain_escape IS
  '選舉鏈的逃生門：params.chain_fallback 的里程碑（kind＋offset 天）到了＝fallback；這個任務以前開過（gap_events）＝sticky（已開的不收回）；都不是＝NULL（擋下）';

-- 統計缺哪幾項（臂與進度視圖共用同一個判準）：規則 regional_stats_missing 的 min_year／exclude_kinds；齊了或不收統計的種類＝NULL
CREATE OR REPLACE FUNCTION policy_jp.chain_regional_stats_missing(p_lg_code TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT r.params->'min_year' AS min_year, COALESCE(r.params->'exclude_kinds', '[]'::JSONB) AS exclude_kinds
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'regional_stats_missing' AND r.enabled
     ORDER BY r.id LIMIT 1
  ),
  k AS (
    SELECT COALESCE((SELECT g.kind FROM policy_jp.local_governments g WHERE g.lg_code = p_lg_code),
                    (SELECT x.kind FROM policy_jp.lg_code_registry x WHERE x.lg_code = p_lg_code)) AS kind
  )
  SELECT jsonb_agg(jsonb_build_object('stat_key', w.stat_key, 'min_year', w.min_year::INTEGER, 'unit', policy_jp.regional_stat_unit(w.stat_key)) ORDER BY w.stat_key)
    FROM p CROSS JOIN k CROSS JOIN LATERAL jsonb_each_text(p.min_year) AS w(stat_key, min_year)
   WHERE NOT (p.exclude_kinds ? COALESCE(k.kind, ''))
     AND NOT EXISTS (SELECT 1 FROM policy_jp.regional_stats s
                      WHERE s.lg_code = p_lg_code AND s.stat_key = w.stat_key AND s.year >= w.min_year::INTEGER AND s.review_status = 'published')
$$;
COMMENT ON FUNCTION policy_jp.chain_regional_stats_missing IS
  '團體缺的統計（[{stat_key, min_year, unit}]）；齊了、規則停用、種類在 exclude_kinds（行政区）＝NULL。regional_stats_missing 臂與 election_chain_progress 共用';

-- ------------------------------------------------------------
-- 3. 開著的選舉
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW policy_jp.chain_open_elections WITH (security_invoker = true) AS
  WITH p AS (
    -- 鏈開多久：頭（election_discovery）規則的 params。不看 enabled：停掉「發現新選舉」不該讓已經開著的鏈跟著消失
    SELECT (r.params->>'chain_close_after_days')::INTEGER AS close_after
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'election_discovery' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  waiting AS (
    -- 已通過驗證、只在等團體落庫的選舉交件（apply_blocker 是 local_government_missing:…）；id 跟 apply_election 算的一樣
    SELECT DISTINCT ON (k.election_id) k.*
      FROM (SELECT (c.payload->>'election_date') || '_' || (c.payload->>'election_type') || '_' || (c.payload->>'lg_code') AS election_id,
                   c.payload->>'lg_code' AS lg_code, c.payload->>'election_type' AS election_type,
                   policy_jp.date_or_null(c.payload->>'election_date') AS election_date, policy_jp.date_or_null(c.payload->>'notice_date') AS notice_date,
                   COALESCE(c.verified_at, c.created_at) AS since
              FROM policy_jp.contributions c
             WHERE c.contribution_type = 'election' AND c.status = 'verified'
               AND policy_jp.apply_blocker(c.contribution_type, c.payload) LIKE 'local_government_missing:%') k
     WHERE k.election_date IS NOT NULL
       AND policy_jp.election_level(k.election_type) IN ('regional', 'local')
       AND NOT EXISTS (SELECT 1 FROM policy_jp.elections e WHERE e.id = k.election_id)
     ORDER BY k.election_id, k.since
  )
  SELECT x.election_id, x.lg_code, x.election_type, x.election_date, x.notice_date, x.basis, x.since
    FROM (SELECT e.id AS election_id, e.lg_code, e.election_type, e.election_date, e.notice_date, 'published'::TEXT AS basis, e.created_at AS since
            FROM policy_jp.elections e
           WHERE e.review_status = 'published' AND e.lg_code IS NOT NULL
          UNION ALL
          SELECT w.election_id, w.lg_code, w.election_type, w.election_date, w.notice_date, 'verified_waiting'::TEXT, w.since
            FROM waiting w) x
    CROSS JOIN p
   WHERE x.election_date + p.close_after >= policy_jp.activity_today();
COMMENT ON VIEW policy_jp.chain_open_elections IS
  '選舉鏈「開著的選舉」：已上線的地方選舉＋已通過驗證、只在等團體落庫的選舉交件（basis＝verified_waiting），投票日後 chain_close_after_days 天內。service_role 用';

-- ------------------------------------------------------------
-- 4. 鏈的進度：開著的選舉×團體×步驟
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW policy_jp.election_chain_progress WITH (security_invoker = true) AS
  WITH oe AS (SELECT o.election_id, o.lg_code, o.since FROM policy_jp.chain_open_elections o),
  lg AS (
    -- 團體與所屬都道府県（都道府県的選舉兩個碼相同）：每個碼都在 local_governments，或那一件回報查無、還在冷卻中
    SELECT o.election_id, o.lg_code,
           bool_and(g.lg_code IS NOT NULL OR ck.checked_at IS NOT NULL) AS done,
           max(COALESCE(g.created_at, ck.checked_at)) AS last_at
      FROM oe o
      CROSS JOIN LATERAL (VALUES (policy_jp.lg_pref_code(o.lg_code)), (o.lg_code)) AS c(code)
      LEFT JOIN policy_jp.local_governments g ON g.lg_code = c.code
      LEFT JOIN LATERAL (
        SELECT max(tc.checked_at) AS checked_at FROM policy_jp.task_checks tc
         WHERE tc.task_id = 'auto:local_government_missing:' || c.code AND tc.outcome = 'not_found'
           AND tc.checked_at > now() - (policy_jp.task_check_cooldown_days() || ' days')::INTERVAL
      ) ck ON true
     GROUP BY o.election_id, o.lg_code
  ),
  st AS (
    -- 統計齊了（或不收統計的種類），或那一件回報查無、還在冷卻中
    SELECT o.election_id, o.lg_code,
           (policy_jp.chain_regional_stats_missing(o.lg_code) IS NULL OR ck.checked_at IS NOT NULL) AS done,
           GREATEST((SELECT max(s.created_at) FROM policy_jp.regional_stats s WHERE s.lg_code = o.lg_code AND s.review_status = 'published'), ck.checked_at, o.since) AS last_at
      FROM oe o
      LEFT JOIN LATERAL (
        SELECT max(tc.checked_at) AS checked_at FROM policy_jp.task_checks tc
         WHERE tc.task_id = 'auto:regional_stats_missing:' || o.lg_code AND tc.outcome = 'not_found'
           AND tc.checked_at > now() - (policy_jp.task_check_cooldown_days() || ' days')::INTERVAL
      ) ck ON true
  )
  SELECT o.election_id, o.lg_code, 'discovery'::TEXT AS step, true AS done, o.since AS done_at FROM oe o
  UNION ALL
  SELECT l.election_id, l.lg_code, 'local_government'::TEXT, l.done, CASE WHEN l.done THEN l.last_at END FROM lg l
  UNION ALL
  SELECT s.election_id, s.lg_code, 'regional_stats'::TEXT, s.done, CASE WHEN s.done THEN s.last_at END FROM st s
  UNION ALL
  SELECT l.election_id, l.lg_code, 'region'::TEXT, l.done AND s.done, CASE WHEN l.done AND s.done THEN GREATEST(l.last_at, s.last_at) END
    FROM lg l JOIN st s ON s.election_id = l.election_id AND s.lg_code = l.lg_code;
COMMENT ON VIEW policy_jp.election_chain_progress IS
  '選舉鏈的進度：開著的選舉×團體×步驟（election_chain_steps()）一列，done＝這一步的缺口都補上了，或回報查無、還在冷卻中。總表的 chain_gate 讀它（seed 時算一次）。service_role 用';

-- ------------------------------------------------------------
-- 5. 臂：local_government_missing（鏈的第 1 步：開著的選舉的團體）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_local_government_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'local_government_missing' AND r.enabled
     ORDER BY r.id LIMIT 1
  ),
  -- 開著的選舉的團體與所屬的都道府県；同一個碼在好幾場選舉裡時，掛在投票日最早的那一場
  codes AS (
    SELECT DISTINCT ON (c.code) c.code, o.election_id, o.election_type, o.election_date, o.lg_code AS chain_lg_code
      FROM policy_jp.chain_open_elections o
      CROSS JOIN LATERAL (VALUES (policy_jp.lg_pref_code(o.lg_code)), (o.lg_code)) AS c(code)
     ORDER BY c.code, o.election_date, o.election_id
  ),
  gaps AS (
    SELECT c.*, (substr(c.code, 3, 3) = '000') AS is_prefecture,
           COALESCE(x.name, '（名称未確認）') AS lg_name,
           COALESCE(xp.name, (SELECT g.name FROM policy_jp.local_governments g WHERE g.lg_code = policy_jp.lg_pref_code(c.code)), '（都道府県名未確認）') AS pref_name
      FROM codes c
      CROSS JOIN p
      LEFT JOIN policy_jp.lg_code_registry x ON x.lg_code = c.code
      LEFT JOIN policy_jp.lg_code_registry xp ON xp.lg_code = policy_jp.lg_pref_code(c.code)
     WHERE p.cap IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = c.code)
       AND NOT policy_jp.task_unavailable('auto:local_government_missing:' || c.code)
     ORDER BY (substr(c.code, 3, 3) = '000') DESC, c.election_date, c.code
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:local_government_missing:' || g.code, 'local_government_missing',
         jsonb_build_object('lg_code', g.code, 'pref_name', g.pref_name, 'lg_name', g.lg_name, 'pref_code', policy_jp.lg_pref_code(g.code),
                            'is_prefecture', g.is_prefecture, 'election_id', g.election_id, 'election_type', g.election_type,
                            'election_date', g.election_date, 'chain_lg_code', g.chain_lg_code, 'chain_step', 'local_government'),
         g.lg_name || '（団体コード ' || g.code || '、' || g.pref_name || '）が地方公共団体の一覧（local_governments）にまだありません。'
           || g.election_date || ' 投票の選挙（' || g.election_id || '）の準備として、まず団体の基本情報が必要です。'
           || '総務省「全国地方公共団体コード」（https://www.soumu.go.jp/denshijiti/code.html）で団体コード・名称・読みを確かめ、contribution_type=local_government で回報してください。'
           || 'payload は lg_code・kind・pref_code・name・kana（読みは「ひらがな」に直す）。source_urls には総務省の団体コード表（またはその団体の公式サイト）を入れてください。'
           || '総務省のコード表と一致すれば、交件と同時に機械照合で確定します。'
           || CASE WHEN g.is_prefecture
                   THEN 'これは都道府県です：kind=prefecture、pref_code は lg_code と同じ値にします。'
                   ELSE 'kind は 政令指定都市＝designated_city、中核市＝core_city、その他の市＝city、東京23区＝special_ward、町＝town、村＝village から選びます'
                        || '（政令指定都市・中核市かどうかは総務省の指定都市・中核市の一覧で確かめる）。pref_code は ' || policy_jp.lg_pref_code(g.code) || '（所属の都道府県）です。'
              END
           || 'コード表で確かめられない場合は contribution_type=no_change、outcome=not_found、checked_urls に見たページを入れて回報してください。',
         ARRAY['総務省 全国地方公共団体コード', g.lg_name || ' 公式サイト', '総務省 指定都市・中核市の一覧']::TEXT[], 1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_local_government_missing IS
  '選挙鎖の第 1 歩：開いている選挙（chain_open_elections）の団体と所属の都道府県で、local_governments にないもの → local_government_missing 任務。都道府県を先、次に投票日順。params.cap は可派（task_unavailable でない）の前 N 件。名称は lg_code_registry（説明文だけに使う）';

-- ------------------------------------------------------------
-- 6. 臂：regional_stats_missing（鏈的第 1 步：開著的選舉的團體的統計）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_regional_stats_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'regional_stats_missing' AND r.enabled
     ORDER BY r.id LIMIT 1
  ),
  -- 開著的選舉的團體；同一個團體有好幾場時，掛在投票日最早的那一場
  els AS (
    SELECT DISTINCT ON (o.lg_code) o.lg_code, o.election_id, o.election_type, o.election_date
      FROM policy_jp.chain_open_elections o
     ORDER BY o.lg_code, o.election_date, o.election_id
  ),
  cand AS (
    SELECT e.*, COALESCE(g.name, x.name, '（名称未確認）') AS name, COALESCE(g.kind, x.kind) AS kind,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), x.pref_name, '（都道府県名未確認）') AS pref_name,
           policy_jp.chain_regional_stats_missing(e.lg_code) AS missing
      FROM els e
      CROSS JOIN p
      LEFT JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
      LEFT JOIN policy_jp.lg_code_registry x ON x.lg_code = e.lg_code
     WHERE p.cap IS NOT NULL
  ),
  gaps AS (
    SELECT c.* FROM cand c
     WHERE c.missing IS NOT NULL
       AND NOT policy_jp.task_unavailable('auto:regional_stats_missing:' || c.lg_code)
     ORDER BY COALESCE(c.kind = 'prefecture', false) DESC, c.election_date, c.lg_code
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:regional_stats_missing:' || g.lg_code, 'regional_stats_missing',
         jsonb_build_object('lg_code', g.lg_code, 'lg_name', g.name, 'pref_name', g.pref_name, 'kind', g.kind, 'missing', g.missing,
                            'election_id', g.election_id, 'election_type', g.election_type, 'election_date', g.election_date,
                            'chain_lg_code', g.lg_code, 'chain_step', 'regional_stats'),
         g.name || '（団体コード ' || g.lg_code || '）の統計値が足りません：'
           || (SELECT string_agg(policy_jp.regional_stat_label(m->>'stat_key') || '＝' || (m->>'min_year') || ' 年以降の最新値（stat_key=' || (m->>'stat_key') || '、unit=' || (m->>'unit') || '）', '、' ORDER BY m->>'stat_key')
                 FROM jsonb_array_elements(g.missing) m)
           || '。' || g.election_date || ' 投票の選挙（' || g.election_id || '）の地域データです。'
           || 'e-Stat「統計でみる市区町村のすがた」や総務省の市町村決算カード・国勢調査などの公的統計で確かめ、値 1 つにつき 1 件、contribution_type=regional_stat で回報してください。'
           || 'payload は lg_code・stat_key・year（西暦。歳出は会計年度の開始年）・value（数値）・unit（上の unit のとおり）・as_of（基準日 YYYY-MM-DD、任意）。'
           || 'source_urls には統計の公表元（e-Stat・総務省・その団体の公式統計ページ）を入れてください。'
           || '人口・面積・高齢化率は、令和7年国勢調査（e-Stat「都道府県・市区町村別の主な結果」、year=2025、as_of=2025-10-01）の値と一致すれば、交件と同時に機械照合で確定します。'
           || '公表されていない・確かめられない場合は contribution_type=no_change、outcome=not_found、checked_urls に見たページを入れて回報してください。',
         ARRAY['e-Stat 令和7年国勢調査 都道府県・市区町村別の主な結果', 'e-Stat 統計でみる市区町村のすがた', '総務省 市町村決算カード', g.name || ' 公式サイトの統計ページ']::TEXT[], 2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_regional_stats_missing IS
  '選挙鎖の第 1 歩：開いている選挙の団体で、統計（chain_regional_stats_missing）が足りないもの → regional_stats_missing 任務（1 団体 1 件）。団体が local_governments にまだなくても出す（開くかどうかは総表の chain_gate：after_step=local_government、後備は投票日前 45 日）。cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 7. 總表：20261009210100 的版本＋「選舉鏈」一段（>>> 選舉鏈 … <<< 選舉鏈，其餘一字不改；守門做替換比對）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH tagged AS (
  SELECT 'manual_visitor' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'election_discovery' AS arm, t.* FROM policy_jp.contribution_auto_tasks_election_discovery() t
  UNION ALL SELECT 'local_government_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_local_government_missing() t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_regional_stats_missing() t
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       keyed AS (
  SELECT g.*, policy_jp.election_id_or_null(g.target->>'election_id') AS eid, NULLIF(g.target->>'election_type', '') AS etype FROM tagged g
       ),
       -- >>> 選舉鏈：規則有 after_step 的列，要這一步在 election_chain_progress 是 done 才開；視圖在這裡只算一次，只取規則用得到的步驟
       chain AS MATERIALIZED (
  SELECT p.election_id, p.lg_code, p.step FROM policy_jp.election_chain_progress p
   WHERE p.done AND p.step IN (SELECT r.after_step FROM policy_jp.activity_rules r WHERE r.enabled AND r.after_step IS NOT NULL)
       ),
       -- <<< 選舉鏈
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until,
         (SELECT r.after_step FROM policy_jp.activity_rules r WHERE r.id = o.rule_id) AS after_step,  -- 選舉鏈：開這一組的規則掛在哪一步之後（NULL＝不在鏈上；覆寫開的也是 NULL）
         (SELECT r.params->'chain_fallback' FROM policy_jp.activity_rules r WHERE r.id = o.rule_id) AS chain_fallback  -- 選舉鏈：後備里程碑
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE policy_jp.activity_require_rule(x.arm) OFFSET 0) k
    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們
      SELECT * FROM policy_jp.activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o ON true
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         CASE WHEN w.via IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until,
           'chain_gate', CASE WHEN o.after_step IS NOT NULL THEN jsonb_build_object('after_step', o.after_step, 'via', w.via) END)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, '') = COALESCE(g.eid, '') AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
    -- >>> 選舉鏈：窗口有開（o.source）之後，規則有 after_step 的列要過 gate：前一步 done → 後備里程碑到了（fallback）→ 開過（sticky）；都不是＝擋下（NULL）
    CROSS JOIN LATERAL (SELECT CASE
           WHEN o.source IS NULL THEN NULL
           WHEN o.after_step IS NULL THEN 'none'
           WHEN EXISTS (SELECT 1 FROM chain c WHERE c.election_id = g.eid AND c.lg_code = policy_jp.activity_chain_scope(g.target) AND c.step = o.after_step) THEN 'done'
           ELSE policy_jp.activity_chain_escape(o.chain_fallback, g.eid, g.etype, g.task_id) END AS via) w
    -- <<< 選舉鏈
   WHERE (w.via IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
$$;

-- ------------------------------------------------------------
-- 8. 規則（原地 UPDATE，rule_id 不變；activity_audit 觸發器把修改記進 edit_history）
-- ------------------------------------------------------------
UPDATE policy_jp.activity_rules
   SET params = params || '{"chain_close_after_days":90}'::JSONB,
       note = note || '。選挙鎖：選挙が見つかった（上線した）ら、その団体の鎖が開く。鎖は投票日の 90 日後に閉じる（chain_close_after_days）'
 WHERE activity = 'election_discovery' AND priority IS NULL AND NOT (params ? 'chain_close_after_days');

UPDATE policy_jp.activity_rules
   SET after_step = 'discovery',
       note = '選挙鎖の第 1 歩（地域データ）：開いている選挙の団体と所属の都道府県で local_governments にないものを、総務省の団体コード表で確かめて local_government を回報させる。'
              || '選挙が見つかればすぐ開く（鎖の起点、後備の里程碑なし）。全国の常駐スキャンはしない。同時に開くのは最大 200 件（都道府県が先、次に投票日順）'
 WHERE activity = 'local_government_missing' AND priority IS NULL AND after_step IS NULL;

UPDATE policy_jp.activity_rules
   SET after_step = 'local_government',
       params = params || '{"chain_fallback":{"kind":"polling","offset":-45},"min_year":{"population":2025,"area_km2":2025,"aging_rate":2025,"budget_expenditure":2023}}'::JSONB,
       note = '選挙鎖の第 1 歩（地域データ）：開いている選挙の団体の統計（人口・面積・高齢化率は令和7年国勢調査＝2025 年以降、歳出は 2023 会計年度以降の最新）が足りないものを、e-Stat・総務省で確かめて regional_stat を回報させる。'
              || '団体が local_governments に入ってから開く（統計の外部キーは団体）。団体が止まっていても投票日の 45 日前には開く（後備）。同時に開くのは最大 200 件。行政区は対象外'
 WHERE activity = 'regional_stats_missing' AND priority IS NULL AND after_step IS NULL;

-- ------------------------------------------------------------
-- 9. 權限（新函式預設對 PUBLIC 可執行、視圖預設 service_role 全權；明寫收回）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.election_chain_steps(), policy_jp.date_or_null(TEXT), policy_jp.activity_chain_scope(JSONB),
  policy_jp.activity_chain_escape(JSONB, TEXT, TEXT, TEXT, DATE), policy_jp.chain_regional_stats_missing(TEXT),
  policy_jp.contribution_auto_tasks_local_government_missing(), policy_jp.contribution_auto_tasks_regional_stats_missing(), policy_jp.contribution_auto_tasks_arms()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.election_chain_steps(), policy_jp.date_or_null(TEXT), policy_jp.activity_chain_scope(JSONB),
  policy_jp.activity_chain_escape(JSONB, TEXT, TEXT, TEXT, DATE), policy_jp.chain_regional_stats_missing(TEXT),
  policy_jp.contribution_auto_tasks_local_government_missing(), policy_jp.contribution_auto_tasks_regional_stats_missing(), policy_jp.contribution_auto_tasks_arms()
  TO service_role;
REVOKE ALL ON policy_jp.chain_open_elections, policy_jp.election_chain_progress FROM PUBLIC, anon, authenticated;
GRANT SELECT ON policy_jp.chain_open_elections, policy_jp.election_chain_progress TO service_role;

-- ------------------------------------------------------------
-- 10. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  -- 鏈要有壽命：沒有 chain_close_after_days，開著的選舉是空的＝整條鏈無聲消失
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'election_discovery' AND r.priority IS NULL
                  AND jsonb_typeof(r.params->'chain_close_after_days') = 'number' AND (r.params->>'chain_close_after_days')::NUMERIC > 0) THEN
    RAISE EXCEPTION 'policy_jp：election_discovery 的規則缺 chain_close_after_days（開著的選舉會是空的）';
  END IF;
  -- 第 1 步的兩支臂都在鏈上；鏈的起點（discovery）之後的每一步都要有逃生門（主線條件：前一步卡住時不能無聲停住）
  SELECT string_agg(x.activity, ', ') INTO bad
    FROM (VALUES ('local_government_missing'), ('regional_stats_missing')) AS x(activity)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = x.activity AND r.priority IS NULL AND r.enabled AND r.after_step IS NOT NULL);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些鏈上的臂沒有 after_step：%', bad; END IF;
  SELECT string_agg(r.activity || '（after_step=' || r.after_step || '）', ', ') INTO bad
    FROM policy_jp.activity_rules r
   WHERE r.after_step IS NOT NULL AND r.after_step <> 'discovery' AND NOT (r.params ? 'chain_fallback');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些鏈上的規則沒有後備里程碑（params.chain_fallback）：%', bad; END IF;
  -- min_year 的每個 key 都要是 regional_stats 認得的 stat_key（寫錯字會變成永遠要求一個不存在的統計，鏈的 regional_stats 永遠不 done）
  SELECT string_agg(k.key, ', ') INTO bad
    FROM policy_jp.activity_rules r, jsonb_each_text(r.params->'min_year') AS k(key, value)
   WHERE r.activity = 'regional_stats_missing' AND policy_jp.regional_stat_unit(k.key) IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：regional_stats_missing 的 min_year 有不認得的 stat_key：%', bad; END IF;
  IF has_function_privilege('anon', 'policy_jp.activity_chain_escape(jsonb, text, text, text, date)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.chain_regional_stats_missing(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_arms()', 'EXECUTE')
     OR has_table_privilege('anon', 'policy_jp.election_chain_progress', 'SELECT')
     OR has_table_privilege('anon', 'policy_jp.chain_open_elections', 'SELECT') THEN
    RAISE EXCEPTION 'policy_jp：選舉鏈的函式與視圖不該給 anon';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
