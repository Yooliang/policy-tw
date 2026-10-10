-- 日本站「選舉鏈」第 4 步：這次的政見（policy_missing 臂＋policy 交件型別＋落庫＋同一件事）
-- ============================================================
--
-- 計畫：policy-jp docs/PLAN-election-chain.md 第 2 節的第 4 步（任務型別 term_policy_missing／policy_missing、交件型別 policy；
-- 第 3 步完成才開、後備＝告示日翌日〔選挙公報〕）。前提：20261010050000（第 3 步：politician、profile 步驟）。
--
-- 這支做的事（新增鏈上的一步＝election_chain_steps() 加名字＋進度視圖加一段＋規則設 after_step 與後備里程碑＋三處登記）：
-- 1. 步驟清單加 policy（這次的政見）；進度視圖 election_chain_progress 加一段（其餘一字不改）。
-- 2. 派工臂 policy_missing（正見 contribution_auto_tasks_raw 的 policy_missing 的日本版）：開著的、已上線的選舉裡，上線・非退選・已表明參選
--    （declared／filed／elected／not_elected）而一條政見都沒有的參選紀錄，一人一件，task_id＝auto:policy_missing:<參選紀錄 id>。
--    三處一起加：總表加一行 UNION、activity_arm_names() 加名字、activity_rules 種規則（after_step=profile＝第 3 步完成；
--    後備＝告示日翌日；窗口永遠開；cap）。另加優先層規則 priority:policy_missing 與 chain_step_rank 的 WHEN（6）。
-- 3. 交件型別 policy（公約 origin=pledge）：DB CHECK、apply_types()、落庫 apply_policy（寫 policies，掛在 politician_election_id；
--    出處＋履歷；同一參選同標題＝unchanged／內容不同＝conflict）、apply_contribution 多一個 WHEN。共識走 normal（目標 3、退件 −3）。
-- 4. 同一件事（#521 登記表）：policy 登記在 same-claims.ts。精確鍵＝參選紀錄 id ＋ 標題（NFKC 正規化、去掉空白、小寫）。
--    same_claim_matches 的分派器多一個型別（policy → same_claim_matches_policy）、same_claim_same_content 多 policy（說明文正規化後相同）、
--    收編觸發器的型別清單多 policy。
--
-- 設計決定：
-- a. term_policy_missing 這一步不做：日本站的政見直接掛在參選（politician_election_id）上，『這一屆的政見』＝『這次參選的政見』，
--    policy_missing 已涵蓋；舊屆補政見是計畫第 3 節的『往回補』（lookback_years／deep_levels），另一個 PR。
-- b. 「這次的政見」只收公約（origin=pledge）：出處是選挙公報・候補者の公式サイト・政見放送など。議会提案・予算・施政方針（assembly／budget／policy_address）
--    是當選後的施政，屬於『往後接』，這一步不收。status 一律 not_started（投票前）。
-- c. 對象：考慮中（considering）不是公約提出者，不派；退選（withdrawn）不派。
-- d. description 是『要約』：120 字以內（DB CHECK）、只寫事實；TS 驗證 10～120 字。category 是自由文字（1～30 字），日本站沒有固定分類表。
-- e. 「完成」（給第 5 步以後用）：這場選舉至少有一位對象，而且每一位都有一條上線的政見，或該參選的 policy_missing 任務被回報查無（not_found）並在冷卻中。
--
-- 守門：supabase/functions/_shared/policy-jp-chain-policy.test.ts、policy-jp-dispatch-drift.test.ts（登記）、same-claims.test.ts、
-- jp/contribution-schema-chain.test.ts、jp-entry-chain.test.ts。不碰 public、ditrust。

-- ------------------------------------------------------------
-- 1. 步驟清單
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.election_chain_steps() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT ARRAY['discovery', 'local_government', 'regional_stats', 'region', 'roster', 'candidacy', 'profile', 'policy']::TEXT[]
$$;
COMMENT ON FUNCTION policy_jp.election_chain_steps IS '選舉鏈的步驟（election_chain_progress.step 的值）；activity_rules.after_step 只能是這裡的值。加步驟＝改這裡＋視圖多一段';

-- ------------------------------------------------------------
-- 2. 政見の対象（臂と進度視圖が共有する判準）
-- ------------------------------------------------------------
-- 公約の対象になる参選紀錄：上線済み・表明以降（considering・withdrawn は除く）。開いている・上線済みの選挙のものだけ
CREATE OR REPLACE FUNCTION policy_jp.chain_policy_subjects() RETURNS TABLE (
  politician_election_id TEXT, politician_id TEXT, name TEXT, kana TEXT, candidacy_status TEXT, district_kind TEXT, district_name TEXT,
  election_id TEXT, election_name TEXT, election_type TEXT, election_date DATE, notice_date DATE, lg_code TEXT, lg_name TEXT, pref_name TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT pe.id, pe.politician_id, pp.name, pp.kana, pe.candidacy_status, pe.district_kind, pe.district_name,
         e.id, e.name, e.election_type, e.election_date, e.notice_date, e.lg_code,
         COALESCE(g.name, '（名称未確認）'),
         COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), '（都道府県名未確認）')
    FROM policy_jp.chain_open_elections o
    JOIN policy_jp.elections e ON e.id = o.election_id AND o.basis = 'published' AND e.review_status = 'published'
    JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
    JOIN policy_jp.politician_elections pe ON pe.election_id = e.id AND pe.review_status = 'published' AND pe.candidacy_status IN ('declared', 'filed', 'elected', 'not_elected')
    JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
$$;
COMMENT ON FUNCTION policy_jp.chain_policy_subjects IS '公約の対象：開いている・上線済みの選挙の、上線済み・declared／filed／elected／not_elected の参選紀錄（considering・withdrawn は除く）';

-- この参選に上線済みの政見が一条でもあるか
CREATE OR REPLACE FUNCTION policy_jp.chain_policy_exists(p_politician_election_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM policy_jp.policies pl WHERE pl.politician_election_id = p_politician_election_id AND pl.review_status = 'published')
$$;

-- ------------------------------------------------------------
-- 3. 鏈の進度：前一版（20261010050000）の視圖＋policy の一段
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
  ),
  -- 第 2 步 roster：名簿確認過了（roster_check 任務有人回報 confirmed／not_found，還在冷卻中）
  ro AS (
    SELECT o.election_id, o.lg_code, (ck.checked_at IS NOT NULL) AS done, ck.checked_at AS last_at
      FROM oe o
      CROSS JOIN LATERAL (SELECT policy_jp.chain_task_checked('auto:roster_check:' || o.election_id) AS checked_at) ck
  ),
  -- 第 2 步之後的 candidacy：這場選舉至少有一位已表明以上的已上線參選紀錄（considering 與退選不算；逐人的第 3 步靠它開）
  ca AS (
    SELECT o.election_id, o.lg_code, (x.n > 0) AS done, x.last_at
      FROM oe o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, max(pe.created_at) AS last_at FROM policy_jp.politician_elections pe
         WHERE pe.election_id = o.election_id AND pe.review_status = 'published' AND pe.candidacy_status IN ('declared', 'filed', 'elected', 'not_elected')
      ) x
  ),
  -- 第 3 步 profile：這場選舉至少有一位參選人，而且每一位都建檔齊了（缺口なし、または缺口ごとに『查無』が冷卻中）
  pf AS (
    SELECT o.election_id, o.lg_code, (x.n > 0 AND x.n = x.n_done) AS done, x.last_at
      FROM oe o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n, count(*) FILTER (WHERE policy_jp.chain_profile_done(pe.pid)) AS n_done, max(pe.u) AS last_at
          FROM (SELECT pe0.politician_id AS pid, max(pe0.updated_at) AS u FROM policy_jp.politician_elections pe0
                 WHERE pe0.election_id = o.election_id AND pe0.review_status = 'published' AND pe0.candidacy_status <> 'withdrawn'
                 GROUP BY pe0.politician_id) pe
      ) x
  ),
  -- 第 4 步 policy：這場選舉至少有一位公約の対象，而且每一位都有上線の政見（または policy_missing が『查無』で冷卻中）
  pl AS (
    SELECT o.election_id, o.lg_code, (x.n > 0 AND x.n = x.n_done) AS done, x.last_at
      FROM oe o
      CROSS JOIN LATERAL (
        SELECT count(*) AS n,
               count(*) FILTER (WHERE policy_jp.chain_policy_exists(s.id) OR policy_jp.chain_task_checked('auto:policy_missing:' || s.id, ARRAY['not_found']) IS NOT NULL) AS n_done,
               max(s.updated_at) AS last_at
          FROM policy_jp.politician_elections s
         WHERE s.election_id = o.election_id AND s.review_status = 'published' AND s.candidacy_status IN ('declared', 'filed', 'elected', 'not_elected')
      ) x
  )
  SELECT o.election_id, o.lg_code, 'discovery'::TEXT AS step, true AS done, o.since AS done_at FROM oe o
  UNION ALL
  SELECT l.election_id, l.lg_code, 'local_government'::TEXT, l.done, CASE WHEN l.done THEN l.last_at END FROM lg l
  UNION ALL
  SELECT s.election_id, s.lg_code, 'regional_stats'::TEXT, s.done, CASE WHEN s.done THEN s.last_at END FROM st s
  UNION ALL
  SELECT l.election_id, l.lg_code, 'region'::TEXT, l.done AND s.done, CASE WHEN l.done AND s.done THEN GREATEST(l.last_at, s.last_at) END
    FROM lg l JOIN st s ON s.election_id = l.election_id AND s.lg_code = l.lg_code
  UNION ALL
  SELECT r.election_id, r.lg_code, 'roster'::TEXT, r.done, CASE WHEN r.done THEN r.last_at END FROM ro r
  UNION ALL
  SELECT c.election_id, c.lg_code, 'candidacy'::TEXT, c.done, CASE WHEN c.done THEN c.last_at END FROM ca c
  UNION ALL
  SELECT f.election_id, f.lg_code, 'profile'::TEXT, f.done, CASE WHEN f.done THEN f.last_at END FROM pf f
  UNION ALL
  SELECT p.election_id, p.lg_code, 'policy'::TEXT, p.done, CASE WHEN p.done THEN p.last_at END FROM pl p;
COMMENT ON VIEW policy_jp.election_chain_progress IS
  '選舉鏈的進度：開著的選舉×團體×步驟（election_chain_steps()）一列，done＝這一步的缺口都補上了，或回報查無、還在冷卻中。總表の chain_gate 讀它（seed 時算一次）。service_role 用';

-- ------------------------------------------------------------
-- 4. 交件型別 policy：DB CHECK と落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician', 'policy'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'policy', 'no_change']::TEXT[]
$$;

-- 政見の題名の正規化（同一件事の鍵）：NFKC・小文字・空白（全角も）を全部除く
CREATE OR REPLACE FUNCTION policy_jp.policy_title_key(p_title TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT lower(regexp_replace(normalize(COALESCE(p_title, ''), NFKC), '[[:space:]　]+', '', 'g'))
$$;
COMMENT ON FUNCTION policy_jp.policy_title_key IS '政見の題名の正規化（同一件事の鍵）：NFKC・小文字・空白除去。TS 側 _shared/jp/contribution-schema.ts の policyTitleKey と同じ（対齊テスト）';

-- policy 交件の落庫：公約（origin=pledge）を参選に掛けて policies に足す
CREATE OR REPLACE FUNCTION policy_jp.apply_policy(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_peid TEXT := NULLIF(btrim(COALESCE(p->>'politician_election_id', '')), '');
  v_title TEXT := btrim(COALESCE(p->>'title', ''));
  v_desc TEXT := btrim(COALESCE(p->>'description', ''));
  v_cat TEXT := btrim(COALESCE(p->>'category', ''));
  v_loc TEXT := btrim(COALESCE(p->>'source_locator', ''));
  v_proposed DATE;
  pe policy_jp.politician_elections%ROWTYPE;
  e policy_jp.elections%ROWTYPE;
  ex policy_jp.policies%ROWTYPE;
  v_new policy_jp.policies%ROWTYPE;
  v_id TEXT;
  v_src BIGINT;
BEGIN
  IF v_peid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'politician_election_id がない（任務の target.politician_election_id を使う）');
  END IF;
  SELECT * INTO pe FROM policy_jp.politician_elections WHERE id = v_peid;
  IF NOT FOUND OR pe.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('参選 %s は登録されていないか、まだ公開されていない', v_peid));
  END IF;
  SELECT * INTO e FROM policy_jp.elections WHERE id = pe.election_id;
  IF char_length(v_title) NOT BETWEEN 4 AND 100 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'title は 4～100 字');
  END IF;
  IF char_length(v_desc) NOT BETWEEN 10 AND 120 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'description（要約）は 10～120 字（事実だけを短く）');
  END IF;
  IF char_length(v_cat) NOT BETWEEN 1 AND 30 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'category は 1～30 字');
  END IF;
  IF char_length(v_loc) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_locator（原文のどこか：公報の頁・見出し）は 1～200 字で必須');
  END IF;
  IF p ->> 'proposed_date' IS NOT NULL THEN
    IF p ->> 'proposed_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'proposed_date は YYYY-MM-DD');
    END IF;
    BEGIN
      v_proposed := (p ->> 'proposed_date')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'proposed_date が実在しない日付');
    END;
    IF v_proposed NOT BETWEEN DATE '1947-01-01' AND LEAST(e.election_date, policy_jp.activity_today()) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('proposed_date（%s）は 1947 年以降、投票日（%s）と今日のどちらも超えない日付', v_proposed, e.election_date));
    END IF;
  END IF;

  v_src := policy_jp.source_write(NULL, NULL, c.source_urls, 'policy');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  -- 同じ参選・同じ題名（正規化）の政見が既にあるか
  SELECT * INTO ex FROM policy_jp.policies pl
   WHERE pl.politician_election_id = v_peid AND policy_jp.policy_title_key(pl.title) = policy_jp.policy_title_key(v_title)
   ORDER BY pl.created_at, pl.id LIMIT 1;
  IF FOUND THEN
    IF policy_jp.policy_title_key(ex.description) <> policy_jp.policy_title_key(v_desc) OR ex.review_status IN ('rejected', 'not_found') THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'policies', 'record_id', ex.id,
        'message', format('庫に同じ題名の政見 %s があり、要約が違う（または退回済み）。上書きしない（直すなら correction）', ex.id));
    END IF;
    PERFORM policy_jp.source_write('policies', ex.id, c.source_urls, 'policy');
    UPDATE policy_jp.contributions SET applied_policy_id = ex.id, applied_politician_id = pe.politician_id WHERE id = c.id;
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'policies', 'record_id', ex.id, 'message', format('政見 %s は庫に同じ内容で既にある', ex.id));
  END IF;

  v_id := gen_random_uuid()::TEXT;
  INSERT INTO policy_jp.policies (id, title, description, category, origin, source_locator, politician_election_id, lg_code, status, proposed_date, last_updated, review_status)
  VALUES (v_id, v_title, v_desc, v_cat, 'pledge', v_loc, v_peid, e.lg_code, 'not_started', v_proposed, policy_jp.activity_today(), 'published')
  RETURNING * INTO v_new;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('policies', v_id, '*', NULL, to_jsonb(v_new), c.id, 'auto-apply');
  PERFORM policy_jp.source_write('policies', v_id, c.source_urls, 'policy');
  UPDATE policy_jp.contributions SET applied_policy_id = v_id, applied_politician_id = pe.politician_id WHERE id = c.id;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'policies', 'record_id', v_id, 'message', format('公約を追加：%s（参選 %s）', v_title, v_peid));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_policy IS
  'policy 交件の落庫（公約 origin=pledge を参選に掛けて policies へ）。同じ参選・同じ題名（正規化）＝unchanged（要約が違えば conflict）、不備＝invalid。status は not_started、出処と履歴を残す';

-- 落庫主函式：20261010050000 の版に policy の WHEN を 1 行足しただけ（残りは一字も変えない）
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
-- 5. 臂：policy_missing（鏈の第 4 歩：公約が一条もない参選）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_policy_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'policy_missing' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*,
           -- 審議中の公約の題名（重複して出さないため。正見の queued_policies）
           COALESCE((SELECT jsonb_agg(DISTINCT c.payload->>'title') FROM policy_jp.contributions c
                      WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                        AND c.payload->>'politician_election_id' = s.politician_election_id), '[]'::JSONB) AS queued
      FROM policy_jp.chain_policy_subjects() s CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND NOT policy_jp.chain_policy_exists(s.politician_election_id)
       AND NOT policy_jp.task_unavailable('auto:policy_missing:' || s.politician_election_id)
     ORDER BY s.election_date, s.kana, s.politician_election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:policy_missing:' || g.politician_election_id, 'policy_missing',
         jsonb_build_object('politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name, 'queued_policies', g.queued,
                            'chain_lg_code', g.lg_code, 'chain_step', 'policy'),
         g.name || '（' || g.kana || '、' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）の公約がまだ 1 件も登録されていません。'
           || '選挙公報（選挙管理委員会のページ）・候補者本人の公式サイト・公式な政策パンフレットから、この候補者が掲げた具体的な公約を探してください。'
           || '1 件ずつ contribution_type=policy で提出します（最大 5 件、見つかった数だけ。1 件でも構いません。スローガン・理念・人柄の話は公約ではないので出さない）。'
           || 'payload は politician_election_id（' || g.politician_election_id || '）・title（4～100 字）・description（要約：120 字以内、事実だけ。原文の修辞は写さない）・'
           || 'category（分野、例：子育て・防災・交通）・source_locator（原文のどこか：公報の頁や見出し。必須）・resolved_claim（item.current.same_claims を見て決める。誰も出していなければ "new"）、'
           || '分かれば proposed_date（公約が公表された日）。source_urls はその公約が書かれたページ（選挙公報・候補者の公式サイト）。'
           || '審議中の同じ公約（target.queued_policies：' || COALESCE((SELECT string_agg(q, '、') FROM jsonb_array_elements_text(g.queued) q), 'なし') || '）は重複して出さないでください。'
           || '日付の進め方：告示日は ' || COALESCE(g.notice_date::TEXT, '未記録') || '、選挙公報は告示日以降に出ます。公約が見つからない・まだ公表されていないときは、'
           || 'contribution_type=no_change、outcome=not_found、checked_urls に探した場所を入れて報告してください（推測や他人の公約の流用をしない）。'
           || '得票数・当落の予想は書きません。',
         ARRAY[g.lg_name || ' 選挙管理委員会の選挙公報', '候補者本人の公式サイト・公式パンフレット', g.pref_name || ' 選挙管理委員会', '政党の公認・推薦候補の発表ページ']::TEXT[],
         2, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_policy_missing IS
  '選挙鎖の第 4 歩：開いている選挙の立候補者（declared／filed／elected／not_elected）で公約が 1 件もない参選 → policy_missing 任務（1 参選 1 件、task_id＝auto:policy_missing:<参選紀錄 id>）。審議中の題名を target.queued_policies で渡す。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 6. 同一件事（政見）：same_claim_matches の分派に policy を足し、same_claim_same_content と収編触発器を拡張
-- ------------------------------------------------------------
-- policy：鍵＝参選紀錄 id ＋ 題名の正規化（policy_title_key）。題名がない探査（policy_missing の任務を領いたとき）は、その参選の政見を全部返す
CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches_policy(p JSONB, p_ip_hash TEXT, p_exclude UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_peid TEXT := NULLIF(p->>'politician_election_id', '');
  v_key TEXT := CASE WHEN NULLIF(btrim(COALESCE(p->>'title', '')), '') IS NOT NULL THEN policy_jp.policy_title_key(p->>'title') END;
  v_existing JSONB := '[]'::JSONB;
  v_pending JSONB := '[]'::JSONB;
BEGIN
  IF v_peid IS NULL THEN
    RETURN jsonb_build_object('type', 'policy', 'existing', v_existing, 'pending', v_pending);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', pl.id, 'title', pl.title, 'description', pl.description, 'category', pl.category, 'review_status', pl.review_status,
           'summary', pl.title, 'why', CASE WHEN v_key IS NULL THEN '同じ参選に掛かっている公約' ELSE '同じ参選・同じ題名（空白・全半角・大小文字を無視）' END)
           ORDER BY pl.created_at, pl.id), '[]'::JSONB)
    INTO v_existing
    FROM policy_jp.policies pl
   WHERE pl.politician_election_id = v_peid AND (v_key IS NULL OR policy_jp.policy_title_key(pl.title) = v_key);
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.created_at), '[]'::JSONB) INTO v_pending FROM (
    SELECT c.created_at, jsonb_build_object(
             'contribution_id', c.id, 'status', c.status, 'agent', c.agent_name, 'sources', to_jsonb(c.source_urls),
             'title', c.payload->>'title', 'description', c.payload->>'description', 'category', c.payload->>'category',
             'summary', COALESCE(c.payload->>'title', '?'),
             'yours', p_ip_hash IS NOT NULL AND c.contributor_ip_hash = p_ip_hash,
             'your_network_voted', p_ip_hash IS NOT NULL AND (c.contributor_ip_hash = p_ip_hash
               OR EXISTS (SELECT 1 FROM policy_jp.contribution_votes v WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash))) AS j
      FROM policy_jp.contributions c
     WHERE c.contribution_type = 'policy'
       AND c.status IN ('pending', 'disputed', 'verified', 'apply_failed')
       AND (p_exclude IS NULL OR c.id <> p_exclude)
       AND c.payload->>'politician_election_id' = v_peid
       AND (v_key IS NULL OR policy_jp.policy_title_key(c.payload->>'title') = v_key)
     LIMIT 50
  ) x;
  RETURN jsonb_build_object('type', 'policy', 'existing', v_existing, 'pending', v_pending);
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_matches_policy IS
  '同一件事（policy）：参選紀錄 id ＋ 題名の正規化。題名がない探査ではその参選の政見と審議中の提出を全部返す。same_claim_matches の分派先';

CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches(
  p_type TEXT, p_payload JSONB, p_ip_hash TEXT DEFAULT NULL, p_exclude UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF p_type NOT IN ('election', 'regional_stat', 'local_government', 'politician', 'policy') THEN
    RETURN NULL;
  END IF;
  IF p_type = 'politician' THEN
    RETURN policy_jp.same_claim_matches_politician(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);
  END IF;
  IF p_type = 'policy' THEN
    RETURN policy_jp.same_claim_matches_policy(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);
  END IF;
  RETURN policy_jp.same_claim_matches_base(p_type, p_payload, p_ip_hash, p_exclude);
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_matches IS
  '同一件事（#521）の入口：型別＋payload → {existing:在庫の列, pending:審議中の提出（your_network_voted つき）}；登録のない型別＝NULL。'
  'election／regional_stat／local_government は same_claim_matches_base（20261009280000 の本体）、politician は same_claim_matches_politician、policy は same_claim_matches_policy。TS 登録表 _shared/same-claims.ts';

-- 収編用の「内容が同じか」：20261010050000 の版に policy の WHEN を足しただけ
CREATE OR REPLACE FUNCTION policy_jp.same_claim_same_content(p_type TEXT, a JSONB, b JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_type
    WHEN 'election' THEN (a->>'election_date', a->>'election_type', COALESCE(NULLIF(a->>'election_reason', ''), 'regular'))
                     IS NOT DISTINCT FROM (b->>'election_date', b->>'election_type', COALESCE(NULLIF(b->>'election_reason', ''), 'regular'))
    -- 数値比対は apply_regional_stat と同じ判準（NUMERIC：28.5 と 28.50 は同じ）；数字でないものは同じとみなさない
    WHEN 'regional_stat' THEN jsonb_typeof(a->'value') = 'number' AND jsonb_typeof(b->'value') = 'number'
                              AND (a->>'value')::NUMERIC = (b->>'value')::NUMERIC AND a->>'unit' IS NOT DISTINCT FROM b->>'unit'
    WHEN 'local_government' THEN (a->>'name', a->>'kana', a->>'kind') IS NOT DISTINCT FROM (b->>'name', b->>'kana', b->>'kind')
    -- 政治人物：生年・学歴・経歴が（順序を問わず）同じ
    WHEN 'politician' THEN
      (a->>'birth_year') IS NOT DISTINCT FROM (b->>'birth_year')
      AND COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'education') = 'array' THEN a->'education' ELSE '[]'::JSONB END) t), '[]'::JSONB)
        = COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b->'education') = 'array' THEN b->'education' ELSE '[]'::JSONB END) t), '[]'::JSONB)
      AND COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'career') = 'array' THEN a->'career' ELSE '[]'::JSONB END) t), '[]'::JSONB)
        = COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b->'career') = 'array' THEN b->'career' ELSE '[]'::JSONB END) t), '[]'::JSONB)
    -- 政見：要約が（空白・全半角・大小文字を無視して）同じ（題名は鍵で既に同じ）
    WHEN 'policy' THEN policy_jp.policy_title_key(a->>'description') = policy_jp.policy_title_key(b->>'description') AND NULLIF(btrim(COALESCE(a->>'description', '')), '') IS NOT NULL
    ELSE FALSE
  END
$$;

DROP TRIGGER IF EXISTS contributions_same_claim_supersede ON policy_jp.contributions;
CREATE TRIGGER contributions_same_claim_supersede AFTER UPDATE OF status ON policy_jp.contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NEW.contribution_type IN ('election', 'regional_stat', 'local_government', 'politician', 'policy'))
  EXECUTE FUNCTION policy_jp.same_claim_supersede_trg();

-- ------------------------------------------------------------
-- 7. 臂名清單と総表：20261010050000 の版本に名前 1 つ／UNION 1 行を足しただけ（残りは一字も変えない）
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
    'policy_missing'
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

-- 層内排序の步驟順位：20261010050000 の版に WHEN 1 行（policy_missing＝6）
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
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check 4、profile_gap／profile_detail_gap 5、policy_missing 6。登録のない auto 型別は 9';

-- ------------------------------------------------------------
-- 8. 規則（冪等）
-- ------------------------------------------------------------
-- 窗口は永遠（always）。第 3 歩（profile）が済んでから開く；止まっていても告示日の翌日（選挙公報が出る日）には開く（後備）
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, after_step, params, note)
SELECT 'policy_missing', 'always', 'announced', 'profile', '{"cap":200,"chain_fallback":{"kind":"announced","offset":1}}'::JSONB,
       '選挙鎖の第 4 歩（この選挙の公約）：開いている選挙の立候補者で公約が 1 件もない人を、選挙公報・公式サイトで確かめて policy を提出させる。建檔（第 3 歩）が済んでから開く；止まっていても告示日の翌日（選挙公報が出る日）には開く（後備）。同時に開くのは最大 200 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'policy_missing' AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT a.activity, 'event', a.from_kind, a.from_offset, a.until_kind, a.until_offset, a.tier, a.note
  FROM (VALUES
    ('priority:policy_missing', 'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 日以内の公約任務（最近の選挙を先に派す）'),
    ('priority:policy_missing', NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の公約任務；61～180 日は既定の層（中段）')
  ) AS a(activity, from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority = a.tier);

-- ------------------------------------------------------------
-- 9. 権限
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.chain_policy_subjects(), policy_jp.chain_policy_exists(TEXT), policy_jp.policy_title_key(TEXT),
  policy_jp.apply_policy(policy_jp.contributions), policy_jp.contribution_auto_tasks_policy_missing(), policy_jp.same_claim_matches_policy(JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.chain_policy_subjects(), policy_jp.chain_policy_exists(TEXT), policy_jp.policy_title_key(TEXT),
  policy_jp.apply_policy(policy_jp.contributions), policy_jp.contribution_auto_tasks_policy_missing(), policy_jp.same_claim_matches_policy(JSONB, TEXT, UUID)
  TO service_role;

-- ------------------------------------------------------------
-- 10. 自己検査
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'policy_missing' AND r.priority IS NULL AND r.enabled
                  AND r.after_step = 'profile' AND r.params ? 'chain_fallback' AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：policy_missing の規則に after_step／chain_fallback／cap がない';
  END IF;
  SELECT string_agg(r.activity || '（after_step=' || r.after_step || '）', ', ') INTO bad
    FROM policy_jp.activity_rules r
   WHERE r.after_step IS NOT NULL AND r.after_step <> 'discovery' AND NOT (r.params ? 'chain_fallback');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些鏈上的規則沒有後備里程碑（params.chain_fallback）：%', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%''policy''%') THEN
    RAISE EXCEPTION 'policy_jp：contributions の contribution_type CHECK に policy がない';
  END IF;
  IF NOT ('policy' = ANY (policy_jp.apply_types())) THEN RAISE EXCEPTION 'policy_jp：apply_types() に policy がない'; END IF;
  IF NOT (policy_jp.chain_step_rank('auto:policy_missing:x', 'policy_missing') > policy_jp.chain_step_rank('auto:profile_gap:x', 'profile_gap')) THEN
    RAISE EXCEPTION 'policy_jp：步驟順位は 建檔 < 政見 でなければならない';
  END IF;
  IF policy_jp.same_claim_matches('policy', '{}'::JSONB) IS NULL OR policy_jp.same_claim_matches('politician', '{}'::JSONB) IS NULL
     OR policy_jp.same_claim_matches('election', '{}'::JSONB) IS NULL OR policy_jp.same_claim_matches('candidacy', '{}'::JSONB) IS NOT NULL THEN
    RAISE EXCEPTION 'policy_jp：same_claim_matches の分派が壊れている';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.apply_policy(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_policy_missing()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.chain_policy_subjects()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.same_claim_matches_policy(jsonb, text, uuid)', 'EXECUTE')
     OR has_table_privilege('anon', 'policy_jp.election_chain_progress', 'SELECT') THEN
    RAISE EXCEPTION 'policy_jp：選舉鏈（第 4 步）の関数・ビューを anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
