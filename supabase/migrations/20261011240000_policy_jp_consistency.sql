-- 日本站派工臂對齊正見 D 期「資料一致性と清理」：測試名の人物 placeholder_politicians／出典のない政見 policy_validity／公約の日付が投票日より後 mismatch（工作単 Yooliang/policy-ops#95 step 5、計画 policy-jp docs/PLAN-arms-parity.md D 期）
-- ============================================================
--
--   正見臂（activity）          日本臂（activity）          任務型別（task_type）        task_id                                              交件
--   placeholder_politicians     placeholder_politicians     placeholder_politician       auto:placeholder_politician:<人物 id>                 removal（target_table=politicians）／no_change（confirmed＝実在する）
--   raw:policy_validity         policy_validity             policy_validity              auto:policy_validity:<参選 id>:<政見 id>              policy（同じ題名・要約＋出典＝出典を足す）／removal（政策ではない）／no_change
--   mismatch                    mismatch                    policy_election_mismatch     auto:policy_election_mismatch:<政見 id>              correction（日付）／removal（公約ではない）／no_change
--
--   正見：20261007020000（placeholder_politicians 本体）、20261006140000（politician_name_is_placeholder）、20261008114000（優先層・隔離）、
--         20261010170000（raw:policy_validity）、20261007110000（mismatch）、1.57.0／1.66.0 の removal（人物）。
--
-- 搬さない 2 つ（正見の臂 5 つのうち）：
--   owner_mismatch（参選紀錄が別人に掛かっている疑い）：訊号が台湾専用。①中選会名冊の出生年（cec_candidates）②交件の region と今掛かっている縣市の食い違い（日本の candidacy 交件に region はない）
--     ③縣市またぎ（日本は市議→県議→首長など転身が普通で、同じ縣市でないことは疑いにならない）④⑤は no_change／投票の理由文の正規表現で、答えの型別 reassign_candidacy が日本站にない。
--     日本站には機械で照合できる名簿も、改掛の交件型別もない。同一人物の重複・誤結合は別の仕事（dup 臂、D 期の範囲外）なので、必要になったら reassign／merge の型別ごと別 PR で起こす。
--   raw:policy_election_missing（政見に所属の届別がない）：日本の policies に election_id 列がない。公約（origin=pledge）は politician_election_id が必須（CHECK policies_pledge_needs_candidacy、
--     origin と politician_election_id は同時に有る／無い）なので、「届別がない」状態はテーブルの制約で作れない。公約以外（policy_address／assembly／budget）は届別を持たない設計で、
--     今それを作る交件型別もない。
--   placeholder の「空殼」（kind=orphan）も搬さない：改掛 reassign_candidacy が前提。測試名人物を止める DB 触発器 politicians_reject_placeholder_name、
--     および『測試名人物の他の任務を止める』隔離（20261008114000）も、この支では入れない（後者は総表の全列に target の文字比較を掛けるので、日本站の規模では別に測ってから）。
--
-- 日本站のちがい：
--   a. placeholder：日本語の名前＋読みを見る（テスト／ダミー／サンプル／架空／てすと／だみー／さんぷる、英語は test／dummy／sample／placeholder が単語として）。正見のように行頭から禁止はしない（臂が検出）。
--      removal の target_table に politicians を足した（既存の型別を使う）：正見は人物と参選を DELETE するが、日本は policies と同じ軟移除（review_status='rejected'）：人物と、その人の参選を一緒に。
--      政見・任期・学歴職歴・政策の継承の役割が付いている人は取り除けない（実在の人の記録かもしれない。正見 politicianRemovalBlockers と同じ考え）；付いているものは target.attached に出す。
--      「実在する」と確かめられた（no_change confirmed）人は二度と派さない。窓＝常時、優先層＝前段（正見 priority:placeholder_politicians と同じ）。
--   b. policy_validity：正見は『出処（source_refs の primary）がない政見』。日本は公約（origin=pledge）で primary の出典を持たないもの。答えは policy 交件（同じ題名・同じ要約で出典の URL を付けて再提出すると apply_policy が unchanged＋出典を足す。
--      同一件事の層（decideSameClaim）は『在庫列と同じ』と宣言すると何も書かず no_change にしてしまうので、resolved_claim は differs:<政見 id>＋note『庫には出典がない』を使う。jp-next の same_claims 探査も足した）、政策ではないなら removal、確かめられないなら no_change。正見の correction(source_url) は日本の correction が落庫しない（verified 止まり）ので使わない。
--      today の落庫（apply_policy）は必ず出典を付けるので、この臂は通常空（守りの網）。
--   c. mismatch：正見は『政見の提出日が届別の投票日より後（当選者の任期中の施政は除く）』＋Jev の判定。日本は公約（pledge）の proposed_date が、その参選の選挙の投票日より後のもの。
--      当選者の例外はない（日本は任期中の発言を origin=policy_address 等で別に持ち、公約と混ぜない）。Jev の判定は日本站にない。答えは correction（proposed_date の訂正）、公約ではない（選挙後の施政方針）なら removal、no_change。
--      落庫（apply_policy）は proposed_date が投票日を超えないことを検査するので、この臂も通常空（correction・選挙日の訂正で後から起きる食い違いの網）。
--
-- この支でやること：
-- 1. politician_name_is_placeholder(name, kana)、politician_attached(人物 id)。
-- 2. removal に target_table=politicians（apply_politician_removal；apply_removal は 20261011180000 の版に先頭の分岐 1 つと文言を足しただけ）。新しい交件型別はない（DB CHECK・apply_types・apply_contribution・共識・同一件事は動かさない）。
-- 3. 臂 3 つ：総表 UNION 3 行・activity_arm_names 3 つ・activity_rules 3 条（enabled、常時窓、cap）・優先層（placeholder だけ前段）・chain_step_rank・console_arm_stage_map。
--    鎖：掛けない（after_step なし）。素材が『既に公開済みのデータ』なので選挙鎖の段に依存しない。chain_step_rank：placeholder_politician 1、policy_validity／policy_election_mismatch 8（整理の仕事は鎖の後）。
--    主控台の段は 3 つとも 1（常時、正見 20261010110000 と同じ）。
-- 守門：_shared/policy-jp-consistency.test.ts、policy-jp-dispatch-drift.test.ts（JP_ONLY 登記）、jp/contribution-schema*.test.ts。不碰 public、ditrust。冪等、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 小さな関数：測試名の判定・人物に付いているもの
-- ------------------------------------------------------------
-- 名前（と読み）がテスト用のデータに見えるか。NFKC 正規化（半角カナ・全角英字を揃える）してから、日本語の語は部分一致、英語の語は単語として一致
CREATE OR REPLACE FUNCTION policy_jp.politician_name_is_placeholder(p_name TEXT, p_kana TEXT DEFAULT NULL) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(normalize(COALESCE(p_name, '') || ' ' || COALESCE(p_kana, ''), NFKC) ~* '(テスト|ダミー|サンプル|架空|てすと|だみー|さんぷる)|(^|[^A-Za-z])(test|dummy|sample|placeholder)([^A-Za-z]|$)', false)
$$;
COMMENT ON FUNCTION policy_jp.politician_name_is_placeholder IS '名前（と読み）がテスト用のデータに見えるか（テスト・ダミー・サンプル・架空・てすと・だみー・さんぷる、英語は test／dummy／sample／placeholder が単語として）。正見 public.politician_name_is_placeholder の日本版（語が違う）';

-- 人物に付いている「本物らしい」内容の件数（取り除けるかの判定と任務の target.attached）：公開前か公開済みの政見（その人の参選に掛かるもの）・任期・学歴職歴・政策の継承の役割
CREATE OR REPLACE FUNCTION policy_jp.politician_attached(p_id TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT jsonb_build_object(
    'policies', (SELECT count(*) FROM policy_jp.policies pl JOIN policy_jp.politician_elections pe ON pe.id = pl.politician_election_id
                  WHERE pe.politician_id = p_id AND pl.review_status IN ('pending', 'published')),
    'offices', (SELECT count(*) FROM policy_jp.politician_offices o WHERE o.politician_id = p_id AND o.review_status IN ('pending', 'published')),
    'careers', (SELECT count(*) FROM policy_jp.politician_careers c WHERE c.politician_id = p_id AND c.review_status IN ('pending', 'published')),
    'lineage_participants', (SELECT count(*) FROM policy_jp.lineage_participants lp WHERE lp.politician_id = p_id AND lp.review_status IN ('pending', 'published')))
$$;
COMMENT ON FUNCTION policy_jp.politician_attached IS '人物に付いている内容の件数 {policies, offices, careers, lineage_participants}（公開前・公開済み）。placeholder 任務の target.attached と apply_politician_removal の「付いているものがあれば取り除けない」が共有。正見 politicianRemovalBlockers の日本版';

-- ------------------------------------------------------------
-- 2. 落庫 apply_politician_removal（removal の target_table=politicians）：人物とその人の参選を軟移除（review_status='rejected'）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_politician_removal(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_id TEXT := NULLIF(policy_jp.policy_trim(p->>'target_id'), '');
  pp policy_jp.politicians%ROWTYPE;
  v_new policy_jp.politicians%ROWTYPE;
  r policy_jp.politician_elections%ROWTYPE;
  r_new policy_jp.politician_elections%ROWTYPE;
  v_att JSONB;
  v_block TEXT;
  v_n INTEGER := 0;
BEGIN
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'target_id がない（取り除く人物の id）');
  END IF;
  IF char_length(policy_jp.policy_trim(p->>'reason')) < 20 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'reason は 20 字以上（なぜ取り除くか：どこを調べて実在しなかったか）');
  END IF;
  IF NULLIF(policy_jp.policy_trim(p->>'keep_id'), '') IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'keep_id は政見の removal だけに使う（人物には使えない）');
  END IF;
  SELECT * INTO pp FROM policy_jp.politicians WHERE id = v_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('人物 %s は登録されていない', v_id));
  END IF;
  IF pp.review_status = 'rejected' THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'politicians', 'record_id', v_id,
      'message', format('人物「%s」はすでに取り除かれている', pp.name));
  END IF;
  IF pp.review_status <> 'published' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('人物 %s は公開されていない（%s）ので removal の対象にならない', v_id, pp.review_status));
  END IF;
  -- 本物らしい内容が付いている人は取り除かない（同一人の重複は別の仕事、資料の誤りは correction）
  v_att := policy_jp.politician_attached(v_id);
  SELECT string_agg(a.key || '×' || a.value, '、' ORDER BY a.key) INTO v_block FROM jsonb_each_text(v_att) a WHERE a.value::INTEGER > 0;
  IF v_block IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('人物「%s」には %s が付いているので取り除けない（先にそれらが誤りなら個別に取り除く／直す）', pp.name, v_block));
  END IF;

  -- 参選を先に、人物を最後に（履歴から戻すときは新しい方から）
  FOR r IN SELECT * FROM policy_jp.politician_elections WHERE politician_id = v_id AND review_status <> 'rejected' ORDER BY id LOOP
    UPDATE policy_jp.politician_elections SET review_status = 'rejected', updated_at = now() WHERE id = r.id RETURNING * INTO r_new;
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('politician_elections', r.id, '*', to_jsonb(r), to_jsonb(r_new), c.id, 'auto-apply');
    v_n := v_n + 1;
  END LOOP;
  UPDATE policy_jp.politicians SET review_status = 'rejected', updated_at = now() WHERE id = v_id RETURNING * INTO v_new;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('politicians', v_id, '*', to_jsonb(pp), to_jsonb(v_new), c.id, 'auto-apply');
  -- 出典は任意（調べたページの記録）。あれば取り除いた人物に掛けておく
  IF cardinality(COALESCE(c.source_urls, '{}'::TEXT[])) > 0 THEN
    PERFORM policy_jp.source_write('politicians', v_id, c.source_urls, 'removal');
  END IF;
  UPDATE policy_jp.contributions SET applied_politician_id = v_id WHERE id = c.id;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'politicians', 'record_id', v_id,
    'message', format('人物「%s」と参選 %s 件を取り除いた（review_status=rejected、行は残る）', pp.name, v_n));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_politician_removal IS
  'removal 交件（target_table=politicians）の落庫：人物とその人の参選を軟移除（review_status を rejected に。行も子表も消さない）。公開済みだけ、すでに rejected は unchanged、'
  '政見・任期・学歴職歴・政策の継承の役割が付いている人は invalid。履歴は edit_history（旧行・新行）から戻せる。正見 applyPoliticianRemoval（DELETE）の日本版（軟移除）';

-- ------------------------------------------------------------
-- 3. apply_removal：20261011180000 の版に、先頭の分岐（politicians）と文言を足しただけ
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
  IF v_table = 'politicians' THEN
    RETURN policy_jp.apply_politician_removal(c);
  END IF;
  IF v_table IS DISTINCT FROM 'policies' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('removal で取り除けるのは policies（政見）か politicians（人物）だけ（target_table=%s）', COALESCE(v_table, '未指定')));
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
  'removal 交件の落庫（正見 applyRemoval の日本版）：政見 1 件の軟移除（review_status を rejected に。行も子表も消さない）。公開済みだけ、すでに rejected は unchanged、それ以外は invalid。target_table=politicians は apply_politician_removal（20261011240000）。'
  'keep_id（任意）は同じ参選の別の公開済み政見。履歴は edit_history（旧行・新行）から戻せる';

-- ------------------------------------------------------------
-- 4. 臂 placeholder_politicians（task_type=placeholder_politician）：名前がテスト用に見える公開済みの人物 → 実在するか調べ、しなければ removal
--    窓＝常時（規則）。『実在する』と確認済み（no_change confirmed）なら永久に派さない；人物の removal が審議中なら派さない
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_placeholder_politicians()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'placeholder_politicians' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  cand AS MATERIALIZED (
    SELECT pp.id, pp.name, pp.kana, policy_jp.politician_attached(pp.id) AS attached,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('politician_election_id', pe.id, 'election_id', pe.election_id, 'candidacy_status', pe.candidacy_status)
                                      ORDER BY pe.election_id, pe.id)
                       FROM policy_jp.politician_elections pe WHERE pe.politician_id = pp.id AND pe.review_status <> 'rejected'), '[]'::JSONB) AS elections,
           'auto:placeholder_politician:' || pp.id AS task_id
      FROM policy_jp.politicians pp
     WHERE pp.review_status = 'published' AND policy_jp.politician_name_is_placeholder(pp.name, pp.kana)
  ),
  gaps AS (
    SELECT c.*
      FROM cand c CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL
       -- もう誰かがこの人物の removal を出して、票待ち・自動再試行中：先に派さない（退件されれば戻る）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions x
                        WHERE x.contribution_type = 'removal' AND x.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                          AND x.payload->>'target_table' = 'politicians' AND x.payload->>'target_id' = c.id)
       -- 実在すると確認済み（no_change confirmed）：永久。not_found／unreachable は task_unavailable の冷却で戻る
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = c.task_id AND tc.outcome = 'confirmed')
       AND NOT policy_jp.task_unavailable(c.task_id)
     ORDER BY c.id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT g.task_id, 'placeholder_politician',
         jsonb_build_object('politician_id', g.id, 'name', g.name, 'kana', g.kana, 'elections', g.elections, 'attached', g.attached),
         '人物「' || g.name || '」' || COALESCE('（' || g.kana || '）', '') || 'の名前が、テスト用のデータのように見えます（「テスト」「ダミー」「サンプル」「架空」など）。実在する人なのかを確かめてください。'
           || '選挙管理委員会の候補者一覧、選挙公報、報道、本人や政党の公式サイトで、この人が実在し、立候補した（または公職にある）人かを調べます。'
           || '**実在しない**なら contribution_type=removal で提出します：payload は target_table（politicians）・target_id（' || g.id || '）・reason（20 字以上：どこを調べて見つからなかったか）。'
           || 'source_urls には調べたページ（候補者一覧など）を入れます。通ると、この人と、その人の参選の記録が画面から消えます（行は残り、履歴から戻せます）。'
           || '政見・任期・学歴職歴・政策の継承の役割が付いている人は取り除けません（実在の人の記録かもしれないため）：target.attached に付いている件数があります。'
           || '**実在する**（たまたまそう見える名前）なら contribution_type=no_change、outcome=confirmed、task_id（' || g.task_id || '）で報告し、checked_urls にその人が確認できる公式のページを入れます。確認済みの人は二度と派されません。'
           || '調べても決められないときは no_change、outcome=not_found（ページを開けなかったときは unreachable）で、探した場所を checked_urls と finding に書いてください。',
         ARRAY['選挙管理委員会の候補者一覧・選挙結果', '選挙公報', '総務省 選挙関連情報', '本人・政党の公式サイト']::TEXT[],
         1, NULL::TEXT
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_placeholder_politicians IS
  '測試名人物の臂（正見 placeholder_politicians の日本版・空殼なし）：名前（と読み）がテスト用に見える公開済みの人物 → placeholder_politician 任務（1 人 1 件、task_id＝auto:placeholder_politician:<人物 id>）。'
  '人物の removal が審議中・no_change confirmed 済み（永久）なら派さない。窓は規則（常時）、優先層は前段（priority:placeholder_politicians）。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 5. 臂 policy_validity（task_type=policy_validity）：出典（primary）のない公開済みの公約 → 政策ではないなら removal、政策なら出典を付けて policy で再提出
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_policy_validity()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'policy_validity' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  cand AS MATERIALIZED (
    SELECT pl.id AS policy_id, pl.title, pl.description, pl.category, pl.source_locator, pl.proposed_date,
           pe.id AS pe_id, pe.politician_id, pp.name,
           e.id AS election_id, e.name AS election_name, e.election_date, e.lg_code,
           COALESCE(g.name, '国政') AS lg_name,
           (SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)) AS pref_name,
           'auto:policy_validity:' || pe.id || ':' || pl.id AS task_id
      FROM policy_jp.policies pl
      JOIN policy_jp.politician_elections pe ON pe.id = pl.politician_election_id AND pe.review_status = 'published'
      JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
      JOIN policy_jp.elections e ON e.id = pe.election_id AND e.review_status = 'published'
      LEFT JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
     WHERE pl.review_status = 'published' AND pl.origin = 'pledge'
       AND NOT EXISTS (SELECT 1 FROM policy_jp.source_refs sr WHERE sr.target_table = 'policies' AND sr.target_id = pl.id AND sr.role = 'primary')
  ),
  gaps AS (
    SELECT c.*
      FROM cand c CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL
       -- もう誰かがこの政見に removal を出した、またはこの任務に policy／removal を出して、票待ち・自動再試行中：先に派さない（退件されれば戻る）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions x
                        WHERE x.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                          AND ((x.contribution_type = 'removal' AND x.payload->>'target_table' = 'policies' AND x.payload->>'target_id' = c.policy_id)
                               OR (x.contribution_type IN ('policy', 'removal') AND x.task_id = c.task_id)))
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = c.task_id AND tc.outcome = 'confirmed')
       AND NOT policy_jp.task_unavailable(c.task_id)
     ORDER BY c.election_date, c.policy_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT g.task_id, 'policy_validity',
         jsonb_build_object('policy_id', g.policy_id, 'policy_title', g.title, 'description', g.description, 'category', g.category, 'source_locator', g.source_locator,
                            'proposed_date', g.proposed_date, 'politician_election_id', g.pe_id, 'politician_id', g.politician_id, 'name', g.name,
                            'election_name', g.election_name, 'election_date', g.election_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name),
         '政見「' || g.title || '」（' || g.name || '、' || g.lg_name || ' ' || g.election_name || '）は公開されていますが、当方にその出典（原文のページ）が記録されていません。出典のない公約は確かめようがありません。'
           || '**まず、これが公約かどうかを判断します**：公約は「当選したらやる具体的なこと」で、何を・誰に・どの程度かが読み取れるものです。'
           || 'スローガン、チーム紹介、日程、個人の意見表明、選挙戦の掛け声（「まちを元気に」「温かい〇〇市」など）は公約ではありません。'
           || '**公約でない**なら contribution_type=removal で提出します：payload は target_table（policies）・target_id（' || g.policy_id || '）・reason（20 字以上：どの種類に当たるか）。source_urls には確かめたページを入れます。'
           || '**公約である**なら原文を探し、contribution_type=policy で同じ公約を出典付きで出します：politician_election_id（' || g.pe_id || '）・title と description は現在の記録のまま・category・source_locator（原文のどこか）・'
           || 'source_urls に原文のページ。resolved_claim は "differs:' || g.policy_id || '"（庫の政見には出典がなく、この提出は出典を付ける、という違い）、頂層の note（10 字以上）にそう書きます。題名と要約が同じなら新しい政見は作られず、出典だけが足されます。'
           || 'どちらも確かめられないときは no_change、outcome=not_found（ページを開けなかったときは unreachable）で、探した場所を checked_urls と finding に書いてください。',
         ARRAY['選挙公報（' || g.lg_name || ' 選挙管理委員会）', '候補者本人の公式サイト・公式パンフレット', '政見放送・公開討論会の記録', '報道（新聞・自治体広報）']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_policy_validity IS
  '出典なし公約の臂（正見 raw:policy_validity の日本版）：公開済みの公約（origin=pledge）で primary の出典（source_refs）がないもの → policy_validity 任務（1 政見 1 件、task_id＝auto:policy_validity:<参選 id>:<政見 id>）。'
  '答えは removal（公約ではない）／policy（同じ題名・要約＋出典＝出典を足す）／no_change。審議中・confirmed 済み（永久）なら派さない。窓は規則（常時）。params.cap は可派の前 N 件（投票日の近い順）';

-- ------------------------------------------------------------
-- 6. 臂 mismatch（task_type=policy_election_mismatch）：公約の提出日がその選挙の投票日より後 → 日付を直す correction／公約ではないなら removal
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_mismatch()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'mismatch' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  cand AS MATERIALIZED (
    SELECT pl.id AS policy_id, pl.title, pl.proposed_date, pl.source_locator,
           pe.id AS pe_id, pe.politician_id, pp.name,
           e.id AS election_id, e.name AS election_name, e.election_date, e.lg_code,
           COALESCE(g.name, '国政') AS lg_name,
           (SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(e.lg_code)) AS pref_name,
           (SELECT s.url FROM policy_jp.source_refs sr JOIN policy_jp.sources s ON s.id = sr.source_id
             WHERE sr.target_table = 'policies' AND sr.target_id = pl.id
             ORDER BY (sr.role = 'primary') DESC, sr.created_at, s.id LIMIT 1) AS source_url,
           'auto:policy_election_mismatch:' || pl.id AS task_id
      FROM policy_jp.policies pl
      JOIN policy_jp.politician_elections pe ON pe.id = pl.politician_election_id AND pe.review_status = 'published'
      JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
      JOIN policy_jp.elections e ON e.id = pe.election_id AND e.review_status = 'published'
      LEFT JOIN policy_jp.local_governments g ON g.lg_code = e.lg_code
     WHERE pl.review_status = 'published' AND pl.origin = 'pledge'
       AND pl.proposed_date IS NOT NULL AND pl.proposed_date > e.election_date
  ),
  gaps AS (
    SELECT c.*
      FROM cand c CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL
       -- もう誰かがこの政見の correction／removal を出して、票待ち・自動再試行中（correction は落庫されず verified で止まる）：先に派さない
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions x
                        WHERE x.contribution_type IN ('correction', 'removal') AND x.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                          AND ((x.payload->>'target_table' = 'policies' AND x.payload->>'target_id' = c.policy_id) OR x.task_id = c.task_id))
       -- 確認済み（no_change confirmed）：永久。not_found／unreachable は task_unavailable の冷却で戻る
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc WHERE tc.task_id = c.task_id AND tc.outcome = 'confirmed')
       AND NOT policy_jp.task_unavailable(c.task_id)
     ORDER BY c.election_date, c.policy_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT g.task_id, 'policy_election_mismatch',
         jsonb_build_object('policy_id', g.policy_id, 'policy_title', g.title, 'proposed_date', g.proposed_date, 'source_locator', g.source_locator, 'source_url', g.source_url,
                            'politician_election_id', g.pe_id, 'politician_id', g.politician_id, 'name', g.name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_date', g.election_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name),
         '公約「' || g.title || '」（' || g.name || '、' || g.lg_name || ' ' || g.election_name || '）は、提出日が ' || g.proposed_date || ' と記録されていますが、その選挙の投票日は ' || g.election_date || ' で、日付が投票日より後になっています。'
           || '公約は投票の前に示すものなので、どちらかの記録が間違っています。出典（target.source_url）の原文を開いて確かめてください。'
           || '**提出日が違う**→ contribution_type=correction：target_table（policies）・target_id（' || g.policy_id || '）・changes に proposed_date（出典に日付が書いてあればその日、書いていなければ空）。'
           || '**選挙の投票日の記録が違う**→ correction：target_table（elections）・target_id（' || g.election_id || '）・changes に election_date。出典は選挙管理委員会の告示です。'
           || '**選挙の後の施政方針や議会答弁で、公約ではない**→ removal：target_table（policies）・target_id（' || g.policy_id || '）・reason（20 字以上）。'
           || 'どれとも確かめられないときは no_change、outcome=not_found（開けなかったときは unreachable）で、探した場所を checked_urls と finding に書いてください。'
           || '出典で日付も投票日も確かめた結果、この記録のままで正しいと言えるときだけ outcome=confirmed（二度と派されません）。',
         ARRAY['政見本体の出典（target.source_url）', g.lg_name || ' 選挙管理委員会の告示・選挙公報', '候補者本人の公式サイト']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_mismatch IS
  '公約の日付が投票日より後の臂（正見 mismatch の日本版・Jev の判定なし・当選者の例外なし）：公開済みの公約（origin=pledge）で proposed_date が参選の選挙の投票日より後 → policy_election_mismatch 任務（1 政見 1 件、task_id＝auto:policy_election_mismatch:<政見 id>）。'
  '答えは correction（政見の proposed_date または選挙の election_date）／removal（公約ではない）／no_change。correction／removal が審議中・confirmed 済み（永久）なら派さない。窓は規則（常時）。params.cap は可派の前 N 件（投票日の近い順）';

-- ------------------------------------------------------------
-- 7. 臂名・総表・層内順位：20261011230000 の版に 名前 3 つ／UNION 3 行／WHEN 3 行を足しただけ（残りは一字も変えない）
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
    'lineage_links',
    'party_roster',
    'party_gap',
    'party_info',
    'placeholder_politicians',
    'policy_validity',
    'mismatch'
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
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM policy_jp.contribution_auto_tasks_party_roster() t
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM policy_jp.contribution_auto_tasks_party_gap() t
  UNION ALL SELECT 'party_info' AS arm, t.* FROM policy_jp.contribution_auto_tasks_party_info() t
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM policy_jp.contribution_auto_tasks_placeholder_politicians() t
  UNION ALL SELECT 'policy_validity' AS arm, t.* FROM policy_jp.contribution_auto_tasks_policy_validity() t
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM policy_jp.contribution_auto_tasks_mismatch() t
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
                  WHEN 'party_missing' THEN 4
                  WHEN 'party_info_missing' THEN 4
                  WHEN 'placeholder_politician' THEN 1
                  WHEN 'policy_validity' THEN 8
                  WHEN 'policy_election_mismatch' THEN 8
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery／placeholder_politician 1、local_government_missing 2、regional_stats_missing 3、roster_check／party_missing／party_info_missing／candidate_status_stale／not_running_recheck／candidacy_source_missing／district_seats_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing／duplicate_policy／term_policy_missing／policy_validity／policy_election_mismatch 8、progress_stale／deadline_due／lineage_candidate／handover_missing／lineage_roles_missing／lineage_link_candidate 9（任期中の追跡と政策の継承は鎖の最後）。登録のない auto 型別も 9';

-- ------------------------------------------------------------
-- 8. 規則（enabled・常時窓）・優先層・主控台の段（冪等）
-- ------------------------------------------------------------
-- 3 つとも窓は常時・鎖に掛けない（素材が『すでに公開済みのデータ』）。params.cap は同時に開く最大件数
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'placeholder_politicians', 'always', 'announced', '{"cap":20}'::JSONB,
       '測試名人物（正見 placeholder_politicians）：名前（と読み）がテスト用に見える公開済みの人物に、実在するかを調べさせ、実在しなければ removal（target_table=politicians）。窓は常時・鎖に掛けない。同時に開くのは最大 20 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'placeholder_politicians' AND r.priority IS NULL);
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'policy_validity', 'always', 'announced', '{"cap":50}'::JSONB,
       '出典なし公約（正見 raw:policy_validity）：primary の出典がない公開済みの公約に、公約かを判断させ、公約でなければ removal、公約なら出典を付けた policy で出典を足させる。窓は常時・鎖に掛けない。同時に開くのは最大 50 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'policy_validity' AND r.priority IS NULL);
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'mismatch', 'always', 'announced', '{"cap":50}'::JSONB,
       '公約の日付が投票日より後（正見 mismatch）：公開済みの公約の提出日がその選挙の投票日より後のものに、どちらの記録が違うかを調べさせる（correction／removal）。窓は常時・鎖に掛けない。同時に開くのは最大 50 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'mismatch' AND r.priority IS NULL);

-- 優先層：placeholder は前段（正見 priority:placeholder_politicians と同じ。任務が少なく、片付ければデータが綺麗になる）。他の 2 つは既定の層（正見も選挙の通則だけ）
INSERT INTO policy_jp.activity_rules (activity, window_kind, priority, note)
SELECT 'priority:placeholder_politicians', 'always', 1,
       '前段：測試名の人物の確認は任務が少なく、終われば人物ごと画面から消える。永久に開き、選挙を指名しない；既定の層に戻したければこの 1 行を消す（migration）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:placeholder_politicians');

INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('placeholder_politicians', 1, '測試名の人物'),
  ('policy_validity', 1, '出典のない公約'),
  ('mismatch', 1, '公約の日付が投票日より後')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 9. 權限（内部関数：service_role だけ）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.politician_name_is_placeholder(TEXT, TEXT), policy_jp.politician_attached(TEXT),
  policy_jp.contribution_auto_tasks_placeholder_politicians(), policy_jp.contribution_auto_tasks_policy_validity(), policy_jp.contribution_auto_tasks_mismatch(),
  policy_jp.apply_politician_removal(policy_jp.contributions)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.politician_name_is_placeholder(TEXT, TEXT), policy_jp.politician_attached(TEXT),
  policy_jp.contribution_auto_tasks_placeholder_politicians(), policy_jp.contribution_auto_tasks_policy_validity(), policy_jp.contribution_auto_tasks_mismatch(),
  policy_jp.apply_politician_removal(policy_jp.contributions)
  TO service_role;

-- ------------------------------------------------------------
-- 10. 自我檢查
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT; v_arm TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  FOREACH v_arm IN ARRAY ARRAY['placeholder_politicians', 'policy_validity', 'mismatch'] LOOP
    IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = v_arm AND r.priority IS NULL AND r.enabled AND r.window_kind = 'always' AND r.after_step IS NULL AND r.params ? 'cap') THEN
      RAISE EXCEPTION 'policy_jp：% の規則が「開いている・常時・after_step なし・cap あり」になっていない', v_arm;
    END IF;
    IF NOT (v_arm = ANY (policy_jp.activity_arm_names())) THEN RAISE EXCEPTION 'policy_jp：activity_arm_names() に % がない', v_arm; END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
           AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_' || v_arm || '()%') <> 1 THEN
      RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 総表に % の分支がない', v_arm;
    END IF;
    IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_' || v_arm || '()', 'EXECUTE') THEN
      RAISE EXCEPTION 'policy_jp：% の派工関数を anon に渡してはいけない', v_arm;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:placeholder_politicians' AND r.priority = 1 AND r.window_kind = 'always') THEN
    RAISE EXCEPTION 'policy_jp：priority:placeholder_politicians（前段）の規則がない';
  END IF;
  IF policy_jp.chain_step_rank('auto:placeholder_politician:x', 'placeholder_politician') <> 1
     OR policy_jp.chain_step_rank('auto:policy_validity:x:y', 'policy_validity') <> 8
     OR policy_jp.chain_step_rank('auto:policy_election_mismatch:x', 'policy_election_mismatch') <> 8
     OR policy_jp.chain_step_rank('auto:party_missing:x', 'party_missing') <> 4
     OR policy_jp.chain_step_rank('auto:progress_stale:x', 'progress_stale') <> 9 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank の登録がおかしい';
  END IF;
  IF (SELECT count(*) FROM policy_jp.console_arm_stage_map m WHERE (m.arm, m.stage) IN (('placeholder_politicians', 1), ('policy_validity', 1), ('mismatch', 1))) <> 3 THEN
    RAISE EXCEPTION 'policy_jp：console_arm_stage_map に臂 3 つの段がない';
  END IF;
  IF NOT policy_jp.politician_name_is_placeholder('テスト太郎') OR NOT policy_jp.politician_name_is_placeholder('山田', 'てすと')
     OR NOT policy_jp.politician_name_is_placeholder('Test Taro') OR policy_jp.politician_name_is_placeholder('山田太郎', 'やまだたろう')
     OR policy_jp.politician_name_is_placeholder('Testa Rossa') THEN
    RAISE EXCEPTION 'policy_jp：politician_name_is_placeholder の判定がおかしい';
  END IF;
  -- 交件型別は増やしていない：removal が落庫清單にあり、apply_removal が politicians へ分岐する
  IF NOT (policy_jp.apply_types() @> ARRAY['removal', 'party_info', 'policy', 'candidacy']::TEXT[]) THEN
    RAISE EXCEPTION 'policy_jp：apply_types() から型別が消えた';
  END IF;
  IF pg_get_functiondef('policy_jp.apply_removal(policy_jp.contributions)'::regprocedure) NOT LIKE '%apply_politician_removal(c)%' THEN
    RAISE EXCEPTION 'policy_jp：apply_removal が politicians へ分岐していない';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.apply_politician_removal(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_removal(policy_jp.contributions)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：removal の落庫関数を anon に渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
