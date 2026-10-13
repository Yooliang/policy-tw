-- 日本站派工臂對齊正見：現職首長の施政方針・公約の二本 mayor_policies／term_policies（C 期 第 4 步）。工作單 Yooliang/policy-ops#95、計畫 policy-jp docs/PLAN-arms-parity.md C 期
-- ============================================================
--
--   正見臂             日本臂（activity） 任務型別（task_type）  task_id                                      交件
--   mayor_policies     mayor_policies    policy_missing         auto:policy_missing:<参選紀錄 id>             policy（公約 origin=pledge）／no_change（outcome=not_found）
--   term_policies      term_policies     term_policy_missing    auto:term_policy_missing:<参選紀錄 id>        policy（同上）／no_change（outcome=not_found）
--
--   正見：mayor_policies＝20261008180000_arms_perf.sql（縣市長候選人の当屆政見が 1 筆以上 5 筆未満 → policy_missing。0 筆は raw の policy_missing が担当、task_id は同じ）。
--         term_policies＝20261011030000_arm_windows_13.sql（当選人で、その屆の政見が 0 筆 → term_policy_missing。task_id＝auto:term_policy_missing:<人物>:<屆別>）。
--   日本站のちがい：
--     ・新しい交件型別はない。どちらも既存の policy（公約 origin=pledge、参選に掛かる）で答える。apply_policy は一字も変えない
--       （過去の選挙の参選でも、pe が公開済みなら掛けられる。proposed_date の上限は min(投票日, 今日)）。
--     ・単位は「人×屆」ではなく参選紀錄（policy_jp.politician_elections.id）。task_id の末尾は policy_missing と同じ参選紀錄 id
--       （term は型別名だけ別なので、同じ参選で二つの臂が同じ task_id を取り合うことはない）。
--     ・mayor_policies の task_id は policy_missing と同じ（正見と同じ）：公約 0 件のうちは policy_missing 臂、1 件以上 5 件未満になると mayor_policies 臂が引き継ぐ
--       （1 件目の落庫で任務は一度収回され、次の seed で mayor_policies として戻る＝正見と同じ動き）。対象は首長選挙（params.election_types）の declared／filed だけ
--       （正見の is_2026_mayor_candidate と同じ「まだ結果が出ていない候補者」）。
--     ・term_policies は『任期（politician_offices）の元になった参選』を見る：公開済みの任期の politician_election_id が当選（elected）の参選で、
--       その参選に公開済みの政見が 1 件もないもの。台湾の election_task_config.enabled（屆別の手動開關）に当たるのは、この臂の「開いている選挙の団体・職位と一致」条件
--       ＋ params.lookback_years（任期の終わりが 10 年以内）＋ params.deep_kinds（都道府県・政令市・中核市・市だけ。町村は往回補しない、PLAN-election-chain 第 3 節）。
--       在任中（end_date が空）の人が先頭＝「現職の任内公約」。
--     ・投票直後（開いている選挙＝投票日から 90 日以内）の当選者は policy_missing 臂の対象（elected を含む）なので、term_policies は出さない（二重にしない）。
--     ・鎖の外の臂ではなく、**鎖にぶら下げる**（選挙鎖 第 3 節「往回補は第 1 歩完了後に開く」）：
--         mayor_policies … after_step='candidacy'・後備＝告示日翌日（policy_missing と同じ。その選挙に表明者が出たら 1 件ずつ開く）。
--         term_policies  … after_step='regional_stats'（第 1 歩＝団体・地域統計が済んだ後）・後備＝告示日（announced +0）。target.election_id は
--                           『往回補を開いた原因の、開いている選挙』（過去の選挙は target.term_election_id）。ゲートも優先層も、この開いている選挙で引く。
--       どちらも窓は常時（always）。
--     ・優先層：mayor_policies は policy_missing と同じ（前 60 日以内＝前段、181 日以上前＝後段）。term_policies は後段（過去の補完は新しい選挙の仕事より先に派さない）。
--     ・chain_step_rank：term_policy_missing＝8（整理・補完系。policy_missing の 6 と開票結果の 7 の後ろ）。mayor_policies の型別は policy_missing なので 6 のまま。
--
-- 規則は enabled（既定）。本番は politician_offices が 0 行なので term_policies の出力は任期が入るまで空。mayor_policies は公約 1～4 件の declared／filed がいれば出る。
-- 止める・絞るのは UPDATE policy_jp.activity_rules SET enabled / params（走 migration）。
--
-- 守門：supabase/functions/_shared/policy-jp-term-policies.test.ts、policy-jp-dispatch-drift.test.ts（登記）、same-claims.test.ts、jp/contribution-schema*.test.ts。
-- 不碰 public、ditrust。冪等（規則は NOT EXISTS）、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 臂：mayor_policies（首長選挙の declared／filed で、公開済みの公約が 1 件以上 max_policies 件未満の人）
-- ------------------------------------------------------------
-- 規則（activity_rules「mayor_policies」）の params：cap（同時に開く最大件数）、max_policies（審議中を足して何件で満足か）、election_types（対象の選挙種別）。
-- 公約 0 件の人は policy_missing 臂（同じ task_id）。窓の開閉は総表が決める
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_mayor_policies()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap,
           (r.params->>'max_policies')::INTEGER AS max_policies,
           ARRAY(SELECT jsonb_array_elements_text(r.params->'election_types')) AS election_types
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'mayor_policies' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  -- 審議中の公約の題名（参選ごと。全 contributions を 1 回だけ走査）
  queued_by AS MATERIALIZED (
    SELECT c.payload->>'politician_election_id' AS peid, jsonb_agg(DISTINCT c.payload->>'title') AS titles, count(DISTINCT c.payload->>'title')::INTEGER AS n
      FROM policy_jp.contributions c
     WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified', 'disputed', 'apply_failed')
       AND c.payload->>'politician_election_id' IS NOT NULL
     GROUP BY 1
  ),
  m AS MATERIALIZED (
    SELECT s.*,
           (SELECT count(*) FROM policy_jp.policies pl WHERE pl.politician_election_id = s.politician_election_id AND pl.review_status = 'published')::INTEGER AS n_now,
           -- 同じ人の、ほかの選挙の公約（この選挙の分ではない）
           (SELECT count(*) FROM policy_jp.policies pl JOIN policy_jp.politician_elections o ON o.id = pl.politician_election_id
             WHERE o.politician_id = s.politician_id AND pl.politician_election_id <> s.politician_election_id AND pl.review_status = 'published')::INTEGER AS n_other,
           COALESCE(q.n, 0) AS queued_n, COALESCE(q.titles, '[]'::JSONB) AS queued,
           (SELECT string_agg(DISTINCT pl.category, '・') FROM policy_jp.policies pl
             WHERE pl.politician_election_id = s.politician_election_id AND pl.review_status = 'published') AS cats,
           cfg.max_policies
      FROM policy_jp.chain_policy_subjects() s
      CROSS JOIN cfg
      LEFT JOIN queued_by q ON q.peid = s.politician_election_id
     WHERE cfg.cap IS NOT NULL AND cfg.max_policies IS NOT NULL
       AND s.election_type = ANY (cfg.election_types)
       AND s.candidacy_status IN ('declared', 'filed')
  ),
  gaps AS (
    SELECT m.*
      FROM m
     WHERE m.n_now > 0                                  -- 0 件は policy_missing 臂が出す（同じ task_id を二重に出さない）
       AND m.n_now + m.queued_n < m.max_policies
       AND NOT policy_jp.task_unavailable('auto:policy_missing:' || m.politician_election_id)
     ORDER BY m.election_date, m.kana, m.politician_election_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT 'auto:policy_missing:' || g.politician_election_id, 'policy_missing',
         jsonb_build_object('politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'policies_now', g.n_now, 'policies_other_terms', g.n_other, 'queued', g.queued_n, 'categories_now', g.cats, 'queued_policies', g.queued,
                            'chain_lg_code', g.lg_code, 'chain_step', 'policy'),
         g.name || '（' || COALESCE(g.kana || '、', '') || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）の**この選挙の**公約は、いま ' || g.n_now || ' 件です'
           || CASE WHEN g.queued_n > 0 THEN '（ほかに審議中が ' || g.queued_n || ' 件）' ELSE '' END
           || CASE WHEN g.n_other > 0 THEN '。このほか、過去の選挙の公約が ' || g.n_other || ' 件ありますが、この選挙の分には数えません' ELSE '' END
           || CASE WHEN g.cats IS NOT NULL THEN '。すでにある分野：' || g.cats ELSE '' END
           || '。首長選挙は住民が最も参照する情報なので、この選挙で掲げた具体的な公約を、合計 ' || g.max_policies || ' 件になるまで追加してください（あと ' || (g.max_policies - g.n_now - g.queued_n) || ' 件まで）。'
           || '選挙公報（選挙管理委員会のページ）・候補者本人の公式サイト・公式な政策パンフレットから、まだ登録されていない分野を優先して探します。'
           || '1 件ずつ contribution_type=policy で提出します（見つかった数だけ。スローガン・理念・人柄の話は公約ではないので出さない）。'
           || 'payload は politician_election_id（' || g.politician_election_id || '）・title（4～100 字）・description（要約：120 字以内、事実だけ）・category（分野）・'
           || 'source_locator（原文のどこか：公報の頁や見出し。必須）・resolved_claim（item.current.same_claims を見て決める。誰も出していなければ "new"）、分かれば proposed_date。'
           || 'source_urls はその公約が書かれたページです。登録済みの公約と審議中の公約（target.queued_policies：'
           || COALESCE((SELECT string_agg(q, '、') FROM jsonb_array_elements_text(g.queued) q), 'なし') || '）は重複して出さないでください。'
           || '現職の人の就任後の施策・施政方針演説、過去の選挙の公約は、この選挙の公約ではありません。'
           || 'これ以上見つからないときは contribution_type=no_change、outcome=not_found、checked_urls に探した場所を入れて報告してください（推測や他人の公約の流用をしない）。',
         ARRAY[g.lg_name || ' 選挙管理委員会の選挙公報', '候補者本人の公式サイト・公式パンフレット', g.pref_name || ' 選挙管理委員会', '政党の公認・推薦候補の発表ページ']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_mayor_policies IS
  '首長候補の公約補充（正見 mayor_policies の日本版）：開いている選挙（chain_policy_subjects）の首長選挙で declared／filed の人のうち、公開済みの公約が 1 件以上、審議中を足して max_policies 件未満 → policy_missing 任務'
  '（task_id は policy_missing 臂と同じ auto:policy_missing:<参選紀錄 id>。0 件は policy_missing 臂）。窓（規則の enabled・chain gate）は総表が決める。params：cap・max_policies・election_types';

-- ------------------------------------------------------------
-- 2. 臂：term_policies（任期の元になった当選の参選に、公開済みの公約が 1 件もない：往回補）
-- ------------------------------------------------------------
-- 規則（activity_rules「term_policies」）の params：cap、lookback_years（任期の終わり〔在任中は今日〕がこの年数以内）、deep_kinds（団体の種類）、election_types（職位）。
-- 『いまの選挙の団体・職位』と同じところだけを遡る（開いている選挙＝chain_open_elections）。投票直後の当選者（その選挙がまだ開いている）は policy_missing 臂が担当
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_term_policies()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap,
           (r.params->>'lookback_years')::INTEGER AS lookback_years,
           ARRAY(SELECT jsonb_array_elements_text(r.params->'deep_kinds')) AS deep_kinds,
           ARRAY(SELECT jsonb_array_elements_text(r.params->'election_types')) AS election_types
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'term_policies' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  cand AS MATERIALIZED (
    -- 任期（公開済み）→ その元になった当選の参選 → 過去の選挙 → 同じ団体・同じ職位の『いまの開いている選挙』（投票日がそれより後のうち一番近い）
    SELECT DISTINCT ON (pe.id)
           pe.id AS pe_id, pe.politician_id, pp.name, pp.kana,
           o.id AS office_id, o.term_no, o.start_date, o.scheduled_end_date, o.end_date,
           te.id AS term_election_id, te.name AS term_election_name, te.election_date AS term_election_date,
           oe.election_id, oe.election_type, oe.election_date, te.lg_code, g.name AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(te.lg_code)), '（都道府県名未確認）') AS pref_name
      FROM cfg
      JOIN policy_jp.politician_offices o ON o.review_status = 'published'
      JOIN policy_jp.politician_elections pe ON pe.id = o.politician_election_id AND pe.review_status = 'published' AND pe.candidacy_status = 'elected'
      JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
      JOIN policy_jp.elections te ON te.id = pe.election_id AND te.review_status = 'published' AND te.lg_code IS NOT NULL
                                 AND te.election_date < policy_jp.activity_today() AND te.election_type = ANY (cfg.election_types)
      JOIN policy_jp.local_governments g ON g.lg_code = te.lg_code AND g.kind = ANY (cfg.deep_kinds)
      JOIN policy_jp.chain_open_elections oe ON oe.lg_code = te.lg_code AND oe.election_type = te.election_type AND oe.basis = 'published'
                                            AND oe.election_date > te.election_date
     WHERE cfg.cap IS NOT NULL AND cfg.lookback_years IS NOT NULL
       AND COALESCE(o.end_date, policy_jp.activity_today()) >= policy_jp.activity_today() - make_interval(years => cfg.lookback_years)
       AND NOT EXISTS (SELECT 1 FROM policy_jp.policies pl WHERE pl.politician_election_id = pe.id AND pl.review_status = 'published')
       -- 投票直後（その選挙がまだ開いている）の当選者は policy_missing 臂が担当
       AND NOT EXISTS (SELECT 1 FROM policy_jp.chain_open_elections x WHERE x.election_id = te.id)
     ORDER BY pe.id, oe.election_date, oe.election_id
  ),
  gaps AS (
    SELECT c.*,
           COALESCE((SELECT jsonb_agg(DISTINCT x.payload->>'title') FROM policy_jp.contributions x
                      WHERE x.contribution_type = 'policy' AND x.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                        AND x.payload->>'politician_election_id' = c.pe_id), '[]'::JSONB) AS queued
      FROM cand c
     WHERE NOT policy_jp.task_unavailable('auto:term_policy_missing:' || c.pe_id)
     ORDER BY (c.end_date IS NULL) DESC, c.term_election_date DESC, c.pe_id      -- 在任中の人が先、そのあと新しい任期から
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT 'auto:term_policy_missing:' || g.pe_id, 'term_policy_missing',
         jsonb_build_object('politician_election_id', g.pe_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'election_id', g.election_id, 'election_type', g.election_type, 'election_date', g.election_date,
                            'term_election_id', g.term_election_id, 'term_election_name', g.term_election_name, 'term_election_date', g.term_election_date,
                            'office_id', g.office_id, 'term_no', g.term_no, 'term_start', g.start_date, 'term_end', g.scheduled_end_date,
                            'in_office', g.end_date IS NULL, 'lg_code', g.lg_code, 'lg_name', g.lg_name, 'queued_policies', g.queued,
                            'chain_lg_code', g.lg_code),
         g.name || '（' || COALESCE(g.kana || '、', '') || g.lg_name || '）は ' || g.term_election_date || ' の ' || g.term_election_name || ' で当選し（' || g.term_no || ' 期目、'
           || CASE WHEN g.end_date IS NULL THEN '現在も在任中' ELSE g.end_date || ' に任期を終えています' END
           || '）、**その選挙で掲げた公約**がまだ 1 件も登録されていません。'
           || '探すのは『この選挙のときの公約』です：当時の選挙公報、当時の候補者の公式サイト・パンフレット・政見放送、当時の新聞報道。就任後に打ち出した施策や施政方針演説は、この任務の対象ではありません。'
           || '1 件ずつ contribution_type=policy で提出します（最大 5 件、見つかった数だけ。スローガン・理念・「まちを元気に」のような中身のない一言は出さない）。'
           || 'payload は politician_election_id（' || g.pe_id || '）・title（4～100 字）・description（要約：120 字以内、事実だけ）・category（分野）・'
           || 'source_locator（原文のどこか：公報の頁や見出し。必須）・resolved_claim（item.current.same_claims を見て決める。誰も出していなければ "new"）、分かれば proposed_date（当時の公表日）。'
           || 'source_urls はその公約が書かれたページです。公約が実現したか・進んでいるかはこの任務では書かない（進み具合は別の任務で調べます）。'
           || '過去の選挙公報は選管のサイトから消えていることが多いので、自治体の広報・議会だより、国立国会図書館のインターネット資料収集保存事業（WARP）、ウェイバックマシンに残る当時の公式サイトも探してください。'
           || '審議中の公約（target.queued_policies：' || COALESCE((SELECT string_agg(q, '、') FROM jsonb_array_elements_text(g.queued) q), 'なし') || '）は重複して出さないでください。'
           || '見つからないときは contribution_type=no_change、outcome=not_found、checked_urls に探した場所を入れて報告してください（推測や他人の公約の流用をしない）。',
         ARRAY[g.lg_name || ' 選挙管理委員会（過去の選挙公報・選挙記録）', 'ウェイバックマシンに残る当時の候補者の公式サイト', '国立国会図書館 WARP（過去の自治体サイトの保存）',
               g.lg_name || ' の広報誌・議会だより', g.pref_name || ' 選挙管理委員会']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_term_policies IS
  '任期中の首長の当選時公約の往回補（正見 term_policies の日本版）：公開済みの任期（politician_offices）の元になった当選の参選に、公開済みの政見が 1 件もなく、同じ団体・同じ職位に開いている選挙がある → term_policy_missing 任務'
  '（1 参選 1 件、task_id＝auto:term_policy_missing:<参選紀錄 id>、target.election_id は開いている選挙・過去の選挙は term_election_id）。在任中の人が先、lookback_years・deep_kinds・election_types は規則の params。窓（enabled・chain gate）は総表が決める';

-- ------------------------------------------------------------
-- 3. 臂名清單・総表・層内順位：20261011180000 の版に 名前 2 つ／UNION 2 行／WHEN 1 行を足しただけ（残りは一字も変えない）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY[
    'manual_visitor',
    'manual_open',
    'election_discovery',
    'local_government_missing',
    'regional_stats_missing',
    'roster_check',
    'profile_gap',
    'profile_detail_gap',
    'policy_missing',
    'candidate_status_stale',
    'not_running',
    'withdrawn_filing',
    'candidacy_source_missing',
    'election_results',
    'elected_missing',
    'policy_elements',
    'district_seats',
    'duplicate_policy',
    'mayor_policies',
    'term_policies'
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
  UNION ALL SELECT 'roster_check' AS arm, t.* FROM policy_jp.contribution_auto_tasks_roster_check() t
  UNION ALL SELECT 'profile_gap' AS arm, t.* FROM policy_jp.contribution_auto_tasks_profile_gap() t
  UNION ALL SELECT 'profile_detail_gap' AS arm, t.* FROM policy_jp.contribution_auto_tasks_profile_detail_gap() t
  UNION ALL SELECT 'policy_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_policy_missing() t
  UNION ALL SELECT 'candidate_status_stale' AS arm, t.* FROM policy_jp.contribution_auto_tasks_candidate_status_stale() t
  UNION ALL SELECT 'not_running' AS arm, t.* FROM policy_jp.contribution_auto_tasks_not_running() t
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_withdrawn_filing() t
  UNION ALL SELECT 'candidacy_source_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_candidacy_source_missing() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM policy_jp.contribution_auto_tasks_election_results() t
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_elected_missing() t
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM policy_jp.contribution_auto_tasks_policy_elements() t
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM policy_jp.contribution_auto_tasks_district_seats() t
  UNION ALL SELECT 'duplicate_policy' AS arm, t.* FROM policy_jp.contribution_auto_tasks_duplicate_policy() t
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM policy_jp.contribution_auto_tasks_mayor_policies() t
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM policy_jp.contribution_auto_tasks_term_policies() t
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


CREATE OR REPLACE FUNCTION policy_jp.chain_step_rank(p_task_id TEXT, p_task_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE
           WHEN p_task_id IS NULL OR p_task_id NOT LIKE 'auto:%' THEN 0
           ELSE CASE p_task_type
                  WHEN 'election_discovery' THEN 1
                  WHEN 'local_government_missing' THEN 2
                  WHEN 'regional_stats_missing' THEN 3
                  WHEN 'roster_check' THEN 4
                  WHEN 'profile_gap' THEN 5
                  WHEN 'profile_detail_gap' THEN 5
                  WHEN 'policy_missing' THEN 6
                  WHEN 'candidate_status_stale' THEN 4
                  WHEN 'not_running_recheck' THEN 4
                  WHEN 'candidacy_source_missing' THEN 4
                  WHEN 'election_result_missing' THEN 7
                  WHEN 'policy_elements_missing' THEN 8
                  WHEN 'district_seats_missing' THEN 4
                  WHEN 'duplicate_policy' THEN 8
                  WHEN 'term_policy_missing' THEN 8
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／candidate_status_stale／not_running_recheck／candidacy_source_missing／district_seats_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing／duplicate_policy／term_policy_missing 8。登録のない auto 型別は 9';


-- ------------------------------------------------------------
-- 4. 規則（enabled・既定）と優先層（冪等）
-- ------------------------------------------------------------
-- mayor_policies：窓＝常時。candidacy が済んでから（その選挙に表明者が出たら 1 件ずつ）、止まっていても告示日の翌日（選挙公報が出る日）には開く。同時に最大 100 件、満足は 5 件
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, after_step, params, note)
SELECT 'mayor_policies', 'always', 'announced', 'candidacy',
       '{"cap":100,"max_policies":5,"election_types":["governor","mayor","ward_mayor","town_mayor"],"chain_fallback":{"kind":"announced","offset":1}}'::JSONB,
       '首長候補の公約補充（正見 mayor_policies）：開いている首長選挙で declared／filed の人の、この選挙の公約が 1 件以上 5 件未満のとき、あと何件探すかを示して policy を提出させる（0 件は policy_missing）。その選挙に表明者が出たら 1 件ずつ開き、止まっていても告示日の翌日には開く。同時に開くのは最大 100 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'mayor_policies' AND r.priority IS NULL);

-- term_policies：窓＝常時。第 1 歩（団体・地域統計）が済んでから、止まっていても告示日には開く。10 年遡り、都道府県・政令市・中核市・市だけ（町村は往回補しない）
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, after_step, params, note)
SELECT 'term_policies', 'always', 'announced', 'regional_stats',
       '{"cap":100,"lookback_years":10,"deep_kinds":["prefecture","designated_city","core_city","city"],"election_types":["governor","mayor","ward_mayor","town_mayor"],"chain_fallback":{"kind":"announced","offset":0}}'::JSONB,
       '任期中の首長の当選時公約の往回補（正見 term_policies）：開いている選挙と同じ団体・職位の、過去 10 年の任期の元になった当選の参選に公約が 1 件もないとき、当時の公約を探させる。第 1 歩（団体・地域統計）が済んでから、止まっていても告示日には開く。町村は往回補しない。同時に開くのは最大 100 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'term_policies' AND r.priority IS NULL);

-- 優先層：mayor_policies は policy_missing と同じ（前 60 日以内＝前段、181 日以上前＝後段、その間は既定の中段）；term_policies は後段（過去の補完は新しい選挙の仕事より先に派さない）
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT a.activity, 'event', a.from_kind, a.from_offset, a.until_kind, a.until_offset, a.tier, a.note
  FROM (VALUES
    ('priority:mayor_policies', 'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 日以内の首長候補の公約補充（最近の選挙を先に派す）'),
    ('priority:mayor_policies', NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の首長候補の公約補充；61～180 日は既定の層（中段）')
  ) AS a(activity, from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority = a.tier);

INSERT INTO policy_jp.activity_rules (activity, window_kind, priority, note)
SELECT 'priority:term_policies', 'always', 3, '後段：過去の任期の公約の往回補は歴史の補完（新しい選挙の仕事より先に派さない）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:term_policies' AND r.priority = 3);

-- 主控台時間軸の段：mayor_policies は告示日起算＝第 3 段（policy_missing と同じ）、term_policies は第 1 歩のあとすぐ開くので第 1 段。規則は常時窓なので、この登記が採用される
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('mayor_policies', 3, '首長候補の公約補充（告示後）'),
  ('term_policies', 1, '過去の任期の公約の往回補（団体・統計が済んだあと）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 5. 權限（新函式は PUBLIC に実行権が付くので明示的に収回）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_mayor_policies(), policy_jp.contribution_auto_tasks_term_policies()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_mayor_policies(), policy_jp.contribution_auto_tasks_term_policies()
  TO service_role;

-- ------------------------------------------------------------
-- 6. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  -- 規則：存在、開いている、常時窓、鎖にぶら下がる（after_step）＋後備＋cap
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'mayor_policies' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'always'
                    AND r.after_step = 'candidacy' AND r.params ? 'chain_fallback' AND r.params ? 'cap' AND r.params ? 'max_policies'
                    AND jsonb_typeof(r.params->'election_types') = 'array' AND jsonb_array_length(r.params->'election_types') > 0) THEN
    RAISE EXCEPTION 'policy_jp：mayor_policies の規則が「開いている・常時窓・candidacy の後・chain_fallback／cap／max_policies／election_types あり」になっていない';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'term_policies' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'always'
                    AND r.after_step = 'regional_stats' AND r.params ? 'chain_fallback' AND r.params ? 'cap' AND r.params ? 'lookback_years'
                    AND jsonb_typeof(r.params->'deep_kinds') = 'array' AND jsonb_array_length(r.params->'deep_kinds') > 0
                    AND jsonb_typeof(r.params->'election_types') = 'array' AND jsonb_array_length(r.params->'election_types') > 0) THEN
    RAISE EXCEPTION 'policy_jp：term_policies の規則が「開いている・常時窓・regional_stats の後・chain_fallback／cap／lookback_years／deep_kinds／election_types あり」になっていない';
  END IF;
  IF (SELECT count(*) FROM policy_jp.activity_rules r WHERE r.activity = 'priority:mayor_policies' AND r.priority IN (1, 3)) <> 2
     OR (SELECT count(*) FROM policy_jp.activity_rules r WHERE r.activity = 'priority:term_policies' AND r.priority = 3) <> 1
     OR (SELECT count(*) FROM policy_jp.activity_rules r WHERE r.activity IN ('priority:mayor_policies', 'priority:term_policies')) <> 3 THEN
    RAISE EXCEPTION 'policy_jp：priority:mayor_policies（前段・後段）／priority:term_policies（後段）の規則が揃っていない';
  END IF;
  -- 三處一起加
  IF NOT ('mayor_policies' = ANY (policy_jp.activity_arm_names())) OR NOT ('term_policies' = ANY (policy_jp.activity_arm_names())) THEN
    RAISE EXCEPTION 'policy_jp：activity_arm_names() に mayor_policies／term_policies がない';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_mayor_policies()%'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_term_policies()%') <> 1 THEN
    RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 総表に mayor_policies／term_policies の分支がない';
  END IF;
  IF policy_jp.chain_step_rank('auto:term_policy_missing:x', 'term_policy_missing') <> 8
     OR policy_jp.chain_step_rank('auto:policy_missing:x', 'policy_missing') <> 6
     OR policy_jp.chain_step_rank('auto:duplicate_policy:x:y', 'duplicate_policy') <> 8
     OR policy_jp.chain_step_rank('auto:something_new:x', 'something_new') <> 9 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank の登録がおかしい';
  END IF;
  IF (SELECT count(*) FROM policy_jp.console_arm_stage_map m WHERE (m.arm, m.stage) IN (('mayor_policies', 3), ('term_policies', 1))) <> 2 THEN
    RAISE EXCEPTION 'policy_jp：console_arm_stage_map に mayor_policies（3）／term_policies（1）がない';
  END IF;
  -- 新しい交件型別は作らない：policy で答える
  IF NOT ('policy' = ANY (policy_jp.apply_types())) THEN RAISE EXCEPTION 'policy_jp：apply_types() に policy がない'; END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_mayor_policies()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_term_policies()', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：首長の公約の臂を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
