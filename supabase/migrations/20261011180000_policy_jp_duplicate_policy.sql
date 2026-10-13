-- 日本站派工臂對齊正見：重複政見清查（duplicate_policy）と交件型別 removal。工作單 Yooliang/policy-ops#95、計畫 policy-jp docs/PLAN-arms-parity.md 第 2c 步
-- ============================================================
--
--   正見臂                    日本臂（activity）  任務型別（task_type）   task_id                                                  交件
--   duplicate_policy          duplicate_policy   duplicate_policy        auto:duplicate_policy:<参選紀錄 id>:<清單指紋 md5 32 字>   removal（あいまいな方を取り除く）／no_change（重複なし・outcome=confirmed）
--
--   正見：migration 20260921000004_duplicate_policy.sql（臂・清單指紋）、_shared/contribution-schema.ts の removal、apply-contribution.ts の removal（policies は removed_at の軟移除）、
--         public/skill-types.md「duplicate_policy」「removal」。
--   日本站のちがい：
--     ・正見の単位は「一人」、日本は「一人の一回の参選」（policy_jp.policies は politician_election_id に掛かる公約）。清單＝その参選の公開済み公約が 2 件以上。
--     ・policies に removed_at がない。軟移除は review_status = 'rejected'（公開読みは published だけなので画面から消え、行は残る）。子表（policy_elements・tracking_logs）は何も消さない。
--     ・正見は「査完済み」を表 policy_dupe_reviews に持つが、日本は task_checks（no_change の outcome=confirmed）を使う：同じ指紋の confirmed は永久（清單が変われば指紋が変わり、また開く）。
--
-- この支でやること：
-- 1. 臂 contribution_auto_tasks_duplicate_policy()：総表に一行 UNION、activity_arm_names() に名前、activity_rules に規則を 1 条（**enabled = false＝預設關**）。
--    開くとき：UPDATE policy_jp.activity_rules SET enabled = true WHERE activity = 'duplicate_policy' AND priority IS NULL（走 migration）。
--    窓＝常時（always）、after_step なし（選挙鎖の段に依存しない：公約が 2 件ある参選なら、どの段でも比べられる）。params：cap＝同時に開く最大件数（20）。
--    優先層：後段（tier 3）1 条（整理の仕事なので、候補者・公約を集める鎖の仕事より先に派さない）。主控台の段＝3。chain_step_rank＝8（policy_elements_missing と同じ、未登録の 9 より前）。
-- 2. 交件型別 removal：DB CHECK（policy_jp_contributions_type_check）、apply_types()、落庫 apply_removal()、apply_contribution に WHEN 1 行。
--    payload：target_table（'policies' だけ）、target_id（取り除く政見 id）、reason（20 字以上）、keep_id（任意：残す政見。付けたら同じ参選の別の公開済み政見であること）。
--    公開済み → review_status='rejected' ＋ edit_history（'*' に旧行・新行、agent_name='auto-apply'）。すでに rejected → unchanged。pending／not_found／存在しない → invalid。何も消さない（edit_history から戻せる）。
-- 3. 共識：contribution_needs_two_ips は removal を最初から列挙（20261009130000、正見複本）、contribution_required_agree は ELSE の normal（目標 3・退件 −3）、system_vote_eligible は removal を含まない
--    ＝この支では共識関数を一字も変えない（TS _shared/jp/consensus.ts は型別を足すだけ）。
-- 4. 同一件事（#521）：removal は登記表の型別ではなく、claimKey 併票の型別（duplicate-claim.ts の DUPLICATE_ELIGIBLE_TYPES、鍵＝target_id）。correction／no_change と同じ扱い＝この支は same_claim_matches を触らない。
--
-- 設計の判斷：
-- a. 指紋＝その参選の公開済み公約を id 順に並べた [id, title, description] の jsonb 配列の md5（32 字）。公約の追加・編集・取り下げで指紋が変わり、任務が出直す。
-- b. 派さない条件：(1) その清單の公約を対象にした removal が pending／verified／disputed／apply_failed のどれかで審議中。(2) この task_id（＝この指紋）の no_change が confirmed で記録済み＝永久。
--    (3) task_unavailable()（飽和・no_change 等票・not_found／unreachable／confirmed の冷却）。not_found と unreachable は通常の冷却で戻る（2 日／14 日）。
-- c. 開いている選挙（chain_open_elections、公開済み）の公開済みの参選・人物・選挙だけを見る。
-- d. 任務の收回：removal が applied になれば contributions_drop_dispatch が派工列を落とし、指紋が変わるので臂も出さなくなる（filled）。
--
-- 守門：supabase/functions/_shared/policy-jp-duplicate-policy.test.ts、policy-jp-dispatch-drift.test.ts（登記）、same-claims.test.ts、jp/contribution-schema*.test.ts。
-- 不碰 public、ditrust。冪等（規則は NOT EXISTS）、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 交件型別 removal：DB CHECK と落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'no_change']::TEXT[]
$$;

-- ------------------------------------------------------------
-- 2. 落庫 apply_removal（正見 applyRemoval の日本版：政見だけ、軟移除は review_status = 'rejected'）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_removal(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_table TEXT := p->>'target_table';
  v_id TEXT := NULLIF(policy_jp.policy_trim(p->>'target_id'), '');
  v_keep TEXT := NULLIF(policy_jp.policy_trim(p->>'keep_id'), '');
  pl policy_jp.policies%ROWTYPE;
  kp policy_jp.policies%ROWTYPE;
  v_new policy_jp.policies%ROWTYPE;
  v_politician_id TEXT;
BEGIN
  IF v_table IS DISTINCT FROM 'policies' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('removal で取り除けるのは policies（政見）だけ（target_table=%s）', COALESCE(v_table, '未指定')));
  END IF;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'target_id がない（取り除く政見の id）');
  END IF;
  IF char_length(policy_jp.policy_trim(p->>'reason')) < 20 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'reason は 20 字以上（なぜ取り除くか）');
  END IF;
  SELECT * INTO pl FROM policy_jp.policies WHERE id = v_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('政見 %s は登録されていない', v_id));
  END IF;
  IF pl.review_status = 'rejected' THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'policies', 'record_id', v_id,
      'message', format('政見「%s」はすでに取り除かれている', pl.title));
  END IF;
  IF pl.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('政見 %s は公開されていない（%s）ので removal の対象にならない', v_id, pl.review_status));
  END IF;
  -- 残す方（keep_id）は任意。付けたら、違う政見で、公開済みで、同じ参選のもの（重複の相手として筋が通る）
  IF v_keep IS NOT NULL THEN
    IF v_keep = v_id THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'keep_id と target_id が同じ：残す政見と取り除く政見は別のもの');
    END IF;
    SELECT * INTO kp FROM policy_jp.policies WHERE id = v_keep;
    IF NOT FOUND OR kp.review_status <> 'published' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('keep_id %s は登録されていないか、公開されていない', v_keep));
    END IF;
    IF kp.politician_election_id IS DISTINCT FROM pl.politician_election_id THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('keep_id %s は同じ参選の政見ではない', v_keep));
    END IF;
  END IF;

  UPDATE policy_jp.policies SET review_status = 'rejected', updated_at = now() WHERE id = v_id RETURNING * INTO v_new;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('policies', v_id, '*', to_jsonb(pl), to_jsonb(v_new), c.id, 'auto-apply');
  -- 出典は任意（取り除く理由が本体）。あれば取り除いた政見に掛けておく（確かめたページの記録）
  IF cardinality(COALESCE(c.source_urls, '{}'::TEXT[])) > 0 THEN
    PERFORM policy_jp.source_write('policies', v_id, c.source_urls, 'removal');
  END IF;
  SELECT pe.politician_id INTO v_politician_id FROM policy_jp.politician_elections pe WHERE pe.id = pl.politician_election_id;
  UPDATE policy_jp.contributions SET applied_policy_id = v_id, applied_politician_id = v_politician_id WHERE id = c.id;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'policies', 'record_id', v_id,
    'message', format('政見「%s」を取り除いた（review_status=rejected、行は残る）%s', pl.title,
                      CASE WHEN v_keep IS NOT NULL THEN format('；残す政見：%s', v_keep) ELSE '' END));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_removal IS
  'removal 交件の落庫（正見 applyRemoval の日本版）：政見 1 件の軟移除（review_status を rejected に。行も子表も消さない）。公開済みだけ、すでに rejected は unchanged、それ以外は invalid。'
  'keep_id（任意）は同じ参選の別の公開済み政見。履歴は edit_history（旧行・新行）から戻せる';

-- 落庫主函式：20261011170000 の版に removal の WHEN を 1 行足しただけ（残りは一字も変えない）
CREATE OR REPLACE FUNCTION policy_jp.apply_contribution(p_id UUID, p_retry BOOLEAN DEFAULT false) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  c policy_jp.contributions%ROWTYPE;
  v_blocker TEXT;
  v_out JSONB;
  v_err TEXT;
  v_count INTEGER;
  v_msg TEXT;
BEGIN
  SELECT * INTO c FROM policy_jp.contributions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF NOT (c.status = 'verified'
          OR (p_retry AND c.status = 'apply_failed' AND c.retry_count < policy_jp.apply_max_retries() AND c.next_retry_at IS NOT NULL AND c.next_retry_at <= now())) THEN
    RETURN jsonb_build_object('status', 'skipped', 'contribution_status', c.status);
  END IF;
  IF NOT (c.contribution_type = ANY (policy_jp.apply_types())) THEN
    RETURN jsonb_build_object('status', 'unsupported', 'contribution_type', c.contribution_type);
  END IF;
  v_blocker := policy_jp.apply_blocker(c.contribution_type, c.payload);
  IF v_blocker IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'waiting', 'reason', v_blocker, 'message', '外鍵指到的團體還沒落庫，等它進來再落（貢獻維持 ' || c.status || '）：' || v_blocker);
  END IF;

  BEGIN
    v_out := CASE c.contribution_type
               WHEN 'local_government' THEN policy_jp.apply_local_government(c)
               WHEN 'regional_stat' THEN policy_jp.apply_regional_stat(c)
               WHEN 'election' THEN policy_jp.apply_election(c)
               WHEN 'candidacy' THEN policy_jp.apply_candidacy(c)
               WHEN 'politician' THEN policy_jp.apply_politician(c)
               WHEN 'policy' THEN policy_jp.apply_policy(c)
               WHEN 'policy_elements' THEN policy_jp.apply_policy_elements(c)
               WHEN 'district_seats' THEN policy_jp.apply_district_seats(c)
               WHEN 'removal' THEN policy_jp.apply_removal(c)
               ELSE policy_jp.apply_no_change(c)
             END;
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    v_count := c.retry_count + 1;
    IF v_count >= policy_jp.apply_max_retries() THEN
      -- 連續失敗：不硬建，退件；缺口還在，派工佇列之後會重新派出去（正見 auto-apply.ts 的 GAP_RETURNS）
      UPDATE policy_jp.contributions SET status = 'rejected', retry_count = v_count, last_error = v_err, next_retry_at = NULL,
             review_notes = '[auto] 落庫連續 ' || v_count || ' 次失敗，退件：' || v_err || '。這筆不落庫；缺口會回到任務佇列，由之後的任務重新查一次',
             reviewed_by = 'auto-apply', reviewed_at = now()
       WHERE id = c.id;
      RETURN jsonb_build_object('status', 'rejected', 'message', v_err, 'retry_count', v_count);
    END IF;
    UPDATE policy_jp.contributions SET status = 'apply_failed', retry_count = v_count, last_error = v_err,
           next_retry_at = now() + make_interval(mins => policy_jp.apply_retry_delay_minutes()),
           review_notes = '[auto] 落庫失敗（第 ' || v_count || ' 次，' || policy_jp.apply_retry_delay_minutes() || ' 分鐘後重試）：' || v_err,
           reviewed_by = 'auto-apply', reviewed_at = now()
     WHERE id = c.id;
    RETURN jsonb_build_object('status', 'apply_failed', 'message', v_err, 'retry_count', v_count);
  END;

  v_msg := v_out->>'message';
  IF v_out->>'outcome' IN ('conflict', 'invalid') THEN
    UPDATE policy_jp.contributions SET status = 'rejected', last_error = NULL, next_retry_at = NULL,
           review_notes = '[auto] ' || v_msg || '。這筆不落庫；缺口會回到任務佇列，由之後的任務重新查一次',
           reviewed_by = 'auto-apply', reviewed_at = now()
     WHERE id = c.id;
    RETURN jsonb_build_object('status', 'rejected', 'outcome', v_out->>'outcome', 'message', v_msg);
  END IF;
  -- applied／unchanged：狀態轉 applied 會觸發 contributions_drop_dispatch，自動缺口的派工列立刻收回
  UPDATE policy_jp.contributions SET status = 'applied', applied_at = now(), last_error = NULL, next_retry_at = NULL,
         review_notes = '[auto] ' || v_msg, reviewed_by = 'auto-apply', reviewed_at = now()
   WHERE id = c.id;
  RETURN jsonb_build_object('status', 'applied', 'outcome', v_out->>'outcome', 'message', v_msg, 'table_name', v_out->>'table_name', 'record_id', v_out->>'record_id');
END;
$$;


-- ------------------------------------------------------------
-- 3. 臂：duplicate_policy（同じ参選の公開済み公約が 2 件以上ある清單を、代理が読み比べる）
-- ------------------------------------------------------------
-- 規則（activity_rules「duplicate_policy」）の params.cap だけ読む。窓の開閉（enabled）は総表が決める
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_duplicate_policy()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'duplicate_policy' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  lists AS MATERIALIZED (
    -- 清單＝その参選の公開済み公約（id 順）。指紋＝[id, title, description] の配列の md5
    SELECT pl.politician_election_id AS pe_id, count(*)::INTEGER AS n,
           array_agg(pl.id ORDER BY pl.id) AS ids,
           md5(jsonb_agg(jsonb_build_array(pl.id, pl.title, pl.description) ORDER BY pl.id)::TEXT) AS fp,
           jsonb_agg(jsonb_build_object('id', pl.id, 'title', pl.title, 'description', pl.description, 'category', pl.category,
                                        'source_url', (SELECT s.url FROM policy_jp.source_refs sr JOIN policy_jp.sources s ON s.id = sr.source_id
                                                        WHERE sr.target_table = 'policies' AND sr.target_id = pl.id
                                                        ORDER BY (sr.role = 'primary') DESC, sr.created_at, s.id LIMIT 1))
                     ORDER BY pl.id) AS policies
      FROM policy_jp.policies pl
     WHERE pl.review_status = 'published' AND pl.politician_election_id IS NOT NULL
     GROUP BY pl.politician_election_id
    HAVING count(*) >= 2
  ),
  cand AS MATERIALIZED (
    SELECT l.pe_id, l.n, l.ids, l.fp, l.policies,
           pp.id AS politician_id, pp.name,
           e.id AS election_id, e.name AS election_name, e.election_type, e.election_date, e.lg_code, g.name AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), '（都道府県名未確認）') AS pref_name,
           'auto:duplicate_policy:' || l.pe_id || ':' || l.fp AS task_id
      FROM lists l
      JOIN policy_jp.politician_elections pe ON pe.id = l.pe_id AND pe.review_status = 'published'
      JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
      JOIN policy_jp.chain_open_elections o ON o.election_id = pe.election_id AND o.basis = 'published'
      JOIN policy_jp.elections e ON e.id = pe.election_id AND e.review_status = 'published'
      JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
  ),
  gaps AS (
    SELECT c.*
      FROM cand c CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL
       -- もう誰かがこの清單の政見に removal を出して、票待ち・自動再試行中：先に派さない（退件されれば戻る）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions x
                        WHERE x.contribution_type = 'removal' AND x.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                          AND x.payload->>'target_id' = ANY (c.ids))
       -- この指紋で「重複なし」と確認済み：永久（清單が変われば指紋が変わって出直す）。not_found／unreachable は task_unavailable の冷却で戻る
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = c.task_id AND tc.outcome = 'confirmed')
       AND NOT policy_jp.task_unavailable(c.task_id)
     ORDER BY c.election_date, c.pe_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT g.task_id, 'duplicate_policy',
         jsonb_build_object('politician_election_id', g.pe_id, 'politician_id', g.politician_id, 'name', g.name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'lg_code', g.lg_code, 'lg_name', g.lg_name, 'policies_count', g.n, 'fingerprint', g.fp, 'policies', g.policies,
                            'chain_lg_code', g.lg_code),
         g.name || '（' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）の公約が ' || g.n || ' 件、公開されています（target.policies に全件が入っています）。'
           || 'この人のこの選挙の公約を全部読み比べて、「同じ約束が二重に記録されている」組み合わせがないか確かめます。'
           || '判断の基準：言い換えただけで同じ約束なら重複です。同じ分野でも、対象・数字・場所・期限が違えば別の約束で、重複ではありません。'
           || '選挙公報の「大きな公約 N 本」を N 件に分けて記録しているのも重複ではありません。空泛な一件（「まちを元気にする」）と具体的な一件（「商店街の空き店舗に補助を出す」）が同じことを指しているなら重複です。'
           || '重複が見つかったら、具体的で確かめやすい方を残し、あいまいな方について contribution_type=removal で提出します：'
           || 'payload は target_table（policies）・target_id（取り除く方の政見 id）・reason（20 字以上：残す方の政見 id を書き、なぜ同じ約束か、なぜそちらを残すかを説明）・keep_id（残す方の政見 id、付けてください）。'
           || 'source_urls には両方の原文など、確かめたページを入れます。取り除く方にしかない具体的な情報があるなら、先に correction で残す方へ足してから removal します。'
           || '取り除かれた政見は画面から消えますが、行は残り、履歴から戻せます。'
           || '重複がなければ contribution_type=no_change、outcome=confirmed、task_id（' || g.task_id || '）で報告します。finding には実際に比べた組み合わせを書きます（「重複なし」とだけ書いても確認したことになりません）。',
         ARRAY[
           'target.policies が清單そのものです（別に探す必要はありません）',
           '各政見の source_url：同じ発表・同じ文書の同じ箇所かを開いて確かめる',
           g.lg_name || ' 選挙管理委員会の選挙公報',
           '候補者本人の公式サイト・公式パンフレット'
         ]::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_duplicate_policy IS
  '重複政見の清査（正見 duplicate_policy の日本版）：開いている選挙（chain_open_elections）の公開済みの参選で、公開済みの公約が 2 件以上ある清單 → duplicate_policy 任務'
  '（1 参選 1 件、task_id＝auto:duplicate_policy:<参選紀錄 id>:<清單指紋>、target.policies は清單全件）。清單の政見への removal が審議中、この指紋で no_change confirmed 済み（永久）なら派さない。'
  '窓（規則の enabled）は総表が決める＝預設關。params.cap は可派の前 N 件（投票日の近い順）';


-- ------------------------------------------------------------
-- 4. 臂名清單・総表・層内順位：20261011170000 の版に 名前 1 つ／UNION 1 行／WHEN 1 行を足しただけ（残りは一字も変えない）
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
    'duplicate_policy'
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
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／candidate_status_stale／not_running_recheck／candidacy_source_missing／district_seats_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing／duplicate_policy 8。登録のない auto 型別は 9';


-- ------------------------------------------------------------
-- 5. 規則（預設關）と優先層（冪等）
-- ------------------------------------------------------------
-- 窓＝常時、after_step なし。min_status='announced'：投票日が告示済み以上の選挙だけ。同時に開くのは最大 20 件。預設は閉じている（enabled=false）
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, enabled, params, note)
SELECT 'duplicate_policy', 'always', 'announced', false,
       '{"cap":20}'::JSONB,
       '重複政見の清査（正見 duplicate_policy）：同じ参選の公開済み公約が 2 件以上あるとき、代理が読み比べて、同じ約束の二重記録はあいまいな方を removal で取り除く（なければ no_change）。預設は閉じている（enabled=false）。開くときは UPDATE policy_jp.activity_rules SET enabled = true。同時に開くのは最大 20 件（投票日の近い選挙が先）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'duplicate_policy' AND r.priority IS NULL);

-- 優先層：後段（整理の仕事なので、候補者・公約を集める鎖の仕事より先に派さない）
INSERT INTO policy_jp.activity_rules (activity, window_kind, priority, note)
SELECT 'priority:duplicate_policy', 'always', 3, '後段：重複政見の清査は整理の仕事（候補者・公約を集める鎖の仕事より先に派さない）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:duplicate_policy' AND r.priority = 3);

-- 主控台時間軸の段（告示日起算＝第 3 段。policy_missing・policy_elements と同じ。規則は常時窓なので、この登記が採用される）
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('duplicate_policy', 3, '重複政見の清査（告示後）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 6. 權限（新函式は PUBLIC に実行権が付くので明示的に収回）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_duplicate_policy(), policy_jp.apply_removal(policy_jp.contributions)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_duplicate_policy(), policy_jp.apply_removal(policy_jp.contributions)
  TO service_role;

-- ------------------------------------------------------------
-- 7. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  -- 規則：存在、預設關、常時窓、after_step なし、cap あり
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'duplicate_policy' AND r.priority IS NULL AND NOT r.enabled AND r.window_kind = 'always'
                    AND r.after_step IS NULL AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：duplicate_policy の規則が「預設關・常時窓・after_step なし・cap あり」になっていない';
  END IF;
  IF (SELECT count(*) FROM policy_jp.activity_rules r WHERE r.activity = 'priority:duplicate_policy' AND r.priority = 3) <> 1 THEN
    RAISE EXCEPTION 'policy_jp：priority:duplicate_policy（後段）の規則が 1 条ではない';
  END IF;
  -- 三處一起加
  IF NOT ('duplicate_policy' = ANY (policy_jp.activity_arm_names())) THEN
    RAISE EXCEPTION 'policy_jp：activity_arm_names() に duplicate_policy がない';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_duplicate_policy()%') <> 1 THEN
    RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 総表に duplicate_policy の分支がない';
  END IF;
  IF policy_jp.chain_step_rank('auto:duplicate_policy:x:y', 'duplicate_policy') <> 8
     OR policy_jp.chain_step_rank('auto:policy_elements_missing:x', 'policy_elements_missing') <> 8
     OR policy_jp.chain_step_rank('auto:district_seats_missing:x', 'district_seats_missing') <> 4
     OR policy_jp.chain_step_rank('auto:something_new:x', 'something_new') <> 9 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank の登録がおかしい';
  END IF;
  -- 交件型別：DB CHECK と落庫清單
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%removal%') THEN
    RAISE EXCEPTION 'policy_jp：policy_jp_contributions_type_check に removal がない';
  END IF;
  IF NOT ('removal' = ANY (policy_jp.apply_types())) THEN RAISE EXCEPTION 'policy_jp：apply_types() に removal がない'; END IF;
  IF pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_removal%' THEN
    RAISE EXCEPTION 'policy_jp：apply_contribution に removal の WHEN がない';
  END IF;
  -- 共識は動かさない：removal は 2 つの網段・目標 3・系統票なし
  IF NOT policy_jp.contribution_needs_two_ips('removal', '{}'::JSONB)
     OR policy_jp.contribution_required_agree('removal', '{}'::JSONB, ARRAY[]::TEXT[]) <> 3
     OR policy_jp.system_vote_eligible('removal') THEN
    RAISE EXCEPTION 'policy_jp：removal の共識（2 網段・目標 3・系統票なし）が期待と違う';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_duplicate_policy()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_removal(policy_jp.contributions)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：重複政見の関数を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
