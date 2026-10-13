-- 日本站派工臂對齊正見：政見三要素（policy_elements）。規則は預設關（工作單 Yooliang/policy-ops#95、計畫 policy-jp docs/PLAN-arms-parity.md 第 2 步）
-- ============================================================
--
--   正見臂             日本臂（activity）   任務型別（task_type）          task_id                                   交件
--   policy_elements    policy_elements     policy_elements_missing        auto:policy_elements_missing:<政見 id>    policy_elements（要素 1～3 個）／no_change（原文が見つからない）
--
--   正見：20261010100000_policy_elements_config.sql（規則の params.elements／election_ids で、どの要素・どの選舉を派すか可設定）。
--   落庫：正見 apply-contribution.ts の applyPolicyElements。
--
-- この支でやること（新增一支派工臂＝三處一起加）：
-- 1. 臂 contribution_auto_tasks_policy_elements()：総表加一行 UNION、activity_arm_names() 加名字、activity_rules 種一條規則。
--    規則は **enabled = false**（預設關）：臂は読み取りだけで行を返す（規則の行があれば params を読む。enabled は見ない）が、総表の窗口が閉じているので派工列にはならない。
--    開くとき＝1 行の migration の UPDATE（`UPDATE policy_jp.activity_rules SET enabled = true WHERE activity = 'policy_elements' AND priority IS NULL`）。
--    params：elements＝派す要素（target／deadline／funding。3 つとも載せてある。日本站も正見と同じく、開く前に要素を絞れる）、
--            election_ids＝派す選挙 id の配列（なければ開いている選挙すべて。日本站の選挙 id は TEXT）、cap＝同時に開く最大件数、chain_fallback＝後備里程碑。
-- 2. 交件型別 policy_elements：DB CHECK（policy_jp_contributions_type_check）、apply_types()、落庫 apply_policy_elements()、apply_contribution に WHEN 1 行。
-- 3. 同一件事（#521 登記表）：policy_elements を SAME_CLAIM_REGISTRY に登記（鍵＝政見 id ＋ 要素）。same_claim_matches の分派器・same_claim_same_content・
--    収編触発器の型別清單に足す。
-- 4. chain_step_rank に WHEN 1 行（policy_elements_missing＝8）。
--
-- 設計の判斷：
-- a. after_step＝'candidacy'（'policy' ではない）。'policy' は「この選挙の対象者**全員**に公約がある」まで待つ段で、policy_missing を 10-11 に
--    『逐人開』へ直した維持者の裁決（整場の揃うのを待たない）と逆になる。この臂の対象は『上線済みの政見』なので、その人の公約が入った時点で開いてよい。
--    後備＝告示日翌日（選挙公報が出る日。三要素は公約の原文＝公報で確かめるので、公報の前に開く意味がない）。
-- b. chain_step_rank＝8：同じ層の中で policy_missing（6）・開票結果（7）の後ろ、未登録の auto 型別（9）の前。
--    誰かの公約が一件もない・開票結果が決まっていない、が先で、要素の細分化は後。
-- c. 対象：還没投票＝非退選の参選（公約の本人）の政見／已投票＝当選者の政見で、まだ achieved・unfulfilled・discontinued でないもの
--    （正見は Achieved／Failed を除く。日本站の status は小文字で、discontinued〔中止〕も『追跡の対象外』なので同じく除く）。
--    対象の選挙は chain_open_elections（開いている選挙）：『常駐の全国掃描はしない』（日本站の方針）。
-- d. conflict の扱い：正見は同じ要素に違う値を交ると上書き（更正の経路）。日本站は apply_policy と同じ『上書きしない』：
--    庫の公開済みの要素と値が違うものが 1 つでもあれば、この交件は全体を conflict で退件（半分だけ書かない）。直すなら correction。
--    庫にあるのが非公開（pending／rejected／not_found）の行なら、新しい値で置き換えて公開する（UNIQUE(policy_id, element) との循環を作らない）。
--    全部が庫と同じ＝unchanged（出典だけ足す）。
-- e. 期限語：日本の会計年度は 4/1～3/31。『2028 年度まで』＝2029-03-31、暦年の書き方（『2028 年末まで』）＝2028-12-31、『任期中』＝task の term_end
--    （office_term_for の任期満了日。算出できないときは日付を付けない）。日付にできない書き方は text だけ。deadline_date は element=deadline かつ stated=true のときだけ。
-- f. 出典：source_refs（target_table='policy_elements'、target_id＝要素の行 id）に交件の source_urls を掛ける（要素ごとの source_url があればそれを先頭＝主要出処に）。
--    履歴は edit_history（agent_name='auto-apply'）。policy_jp.policy_elements に source_url／contribution_id 欄はない。
-- g. 任務の收回：contributions_drop_dispatch（status→applied）が task_dispatches の行を落とす。要素が一部だけ入ったときは、次の seed で
--    『まだ無い要素』だけの task として戻る（target.missing が縮む）。3 要素が揃えば arm が出さなくなり、收回の理由は filled。
--
-- 守門：supabase/functions/_shared/policy-jp-policy-elements.test.ts、policy-jp-dispatch-drift.test.ts（登記）、same-claims.test.ts、
-- jp/contribution-schema*.test.ts。不碰 public、ditrust。冪等（規則は NOT EXISTS、登記は ON CONFLICT）、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 交件型別 policy_elements：DB CHECK と落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician', 'policy', 'policy_elements'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'policy', 'policy_elements', 'no_change']::TEXT[]
$$;

-- ------------------------------------------------------------
-- 2. 落庫：要素 1 つの正規化（検査）と、要素の署名（同一件事の「内容が同じか」）
-- ------------------------------------------------------------
-- 交件の要素 1 つ → {element, stated, text, deadline_date, source_locator}。不備は {problem}。TS（_shared/jp/contribution-schema.ts の policy_elements）と同じ規則
CREATE OR REPLACE FUNCTION policy_jp.policy_element_normalize(e JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_kind TEXT;
  v_stated BOOLEAN;
  v_text TEXT;
  v_loc TEXT;
  v_dl_raw TEXT;
  v_dl DATE;
BEGIN
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('problem', 'elements の各要素はオブジェクト（element, stated, text, deadline_date, source_locator）');
  END IF;
  v_kind := e->>'element';
  IF v_kind IS NULL OR v_kind NOT IN ('target', 'deadline', 'funding') THEN
    RETURN jsonb_build_object('problem', 'element は target（数値目標）／deadline（達成期限）／funding（財源）のどれか');
  END IF;
  IF jsonb_typeof(e->'stated') IS DISTINCT FROM 'boolean' THEN
    RETURN jsonb_build_object('problem', format('%s：stated は必須（true＝原文に書いてある／false＝原文を調べたが書いていない）', v_kind));
  END IF;
  v_stated := (e->>'stated')::BOOLEAN;
  v_text := policy_jp.policy_trim(e->>'text');
  IF v_stated THEN
    IF char_length(v_text) NOT BETWEEN 1 AND 120 THEN
      RETURN jsonb_build_object('problem', format('%s：stated=true のときは text が必須（原文の事実を 1～120 字。補わない・換算しない）', v_kind));
    END IF;
  ELSIF v_text <> '' THEN
    RETURN jsonb_build_object('problem', format('%s：stated=false（原文に書いていない）のときは text を付けない（「未説明」と書かない）', v_kind));
  END IF;
  v_loc := policy_jp.policy_trim(e->>'source_locator');
  IF char_length(v_loc) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('problem', format('%s：source_locator（原文のどこか：公報の頁・見出し。書いていない場合も調べた箇所）は 1～200 字で必須', v_kind));
  END IF;
  v_dl_raw := NULLIF(policy_jp.policy_trim(e->>'deadline_date'), '');
  IF v_dl_raw IS NOT NULL THEN
    IF v_kind <> 'deadline' OR NOT v_stated THEN
      RETURN jsonb_build_object('problem', 'deadline_date は、原文に書いてある達成期限（element=deadline、stated=true）のときだけ付ける');
    END IF;
    IF v_dl_raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN jsonb_build_object('problem', 'deadline_date は YYYY-MM-DD（西暦）');
    END IF;
    BEGIN
      v_dl := v_dl_raw::DATE;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('problem', 'deadline_date が実在しない日付');
    END;
    IF to_char(v_dl, 'YYYY-MM-DD') <> v_dl_raw OR EXTRACT(YEAR FROM v_dl) NOT BETWEEN 1990 AND 2100 THEN
      RETURN jsonb_build_object('problem', 'deadline_date は 1990～2100 年の実在する日付（日付にできない期限は text だけにして付けない）');
    END IF;
  END IF;
  RETURN jsonb_build_object('element', v_kind, 'stated', v_stated, 'text', NULLIF(v_text, ''), 'deadline_date', v_dl, 'source_locator', v_loc);
END;
$$;
COMMENT ON FUNCTION policy_jp.policy_element_normalize IS
  '政見三要素の交件 1 要素の検査と正規化（{element, stated, text, deadline_date, source_locator}、不備は {problem}）。stated=false は text なし、deadline_date は deadline かつ stated のときだけ。TS 版 contribution-schema.ts の policy_elements と同じ規則';

-- 要素の署名：交件の elements を「要素|stated|text の正規化|期限」の並びにして連結（要素の集合と内容が同じなら同じ文字列）。不備・空は NULL
CREATE OR REPLACE FUNCTION policy_jp.policy_elements_signature(p JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p->'elements') = 'array' AND jsonb_array_length(p->'elements') > 0
              THEN (SELECT string_agg(n->>'element' || '|' || (n->>'stated') || '|' || policy_jp.policy_title_key(n->>'text') || '|' || COALESCE(n->>'deadline_date', ''), ';' ORDER BY n->>'element')
                      FROM (SELECT policy_jp.policy_element_normalize(x) AS n FROM jsonb_array_elements(p->'elements') x) q
                     WHERE n ? 'element')
         END
$$;
COMMENT ON FUNCTION policy_jp.policy_elements_signature IS '政見三要素の交件の署名（要素の集合・stated・text の正規化・期限）。same_claim_same_content が使う';

-- ------------------------------------------------------------
-- 3. 落庫 apply_policy_elements（正見 applyPolicyElements の日本版）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_policy_elements(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_pid TEXT := NULLIF(policy_jp.policy_trim(p->>'policy_id'), '');
  pl policy_jp.policies%ROWTYPE;
  v_politician_id TEXT;
  x JSONB;
  n JSONB;
  ex policy_jp.policy_elements%ROWTYPE;
  v_new policy_jp.policy_elements%ROWTYPE;
  v_seen TEXT[] := '{}';
  v_conflicts TEXT[] := '{}';
  v_written TEXT[] := '{}';
  v_same TEXT[] := '{}';
  v_urls TEXT[];
  v_label TEXT;
  v_src BIGINT;
BEGIN
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'policy_id がない（任務の target.policy_id を使う）');
  END IF;
  SELECT * INTO pl FROM policy_jp.policies WHERE id = v_pid;
  IF NOT FOUND OR pl.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('政見 %s は登録されていないか、まだ公開されていない', v_pid));
  END IF;
  IF jsonb_typeof(p->'elements') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'elements') NOT BETWEEN 1 AND 3 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'elements は 1～3 個（target／deadline／funding を 1 つずつ）');
  END IF;
  v_src := policy_jp.source_write(NULL, NULL, c.source_urls, 'policy_elements');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  -- 1 周目：検査と衝突の洗い出し（何も書かない）
  FOR x IN SELECT * FROM jsonb_array_elements(p->'elements') LOOP
    n := policy_jp.policy_element_normalize(x);
    IF n ? 'problem' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', n->>'problem');
    END IF;
    IF (n->>'element') = ANY (v_seen) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('%s が重複している：同じ政見の同じ要素は 1 回だけ', n->>'element'));
    END IF;
    v_seen := v_seen || (n->>'element');
    SELECT * INTO ex FROM policy_jp.policy_elements WHERE policy_id = v_pid AND element = n->>'element';
    IF FOUND AND ex.review_status = 'published'
       AND (ex.stated, ex.text, ex.deadline_date) IS DISTINCT FROM ((n->>'stated')::BOOLEAN, n->>'text', (n->>'deadline_date')::DATE) THEN
      v_conflicts := v_conflicts || (n->>'element');
    END IF;
  END LOOP;
  IF cardinality(v_conflicts) > 0 THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'policy_elements', 'record_id', v_pid,
      'message', format('庫にすでに同じ要素（%s）があり、値が違う。上書きしない（直すなら correction）', array_to_string(v_conflicts, '、')));
  END IF;

  -- 2 周目：書く（庫と同じ公開済みの要素は出典だけ足す。非公開の行は新しい値で置き換えて公開する）
  FOR x IN SELECT * FROM jsonb_array_elements(p->'elements') LOOP
    n := policy_jp.policy_element_normalize(x);
    v_label := CASE n->>'element' WHEN 'target' THEN '数値目標' WHEN 'deadline' THEN '達成期限' ELSE '財源' END
               || '：' || CASE WHEN (n->>'stated')::BOOLEAN THEN left(n->>'text', 40) || CASE WHEN char_length(n->>'text') > 40 THEN '…' ELSE '' END ELSE '未説明' END;
    -- 要素ごとの source_url があればそれを先頭（主要出処）に、残りを一緒に掛ける
    v_urls := CASE WHEN NULLIF(btrim(COALESCE(x->>'source_url', '')), '') IS NOT NULL
                   THEN ARRAY[btrim(x->>'source_url')] || array_remove(c.source_urls, btrim(x->>'source_url'))
                   ELSE c.source_urls END;
    SELECT * INTO ex FROM policy_jp.policy_elements WHERE policy_id = v_pid AND element = n->>'element';
    IF NOT FOUND THEN
      INSERT INTO policy_jp.policy_elements (id, policy_id, element, stated, text, deadline_date, source_locator, review_status)
      VALUES (gen_random_uuid()::TEXT, v_pid, n->>'element', (n->>'stated')::BOOLEAN, n->>'text', (n->>'deadline_date')::DATE, n->>'source_locator', 'published')
      RETURNING * INTO v_new;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('policy_elements', v_new.id, '*', NULL, to_jsonb(v_new), c.id, 'auto-apply');
      PERFORM policy_jp.source_write('policy_elements', v_new.id, v_urls, 'policy_elements');
      v_written := v_written || v_label;
    ELSIF ex.review_status <> 'published' THEN
      UPDATE policy_jp.policy_elements
         SET stated = (n->>'stated')::BOOLEAN, text = n->>'text', deadline_date = (n->>'deadline_date')::DATE, source_locator = n->>'source_locator',
             review_status = 'published', updated_at = now()
       WHERE id = ex.id
       RETURNING * INTO v_new;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('policy_elements', ex.id, '*', to_jsonb(ex), to_jsonb(v_new), c.id, 'auto-apply');
      PERFORM policy_jp.source_write('policy_elements', ex.id, v_urls, 'policy_elements');
      v_written := v_written || v_label;
    ELSE
      PERFORM policy_jp.source_write('policy_elements', ex.id, v_urls, 'policy_elements');
      v_same := v_same || v_label;
    END IF;
  END LOOP;

  SELECT pe.politician_id INTO v_politician_id FROM policy_jp.politician_elections pe WHERE pe.id = pl.politician_election_id;
  UPDATE policy_jp.contributions SET applied_policy_id = v_pid, applied_politician_id = v_politician_id WHERE id = c.id;
  IF cardinality(v_written) = 0 THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'policy_elements', 'record_id', v_pid,
      'message', format('政見「%s」の三要素は庫に同じ内容で既にある（%s）', pl.title, array_to_string(v_same, '；')));
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'policy_elements', 'record_id', v_pid,
    'message', format('政見「%s」の三要素を記録：%s%s', pl.title, array_to_string(v_written, '；'),
                      CASE WHEN cardinality(v_same) > 0 THEN format('（%s は庫と同じなので出典だけ追加）', array_to_string(v_same, '、')) ELSE '' END));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_policy_elements IS
  'policy_elements 交件の落庫（正見 applyPolicyElements の日本版）：政見 1 件の要素 1～3 個。庫に無い要素は新規、非公開の行は置き換えて公開、公開済みと同じ値は出典だけ追加。'
  '公開済みと違う値が 1 つでもあれば全体を conflict（上書きしない）。stated=false（未説明）も答え。deadline_date は deadline かつ stated のときだけ。出典は source_refs（policy_elements）、履歴は edit_history';

-- 落庫主函式：20261010060000 の版に policy_elements の WHEN を 1 行足しただけ（残りは一字も変えない）
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
-- 4. 臂：policy_elements（政見の三要素のうち、まだ記録のない要素）
-- ------------------------------------------------------------
-- 規則（activity_rules「policy_elements」）の params を読む：elements（派す要素）・election_ids（派す選挙。なければ開いている選挙すべて）・cap。
-- 規則の enabled は見ない（臂は常に読み取りだけで行を返し、窓の開閉は総表が決める。規則は預設で閉じている）
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_policy_elements()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap,
           CASE WHEN jsonb_typeof(r.params->'elements') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r.params->'elements')) ELSE ARRAY['target', 'deadline', 'funding'] END AS elements,
           CASE WHEN jsonb_typeof(r.params->'election_ids') = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(r.params->'election_ids')) END AS election_ids
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'policy_elements' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  inflight AS (
    -- もう誰かが交件して、票待ち・自動再試行中：先に派さない（二人のエージェントが同じ政見を割らないように）。退件されれば戻る
    SELECT DISTINCT c.payload->>'policy_id' AS policy_id
      FROM policy_jp.contributions c
     WHERE c.contribution_type = 'policy_elements' AND c.status IN ('pending', 'verified', 'disputed', 'apply_failed')
  ),
  cand AS MATERIALIZED (
    SELECT pl.id AS policy_id, pl.title, pl.status AS status,
           pe.id AS politician_election_id, pp.id AS politician_id, pp.name, pp.kana,
           e.id AS election_id, e.name AS election_name, e.election_type, e.election_date, e.lg_code, g.name AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), '（都道府県名未確認）') AS pref_name,
           (SELECT s.url FROM policy_jp.source_refs sr JOIN policy_jp.sources s ON s.id = sr.source_id
             WHERE sr.target_table = 'policies' AND sr.target_id = pl.id ORDER BY (sr.role = 'primary') DESC, sr.created_at, s.id LIMIT 1) AS source_url,
           ARRAY(SELECT k FROM unnest(ARRAY['target', 'deadline', 'funding']) WITH ORDINALITY AS u(k, n)
                  WHERE u.k = ANY ((SELECT cfg.elements FROM cfg)::TEXT[])
                    AND NOT EXISTS (SELECT 1 FROM policy_jp.policy_elements x WHERE x.policy_id = pl.id AND x.element = u.k AND x.review_status = 'published')
                  ORDER BY u.n) AS missing
      FROM policy_jp.policies pl
      JOIN policy_jp.politician_elections pe ON pe.id = pl.politician_election_id AND pe.review_status = 'published'
      JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
      JOIN policy_jp.chain_open_elections o ON o.election_id = pe.election_id AND o.basis = 'published'
      JOIN policy_jp.elections e ON e.id = pe.election_id AND e.review_status = 'published'
      JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
     WHERE pl.review_status = 'published' AND pl.origin = 'pledge'
       AND ((SELECT cfg.election_ids FROM cfg) IS NULL OR e.id = ANY ((SELECT cfg.election_ids FROM cfg)::TEXT[]))
       AND (
         -- まだ投票前：立候補している人（取りやめ以外。選挙前に並べて比べられるように）
         (e.election_date >= policy_jp.activity_today() AND pe.candidacy_status <> 'withdrawn')
         -- 投票後：当選者で、公約がまだ達成・不履行・中止になっていない（期限を進捗の追跡につなげるため）
         OR (e.election_date < policy_jp.activity_today() AND pe.candidacy_status = 'elected' AND pl.status NOT IN ('achieved', 'unfulfilled', 'discontinued'))
       )
  ),
  gaps AS (
    SELECT c.*
      FROM cand c CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL
       AND cardinality(c.missing) > 0
       AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.policy_id = c.policy_id)
       AND NOT policy_jp.task_unavailable('auto:policy_elements_missing:' || c.policy_id)
     ORDER BY c.election_date, c.kana NULLS LAST, c.policy_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT 'auto:policy_elements_missing:' || g.policy_id, 'policy_elements_missing',
         jsonb_build_object('policy_id', g.policy_id, 'policy_title', g.title, 'status', g.status, 'source_url', g.source_url,
                            'politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'lg_code', g.lg_code, 'lg_name', g.lg_name, 'term_end', t.term_end, 'missing', to_jsonb(g.missing),
                            'chain_lg_code', g.lg_code, 'chain_step', 'policy'),
         '公約「' || g.title || '」（' || g.name || '、' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）を、数値目標・達成期限・財源の三つの要素に分けて記録します。'
           || 'まだ記録のない要素：' || array_to_string(ARRAY(SELECT CASE k WHEN 'target' THEN '数値目標' WHEN 'deadline' THEN '達成期限' ELSE '財源' END
                                                           FROM unnest(g.missing) WITH ORDINALITY AS u(k, n) ORDER BY u.n), '、') || '（target.missing）。'
           || 'この公約の原文（選挙公報・候補者の公式サイト・政策パンフレット・選挙管理委員会の掲載ページ）を開いてください。いま公約にひもづいている出典が報道の要約などのときは、原文を探します。'
           || '確かめるのは上に挙げた要素だけです（挙げていない要素は調べなくて構いません）：数値目標＝どこまで何を達成するか、達成期限＝いつまでか、財源＝お金をどこから出すか。'
           || '原文に書いてあれば、その事実を text（120 字以内）に書き写します（数字を補わない・換算しない・評価しない）。調べて原文に書いていなければ stated=false にして、text は付けません。それも答えで、画面には「未説明」と出ます。'
           || '調べていない要素は出さないでください（「未調査」のまま残ります）。要素ごとに source_locator（原文のどこか：公報の頁・見出し。書いていない場合も、どの部分を調べたか）が必須です。'
           || '達成期限が日付にできるときは deadline_date（YYYY-MM-DD）も付けます。日本の会計年度は 4 月 1 日から翌年 3 月 31 日です：「2028 年度まで」は 2029-03-31、'
           || '「2028 年末まで」「2028 年中」のように暦年で書いてあれば 2028-12-31、「任期中」は任期満了日（' || COALESCE(t.term_end::TEXT, '任期満了日が分からないときは日付を付けない') || '）。'
           || '「早期に」「できるだけ早く」など日付にできない書き方は deadline_date を付けず、text だけにします。'
           || 'contribution_type=policy_elements で提出します：payload は policy_id（' || g.policy_id || '）・elements［{element, stated, text, deadline_date, source_locator}］・'
           || 'resolved_claim（item.current.same_claims を見て決める。誰も出していなければ "new"）。source_urls は原文のページです。'
           || '原文が見つからないときは contribution_type=no_change、outcome=not_found、checked_urls に探した場所を入れて報告してください（こちらの要約を原文の代わりにしない）。',
         ARRAY_REMOVE(ARRAY[
           CASE WHEN g.source_url IS NOT NULL THEN g.source_url || ' ←この公約に今ひもづいている出典（原文かどうか確かめてください）' END,
           g.lg_name || ' 選挙管理委員会の選挙公報',
           '候補者本人の公式サイト・公式パンフレット',
           g.pref_name || ' 選挙管理委員会',
           '政党の公認・推薦候補の発表ページ'
         ], NULL)::TEXT[],
         1, g.pref_name
    FROM gaps g
    LEFT JOIN LATERAL (SELECT ot.scheduled_end_date AS term_end FROM policy_jp.office_term_for(g.election_id) ot LIMIT 1) t ON true
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_policy_elements IS
  '政見三要素（正見 policy_elements の日本版）：開いている選挙の公開済みの公約で、規則 params.elements の要素のうちまだ公開記録がないもの → policy_elements_missing 任務'
  '（1 政見 1 件、task_id＝auto:policy_elements_missing:<政見 id>、target.missing は残りの要素だけ）。投票前は取りやめ以外の参選、投票後は当選者で未達成・未不履行・未中止の公約。'
  '交件待ち（pending／verified／disputed／apply_failed）の政見は派さない。窓（規則の enabled・after_step）は総表が決める。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 5. 同一件事（#521）：policy_elements の比對本体と分派
-- ------------------------------------------------------------
-- 鍵＝政見 id ＋ 要素。要素を書かない探査（policy_elements_missing の任務を領いたとき）は、その政見の公開済みの要素と審議中の提出を全部返す
CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches_policy_elements(p JSONB, p_ip_hash TEXT, p_exclude UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_pid TEXT := NULLIF(p->>'policy_id', '');
  v_kinds TEXT[] := CASE WHEN jsonb_typeof(p->'elements') = 'array'
                         THEN ARRAY(SELECT DISTINCT x->>'element' FROM jsonb_array_elements(p->'elements') x WHERE jsonb_typeof(x) = 'object' AND x->>'element' IS NOT NULL) END;
  v_existing JSONB := '[]'::JSONB;
  v_pending JSONB := '[]'::JSONB;
BEGIN
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('type', 'policy_elements', 'existing', v_existing, 'pending', v_pending);
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', x.id, 'element', x.element, 'stated', x.stated, 'text', x.text, 'deadline_date', x.deadline_date, 'review_status', x.review_status,
           'summary', x.element || '：' || CASE WHEN x.stated THEN COALESCE(x.text, '') ELSE '未説明' END,
           'why', CASE WHEN v_kinds IS NULL OR cardinality(v_kinds) = 0 THEN '同じ政見に記録済みの要素' ELSE '同じ政見の同じ要素' END)
           ORDER BY x.element, x.id), '[]'::JSONB)
    INTO v_existing
    FROM policy_jp.policy_elements x
   WHERE x.policy_id = v_pid AND x.review_status = 'published' AND (v_kinds IS NULL OR cardinality(v_kinds) = 0 OR x.element = ANY (v_kinds));
  SELECT COALESCE(jsonb_agg(y.j ORDER BY y.created_at), '[]'::JSONB) INTO v_pending FROM (
    SELECT c.created_at, jsonb_build_object(
             'contribution_id', c.id, 'status', c.status, 'agent', c.agent_name, 'sources', to_jsonb(c.source_urls),
             'elements', c.payload->'elements',
             'summary', COALESCE(policy_jp.policy_elements_signature(c.payload), '?'),
             'yours', p_ip_hash IS NOT NULL AND c.contributor_ip_hash = p_ip_hash,
             'your_network_voted', p_ip_hash IS NOT NULL AND (c.contributor_ip_hash = p_ip_hash
               OR EXISTS (SELECT 1 FROM policy_jp.contribution_votes v WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash))) AS j
      FROM policy_jp.contributions c
     WHERE c.contribution_type = 'policy_elements'
       AND c.status IN ('pending', 'disputed', 'verified', 'apply_failed')
       AND (p_exclude IS NULL OR c.id <> p_exclude)
       AND c.payload->>'policy_id' = v_pid
       AND (v_kinds IS NULL OR cardinality(v_kinds) = 0
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'elements') = 'array' THEN c.payload->'elements' ELSE '[]'::JSONB END) z
                        WHERE jsonb_typeof(z) = 'object' AND z->>'element' = ANY (v_kinds)))
     LIMIT 50
  ) y;
  RETURN jsonb_build_object('type', 'policy_elements', 'existing', v_existing, 'pending', v_pending);
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_matches_policy_elements IS
  '同一件事（policy_elements）：政見 id ＋ 要素。要素を書かない探査ではその政見の公開済みの要素と審議中の提出を全部返す。same_claim_matches の分派先';

-- 分派器：20261010060000 の版に policy_elements の分岐を足しただけ
CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches(
  p_type TEXT, p_payload JSONB, p_ip_hash TEXT DEFAULT NULL, p_exclude UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF p_type NOT IN ('election', 'regional_stat', 'local_government', 'politician', 'policy', 'policy_elements') THEN
    RETURN NULL;
  END IF;
  IF p_type = 'politician' THEN
    RETURN policy_jp.same_claim_matches_politician(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);
  END IF;
  IF p_type = 'policy' THEN
    RETURN policy_jp.same_claim_matches_policy(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);
  END IF;
  IF p_type = 'policy_elements' THEN
    RETURN policy_jp.same_claim_matches_policy_elements(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);
  END IF;
  RETURN policy_jp.same_claim_matches_base(p_type, p_payload, p_ip_hash, p_exclude);
END;
$$;

-- 収編用の「内容が同じか」：20261010120000 の版に policy_elements の WHEN を 1 行足しただけ
CREATE OR REPLACE FUNCTION policy_jp.same_claim_same_content(p_type TEXT, a JSONB, b JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_type
    WHEN 'election' THEN (a->>'election_date', a->>'election_type', COALESCE(NULLIF(a->>'election_reason', ''), 'regular'))
                     IS NOT DISTINCT FROM (b->>'election_date', b->>'election_type', COALESCE(NULLIF(b->>'election_reason', ''), 'regular'))
    -- 数値比対は apply_regional_stat と同じ判準（NUMERIC：28.5 と 28.50 は同じ）；数字でないものは同じとみなさない
    WHEN 'regional_stat' THEN jsonb_typeof(a->'value') = 'number' AND jsonb_typeof(b->'value') = 'number'
                              AND (a->>'value')::NUMERIC = (b->>'value')::NUMERIC AND a->>'unit' IS NOT DISTINCT FROM b->>'unit'
    WHEN 'local_government' THEN (a->>'name', a->>'kana', a->>'kind') IS NOT DISTINCT FROM (b->>'name', b->>'kana', b->>'kind')
    -- 政治人物：生年・読み・学歴・経歴が（順序を問わず）同じ
    WHEN 'politician' THEN
      (a->>'birth_year') IS NOT DISTINCT FROM (b->>'birth_year')
      AND (a->>'kana') IS NOT DISTINCT FROM (b->>'kana')
      AND COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'education') = 'array' THEN a->'education' ELSE '[]'::JSONB END) t), '[]'::JSONB)
        = COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b->'education') = 'array' THEN b->'education' ELSE '[]'::JSONB END) t), '[]'::JSONB)
      AND COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'career') = 'array' THEN a->'career' ELSE '[]'::JSONB END) t), '[]'::JSONB)
        = COALESCE((SELECT jsonb_agg(btrim(t) ORDER BY btrim(t)) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(b->'career') = 'array' THEN b->'career' ELSE '[]'::JSONB END) t), '[]'::JSONB)
    -- 政見：要約が（空白・全半角・大小文字を無視して）同じ（題名は鍵で既に同じ）
    WHEN 'policy' THEN policy_jp.policy_title_key(a->>'description') = policy_jp.policy_title_key(b->>'description') AND NULLIF(btrim(COALESCE(a->>'description', '')), '') IS NOT NULL
    -- 政見の三要素：要素の集合が同じで、各要素の stated・text・deadline_date が（空白・全半角・大小文字を無視して）同じ
    WHEN 'policy_elements' THEN policy_jp.policy_elements_signature(a) IS NOT NULL AND policy_jp.policy_elements_signature(b) IS NOT NULL
                              AND policy_jp.policy_elements_signature(a) = policy_jp.policy_elements_signature(b)
    ELSE FALSE
  END
$$;

DROP TRIGGER IF EXISTS contributions_same_claim_supersede ON policy_jp.contributions;
CREATE TRIGGER contributions_same_claim_supersede AFTER UPDATE OF status ON policy_jp.contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NEW.contribution_type IN ('election', 'regional_stat', 'local_government', 'politician', 'policy', 'policy_elements'))
  EXECUTE FUNCTION policy_jp.same_claim_supersede_trg();

-- ------------------------------------------------------------
-- 6. 臂名清單・総表・層内順位：20261011090000 の版に 名前 1 つ／UNION 1 行／WHEN 1 行を足しただけ（残りは一字も変えない）
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
    'policy_elements'
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
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／candidate_status_stale／not_running_recheck／candidacy_source_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing 8。登録のない auto 型別は 9';

-- ------------------------------------------------------------
-- 7. 規則（預設關）と優先層（冪等）
-- ------------------------------------------------------------
-- 窗口は常時（always）。第 2 歩（candidacy）が済んでから、止まっていても告示日の翌日（選挙公報が出る日）には開く。enabled = false：開くのは別の migration の UPDATE
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, after_step, enabled, params, note)
SELECT 'policy_elements', 'always', 'announced', 'candidacy', false,
       '{"cap":200,"elements":["target","deadline","funding"],"chain_fallback":{"kind":"announced","offset":1}}'::JSONB,
       '政見三要素（正見 policy_elements）：公開済みの公約を数値目標・達成期限・財源に分けて記録する任務。預設は閉じている（enabled=false）。開くときは UPDATE policy_jp.activity_rules SET enabled = true（要素を絞るなら params.elements も）。開いたあとは参選者の人物建檔が済み（candidacy）、止まっていても告示日の翌日には開く。同時に開くのは最大 200 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'policy_elements' AND r.priority IS NULL);

-- 優先層：policy_missing と同じ（投票日前 60 日以内＝前段、前 181 日以上＝後段、その間は既定の中段）
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT a.activity, 'event', a.from_kind, a.from_offset, a.until_kind, a.until_offset, a.tier, a.note
  FROM (VALUES
    ('priority:policy_elements', 'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 日以内の政見三要素任務（最近の選挙を先に派す）'),
    ('priority:policy_elements', NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の政見三要素任務；61～180 日は既定の層（中段）')
  ) AS a(activity, from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority = a.tier);

-- 主控台時間軸の段（告示日起算＝第 3 段。policy_missing と同じ。規則は常時窓なので、この登記が採用される）
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('policy_elements', 3, '政見の三要素（告示後）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 8. 權限（新函式は PUBLIC に実行権が付くので明示的に収回。CREATE OR REPLACE した既存の関数は権限を保つ）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_policy_elements(), policy_jp.apply_policy_elements(policy_jp.contributions),
  policy_jp.policy_element_normalize(JSONB), policy_jp.policy_elements_signature(JSONB), policy_jp.same_claim_matches_policy_elements(JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_policy_elements(), policy_jp.apply_policy_elements(policy_jp.contributions),
  policy_jp.policy_element_normalize(JSONB), policy_jp.policy_elements_signature(JSONB), policy_jp.same_claim_matches_policy_elements(JSONB, TEXT, UUID)
  TO service_role;

-- ------------------------------------------------------------
-- 9. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  -- 規則：存在、預設關、掛在 candidacy 之後、有後備與 cap、params.elements 只含三種要素
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'policy_elements' AND r.priority IS NULL AND NOT r.enabled AND r.window_kind = 'always'
                    AND r.after_step = 'candidacy' AND r.params ? 'chain_fallback' AND r.params ? 'cap'
                    AND jsonb_typeof(r.params->'elements') = 'array' AND jsonb_array_length(r.params->'elements') > 0
                    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.params->'elements') e WHERE e NOT IN ('target', 'deadline', 'funding'))) THEN
    RAISE EXCEPTION 'policy_jp：policy_elements の規則が「預設關・candidacy の後・chain_fallback と cap あり・elements は target／deadline／funding だけ」になっていない';
  END IF;
  -- 三處一起加
  IF NOT ('policy_elements' = ANY (policy_jp.activity_arm_names())) THEN
    RAISE EXCEPTION 'policy_jp：activity_arm_names() に policy_elements がない';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_policy_elements()%') <> 1 THEN
    RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 総表に policy_elements の分支がない';
  END IF;
  IF policy_jp.chain_step_rank('auto:policy_elements_missing:x', 'policy_elements_missing') <> 8
     OR policy_jp.chain_step_rank('auto:policy_missing:x', 'policy_missing') <> 6
     OR policy_jp.chain_step_rank('auto:election_result_missing:x', 'election_result_missing') <> 7 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank の登録がおかしい';
  END IF;
  -- 交件型別：DB CHECK と落庫清單
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%policy_elements%') THEN
    RAISE EXCEPTION 'policy_jp：policy_jp_contributions_type_check に policy_elements がない';
  END IF;
  IF NOT ('policy_elements' = ANY (policy_jp.apply_types())) THEN RAISE EXCEPTION 'policy_jp：apply_types() に policy_elements がない'; END IF;
  IF pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_policy_elements%' THEN
    RAISE EXCEPTION 'policy_jp：apply_contribution に policy_elements の WHEN がない';
  END IF;
  -- 同一件事：分派器が policy_elements を知っている
  IF policy_jp.same_claim_matches('policy_elements', '{"policy_id":"none"}'::JSONB) IS NULL THEN
    RAISE EXCEPTION 'policy_jp：same_claim_matches が policy_elements を知らない';
  END IF;
  IF pg_get_triggerdef((SELECT t.oid FROM pg_trigger t WHERE t.tgname = 'contributions_same_claim_supersede' AND t.tgrelid = 'policy_jp.contributions'::regclass)) NOT LIKE '%policy_elements%' THEN
    RAISE EXCEPTION 'policy_jp：contributions_same_claim_supersede の型別清單に policy_elements がない';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_policy_elements()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_policy_elements(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.policy_element_normalize(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.policy_elements_signature(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.same_claim_matches_policy_elements(jsonb, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：政見三要素の関数を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
