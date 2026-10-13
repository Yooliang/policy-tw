-- 日本站派工臂対齊正見：政策の継承（lineage／handover）— 来龍去脈・前後任の交接・同級多人・上下級（C 期 第 6 步）。工作単 Yooliang/policy-ops#95、計畫 policy-jp docs/PLAN-arms-parity.md C 期「前後任交接、同一件事の来龍去脈」
-- ============================================================
--
--   正見臂（activity）   日本臂（activity）   任務型別（task_type）    task_id                                                  交件
--   lineage_candidates   lineage_candidates  lineage_candidate        auto:lineage_candidate:<格の鍵 12 字>:<清單指紋 8 字>      lineage（同じ件を脈絡にまとめる）／no_change（outcome=confirmed）
--   handover_missing     handover_missing    handover_missing         auto:handover_missing:<脈絡 id>:<交接の指紋 8 字>          lineage_handover／no_change（outcome=not_found）
--   lineage_roles        lineage_roles       lineage_roles_missing    auto:lineage_roles_missing:<脈絡 id>                       lineage_participants／no_change（outcome=not_found）
--   lineage_links        lineage_links       lineage_link_candidate   auto:lineage_link_candidate:<下級の脈絡 id>:<指紋 8 字>    lineage_link／no_change（outcome=confirmed）
--
--   正見：migration 20261006034900_policy_lineages.sql（4 支の臂・lineage_candidate_scope・lineage_block_key・contribution_needs_two_ips の stop 一句）、20261006234000_lineage_read_side.sql（読み側）、
--         _shared/lineage.ts（上限・列挙・値の組み立て）、contribution-schema.ts の lineage／lineage_participants／lineage_handover／lineage_link、apply-contribution.ts の applyLineage*。
--         正見の窓は 20261011030000 で『当屆類だが task target に選挙がないので永遠に開く』と明記（handover_missing id 22、lineage_candidates／links／roles id 6・25・26）。主控台の段は 20261010110000：lineage 3 本＝6（任期中）、handover_missing＝7（卸任交接）。
--   日本站のちがい：
--     ・層級は national／regional（都道府県）／local（市区町村）。場所は lg_code 一本（正見の region／sub_region／admin_code の三つ組ではない）。lineages_place CHECK＝（level='national')＝(lg_code IS NULL）。
--       regional は kind='prefecture' の団体、local はそれ以外の団体でなければならない（落庫で検査：テーブルには検査がない）。上下関係は『国→都道府県→その都道府県内の市区町村』（pref_code で結ぶ）。
--     ・id は TEXT（gen_random_uuid()::TEXT）。lineages／handovers／participants／links に contribution_id 列がない：来歴は edit_history.contribution_id と source_refs（target_table = lineages／lineage_participants／lineage_links／handovers）に残す。
--     ・交接 handovers は人物×選挙ではなく『任期（politician_offices）から任期へ』：from_office_id／to_office_id。同じ職位・同じ団体の任期どうし、from は to より前に始まったもの。
--       from_policy_ids／to_policy_ids は落庫の時に『この脈絡の政策のうち、その任期の人の政策』から自動で埋める（交件に書かせない）。stop（中止）は official 等級の出典が 1 つ要る（テーブル注記『stop は official か assembly の出典』のうち、URL で自動判定できる official に限る）。
--     ・首長だけが交接の対象（governor／mayor／ward_mayor／town_mayor）：議員は多席・非執行なので前後任の関係でない（正見と同じ）。前任が『別の人』に交代したときだけ（同じ人の再選は交接の臂に出さない＝正見の `to_id <> from_id` と同じ。再選での継続は脈絡の中の政策の status で見える）。
--       前任の任期が終わっている＝end_date が入っている（日本の『現任』は end_date が空の一種類だけ）。後任は同じ職位・同じ団体で『前任より後に始まり、今日までに始まった』最初の任期。
--     ・民意代表（lineage_roles の対象）：政策を持つ人が、公開済みの議員任期（pref_assembly_member／muni_assembly_member／representative／councillor）を 1 つでも持つ（始まっていること）。出典は国会会議録・議案・会議録。cosigner＝賛成者／連署。
--     ・『候補を調べた』の記録：正見は表 lineage_candidate_reviews。日本は duplicate_policy と同じく task_checks の confirmed を使う：task_id に清單の指紋が入っているので、同じ指紋の confirmed は永久（清單が変われば指紋が変わり、また開く）。
--       lineage／lineage_link を落庫したら apply 側が同じ task_id に confirmed を 1 行足す（正見の recordCandidateReview と同じ意味）。not_found／unreachable は task_unavailable() の標準の冷却で戻る。
--     ・政策の範囲：公開済みの政策で、人物が引けるもの。公約（origin=pledge）は当選済み（elected）か、まだ投票前で届出済み・表明済み（filed／declared）の人のもの。それ以外の由来（policy_address／assembly／budget）は任期の人物。
--       正見の『立法委員の政見を県市の格にも入れる』は日本版では入れない（国会議員は national の格だけ）。地方の事業でも国会議員が公約にしたものは、代理が new_lineage の level／lg_code で決める（正見と同じ運用）。
--
-- この支でやること：
-- 1. 交件型別 4 つ：lineage（脈絡を建てる／既存に政策を掛け外しする／題名等を直す）、lineage_participants（参加者と役割）、lineage_handover（交接）、lineage_link（上下級の関連）。
--    DB CHECK（policy_jp_contributions_type_check）、apply_types()、落庫 apply_lineage／apply_lineage_participants／apply_lineage_handover／apply_lineage_link、apply_contribution に WHEN 4 行。
--    payload の形は _shared/jp/contribution-schema.ts（TS）と同じ規則を SQL でも検査する（不備は invalid で退件、庫を汚さない）。履歴は edit_history（agent_name='auto-apply'）、出典は source_refs。
-- 2. 臂 4 つ：総表に UNION 4 行、activity_arm_names() に名前 4 つ、activity_rules に規則 4 条（enabled・常時窓・after_step なし・cap）、chain_step_rank に WHEN 4 行、主控台の段（lineage 3 本＝6、handover_missing＝7）。
-- 3. 共識：contribution_needs_two_ips に『lineage_handover の handover_type=stop』を足す（正見 20261006034900 と同じ一句。130000 の複本はこの一句だけ抜いてあった＝DEVIATED で登記、policy-jp-dispatch-drift.test.ts）。
--    contribution_required_agree は ELSE の normal（目標 3・退件 −3）、system_vote_eligible／system_one_precheck_types には入れない＝系統票なし。この支で触る共識関数は contribution_needs_two_ips だけ。
-- 4. 同一件事（#521）：4 つとも same_claim の登記表の型別ではなく、claimKey 併票の型別でもない（正見の duplicate-claim.ts は正見でも lineage 系を鍵にしていない）。
--    重複は DB の一意制約と落庫の冪等（同じ内容＝unchanged、同名の脈絡＝conflict）で止める＝正見と同じ仕組み。same-claims.ts に APPLY_IDEMPOTENT_TYPES として明記し、守門（same-claims.test.ts）がその第三の道を認める。
--
-- 設計の判断：
-- a. 鎖（選挙鎖）に掛けない（after_step なし）、窓は常時：脈絡は『複数の任期・複数の政策にまたがる』ものなので特定の選挙の段の完了を前提にしない。task の target に選挙 id がないので、選挙里程碑で窓を切ると全件が閉じる（正見 20261011030000 が同じ理由で『永遠に開く』と明記）。progress_stale と同じ。
-- b. 優先層は専用規則を置かない＝既定の層（中段）。chain_step_rank は 9（選挙鎖の最後）。主控台の段は正見に合わせる（脈絡 6、交接 7）。
-- c. 規則は enabled：正見の 4 支も初期から開いている。本番の脈絡は 0 件（lineage_candidates だけが最初に出る）ので、他の 3 つは脈絡ができてから動く。止める・絞るのは UPDATE policy_jp.activity_rules SET enabled / params（走 migration）。
-- d. cap（同時に開く最大件数）は規則の params.cap（既定 100）。正見は臂に件数の上限がなかった（lineage_candidates は初回 151 格）。日本版は新しい臂なので上限を置く（progress_stale と同じ並べ方）。
--
-- 守門：supabase/functions/_shared/policy-jp-lineage.test.ts、policy-jp-dispatch-drift.test.ts（登記・DEVIATED_LINEAGE）、same-claims.test.ts、jp/contribution-schema*.test.ts。
-- 不碰 public、ditrust。冪等（規則は NOT EXISTS）、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 交件型別 4 つ：DB CHECK と落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'policy_progress',
                               'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'policy_progress', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'no_change']::TEXT[]
$$;

-- 兩台機器：130000 の複本は正見の一句（lineage_handover の stop）だけを抜いてあった。日本にも脈絡ができたので、正見と同じ本体に戻す（正見 20261006141600 の現行定義と逐字同じ）
CREATE OR REPLACE FUNCTION policy_jp.contribution_needs_two_ips(p_type TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('merge_politician', 'candidacy', 'removal', 'reassign_candidacy')
      OR (p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop')
$$;
COMMENT ON FUNCTION policy_jp.contribution_needs_two_ips IS
  '分数が 1 つの来源網段だけで貯まってはいけない貢献：同名合併・参選の加減・移除・参選の付け替え、そして『中止』の交接（lineage_handover の handover_type=stop）。正見の同名関数の日本版（stop の一句は 20261011210000 で復活）';

-- ------------------------------------------------------------
-- 2. 共通の小さな関数：層級・上下級・政策がどの任期に属すか
-- ------------------------------------------------------------
-- 団体コード → 脈絡の層級（NULL＝national、都道府県＝regional、その他＝local）
CREATE OR REPLACE FUNCTION policy_jp.lineage_level_of(p_lg_code TEXT) RETURNS TEXT
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT CASE WHEN p_lg_code IS NULL THEN 'national'
              WHEN (SELECT g.kind FROM policy_jp.local_governments g WHERE g.lg_code = p_lg_code) = 'prefecture' THEN 'regional'
              ELSE 'local' END
$$;
COMMENT ON FUNCTION policy_jp.lineage_level_of IS '団体コードから脈絡の層級を引く：NULL＝national、kind=prefecture＝regional、それ以外＝local（lineages の level の定義と同じ）';

-- 上下級の関連として成り立つか：上級が下級の一つ上の層（国→都道府県・市区町村、都道府県→その都道府県内の市区町村）
CREATE OR REPLACE FUNCTION policy_jp.lineage_link_level_ok(p_upper_level TEXT, p_upper_lg TEXT, p_lower_level TEXT, p_lower_lg TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT (p_upper_level = 'national' AND p_lower_level IN ('regional', 'local'))
      OR (p_upper_level = 'regional' AND p_lower_level = 'local'
          AND p_upper_lg IS NOT NULL
          AND p_upper_lg = (SELECT g.pref_code FROM policy_jp.local_governments g WHERE g.lg_code = p_lower_lg))
$$;
COMMENT ON FUNCTION policy_jp.lineage_link_level_ok IS '脈絡の上下級の関連が成り立つか（正見 linkLevelProblem の日本版）：国は都道府県・市区町村の上、都道府県はその都道府県内の市区町村の上。落庫と lineage_links 臂が共有する';

-- ------------------------------------------------------------
-- 3. 落庫 apply_lineage（正見 applyLineage の日本版）
-- ------------------------------------------------------------
-- payload：lineage_id（既存に歸入）か new_lineage {title, summary, category, level, lg_code} の二択、policy_ids（掛ける政策）、detach_policy_ids（外す政策）、既存の脈絡の title／summary／category の訂正、note（20～1000 字）。
-- 候補（auto:lineage_candidate:…）の task_id がついていれば、落庫した時点で『この清單は見た』を task_checks（confirmed）に足す。
CREATE OR REPLACE FUNCTION policy_jp.apply_lineage(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  nl JSONB := CASE WHEN jsonb_typeof(p->'new_lineage') = 'object' THEN p->'new_lineage' END;
  v_lid TEXT := NULLIF(policy_jp.policy_trim(p->>'lineage_id'), '');
  v_task TEXT := COALESCE(NULLIF(c.payload->>'task_id', ''), c.task_id);
  v_attach TEXT[] := '{}';
  v_detach TEXT[] := '{}';
  v_title TEXT; v_summary TEXT; v_cat TEXT; v_level TEXT; v_lg TEXT; v_kind TEXT;
  v_min INTEGER;
  v_found INTEGER;
  v_changed BOOLEAN := false;
  v_done TEXT[] := '{}';
  v_note TEXT := policy_jp.policy_trim(p->>'note');
  l policy_jp.lineages%ROWTYPE;
  l_new policy_jp.lineages%ROWTYPE;
  pol policy_jp.policies%ROWTYPE;
  r RECORD;
BEGIN
  IF (v_lid IS NULL) = (nl IS NULL) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'lineage_id（既存の脈絡に入れる）と new_lineage（新しく建てる）はどちらか一方だけ');
  END IF;
  IF char_length(v_note) NOT BETWEEN 20 AND 1000 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'note は 20～1000 字（なぜ同じ件と言えるか：同じ事業名・場所・法令・予算を原文や報道で引く）');
  END IF;
  IF jsonb_typeof(p->'policy_ids') = 'array' THEN
    SELECT COALESCE(array_agg(DISTINCT policy_jp.policy_trim(x)), '{}') INTO v_attach FROM jsonb_array_elements_text(p->'policy_ids') x;
  END IF;
  IF jsonb_typeof(p->'detach_policy_ids') = 'array' THEN
    SELECT COALESCE(array_agg(DISTINCT policy_jp.policy_trim(x)), '{}') INTO v_detach FROM jsonb_array_elements_text(p->'detach_policy_ids') x;
  END IF;
  IF cardinality(v_attach) > 30 OR cardinality(v_detach) > 30 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'policy_ids／detach_policy_ids は 1 回に 30 件まで');
  END IF;
  IF v_attach && v_detach THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '同じ政策を掛けると同時に外すことはできない');
  END IF;

  -- 掛ける・外す政策はすべて公開済みで実在すること（実在しない政策を黙って無視しない）
  SELECT count(*) INTO v_found FROM policy_jp.policies pl WHERE pl.id = ANY (v_attach || v_detach) AND pl.review_status = 'published';
  IF v_found <> cardinality(v_attach) + cardinality(v_detach) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('政策 %s は登録されていないか、公開されていない',
      (SELECT string_agg(x, '、') FROM unnest(v_attach || v_detach) x WHERE NOT EXISTS (SELECT 1 FROM policy_jp.policies pl WHERE pl.id = x AND pl.review_status = 'published'))));
  END IF;

  IF v_lid IS NOT NULL THEN
    SELECT * INTO l FROM policy_jp.lineages WHERE id = v_lid;
    IF NOT FOUND OR l.review_status <> 'published' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('脈絡 %s は登録されていないか、公開されていない', v_lid));
    END IF;
    IF p ? 'title' AND char_length(policy_jp.policy_trim(p->>'title')) NOT BETWEEN 4 AND 60 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'title は 4～60 字（この件の名称。中立・事実のまま）');
    END IF;
    IF p ? 'summary' AND char_length(policy_jp.policy_trim(p->>'summary')) NOT BETWEEN 1 AND 200 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'summary は 1～200 字（この件が何かを一、二文で。事実だけ）');
    END IF;
    IF p ? 'category' AND char_length(policy_jp.policy_trim(p->>'category')) NOT BETWEEN 1 AND 30 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'category は 1～30 字');
    END IF;
    IF cardinality(v_attach) = 0 AND cardinality(v_detach) = 0 AND NOT (p ? 'title' OR p ? 'summary' OR p ? 'category') THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', '既存の脈絡に入れるときは policy_ids（掛ける政策）を付ける。外すなら detach_policy_ids、脈絡自体を直すなら title／summary／category');
    END IF;
  ELSE
    v_title := policy_jp.policy_trim(nl->>'title');
    v_summary := NULLIF(policy_jp.policy_trim(nl->>'summary'), '');
    v_cat := policy_jp.policy_trim(nl->>'category');
    v_level := nl->>'level';
    v_lg := NULLIF(policy_jp.policy_trim(nl->>'lg_code'), '');
    IF char_length(v_title) NOT BETWEEN 4 AND 60 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'title は 4～60 字（この件の名称。中立・事実のまま。評価やスローガンは書かない）');
    END IF;
    IF v_summary IS NOT NULL AND char_length(v_summary) > 200 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'summary は 200 字まで（一、二文で。事実だけ）');
    END IF;
    IF char_length(v_cat) NOT BETWEEN 1 AND 30 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'category は 1～30 字');
    END IF;
    IF v_level IS NULL OR NOT (v_level = ANY (ARRAY['national', 'regional', 'local'])) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'level は national（国）／regional（都道府県）／local（市区町村）：この件を決め、実行するのはどの層か');
    END IF;
    IF v_level = 'national' THEN
      IF v_lg IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', 'level=national の脈絡には lg_code を付けない'); END IF;
    ELSE
      SELECT g.kind INTO v_kind FROM policy_jp.local_governments g WHERE g.lg_code = v_lg;
      IF v_lg IS NULL OR v_kind IS NULL THEN
        RETURN jsonb_build_object('outcome', 'invalid', 'message', 'level が regional／local のときは、登録済みの団体の lg_code（6 桁）が要る');
      END IF;
      IF (v_level = 'regional') <> (v_kind = 'prefecture') THEN
        RETURN jsonb_build_object('outcome', 'invalid', 'message', format('level=%s と団体 %s（%s）が合わない：regional は都道府県、local は市区町村の団体', v_level, v_lg, v_kind));
      END IF;
    END IF;
    v_min := CASE WHEN v_level = 'national' THEN 1 ELSE 2 END;
    IF cardinality(v_attach) < v_min THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('新しい脈絡には policy_ids を %s 件以上付ける（政策が 1 件だけで、他の人や他の任期が同じ件を扱っていないなら脈絡を建てない）', v_min));
    END IF;
    IF cardinality(v_detach) > 0 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', '新しく建てる脈絡に、外す政策はない');
    END IF;
    -- 同時に同名の脈絡を建てる 2 件が両方とも同名検査を通り抜けないよう、層・団体・正規化した題名で直列化する
    PERFORM pg_advisory_xact_lock(hashtext('lineage:' || v_level || '|' || COALESCE(v_lg, '') || '|' || policy_jp.policy_title_key(v_title)));
    IF EXISTS (SELECT 1 FROM policy_jp.lineages x
                WHERE x.level = v_level AND x.lg_code IS NOT DISTINCT FROM v_lg AND x.review_status IN ('published', 'pending')
                  AND policy_jp.policy_title_key(x.title) = policy_jp.policy_title_key(v_title)) THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'message', format('同じ層・同じ団体に同名の脈絡「%s」がすでにある。lineage_id でそちらに入れる', v_title));
    END IF;
  END IF;

  -- 掛ける政策が、別の脈絡にすでに入っていないか（付け替えは、先に外してから）
  FOR pol IN SELECT * FROM policy_jp.policies WHERE id = ANY (v_attach) ORDER BY id LOOP
    IF pol.lineage_id IS NOT NULL AND pol.lineage_id IS DISTINCT FROM v_lid THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'message', format('政策「%s」はすでに別の脈絡（%s）に入っている。付け替えるなら、先にその脈絡に detach_policy_ids で外してから入れる', pol.title, pol.lineage_id));
    END IF;
  END LOOP;

  IF v_lid IS NULL THEN
    INSERT INTO policy_jp.lineages (id, title, category, level, lg_code, summary, review_status)
    VALUES (gen_random_uuid()::TEXT, v_title, v_cat, v_level, v_lg, v_summary, 'published')
    RETURNING * INTO l_new;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('lineages', l_new.id, '*', NULL, to_jsonb(l_new), c.id, 'auto-apply');
    v_lid := l_new.id;
    v_changed := true;
    v_done := v_done || format('脈絡「%s」を新しく建てた', v_title);
  ELSE
    -- 既存の脈絡自体の訂正（値が変わるときだけ書く）
    FOR r IN SELECT f.field, policy_jp.policy_trim(p->>f.field) AS new_value, to_jsonb(l) ->> f.field AS old_value
               FROM (VALUES ('title'), ('summary'), ('category')) f(field) WHERE p ? f.field LOOP
      IF r.new_value IS DISTINCT FROM COALESCE(r.old_value, '') AND NOT (r.new_value = '' AND r.old_value IS NULL) THEN
        EXECUTE format('UPDATE policy_jp.lineages SET %I = $1, updated_at = now() WHERE id = $2', r.field) USING NULLIF(r.new_value, ''), v_lid;
        INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('lineages', v_lid, r.field, to_jsonb(r.old_value), to_jsonb(NULLIF(r.new_value, '')), c.id, 'auto-apply');
        v_changed := true;
        v_done := v_done || format('%s を直した', r.field);
      END IF;
    END LOOP;
  END IF;

  FOR pol IN SELECT * FROM policy_jp.policies WHERE id = ANY (v_attach) ORDER BY id LOOP
    CONTINUE WHEN pol.lineage_id IS NOT DISTINCT FROM v_lid;  -- もうこの脈絡にある
    UPDATE policy_jp.policies SET lineage_id = v_lid, updated_at = now() WHERE id = pol.id;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('policies', pol.id, 'lineage_id', to_jsonb(pol.lineage_id), to_jsonb(v_lid), c.id, 'auto-apply');
    v_changed := true;
    v_done := v_done || format('政策「%s」を入れた', pol.title);
  END LOOP;
  FOR pol IN SELECT * FROM policy_jp.policies WHERE id = ANY (v_detach) ORDER BY id LOOP
    CONTINUE WHEN pol.lineage_id IS DISTINCT FROM v_lid;  -- もともとこの脈絡にない
    UPDATE policy_jp.policies SET lineage_id = NULL, updated_at = now() WHERE id = pol.id;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('policies', pol.id, 'lineage_id', to_jsonb(pol.lineage_id), NULL, c.id, 'auto-apply');
    v_changed := true;
    v_done := v_done || format('政策「%s」を外した', pol.title);
  END LOOP;

  IF v_changed THEN PERFORM policy_jp.source_write('lineages', v_lid, c.source_urls, 'lineage'); END IF;
  -- 候補の清單は『見た』：同じ指紋の confirmed は永久に派さない（正見の lineage_candidate_reviews の日本版）
  IF v_task ~ '^auto:lineage_candidate:[0-9a-f]{12}:[0-9a-f]{8}$'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = v_task AND tc.outcome = 'confirmed') THEN
    INSERT INTO policy_jp.task_checks (task_id, agent_name, note, contribution_id, outcome)
    VALUES (v_task, c.agent_name, left(v_note, 1000), c.id, 'confirmed');
  END IF;
  IF cardinality(v_attach) > 0 THEN
    UPDATE policy_jp.contributions SET applied_policy_id = v_attach[1] WHERE id = c.id;
  END IF;

  IF NOT v_changed THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'lineages', 'record_id', v_lid, 'message', format('脈絡 %s は、この貢献と同じ内容でもうある（別の人が先に出した）', v_lid));
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'lineages', 'record_id', v_lid, 'message', format('%s（脈絡 %s）', array_to_string(v_done, '；'), v_lid));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_lineage IS
  'lineage 交件の落庫（正見 applyLineage の日本版）：new_lineage で脈絡を建てる／lineage_id の脈絡に policy_ids を掛け、detach_policy_ids を外し、title／summary／category を直す。'
  '同名の脈絡＝conflict、別の脈絡に入っている政策＝conflict、不備＝invalid、変化なし＝unchanged。履歴は edit_history、出典は source_refs（lineages）。候補の task_id がついていれば task_checks に confirmed を足す';

-- ------------------------------------------------------------
-- 4. 落庫 apply_lineage_participants（正見 applyLineageParticipants の日本版）
-- ------------------------------------------------------------
-- 一人の一つの根拠（official_record／self_claim）に役割は一つ。重交＝上書き、remove=true で外す。検査は書く前にぜんぶ終える（途中で invalid を返して半端に書かない）
CREATE OR REPLACE FUNCTION policy_jp.apply_lineage_participants(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_lid TEXT := NULLIF(policy_jp.policy_trim(p->>'lineage_id'), '');
  v_task TEXT := COALESCE(NULLIF(c.payload->>'task_id', ''), c.task_id);
  l policy_jp.lineages%ROWTYPE;
  ex policy_jp.lineage_participants%ROWTYPE;
  v_new policy_jp.lineage_participants%ROWTYPE;
  it JSONB;
  v_pid TEXT; v_role TEXT; v_basis TEXT; v_loc TEXT; v_note TEXT; v_url TEXT; v_remove BOOLEAN;
  v_seen TEXT[] := '{}';
  v_key TEXT;
  v_written TEXT[] := '{}';
  v_same TEXT[] := '{}';
  v_pname TEXT;
  v_first_url TEXT := (SELECT btrim(u) FROM unnest(c.source_urls) u WHERE btrim(u) ~* '^https?://[^/[:space:]]+' LIMIT 1);
  -- basis=official_record で個別の source_url がないときは、source_urls のうち official 等級の最初の 1 つ（TS の『どれか 1 つが official』と同じ判定）
  v_first_official TEXT := (SELECT btrim(u) FROM unnest(c.source_urls) u
                             WHERE btrim(u) ~* '^https?://[^/[:space:]]+' AND policy_jp.source_kind_for_url(btrim(u), 'lineage_participants') = 'official' LIMIT 1);
BEGIN
  IF v_lid IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', 'lineage_id がない（任務の target.lineage_id を使う）'); END IF;
  SELECT * INTO l FROM policy_jp.lineages WHERE id = v_lid;
  IF NOT FOUND OR l.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('脈絡 %s は登録されていないか、公開されていない', v_lid));
  END IF;
  IF jsonb_typeof(p->'participants') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'participants') NOT BETWEEN 1 AND 50 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'participants は 1～50 件の配列');
  END IF;

  -- 1 周目：検査だけ
  FOR it IN SELECT value FROM jsonb_array_elements(p->'participants') LOOP
    v_pid := NULLIF(policy_jp.policy_trim(it->>'politician_id'), '');
    v_role := it->>'role';
    v_basis := it->>'basis';
    v_loc := policy_jp.policy_trim(it->>'source_locator');
    v_note := NULLIF(policy_jp.policy_trim(it->>'note'), '');
    v_url := COALESCE(NULLIF(btrim(it->>'source_url'), ''), CASE WHEN v_basis = 'official_record' THEN COALESCE(v_first_official, v_first_url) ELSE v_first_url END);
    v_remove := COALESCE(it->>'remove', 'false') = 'true';
    IF v_pid IS NULL OR NOT EXISTS (SELECT 1 FROM policy_jp.politicians pp WHERE pp.id = v_pid AND pp.review_status = 'published') THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('人物 %s は登録されていないか、公開されていない（まだサイトにいない人は標さない）', COALESCE(v_pid, '（未記入）')));
    END IF;
    IF v_basis IS NULL OR NOT (v_basis = ANY (ARRAY['official_record', 'self_claim'])) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'basis は official_record（公的な記録）か self_claim（本人の主張）');
    END IF;
    IF NOT v_remove AND (v_role IS NULL OR NOT (v_role = ANY (ARRAY['proposer', 'co_proposer', 'cosigner', 'advocate']))) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'role は proposer／co_proposer／cosigner／advocate のどれか');
    END IF;
    IF char_length(v_loc) NOT BETWEEN 1 AND 200 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_locator は 1～200 字で必須（議案番号・会議録の日付と案件・頁）');
    END IF;
    IF v_note IS NOT NULL AND char_length(v_note) > 200 THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'note は 200 字まで');
    END IF;
    IF NOT v_remove THEN
      IF v_url IS NULL OR v_url !~* '^https?://[^/[:space:]]+' THEN
        RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
      END IF;
      IF v_basis = 'official_record' AND policy_jp.source_kind_for_url(v_url, 'lineage_participants') <> 'official' THEN
        RETURN jsonb_build_object('outcome', 'invalid', 'message', format('basis=official_record（公的な記録）には official 等級の出典が要る（*.go.jp・*.lg.jp・自治体・議会の公式サイト）：%s', v_url));
      END IF;
    END IF;
    v_key := v_pid || '|' || v_basis;
    IF v_key = ANY (v_seen) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', '同じ人の同じ根拠は 1 回だけ（公的な記録は役割 1 つ、本人の主張は役割 1 つ）');
    END IF;
    v_seen := v_seen || v_key;
  END LOOP;

  -- 2 周目：書く
  FOR it IN SELECT value FROM jsonb_array_elements(p->'participants') LOOP
    v_pid := policy_jp.policy_trim(it->>'politician_id');
    v_role := it->>'role';
    v_basis := it->>'basis';
    v_loc := policy_jp.policy_trim(it->>'source_locator');
    v_note := NULLIF(policy_jp.policy_trim(it->>'note'), '');
    v_url := COALESCE(NULLIF(btrim(it->>'source_url'), ''), CASE WHEN v_basis = 'official_record' THEN COALESCE(v_first_official, v_first_url) ELSE v_first_url END);
    v_remove := COALESCE(it->>'remove', 'false') = 'true';
    SELECT pp.name INTO v_pname FROM policy_jp.politicians pp WHERE pp.id = v_pid;
    SELECT * INTO ex FROM policy_jp.lineage_participants x WHERE x.lineage_id = v_lid AND x.politician_id = v_pid AND x.basis = v_basis;
    IF v_remove THEN
      IF NOT FOUND THEN v_same := v_same || format('%s（もともとない）', v_pname); CONTINUE; END IF;
      DELETE FROM policy_jp.lineage_participants WHERE id = ex.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_participants', ex.id, '*', to_jsonb(ex), NULL, c.id, 'auto-apply');
      v_written := v_written || format('%s の %s を外した', v_pname, ex.role);
    ELSIF NOT FOUND THEN
      INSERT INTO policy_jp.lineage_participants (id, lineage_id, politician_id, role, basis, source_locator, note, review_status)
      VALUES (gen_random_uuid()::TEXT, v_lid, v_pid, v_role, v_basis, v_loc, v_note, 'published')
      RETURNING * INTO v_new;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_participants', v_new.id, '*', NULL, to_jsonb(v_new), c.id, 'auto-apply');
      PERFORM policy_jp.source_write('lineage_participants', v_new.id, ARRAY[v_url], 'lineage_participants');
      v_written := v_written || format('%s：%s（%s）', v_pname, v_role, v_basis);
    ELSIF ex.role IS DISTINCT FROM v_role OR ex.source_locator IS DISTINCT FROM v_loc OR ex.note IS DISTINCT FROM v_note THEN
      UPDATE policy_jp.lineage_participants SET role = v_role, source_locator = v_loc, note = v_note, updated_at = now() WHERE id = ex.id RETURNING * INTO v_new;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_participants', ex.id, '*', to_jsonb(ex), to_jsonb(v_new), c.id, 'auto-apply');
      PERFORM policy_jp.source_write('lineage_participants', ex.id, ARRAY[v_url], 'lineage_participants');
      v_written := v_written || format('%s：%s（%s）に直した', v_pname, v_role, v_basis);
    ELSE
      v_same := v_same || v_pname;
    END IF;
  END LOOP;

  IF cardinality(v_written) = 0 THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'lineage_participants', 'record_id', v_lid,
      'message', format('脈絡「%s」の参加者の役割は、すでにこのとおり（%s）', l.title, array_to_string(v_same, '、')));
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'lineage_participants', 'record_id', v_lid,
    'message', format('脈絡「%s」の参加者を記録した：%s%s', l.title, array_to_string(v_written, '；'),
                      CASE WHEN cardinality(v_same) > 0 THEN format('（%s は同じなので略）', array_to_string(v_same, '、')) ELSE '' END));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_lineage_participants IS
  'lineage_participants 交件の落庫（正見 applyLineageParticipants の日本版）：脈絡×人物×根拠ごとに役割 1 つ。重交＝上書き、remove=true で外す。official_record には official 等級の出典。検査を先にぜんぶ終えてから書く';

-- ------------------------------------------------------------
-- 5. 落庫 apply_lineage_handover（正見 applyLineageHandover の日本版：任期から任期へ）
-- ------------------------------------------------------------
-- payload：lineage_id、from_office_id、to_office_id（politician_offices.id）、handover_type（keep／pivot／shrink／stop／resume）、decided_on（任意）、note（20～500 字）、source_locator（1～200 字）。
-- 同じ脈絡・同じ一対の任期は 1 件、重交＝上書き。stop は source_urls に official 等級が 1 つ要り、共識は 2 網段（contribution_needs_two_ips）。
CREATE OR REPLACE FUNCTION policy_jp.apply_lineage_handover(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_lid TEXT := NULLIF(policy_jp.policy_trim(p->>'lineage_id'), '');
  v_from TEXT := NULLIF(policy_jp.policy_trim(p->>'from_office_id'), '');
  v_to TEXT := NULLIF(policy_jp.policy_trim(p->>'to_office_id'), '');
  v_type TEXT := p->>'handover_type';
  v_note TEXT := policy_jp.policy_trim(p->>'note');
  v_loc TEXT := policy_jp.policy_trim(p->>'source_locator');
  v_decided DATE;
  l policy_jp.lineages%ROWTYPE;
  fo policy_jp.politician_offices%ROWTYPE;
  tof policy_jp.politician_offices%ROWTYPE;
  ex policy_jp.handovers%ROWTYPE;
  v_new policy_jp.handovers%ROWTYPE;
  v_from_pols TEXT[];
  v_to_pols TEXT[];
  v_phrase TEXT;
  v_fname TEXT; v_tname TEXT;
BEGIN
  IF v_lid IS NULL OR v_from IS NULL OR v_to IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'lineage_id・from_office_id・to_office_id がない（任務の target の値を使う）');
  END IF;
  SELECT * INTO l FROM policy_jp.lineages WHERE id = v_lid;
  IF NOT FOUND OR l.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('脈絡 %s は登録されていないか、公開されていない', v_lid));
  END IF;
  SELECT * INTO fo FROM policy_jp.politician_offices WHERE id = v_from AND review_status = 'published';
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', format('前任の任期 %s は登録されていないか、公開されていない', v_from)); END IF;
  SELECT * INTO tof FROM policy_jp.politician_offices WHERE id = v_to AND review_status = 'published';
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', format('後任の任期 %s は登録されていないか、公開されていない', v_to)); END IF;
  IF fo.id = tof.id OR fo.position <> tof.position OR fo.lg_code IS DISTINCT FROM tof.lg_code OR fo.start_date >= tof.start_date THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '交接は、同じ団体・同じ職位の前の任期から後の任期へ（前任の任期が先に始まっていること）');
  END IF;
  IF v_type IS NULL OR NOT (v_type = ANY (ARRAY['keep', 'pivot', 'shrink', 'stop', 'resume'])) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'handover_type は keep（継承）／pivot（転換）／shrink（縮小）／stop（中止）／resume（再開）のどれか');
  END IF;
  IF char_length(v_note) NOT BETWEEN 20 AND 500 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'note は 20～500 字（どの文書に、どう書いてあるか。中止なら誰のどの文書が停止・取りやめ・解約を書いているか）');
  END IF;
  IF char_length(v_loc) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_locator は 1～200 字で必須（予算書の頁・会議録の日付と案件・報道のどの段落）');
  END IF;
  IF p ->> 'decided_on' IS NOT NULL AND p ->> 'decided_on' <> '' THEN
    IF p ->> 'decided_on' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'decided_on は YYYY-MM-DD');
    END IF;
    BEGIN
      v_decided := (p ->> 'decided_on')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'decided_on が実在しない日付');
    END;
    IF v_decided NOT BETWEEN DATE '1947-01-01' AND policy_jp.activity_today() THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('decided_on（%s）は 1947 年以降、今日（%s）を超えない日付', v_decided, policy_jp.activity_today()));
    END IF;
  END IF;
  IF v_type = 'stop' AND NOT EXISTS (SELECT 1 FROM unnest(c.source_urls) u WHERE policy_jp.source_kind_for_url(btrim(u), 'lineage_handover') = 'official') THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'stop（中止）には公的な出典が要る：source_urls に *.go.jp・*.lg.jp・自治体・議会の公式サイトを 1 つ以上入れる');
  END IF;
  IF policy_jp.source_write(NULL, NULL, c.source_urls, 'lineage_handover') IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  -- この脈絡の政策のうち、それぞれの任期の人のもの（公約は参選、公約以外は任期に掛かる）
  SELECT COALESCE(array_agg(pl.id ORDER BY pl.id), '{}') INTO v_from_pols FROM policy_jp.policies pl
   WHERE pl.lineage_id = v_lid AND pl.review_status = 'published'
     AND ((pl.politician_election_id IS NOT NULL AND pl.politician_election_id = fo.politician_election_id) OR fo.id = ANY (pl.office_ids));
  SELECT COALESCE(array_agg(pl.id ORDER BY pl.id), '{}') INTO v_to_pols FROM policy_jp.policies pl
   WHERE pl.lineage_id = v_lid AND pl.review_status = 'published'
     AND ((pl.politician_election_id IS NOT NULL AND pl.politician_election_id = tof.politician_election_id) OR tof.id = ANY (pl.office_ids));

  SELECT pp.name INTO v_fname FROM policy_jp.politicians pp WHERE pp.id = fo.politician_id;
  SELECT pp.name INTO v_tname FROM policy_jp.politicians pp WHERE pp.id = tof.politician_id;
  v_phrase := format('%s → %s：%s', COALESCE(v_fname, '前任'), COALESCE(v_tname, '後任'),
                     CASE v_type WHEN 'keep' THEN '継承' WHEN 'pivot' THEN '転換' WHEN 'shrink' THEN '縮小' WHEN 'stop' THEN '中止' ELSE '再開' END);

  SELECT * INTO ex FROM policy_jp.handovers WHERE lineage_id = v_lid AND from_office_id = v_from AND to_office_id = v_to;
  IF NOT FOUND THEN
    INSERT INTO policy_jp.handovers (id, lineage_id, from_office_id, to_office_id, from_policy_ids, to_policy_ids, handover_type, decided_on, note, source_locator, review_status)
    VALUES (gen_random_uuid()::TEXT, v_lid, v_from, v_to, v_from_pols, v_to_pols, v_type, v_decided, v_note, v_loc, 'published')
    RETURNING * INTO v_new;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('handovers', v_new.id, '*', NULL, to_jsonb(v_new), c.id, 'auto-apply');
    PERFORM policy_jp.source_write('handovers', v_new.id, c.source_urls, 'lineage_handover');
    RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'handovers', 'record_id', v_new.id, 'message', format('脈絡「%s」に交接を記録した：%s', l.title, v_phrase));
  END IF;
  IF ex.handover_type = v_type AND ex.decided_on IS NOT DISTINCT FROM v_decided AND ex.note = v_note AND ex.source_locator IS NOT DISTINCT FROM v_loc THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'handovers', 'record_id', ex.id, 'message', format('脈絡「%s」にはもう同じ交接がある（%s）', l.title, v_phrase));
  END IF;
  UPDATE policy_jp.handovers SET handover_type = v_type, decided_on = v_decided, note = v_note, source_locator = v_loc,
         from_policy_ids = v_from_pols, to_policy_ids = v_to_pols, updated_at = now()
   WHERE id = ex.id RETURNING * INTO v_new;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('handovers', ex.id, '*', to_jsonb(ex), to_jsonb(v_new), c.id, 'auto-apply');
  PERFORM policy_jp.source_write('handovers', ex.id, c.source_urls, 'lineage_handover');
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'handovers', 'record_id', ex.id, 'message', format('脈絡「%s」の交接を直した：%s', l.title, v_phrase));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_lineage_handover IS
  'lineage_handover 交件の落庫（正見 applyLineageHandover の日本版）：同じ脈絡・同じ一対の任期（politician_offices）で 1 件、重交＝上書き。from／to_policy_ids はこの脈絡の政策から自動で埋める。stop は official 等級の出典が要る（共識は 2 網段）';

-- ------------------------------------------------------------
-- 6. 落庫 apply_lineage_link（正見 applyLineageLink の日本版）
-- ------------------------------------------------------------
-- payload：upper_lineage_id、lower_lineage_id、link_type（top_down／bottom_up）、note（20～500 字）、source_locator（1～200 字）。一対は 1 件、重交＝上書き。
-- 上級は下級の一つ上の層（lineage_link_level_ok）。候補（auto:lineage_link_candidate:…）の task_id がついていれば『この清單は見た』を task_checks に足す。
CREATE OR REPLACE FUNCTION policy_jp.apply_lineage_link(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_up TEXT := NULLIF(policy_jp.policy_trim(p->>'upper_lineage_id'), '');
  v_lo TEXT := NULLIF(policy_jp.policy_trim(p->>'lower_lineage_id'), '');
  v_type TEXT := p->>'link_type';
  v_note TEXT := policy_jp.policy_trim(p->>'note');
  v_loc TEXT := policy_jp.policy_trim(p->>'source_locator');
  v_task TEXT := COALESCE(NULLIF(c.payload->>'task_id', ''), c.task_id);
  u policy_jp.lineages%ROWTYPE;
  d policy_jp.lineages%ROWTYPE;
  ex policy_jp.lineage_links%ROWTYPE;
  v_new policy_jp.lineage_links%ROWTYPE;
  v_phrase TEXT;
  v_msg TEXT;
  v_outcome TEXT;
  v_id TEXT;
BEGIN
  IF v_up IS NULL OR v_lo IS NULL OR v_up = v_lo THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'upper_lineage_id と lower_lineage_id は別々の脈絡の id（上級と下級）');
  END IF;
  SELECT * INTO u FROM policy_jp.lineages WHERE id = v_up;
  IF NOT FOUND OR u.review_status <> 'published' THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', format('上級の脈絡 %s は登録されていないか、公開されていない', v_up)); END IF;
  SELECT * INTO d FROM policy_jp.lineages WHERE id = v_lo;
  IF NOT FOUND OR d.review_status <> 'published' THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', format('下級の脈絡 %s は登録されていないか、公開されていない', v_lo)); END IF;
  IF NOT policy_jp.lineage_link_level_ok(u.level, u.lg_code, d.level, d.lg_code) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('上級「%s」（%s）は下級「%s」（%s）の一つ上の層になっていない：国は都道府県・市区町村の上、都道府県はその都道府県内の市区町村の上。同じ層なら同じ件か、上下の関係ではない', u.title, u.level, d.title, d.level));
  END IF;
  IF v_type IS NULL OR NOT (v_type = ANY (ARRAY['top_down', 'bottom_up'])) THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'link_type は top_down（上が法令・補助を定め、下が実行する）か bottom_up（下が先に動き、上が採り入れた）');
  END IF;
  IF char_length(v_note) NOT BETWEEN 20 AND 500 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'note は 20～500 字（どの法令・補助の決定・実施計画が二つの件をつないでいるか）');
  END IF;
  IF char_length(v_loc) NOT BETWEEN 1 AND 200 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_locator は 1～200 字で必須（条文・決定通知の番号・計画書の頁）');
  END IF;
  IF policy_jp.source_write(NULL, NULL, c.source_urls, 'lineage_link') IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;

  v_phrase := format('「%s」→「%s」：%s', u.title, d.title, CASE v_type WHEN 'top_down' THEN '上が定め下が実行' ELSE '下が先行し上が採用' END);
  SELECT * INTO ex FROM policy_jp.lineage_links WHERE upper_lineage_id = v_up AND lower_lineage_id = v_lo;
  IF NOT FOUND THEN
    INSERT INTO policy_jp.lineage_links (id, upper_lineage_id, lower_lineage_id, link_type, note, source_locator, review_status)
    VALUES (gen_random_uuid()::TEXT, v_up, v_lo, v_type, v_note, v_loc, 'published')
    RETURNING * INTO v_new;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('lineage_links', v_new.id, '*', NULL, to_jsonb(v_new), c.id, 'auto-apply');
    PERFORM policy_jp.source_write('lineage_links', v_new.id, c.source_urls, 'lineage_link');
    v_id := v_new.id; v_outcome := 'applied'; v_msg := format('上下級の関連を記録した：%s', v_phrase);
  ELSIF ex.link_type = v_type AND ex.note = v_note AND ex.source_locator IS NOT DISTINCT FROM v_loc THEN
    v_id := ex.id; v_outcome := 'unchanged'; v_msg := format('もう同じ関連がある（%s）', v_phrase);
  ELSE
    UPDATE policy_jp.lineage_links SET link_type = v_type, note = v_note, source_locator = v_loc, updated_at = now() WHERE id = ex.id RETURNING * INTO v_new;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('lineage_links', ex.id, '*', to_jsonb(ex), to_jsonb(v_new), c.id, 'auto-apply');
    PERFORM policy_jp.source_write('lineage_links', ex.id, c.source_urls, 'lineage_link');
    v_id := ex.id; v_outcome := 'applied'; v_msg := format('上下級の関連を直した：%s', v_phrase);
  END IF;
  IF v_task ~ '^auto:lineage_link_candidate:[^[:space:]:]+:[0-9a-f]{8}$'
     AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = v_task AND tc.outcome = 'confirmed') THEN
    INSERT INTO policy_jp.task_checks (task_id, agent_name, note, contribution_id, outcome)
    VALUES (v_task, c.agent_name, left(v_note, 1000), c.id, 'confirmed');
  END IF;
  RETURN jsonb_build_object('outcome', v_outcome, 'table_name', 'lineage_links', 'record_id', v_id, 'message', v_msg);
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_lineage_link IS
  'lineage_link 交件の落庫（正見 applyLineageLink の日本版）：一対の脈絡（上級・下級）で 1 件、重交＝上書き。上級は下級の一つ上の層。候補の task_id がついていれば task_checks に confirmed を足す';

-- ------------------------------------------------------------
-- 7. 臂 lineage_candidates（同じ層・同じ団体・同じ分野の政策を 1 つの「格」にして、同じ件の政策を脈絡にまとめさせる）
-- ------------------------------------------------------------
-- 範囲：公開済みの政策で人物が引けるもの。公約は当選済み（elected）か、投票前で届出済み・表明済み（filed／declared）の人のもの。公約以外（policy_address／assembly／budget）は任期の人物。
-- 格＝（層, 団体, 分野）。層は団体コードから（lineage_level_of）。格に『2 つ以上の任期・参選にまたがる政策』があり、まだ脈絡に入っていない政策が 1 件以上あれば 1 件の任務。
CREATE OR REPLACE FUNCTION policy_jp.lineage_candidate_scope()
RETURNS TABLE (policy_id TEXT, title TEXT, content_md5 TEXT, category TEXT, status TEXT, lineage_id TEXT, politician_id TEXT, politician_name TEXT,
               term_key TEXT, election_id TEXT, election_date DATE, election_type TEXT, level TEXT, lg_code TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT pl.id, pl.title, md5(pl.title || COALESCE(pl.description, '')), pl.category, pl.status, pl.lineage_id,
         pp.id, pp.name,
         COALESCE(pl.politician_election_id, o.id),
         e.id, e.election_date, e.election_type,
         policy_jp.lineage_level_of(x.lg), x.lg
    FROM policy_jp.policies pl
    LEFT JOIN policy_jp.politician_elections pe ON pe.id = pl.politician_election_id AND pe.review_status = 'published'
    LEFT JOIN policy_jp.politician_offices o ON pl.politician_election_id IS NULL AND o.review_status = 'published'
           AND o.id = (SELECT o2.id FROM policy_jp.politician_offices o2 WHERE o2.id = ANY (pl.office_ids) AND o2.review_status = 'published' ORDER BY o2.start_date, o2.id LIMIT 1)
    JOIN policy_jp.politicians pp ON pp.id = COALESCE(pe.politician_id, o.politician_id) AND pp.review_status = 'published'
    LEFT JOIN policy_jp.elections e ON e.id = COALESCE(pe.election_id, o.election_id)
    CROSS JOIN LATERAL (SELECT COALESCE(pl.lg_code, e.lg_code, o.lg_code) AS lg) x
   WHERE pl.review_status = 'published'
     AND (pl.origin <> 'pledge'
          OR pe.candidacy_status = 'elected'
          OR (e.election_date >= policy_jp.activity_today() AND pe.candidacy_status IN ('declared', 'filed')))
$$;
COMMENT ON FUNCTION policy_jp.lineage_candidate_scope IS
  '脈絡の候補の範囲（正見 lineage_candidate_scope の日本版）：どの政策を、どの格（層・団体）に入れるか。公約は当選済み、または投票前で届出済み・表明済みの人のもの；公約以外は任期の人物。層は団体コードから（lineage_level_of）';

-- 格の鍵：層｜団体｜分野 の md5 前 12 字（task_id に空白は入れられない。文字は target に別に置く）
CREATE OR REPLACE FUNCTION policy_jp.lineage_block_key(p_level TEXT, p_lg_code TEXT, p_category TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT substr(md5(p_level || '|' || COALESCE(p_lg_code, '') || '|' || COALESCE(p_category, '')), 1, 12)
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_lineage_candidates()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'lineage_candidates' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  s AS MATERIALIZED (SELECT * FROM policy_jp.lineage_candidate_scope()),
  blocks AS (
    SELECT s.level, s.lg_code, s.category,
           policy_jp.lineage_block_key(s.level, s.lg_code, s.category) AS block_key,
           -- 指紋は政策そのもの（id＋題名＋要約）だけ。どの脈絡に入ったかは見ない：脈絡を出したあとに『入ったから』と再び派さないため
           substr(md5(string_agg(s.policy_id || ':' || s.content_md5, ',' ORDER BY s.policy_id)), 1, 8) AS fp,
           count(*) AS n,
           count(DISTINCT s.term_key) AS terms,
           count(*) FILTER (WHERE s.lineage_id IS NULL) AS loose,
           jsonb_agg(jsonb_build_object(
             'policy_id', s.policy_id, 'title', s.title, 'politician_id', s.politician_id, 'name', s.politician_name,
             'election_id', s.election_id, 'election_year', EXTRACT(YEAR FROM s.election_date)::INTEGER,
             'election_type', s.election_type, 'status', s.status, 'lineage_id', s.lineage_id)
             ORDER BY s.election_date NULLS LAST, s.politician_name, s.policy_id) AS policies
      FROM s
     GROUP BY s.level, s.lg_code, s.category
  ),
  gaps AS (
    SELECT b.*, 'auto:lineage_candidate:' || b.block_key || ':' || b.fp AS tid, g.name AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = g.pref_code), '全国') AS pref_name
      FROM blocks b
      LEFT JOIN policy_jp.local_governments g ON g.lg_code = b.lg_code
      CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL AND b.terms >= 2 AND b.loose >= 1
       -- この指紋で『見た』（no_change confirmed、または脈絡を出して落庫された）：永久。清單が変われば指紋が変わって出直す
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = 'auto:lineage_candidate:' || b.block_key || ':' || b.fp AND tc.outcome = 'confirmed')
       -- 出した人がいて票待ち：派さない（同じ格の何件かが一緒に出る。退件になれば戻る）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                        WHERE c.contribution_type = 'lineage' AND c.status IN ('pending', 'verified', 'apply_failed')
                          AND c.task_id = 'auto:lineage_candidate:' || b.block_key || ':' || b.fp)
       AND NOT policy_jp.task_unavailable('auto:lineage_candidate:' || b.block_key || ':' || b.fp)
     ORDER BY b.terms DESC, b.block_key
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT g.tid, 'lineage_candidate',
         jsonb_build_object(
           'block_key', g.block_key, 'fingerprint', g.fp, 'level', g.level, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
           'category', g.category, 'policies', g.policies, 'policies_total', g.n,
           -- 同じ層・同じ団体にすでにある脈絡（分野は問わず最大 30 件）：同じ件ならそこに入れる。新しく建てない
           'existing_lineages', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('lineage_id', l.id, 'title', l.title, 'category', l.category) ORDER BY l.rn)
               FROM (SELECT l0.*, row_number() OVER (ORDER BY COALESCE(l0.category = g.category, false) DESC, l0.title, l0.id) AS rn
                       FROM policy_jp.lineages l0
                      WHERE l0.level = g.level AND l0.lg_code IS NOT DISTINCT FROM g.lg_code AND l0.review_status = 'published'
                      ORDER BY rn LIMIT 30) l
           ), '[]'::JSONB)),
         'この格は ' || CASE g.level WHEN 'national' THEN '国' ELSE g.lg_name END || '・「' || g.category || '」分野の政策 ' || g.n || ' 件です（target.policies、' || g.terms || ' の任期・参選にまたがる）。'
           || '全体を読んで、**同じ件を言っている**政策を探してください。同じ事業・同じ法令・同じ補助・同じ制度のことです'
           || '（例：前任の「新庁舎の建設」と後任の「新庁舎の開庁準備」、複数の議員が公約にした「給食費の無償化」）。'
           || '同じ分野でも対象が違う（別の病院・別の路線・別の補助対象）なら同じ件ではありません。'
           || '見つかったら contribution_type=lineage で提出します：同じ件の脈絡がすでにある（target.existing_lineages）なら lineage_id を付けて policy_ids の政策をそこに入れ、'
           || 'なければ new_lineage を付けて建てます（title は 4～60 字で、中立・事実のまま。level は national／regional／local のうち、この件を決めて実行する層、'
           || 'regional と local は lg_code も付ける。summary は 200 字以内）。1 つの件で 1 件、同じ格から何件出してもかまいません。new_lineage には policy_ids を 2 件以上（level=national は 1 件以上）付けます。'
           || '政策が 1 件だけで、他の人や他の任期が同じ件を扱っていないなら、脈絡を建てないでください。すでに別の脈絡にある政策は入れられません（付け替えるなら、先にその脈絡に detach_policy_ids で外します）。'
           || '格を最後まで読んで同じ件が 1 つもなければ、contribution_type=no_change、outcome=confirmed、task_id（' || g.tid || '）、finding に比べた組み合わせ、checked_urls に読んだページを入れて報告します。'
           || 'note には、なぜ同じ件と言えるか（原文や報道に出てくる同じ事業名・場所・金額・法令名）を具体的に書きます。',
         ARRAY['target.policies が清單そのもの。各政策の出典は jp.hustings.net の政策ページ（policy_id）',
               CASE WHEN g.level = 'national' THEN '国会会議録検索システム（kokkai.ndl.go.jp）・衆議院／参議院の議案情報' ELSE g.lg_name || ' の公式サイト（施政方針・予算・総合計画）' END,
               '議会の会議録（会議録検索システム）',
               CASE WHEN g.level = 'national' THEN '各省庁の事業・法令（*.go.jp）' ELSE g.pref_name || ' の公式サイト（*.lg.jp）' END]::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_lineage_candidates IS
  '脈絡の候補（正見 lineage_candidates の日本版）：同じ層・同じ団体・同じ分野の政策を 1 つの格にまとめ、2 つ以上の任期・参選にまたがり、脈絡に入っていない政策が 1 件でもあれば lineage_candidate 任務（task_id＝auto:lineage_candidate:<格の鍵>:<指紋>）。'
  '同じ指紋の confirmed は永久（落庫された lineage も同じ task_id に confirmed を足す）、票待ちの lineage があれば派さない。窓（規則の enabled）は総表が決める。terms の多い格から cap 件';

-- ------------------------------------------------------------
-- 8. 臂 handover_missing（脈絡の中に首長の任期の政策があり、その職位が別の人に交代し、前任の任期は終わっているのに交接の記録がない）
-- ------------------------------------------------------------
-- 首長（governor／mayor／ward_mayor／town_mayor）の任期だけ。後任＝同じ団体・同じ職位で、前任より後に始まり、今日までに始まった最初の任期。同じ人の再選は対象にしない（正見と同じ）
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_handover_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'handover_missing' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  exec AS (
    -- 脈絡に入っている政策 → その政策の任期（公約は参選から出た任期、公約以外は office_ids のどれか）。前任の任期が終わっているものだけ
    SELECT DISTINCT pl.lineage_id, fo.id AS from_office_id
      FROM policy_jp.policies pl
      JOIN policy_jp.lineages l ON l.id = pl.lineage_id AND l.review_status = 'published'
      JOIN policy_jp.politician_offices fo ON fo.review_status = 'published'
           AND fo.position IN ('governor', 'mayor', 'ward_mayor', 'town_mayor')
           AND fo.end_date IS NOT NULL AND fo.end_date < policy_jp.activity_today()
           AND ((pl.politician_election_id IS NOT NULL AND fo.politician_election_id = pl.politician_election_id)
                OR (pl.politician_election_id IS NULL AND fo.id = ANY (pl.office_ids)))
     WHERE pl.review_status = 'published' AND pl.lineage_id IS NOT NULL
  ),
  succ AS (
    SELECT DISTINCT ON (x.lineage_id, x.from_office_id) x.lineage_id, x.from_office_id, so.id AS to_office_id
      FROM exec x
      JOIN policy_jp.politician_offices fo ON fo.id = x.from_office_id
      JOIN policy_jp.politician_offices so ON so.review_status = 'published' AND so.position = fo.position AND so.lg_code IS NOT DISTINCT FROM fo.lg_code
           AND so.start_date > fo.start_date AND so.start_date <= policy_jp.activity_today()
     ORDER BY x.lineage_id, x.from_office_id, so.start_date, so.id
  ),
  gaps AS (
    SELECT s.lineage_id, s.from_office_id, s.to_office_id,
           'auto:handover_missing:' || s.lineage_id || ':' || substr(md5(s.from_office_id || ':' || s.to_office_id), 1, 8) AS tid,
           l.title, l.level, l.lg_code, g.name AS lg_name, fo.position, fo.start_date AS from_start, fo.end_date AS from_end, so.start_date AS to_start,
           fp.id AS from_pid, fp.name AS from_name, tp.id AS to_pid, tp.name AS to_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = g.pref_code), '全国') AS pref_name
      FROM succ s
      CROSS JOIN cfg
      JOIN policy_jp.lineages l ON l.id = s.lineage_id
      JOIN policy_jp.politician_offices fo ON fo.id = s.from_office_id
      JOIN policy_jp.politician_offices so ON so.id = s.to_office_id
      JOIN policy_jp.politicians fp ON fp.id = fo.politician_id AND fp.review_status = 'published'
      JOIN policy_jp.politicians tp ON tp.id = so.politician_id AND tp.review_status = 'published'
      LEFT JOIN policy_jp.local_governments g ON g.lg_code = fo.lg_code
     WHERE cfg.cap IS NOT NULL AND so.politician_id <> fo.politician_id
       AND NOT EXISTS (SELECT 1 FROM policy_jp.handovers h WHERE h.lineage_id = s.lineage_id AND h.from_office_id = s.from_office_id AND h.to_office_id = s.to_office_id)
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                        WHERE c.contribution_type = 'lineage_handover' AND c.status IN ('pending', 'verified', 'apply_failed')
                          AND c.payload->>'lineage_id' = s.lineage_id
                          AND c.payload->>'from_office_id' = s.from_office_id AND c.payload->>'to_office_id' = s.to_office_id)
       AND NOT policy_jp.task_unavailable('auto:handover_missing:' || s.lineage_id || ':' || substr(md5(s.from_office_id || ':' || s.to_office_id), 1, 8))
     ORDER BY fo.end_date, s.lineage_id, s.from_office_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT g.tid, 'handover_missing',
         jsonb_build_object(
           'lineage_id', g.lineage_id, 'lineage_title', g.title, 'level', g.level, 'lg_code', g.lg_code, 'lg_name', g.lg_name, 'position', g.position,
           'from_office_id', g.from_office_id, 'from_politician_id', g.from_pid, 'from_name', g.from_name, 'from_term_start', g.from_start, 'from_term_end', g.from_end,
           'to_office_id', g.to_office_id, 'to_politician_id', g.to_pid, 'to_name', g.to_name, 'to_term_start', g.to_start,
           'from_policies', COALESCE((SELECT jsonb_agg(jsonb_build_object('policy_id', pl.id, 'title', pl.title, 'status', pl.status) ORDER BY pl.id)
                                        FROM policy_jp.policies pl JOIN policy_jp.politician_offices fo2 ON fo2.id = g.from_office_id
                                       WHERE pl.lineage_id = g.lineage_id AND pl.review_status = 'published'
                                         AND ((pl.politician_election_id IS NOT NULL AND pl.politician_election_id = fo2.politician_election_id) OR fo2.id = ANY (pl.office_ids))), '[]'::JSONB),
           'to_policies', COALESCE((SELECT jsonb_agg(jsonb_build_object('policy_id', pl.id, 'title', pl.title, 'status', pl.status) ORDER BY pl.id)
                                      FROM policy_jp.policies pl JOIN policy_jp.politician_offices to2 ON to2.id = g.to_office_id
                                     WHERE pl.lineage_id = g.lineage_id AND pl.review_status = 'published'
                                       AND ((pl.politician_election_id IS NOT NULL AND pl.politician_election_id = to2.politician_election_id) OR to2.id = ANY (pl.office_ids))), '[]'::JSONB)),
         '脈絡「' || g.title || '」には、' || g.from_name || ' さん（' || COALESCE(g.lg_name, '') || '、' || g.from_start || ' 就任・' || g.from_end || ' 退任）の任期の政策が入っています。'
           || '後任は ' || g.to_name || ' さん（' || g.to_start || ' 就任）ですが、この脈絡にはこの二人の間の交接の記録がありません。'
           || g.to_name || ' さんの就任後、この件がどう扱われたかを調べてください：そのまま続けた（keep 継承）、目的は同じで進め方を変えた（pivot 転換）、'
           || '規模や予算は縮んだが続いている（shrink 縮小）、止めた（stop 中止）、いったん止めて再開した（resume 再開）。'
           || 'contribution_type=lineage_handover で提出します：payload は lineage_id（' || g.lineage_id || '）・from_office_id（' || g.from_office_id || '）・to_office_id（' || g.to_office_id
           || '）・handover_type・decided_on（判断の根拠になった日付、わかれば）・note（20～500 字：どの文書にどう書いてあるか）・source_locator（出典のどこか：予算書の頁・会議録の日付と案件）。'
           || '**stop（中止）には、自治体・議会の公式サイト（*.lg.jp・*.go.jp 等）の出典が 1 つ必要で、中止の判定は 2 つの別々の接続元の確認票が集まるまで公開されません。**'
           || '後任の政策リストに載っていないことは中止の根拠になりません。中止・取りやめ・解約が文書に書かれていることが必要です。'
           || '就任して間もない、公開資料がまだ何もない、などで調べても分からなければ、contribution_type=no_change、outcome=not_found、task_id（' || g.tid || '）、checked_urls に調べた場所を入れて報告します。',
         ARRAY[COALESCE(g.lg_name, '国') || ' の公式サイト（施政方針・予算書・主要施策の成果報告書）', '議会の会議録（一般質問・予算審査）', '総合計画・実施計画', g.pref_name || ' の公式サイト（*.lg.jp）']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_handover_missing IS
  '脈絡の交接の欠け（正見 handover_missing の日本版）：脈絡の中に首長の任期の政策があり、同じ団体・職位で別の人が後に就任し、前任の任期が終わっているのに handovers の記録がない → handover_missing 任務'
  '（task_id＝auto:handover_missing:<脈絡 id>:<md5(from_office:to_office) 前 8 字>）。同じ人の再選は対象外。終了日の早い順に cap 件。窓は総表が決める';

-- ------------------------------------------------------------
-- 9. 臂 lineage_roles（脈絡の中に議員（国会・地方）の政策があり、その人の役割の記録がない）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_lineage_roles()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'lineage_roles' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  people AS (
    SELECT DISTINCT pl.lineage_id, pp.id AS politician_id, pp.name
      FROM policy_jp.policies pl
      JOIN policy_jp.lineages l ON l.id = pl.lineage_id AND l.review_status = 'published'
      LEFT JOIN policy_jp.politician_elections pe ON pe.id = pl.politician_election_id
      LEFT JOIN policy_jp.politician_offices o ON o.id = ANY (pl.office_ids) AND pl.politician_election_id IS NULL
      JOIN policy_jp.politicians pp ON pp.id = COALESCE(pe.politician_id, o.politician_id) AND pp.review_status = 'published'
     WHERE pl.review_status = 'published' AND pl.lineage_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM policy_jp.politician_offices ao
                    WHERE ao.politician_id = pp.id AND ao.review_status = 'published' AND ao.start_date <= policy_jp.activity_today()
                      AND ao.position IN ('pref_assembly_member', 'muni_assembly_member', 'representative', 'councillor'))
       AND NOT EXISTS (SELECT 1 FROM policy_jp.lineage_participants lp WHERE lp.lineage_id = pl.lineage_id AND lp.politician_id = pp.id)
  ),
  grp AS (
    SELECT lineage_id, jsonb_agg(jsonb_build_object('politician_id', politician_id, 'name', name) ORDER BY name, politician_id) AS people,
           string_agg(name, '、' ORDER BY name, politician_id) AS names
      FROM people GROUP BY lineage_id
  ),
  gaps AS (
    SELECT l.id AS lineage_id, l.title, l.level, l.lg_code, l.category, g.people, g.names, lg.name AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = lg.pref_code), '全国') AS pref_name
      FROM grp g
      CROSS JOIN cfg
      JOIN policy_jp.lineages l ON l.id = g.lineage_id
      LEFT JOIN policy_jp.local_governments lg ON lg.lg_code = l.lg_code
     WHERE cfg.cap IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                        WHERE c.contribution_type = 'lineage_participants' AND c.status IN ('pending', 'verified', 'apply_failed')
                          AND c.payload->>'lineage_id' = l.id)
       AND NOT policy_jp.task_unavailable('auto:lineage_roles_missing:' || l.id)
     ORDER BY l.id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT 'auto:lineage_roles_missing:' || g.lineage_id, 'lineage_roles_missing',
         jsonb_build_object('lineage_id', g.lineage_id, 'lineage_title', g.title, 'level', g.level, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'category', g.category, 'people', g.people),
         '脈絡「' || g.title || '」には議員の政策が入っています（' || g.names || '）が、この件でのそれぞれの役割がまだ記録されていません。'
           || '**公的な記録**で調べてください：国会会議録検索システムと衆議院・参議院の議案情報（提出者・賛成者）、都道府県議会・市区町村議会の議案・会議録（提出者・賛成者・質問や討論での主張）。'
           || '誰が提出者（proposer）、共同提出者（co_proposer）、賛成者・連署（cosigner）、公的な記録の中でこの件を主張・推進した人（advocate、例：一般質問、討論）かを探し、'
           || '——target.people に限らず、同じ議案の他の提出者・賛成者も一緒に——contribution_type=lineage_participants で提出します。'
           || 'basis は official_record（公的な記録）にし、出典はそのページ、source_locator に議案番号・頁・会議録の日付と案件を書きます。'
           || '本人がサイトや報道や答弁で「自分が提案した」と言っているだけで公的な記録がそうなっていないときは、公的な記録のとおりの役割を official_record で出し、別の項目として basis=self_claim（本人の主張）を足します。'
           || 'SNS（Facebook・X・Instagram など、読めないもの）は出典に使えません。公的な記録でこの件との関係が見つからない人には、役割を付けないでください。'
           || '全員について何も見つからなければ、contribution_type=no_change、outcome=not_found、task_id（auto:lineage_roles_missing:' || g.lineage_id || '）、checked_urls に調べた議案・会議録のページを入れて報告します。',
         ARRAY['国会会議録検索システム https://kokkai.ndl.go.jp/', '衆議院・参議院の議案情報（提出者・賛成者）', COALESCE(g.lg_name || ' 議会', '都道府県・市区町村議会') || ' の会議録・議案', g.pref_name || ' の公式サイト（*.lg.jp）']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_lineage_roles IS
  '脈絡の参加者の役割（正見 lineage_roles の日本版）：脈絡の中に議員任期（pref_assembly_member／muni_assembly_member／representative／councillor）を持つ人の政策があり、その人の lineage_participants がない → lineage_roles_missing 任務（task_id＝auto:lineage_roles_missing:<脈絡 id>）。窓は総表が決める';

-- ------------------------------------------------------------
-- 10. 臂 lineage_links（同じ分野で、一つ上の層の脈絡との関連がまだない → 上下級の関係を判断させる）
-- ------------------------------------------------------------
-- 下級の脈絡 1 本が 1 件。上級の候補（同じ分野で一つ上の層）を並べて渡す。候補の並びが変わると指紋が変わって出直す（confirmed は同じ指紋の間だけ永久）
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_lineage_links()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS MATERIALIZED (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'lineage_links' AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  cand AS (
    SELECT lo.id AS lower_id, up.id AS upper_id, up.title AS upper_title, up.level AS upper_level, up.lg_code AS upper_lg
      FROM policy_jp.lineages lo
      JOIN policy_jp.lineages up ON up.category = lo.category AND up.id <> lo.id AND up.review_status = 'published'
           AND policy_jp.lineage_link_level_ok(up.level, up.lg_code, lo.level, lo.lg_code)
     WHERE lo.review_status = 'published' AND lo.category IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.lineage_links k WHERE k.upper_lineage_id = up.id AND k.lower_lineage_id = lo.id)
  ),
  grp AS (
    SELECT lower_id,
           jsonb_agg(jsonb_build_object('lineage_id', upper_id, 'title', upper_title, 'level', upper_level, 'lg_code', upper_lg)
                     ORDER BY upper_level, upper_title, upper_id) AS uppers,
           substr(md5(string_agg(upper_id, ',' ORDER BY upper_id)), 1, 8) AS fp,
           count(*) AS n
      FROM cand GROUP BY lower_id
  ),
  gaps AS (
    SELECT g.lower_id, g.uppers, g.fp, g.n, 'auto:lineage_link_candidate:' || g.lower_id || ':' || g.fp AS tid,
           lo.title, lo.level, lo.lg_code, lo.category, lg.name AS lg_name,
           COALESCE((SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = lg.pref_code), '全国') AS pref_name
      FROM grp g
      CROSS JOIN cfg
      JOIN policy_jp.lineages lo ON lo.id = g.lower_id
      LEFT JOIN policy_jp.local_governments lg ON lg.lg_code = lo.lg_code
     WHERE cfg.cap IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = 'auto:lineage_link_candidate:' || g.lower_id || ':' || g.fp AND tc.outcome = 'confirmed')
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                        WHERE c.contribution_type = 'lineage_link' AND c.status IN ('pending', 'verified', 'apply_failed')
                          AND c.task_id = 'auto:lineage_link_candidate:' || g.lower_id || ':' || g.fp)
       AND NOT policy_jp.task_unavailable('auto:lineage_link_candidate:' || g.lower_id || ':' || g.fp)
     ORDER BY g.lower_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT g.tid, 'lineage_link_candidate',
         jsonb_build_object('lineage_id', g.lower_id, 'lineage_title', g.title, 'level', g.level, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'category', g.category, 'fingerprint', g.fp, 'upper_candidates', g.uppers),
         '脈絡「' || g.title || '」（' || CASE WHEN g.level = 'regional' OR g.level = 'local' THEN g.lg_name ELSE '国' END || '）には、一つ上の層で同じ分野の脈絡 ' || g.n
           || ' 本（target.upper_candidates）との関連の記録がありません。**実際の法令・予算・補助・計画のつながり**があるかを判断してください：'
           || '上が法令や補助を定め、こちらがそれを受けて実行している（top_down、例：国の交付金や法律 → 自治体の実施計画）、'
           || 'またはこちらが先に動き、あとから上が制度にした（bottom_up、例：自治体の先行事業 → 国の制度化）。'
           || 'あれば contribution_type=lineage_link で提出します：upper_lineage_id（上級の脈絡）・lower_lineage_id（' || g.lower_id || '）・link_type・'
           || 'note（20～500 字：どの法令・補助の決定通知・実施計画がどの案を挙げているか）・source_locator（条文・通知番号・計画書の頁）。1 組ごとに 1 件です。'
           || '同じ分野でも、法令・予算・計画のつながりが見つからない（テーマが似ているだけ）ものは関連にしません。'
           || '全部を見てどれも関連がなければ、contribution_type=no_change、outcome=confirmed、task_id（' || g.tid || '）、finding に 1 本ずつ見た結論、checked_urls に読んだページを入れて報告します。',
         ARRAY['国・自治体の計画と補助・交付金の決定（*.go.jp・*.lg.jp）', 'e-Gov 法令検索 https://laws.e-gov.go.jp/', '議会の会議録', g.pref_name || ' の公式サイト（*.lg.jp）']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_lineage_links IS
  '脈絡の上下級の関連（正見 lineage_links の日本版）：同じ分野で一つ上の層（国→都道府県・市区町村、都道府県→その市区町村）の脈絡と、関連の記録がまだない下級の脈絡 → lineage_link_candidate 任務'
  '（task_id＝auto:lineage_link_candidate:<下級の脈絡 id>:<候補の指紋>）。同じ指紋の confirmed は永久。窓は総表が決める';

-- ------------------------------------------------------------
-- 11. 総表・臂名・鎖の段・落庫の振り分け（20261011200000 の版に、臂 4 つ／WHEN 4 行を足しただけ）
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
    'deadline_due',
    'lineage_candidates',
    'handover_missing',
    'lineage_roles',
    'lineage_links'
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
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM policy_jp.contribution_auto_tasks_lineage_candidates() t
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_handover_missing() t
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM policy_jp.contribution_auto_tasks_lineage_roles() t
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM policy_jp.contribution_auto_tasks_lineage_links() t
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
                  WHEN 'lineage_candidate' THEN 9
                  WHEN 'handover_missing' THEN 9
                  WHEN 'lineage_roles_missing' THEN 9
                  WHEN 'lineage_link_candidate' THEN 9
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／candidate_status_stale／not_running_recheck／candidacy_source_missing／district_seats_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing／duplicate_policy／term_policy_missing 8、progress_stale／deadline_due／lineage_candidate／handover_missing／lineage_roles_missing／lineage_link_candidate 9（任期中の追跡と政策の継承は鎖の最後）。登録のない auto 型別も 9';
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
               WHEN 'lineage' THEN policy_jp.apply_lineage(c)
               WHEN 'lineage_participants' THEN policy_jp.apply_lineage_participants(c)
               WHEN 'lineage_handover' THEN policy_jp.apply_lineage_handover(c)
               WHEN 'lineage_link' THEN policy_jp.apply_lineage_link(c)
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
-- 12. 規則（enabled・既定）と主控台の段（冪等）
-- ------------------------------------------------------------
-- 窓＝常時、after_step なし（理由は檔頭の a）。優先層の専用規則は置かない＝既定の層（檔頭の b）。同時に開くのは最大 100 件（檔頭の d）
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'lineage_candidates', 'always', 'announced',
       '{"cap":100}'::JSONB,
       '同じ件の政策を脈絡にまとめる（正見 lineage_candidates）：同じ層・同じ団体・同じ分野で、複数の任期にまたがる政策の格のうち、まだ脈絡に入っていない政策があるものを、代理に調べさせる（lineage／同じ件がなければ no_change confirmed）。'
       || '窓は常時・鎖に掛けない（task の target に選挙がなく、里程碑で窓を切ると全件が閉じる）。同時に開くのは最大 100 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'lineage_candidates' AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'handover_missing', 'always', 'announced',
       '{"cap":100}'::JSONB,
       '前後任の交接（正見 handover_missing）：脈絡の中の政策の持ち主の任期が終わり、後任が就いているのに交接の記録がないものを、代理に調べさせる（lineage_handover／記録がなければ no_change not_found）。'
       || '窓は常時・鎖に掛けない（task の target に選挙がなく、里程碑で窓を切ると全件が閉じる）。同時に開くのは最大 100 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'handover_missing' AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'lineage_roles', 'always', 'announced',
       '{"cap":100}'::JSONB,
       '同級多人の役割（正見 lineage_roles）：脈絡の中の政策を持つ議員について、提案者・賛成者などの役割を調べさせる（lineage_participants／記録がなければ no_change not_found）。'
       || '窓は常時・鎖に掛けない（task の target に選挙がなく、里程碑で窓を切ると全件が閉じる）。同時に開くのは最大 100 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'lineage_roles' AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'lineage_links', 'always', 'announced',
       '{"cap":100}'::JSONB,
       '上下級の関連（正見 lineage_links）：国→都道府県→市区町村の脈絡のうち、関連がありそうなものを調べさせる（lineage_link／関連がなければ no_change confirmed）。'
       || '窓は常時・鎖に掛けない（task の target に選挙がなく、里程碑で窓を切ると全件が閉じる）。同時に開くのは最大 100 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'lineage_links' AND r.priority IS NULL);

-- 主控台時間軸の段：脈絡 3 本＝任期中（6）、交接＝卸任の交接（7）（正見 20261010110000 と同じ）
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('lineage_candidates', 6, '政策の脈絡づくり（同じ件の政策をまとめる）'),
  ('lineage_roles', 6, '脈絡の中の議員の役割'),
  ('lineage_links', 6, '上下級の脈絡の関連'),
  ('handover_missing', 7, '首長の交代に伴う政策の交接')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 13. 權限（新函式は PUBLIC に実行権が付くので明示的に収回）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_lineage_candidates(), policy_jp.contribution_auto_tasks_handover_missing(),
  policy_jp.contribution_auto_tasks_lineage_roles(), policy_jp.contribution_auto_tasks_lineage_links(),
  policy_jp.lineage_candidate_scope(), policy_jp.lineage_block_key(TEXT, TEXT, TEXT),
  policy_jp.lineage_level_of(TEXT), policy_jp.lineage_link_level_ok(TEXT, TEXT, TEXT, TEXT),
  policy_jp.apply_lineage(policy_jp.contributions), policy_jp.apply_lineage_participants(policy_jp.contributions),
  policy_jp.apply_lineage_handover(policy_jp.contributions), policy_jp.apply_lineage_link(policy_jp.contributions)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.contribution_auto_tasks_lineage_candidates(), policy_jp.contribution_auto_tasks_handover_missing(),
  policy_jp.contribution_auto_tasks_lineage_roles(), policy_jp.contribution_auto_tasks_lineage_links(),
  policy_jp.lineage_candidate_scope(), policy_jp.lineage_block_key(TEXT, TEXT, TEXT),
  policy_jp.lineage_level_of(TEXT), policy_jp.lineage_link_level_ok(TEXT, TEXT, TEXT, TEXT),
  policy_jp.apply_lineage(policy_jp.contributions), policy_jp.apply_lineage_participants(policy_jp.contributions),
  policy_jp.apply_lineage_handover(policy_jp.contributions), policy_jp.apply_lineage_link(policy_jp.contributions)
  TO service_role;

-- ------------------------------------------------------------
-- 14. 自我檢查：做錯就讓這支 migration 失敗
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT; v_arm TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  FOREACH v_arm IN ARRAY ARRAY['lineage_candidates', 'handover_missing', 'lineage_roles', 'lineage_links'] LOOP
    IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r
                    WHERE r.activity = v_arm AND r.priority IS NULL AND r.enabled AND r.window_kind = 'always'
                      AND r.after_step IS NULL AND r.params ? 'cap') THEN
      RAISE EXCEPTION 'policy_jp：% の規則が「開いている・常時窓・after_step なし・cap あり」になっていない', v_arm;
    END IF;
    IF EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:' || v_arm) THEN
      RAISE EXCEPTION 'policy_jp：% に優先層の専用規則を置かない（既定の層）', v_arm;
    END IF;
    IF NOT (v_arm = ANY (policy_jp.activity_arm_names())) THEN
      RAISE EXCEPTION 'policy_jp：activity_arm_names() に % がない', v_arm;
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
           AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_' || v_arm || '()%') <> 1 THEN
      RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 総表に % の分支がない', v_arm;
    END IF;
    IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_' || v_arm || '()', 'EXECUTE') THEN
      RAISE EXCEPTION 'policy_jp：% の派工関数を anon に渡してはいけない', v_arm;
    END IF;
  END LOOP;
  IF policy_jp.chain_step_rank('auto:lineage_candidate:x:y', 'lineage_candidate') <> 9
     OR policy_jp.chain_step_rank('auto:handover_missing:x:y', 'handover_missing') <> 9
     OR policy_jp.chain_step_rank('auto:lineage_roles_missing:x', 'lineage_roles_missing') <> 9
     OR policy_jp.chain_step_rank('auto:lineage_link_candidate:x:y', 'lineage_link_candidate') <> 9
     OR policy_jp.chain_step_rank('auto:progress_stale:x', 'progress_stale') <> 9
     OR policy_jp.chain_step_rank('auto:term_policy_missing:x', 'term_policy_missing') <> 8
     OR policy_jp.chain_step_rank('auto:policy_missing:x', 'policy_missing') <> 6 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank の登録がおかしい';
  END IF;
  IF (SELECT count(*) FROM policy_jp.console_arm_stage_map m
       WHERE (m.arm, m.stage) IN (('lineage_candidates', 6), ('lineage_roles', 6), ('lineage_links', 6), ('handover_missing', 7))) <> 4 THEN
    RAISE EXCEPTION 'policy_jp：console_arm_stage_map に脈絡の臂 4 つの段がない';
  END IF;
  -- 交件型別：DB CHECK、落庫清單、落庫の振り分け
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check'
                  AND pg_get_constraintdef(oid) LIKE '%lineage_participants%' AND pg_get_constraintdef(oid) LIKE '%lineage_handover%'
                  AND pg_get_constraintdef(oid) LIKE '%lineage_link%' AND pg_get_constraintdef(oid) LIKE '%policy_progress%') THEN
    RAISE EXCEPTION 'policy_jp：policy_jp_contributions_type_check に脈絡の型別がない（または既存の型別が消えた）';
  END IF;
  IF NOT (policy_jp.apply_types() @> ARRAY['lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'policy_progress', 'removal']::TEXT[]) THEN
    RAISE EXCEPTION 'policy_jp：apply_types() に脈絡の型別がない（または既存の型別が消えた）';
  END IF;
  IF pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_lineage(c)%'
     OR pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_lineage_participants(c)%'
     OR pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_lineage_handover(c)%'
     OR pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_lineage_link(c)%'
     OR pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_policy_progress%' THEN
    RAISE EXCEPTION 'policy_jp：apply_contribution に脈絡の WHEN がない（または既存の WHEN が消えた）';
  END IF;
  -- 共識：stop の交接だけ 2 つの網段、他は 1 つ・目標 3・系統票なし
  IF NOT policy_jp.contribution_needs_two_ips('lineage_handover', '{"handover_type":"stop"}'::JSONB)
     OR policy_jp.contribution_needs_two_ips('lineage_handover', '{"handover_type":"continue"}'::JSONB)
     OR policy_jp.contribution_needs_two_ips('lineage', '{}'::JSONB)
     OR policy_jp.contribution_required_agree('lineage', '{}'::JSONB, ARRAY[]::TEXT[]) <> 3
     OR 'lineage' = ANY (policy_jp.system_one_precheck_types()) THEN
    RAISE EXCEPTION 'policy_jp：脈絡の共識（stop の交接だけ網段 2 つ・目標 3・系統票なし）が期待と違う';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.apply_lineage(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_lineage_participants(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_lineage_handover(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_lineage_link(policy_jp.contributions)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：脈絡の落庫関数を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
