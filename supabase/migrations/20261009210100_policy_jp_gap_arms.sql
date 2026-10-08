-- 日本站兩支新的缺口臂（local_government_missing、regional_stats_missing）＋ #503 修正：election_discovery 的 cap 套在「可派」的缺口上
-- ============================================================
--
-- 前提：20261009210000_policy_jp_apply.sql（regional_stats、新交件型別、落庫與 no_change 的冷卻紀錄）。
-- 原則（維護者 10-08）：日本站的資料一律走「找缺口 → 派任務 → 代理附官方出處交件 → 同儕驗證 → 落庫」，程式不產生資料。
--
-- 一、local_government_missing：總務省任期満了調查（term_expirations）裡出現、卻不在 local_governments 的團體（含 47 都道府県）
--      → 派「從総務省の全国地方公共団体コードで確かめて local_government を回報」。都道府県先、再依團體碼；規則 params.cap（200）。
--      團體表是選舉（elections.lg_code）與統計（regional_stats.lg_code）外鍵的根，所以它是缺口鏈的第一環。
-- 二、regional_stats_missing：local_governments 裡的團體，缺「已上線、年度 ≥ params.min_year[stat_key]」的統計 → 一個團體一件任務，
--      列出缺哪幾個 stat_key（人口・面積・歳出・高齢化率）。都道府県先、再依團體碼；規則 params.cap（200）；
--      params.min_year 是每個 stat_key 最舊可接受的年份（西暦；歳出は会計年度の開始年）——新的年度進來就自動滿足，要求更新的年度改規則一行；
--      params.exclude_kinds（初值 admin_ward）：政令市の行政区は決算カードがない（歳出が永遠に埋まらない）ので対象外。
-- 三、#503（主線 10-09）election_discovery 臂：ORDER BY term_end … LIMIT cap 原本在 blocked／冷卻過濾「之前」截斷。
--      refresh_dispatch_blocked 把「有 pending／verified 的 no_change」的任務擋住、task_checks 讓它冷卻 14 天，
--      但這些任務仍佔著 cap 名額，第 51 名以後永遠開不出來。選擇：**cap 套在可派的缺口上**（臂先排除，再 LIMIT），不是縮短 no_change 的擋期。理由：
--        1. 病因是「先截斷、後過濾」，不管擋的原因是 no_change、冷卻或飽和，佔名額的結構問題都一樣；縮短擋期只修其中一種；
--        2. 縮短擋期要動 refresh_dispatch_blocked（走樣守門登記的正見複本，而且影響所有臂）；排除在臂裡，不動共用函式；
--        3. 新的兩支臂（也有 cap）一開始就用同一個函式，行為一致。
--      代價：被排除的任務在冷卻期間不在派工列裡（seed 把它收回，gap_events 記 closed／filled），冷卻過了臂又算得出來，重新出生（reopened）。
--      排除條件集中在一支函式 task_unavailable()：飽和（≥5 筆在途）、no_change 等票或已通過、task_checks 冷卻中——前三項與 refresh_dispatch_blocked
--      同一個定義（行為對照測試守著）——再加第四項：有通過驗證、等落庫的資料型交件（election／local_government／regional_stat）。
--      第四項是日本站落庫「等團體到了再落」（#503 c）造成的：已經查到、只是外鍵在等，不該再派別人重查。
--      重新定義 election_discovery 臂是「緊接在 20261009130100 那一版上加一段」（守門 policy-jp-apply.test.ts 做機械替換比對）。
-- 四、no_change 現在會落庫（上一支 migration）：通過驗證的 no_change 記一筆 task_checks、狀態轉 applied；
--      因此任務在 nochange 擋期（pending／verified）結束後進入冷卻，冷卻到期任務重開。
--
-- 新增一支臂的三處（CLAUDE.md）：總表加 UNION 分支、activity_arm_names() 加名字、activity_rules 種規則——都在這支。
-- 總表與臂名清單是 20261009130100 的版本加兩行／兩個名字（其餘一字不改；守門做替換比對）。
-- 臂沒有選舉（target 沒有 election_id）＝預設優先層；task_id 是 auto:<型別>:<團體碼>。

-- ------------------------------------------------------------
-- 1. 可派判斷：這個任務現在能不能派給別人（true＝不能）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.task_unavailable(p_task_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  -- 1. 飽和：在途（pending／verified／disputed）的交件 ≥ 5 筆（同 refresh_dispatch_blocked 的 saturated）
  SELECT (SELECT COUNT(*) FROM policy_jp.contributions c WHERE c.task_id = p_task_id AND c.status IN ('pending', 'verified', 'disputed')) >= 5
      -- 2. 「查了，沒有異動／查無」還在等票或已通過、還沒落庫（同 refresh_dispatch_blocked 的 nochange）
      OR EXISTS (SELECT 1 FROM policy_jp.contributions c
                  WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified') AND c.payload->>'task_id' = p_task_id)
      -- 3. 冷卻中：最近查過（同 refresh_dispatch_blocked 的 cool：unreachable 2 天、其餘 14 天）
      OR EXISTS (SELECT 1 FROM policy_jp.task_checks tc
                  WHERE tc.task_id = p_task_id
                    AND tc.checked_at > now() - (CASE WHEN tc.outcome = 'unreachable' THEN policy_jp.task_unreachable_cooldown_days() ELSE policy_jp.task_check_cooldown_days() END || ' days')::INTERVAL)
      -- 4. 資料型交件已通過驗證、等著落庫（團體還沒進來時會等）：答案已經有了，不要再派人重查
      OR EXISTS (SELECT 1 FROM policy_jp.contributions c
                  WHERE c.task_id = p_task_id AND c.status = 'verified' AND c.contribution_type IN ('election', 'local_government', 'regional_stat'))
$$;
COMMENT ON FUNCTION policy_jp.task_unavailable IS '任務現在不能派（飽和／no_change 等票或已通過／冷卻中／資料型交件通過等落庫）。派工臂在 LIMIT cap 之前用它排除，cap 才是「可派的前 N 筆」（#503）。前三項與 refresh_dispatch_blocked 同一個定義';

-- 統計項目的日文名（給任務描述用）
CREATE OR REPLACE FUNCTION policy_jp.regional_stat_label(p_stat_key TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_stat_key
           WHEN 'population' THEN '人口（国勢調査）'
           WHEN 'area_km2' THEN '面積（全国都道府県市区町村別面積調）'
           WHEN 'budget_expenditure' THEN '歳出決算総額（市町村決算カード・都道府県決算状況）'
           WHEN 'aging_rate' THEN '高齢化率（65歳以上人口の割合）'
         END
$$;

-- ------------------------------------------------------------
-- 2. #503：election_discovery 臂（20261009130100 的版本加一段排除條件）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_election_discovery()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'scope_from')::DATE AS scope_from,
           (r.params->>'lead_days')::INTEGER AS lead_days,
           COALESCE((r.params->>'include_uncertain')::BOOLEAN, true) AS include_uncertain,
           (r.params->>'cap')::INTEGER AS cap,
           policy_jp.activity_today() AS today
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'election_discovery' AND r.enabled
     ORDER BY r.id LIMIT 1
  ),
  latest AS (
    SELECT DISTINCT ON (t.lg_code, t.office_kind) t.* FROM policy_jp.term_expirations t ORDER BY t.lg_code, t.office_kind, t.as_of DESC
  ),
  gaps AS (
    SELECT t.*, p.scope_from FROM latest t CROSS JOIN p
     WHERE p.scope_from IS NOT NULL AND p.lead_days IS NOT NULL AND p.cap IS NOT NULL
       AND t.term_end - 1 >= p.scope_from
       AND (p.include_uncertain OR t.term_end - 30 >= p.scope_from)
       AND t.term_end - p.lead_days <= p.today
       AND t.term_end + 60 >= p.today
       AND NOT EXISTS (
         SELECT 1 FROM policy_jp.elections e
          WHERE e.lg_code = t.lg_code AND e.election_type = t.election_type AND e.review_status <> 'rejected'
            AND e.election_date BETWEEN t.term_end - 120 AND t.term_end + 60)
       -- #503：cap 要套在「可派」的缺口上——有人交了查無（等票中或已通過）、冷卻中、飽和、已有通過等落庫的交件的團體先排除，再 ORDER BY／LIMIT。
       -- 否則前 N 筆被擋住的團體會佔著名額，第 N+1 名以後開不出來
       AND NOT policy_jp.task_unavailable('auto:election_discovery:' || t.term_end || ':' || t.lg_code || ':' || t.office_kind)
     ORDER BY t.term_end, t.lg_code, t.office_kind
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:election_discovery:' || g.term_end || ':' || g.lg_code || ':' || g.office_kind, 'election_discovery',
         jsonb_build_object('lg_code', g.lg_code, 'pref_name', g.pref_name, 'lg_name', g.lg_name,
                            'office_kind', g.office_kind, 'election_type', g.election_type, 'term_end', g.term_end,
                            'vote_window_from', g.term_end - 30, 'vote_window_until', g.term_end - 1,
                            'certainly_in_scope', (g.term_end - 30 >= g.scope_from), 'scope_from', g.scope_from,
                            'term_source_id', g.source_id, 'term_as_of', g.as_of),
         g.lg_name || 'の' || CASE WHEN g.office_kind = 'head' THEN '長' ELSE '議会議員' END || 'の任期は ' || g.term_end || ' に満了します（総務省「任期満了に関する調」' || g.as_of || ' 現在）。'
           || 'この任期満了による選挙の告示日・投票日を、' || g.pref_name || 'または' || g.lg_name || 'の選挙管理委員会の告示・お知らせで確かめてください。'
           || '公表済みなら contribution_type=election（lg_code・election_type・election_reason・election_date・notice_date、出典は選管の告示）。'
           || 'まだ公表されていなければ contribution_type=no_change、outcome=not_found、checked_urls に見た選管のページを入れてください。'
           || '辞職などで任期が変わっていた場合も、実際の選挙日程を election で回報してください。',
         ARRAY[g.pref_name || '選挙管理委員会', g.lg_name || '選挙管理委員会', '総務省 任期満了に関する調']::TEXT[], 2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_election_discovery IS
  '任期満了日（term_expirations）が近いのに対応する選挙がない団体 → election_discovery 任務。規則 election_discovery の params（scope_from、lead_days、include_uncertain、cap）を読む。cap は可派（task_unavailable でない）の前 N 件（#503）';

-- ------------------------------------------------------------
-- 3. 臂：local_government_missing
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
  latest AS (
    SELECT DISTINCT ON (t.lg_code, t.office_kind) t.* FROM policy_jp.term_expirations t ORDER BY t.lg_code, t.office_kind, t.as_of DESC
  ),
  names AS (
    -- 一個團體可能有「長」「議会」兩列：名稱以「長」那一列為準
    SELECT DISTINCT ON (l.lg_code) l.lg_code, l.pref_name, l.lg_name, l.source_id, l.as_of FROM latest l ORDER BY l.lg_code, (l.office_kind = 'head') DESC
  ),
  gaps AS (
    SELECT n.* FROM names n CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = n.lg_code)
       AND NOT policy_jp.task_unavailable('auto:local_government_missing:' || n.lg_code)
     ORDER BY (substr(n.lg_code, 3, 3) = '000') DESC, n.lg_code
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:local_government_missing:' || g.lg_code, 'local_government_missing',
         jsonb_build_object('lg_code', g.lg_code, 'pref_name', g.pref_name, 'lg_name', g.lg_name, 'pref_code', policy_jp.lg_pref_code(g.lg_code),
                            'is_prefecture', (substr(g.lg_code, 3, 3) = '000'), 'term_source_id', g.source_id, 'term_as_of', g.as_of),
         g.lg_name || '（団体コード ' || g.lg_code || '、' || g.pref_name || '）が地方公共団体の一覧（local_governments）にまだありません。'
           || '総務省「全国地方公共団体コード」（https://www.soumu.go.jp/denshijiti/code.html）で団体コード・名称・読みを確かめ、contribution_type=local_government で回報してください。'
           || 'payload は lg_code・kind・pref_code・name・kana（読みは「ひらがな」に直す）。source_urls には総務省の団体コード表（またはその団体の公式サイト）を入れてください。'
           || CASE WHEN substr(g.lg_code, 3, 3) = '000'
                   THEN 'これは都道府県です：kind=prefecture、pref_code は lg_code と同じ値にします。'
                   ELSE 'kind は 政令指定都市＝designated_city、中核市＝core_city、その他の市＝city、東京23区＝special_ward、町＝town、村＝village から選びます'
                        || '（政令指定都市・中核市かどうかは総務省の指定都市・中核市の一覧で確かめる）。pref_code は ' || policy_jp.lg_pref_code(g.lg_code) || '（所属の都道府県）です。'
              END
           || 'コード表で確かめられない場合は contribution_type=no_change、outcome=not_found、checked_urls に見たページを入れて回報してください。',
         ARRAY['総務省 全国地方公共団体コード', g.lg_name || ' 公式サイト', '総務省 指定都市・中核市の一覧']::TEXT[], 1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_local_government_missing IS
  '任期満了調査（term_expirations）にいるのに local_governments にない団体 → local_government_missing 任務。都道府県を先、次に団体コード順。規則 local_government_missing の params.cap を読む。cap は可派（task_unavailable でない）の前 N 件';

-- ------------------------------------------------------------
-- 4. 臂：regional_stats_missing
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_regional_stats_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap, r.params->'min_year' AS min_year, COALESCE(r.params->'exclude_kinds', '[]'::JSONB) AS exclude_kinds
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'regional_stats_missing' AND r.enabled
     ORDER BY r.id LIMIT 1
  ),
  want AS (
    SELECT k.key AS stat_key, k.value::INTEGER AS min_year FROM p, jsonb_each_text(p.min_year) AS k(key, value)
  ),
  cand AS (
    SELECT g.lg_code, g.kind, g.name, pr.name AS pref_name,
           (SELECT jsonb_agg(jsonb_build_object('stat_key', w.stat_key, 'min_year', w.min_year, 'unit', policy_jp.regional_stat_unit(w.stat_key)) ORDER BY w.stat_key)
              FROM want w
             WHERE NOT EXISTS (SELECT 1 FROM policy_jp.regional_stats s
                                WHERE s.lg_code = g.lg_code AND s.stat_key = w.stat_key AND s.year >= w.min_year AND s.review_status = 'published')) AS missing
      FROM policy_jp.local_governments g
      JOIN policy_jp.local_governments pr ON pr.lg_code = g.pref_code
      CROSS JOIN p
     WHERE p.cap IS NOT NULL AND g.valid_to IS NULL AND NOT (p.exclude_kinds ? g.kind)
  ),
  gaps AS (
    SELECT c.* FROM cand c CROSS JOIN p
     WHERE c.missing IS NOT NULL
       AND NOT policy_jp.task_unavailable('auto:regional_stats_missing:' || c.lg_code)
     ORDER BY (c.kind = 'prefecture') DESC, c.lg_code
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:regional_stats_missing:' || g.lg_code, 'regional_stats_missing',
         jsonb_build_object('lg_code', g.lg_code, 'lg_name', g.name, 'pref_name', g.pref_name, 'kind', g.kind, 'missing', g.missing),
         g.name || '（団体コード ' || g.lg_code || '）の統計値が足りません：'
           || (SELECT string_agg(policy_jp.regional_stat_label(m->>'stat_key') || '＝' || (m->>'min_year') || ' 年以降の最新値（stat_key=' || (m->>'stat_key') || '、unit=' || (m->>'unit') || '）', '、' ORDER BY m->>'stat_key')
                 FROM jsonb_array_elements(g.missing) m)
           || '。e-Stat「統計でみる市区町村のすがた」や総務省の市町村決算カード・国勢調査などの公的統計で確かめ、値 1 つにつき 1 件、contribution_type=regional_stat で回報してください。'
           || 'payload は lg_code・stat_key・year（西暦。歳出は会計年度の開始年）・value（数値）・unit（上の unit のとおり）・as_of（基準日 YYYY-MM-DD、任意）。'
           || 'source_urls には統計の公表元（e-Stat・総務省・その団体の公式統計ページ）を入れてください。'
           || '公表されていない・確かめられない場合は contribution_type=no_change、outcome=not_found、checked_urls に見たページを入れて回報してください。',
         ARRAY['e-Stat 統計でみる市区町村のすがた', '総務省 市町村決算カード', '総務省統計局 国勢調査', g.name || ' 公式サイトの統計ページ']::TEXT[], 2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_regional_stats_missing IS
  'local_governments の団体で、公開済みの統計（stat_key ごとに params.min_year 年以降）が足りないもの → regional_stats_missing 任務（1 団体 1 件、足りない stat_key を target.missing に列挙）。都道府県を先、次に団体コード順。cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 5. 臂名清單與總表：20261009130100 の版本に名前 2 つ／分岐 2 行を足しただけ（残りは一字も変えない）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY[
    'manual_visitor',
    'manual_open',
    'election_discovery',
    'local_government_missing',
    'regional_stats_missing'
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
-- 6. 規則（照「新增一支臂」：規則直接種；參數放 params）
-- ------------------------------------------------------------
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'local_government_missing', 'always', 'announced', '{"cap":200}'::JSONB,
       '任期満了調査にいるのに local_governments にない団体を、総務省の団体コード表で確かめて local_government を回報させる。同時に開くのは最大 200 件（都道府県が先、次に団体コード順）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'local_government_missing' AND r.priority IS NULL);
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'regional_stats_missing', 'always', 'announced',
       '{"cap":200,"min_year":{"population":2020,"area_km2":2020,"aging_rate":2020,"budget_expenditure":2023},"exclude_kinds":["admin_ward"]}'::JSONB,
       '団体ごとの統計（人口・面積・高齢化率は国勢調査 2020 年以降、歳出は 2023 会計年度以降の最新）が足りないものを、e-Stat・総務省で確かめて regional_stat を回報させる。同時に開くのは最大 200 件（都道府県が先）。行政区は決算カードがないので対象外'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'regional_stats_missing' AND r.priority IS NULL);

-- ------------------------------------------------------------
-- 7. 權限與自我檢查（新函式預設對 PUBLIC 可執行，要明寫收回）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.task_unavailable(TEXT), policy_jp.regional_stat_label(TEXT),
  policy_jp.contribution_auto_tasks_election_discovery(), policy_jp.contribution_auto_tasks_local_government_missing(),
  policy_jp.contribution_auto_tasks_regional_stats_missing(), policy_jp.contribution_auto_tasks_arms(), policy_jp.activity_arm_names()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.task_unavailable(TEXT), policy_jp.regional_stat_label(TEXT),
  policy_jp.contribution_auto_tasks_election_discovery(), policy_jp.contribution_auto_tasks_local_government_missing(),
  policy_jp.contribution_auto_tasks_regional_stats_missing(), policy_jp.contribution_auto_tasks_arms(), policy_jp.activity_arm_names()
  TO service_role;

DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'local_government_missing' AND r.enabled AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：local_government_missing 的規則缺 cap（臂會整支回 0 列＝無聲消失）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'regional_stats_missing' AND r.enabled
                  AND r.params ? 'cap' AND jsonb_typeof(r.params->'min_year') = 'object') THEN
    RAISE EXCEPTION 'policy_jp：regional_stats_missing 的規則缺 cap／min_year（臂會整支回 0 列＝無聲消失）';
  END IF;
  -- min_year 的每個 key 都要是 regional_stats 認得的 stat_key（寫錯字會變成永遠要求一個不存在的統計）
  SELECT string_agg(k.key, ', ') INTO bad
    FROM policy_jp.activity_rules r, jsonb_each_text(r.params->'min_year') AS k(key, value)
   WHERE r.activity = 'regional_stats_missing' AND policy_jp.regional_stat_unit(k.key) IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：regional_stats_missing 的 min_year 有不認得的 stat_key：%', bad; END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_local_government_missing()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_regional_stats_missing()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.task_unavailable(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：派工臂與可派判斷不該給 anon 執行';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
