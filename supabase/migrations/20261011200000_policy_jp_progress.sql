-- 日本站派工臂対齊正見：政見の進捗追跡 progress_stale／deadline_due と交件型別 policy_progress（C 期 第 5 步）。工作単 Yooliang/policy-ops#95、計畫 policy-jp docs/PLAN-arms-parity.md C 期「任期中の追跡」
-- ============================================================
--
--   正見臂                日本臂（activity）  任務型別（task_type）  task_id                            交件
--   raw:progress_stale   progress_stale      progress_stale         auto:progress_stale:<政見 id>      policy_progress／removal（政策ではなかった）／no_change（outcome=not_found）
--   deadline_due         deadline_due        deadline_due           auto:deadline_due:<政見 id>        policy_progress／no_change（outcome=not_found）
--
--   正見：progress_stale＝contribution_auto_tasks_raw() の一段（最新は 20261010170000）、deadline_due＝contribution_auto_tasks_deadline_due()（20261006220000）、
--         総表で『同じ政見に deadline_due があれば progress_stale は出さない』（20261011120000）。交件は contribution-schema.ts／apply-contribution.ts の policy_progress。
--   日本站のちがい：
--     ・政見は policy_jp.policies（status は 6 値：not_started／in_progress／partial／achieved／discontinued／unfulfilled。正見の Campaign Pledge は『来源』なので origin=pledge、Failed は unfulfilled、Stalled に当たる値はない）。
--       removed_at がない：軟移除は review_status='rejected'。『終わった』政策＝achieved／discontinued／unfulfilled（正見は Achieved／Failed）。
--     ・人物は『公約＝参選紀錄（politician_election_id）、公約以外＝任期（office_ids[1]）』から引く。今は公約（origin=pledge）だけが落庫される。
--     ・公約は『当選した人の分だけ』追う（pe.candidacy_status = 'elected' かつ投票日が過ぎている）。正見は『落選・退選を除く』なので、当落が未記録の候補者の公約も含み、
--       任務文で『まず当選したか確かめて candidacy で結果を足す』と案内するが、日本站には当落を記録する臂（election_results／elected_missing、B 期）が別にあるので、
--       進捗の臂は当落が決まった公約だけを扱う（当選結果の確認と candidacy の回報は進捗の任務に混ぜない）。
--     ・進捗の ％（policies.progress）は日本站の policies にない。policy_progress の payload は policy_id・status・date・note（progress を付けたら 400）。
--     ・正見の CURRENT_DATE は policy_jp.activity_today()（Asia/Tokyo、テストは SET app.activity_today で固定）。90 日は規則の params.stale_days（正見は臂に直書き）。
--     ・正見は『最終更新が 90 日前より古い』を policies.last_updated で見る。日本站は last_updated が NULL のとき created_at の日付（東京）を使う。
--
-- この支でやること：
-- 1. 交件型別 policy_progress：DB CHECK（policy_jp_contributions_type_check）、apply_types()、落庫 apply_policy_progress()、apply_contribution に WHEN 1 行。
--    payload：policy_id、status（上の 6 値）、date（出来事の日付。1947-01-01～今日（東京））、note（10～3000 字）。出典は source_urls（全型別共通で必須）。
--    落庫（正見 applyPolicyProgress の日本版）：公開済みの政見だけ（それ以外は invalid）。出来事の日付が政見の last_updated より古い（厳密に早い）ときは時間軸（tracking_logs）にだけ記録して現況は変えない
--    （『10 月に達成』のあとに『3 月に着手』が来ても現況が巻き戻らない、正見 2026-09-28）。そうでなければ policies.status と last_updated を書き換え、edit_history（'*' に旧行・新行、agent_name='auto-apply'）。
--    tracking_logs に 1 行（event＝『経過の更新：<状態>』、description＝note、review_status='published'）、出典は source_refs（target_table='tracking_logs'）。
--    同じ政見・同じ日・同じ event・同じ note の公開済みの行がすでにあれば unchanged（冪等）。
--    ・status=unfulfilled は origin=pledge の政見だけ（policies の CHECK と同じ。落庫で invalid にして apply_failed の再試行ループにしない）。
--    ・status=discontinued は source_urls に official 等級（*.go.jp・*.lg.jp・自治体公式サイト）が 1 つ以上必要（policies の列コメント『discontinued は official か assembly の出典が要る（寫入端檢查）』を、
--      最初に status を書く交件型別のここで実装する。TS の jpSourceKind と SQL の source_kind_for_url は同じ判定）。
-- 2. 臂 progress_stale／deadline_due：総表に UNION 2 行、activity_arm_names() に名前 2 つ、activity_rules に規則 2 条（enabled・常時窓・after_step なし・cap）、chain_step_rank に WHEN 2 行、主控台の段 6（任期中）。
--    共通の判定は helper 関数 progress_subjects()（追跡対象の政見）と deadline_due_subjects()（その中で期限が過ぎたもの）。deadline_due が出る政見には progress_stale を出さない（正見の総表と同じ）。
-- 3. 共識：contribution_needs_two_ips は policy_progress を列挙しない、contribution_required_agree は ELSE の normal（目標 3・退件 −3）、system_vote_eligible は正見の複本のまま policy_progress を含むが
--    jp-system-one の候選型別（system_one_precheck_types）には入れない＝系統票なし。この支では共識関数を一字も変えない。
-- 4. 同一件事（#521）：policy_progress は登記表の型別ではなく、claimKey 併票の型別（duplicate-claim.ts の DUPLICATE_ELIGIBLE_TYPES、鍵＝policy_id＋status＋date）。same_claim_matches は触らない。
--
-- 設計の判断：
-- a. 鎖（選挙鎖）に掛けない（after_step なし）：進捗の任務は『すでに公開された政見』が対象で、選挙鎖のどの段の完了も前提にしない。
--    鎖の gate は『開いている選挙』の（選挙 id×団体）で進み具合を引くが、進捗の対象は過去の選挙の公約・選挙のない政策（policy_address／assembly／budget）が普通なので、
--    after_step を付けると選挙のない政策は後備（選挙の里程碑）も出せず一度も開かない。duplicate_policy と同じく常時窓・after_step なし。
-- b. 優先層は専用の規則を置かない＝既定の層（中段）：日本站の priority 規則は臂ごとの『投票日からの距離』（前段＝投票日前 60 日以内、後段＝181 日以上前）で、
--    進捗追跡は投票日と関係なく『任期中の政策を見守る』仕事なので、距離で前後に振らない。層内は先入れ先出し、chain_step_rank は 9（選挙鎖の最後）。
-- c. 『查無』の冷却遞増（正見 task_cooldown_settings：1 回目 14 日・2 回目から 30 日）は入れていない：日本站の task_unavailable／refresh_dispatch_blocked は
--    正見の複本＋告示日の偏離で、冷却日数を型別ごとに変えるには設定表・日数関数・二つの本体の差し替え（偏離の登記を増やす）が要る。標準の冷却（not_found 14 日・unreachable 2 日）のまま。
--    本番の政見は 0 件なので出力は空、必要になった時に別の migration で足す。
--
-- 規則は enabled（既定）。本番の公開済みの政見は 0 件なので派工は空のまま。止める・絞るのは UPDATE policy_jp.activity_rules SET enabled / params（走 migration）。
--
-- 守門：supabase/functions/_shared/policy-jp-progress.test.ts、policy-jp-dispatch-drift.test.ts（登記）、same-claims.test.ts、jp/contribution-schema*.test.ts。
-- 不碰 public、ditrust。冪等（規則は NOT EXISTS）、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 交件型別 policy_progress：DB CHECK と落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'policy_progress'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'policy_progress', 'no_change']::TEXT[]
$$;

-- 政策の状態の日本語（画面 src/lib/constants.ts の STATUS と同じ言葉）。tracking_logs.event と任務文に使う
CREATE OR REPLACE FUNCTION policy_jp.policy_status_label(p_status TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE p_status
           WHEN 'not_started' THEN '未着手' WHEN 'in_progress' THEN '進行中' WHEN 'partial' THEN '一部達成'
           WHEN 'achieved' THEN '達成' WHEN 'discontinued' THEN '中止' WHEN 'unfulfilled' THEN '任期中に未達成'
           ELSE p_status END
$$;
COMMENT ON FUNCTION policy_jp.policy_status_label IS '政策の状態（policies.status の 6 値）の日本語。画面の STATUS の label と同じ。未知の値はそのまま返す';

-- ------------------------------------------------------------
-- 2. 落庫 apply_policy_progress（正見 applyPolicyProgress の日本版）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_policy_progress(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_pid TEXT := NULLIF(policy_jp.policy_trim(p->>'policy_id'), '');
  v_status TEXT := p->>'status';
  v_note TEXT := policy_jp.policy_trim(p->>'note');
  v_date DATE;
  v_event TEXT;
  v_older BOOLEAN;
  v_politician_id TEXT;
  pl policy_jp.policies%ROWTYPE;
  v_new policy_jp.policies%ROWTYPE;
  v_log policy_jp.tracking_logs%ROWTYPE;
BEGIN
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'policy_id がない（任務の target.policy_id を使う）');
  END IF;
  SELECT * INTO pl FROM policy_jp.policies WHERE id = v_pid;
  IF NOT FOUND OR pl.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('政見 %s は登録されていないか、公開されていない（取り除かれた政見には経過を書けない）', v_pid));
  END IF;
  IF v_status IS NULL OR NOT (v_status = ANY (ARRAY['not_started', 'in_progress', 'partial', 'achieved', 'discontinued', 'unfulfilled'])) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'status は not_started／in_progress／partial／achieved／discontinued／unfulfilled のどれか');
  END IF;
  IF char_length(v_note) NOT BETWEEN 10 AND 3000 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'note は 10～3000 字（何が起きたか、どの文書に書いてあるか）');
  END IF;
  IF p ->> 'date' IS NULL OR p ->> 'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'date は YYYY-MM-DD（出来事の日付）');
  END IF;
  BEGIN
    v_date := (p ->> 'date')::DATE;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'date が実在しない日付');
  END;
  IF v_date NOT BETWEEN DATE '1947-01-01' AND policy_jp.activity_today() THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('date（%s）は 1947 年以降、今日（%s）を超えない日付', v_date, policy_jp.activity_today()));
  END IF;
  IF v_status = 'unfulfilled' AND pl.origin <> 'pledge' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'unfulfilled（任期中に未達成）にできるのは公約（origin=pledge）だけ');
  END IF;
  IF v_status = 'discontinued' AND NOT EXISTS (SELECT 1 FROM unnest(c.source_urls) u WHERE policy_jp.source_kind_for_url(btrim(u), 'policy_progress') = 'official') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'discontinued（中止）には公的な出典が要る：source_urls に *.go.jp・*.lg.jp・自治体の公式サイトを 1 つ以上入れる');
  END IF;
  IF policy_jp.source_write(NULL, NULL, c.source_urls, 'policy_progress') IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  v_event := '経過の更新：' || policy_jp.policy_status_label(v_status);
  SELECT pe.politician_id INTO v_politician_id FROM policy_jp.politician_elections pe WHERE pe.id = pl.politician_election_id;
  IF v_politician_id IS NULL THEN
    SELECT o.politician_id INTO v_politician_id FROM policy_jp.politician_offices o WHERE o.id = pl.office_ids[1];
  END IF;

  -- 同じ経過がすでに公開されている（同じ日・同じ event・同じ note）：何も書かない
  IF EXISTS (SELECT 1 FROM policy_jp.tracking_logs tl
              WHERE tl.policy_id = v_pid AND tl.review_status = 'published' AND tl.date = v_date AND tl.event = v_event AND tl.description IS NOT DISTINCT FROM v_note) THEN
    UPDATE policy_jp.contributions SET applied_policy_id = v_pid, applied_politician_id = v_politician_id WHERE id = c.id;
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'tracking_logs', 'record_id', v_pid,
      'message', format('政策「%s」の同じ経過（%s、%s）は庫にすでにある', pl.title, v_date, v_event));
  END IF;

  -- 出来事の日付が現況の最終更新より古い（厳密に早い）：時間軸にだけ足し、現在の状態は変えない
  v_older := pl.last_updated IS NOT NULL AND v_date < pl.last_updated;
  IF NOT v_older AND (pl.status IS DISTINCT FROM v_status OR pl.last_updated IS DISTINCT FROM v_date) THEN
    UPDATE policy_jp.policies SET status = v_status, last_updated = v_date, updated_at = now() WHERE id = v_pid RETURNING * INTO v_new;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('policies', v_pid, '*', to_jsonb(pl), to_jsonb(v_new), c.id, 'auto-apply');
  END IF;

  INSERT INTO policy_jp.tracking_logs (id, policy_id, date, event, description, review_status)
  VALUES (gen_random_uuid()::TEXT, v_pid, v_date, v_event, v_note, 'published')
  RETURNING * INTO v_log;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('tracking_logs', v_log.id, '*', NULL, to_jsonb(v_log), c.id, 'auto-apply');
  PERFORM policy_jp.source_write('tracking_logs', v_log.id, c.source_urls, 'policy_progress');
  UPDATE policy_jp.contributions SET applied_policy_id = v_pid, applied_politician_id = v_politician_id WHERE id = c.id;

  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'tracking_logs', 'record_id', v_log.id,
    'message', CASE WHEN v_older
                    THEN format('政策「%s」の経過（%s）を時間軸に記録した。日付が現況の最終更新（%s）より古いので、現在の状態は変えていない', pl.title, v_date, pl.last_updated)
                    ELSE format('政策「%s」の経過を更新した：%s（%s）', pl.title, policy_jp.policy_status_label(v_status), v_date) END);
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_policy_progress IS
  'policy_progress 交件の落庫（正見 applyPolicyProgress の日本版）：公開済みの政策の status と last_updated を書き換え、tracking_logs に 1 行足す。出来事の日付が現況の最終更新より古ければ時間軸にだけ記録して状態は変えない。'
  'unfulfilled は公約だけ、discontinued は official 等級の出典が要る、同じ経過がすでにあれば unchanged、不備は invalid。履歴は edit_history、出典は source_refs（tracking_logs）';

-- 落庫主函式：20261011180000 の版に policy_progress の WHEN を 1 行足しただけ（残りは一字も変えない）
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
               WHEN 'policy_progress' THEN policy_jp.apply_policy_progress(c)
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
-- 3. 共通の判定：追跡対象の政見 progress_subjects()／期限が過ぎたもの deadline_due_subjects()
-- ------------------------------------------------------------
-- 追跡対象＝公開済みで、まだ『終わっていない』（achieved／discontinued／unfulfilled 以外）政策で、人物が引けるもの。
--   公約（origin=pledge）は、公開済みの参選で当選（elected）し、その選挙の投票日が過ぎているものだけ。落選・退選・当落未記録の人の公約は追わない（当落は election_results／elected_missing 臂が決める）。
--   公約以外（policy_address／assembly／budget）は office_ids[1] の任期の人物。last_updated が NULL なら created_at の日付（東京）
CREATE OR REPLACE FUNCTION policy_jp.progress_subjects()
RETURNS TABLE (policy_id TEXT, title TEXT, category TEXT, status TEXT, origin TEXT, last_updated DATE,
               politician_id TEXT, politician_name TEXT, politician_kana TEXT, politician_election_id TEXT, candidacy_status TEXT,
               election_id TEXT, election_name TEXT, election_type TEXT, election_date DATE, lg_code TEXT, lg_name TEXT, pref_name TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT pl.id, pl.title, pl.category, pl.status, pl.origin,
         COALESCE(pl.last_updated, (pl.created_at AT TIME ZONE 'Asia/Tokyo')::DATE),
         pp.id, pp.name, pp.kana, pe.id, pe.candidacy_status,
         e.id, e.name, e.election_type, e.election_date,
         COALESCE(pl.lg_code, e.lg_code, o.lg_code),
         COALESCE(g.name, '（自治体名未確認）'),
         COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(COALESCE(pl.lg_code, e.lg_code, o.lg_code))), '（都道府県名未確認）')
    FROM policy_jp.policies pl
    LEFT JOIN policy_jp.politician_elections pe ON pe.id = pl.politician_election_id AND pe.review_status = 'published'
    LEFT JOIN policy_jp.politician_offices o ON o.id = pl.office_ids[1] AND pl.politician_election_id IS NULL AND o.review_status = 'published'
    JOIN policy_jp.politicians pp ON pp.id = COALESCE(pe.politician_id, o.politician_id) AND pp.review_status = 'published'
    LEFT JOIN policy_jp.elections e ON e.id = COALESCE(pe.election_id, o.election_id)
    LEFT JOIN policy_jp.local_governments g ON g.lg_code = COALESCE(pl.lg_code, e.lg_code, o.lg_code)
   WHERE pl.review_status = 'published'
     AND pl.status NOT IN ('achieved', 'discontinued', 'unfulfilled')
     AND (pl.origin <> 'pledge' OR (pe.candidacy_status = 'elected' AND e.election_date < policy_jp.activity_today()))
$$;
COMMENT ON FUNCTION policy_jp.progress_subjects IS
  '進捗追跡の対象になる政策（progress_stale／deadline_due 臂が共有）：公開済みで、achieved／discontinued／unfulfilled 以外で、人物が引けるもの。公約は当選済みで投票日が過ぎたものだけ（当落未記録・落選・退選の人は追わない）。last_updated が NULL なら created_at の日付（東京）';

-- 期限が過ぎた政策：原文に書かれた達成期限（policy_elements の deadline、stated で日付あり、公開済み）が今日より前で、期限より後の進捗記録（公開済みの tracking_logs）が 1 件もない
CREATE OR REPLACE FUNCTION policy_jp.deadline_due_subjects()
RETURNS TABLE (policy_id TEXT, deadline_date DATE, deadline_text TEXT, deadline_locator TEXT, deadline_source_url TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT s.policy_id, d.deadline_date, d.text, d.source_locator,
         (SELECT x.url FROM policy_jp.source_refs sr JOIN policy_jp.sources x ON x.id = sr.source_id
           WHERE sr.target_table = 'policy_elements' AND sr.target_id = d.id
           ORDER BY (sr.role = 'primary') DESC, sr.created_at, x.id LIMIT 1)
    FROM policy_jp.progress_subjects() s
    JOIN policy_jp.policy_elements d ON d.policy_id = s.policy_id AND d.element = 'deadline' AND d.stated AND d.deadline_date IS NOT NULL AND d.review_status = 'published'
   WHERE d.deadline_date < policy_jp.activity_today()
     AND NOT EXISTS (SELECT 1 FROM policy_jp.tracking_logs tl WHERE tl.policy_id = s.policy_id AND tl.review_status = 'published' AND tl.date > d.deadline_date)
$$;
COMMENT ON FUNCTION policy_jp.deadline_due_subjects IS
  '達成期限が過ぎた政策（deadline_due 臂の対象。progress_stale 臂は『ここに入る政策は出さない』ために使う）：progress_subjects() のうち、公開済みの deadline 要素（stated・日付あり）が今日より前で、期限より後の公開済みの経過が 1 件もないもの';

-- ------------------------------------------------------------
-- 4. 臂 progress_stale（最後の更新から stale_days 日以上、経過の記録がない）
-- ------------------------------------------------------------
-- 規則（activity_rules「progress_stale」）の params：cap（同時に開く最大件数）、stale_days（何日動きがなければ出すか）。窓の開閉（enabled）は総表が決める。
-- deadline_due の対象は出さない（期限が過ぎた確認が先。正見の総表と同じ）。古い順に cap 件
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_progress_stale()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap, (r.params->>'stale_days')::INTEGER AS stale_days
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'progress_stale' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  due AS MATERIALIZED (SELECT d.policy_id FROM policy_jp.deadline_due_subjects() d),
  gaps AS (
    SELECT s.*, cfg.stale_days,
           (SELECT max(tl.date) FROM policy_jp.tracking_logs tl WHERE tl.policy_id = s.policy_id AND tl.review_status = 'published') AS last_log_date
      FROM policy_jp.progress_subjects() s CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL AND cfg.stale_days IS NOT NULL
       AND s.last_updated < policy_jp.activity_today() - cfg.stale_days
       AND NOT EXISTS (SELECT 1 FROM policy_jp.tracking_logs tl
                        WHERE tl.policy_id = s.policy_id AND tl.review_status = 'published' AND tl.date >= policy_jp.activity_today() - cfg.stale_days)
       AND NOT EXISTS (SELECT 1 FROM due WHERE due.policy_id = s.policy_id)
       AND NOT policy_jp.task_unavailable('auto:progress_stale:' || s.policy_id)
     ORDER BY s.last_updated, s.policy_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT 'auto:progress_stale:' || g.policy_id, 'progress_stale',
         jsonb_build_object('policy_id', g.policy_id, 'policy_title', g.title, 'category', g.category, 'status', g.status, 'origin', g.origin,
                            'politician_id', g.politician_id, 'name', g.politician_name, 'kana', g.politician_kana,
                            'politician_election_id', g.politician_election_id, 'candidacy_status', g.candidacy_status,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'lg_code', g.lg_code, 'lg_name', g.lg_name, 'last_updated', g.last_updated, 'last_log_date', g.last_log_date, 'stale_days', g.stale_days),
         CASE WHEN g.origin = 'pledge' AND g.status = 'not_started' THEN
           '選挙公約「' || g.title || '」（' || g.politician_name || '、' || COALESCE(g.election_name, '') || '、投票日 ' || COALESCE(g.election_date::TEXT, '不明')
             || ' に当選）は、当選から時間が経つのに、まだ「未着手」のままで、' || g.stale_days || ' 日以上、経過の記録がありません。'
         ELSE
           '政策「' || g.title || '」（' || g.politician_name || '、いまの状態：' || policy_jp.policy_status_label(g.status) || '）は、最後の更新（' || g.last_updated || '）から '
             || g.stale_days || ' 日以上、経過の記録がありません。'
         END
           || '**第一歩：それが政策かどうかを判断します。** スローガン・体制づくり・日程・個人の表明は政策ではなく、経過を追えませんし追うべきでもありません。'
           || 'そう判断したら contribution_type=removal で報告します（payload は target_table=policies・target_id=' || g.policy_id || '・reason は 20 字以上でなぜ政策でないか。3 票必要）。その項目を埋めようとはしないでください。'
           || '政策であれば、施政方針・市政報告・議会の会議録・予算書や決算・自治体の広報・報道で、この政策のその後（着手したか、どこまで進んだか、取りやめになったか）を調べます。'
           || '見つかったら contribution_type=policy_progress で提出します：payload は policy_id（' || g.policy_id || '）・status（not_started 未着手／in_progress 進行中／partial 一部達成／achieved 達成／discontinued 中止／unfulfilled 任期中に未達成）・'
           || 'date（その出来事の日付 YYYY-MM-DD。今日より先は不可）・note（10 字以上：何が起きたか、どの文書のどこに書いてあるか）。source_urls には読んだページを入れます。'
           || 'discontinued は自治体・議会が取りやめを明確に決めたときだけで、*.lg.jp・*.go.jp・自治体の公式サイトなど公的な出典が 1 つ以上必要です。unfulfilled は公約だけが使え、任期の終わりの時点で達成できていないときに使います。'
           || '出典に書かれた事実だけを note に書き、本人や支持者の発信だけで「達成」と決めないでください。'
           || '調べても近況に新しい動きが本当に見つからなければ、contribution_type=no_change、outcome=not_found、task_id（auto:progress_stale:' || g.policy_id || '）、checked_urls に調べた場所を入れて報告します。それも成果で、しばらく同じ任務は配られません。',
         ARRAY[g.lg_name || ' の公式サイト（施政方針・市政報告・広報）', '議会の会議録（会議録検索システム）', '予算書・決算書・主要施策の成果報告書',
               '政策そのものの出典（target.policy_id の source_refs）', g.pref_name || ' の公式サイト']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_progress_stale IS
  '政策の進捗が止まっている（正見 raw:progress_stale の日本版）：追跡対象の政策（progress_subjects）で、最終更新が stale_days 日（規則の params、既定 90）より前で、その間の公開済みの経過が 1 件もなく、deadline_due の対象でもない → progress_stale 任務'
  '（1 政策 1 件、task_id＝auto:progress_stale:<政見 id>）。公約で未着手のままのものは文言が違う。古い順に cap 件。窓（規則の enabled）は総表が決める。標準の冷却（not_found 14 日）で、遞増はない';

-- ------------------------------------------------------------
-- 5. 臂 deadline_due（原文の達成期限が過ぎ、期限より後の経過がない）
-- ------------------------------------------------------------
-- 規則（activity_rules「deadline_due」）の params.cap だけ読む。期限が早い順に cap 件
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_deadline_due()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'deadline_due' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*, d.deadline_date, d.deadline_text, d.deadline_locator, d.deadline_source_url,
           (SELECT max(tl.date) FROM policy_jp.tracking_logs tl WHERE tl.policy_id = s.policy_id AND tl.review_status = 'published') AS last_log_date
      FROM policy_jp.deadline_due_subjects() d
      JOIN policy_jp.progress_subjects() s ON s.policy_id = d.policy_id
      CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL
       AND NOT policy_jp.task_unavailable('auto:deadline_due:' || s.policy_id)
     ORDER BY d.deadline_date, s.policy_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT 'auto:deadline_due:' || g.policy_id, 'deadline_due',
         jsonb_build_object('policy_id', g.policy_id, 'policy_title', g.title, 'category', g.category, 'status', g.status, 'origin', g.origin,
                            'politician_id', g.politician_id, 'name', g.politician_name, 'kana', g.politician_kana,
                            'politician_election_id', g.politician_election_id, 'candidacy_status', g.candidacy_status,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'lg_code', g.lg_code, 'lg_name', g.lg_name, 'last_updated', g.last_updated, 'last_log_date', g.last_log_date,
                            'deadline_date', g.deadline_date, 'deadline_text', g.deadline_text, 'deadline_source_url', g.deadline_source_url,
                            'deadline_source_locator', g.deadline_locator),
         '政策「' || g.title || '」（' || g.politician_name || '）の原文に書かれた達成期限は「' || g.deadline_text || '」（' || g.deadline_date || ' に換算）で、すでに過ぎています。'
           || 'いまの状態は「' || policy_jp.policy_status_label(g.status) || '」で、期限より後の経過の記録がありません。'
           || '期限が来て、実際にどうなったかを調べてください（施政方針・市政報告・議会の会議録・予算書や決算・自治体の広報・報道）。'
           || '結果が分かったら contribution_type=policy_progress で提出します：payload は policy_id（' || g.policy_id || '）・status（not_started 未着手／in_progress 進行中／partial 一部達成／achieved 達成／discontinued 中止／unfulfilled 任期中に未達成）・'
           || 'date（その出来事の日付 YYYY-MM-DD）・note（期限と比べた結果を具体的に。例：「当初は 2025 年度末の完成予定だったが、2026 年 3 月に開通した」）。source_urls には読んだページを入れます。'
           || 'discontinued は自治体・議会が取りやめを明確に決めたときだけで、*.lg.jp・*.go.jp・自治体の公式サイトなど公的な出典が 1 つ以上必要です。unfulfilled は公約だけが使えます。'
           || '調べても、期限より後の動きが本当に見つからなければ、contribution_type=no_change、outcome=not_found、task_id（auto:deadline_due:' || g.policy_id || '）、checked_urls に調べた場所を入れて報告します。'
           || '「未達成」と自分で決めつけないでください。結果が出典に書かれていることが必要です。',
         ARRAY[g.lg_name || ' の公式サイト（施政方針・市政報告・広報）', '議会の会議録（会議録検索システム）', '予算書・決算書・主要施策の成果報告書',
               '期限を書いた原文（target.deadline_source_url）', g.pref_name || ' の公式サイト']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_deadline_due IS
  '達成期限が過ぎた政策（正見 deadline_due の日本版）：deadline_due_subjects() に入る政策 → deadline_due 任務（1 政策 1 件、task_id＝auto:deadline_due:<政見 id>）。期限が早い順に cap 件。'
  '窓（規則の enabled）は総表が決める。標準の冷却（not_found 14 日）で、遞増はない';

-- ------------------------------------------------------------
-- 6. 臂名清單・総表・層内順位：20261011190000 の版に 名前 2 つ／UNION 2 行／WHEN 2 行を足しただけ（残りは一字も変えない）
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
    'term_policies',
    'progress_stale',
    'deadline_due'
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
  UNION ALL SELECT 'progress_stale' AS arm, t.* FROM policy_jp.contribution_auto_tasks_progress_stale() t
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM policy_jp.contribution_auto_tasks_deadline_due() t
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
                  WHEN 'progress_stale' THEN 9
                  WHEN 'deadline_due' THEN 9
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／candidate_status_stale／not_running_recheck／candidacy_source_missing／district_seats_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing／duplicate_policy／term_policy_missing 8、progress_stale／deadline_due 9（任期中の追跡は鎖の最後）。登録のない auto 型別も 9';


-- ------------------------------------------------------------
-- 7. 規則（enabled・既定）と主控台の段（冪等）
-- ------------------------------------------------------------
-- 窓＝常時、after_step なし（理由は檔頭の a）。優先層の専用規則は置かない＝既定の層（檔頭の b）。同時に開くのは最大 100 件。progress_stale は stale_days（90 日）動きがなければ出す
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'progress_stale', 'always', 'announced',
       '{"cap":100,"stale_days":90}'::JSONB,
       '政策の進捗追跡（正見 raw:progress_stale）：追跡対象の政策（公開済み・終わっていない・公約は当選済み）で、最終更新から stale_days 日経過の記録がないものを、代理に調べさせる（policy_progress／政策でなければ removal／新しい動きがなければ no_change）。deadline_due の対象は出さない。'
       || '窓は常時・鎖に掛けない（正見は就任日起算の term 窓だが、日本版にはまだ term_start 里程碑がない）。同時に開くのは最大 100 件（古い順）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'progress_stale' AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'deadline_due', 'always', 'announced',
       '{"cap":100}'::JSONB,
       '達成期限が過ぎた政策の確認（正見 deadline_due）：原文に書かれた達成期限が過ぎ、期限より後の経過の記録がない政策を、代理に調べさせる（policy_progress／新しい動きがなければ no_change）。'
       || '窓は常時・鎖に掛けない（正見は就任日起算の term 窓だが、日本版にはまだ term_start 里程碑がない）。同時に開くのは最大 100 件（期限が早い順）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'deadline_due' AND r.priority IS NULL);

-- 主控台時間軸の段：どちらも『任期中』（6）。規則は常時窓なので、この登記が採用される（正見は term_start 起算で自動的に 6）
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('progress_stale', 6, '任期中の政策の進捗確認（経過の記録が止まっている）'),
  ('deadline_due', 6, '達成期限が過ぎた政策の確認')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 8. 權限（新函式は PUBLIC に実行権が付くので明示的に収回）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_progress_stale(), policy_jp.contribution_auto_tasks_deadline_due(),
  policy_jp.progress_subjects(), policy_jp.deadline_due_subjects(), policy_jp.apply_policy_progress(policy_jp.contributions), policy_jp.policy_status_label(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_progress_stale(), policy_jp.contribution_auto_tasks_deadline_due(),
  policy_jp.progress_subjects(), policy_jp.deadline_due_subjects(), policy_jp.apply_policy_progress(policy_jp.contributions), policy_jp.policy_status_label(TEXT)
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
  -- 規則：存在、開いている、常時窓、鎖に掛けない（after_step なし）、cap（progress_stale は stale_days も）
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'progress_stale' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'always'
                    AND r.after_step IS NULL AND r.params ? 'cap' AND r.params ? 'stale_days') THEN
    RAISE EXCEPTION 'policy_jp：progress_stale の規則が「開いている・常時窓・after_step なし・cap／stale_days あり」になっていない';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'deadline_due' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'always'
                    AND r.after_step IS NULL AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：deadline_due の規則が「開いている・常時窓・after_step なし・cap あり」になっていない';
  END IF;
  -- 優先層：専用規則を置かない（既定の層）
  IF EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity IN ('priority:progress_stale', 'priority:deadline_due')) THEN
    RAISE EXCEPTION 'policy_jp：progress_stale／deadline_due に優先層の専用規則を置かない（既定の層）';
  END IF;
  -- 三處一起加
  IF NOT ('progress_stale' = ANY (policy_jp.activity_arm_names())) OR NOT ('deadline_due' = ANY (policy_jp.activity_arm_names())) THEN
    RAISE EXCEPTION 'policy_jp：activity_arm_names() に progress_stale／deadline_due がない';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_progress_stale()%'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_deadline_due()%') <> 1 THEN
    RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 総表に progress_stale／deadline_due の分支がない';
  END IF;
  IF policy_jp.chain_step_rank('auto:progress_stale:x', 'progress_stale') <> 9
     OR policy_jp.chain_step_rank('auto:deadline_due:x', 'deadline_due') <> 9
     OR policy_jp.chain_step_rank('auto:term_policy_missing:x', 'term_policy_missing') <> 8
     OR policy_jp.chain_step_rank('auto:duplicate_policy:x:y', 'duplicate_policy') <> 8
     OR policy_jp.chain_step_rank('auto:policy_missing:x', 'policy_missing') <> 6
     OR policy_jp.chain_step_rank('auto:something_new:x', 'something_new') <> 9 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank の登録がおかしい';
  END IF;
  IF (SELECT count(*) FROM policy_jp.console_arm_stage_map m WHERE (m.arm, m.stage) IN (('progress_stale', 6), ('deadline_due', 6))) <> 2 THEN
    RAISE EXCEPTION 'policy_jp：console_arm_stage_map に progress_stale／deadline_due（6）がない';
  END IF;
  -- 交件型別：DB CHECK と落庫清單
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%policy_progress%') THEN
    RAISE EXCEPTION 'policy_jp：policy_jp_contributions_type_check に policy_progress がない';
  END IF;
  IF NOT ('policy_progress' = ANY (policy_jp.apply_types())) OR NOT ('removal' = ANY (policy_jp.apply_types())) THEN
    RAISE EXCEPTION 'policy_jp：apply_types() に policy_progress／removal がない';
  END IF;
  IF pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_policy_progress%'
     OR pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_removal%' THEN
    RAISE EXCEPTION 'policy_jp：apply_contribution に policy_progress の WHEN がない（または removal の WHEN が消えた）';
  END IF;
  -- 共識は動かさない：policy_progress は 1 つの網段でよい・目標 3・（jp-system-one の候選には入れない）
  IF policy_jp.contribution_needs_two_ips('policy_progress', '{}'::JSONB)
     OR policy_jp.contribution_required_agree('policy_progress', '{}'::JSONB, ARRAY[]::TEXT[]) <> 3
     OR 'policy_progress' = ANY (policy_jp.system_one_precheck_types()) THEN
    RAISE EXCEPTION 'policy_jp：policy_progress の共識（網段 1 つ・目標 3・jp-system-one の候選に入らない）が期待と違う';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_progress_stale()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_deadline_due()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.progress_subjects()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.deadline_due_subjects()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_policy_progress(policy_jp.contributions)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：政策の進捗の関数を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
