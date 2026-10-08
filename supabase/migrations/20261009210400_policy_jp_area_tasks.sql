-- 日本站「地區任務」（area）：一個団体 × 一個選舉週期 × 一個階段 = 一件任務；這支先做選前（pre）階段
-- ============================================================
--
-- 設計：policy-jp docs/PLAN-area-tasks.md（P-日本 10-09，依維護者方向）。維護者：以選舉為單位推進——遇到一場選舉，
--   就把那個地區的資料一起查齊，不做全國普查；代理進到一個選管／自治體網站就順手把該地區要的東西一次補完。
-- 前提：20261009210100（三支臂、task_unavailable）、20261009210200／210300（自治體的機器核對）。
--
-- 任務：task_id auto:area:<lg_code>:<満了日>:pre，target.offices 列出這件涵蓋的職位（head／assembly），target.items 只列還缺的：
--   ① election：各職位還沒有對應的選舉列（同 election_discovery 的對應條件），也沒有在途的 election 交件
--   ② local_governments：這個團體與所屬都道府県還沒登錄、也沒有在途的 local_government 交件（都道府県先）
--   ③ regional_stats：缺 stat_min_year 以後已上線的統計、也沒有在途的 regional_stat 交件
--   ④ 現任名單與任期（politician_offices）：日本站還沒有收人物／任期的交件型別，這支先不列（之後加型別再補）
--   filed（告示後）、result（投票後）兩個階段之後的 PR 做（要 candidacy、policy 等交件型別）。
-- 併件：同一團體首長與議會的任期満了日相差不到 merge_days（30）天＝同一個投票窗口 → 併成一件（日期取早的）；否則各一件。
-- 「查無」只冷卻那一項（文件第 2 節：日程還沒公布時，這件任務照樣可以先補其他項）：每一項有自己的回報 id
--   <task_id>:election／:local_government／:regional_stats，no_change 的 payload.task_id 填它（target.item_task_ids）。
--   這一項的查無等票中或冷卻中（confirmed／not_found 14 天、unreachable 2 天，同正見）就先不列；別的項目照樣派。
--   不用 task_id 本身回報查無，是因為照抄正見的 refresh_dispatch_blocked 會把整件任務擋住。
--   舊的 election_discovery 任務的查無（auto:election_discovery:<満了日>:<lg>:<kind>）也算（銜接，等票中與冷卻中的不重問）。
-- 完成：items 全空 → 臂不再算出這一件 → seed 收回（gap_events 記 filled）。窗口（満了前 lead_days 天～満了後 60 天）在臂裡判斷，同 election_discovery。
-- 同時開啟上限 params.cap（50），満了日早的先。不用 task_unavailable：每一項各自看在途與冷卻，比整件判斷精確。
-- 舊的三支臂（election_discovery、local_government_missing、regional_stats_missing）停掉：照 activity_health 的慣例，用覆寫 closed 留下理由
--   （規則不動；seed 收回時記 window）。已經交進來的貢獻照常驗證、落庫（交件端還認舊的 task_id）。
-- 新增一支臂的三處：總表加一行 UNION 分支、activity_arm_names() 加名字、activity_rules 種規則——都在這支。

-- ------------------------------------------------------------
-- 1. 一項是否「查無等票中或冷卻中」（item_id＝<task_id>:<項目>）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.area_item_dead_end(p_item_ids TEXT[]) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM policy_jp.contributions c
                  WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified') AND c.payload->>'task_id' = ANY (p_item_ids))
      OR EXISTS (SELECT 1 FROM policy_jp.task_checks tc
                  WHERE tc.task_id = ANY (p_item_ids)
                    AND tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days')::INTERVAL)
$$;
COMMENT ON FUNCTION policy_jp.area_item_dead_end IS '地區任務的某一項：有查無（no_change）等票中或已通過，或 task_checks 冷卻中（confirmed／not_found 14 天、unreachable 2 天）→ 先不列這一項';

-- ------------------------------------------------------------
-- 2. 臂：area（pre 階段）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_area()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'scope_from')::DATE AS scope_from,
           (r.params->>'lead_days')::INTEGER AS lead_days,
           COALESCE((r.params->>'include_uncertain')::BOOLEAN, true) AS include_uncertain,
           (r.params->>'cap')::INTEGER AS cap,
           COALESCE((r.params->>'merge_days')::INTEGER, 30) AS merge_days,
           r.params->'stat_min_year' AS stat_min_year,
           policy_jp.activity_today() AS today
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'area' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  latest AS (
    SELECT DISTINCT ON (t.lg_code, t.office_kind) t.* FROM policy_jp.term_expirations t ORDER BY t.lg_code, t.office_kind, t.as_of DESC
  ),
  -- 在 pre 窗口內的職位（條件同 election_discovery：投票日 ≥ scope_from、満了前 lead_days 天起、満了後 60 天止）
  win AS (
    SELECT t.*, p.scope_from, p.merge_days FROM latest t CROSS JOIN p
     WHERE p.scope_from IS NOT NULL AND p.lead_days IS NOT NULL AND p.cap IS NOT NULL
       AND t.term_end - 1 >= p.scope_from
       AND (p.include_uncertain OR t.term_end - 30 >= p.scope_from)
       AND t.term_end - p.lead_days <= p.today
       AND t.term_end + 60 >= p.today
  ),
  -- 併件：同一團體另一個職位的満了日相差不到 merge_days 天 → 兩個職位用同一個日期（早的那個）
  grouped AS (
    SELECT w.*, LEAST(w.term_end, COALESCE((SELECT min(o.term_end) FROM win o
                                             WHERE o.lg_code = w.lg_code AND o.office_kind <> w.office_kind
                                               AND abs(o.term_end - w.term_end) < w.merge_days), w.term_end)) AS area_end
      FROM win w
  ),
  areas AS (
    SELECT g.lg_code, g.area_end, min(g.pref_name) AS pref_name, min(g.lg_name) AS lg_name, min(g.as_of) AS as_of, min(g.source_id) AS source_id,
           min(g.scope_from) AS scope_from, bool_and(g.term_end - 30 >= g.scope_from) AS certainly_in_scope,
           jsonb_agg(jsonb_build_object('office_kind', g.office_kind, 'election_type', g.election_type, 'term_end', g.term_end,
                                        'vote_window_from', g.term_end - 30, 'vote_window_until', g.term_end - 1)
                     ORDER BY g.office_kind DESC) AS offices,
           'auto:area:' || g.lg_code || ':' || g.area_end || ':pre' AS tid
      FROM grouped g
     GROUP BY g.lg_code, g.area_end
  ),
  needs AS (
    SELECT a.*,
           policy_jp.lg_pref_code(a.lg_code) AS pref_code,
           -- ① 選舉：還沒有選舉列、沒有在途的 election 交件的職位；這一項（或舊 election_discovery 任務）的查無等票中／冷卻中就整項先不列
           CASE WHEN policy_jp.area_item_dead_end(
                       ARRAY[a.tid || ':election']
                       || ARRAY(SELECT 'auto:election_discovery:' || (o->>'term_end') || ':' || a.lg_code || ':' || (o->>'office_kind')
                                  FROM jsonb_array_elements(a.offices) o))
                THEN NULL
                ELSE (SELECT jsonb_agg(o ORDER BY o->>'office_kind' DESC) FROM jsonb_array_elements(a.offices) o
                       WHERE NOT EXISTS (SELECT 1 FROM policy_jp.elections e
                                          WHERE e.lg_code = a.lg_code AND e.election_type = o->>'election_type' AND e.review_status <> 'rejected'
                                            AND e.election_date BETWEEN (o->>'term_end')::DATE - 120 AND (o->>'term_end')::DATE + 60)
                         AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                                          WHERE c.contribution_type = 'election' AND c.status IN ('pending', 'verified', 'disputed')
                                            AND c.payload->>'lg_code' = a.lg_code AND c.payload->>'election_type' = o->>'election_type'))
           END AS need_election,
           -- ② 團體：所屬都道府県先、再這個團體（都道府県的選舉只有自己）
           CASE WHEN policy_jp.area_item_dead_end(ARRAY[a.tid || ':local_government']) THEN '{}'::TEXT[]
                ELSE ARRAY(SELECT x.code FROM (SELECT DISTINCT ON (c) c AS code, ord FROM unnest(ARRAY[policy_jp.lg_pref_code(a.lg_code), a.lg_code]) WITH ORDINALITY AS u(c, ord) ORDER BY c, ord) x
                            WHERE NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = x.code)
                              AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                                               WHERE c.contribution_type = 'local_government' AND c.status IN ('pending', 'verified', 'disputed')
                                                 AND c.payload->>'lg_code' = x.code)
                            ORDER BY x.ord)
           END AS need_lg,
           -- ③ 統計：stat_min_year 以後沒有已上線的、也沒有在途的
           CASE WHEN policy_jp.area_item_dead_end(ARRAY[a.tid || ':regional_stats']) THEN NULL
                ELSE (SELECT jsonb_agg(jsonb_build_object('stat_key', k.key, 'min_year', k.value::INTEGER, 'unit', policy_jp.regional_stat_unit(k.key)) ORDER BY k.key)
                        FROM p, jsonb_each_text(p.stat_min_year) AS k(key, value)
                       WHERE NOT EXISTS (SELECT 1 FROM policy_jp.regional_stats s
                                          WHERE s.lg_code = a.lg_code AND s.stat_key = k.key AND s.year >= k.value::INTEGER AND s.review_status = 'published')
                         AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                                          WHERE c.contribution_type = 'regional_stat' AND c.status IN ('pending', 'verified', 'disputed')
                                            AND c.payload->>'lg_code' = a.lg_code AND c.payload->>'stat_key' = k.key))
           END AS need_stats
      FROM areas a
  ),
  gaps AS (
    SELECT n.* FROM needs n
     WHERE n.need_election IS NOT NULL OR cardinality(n.need_lg) > 0 OR n.need_stats IS NOT NULL
     ORDER BY n.area_end, n.lg_code
     LIMIT (SELECT cap FROM p)
  )
  SELECT g.tid, 'area',
         jsonb_strip_nulls(jsonb_build_object(
           'stage', 'pre', 'lg_code', g.lg_code, 'lg_name', g.lg_name, 'pref_name', g.pref_name, 'pref_code', g.pref_code,
           'term_end', g.area_end, 'offices', g.offices, 'certainly_in_scope', g.certainly_in_scope, 'scope_from', g.scope_from,
           'term_source_id', g.source_id, 'term_as_of', g.as_of,
           'items', jsonb_strip_nulls(jsonb_build_object(
             'election', g.need_election,
             'local_governments', CASE WHEN cardinality(g.need_lg) > 0 THEN to_jsonb(g.need_lg) END,
             'regional_stats', g.need_stats)),
           'item_task_ids', jsonb_build_object('election', g.tid || ':election', 'local_government', g.tid || ':local_government', 'regional_stats', g.tid || ':regional_stats'))),
         g.lg_name || '（' || g.pref_name || '、団体コード ' || g.lg_code || '）の選挙前の調べものです。'
           || '次の選挙に向けて、まだ記録にない項目を、この task_id でまとめて提出してください（項目ごとに別々の提出。contributions の配列で一度に送れます）。'
           || CASE WHEN g.need_election IS NOT NULL THEN
                '【選挙の日程】'
                || (SELECT string_agg(CASE WHEN o->>'office_kind' = 'head' THEN '長' ELSE '議会議員' END || 'の任期は ' || (o->>'term_end') || ' に満了', '、' ORDER BY o->>'office_kind' DESC)
                      FROM jsonb_array_elements(g.need_election) o)
                || '（総務省「任期満了に関する調」' || g.as_of || ' 現在）。' || g.pref_name || 'または' || g.lg_name || 'の選挙管理委員会の告示・お知らせで告示日・投票日を確かめ、'
                || 'contribution_type=election（lg_code・election_type・election_reason・election_date・notice_date、出典は選管の告示）。辞職などで任期が変わっていた場合も、実際の選挙日程を election で。'
                || 'まだ公表されていなければ contribution_type=no_change を、payload.task_id を「' || g.tid || ':election」にして outcome=not_found・checked_urls で（この項目だけ 14 日後にまた聞きます。ほかの項目はそのまま提出できます）。'
              ELSE '' END
           || CASE WHEN cardinality(g.need_lg) > 0 THEN
                '【地方公共団体】' || array_to_string(g.need_lg, '・') || ' がまだ登録されていません。'
                || '総務省「全国地方公共団体コード」（https://www.soumu.go.jp/denshijiti/code.html）で確かめ、contribution_type=local_government'
                || '（lg_code・kind・pref_code・name・kana〔ひらがな〕。都道府県を先に）。コード表と一致すれば自動で確定します。'
              ELSE '' END
           || CASE WHEN g.need_stats IS NOT NULL THEN
                '【地域の統計】'
                || (SELECT string_agg(policy_jp.regional_stat_label(m->>'stat_key') || '＝' || (m->>'min_year') || ' 年以降の最新値（stat_key=' || (m->>'stat_key') || '、unit=' || (m->>'unit') || '）', '、' ORDER BY m->>'stat_key')
                      FROM jsonb_array_elements(g.need_stats) m)
                || '。e-Stat「令和7年国勢調査 都道府県・市区町村別の主な結果」（人口・面積・65歳以上人口の割合）や総務省の市町村決算カード（歳出）で確かめ、'
                || '値 1 つにつき 1 件、contribution_type=regional_stat（lg_code・stat_key・year・value・unit・as_of）。'
              ELSE '' END
           || '確かめられない項目は、その項目だけ no_change で報告してください（payload.task_id は target.item_task_ids のその項目の値）。',
         ARRAY[g.pref_name || '選挙管理委員会', g.lg_name || '選挙管理委員会', '総務省 任期満了に関する調', '総務省 全国地方公共団体コード',
               'e-Stat 国勢調査 都道府県・市区町村別の主な結果', '総務省 市町村決算カード']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_area IS
  '地區任務（policy-jp docs/PLAN-area-tasks.md）的 pre 階段：任期満了が近い団体ごとに 1 件（首長と議会の満了日が merge_days 未満なら 1 件）。'
  'target.items は足りない項目だけ（選挙日程・団体・統計）。規則 area の params（scope_from、lead_days、include_uncertain、cap、merge_days、stat_min_year）を読む';

-- ------------------------------------------------------------
-- 3. 臂名清單與總表：20261009210100 的版本各多一個名字／一行分支（其餘一字不改）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY[
    'manual_visitor',
    'manual_open',
    'election_discovery',
    'local_government_missing',
    'regional_stats_missing',
    'area'
  ]::TEXT[]
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH tagged AS (
  SELECT 'manual_visitor' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM policy_jp.contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'election_discovery' AS arm, t.* FROM policy_jp.contribution_auto_tasks_election_discovery() t
  UNION ALL SELECT 'local_government_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_local_government_missing() t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_regional_stats_missing() t
  UNION ALL SELECT 'area' AS arm, t.* FROM policy_jp.contribution_auto_tasks_area() t
       ),
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       keyed AS (
  SELECT g.*, policy_jp.election_id_or_null(g.target->>'election_id') AS eid, NULLIF(g.target->>'election_type', '') AS etype FROM tagged g
       ),
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE policy_jp.activity_require_rule(x.arm) OFFSET 0) k
    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們
      SELECT * FROM policy_jp.activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o ON true
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         CASE WHEN o.source IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, '') = COALESCE(g.eid, '') AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
   WHERE (o.source IS NOT NULL OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
$$;
-- ------------------------------------------------------------
-- 4. 規則：area 種一條（參數從 election_discovery 的現行規則抄，再加併件天數與統計年份）；舊三支用覆寫 closed 停掉
-- ------------------------------------------------------------
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'area', 'always', 'announced',
       COALESCE((SELECT r.params FROM policy_jp.activity_rules r WHERE r.activity = 'election_discovery' AND r.priority IS NULL ORDER BY r.id LIMIT 1),
                '{"cap":50,"lead_days":180,"scope_from":"2027-01-01","include_uncertain":true}'::JSONB)
         || '{"merge_days":30,"stat_min_year":{"population":2020,"area_km2":2020,"aging_rate":2020,"budget_expenditure":2023}}'::JSONB,
       '地區任務 pre 階段（policy-jp docs/PLAN-area-tasks.md）：任期満了前 lead_days 天起，一個団体一件（首長と議会の満了日が merge_days 未満なら併件），'
       || '足りない項目（選挙日程・団体・統計）をまとめて。同時に開くのは cap 件、満了日の早い順'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'area' AND r.priority IS NULL);

-- 舊三支停掉：照 activity_health 的慣例用覆寫 closed 留下理由（不停用規則；規則全停用會被健康檢查列成 activity_all_rules_disabled）
INSERT INTO policy_jp.activity_overrides (activity, "force", reason, created_by)
SELECT a, 'closed', '10-09 併進地區任務 area（policy-jp docs/PLAN-area-tasks.md，維護者：以選舉為單位、一個地區一件任務、不做全國普查）；已經交進來的貢獻照常驗證、落庫',
       'migration 20261009210400'
  FROM unnest(ARRAY['election_discovery', 'local_government_missing', 'regional_stats_missing']) AS a
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_overrides o WHERE o.activity = a AND o."force" = 'closed' AND o.election_id IS NULL AND o.election_type IS NULL);

-- ------------------------------------------------------------
-- 5. 權限與自我檢查
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.area_item_dead_end(TEXT[]), policy_jp.contribution_auto_tasks_area(),
  policy_jp.contribution_auto_tasks_arms(), policy_jp.activity_arm_names() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.area_item_dead_end(TEXT[]), policy_jp.contribution_auto_tasks_area(),
  policy_jp.contribution_auto_tasks_arms(), policy_jp.activity_arm_names() TO service_role;

DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'area' AND r.enabled AND r.priority IS NULL
                  AND r.params ? 'cap' AND r.params ? 'lead_days' AND r.params ? 'scope_from' AND jsonb_typeof(r.params->'stat_min_year') = 'object') THEN
    RAISE EXCEPTION 'policy_jp：area 的規則缺 cap／lead_days／scope_from／stat_min_year（臂會整支回 0 列＝無聲消失）';
  END IF;
  SELECT string_agg(k.key, ', ') INTO bad
    FROM policy_jp.activity_rules r, jsonb_each_text(r.params->'stat_min_year') AS k(key, value)
   WHERE r.activity = 'area' AND policy_jp.regional_stat_unit(k.key) IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：area 的 stat_min_year 有不認得的 stat_key：%', bad; END IF;
  SELECT string_agg(a, ', ') INTO bad
    FROM unnest(ARRAY['election_discovery', 'local_government_missing', 'regional_stats_missing']) AS a
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_overrides o WHERE o.activity = a AND o."force" = 'closed'
                       AND o.election_id IS NULL AND o.election_type IS NULL AND o.expires_at IS NULL);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：舊的派工臂要用覆寫 closed 停掉：%', bad; END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_area()', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：area 臂不該給 anon 執行';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
