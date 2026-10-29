-- 日本站「人物頭像」：Wikimedia Commons の自由授權寫真だけを集める（policy-ops#162、裁決 2026-10-30-日本站收Wikimedia自由授權頭像.md）
-- ============================================================
--
--   任務型別（task_type）  臂（activity）    task_id                            交件型別（contribution_type）
--   avatar_missing         avatar_missing    auto:avatar_missing:<人物 id>       politician_avatar（見つからなければ no_change not_found）
--
-- 授權：CC0／Public domain 類／CC BY／CC BY-SA（各版本）だけ。Commons API による機器核對は jp-report 側（_shared/jp/commons-avatar.ts）。
-- ここ（SQL）は最後の網：落庫時にも同じ形（upload.wikimedia.org／commons.wikimedia.org/wiki/File:／授權正規式）を検査し、表の CHECK でも守る。
--
-- この支でやること：
-- 1. politicians に頭像の 5 欄（avatar_url／avatar_file_page_url／avatar_license／avatar_author／avatar_retrieved_on）＋ 全部空か全部形が正しいかの CHECK。
-- 2. 交件型別 politician_avatar：DB CHECK・apply_types・apply_contribution の振り分け・落庫 apply_politician_avatar（空欄を埋めるだけ、上書きしない）。
-- 3. 臂 avatar_missing：開いている選挙の立候補者＋現職（任期中）で頭像のない人。窓＝常時、後段（priority:avatar_missing）、cap 30。
--    no_change が返ったら params.cooldown_days（90）日は同じ人を派さない（task_check の通常冷却 14 日より長い。臂の中で除外する）。
-- 守門：_shared/jp/commons-avatar.test.ts、policy-jp-avatar.test.ts、policy-jp-dispatch-drift.test.ts（JP_ONLY 登記）。不碰 public、ditrust。冪等、尾端自我檢查。

-- ------------------------------------------------------------
-- 1. 欄位
-- ------------------------------------------------------------
ALTER TABLE policy_jp.politicians
  ADD COLUMN IF NOT EXISTS avatar_url           TEXT,
  ADD COLUMN IF NOT EXISTS avatar_file_page_url TEXT,
  ADD COLUMN IF NOT EXISTS avatar_license       TEXT,
  ADD COLUMN IF NOT EXISTS avatar_author        TEXT,
  ADD COLUMN IF NOT EXISTS avatar_retrieved_on  DATE;
ALTER TABLE policy_jp.politicians DROP CONSTRAINT IF EXISTS politicians_avatar_check;
ALTER TABLE policy_jp.politicians ADD CONSTRAINT politicians_avatar_check CHECK (
  (avatar_url IS NULL AND avatar_file_page_url IS NULL AND avatar_license IS NULL AND avatar_author IS NULL AND avatar_retrieved_on IS NULL)
  OR (avatar_url ~ '^https://upload\.wikimedia\.org/wikipedia/commons/[^[:space:]]+$' AND char_length(avatar_url) <= 600
      AND avatar_file_page_url ~ '^https://commons\.wikimedia\.org/wiki/File:[^[:space:]#?|]+$' AND char_length(avatar_file_page_url) <= 600
      AND avatar_license ~* '^(CC0( 1\.0)?|Public domain|PD[ -].+|CC BY(-SA)? [0-9]\.[0-9]( [a-z]{2,3}(-[a-z]+)?)?)$'
      AND btrim(avatar_author) <> '' AND char_length(avatar_author) <= 300
      AND avatar_retrieved_on IS NOT NULL));
COMMENT ON COLUMN policy_jp.politicians.avatar_url IS '頭像の画像 URL（Wikimedia Commons の自由授權寫真だけ）。5 欄は全部空か全部あるか（politicians_avatar_check）。画面は撮影者・授權・Commons ページを必ず併記する';

-- ------------------------------------------------------------
-- 2. 交件型別 politician_avatar：DB CHECK と落庫清單
-- ------------------------------------------------------------
ALTER TABLE policy_jp.contributions DROP CONSTRAINT IF EXISTS policy_jp_contributions_type_check;
ALTER TABLE policy_jp.contributions ADD CONSTRAINT policy_jp_contributions_type_check
  CHECK (contribution_type IN ('no_change', 'task_suggestion', 'correction', 'election', 'local_government', 'regional_stat', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'policy_progress',
                               'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'politician_avatar'));

CREATE OR REPLACE FUNCTION policy_jp.apply_types() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['local_government', 'regional_stat', 'election', 'candidacy', 'politician', 'policy', 'policy_elements', 'district_seats', 'removal', 'policy_progress', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'politician_avatar', 'no_change']::TEXT[]
$$;

-- 落庫：空欄を埋めるだけ。同じファイルなら unchanged、違う画像が既にあれば conflict（上書きしない。直すなら correction）
-- 出処（source_refs）は書かない：file_page_url を人物の事実（生年など）の出処にすると誤解を招く。ファイルページは politicians に直接持つ
CREATE OR REPLACE FUNCTION policy_jp.apply_politician_avatar(c policy_jp.contributions) RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  p JSONB := c.payload;
  v_pid TEXT := NULLIF(btrim(COALESCE(p->>'politician_id', '')), '');
  v_row policy_jp.politicians%ROWTYPE;
  v_img TEXT; v_page TEXT; v_lic TEXT; v_author TEXT;
  v_k TEXT;
  v_today DATE := policy_jp.activity_today();
BEGIN
  IF v_pid IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'politician_id がない');
  END IF;
  SELECT * INTO v_row FROM policy_jp.politicians WHERE id = v_pid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('politician_id %s は politicians にない', v_pid));
  END IF;
  FOR v_k IN SELECT k FROM jsonb_object_keys(p) k LOOP
    IF v_k NOT IN ('politician_id', 'image_url', 'file_page_url', 'license', 'author') THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('payload.%s は politician_avatar では使えない欄位', v_k));
    END IF;
  END LOOP;
  FOREACH v_k IN ARRAY ARRAY['image_url', 'file_page_url', 'license', 'author'] LOOP
    IF jsonb_typeof(p->v_k) IS DISTINCT FROM 'string' THEN
      RETURN jsonb_build_object('outcome', 'invalid', 'message', format('%s は文字列で必須', v_k));
    END IF;
  END LOOP;
  v_img := btrim(p->>'image_url'); v_page := btrim(p->>'file_page_url'); v_lic := btrim(p->>'license'); v_author := btrim(p->>'author');
  IF v_img !~ '^https://upload\.wikimedia\.org/wikipedia/commons/[^[:space:]]+$' OR char_length(v_img) > 600 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'image_url は Wikimedia Commons（upload.wikimedia.org/wikipedia/commons/）の画像 URL だけ');
  END IF;
  IF v_page !~ '^https://commons\.wikimedia\.org/wiki/File:[^[:space:]#?|]+$' OR char_length(v_page) > 600 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'file_page_url は commons.wikimedia.org/wiki/File:… のファイルページだけ');
  END IF;
  IF v_lic !~* '^(CC0( 1\.0)?|Public domain|PD[ -].+|CC BY(-SA)? [0-9]\.[0-9]( [a-z]{2,3}(-[a-z]+)?)?)$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', format('license「%s」は受け付けない（CC0／Public domain 類／CC BY／CC BY-SA の各版のみ）', v_lic));
  END IF;
  IF v_author = '' OR char_length(v_author) > 300 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'message', 'author は 1～300 字で必須（帰属表示）');
  END IF;

  IF v_row.avatar_url IS NOT NULL THEN
    IF v_row.avatar_file_page_url = v_page THEN
      RETURN jsonb_build_object('outcome', 'unchanged', 'table_name', 'politicians', 'record_id', v_pid, 'message', format('%s は同じ頭像が既にある', v_pid));
    END IF;
    RETURN jsonb_build_object('outcome', 'conflict', 'table_name', 'politicians', 'record_id', v_pid,
      'message', format('庫の %s には別の頭像（%s）が既にある。上書きしない（直すなら correction）', v_pid, v_row.avatar_file_page_url));
  END IF;

  UPDATE policy_jp.politicians
     SET avatar_url = v_img, avatar_file_page_url = v_page, avatar_license = v_lic, avatar_author = v_author, avatar_retrieved_on = v_today
   WHERE id = v_pid;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('politicians', v_pid, 'avatar_url', NULL, to_jsonb(v_img), c.id, 'auto-apply'),
         ('politicians', v_pid, 'avatar_file_page_url', NULL, to_jsonb(v_page), c.id, 'auto-apply'),
         ('politicians', v_pid, 'avatar_license', NULL, to_jsonb(v_lic), c.id, 'auto-apply'),
         ('politicians', v_pid, 'avatar_author', NULL, to_jsonb(v_author), c.id, 'auto-apply'),
         ('politicians', v_pid, 'avatar_retrieved_on', NULL, to_jsonb(v_today), c.id, 'auto-apply');
  UPDATE policy_jp.contributions SET applied_politician_id = v_pid WHERE id = c.id;
  RETURN jsonb_build_object('outcome', 'applied', 'table_name', 'politicians', 'record_id', v_pid, 'message', format('%s の頭像を登録（%s、%s）', v_pid, v_lic, v_author));
END;
$$;
COMMENT ON FUNCTION policy_jp.apply_politician_avatar IS '人物頭像の落庫（Wikimedia Commons の自由授權寫真だけ）：空欄を埋めるだけ、同じファイルは unchanged、別の画像が既にあれば conflict。取得日は日本の今日。出処（source_refs）は書かない';

-- ------------------------------------------------------------
-- 3. 臂 avatar_missing
-- ------------------------------------------------------------
-- 対象の人：開いている選挙の立候補者（chain_profile_subjects）＋ 任期中の現職。候補者として出る人は候補者側の行だけ
CREATE OR REPLACE FUNCTION policy_jp.avatar_subjects() RETURNS TABLE (
  politician_id TEXT, name TEXT, kana TEXT, basis TEXT, lg_code TEXT, lg_name TEXT, pref_name TEXT, election_id TEXT, sort_date DATE)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT s.politician_id, s.name, s.kana, 'candidate'::TEXT, s.lg_code, s.lg_name, s.pref_name, s.election_id, s.election_date
    FROM policy_jp.chain_profile_subjects() s
  UNION ALL
  (SELECT DISTINCT ON (o.politician_id) pp.id, pp.name, pp.kana, 'incumbent'::TEXT, o.lg_code, g.name,
          (SELECT pr.name FROM policy_jp.local_governments pr WHERE pr.lg_code = policy_jp.lg_pref_code(o.lg_code)), NULL::TEXT, o.start_date
     FROM policy_jp.politician_offices o
     JOIN policy_jp.politicians pp ON pp.id = o.politician_id AND pp.review_status = 'published'
     LEFT JOIN policy_jp.local_governments g ON g.lg_code = o.lg_code
    WHERE o.review_status = 'published' AND o.end_date IS NULL AND o.scheduled_end_date >= policy_jp.activity_today()
      AND NOT EXISTS (SELECT 1 FROM policy_jp.chain_profile_subjects() s2 WHERE s2.politician_id = o.politician_id)
    ORDER BY o.politician_id, o.start_date DESC)
$$;
COMMENT ON FUNCTION policy_jp.avatar_subjects IS '頭像を集める対象の人：開いている選挙の立候補者（basis=candidate）と、任期中の現職（basis=incumbent）。公開済みの人物だけ';

CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_avatar_missing()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH cfg AS (
    SELECT (r.params->>'cap')::INTEGER AS cap, COALESCE((r.params->>'cooldown_days')::INTEGER, 90) AS cool_days
      FROM policy_jp.activity_rules r
     WHERE r.activity = 'avatar_missing' AND r.enabled AND r.priority IS NULL
     ORDER BY r.id LIMIT 1
  ),
  gaps AS (
    SELECT s.*
      FROM policy_jp.avatar_subjects() s
      JOIN policy_jp.politicians pp ON pp.id = s.politician_id
      CROSS JOIN cfg
     WHERE cfg.cap IS NOT NULL AND pp.avatar_url IS NULL
       -- 提出が審議中・落庫待ちなら派さない（落ちれば戻る）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.contributions c
                        WHERE c.contribution_type = 'politician_avatar' AND c.status IN ('pending', 'verified', 'disputed', 'apply_failed')
                          AND c.payload->>'politician_id' = s.politician_id)
       -- 「見つからなかった／確認済み」の報告から cool_days（既定 90）日は同じ人を派さない（task_unavailable の 14 日冷却より長い）
       AND NOT EXISTS (SELECT 1 FROM policy_jp.task_checks tc
                        WHERE tc.task_id = 'auto:avatar_missing:' || s.politician_id AND tc.outcome IN ('confirmed', 'not_found')
                          AND tc.checked_at > now() - make_interval(days => cfg.cool_days))
       AND NOT policy_jp.task_unavailable('auto:avatar_missing:' || s.politician_id)
     ORDER BY s.basis, s.sort_date, s.politician_id
     LIMIT (SELECT cap FROM cfg)
  )
  SELECT 'auto:avatar_missing:' || g.politician_id, 'avatar_missing',
         jsonb_build_object('politician_id', g.politician_id, 'name', g.name, 'kana', g.kana, 'basis', g.basis,
                            'lg_code', g.lg_code, 'lg_name', g.lg_name),
         g.name || COALESCE('（' || g.kana || '）', '') || '（' || COALESCE(g.lg_name || ' ', '') || CASE WHEN g.basis = 'candidate' THEN '立候補者' ELSE '現職' END || '）の頭像（顔写真）がありません。'
           || 'Wikimedia Commons（commons.wikimedia.org）で、この人の**自由に使える写真**を探してください。受け付けるのは Commons のファイルだけで、'
           || '選挙公報・ポスター・公式サイト・報道写真・SNS の写真は使えません。'
           || '受け付けるライセンスは CC0／Public domain 類／CC BY／CC BY-SA（各版）だけです（NC・ND・fair use・不明は不可）。'
           || '同じ名前の別人に注意：Commons のファイルの説明・カテゴリ・出典で、この人（' || g.name || '、' || COALESCE(g.lg_name, '') || '）本人だと確かめられる写真だけを選びます（古すぎる写真・団体写真で本人を特定できないものも避けます）。'
           || '見つかったら contribution_type=politician_avatar で提出します：payload は politician_id（' || g.politician_id || '）・'
           || 'image_url（ファイルページの原画像または縮小画像の URL、https://upload.wikimedia.org/wikipedia/commons/… ）・'
           || 'file_page_url（https://commons.wikimedia.org/wiki/File:… ）・'
           || 'license（Commons の LicenseShortName のとおり。例 "CC BY-SA 4.0"）・author（撮影者・作者の表示。ファイルページの作者欄のとおり）。'
           || 'source_urls には file_page_url を入れます。サーバーが Commons の API で画像・ライセンス・作者を自動で照合し、一致しなければ受け付けません。'
           || '見つからなかったら contribution_type=no_change、outcome=not_found、task_id（auto:avatar_missing:' || g.politician_id || '）、checked_urls に探した Commons のページを入れて報告してください。'
           || '見つからなかった人は 90 日間、同じ任務に出ません（無理に探さない・推測で選ばない）。',
         ARRAY['Wikimedia Commons（commons.wikimedia.org）でのその人の名前の検索', 'Commons のカテゴリ（人名・議会・自治体）', 'ウィキペディアの記事の写真（Commons のファイルならその元ページ）']::TEXT[],
         1, g.pref_name
    FROM gaps g
$$;
COMMENT ON FUNCTION policy_jp.contribution_auto_tasks_avatar_missing IS
  '人物頭像の臂：開いている選挙の立候補者と任期中の現職で、頭像（Wikimedia Commons の自由授權寫真）のない公開済みの人 → avatar_missing 任務（task_id＝auto:avatar_missing:<人物 id>）。'
  '審議中の提出・no_change（confirmed／not_found）から params.cooldown_days（既定 90）日以内の人は派さない。窓は規則（常時）、優先層は後段（priority:avatar_missing）。params.cap は可派の前 N 件';

-- ------------------------------------------------------------
-- 4. 臂名・総表・層内順位・落庫の振り分け：現行の定義に 1 行ずつ足しただけ
--    activity_arm_names／contribution_auto_tasks_arms＝20261011250000、chain_step_rank＝20261011240000、apply_contribution＝20261011230000 の版
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
    'mismatch',
    'news_discovery',
    'avatar_missing'
  ]::TEXT[]
$$;
CREATE OR REPLACE FUNCTION policy_jp.contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH -- 姓名がテスト用に見える人物（2026-10-11、正見 20261008114000 の日本版）：その人の id が target のどこかにある他臂の任務は出さない（placeholder_politicians 臂だけ例外）。
       -- MATERIALIZED 必須：比較は strpos（等号ではない）なので雑湊結合にならず、なしだと列ごとに politicians を引き直す
       ph AS MATERIALIZED (SELECT p.id AS pid FROM policy_jp.politicians p WHERE p.review_status <> 'rejected' AND policy_jp.politician_name_is_placeholder(p.name, p.kana)),
       tagged AS (
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
  UNION ALL SELECT 'news_discovery' AS arm, t.* FROM policy_jp.contribution_auto_tasks_news_discovery() t
  UNION ALL SELECT 'avatar_missing' AS arm, t.* FROM policy_jp.contribution_auto_tasks_avatar_missing() t
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
     AND (g.arm = 'placeholder_politicians' OR NOT EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0))  -- 測試名人物の隔離
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
                  WHEN 'avatar_missing' THEN 9
                  WHEN 'placeholder_politician' THEN 1
                  WHEN 'policy_validity' THEN 8
                  WHEN 'policy_election_mismatch' THEN 8
                  ELSE 9
                END
         END
$$;
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
               WHEN 'politician_avatar' THEN policy_jp.apply_politician_avatar(c)
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
COMMENT ON FUNCTION policy_jp.chain_step_rank IS '選舉鏈の步驟順位（層内排序用）：手動任務 0、election_discovery／placeholder_politician 1、local_government_missing 2、regional_stats_missing 3、roster_check／party_missing／party_info_missing／candidate_status_stale／not_running_recheck／candidacy_source_missing／district_seats_missing 4、profile_gap／profile_detail_gap 5、policy_missing 6、election_result_missing 7、policy_elements_missing／duplicate_policy／term_policy_missing／policy_validity／policy_election_mismatch 8、progress_stale／deadline_due／lineage_candidate／handover_missing／lineage_roles_missing／lineage_link_candidate／avatar_missing 9（任期中の追跡と政策の継承は鎖の最後）。登録のない auto 型別も 9';

-- ------------------------------------------------------------
-- 5. 規則（enabled・常時窓）・優先層（後段）・主控台の段（冪等）
-- ------------------------------------------------------------
INSERT INTO policy_jp.activity_rules (activity, window_kind, min_status, params, note)
SELECT 'avatar_missing', 'always', 'announced', '{"cap":30,"cooldown_days":90}'::JSONB,
       '人物頭像（Wikimedia Commons の自由授權寫真）：開いている選挙の立候補者と任期中の現職で頭像のない人に、Commons で本人の写真を探させる。窓は常時・鎖に掛けない。同時に開くのは最大 30 件。見つからなかった人は cooldown_days（90）日派さない'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'avatar_missing' AND r.priority IS NULL);
INSERT INTO policy_jp.activity_rules (activity, window_kind, priority, note)
SELECT 'priority:avatar_missing', 'always', 3,
       '後段：頭像は選挙の本筋（名簿・政見）を押しのけない。永久に開き、選挙を指名しない；既定の層に戻したければこの 1 行を消す（migration）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:avatar_missing');
INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('avatar_missing', 1, '人物の頭像（Commons）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 6. 權限（内部関数：service_role だけ）
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.apply_politician_avatar(policy_jp.contributions), policy_jp.avatar_subjects(), policy_jp.contribution_auto_tasks_avatar_missing()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.apply_politician_avatar(policy_jp.contributions), policy_jp.avatar_subjects(), policy_jp.contribution_auto_tasks_avatar_missing()
  TO service_role;

-- ------------------------------------------------------------
-- 7. 自我檢查
-- ------------------------------------------------------------
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(a.arm, ', ') INTO bad
    FROM unnest(policy_jp.activity_arm_names()) AS a(arm)
   WHERE NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = a.arm);
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp：這些派工臂沒有規則：%', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'avatar_missing' AND r.priority IS NULL AND r.enabled AND r.window_kind = 'always' AND r.after_step IS NULL AND r.params ? 'cap' AND r.params ? 'cooldown_days') THEN
    RAISE EXCEPTION 'policy_jp：avatar_missing の規則が「開いている・常時・after_step なし・cap と cooldown_days あり」になっていない';
  END IF;
  IF NOT ('avatar_missing' = ANY (policy_jp.activity_arm_names())) THEN RAISE EXCEPTION 'policy_jp：activity_arm_names() に avatar_missing がない'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'policy_jp' AND p.proname = 'contribution_auto_tasks_arms'
         AND pg_get_functiondef(p.oid) LIKE '%contribution_auto_tasks_avatar_missing()%') <> 1 THEN
    RAISE EXCEPTION 'policy_jp：contribution_auto_tasks_arms() 総表に avatar_missing の分支がない';
  END IF;
  IF NOT (policy_jp.apply_types() @> ARRAY['politician_avatar', 'party_info', 'politician', 'no_change']::TEXT[]) THEN
    RAISE EXCEPTION 'policy_jp：apply_types() の型別がおかしい';
  END IF;
  IF pg_get_functiondef('policy_jp.apply_contribution(uuid,boolean)'::regprocedure) NOT LIKE '%apply_politician_avatar(c)%' THEN
    RAISE EXCEPTION 'policy_jp：apply_contribution が politician_avatar を振り分けていない';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity = 'priority:avatar_missing' AND r.priority = 3 AND r.window_kind = 'always') THEN
    RAISE EXCEPTION 'policy_jp：priority:avatar_missing（後段）の規則がない';
  END IF;
  IF has_function_privilege('anon', 'policy_jp.contribution_auto_tasks_avatar_missing()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.avatar_subjects()', 'EXECUTE')
     OR has_function_privilege('anon', 'policy_jp.apply_politician_avatar(policy_jp.contributions)', 'EXECUTE') THEN
    RAISE EXCEPTION 'policy_jp：頭像の関数を anon に渡してはいけない';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM policy_jp.console_arm_stage_map m WHERE m.arm = 'avatar_missing' AND m.stage = 1) THEN
    RAISE EXCEPTION 'policy_jp：console_arm_stage_map に avatar_missing の段がない';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
