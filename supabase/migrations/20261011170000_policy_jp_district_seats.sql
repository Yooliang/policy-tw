-- 日本站派工臂對齊正見：議員定数（district_seats）。工作單 Yooliang/policy-ops#95、計畫 policy-jp docs/PLAN-arms-parity.md 第 2b 步
-- ============================================================
--
--   正見臂                    日本臂（activity）  任務型別（task_type）      task_id                                    交件
--   district_seats_missing    district_seats     district_seats_missing     auto:district_seats_missing:<選挙 id>      district_seats（定数＋選挙区の定数）／no_change（原文が見つからない）
--
--   正見：_shared/district-seats.ts、contribution-schema.ts の district_seats、apply-contribution.ts の applyDistrictSeats、public/skill-types.md「district_seats_missing」。
--   日本站のちがい：表は policy_jp.election_districts（選挙区一つ一行：district_kind／district_name〔at_large のときだけ NULL〕／seats／seats_basis）と
--   policy_jp.elections.seats（その選挙の定数の合計）。対象は議会議員選挙（pref_assembly／muni_assembly）だけ。市町村議会はふつう at_large 一つ、都道府県議会は選挙区ごとに並べる。
--
-- この支でやること（新增一支派工臂＝三處一起加）：
-- 1. 臂 contribution_auto_tasks_district_seats()：総表に一行 UNION、activity_arm_names() に名前、activity_rules に規則を 1 条。
--    規則は **enabled = true**（2a の policy_elements とちがい最初から開く）。窓＝投票日当日まで（until polling +0、起点なし）。after_step なし（選挙鎖の前段を待たない：
--    定数は候補者が出る前から条例で決まっているので、鎖のどの段にも依存しない）。params：cap＝同時に開く最大件数（100）。
-- 2. 交件型別 district_seats：DB CHECK（policy_jp_contributions_type_check）、apply_types()、落庫 apply_district_seats()、apply_contribution に WHEN 1 行。
-- 3. 同一件事（#521 登記表）：district_seats を SAME_CLAIM_REGISTRY に登記（鍵＝選挙 id）。same_claim_matches の分派器・same_claim_same_content・収編触発器の型別清單に足す。
-- 4. chain_step_rank に WHEN 1 行（district_seats_missing＝4：参選段〔名簿・候補者の状態〕と同じ順位。定数は候補者の立つ土台なので後ろに回さない）。
--
-- 設計の判斷：
-- a. 検査は TS（_shared/jp/contribution-schema.ts の district_seats）と SQL（district_seats_normalize）に同じ規則：seats_total 1～200、seats_basis は law／notice、
--    districts 1～100 件、各件は district_kind（at_large／district）・district_name〔district のとき必須、at_large のときは付けない〕・district_lg_code〔district のときだけ任意、
--    6 桁。庫の local_governments に在るかは落庫で確かめる〕・seats 1～200。at_large と district は混ぜない、at_large は 1 件だけ、(kind, name) の重複なし、seats の合計＝seats_total。
-- b. conflict の扱いは apply_policy_elements と同じ『上書きしない』：
--    - elections.seats がすでにあって seats_total と違う → 全体を conflict（直すなら correction）。
--    - 庫に別の種類（at_large と district）の選挙区行がある → conflict。
--    - 選挙区ごとに、庫の seats が違う値 → conflict。庫の選挙区行で提出に含まれないものがある（合計が seats_total にならなくなる）→ conflict。
--    - 全部が庫と同じ → unchanged（出典だけ足す）。seats が空の行は埋める（seats_basis も一緒）。無い行は挿入。elections.seats が空なら seats_total で埋める。
--    半分だけ書くことはしない（1 周目で検査と衝突の洗い出し、2 周目で書く）。
-- c. 出典：source_refs に交件の source_urls を掛ける（target_table＝election_districts〔行 id〕と elections〔選挙 id〕）。履歴は edit_history（agent_name='auto-apply'）。
-- d. 任務の收回：contributions_drop_dispatch（status→applied）が task_dispatches の行を落とす。全選挙区が埋まれば臂が出さなくなる＝filled。
-- e. 窓は投票日までなので、投票後に定数が空のままの選挙は派工から外れる（収回の理由は window）。投票後に分かったら correction か、規則の窓を直す migration。
--
-- 守門：supabase/functions/_shared/policy-jp-district-seats.test.ts、policy-jp-dispatch-drift.test.ts（登記）、same-claims.test.ts、
-- jp/contribution-schema*.test.ts。不碰 public、ditrust。冪等（規則は NOT EXISTS、登記は ON CONFLICT）、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 交件型別 district_seats：DB CHECK と落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'no_change']::TEXT[]
$$;

-- ------------------------------------------------------------
-- 2. 落庫：交件の正規化（検査）と署名
-- ------------------------------------------------------------
-- 交件 payload → {seats_total, seats_basis, kind, districts:[{district_kind, district_name, district_lg_code, seats}]}。不備は {problem}。TS（contribution-schema.ts の district_seats）と同じ規則
CREATE OR REPLACE FUNCTION policy_jp.district_seats_normalize(p JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_total INTEGER;
  v_basis TEXT;
  x JSONB;
  v_kind TEXT;
  v_name TEXT;
  v_lg TEXT;
  v_raw TEXT;
  v_seats INTEGER;
  v_out JSONB := '[]'::JSONB;
  v_keys TEXT[] := '{}';
  v_key TEXT;
  v_sum INTEGER := 0;
  v_kinds TEXT[] := '{}';
BEGIN
  IF jsonb_typeof(p->'seats_total') IS DISTINCT FROM 'number' OR (p->>'seats_total') !~ '^[0-9]{1,3}$' THEN
    RETURN jsonb_build_object('problem', 'seats_total は 1～200 の整数（その選挙の議員定数の合計）');
  END IF;
  v_total := (p->>'seats_total')::INTEGER;
  IF v_total NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('problem', 'seats_total は 1～200 の整数（その選挙の議員定数の合計）');
  END IF;
  v_basis := p->>'seats_basis';
  IF v_basis IS NULL OR v_basis NOT IN ('law', 'notice') THEN
    RETURN jsonb_build_object('problem', 'seats_basis は law（議員定数条例）か notice（選挙管理委員会の告示）');
  END IF;
  IF jsonb_typeof(p->'districts') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'districts') NOT BETWEEN 1 AND 100 THEN
    RETURN jsonb_build_object('problem', 'districts は 1～100 件の配列（市町村議会で選挙区がなければ at_large を 1 件）');
  END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(p->'districts') LOOP
    IF jsonb_typeof(x) IS DISTINCT FROM 'object' THEN
      RETURN jsonb_build_object('problem', 'districts の各件はオブジェクト（district_kind, district_name, district_lg_code, seats）');
    END IF;
    v_kind := x->>'district_kind';
    IF v_kind IS NULL OR v_kind NOT IN ('at_large', 'district') THEN
      RETURN jsonb_build_object('problem', 'district_kind は at_large（選挙区なし・全域で一つ）か district（選挙区）');
    END IF;
    v_name := NULLIF(policy_jp.policy_trim(x->>'district_name'), '');
    IF v_kind = 'district' THEN
      IF v_name IS NULL OR char_length(v_name) > 50 THEN
        RETURN jsonb_build_object('problem', 'district_kind=district のときは district_name 必須（選挙区の名前、50 字まで。例：「千種区」「第1選挙区」）');
      END IF;
    ELSIF v_name IS NOT NULL THEN
      RETURN jsonb_build_object('problem', 'district_kind=at_large のときは district_name を付けない');
    END IF;
    v_raw := NULLIF(policy_jp.policy_trim(x->>'district_lg_code'), '');
    IF v_raw IS NOT NULL THEN
      IF v_kind <> 'district' THEN
        RETURN jsonb_build_object('problem', 'district_lg_code は district_kind=district のときだけ付けられる');
      END IF;
      IF v_raw !~ '^[0-9]{6}$' THEN
        RETURN jsonb_build_object('problem', 'district_lg_code は団体コード 6 桁（選挙区がその団体の区域のときだけ。区域が複数にまたがるときは付けない）');
      END IF;
    END IF;
    v_lg := v_raw;
    IF jsonb_typeof(x->'seats') IS DISTINCT FROM 'number' OR (x->>'seats') !~ '^[0-9]{1,3}$' OR (x->>'seats')::INTEGER NOT BETWEEN 1 AND 200 THEN
      RETURN jsonb_build_object('problem', 'seats は 1～200 の整数（その選挙区の定数）');
    END IF;
    v_seats := (x->>'seats')::INTEGER;
    v_key := v_kind || '|' || COALESCE(v_name, '');
    IF v_key = ANY (v_keys) THEN
      RETURN jsonb_build_object('problem', format('選挙区が重複している：%s', COALESCE(v_name, '（at_large）')));
    END IF;
    v_keys := v_keys || v_key;
    IF NOT (v_kind = ANY (v_kinds)) THEN v_kinds := v_kinds || v_kind; END IF;
    v_sum := v_sum + v_seats;
    v_out := v_out || jsonb_build_array(jsonb_build_object('district_kind', v_kind, 'district_name', v_name, 'district_lg_code', v_lg, 'seats', v_seats));
  END LOOP;
  IF cardinality(v_kinds) > 1 THEN
    RETURN jsonb_build_object('problem', 'at_large と district を一つの交件に混ぜない（選挙区がなければ at_large を 1 件、あれば district だけ）');
  END IF;
  IF v_kinds[1] = 'at_large' AND jsonb_array_length(v_out) <> 1 THEN
    RETURN jsonb_build_object('problem', 'at_large は 1 件だけ');
  END IF;
  IF v_sum <> v_total THEN
    RETURN jsonb_build_object('problem', format('seats の合計（%s）が seats_total（%s）と合わない', v_sum, v_total));
  END IF;
  RETURN jsonb_build_object('seats_total', v_total, 'seats_basis', v_basis, 'kind', v_kinds[1], 'districts', v_out);
END;
$$;
COMMENT ON FUNCTION policy_jp.district_seats_normalize IS
  '議員定数の交件の検査と正規化（{seats_total, seats_basis, kind, districts[]}、不備は {problem}）。at_large と district は混ぜない、at_large は 1 件、重複なし、合計＝seats_total。TS 版 contribution-schema.ts の district_seats と同じ規則';

-- 署名：総定数・根拠・(種類, 名前, 定数) の並び（順序を問わず同じなら同じ文字列）。不備は NULL
CREATE OR REPLACE FUNCTION policy_jp.district_seats_signature(p JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE WHEN NOT (n ? 'problem')
              THEN (n->>'seats_total') || '|' || (n->>'seats_basis') || '|'
                   || (SELECT string_agg((d->>'district_kind') || ':' || COALESCE(d->>'district_name', '') || ':' || (d->>'seats'), ';' ORDER BY d->>'district_kind', d->>'district_name')
                         FROM jsonb_array_elements(n->'districts') d)
         END
    FROM (SELECT policy_jp.district_seats_normalize(p) AS n) q
$$;
COMMENT ON FUNCTION policy_jp.district_seats_signature IS '議員定数の交件の署名（総定数・根拠・選挙区ごとの定数）。same_claim_same_content が使う';

-- ------------------------------------------------------------
-- 3. 落庫 apply_district_seats（正見 applyDistrictSeats の日本版）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_district_seats(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_eid TEXT := NULLIF(policy_jp.policy_trim(p->>'election_id'), '');
  el policy_jp.elections%ROWTYPE;
  n JSONB;
  d JSONB;
  ex policy_jp.election_districts%ROWTYPE;
  v_new policy_jp.election_districts%ROWTYPE;
  v_total INTEGER;
  v_basis TEXT;
  v_kind TEXT;
  v_conflicts TEXT[] := '{}';
  v_written TEXT[] := '{}';
  v_same TEXT[] := '{}';
  v_label TEXT;
  v_src BIGINT;
  v_bad_lg TEXT;
  v_extra TEXT;
  v_total_set BOOLEAN := false;
BEGIN
  IF v_eid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'election_id がない（任務の target.election_id を使う）');
  END IF;
  SELECT * INTO el FROM policy_jp.elections WHERE id = v_eid;
  IF NOT FOUND OR el.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('選挙 %s は登録されていないか、まだ公開されていない', v_eid));
  END IF;
  IF el.election_type NOT IN ('pref_assembly', 'muni_assembly') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('選挙 %s は議会議員選挙（pref_assembly／muni_assembly）ではない：議員定数を記録できるのは議会議員選挙だけ', v_eid));
  END IF;
  n := policy_jp.district_seats_normalize(p);
  IF n ? 'problem' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', n->>'problem');
  END IF;
  v_total := (n->>'seats_total')::INTEGER;
  v_basis := n->>'seats_basis';
  v_kind := n->>'kind';
  SELECT string_agg(DISTINCT x->>'district_lg_code', '、') INTO v_bad_lg
    FROM jsonb_array_elements(n->'districts') x
   WHERE x->>'district_lg_code' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM policy_jp.local_governments g WHERE g.lg_code = x->>'district_lg_code');
  IF v_bad_lg IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('district_lg_code（%s）が団体表にない：総務省の団体コードを確かめる', v_bad_lg));
  END IF;
  v_src := policy_jp.source_write(NULL, NULL, c.source_urls, 'district_seats');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  -- 1 周目：衝突の洗い出し（何も書かない）
  IF el.seats IS NOT NULL AND el.seats <> v_total THEN
    v_conflicts := v_conflicts || format('選挙の定数 %s（提出 %s）', el.seats, v_total);
  END IF;
  IF EXISTS (SELECT 1 FROM policy_jp.election_districts x WHERE x.election_id = v_eid AND x.district_kind <> v_kind) THEN
    v_conflicts := v_conflicts || '別の種類（at_large/district）の選挙区行'::TEXT;
  END IF;
  FOR d IN SELECT * FROM jsonb_array_elements(n->'districts') LOOP
    SELECT * INTO ex FROM policy_jp.election_districts x
     WHERE x.election_id = v_eid AND x.district_kind = d->>'district_kind' AND x.district_name IS NOT DISTINCT FROM (d->>'district_name');
    IF FOUND AND ex.seats IS NOT NULL AND ex.seats <> (d->>'seats')::INTEGER THEN
      v_conflicts := v_conflicts || format('%s の定数 %s（提出 %s）', COALESCE(d->>'district_name', '全域'), ex.seats, d->>'seats');
    END IF;
  END LOOP;
  SELECT string_agg(COALESCE(x.district_name, '全域'), '、') INTO v_extra
    FROM policy_jp.election_districts x
   WHERE x.election_id = v_eid
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(n->'districts') s WHERE s->>'district_kind' = x.district_kind AND (s->>'district_name') IS NOT DISTINCT FROM x.district_name);
  IF v_extra IS NOT NULL THEN
    v_conflicts := v_conflicts || format('庫にある選挙区（%s）が提出に含まれず、合計が seats_total にならない', v_extra);
  END IF;
  IF cardinality(v_conflicts) > 0 THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'election_districts', 'record_id', v_eid,
      'message', format('庫にすでに違う内容がある（%s）。上書きしない（直すなら correction）', array_to_string(v_conflicts, '；')));
  END IF;

  -- 2 周目：書く（庫と同じ行は出典だけ足す。seats が空の行は埋める。無い行は挿入）
  FOR d IN SELECT * FROM jsonb_array_elements(n->'districts') LOOP
    v_label := COALESCE(d->>'district_name', '全域') || ' ' || (d->>'seats');
    SELECT * INTO ex FROM policy_jp.election_districts x
     WHERE x.election_id = v_eid AND x.district_kind = d->>'district_kind' AND x.district_name IS NOT DISTINCT FROM (d->>'district_name');
    IF NOT FOUND THEN
      INSERT INTO policy_jp.election_districts (election_id, district_kind, district_name, district_lg_code, seats, seats_basis)
      VALUES (v_eid, d->>'district_kind', d->>'district_name', d->>'district_lg_code', (d->>'seats')::INTEGER, v_basis)
      RETURNING * INTO v_new;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('election_districts', v_new.id::TEXT, '*', NULL, to_jsonb(v_new), c.id, 'auto-apply');
      PERFORM policy_jp.source_write('election_districts', v_new.id::TEXT, c.source_urls, 'district_seats');
      v_written := v_written || v_label;
    ELSIF ex.seats IS NULL THEN
      UPDATE policy_jp.election_districts SET seats = (d->>'seats')::INTEGER, seats_basis = v_basis, updated_at = now()
       WHERE id = ex.id
       RETURNING * INTO v_new;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('election_districts', ex.id::TEXT, '*', to_jsonb(ex), to_jsonb(v_new), c.id, 'auto-apply');
      PERFORM policy_jp.source_write('election_districts', ex.id::TEXT, c.source_urls, 'district_seats');
      v_written := v_written || v_label;
    ELSE
      PERFORM policy_jp.source_write('election_districts', ex.id::TEXT, c.source_urls, 'district_seats');
      v_same := v_same || v_label;
    END IF;
  END LOOP;
  IF el.seats IS NULL THEN
    UPDATE policy_jp.elections SET seats = v_total, updated_at = now() WHERE id = v_eid;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('elections', v_eid, 'seats', NULL, to_jsonb(v_total), c.id, 'auto-apply');
    v_total_set := true;
  END IF;
  PERFORM policy_jp.source_write('elections', v_eid, c.source_urls, 'district_seats');

  IF cardinality(v_written) = 0 AND NOT v_total_set THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'election_districts', 'record_id', v_eid,
      'message', format('「%s」の議員定数 %s は庫に同じ内容で既にある（%s）', el.name, v_total, array_to_string(v_same, '；')));
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'election_districts', 'record_id', v_eid,
    'message', format('「%s」の議員定数 %s を記録：%s%s', el.name, v_total, COALESCE(NULLIF(array_to_string(v_written, '；'), ''), '選挙の定数のみ'),
                      CASE WHEN cardinality(v_same) > 0 THEN format('（%s は庫と同じなので出典だけ追加）', array_to_string(v_same, '；')) ELSE '' END));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_district_seats IS
  'district_seats 交件の落庫（正見 applyDistrictSeats の日本版）：議会議員選挙 1 件の定数合計（elections.seats）と選挙区ごとの定数（election_districts）。庫に無い行は挿入、seats が空の行は埋める、同じ値は出典だけ追加。'
  '違う値・別の種類の行・提出に含まれない庫の行が 1 つでもあれば全体を conflict（上書きしない）。出典は source_refs（election_districts／elections）、履歴は edit_history';

-- 落庫主函式：20261011140000 の版に district_seats の WHEN を 1 行足しただけ（残りは一字も変えない）
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
-- 4. 臂：district_seats（議員定数がまだ記録されていない議会議員選挙）
-- ------------------------------------------------------------
-- 開いている選挙（chain_open_elections）の公開済み議会議員選挙で、elections.seats が空、選挙区行が 1 件もない、または seats が空の行がある → 1 選挙 1 件。
-- 規則（activity_rules「district_seats」）の params.cap だけ読む。窓の開閉は総表が決める
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_district_seats()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'district_seats' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  inflight AS (
    -- もう誰かが交件して、票待ち・自動再試行中：先に派さない（二人のエージェントが同じ選挙を割らないように）。退件されれば戻る
    SELECT DISTINCT c.payload->>'election_id' AS election_id
      FROM policy_jp.contributions c
     WHERE c.contribution_type = 'district_seats' AND c.status IN ('pending', 'verified', 'disputed', 'apply_failed')
  ),
  cand AS MATERIALIZED (
    SELECT e.id AS election_id, e.name AS election_name, e.election_type, e.election_date, e.notice_date, e.lg_code, e.seats, g.name AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)), '（都道府県名未確認）') AS pref_name,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('district_kind', d.district_kind, 'district_name', d.district_name, 'district_lg_code', d.district_lg_code,
                                                         'seats', d.seats, 'seats_basis', d.seats_basis) ORDER BY d.id)
                       FROM policy_jp.election_districts d WHERE d.election_id = e.id), '[]'::JSONB) AS known_districts
      FROM policy_jp.elections e
      JOIN policy_jp.chain_open_elections o ON o.election_id = e.id AND o.basis = 'published'
      JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
     WHERE e.review_status = 'published' AND e.election_type IN ('pref_assembly', 'muni_assembly')
       AND (e.seats IS NULL
            OR NOT EXISTS (SELECT 1 FROM policy_jp.election_districts d WHERE d.election_id = e.id)
            OR EXISTS (SELECT 1 FROM policy_jp.election_districts d WHERE d.election_id = e.id AND d.seats IS NULL))
  ),
  gaps AS (
    SELECT c.*
      FROM cand c CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.election_id = c.election_id)
       AND NOT policy_jp.task_unavailable('auto:district_seats_missing:' || c.election_id)
     ORDER BY c.election_date, c.election_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT 'auto:district_seats_missing:' || g.election_id, 'district_seats_missing',
         jsonb_build_object('election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type,
                            'lg_code', g.lg_code, 'lg_name', g.lg_name, 'election_date', g.election_date, 'notice_date', g.notice_date,
                            'seats', g.seats, 'known_districts', g.known_districts,
                            'chain_lg_code', g.lg_code),
         g.lg_name || 'の' || g.election_name || '（投票日 ' || g.election_date || '）の議員定数を記録します。'
           || CASE WHEN g.seats IS NOT NULL THEN '選挙の定数としては ' || g.seats || ' が記録されていますが、選挙区ごとの定数が揃っていません（target.known_districts）。'
                   ELSE 'まだ定数が記録されていません。' END
           || CASE g.election_type
                WHEN 'muni_assembly' THEN '市区町村議会は、選挙区を分けず全域で一つ（district_kind=at_large）のことがほとんどです。選挙区が分かれている議会（政令指定都市の区ごとの選挙区など）は、選挙区ごとに district で並べます。'
                ELSE '都道府県議会は選挙区ごとに定数が決まっています。選挙区（district_name）を一つずつ、定数（seats）とあわせて全部並べてください。'
              END
           || '議員定数条例（例規集）か、選挙管理委員会の告示（選挙のお知らせ）に書いてある数字をそのまま写します。立候補者の数・当選者の数から推測しない、前回の定数を流用しない、条例の改正があれば告示日時点の数字を使う。'
           || 'seats_total（その選挙の定数の合計）と districts の seats の合計は必ず一致させます。'
           || 'contribution_type=district_seats で提出します：payload は election_id（' || g.election_id || '）・seats_total・seats_basis（law＝議員定数条例／notice＝選挙管理委員会の告示）・'
           || 'districts［{district_kind（at_large または district）, district_name（district のときだけ必須）, district_lg_code（任意・district のときだけ）, seats}］・'
           || 'resolved_claim（item.current.same_claims を見て決める。誰も出していなければ "new"）。at_large と district は一つの提出に混ぜません。source_urls は条例・告示の原文のページです。'
           || '定数が見つからないときは contribution_type=no_change、outcome=not_found、checked_urls に探した場所を入れて報告してください。',
         ARRAY_REMOVE(ARRAY[
           g.lg_name || '議会議員定数条例（例規集）',
           g.lg_name || '選挙管理委員会の告示・選挙のお知らせ',
           CASE WHEN g.election_type = 'pref_assembly' THEN g.pref_name || ' 選挙管理委員会' END
         ], NULL)::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_district_seats IS
  '議員定数（正見 district_seats_missing の日本版）：開いている選挙（chain_open_elections）の公開済み議会議員選挙で、elections.seats が空・選挙区行がない・seats が空の行がある → district_seats_missing 任務'
  '（1 選挙 1 件、task_id＝auto:district_seats_missing:<選挙 id>、target.known_districts は庫にある選挙区行）。交件待ち（pending／verified／disputed／apply_failed）の選挙は派さない。'
  '窓（規則の enabled・until polling）は総表が決める。params.cap は可派の前 N 件（投票日の近い順）';

-- ------------------------------------------------------------
-- 5. 同一件事（#521）：district_seats の比對本体と分派
-- ------------------------------------------------------------
-- 鍵＝選挙 id。在庫＝その選挙の選挙区行（と、定数の合計が入っていればその 1 行）、審議中＝同じ選挙の district_seats 提出。payload に districts がなくても（探査）同じ結果
CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches_district_seats(p JSONB, p_ip_hash TEXT, p_exclude UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_eid TEXT := NULLIF(p->>'election_id', '');
  v_existing JSONB := '[]'::JSONB;
  v_pending JSONB := '[]'::JSONB;
BEGIN
  IF v_eid IS NULL THEN
    RETURN jsonb_build_object('type', 'district_seats', 'existing', v_existing, 'pending', v_pending);
  END IF;
  SELECT COALESCE(jsonb_agg(y.j ORDER BY y.ord, y.id), '[]'::JSONB) INTO v_existing FROM (
    SELECT 0 AS ord, 0::BIGINT AS id, jsonb_build_object('id', e.id, 'kind', 'total', 'seats', e.seats, 'summary', '定数合計 ' || e.seats,
                                                          'why', '同じ選挙の定数の合計') AS j
      FROM policy_jp.elections e WHERE e.id = v_eid AND e.review_status = 'published' AND e.seats IS NOT NULL
    UNION ALL
    SELECT 1, d.id, jsonb_build_object('id', d.id::TEXT, 'kind', 'district', 'district_kind', d.district_kind, 'district_name', d.district_name,
                                       'district_lg_code', d.district_lg_code, 'seats', d.seats, 'seats_basis', d.seats_basis,
                                       'summary', COALESCE(d.district_name, '全域') || ' ' || COALESCE(d.seats::TEXT, '定数未記録'),
                                       'why', '同じ選挙の選挙区')
      FROM policy_jp.election_districts d WHERE d.election_id = v_eid
  ) y;
  SELECT COALESCE(jsonb_agg(y.j ORDER BY y.created_at), '[]'::JSONB) INTO v_pending FROM (
    SELECT c.created_at, jsonb_build_object(
             'contribution_id', c.id, 'status', c.status, 'agent', c.agent_name, 'sources', to_jsonb(c.source_urls),
             'seats_total', c.payload->'seats_total', 'seats_basis', c.payload->'seats_basis', 'districts', c.payload->'districts',
             'summary', COALESCE(policy_jp.district_seats_signature(c.payload), '?'),
             'yours', p_ip_hash IS NOT NULL AND c.contributor_ip_hash = p_ip_hash,
             'your_network_voted', p_ip_hash IS NOT NULL AND (c.contributor_ip_hash = p_ip_hash
               OR EXISTS (SELECT 1 FROM policy_jp.contribution_votes v WHERE v.contribution_id = c.id AND v.verifier_ip_hash = p_ip_hash))) AS j
      FROM policy_jp.contributions c
     WHERE c.contribution_type = 'district_seats'
       AND c.status IN ('pending', 'disputed', 'verified', 'apply_failed')
       AND (p_exclude IS NULL OR c.id <> p_exclude)
       AND c.payload->>'election_id' = v_eid
     LIMIT 50
  ) y;
  RETURN jsonb_build_object('type', 'district_seats', 'existing', v_existing, 'pending', v_pending);
END;
$$;
COMMENT ON FUNCTION policy_jp.same_claim_matches_district_seats IS
  '同一件事（district_seats）：選挙 id。在庫＝その選挙の定数合計（あれば）と選挙区行、審議中＝同じ選挙の提出。same_claim_matches の分派先';

-- 分派器：20261011140000 の版に district_seats の分岐を足しただけ
CREATE OR REPLACE FUNCTION policy_jp.same_claim_matches(
  p_type TEXT, p_payload JSONB, p_ip_hash TEXT DEFAULT NULL, p_exclude UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = policy_jp, pg_temp AS $$
BEGIN
  IF p_type NOT IN ('election', 'regional_stat', 'local_government', 'politician', 'policy', 'policy_elements', 'district_seats') THEN
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
  IF p_type = 'district_seats' THEN
    RETURN policy_jp.same_claim_matches_district_seats(COALESCE(p_payload, '{}'::JSONB), p_ip_hash, p_exclude);
  END IF;
  RETURN policy_jp.same_claim_matches_base(p_type, p_payload, p_ip_hash, p_exclude);
END;
$$;

-- 収編用の「内容が同じか」：20261011140000 の版に district_seats の WHEN を 1 行足しただけ
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
    -- 議員定数：総定数・根拠・選挙区ごとの定数が（順序を問わず）同じ
    WHEN 'district_seats' THEN policy_jp.district_seats_signature(a) IS NOT NULL AND policy_jp.district_seats_signature(b) IS NOT NULL
                             AND policy_jp.district_seats_signature(a) = policy_jp.district_seats_signature(b)
    ELSE FALSE
  END
$$;

DROP TRIGGER IF EXISTS contributions_same_claim_supersede ON policy_jp.contributions;
CREATE TRIGGER contributions_same_claim_supersede AFTER UPDATE OF status ON policy_jp.contributions
  FOR EACH ROW WHEN (NEW.status = 'applied' AND OLD.status IS DISTINCT FROM 'applied'
                     AND NEW.contribution_type IN ('election', 'regional_stat', 'local_government', 'politician', 'policy', 'policy_elements', 'district_seats'))
  EXECUTE FUNCTION policy_jp.same_claim_supersede_trg();


-- ------------------------------------------------------------
-- 6. 臂名清單・総表・層内順位：20261011140000 の版に 名前 1 つ／UNION 1 行／WHEN 1 行を足しただけ（残りは一字も変えない）
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
    'district_seats'
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
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／candidate_status_stale／not_running_recheck／candidacy_source_missing／district_seats_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing 8。登録のない auto 型別は 9';

-- ------------------------------------------------------------
-- 7. 規則（最初から開く）と優先層（冪等）
-- ------------------------------------------------------------
-- 窓＝投票日当日まで（until polling +0、起点なし）。after_step なし（鎖のどの段も待たない）。min_status='announced'：投票日が告示済み以上の選挙だけ。同時に開くのは最大 100 件
INSERT INTO policy_jp.activity_rules (activity, window_kind, until_kind, until_offset, min_status, election_types, enabled, params, note)
SELECT 'district_seats', 'event', 'polling', 0, 'announced', ARRAY['pref_assembly', 'muni_assembly']::TEXT[], true,
       '{"cap":100}'::JSONB,
       '議員定数（正見 district_seats_missing）：議会議員選挙の議員定数を、議員定数条例（例規集）か選挙管理委員会の告示で確かめて、選挙の定数合計と選挙区ごとの定数を記録する任務。投票日当日まで。同時に開くのは最大 100 件（投票日の近い選挙が先）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'district_seats' AND r.priority IS NULL);

-- 優先層：policy_elements と同じ（投票日前 60 日以内＝前段、前 181 日以上＝後段、その間は既定の中段）
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT a.activity, 'event', a.from_kind, a.from_offset, a.until_kind, a.until_offset, a.tier, a.note
  FROM (VALUES
    ('priority:district_seats', 'polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 日以内の議員定数任務（最近の選挙を先に派す）'),
    ('priority:district_seats', NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の議員定数任務；61～180 日は既定の層（中段）')
  ) AS a(activity, from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.activity AND r.priority = a.tier);

-- 主控台時間軸の段（2＝参選期。規則は投票日までの窓なので、規則から自動で算出された段が優先され、この登記は後備）
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('district_seats', 2, '議員定数（投票日まで）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 8. 權限（新函式は PUBLIC に実行権が付くので明示的に収回。CREATE OR REPLACE した既存の関数は権限を保つ）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_district_seats(), policy_jp.apply_district_seats(policy_jp.contributions),
  policy_jp.district_seats_normalize(JSONB), policy_jp.district_seats_signature(JSONB), policy_jp.same_claim_matches_district_seats(JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_district_seats(), policy_jp.apply_district_seats(policy_jp.contributions),
  policy_jp.district_seats_normalize(JSONB), policy_jp.district_seats_signature(JSONB), policy_jp.same_claim_matches_district_seats(JSONB, TEXT, UUID)
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
  -- 規則：存在、開いている、投票日までの窓、after_step なし、cap あり
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                  WHERE r.activity = 'district_seats' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'event'
                    AND r.from_kind IS NULL AND r.until_kind = 'polling' AND r.until_offset = 0
                    AND r.after_step IS NULL AND r.params ? 'cap') THEN
    RAISE EXCEPTION 'policy_jp：district_seats の規則が「開いている・投票日までの窓・after_step なし・cap あり」になっていない';
  END IF;
  -- 三處一起加
  IF NOT ('district_seats' = ANY (policy_jp.activity_arm_names())) THEN
    RAISE EXCEPTION 'policy_jp：activity_arm_names() に district_seats がない';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_district_seats()%') <> 1 THEN
    RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 総表に district_seats の分支がない';
  END IF;
  IF policy_jp.chain_step_rank('auto:district_seats_missing:x', 'district_seats_missing') <> 4
     OR policy_jp.chain_step_rank('auto:policy_elements_missing:x', 'policy_elements_missing') <> 8
     OR policy_jp.chain_step_rank('auto:policy_missing:x', 'policy_missing') <> 6
     OR policy_jp.chain_step_rank('auto:election_result_missing:x', 'election_result_missing') <> 7 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank の登録がおかしい';
  END IF;
  -- 交件型別：DB CHECK と落庫清單
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check' AND pg_get_constraintdef(oid) LIKE '%district_seats%') THEN
    RAISE EXCEPTION 'policy_jp：policy_jp_contributions_type_check に district_seats がない';
  END IF;
  IF NOT ('district_seats' = ANY (policy_jp.apply_types())) THEN RAISE EXCEPTION 'policy_jp：apply_types() に district_seats がない'; END IF;
  IF pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_district_seats%' THEN
    RAISE EXCEPTION 'policy_jp：apply_contribution に district_seats の WHEN がない';
  END IF;
  -- 同一件事：分派器が district_seats を知っている
  IF policy_jp.same_claim_matches('district_seats', '{"election_id":"none"}'::JSONB) IS NULL THEN
    RAISE EXCEPTION 'policy_jp：same_claim_matches が district_seats を知らない';
  END IF;
  IF pg_get_triggerdef((SELECT t.oid FROM pg_trigger t WHERE t.tgname = 'contributions_same_claim_supersede' AND t.tgrelid = 'policy_jp.contributions'::regclass)) NOT LIKE '%district_seats%' THEN
    RAISE EXCEPTION 'policy_jp：contributions_same_claim_supersede の型別清單に district_seats がない';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_district_seats()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_district_seats(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.district_seats_normalize(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.district_seats_signature(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.same_claim_matches_district_seats(jsonb, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：議員定数の関数を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
