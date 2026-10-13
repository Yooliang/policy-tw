-- 日本站派工臂対齊正見 D 期：政党名簿（parties／party_aliases）と政党の臂 party_roster／party_gap／party_info、交件型別 party_info（工作単 Yooliang/policy-ops#95 step 5、計画 policy-jp docs/PLAN-arms-parity.md D 期）
-- ============================================================
--
--   正見臂（activity）   日本臂（activity）   任務型別（task_type）    task_id                                        交件
--   party_roster         party_roster         party_missing            auto:party_missing:<参選 id>                     candidacy（同じ状態＋party／party_id）／no_change（not_found）
--   party_gap            party_gap            party_missing            auto:party_missing:<参選 id>（投票日翌日から）   同上
--   party_info           party_info           party_info_missing       auto:party_info_missing:<書き方の鍵 12 字>       party_info／no_change（not_found）
--
--   正見：20261006100100／20261007010000（party_info_missing）、20261008120000／20261008121000（party_gap／party_roster の窓）、1.56.0／1.57.0（party_info 型別）。
-- 日本站にすでにあるもの（20261009000000）：parties（id TEXT・name・kana・short_name・predecessor_id・valid_from/to）、candidacy_endorsements、
--   politician_elections.party_id＋party_basis（party_basis あり＋party_id 空＝無所属、party_basis 空＝まだ知らない）。表は空。画面（policy-jp）は parties／candidacy_endorsements を読む（PartyListPage／PartyPage／CandidateCard）。
-- この支でやること：
-- 1. party_aliases（書き方 → 政党／無所属）：日本には内政部のような単一の名簿がない。政党は party_info の交件で作り、書き方は alias で結ぶ。「無所属」は政党ではない（kind=independent）。
--    politician_elections.party_text（候補者の交件に書かれた政党の書き方。alias に当たるまで party_id は空のまま）。alias が増えた時に party_text が当たる参選へ party_id を自動で入れる。
-- 2. 交件型別 party_info：政党を作る／空欄を埋める／alias を足す。candidacy は party（書き方）か party_id を受ける：apply_candidacy は触らず、薄い包み apply_candidacy_with_party が後で party を書く。
-- 3. 臂 3 つ（総表 UNION 3 行・activity_arm_names 3 つ・activity_rules 3 条・chain_step_rank・console_arm_stage_map）。
-- 正見とのちがい（policy-jp-dispatch-drift.test.ts の JP_ONLY に登記）：
--   a. 任務型別は candidacy_source_missing（kind=party）ではなく新しい party_missing：日本の candidacy_source_missing は『official 等級の出典を足す』任務で task_id の末尾が参選 id、これと混ぜると出典要件が衝突する。
--   b. 中選会名簿（cec_candidates）のような機械照合できる名簿が日本にない（選管の一覧は地方ごとにバラバラ）。臂は『party_basis も party_text も空の参選』を派し、代理が出典から所属を調べる。
--   c. 推薦・支持（candidacy_endorsements）は交件型別を作っていない：本人の所属（party_id）とは別の事実で、出典・種別・発表日の検査が別に要るため、次の支に回す。candidacy の party は本人の所属だけ（推薦・支持の政党を入れない）。
--   d. 政党の改名・解散日の派工（正見の party_info_missing の後半）は未移植：この支の party_info_missing は『書き方が名簿に当たらない』だけ。
-- 鎖：掛けない（after_step なし）。参選が上線している選挙（chain_open_elections）の参選しか素材にならない＝自然に『候補者がいる』後。窓は規則：party_roster＝投票日 +0 まで、party_gap＝投票日 +1 から、party_info＝常時。
-- 規則は enabled・cap。優先層：party_roster／party_gap は他の候補者臂と同じ 60／181 日（party_info は選挙に属さないので既定の層）。chain_step_rank＝4。主控台の段：party_info 1、party_roster 3、party_gap 4（正見 20261010110000 と同じ）。
-- 守門：_shared/policy-jp-parties.test.ts、policy-jp-dispatch-drift.test.ts（登記）、same-claims.test.ts（APPLY_IDEMPOTENT_TYPES）、jp/contribution-schema*.test.ts。不碰 public、ditrust。冪等、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 表・欄位・書き方の鍵
-- ------------------------------------------------------------
ALTER TABLE policy_jp.politician_elections ADD COLUMN IF NOT EXISTS party_text TEXT;
ALTER TABLE policy_jp.politician_elections DROP CONSTRAINT IF EXISTS politician_elections_party_text_nonblank;
ALTER TABLE policy_jp.politician_elections ADD CONSTRAINT politician_elections_party_text_nonblank CHECK (party_text IS NULL OR btrim(party_text) <> '');
COMMENT ON COLUMN policy_jp.politician_elections.party_text IS
  '交件に書かれた政党の書き方（原文）。party_aliases に当たれば party_id／party_basis が入る；当たるまでは party_basis 空のまま（party_info の任務が名簿に結ぶ）。画面には出さない';

-- 書き方の鍵：NFKC 正規化・小文字・空白と中黒を除く（全角半角・ゆれを同じ鍵に）
CREATE OR REPLACE FUNCTION policy_jp.party_text_key(p_text TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT NULLIF(lower(regexp_replace(normalize(btrim(p_text), NFKC), '[[:space:]・･]+', '', 'g')), '')
$$;
COMMENT ON FUNCTION policy_jp.party_text_key IS '政党の書き方 → 照合用の鍵（NFKC・小文字・空白と中黒を除く）。party_aliases.alias_key と politician_elections.party_text の突き合わせ用';

CREATE TABLE IF NOT EXISTS policy_jp.party_aliases (
  alias_key  TEXT PRIMARY KEY CHECK (alias_key <> ''),
  alias      TEXT NOT NULL CHECK (btrim(alias) <> ''),
  kind       TEXT NOT NULL CHECK (kind IN ('party', 'independent')),
  party_id   TEXT REFERENCES policy_jp.parties(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT party_aliases_kind_party CHECK ((kind = 'party') = (party_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS party_aliases_party_idx ON policy_jp.party_aliases (party_id);
COMMENT ON TABLE policy_jp.party_aliases IS '政党の書き方 → 政党（kind=party）または無所属（kind=independent、party_id 空）。「無所属」は政党ではない。交件 party_info でだけ増える';
ALTER TABLE policy_jp.party_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON policy_jp.party_aliases;
CREATE POLICY "Public read" ON policy_jp.party_aliases FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON policy_jp.party_aliases TO anon, authenticated;

-- 無所属の書き方：政党ではない固定の概念（データではなく規則）なので種を入れる
INSERT INTO policy_jp.party_aliases (alias_key, alias, kind, party_id)
VALUES (policy_jp.party_text_key('無所属'), '無所属', 'independent', NULL)
ON CONFLICT (alias_key) DO NOTHING;

-- ------------------------------------------------------------
-- 2. 落庫 apply_party_info：政党を作る／空欄を埋める／alias を足す。検査を先に全部終えてから書く
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_party_info(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_id TEXT := NULLIF(btrim(COALESCE(p->>'party_id', '')), '');
  v_name TEXT := NULLIF(btrim(COALESCE(p->>'name', '')), '');
  v_kana TEXT := NULLIF(btrim(COALESCE(p->>'kana', '')), '');
  v_short TEXT := NULLIF(btrim(COALESCE(p->>'short_name', '')), '');
  v_pred TEXT := NULLIF(btrim(COALESCE(p->>'predecessor_id', '')), '');
  v_from DATE; v_to DATE;
  v_aliases TEXT[] := '{}'; v_indep TEXT[] := '{}';
  v_keys TEXT[] := '{}';
  v_a TEXT; v_k TEXT;
  pt policy_jp.parties%ROWTYPE;
  v_found BOOLEAN := false;
  v_create BOOLEAN := false;
  v_changed BOOLEAN := false;
  v_n INTEGER;
  v_back INTEGER := 0;
  v_added INTEGER := 0;
  v_src BIGINT;
  a policy_jp.party_aliases%ROWTYPE;
BEGIN
  IF jsonb_typeof(p->'aliases') = 'array' THEN
    SELECT COALESCE(array_agg(btrim(x)), '{}') INTO v_aliases FROM jsonb_array_elements_text(p->'aliases') x WHERE btrim(x) <> '';
  ELSIF p ? 'aliases' AND jsonb_typeof(p->'aliases') <> 'null' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'aliases は文字列の配列');
  END IF;
  IF jsonb_typeof(p->'independent_aliases') = 'array' THEN
    SELECT COALESCE(array_agg(btrim(x)), '{}') INTO v_indep FROM jsonb_array_elements_text(p->'independent_aliases') x WHERE btrim(x) <> '';
  ELSIF p ? 'independent_aliases' AND jsonb_typeof(p->'independent_aliases') <> 'null' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'independent_aliases は文字列の配列');
  END IF;
  IF cardinality(v_aliases) > 20 OR cardinality(v_indep) > 20 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'aliases／independent_aliases は 20 個まで');
  END IF;
  IF v_id IS NULL AND v_name IS NULL AND cardinality(v_indep) = 0 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'party_id（既存の政党）か name（新しい政党）か independent_aliases（無所属の書き方）のどれかが要る');
  END IF;
  IF cardinality(v_aliases) > 0 AND v_id IS NULL AND v_name IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'aliases はどの政党の別表記かが要る（party_id か name）');
  END IF;
  -- 日付
  BEGIN
    IF NULLIF(p->>'valid_from', '') IS NOT NULL THEN
      IF p->>'valid_from' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', 'valid_from は YYYY-MM-DD'); END IF;
      v_from := (p->>'valid_from')::DATE;
    END IF;
    IF NULLIF(p->>'valid_to', '') IS NOT NULL THEN
      IF p->>'valid_to' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', 'valid_to は YYYY-MM-DD'); END IF;
      v_to := (p->>'valid_to')::DATE;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', '日付が実在しない');
  END;
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND v_to < v_from THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('valid_to（%s）が valid_from（%s）より前', v_to, v_from));
  END IF;
  -- 政党を探す（party_id 優先、なければ同名）。改名は新しい政党（predecessor_id）：同じ id で名前は変えない
  IF v_id IS NOT NULL THEN
    SELECT * INTO pt FROM policy_jp.parties WHERE id = v_id;
    v_found := FOUND;
    IF NOT v_found THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', format('party_id %s は parties にない', v_id)); END IF;
    IF v_name IS NOT NULL AND v_name <> pt.name THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'parties', 'record_id', pt.id, 'message', format('庫の %s は「%s」で、提出の「%s」と違う。改名は新しい政党として name＋predecessor_id で出す', pt.id, pt.name, v_name));
    END IF;
  ELSIF v_name IS NOT NULL THEN
    SELECT * INTO pt FROM policy_jp.parties WHERE name = v_name ORDER BY id LIMIT 1;
    v_found := FOUND;
    IF NOT v_found THEN
      IF v_kana IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', '新しい政党には kana（読み）が要る'); END IF;
      v_create := true;
    END IF;
  END IF;
  IF v_found AND v_kana IS NOT NULL AND v_kana <> pt.kana THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'parties', 'record_id', pt.id, 'message', format('庫の %s の読みは「%s」で、提出の「%s」と違う。読みは上書きしない', pt.id, pt.kana, v_kana));
  END IF;
  -- 前身：存在・自分自身でない・たどると自分に戻らない
  IF v_pred IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM policy_jp.parties x WHERE x.id = v_pred) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('predecessor_id %s は parties にない（先に前身の政党を party_info で作る）', v_pred));
    END IF;
    IF v_found AND (v_pred = pt.id OR EXISTS (
         WITH RECURSIVE up(id, depth) AS (SELECT v_pred, 0 UNION ALL SELECT x.predecessor_id, up.depth + 1 FROM policy_jp.parties x JOIN up ON x.id = up.id WHERE x.predecessor_id IS NOT NULL AND up.depth < 50)
         SELECT 1 FROM up WHERE up.id = pt.id)) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', '前身をたどると自分自身に戻る');
    END IF;
  END IF;
  -- 既存の政党の空欄だけ埋める：値があって違う＝conflict（上書きしない）
  IF v_found THEN
    IF (v_short IS NOT NULL AND pt.short_name IS NOT NULL AND pt.short_name <> v_short)
       OR (v_from IS NOT NULL AND pt.valid_from IS NOT NULL AND pt.valid_from <> v_from)
       OR (v_to IS NOT NULL AND pt.valid_to IS NOT NULL AND pt.valid_to <> v_to)
       OR (v_pred IS NOT NULL AND pt.predecessor_id IS NOT NULL AND pt.predecessor_id <> v_pred) THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'parties', 'record_id', pt.id, 'message', format('庫の %s（%s）に別の値が入っている（略称・開始日・終了日・前身）。上書きしない：訂正は correction で', pt.id, pt.name));
    END IF;
    IF v_to IS NOT NULL AND COALESCE(v_from, pt.valid_from) IS NOT NULL AND v_to < COALESCE(v_from, pt.valid_from) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', 'valid_to が valid_from より前になる');
    END IF;
  END IF;
  -- alias の衝突（明示した書き方だけ。他の政党・無所属に結ばれている鍵は奪わない）
  FOREACH v_a IN ARRAY v_aliases LOOP
    v_k := policy_jp.party_text_key(v_a);
    IF v_k IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', format('aliases の「%s」は照合用の鍵にならない（空）', v_a)); END IF;
    SELECT * INTO a FROM policy_jp.party_aliases WHERE alias_key = v_k;
    IF FOUND AND (a.kind <> 'party' OR a.party_id IS DISTINCT FROM pt.id) THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'party_aliases', 'record_id', v_k, 'message', format('書き方「%s」は既に別の扱い（%s %s）に結ばれている。奪わない', v_a, a.kind, COALESCE(a.party_id, '無所属')));
    END IF;
  END LOOP;
  FOREACH v_a IN ARRAY v_indep LOOP
    v_k := policy_jp.party_text_key(v_a);
    IF v_k IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', format('independent_aliases の「%s」は照合用の鍵にならない（空）', v_a)); END IF;
    SELECT * INTO a FROM policy_jp.party_aliases WHERE alias_key = v_k;
    IF FOUND AND a.kind <> 'independent' THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'party_aliases', 'record_id', v_k, 'message', format('書き方「%s」は政党に結ばれている。無所属の書き方にはできない', v_a));
    END IF;
  END LOOP;

  -- ---- 書く ----
  v_src := policy_jp.source_write(NULL, NULL, c.source_urls, 'party_info');
  IF v_src IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'source_urls に使える http(s) の URL がない');
  END IF;
  IF v_create THEN
    pt.id := gen_random_uuid()::TEXT; pt.name := v_name; pt.kana := v_kana; pt.short_name := v_short;
    INSERT INTO policy_jp.parties (id, name, kana, short_name, predecessor_id, valid_from, valid_to)
    VALUES (pt.id, v_name, v_kana, v_short, v_pred, v_from, v_to);
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('parties', pt.id, '*', NULL, (SELECT to_jsonb(x) FROM policy_jp.parties x WHERE x.id = pt.id), c.id, 'auto-apply');
    v_changed := true; v_found := true;
  ELSIF v_found THEN
    IF v_short IS NOT NULL AND pt.short_name IS NULL THEN
      UPDATE policy_jp.parties SET short_name = v_short WHERE id = pt.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name) VALUES ('parties', pt.id, 'short_name', NULL, to_jsonb(v_short), c.id, 'auto-apply');
      v_changed := true;
    END IF;
    IF v_from IS NOT NULL AND pt.valid_from IS NULL THEN
      UPDATE policy_jp.parties SET valid_from = v_from WHERE id = pt.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name) VALUES ('parties', pt.id, 'valid_from', NULL, to_jsonb(v_from), c.id, 'auto-apply');
      v_changed := true;
    END IF;
    IF v_to IS NOT NULL AND pt.valid_to IS NULL THEN
      UPDATE policy_jp.parties SET valid_to = v_to WHERE id = pt.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name) VALUES ('parties', pt.id, 'valid_to', NULL, to_jsonb(v_to), c.id, 'auto-apply');
      v_changed := true;
    END IF;
    IF v_pred IS NOT NULL AND pt.predecessor_id IS NULL THEN
      UPDATE policy_jp.parties SET predecessor_id = v_pred WHERE id = pt.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name) VALUES ('parties', pt.id, 'predecessor_id', NULL, to_jsonb(v_pred), c.id, 'auto-apply');
      v_changed := true;
    END IF;
  END IF;
  IF v_found THEN
    PERFORM policy_jp.source_write('parties', pt.id, c.source_urls, 'party_info');
    -- 明示した書き方＋正式名・略称（自動の分は他に取られていたら黙って飛ばす）
    FOREACH v_a IN ARRAY (v_aliases || ARRAY[pt.name] || CASE WHEN COALESCE(v_short, pt.short_name) IS NOT NULL THEN ARRAY[COALESCE(v_short, pt.short_name)] ELSE '{}'::TEXT[] END) LOOP
      v_k := policy_jp.party_text_key(v_a);
      CONTINUE WHEN v_k IS NULL;
      INSERT INTO policy_jp.party_aliases (alias_key, alias, kind, party_id) VALUES (v_k, v_a, 'party', pt.id) ON CONFLICT (alias_key) DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN
        v_added := v_added + 1; v_keys := v_keys || v_k;
        INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name) VALUES ('party_aliases', v_k, '*', NULL, to_jsonb(v_a), c.id, 'auto-apply');
      END IF;
    END LOOP;
  END IF;
  FOREACH v_a IN ARRAY v_indep LOOP
    v_k := policy_jp.party_text_key(v_a);
    INSERT INTO policy_jp.party_aliases (alias_key, alias, kind, party_id) VALUES (v_k, v_a, 'independent', NULL) ON CONFLICT (alias_key) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      v_added := v_added + 1; v_keys := v_keys || v_k;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name) VALUES ('party_aliases', v_k, '*', NULL, to_jsonb(v_a), c.id, 'auto-apply');
    END IF;
  END LOOP;
  -- 書き方が当たるようになった参選へ party_id を入れる（party_basis 空のものだけ。無所属＝party_id 空・party_basis=contribution）
  IF cardinality(v_keys) > 0 THEN
    WITH upd AS (
      UPDATE policy_jp.politician_elections pe SET party_id = a2.party_id, party_basis = 'contribution'
        FROM policy_jp.party_aliases a2
       WHERE pe.party_basis IS NULL AND pe.party_text IS NOT NULL
         AND a2.alias_key = policy_jp.party_text_key(pe.party_text) AND a2.alias_key = ANY (v_keys)
      RETURNING pe.id, pe.party_id
    ), ins AS (
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      SELECT 'politician_elections', u.id, 'party_id', NULL, to_jsonb(u.party_id), c.id, 'auto-apply' FROM upd u
      RETURNING 1
    )
    SELECT count(*) INTO v_back FROM upd;
  END IF;

  IF NOT v_changed AND v_added = 0 AND v_back = 0 THEN
    RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', CASE WHEN v_found THEN 'parties' ELSE 'party_aliases' END, 'record_id', pt.id, 'message', '政党・書き方とも庫に同じ内容で既にある');
  END IF;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', CASE WHEN v_found THEN 'parties' ELSE 'party_aliases' END, 'record_id', pt.id,
    'message', format('%s：%s、書き方を %s 件追加、参選 %s 件に政党を反映', COALESCE(pt.name, '無所属の書き方'), CASE WHEN v_create THEN '政党を新規作成' WHEN v_changed THEN '空欄を補完' ELSE '政党は変更なし' END, v_added, v_back));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_party_info IS
  'party_info 交件の落庫（正見 applyPartyInfo の日本版＋政党の新規作成）。新規＝name＋kana、既存は空欄だけ補完（値があって違う＝conflict）、alias を足す（他に結ばれた書き方は奪わない）、independent_aliases は無所属の書き方。alias が増えたら party_text の当たる参選へ party_id を反映';

-- ------------------------------------------------------------
-- 3. 落庫 apply_candidacy_with_party：apply_candidacy（20261011070000）は一字も変えず、後ろで政党だけを書く薄い包み
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.apply_candidacy_with_party(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_text TEXT := CASE WHEN jsonb_typeof(p->'party') = 'string' THEN NULLIF(btrim(p->>'party'), '') END;
  v_pid TEXT := CASE WHEN jsonb_typeof(p->'party_id') = 'string' THEN NULLIF(btrim(p->>'party_id'), '') END;
  v_key TEXT;
  v_res TEXT := 'none';          -- party／independent／unmatched／none
  v_party TEXT;
  a policy_jp.party_aliases%ROWTYPE;
  pe policy_jp.politician_elections%ROWTYPE;
  r JSONB;
  v_peid TEXT;
  v_note TEXT := '';
BEGIN
  IF v_text IS NULL AND v_pid IS NULL THEN RETURN policy_jp.apply_candidacy(c); END IF;
  IF v_text IS NOT NULL AND v_pid IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'party（書き方）と party_id はどちらか一方だけ');
  END IF;
  IF v_pid IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM policy_jp.parties x WHERE x.id = v_pid) THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('party_id %s は parties にない（task の target.known_parties から選ぶ。なければ party_info で先に作る）', v_pid));
    END IF;
    v_res := 'party'; v_party := v_pid;
  ELSE
    v_key := policy_jp.party_text_key(v_text);
    IF v_key IS NULL THEN RETURN jsonb_build_object('outcome', 'invalid', 'message', 'party が空'); END IF;
    SELECT * INTO a FROM policy_jp.party_aliases WHERE alias_key = v_key;
    IF FOUND THEN
      v_res := a.kind; v_party := a.party_id;
    ELSE
      v_res := 'unmatched';
    END IF;
  END IF;
  -- 庫の参選に既に所属が入っていて違う＝conflict（上書きしない。状態の更新より前に判定する＝半端に書かない）
  IF NULLIF(btrim(COALESCE(p->>'politician_id', '')), '') IS NOT NULL THEN
    SELECT * INTO pe FROM policy_jp.politician_elections
     WHERE politician_id = btrim(p->>'politician_id') AND election_id = btrim(COALESCE(p->>'election_id', '')) AND district_kind = COALESCE(p->>'district_kind', '');
    IF FOUND AND pe.party_basis IS NOT NULL AND v_res <> 'unmatched' AND pe.party_id IS DISTINCT FROM v_party THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'politician_elections', 'record_id', pe.id,
        'message', format('庫の %s は所属が %s（根拠 %s）で、提出の %s と違う。所属は上書きしない', pe.id, COALESCE(pe.party_id, '無所属'), pe.party_basis, COALESCE(v_party, '無所属')));
    END IF;
  END IF;

  r := policy_jp.apply_candidacy(c);
  IF r->>'outcome' NOT IN ('applied', 'unchanged') THEN RETURN r; END IF;
  v_peid := r->>'record_id';
  SELECT * INTO pe FROM policy_jp.politician_elections WHERE id = v_peid;
  IF NOT FOUND THEN RETURN r; END IF;

  IF pe.party_basis IS NULL THEN
    IF v_res IN ('party', 'independent') THEN
      UPDATE policy_jp.politician_elections SET party_id = v_party, party_basis = 'contribution', party_text = COALESCE(v_text, party_text) WHERE id = pe.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', pe.id, 'party_id', NULL, to_jsonb(v_party), c.id, 'auto-apply'),
             ('politician_elections', pe.id, 'party_basis', NULL, to_jsonb('contribution'::TEXT), c.id, 'auto-apply');
      v_note := format('、所属を %s に記録', COALESCE(v_party, '無所属'));
    ELSIF v_res = 'unmatched' AND pe.party_text IS DISTINCT FROM v_text THEN
      UPDATE policy_jp.politician_elections SET party_text = v_text WHERE id = pe.id;
      INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', pe.id, 'party_text', to_jsonb(pe.party_text), to_jsonb(v_text), c.id, 'auto-apply');
      v_note := format('、政党の書き方「%s」を記録（名簿にまだない：party_info の任務で結ぶ）', v_text);
    END IF;
  END IF;
  IF v_note <> '' THEN
    RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'politician_elections', 'record_id', pe.id, 'message', COALESCE(r->>'message', '') || v_note);
  END IF;
  RETURN r;
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_candidacy_with_party IS
  'candidacy 交件の落庫の入口：party（書き方）か party_id がなければ apply_candidacy そのまま。あれば先に所属の衝突を判定→apply_candidacy→party_basis 空の参選にだけ所属を書く（alias に当たれば party_id、当たらなければ party_text だけ）。推薦・支持は扱わない';

-- ------------------------------------------------------------
-- 4. 臂 party_roster／party_gap（task_type=party_missing）：所属政党も書き方も分からない参選 → 出典から所属を調べて candidacy で補う
--    窓だけが違う（party_roster＝投票日 +0 まで、party_gap＝投票日 +1 から）。同じ参選は同じ task_id＝投票日をまたいでも一つの任務
-- ------------------------------------------------------------
-- 素材：開いている・上線済みの選挙の、上線済みの参選のうち、party_basis も party_text も空（撤回した人は除く）
CREATE OR REPLACE FUNCTION policy_jp.party_missing_subjects() RETURNS TABLE (
  politician_election_id TEXT, politician_id TEXT, name TEXT, kana TEXT, candidacy_status TEXT, status_date DATE,
  district_kind TEXT, district_name TEXT, election_id TEXT, election_name TEXT, election_type TEXT, election_date DATE, notice_date DATE,
  lg_code TEXT, lg_name TEXT, pref_name TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT s.politician_election_id, s.politician_id, s.name, s.kana, s.candidacy_status, s.status_date, s.district_kind, s.district_name,
         s.election_id, s.election_name, s.election_type, s.election_date, s.notice_date, s.lg_code, s.lg_name, s.pref_name
    FROM policy_jp.chain_candidacy_records() s
    JOIN policy_jp.politician_elections pe ON pe.id = s.politician_election_id
   WHERE pe.party_basis IS NULL AND pe.party_text IS NULL
     AND s.candidacy_status IN ('declared', 'filed', 'elected', 'not_elected')
$$;
COMMENT ON FUNCTION policy_jp.party_missing_subjects IS '所属政党がまだ分からない参選（party_basis も party_text も空・declared 以上）。party_roster／party_gap が共有する素材';

-- 名簿の政党（候補：選挙の日に存続していたもの、最大 60）。代理が party_id を選べるように target に載せる
CREATE OR REPLACE FUNCTION policy_jp.party_known_list(p_on DATE) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('party_id', x.id, 'name', x.name) ORDER BY x.kana, x.id), '[]'::JSONB)
    FROM (SELECT id, name, kana FROM policy_jp.parties
           WHERE (valid_from IS NULL OR valid_from <= COALESCE(p_on, CURRENT_DATE)) AND (valid_to IS NULL OR valid_to >= COALESCE(p_on, CURRENT_DATE))
           ORDER BY kana, id LIMIT 60) x
$$;

CREATE OR REPLACE FUNCTION policy_jp.party_missing_tasks(p_arm TEXT)
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = p_arm AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*
      FROM policy_jp.party_missing_subjects() s CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND NOT policy_jp.task_unavailable('auto:party_missing:' || s.politician_election_id)
     ORDER BY (s.election_date < policy_jp.activity_today()), s.election_date, s.kana NULLS LAST, s.politician_election_id
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:party_missing:' || g.politician_election_id, 'party_missing',
         jsonb_build_object('kind', CASE p_arm WHEN 'party_gap' THEN 'party' ELSE 'party_roster' END,
                            'politician_election_id', g.politician_election_id, 'politician_id', g.politician_id, 'name', g.name, 'kana', g.kana,
                            'candidacy_status', g.candidacy_status, 'status_date', g.status_date, 'district_kind', g.district_kind, 'district_name', g.district_name,
                            'election_id', g.election_id, 'election_name', g.election_name, 'election_type', g.election_type, 'election_date', g.election_date,
                            'notice_date', g.notice_date, 'lg_code', g.lg_code, 'lg_name', g.lg_name,
                            'known_parties', policy_jp.party_known_list(g.election_date)),
         g.name || COALESCE('（' || g.kana || '）', '') || '（' || g.lg_name || ' ' || g.election_name || '、投票日 ' || g.election_date || '）が、この選挙でどの政党に所属していたか（または無所属か）を、当方はまだ記録していません。'
           || CASE p_arm WHEN 'party_gap' THEN '投票は終わっています。当選・落選の報道ではなく、選挙管理委員会の公表、本人の公式サイト、政党の発表など、その選挙の時点の所属が書かれたものを探してください。'
                         ELSE '選挙管理委員会が公表した立候補者の一覧に党派（所属政党・無所属）が載る選挙はそれに当たり、載らない選挙は本人の公式サイトや政党の発表で確かめてください。' END
           || '分かったら、contribution_type=candidacy を現在の記録と同じ状態で出します：politician_id（' || g.politician_id || '）・election_id（' || g.election_id || '）・candidacy_status（' || g.candidacy_status || '）・'
           || 'status_date（' || g.status_date || '）・district_kind（' || g.district_kind || '）'
           || CASE WHEN g.district_name IS NOT NULL THEN '・district_name（' || g.district_name || '）' ELSE '' END
           || '、そこに所属を足します。政党なら party に出典に書かれたとおりの政党名（正式名か略称）、target.known_parties にある政党なら party_id でも構いません。無所属なら party に「無所属」。'
           || 'source_urls にその所属が書かれたページを付けます。状態と日付は変わらず、所属だけが足されます。'
           || '政党の「推薦」「支持」「公認申請中」は所属ではありません（推薦・支持は別の記録で、この任務では入れない）。名簿にない政党名は書いたとおりに記録され、別の任務で政党の名簿に結びます。'
           || '所属が出典で確かめられないときは candidacy を出さず、no_change、outcome=not_found（開けなかったときは unreachable）で、探した場所を checked_urls と finding に書いてください（推測で埋めない）。',
         ARRAY[g.lg_name || ' 選挙管理委員会の立候補者一覧・選挙結果', g.pref_name || ' 選挙管理委員会', '総務省 選挙関連情報', '本人の公式サイト・政党の公式サイト']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_party_roster()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$ SELECT * FROM policy_jp.party_missing_tasks('party_roster') $$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_party_roster IS '政党名簿の臂（正見 party_roster の日本版）：投票日まで。所属政党が分からない参選 → party_missing 任務。日付は規則（到投票日 +0）。params.cap は可派の前 N 件';

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_party_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$ SELECT * FROM policy_jp.party_missing_tasks('party_gap') $$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_party_gap IS '政党補完の臂（正見 party_gap の日本版）：投票日翌日から。所属政党が分からない参選 → party_missing 任務。日付は規則（投票日 +1 起）。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 5. 臂 party_info（task_type=party_info_missing）：参選に書かれた政党の書き方が名簿に当たらない → 政党を作る／別表記に結ぶ／無所属の書き方にする
--    書き方（鍵）ごとに一件。サイトで実際に使われている書き方だけ
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_party_info()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH p AS (
    SELECT (r.params->>'cap')::INTEGER AS cap
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'party_info' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  used AS (
    SELECT policy_jp.party_text_key(pe.party_text) AS k, pe.party_text, pe.id AS pe_id, pp.name, e.name AS election_name, e.election_date
      FROM policy_jp.politician_elections pe
      JOIN policy_jp.politicians pp ON pp.id = pe.politician_id AND pp.review_status = 'published'
      JOIN policy_jp.elections e ON e.id = pe.election_id AND e.review_status = 'published'
     WHERE pe.review_status = 'published' AND pe.party_basis IS NULL AND pe.party_text IS NOT NULL
  ),
  grp AS (
    SELECT u.k, min(u.party_text) AS txt, count(*)::INTEGER AS n, min(u.election_date) AS first_date,
           (array_agg(DISTINCT u.party_text))[1:5] AS texts,
           (SELECT jsonb_agg(jsonb_build_object('politician_election_id', y.pe_id, 'name', y.name, 'election_name', y.election_name, 'election_date', y.election_date))
              FROM (SELECT z.pe_id, z.name, z.election_name, z.election_date FROM used z WHERE z.k = u.k ORDER BY z.election_date, z.pe_id LIMIT 5) y) AS examples
      FROM used u
     WHERE u.k IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM policy_jp.party_aliases a WHERE a.alias_key = u.k)
     GROUP BY u.k
  ),
  gaps AS (
    SELECT g.* FROM grp g CROSS JOIN p
     WHERE p.cap IS NOT NULL
       AND NOT policy_jp.task_unavailable('auto:party_info_missing:' || left(md5(g.k), 12))
     ORDER BY g.first_date, g.n DESC, g.k
     LIMIT (SELECT cap FROM p)
  )
  SELECT 'auto:party_info_missing:' || left(md5(g.k), 12), 'party_info_missing',
         jsonb_build_object('kind', 'unmatched_text', 'party_text', g.txt, 'alias_key', g.k, 'texts', to_jsonb(g.texts), 'count', g.n,
                            'election_date', g.first_date, 'examples', g.examples, 'known_parties', policy_jp.party_known_list(g.first_date)),
         '候補者の所属として「' || g.txt || '」と記録された参選が ' || g.n || ' 件ありますが、この書き方が政党の名簿（target.known_parties）に結ばれていません。次のどれかで答えてください。'
           || '【新しい政党】名簿にない政党なら contribution_type=party_info：name（正式名）・kana（ひらがな）・short_name（略称があれば）・valid_from（結成の日が公的な資料で分かれば）、'
           || 'aliases に「' || g.txt || '」を入れます。政党の公式サイトや総務省の公表資料など、その政党が実在することを示す出典を source_urls に付けます。'
           || '【名簿にある政党の別の書き方】target.known_parties のどれかの略称・旧称・表記ゆれなら party_info に party_id と aliases（「' || g.txt || '」）を出します。'
           || '【無所属の書き方】無所属を意味するだけの書き方なら party_info に independent_aliases（「' || g.txt || '」）を出します。「諸派」や団体名のように無所属と断定できないものは入れません。'
           || '政党かどうか確かめられないときは party_info を出さず、no_change、outcome=not_found（開けなかったときは unreachable）で、探した場所を checked_urls と finding に書いてください。'
           || '改名は新しい政党として扱います（name を新しくして predecessor_id に前身の party_id）。推測で政党を作らない。',
         ARRAY['政党の公式サイト', '総務省 政治資金・政党関連の公表資料', '選挙管理委員会の立候補者一覧（党派欄）']::TEXT[],
         1, NULL::TEXT
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_party_info IS '政党資訊の臂（正見 party_info_missing の「書き方が名簿に当たらない」だけの日本版）：参選に書かれた政党の書き方が party_aliases に当たらない → party_info_missing 任務（書き方の鍵ごと一件）。規則は常時窓。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 6. 交件型別 party_info：DB CHECK と落庫清單（20261011210000 の版に 1 つ足しただけ）
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'policy_progress',
                               'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'policy_progress', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'no_change']::TEXT[]
$$;

-- ------------------------------------------------------------
-- 7. 総表・臂名・鎖の段・落庫の振り分け（20261011210000 の版に、臂 3 つ／WHEN 1 行（party_info）／candidacy の入口を包みに替えただけ）
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
    'party_info'
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
                  ELSE 9
                END
         END
$$;
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery 1、local_government_missing 2、regional_stats_missing 3、roster_check／party_missing／party_info_missing／candidate_status_stale／not_running_recheck／candidacy_source_missing／district_seats_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing／duplicate_policy／term_policy_missing 8、progress_stale／deadline_due／lineage_candidate／handover_missing／lineage_roles_missing／lineage_link_candidate 9（任期中の追跡と政策の継承は鎖の最後）。登録のない auto 型別も 9';
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
               WHEN 'candidacy' THEN policy_jp.apply_candidacy_with_party(c)
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
               WHEN 'party_info' THEN policy_jp.apply_party_info(c)
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
-- 8. 規則（enabled）・優先層・主控台の段（冪等）
-- ------------------------------------------------------------
-- party_roster：投票日 +0 まで（起点なし）。party_gap：投票日 +1 から（迄日なし）。鎖には掛けない（素材が『上線済みの参選』なので自然に候補者がいる後）。
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, params, note)
SELECT 'party_roster', 'event', NULL, 0, 'polling', 0, 'announced', '{"cap":200}'::JSONB,
       '政党名簿（正見 party_roster）：投票日当日まで、所属政党が分からない参選に、出典から所属（政党／無所属）を調べさせる（candidacy＋party）。起点なし・投票日 +0 止。同時に開くのは最大 200 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'party_roster' AND r.priority IS NULL);
INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, params, note)
SELECT 'party_gap', 'event', 'polling', 1, NULL, 0, 'announced', '{"cap":200}'::JSONB,
       '政党補完（正見 party_gap）：投票日の翌日から、所属政党が分からない参選に、その選挙の時点の所属を調べさせる（candidacy＋party）。迄日なし（補えば自然に消える）。同時に開くのは最大 200 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'party_gap' AND r.priority IS NULL);
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'party_info', 'always', 'announced', '{"cap":100}'::JSONB,
       '政党資訊（正見 party_info／party_info_missing）：参選に書かれた政党の書き方が名簿に結ばれていないとき、政党を作る・別表記に結ぶ・無所属の書き方にする（party_info）。窓は常時・鎖に掛けない（選挙に属さない）。同時に開くのは最大 100 件'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'party_info' AND r.priority IS NULL);

INSERT INTO policy_jp.activity_rules (activity, window_kind, from_kind, from_offset, until_kind, until_offset, priority, note)
SELECT 'priority:' || x.arm, 'event', t.from_kind, t.from_offset, t.until_kind, t.until_offset, t.tier, x.arm || '：' || t.note
  FROM (VALUES ('party_roster'), ('party_gap')) AS x(arm)
  CROSS JOIN (VALUES
    ('polling', -60, NULL::TEXT,  0,    1::SMALLINT, '前段：投票日前 60 日以内の任務（最近の選挙を先に派す）'),
    (NULL::TEXT, 0,  'polling', -181, 3::SMALLINT, '後段：投票日前 181 日以上の任務；61～180 日は既定の層（中段）')
  ) AS t(from_kind, from_offset, until_kind, until_offset, tier, note)
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:' || x.arm AND r.priority = t.tier);

INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('party_info', 1, '政党資訊（書き方を政党の名簿に結ぶ）'),
  ('party_roster', 3, '政党名簿（投票日まで）'),
  ('party_gap', 4, '政党補完（投票日の翌日から）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 9. 權限
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.party_text_key(TEXT), policy_jp.party_missing_subjects(), policy_jp.party_known_list(DATE), policy_jp.party_missing_tasks(TEXT),
  policy_jp.contribution_auto_tasks_party_roster(), policy_jp.contribution_auto_tasks_party_gap(), policy_jp.contribution_auto_tasks_party_info(),
  policy_jp.apply_party_info(policy_jp.contributions), policy_jp.apply_candidacy_with_party(policy_jp.contributions)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.party_text_key(TEXT), policy_jp.party_missing_subjects(), policy_jp.party_known_list(DATE), policy_jp.party_missing_tasks(TEXT),
  policy_jp.contribution_auto_tasks_party_roster(), policy_jp.contribution_auto_tasks_party_gap(), policy_jp.contribution_auto_tasks_party_info(),
  policy_jp.apply_party_info(policy_jp.contributions), policy_jp.apply_candidacy_with_party(policy_jp.contributions)
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
  FOREACH v_arm IN ARRAY ARRAY['party_roster', 'party_gap', 'party_info'] LOOP
    IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = v_arm AND r.priority IS NULL AND r.enabled AND r.after_step IS NULL AND r.params ? 'cap') THEN
      RAISE EXCEPTION 'policy_jp：% の規則が「開いている・after_step なし・cap あり」になっていない', v_arm;
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
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'party_roster' AND r.priority IS NULL AND r.window_kind = 'event' AND r.from_kind IS NULL AND r.until_kind = 'polling' AND r.until_offset = 0)
     OR NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'party_gap' AND r.priority IS NULL AND r.window_kind = 'event' AND r.from_kind = 'polling' AND r.from_offset = 1 AND r.until_kind IS NULL)
     OR NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'party_info' AND r.priority IS NULL AND r.window_kind = 'always') THEN
    RAISE EXCEPTION 'policy_jp：政党の臂の窓が期待と違う（party_roster＝投票日 +0 止、party_gap＝投票日 +1 起、party_info＝常時）';
  END IF;
  IF policy_jp.chain_step_rank('auto:party_missing:x', 'party_missing') <> 4 OR policy_jp.chain_step_rank('auto:party_info_missing:x', 'party_info_missing') <> 4
     OR policy_jp.chain_step_rank('auto:lineage_candidate:x:y', 'lineage_candidate') <> 9 OR policy_jp.chain_step_rank('auto:progress_stale:x', 'progress_stale') <> 9 THEN
    RAISE EXCEPTION 'policy_jp：chain_step_rank の登録がおかしい';
  END IF;
  IF (SELECT count(*) FROM policy_jp.console_arm_stage_map m WHERE (m.arm, m.stage) IN (('party_info', 1), ('party_roster', 3), ('party_gap', 4))) <> 3 THEN
    RAISE EXCEPTION 'policy_jp：console_arm_stage_map に政党の臂 3 つの段がない';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_jp_contributions_type_check'
                  AND pg_get_constraintdef(oid) LIKE '%party_info%' AND pg_get_constraintdef(oid) LIKE '%lineage_link%' AND pg_get_constraintdef(oid) LIKE '%policy_progress%') THEN
    RAISE EXCEPTION 'policy_jp：policy_jp_contributions_type_check に party_info がない（または既存の型別が消えた）';
  END IF;
  IF NOT (policy_jp.apply_types() @> ARRAY['party_info', 'lineage', 'policy_progress', 'removal', 'candidacy']::TEXT[]) THEN
    RAISE EXCEPTION 'policy_jp：apply_types() に party_info がない（または既存の型別が消えた）';
  END IF;
  IF pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_party_info(c)%'
     OR pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_candidacy_with_party(c)%'
     OR pg_get_functiondef('policy_jp.apply_contribution(uuid, boolean)'::regprocedure) NOT LIKE '%apply_lineage_link(c)%' THEN
    RAISE EXCEPTION 'policy_jp：apply_contribution の振り分けがおかしい';
  END IF;
  IF policy_jp.contribution_needs_two_ips('party_info', '{}'::JSONB) OR policy_jp.contribution_required_agree('party_info', '{}'::JSONB, ARRAY[]::TEXT[]) <> 3
     OR 'party_info' = ANY (policy_jp.system_one_precheck_types()) THEN
    RAISE EXCEPTION 'policy_jp：party_info の共識（網段 1・目標 3・系統票なし）が期待と違う';
  END IF;
  IF policy_jp.party_text_key(' 無所属 ') IS DISTINCT FROM policy_jp.party_text_key('無所属') OR NOT EXISTS (SELECT 1 FROM policy_jp.party_aliases WHERE alias_key = policy_jp.party_text_key('無所属') AND kind = 'independent') THEN
    RAISE EXCEPTION 'policy_jp：無所属の書き方の種がない';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.apply_party_info(policy_jp.contributions)', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_candidacy_with_party(policy_jp.contributions)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：政党の落庫関数を anon に渡してはいけない';
  END IF;
  IF has_table_privilege('anon', 'policy_jp.party_aliases', 'INSERT') OR has_table_privilege('authenticated', 'policy_jp.party_aliases', 'UPDATE') THEN
    RAISE EXCEPTION 'policy_jp：party_aliases に書き込み権限を渡してはいけない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
