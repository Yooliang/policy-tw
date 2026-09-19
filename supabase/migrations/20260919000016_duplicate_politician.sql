-- 同名人物流程（使用者 2026-09-19 核可的四步）：
--   1. 軟合併原語：politicians.merged_into；政見／參選／鍵／提問／指認全部搬到保留的那筆，舊列留著、舊網址轉向。
--   2. 接上 Jev 已有的 same_person 判定：diff ≥門檻的配對不派任務；same 的排前面；merge_politician 貢獻拿系統票。
--   3. duplicate_politician 任務（同名＋同縣市或同出生年）→ 代理交 merge_politician（same_person true／false）→ 3 票＋系統票 → 軟合併或記「不同人」。
--   4. 上游不改：曖昧照建，配對一出現就自動變任務（不再只寫 politician_identity_reviews 等人）。
--
-- 現況：26 筆 pending 審查＝26 對同名同縣市；Jev 影子判過 142 對不同人（≥0.95）、12 對同一人（≥0.95）。

-- 1. 軟合併原語
ALTER TABLE politicians ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES politicians(id);
CREATE INDEX IF NOT EXISTS politicians_merged_into_idx ON politicians (merged_into) WHERE merged_into IS NOT NULL;
COMMENT ON COLUMN politicians.merged_into IS '軟合併：這筆已併進哪一筆（舊列保留給舊網址轉向與查核履歷）；NULL＝正常';

CREATE TABLE IF NOT EXISTS politician_pair_resolutions (
  pair_key TEXT PRIMARY KEY,                 -- least(id)||'|'||greatest(id)，跟 jev_decisions politician_pair 的 subject_id 同形
  a UUID NOT NULL,
  b UUID NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('same', 'different')),
  contribution_id UUID,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE politician_pair_resolutions IS '同名配對的結論：same＝已合併、different＝確認不同人（任務不再派）';
ALTER TABLE politician_pair_resolutions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "politician_pair_resolutions public read" ON politician_pair_resolutions;
CREATE POLICY "politician_pair_resolutions public read" ON politician_pair_resolutions FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION politician_pair_key(p_a UUID, p_b UUID) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT LEAST(p_a, p_b)::TEXT || '|' || GREATEST(p_a, p_b)::TEXT $$;

CREATE OR REPLACE FUNCTION merge_politician(p_keep UUID, p_remove UUID, p_contribution UUID, p_agent TEXT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_keep politicians%ROWTYPE; v_remove politicians%ROWTYPE;
  v_policies INTEGER := 0; v_elections INTEGER := 0; v_filled TEXT[] := ARRAY[]::TEXT[];
  r RECORD;
BEGIN
  IF p_keep = p_remove THEN RAISE EXCEPTION 'keep 與 remove 是同一筆'; END IF;
  SELECT * INTO v_keep FROM politicians WHERE id = p_keep;
  SELECT * INTO v_remove FROM politicians WHERE id = p_remove;
  IF v_keep.id IS NULL OR v_remove.id IS NULL THEN RAISE EXCEPTION '找不到人物'; END IF;
  IF v_keep.merged_into IS NOT NULL THEN RAISE EXCEPTION '保留的那筆本身已被合併'; END IF;
  IF v_remove.merged_into IS NOT NULL THEN RAISE EXCEPTION '要併入的那筆已經合併過'; END IF;

  -- 政見
  UPDATE policies SET politician_id = p_keep WHERE politician_id = p_remove;
  GET DIAGNOSTICS v_policies = ROW_COUNT;

  -- 參選紀錄：同一場已經有就把空欄補到保留的那列再刪掉；沒有就整列搬過去
  FOR r IN SELECT * FROM politician_elections WHERE politician_id = p_remove LOOP
    IF EXISTS (SELECT 1 FROM politician_elections WHERE politician_id = p_keep AND election_id = r.election_id) THEN
      UPDATE politician_elections k SET
        position = COALESCE(k.position, r.position),
        slogan = COALESCE(k.slogan, r.slogan),
        election_type = COALESCE(k.election_type, r.election_type),
        region_id = COALESCE(k.region_id, r.region_id),
        election_result = COALESCE(k.election_result, r.election_result),
        votes_received = COALESCE(k.votes_received, r.votes_received),
        vote_percentage = COALESCE(k.vote_percentage, r.vote_percentage),
        source_note = COALESCE(k.source_note, r.source_note)
      WHERE k.politician_id = p_keep AND k.election_id = r.election_id;
      DELETE FROM politician_elections WHERE politician_id = p_remove AND election_id = r.election_id;
    ELSE
      UPDATE politician_elections SET politician_id = p_keep WHERE politician_id = p_remove AND election_id = r.election_id;
    END IF;
    v_elections := v_elections + 1;
  END LOOP;

  -- 身份鍵：保留那筆已經有的就丟掉，其餘搬過去
  DELETE FROM politician_keys k WHERE k.politician_id = p_remove
    AND EXISTS (SELECT 1 FROM politician_keys k2 WHERE k2.politician_id = p_keep AND k2.key_type = k.key_type AND k2.key_value = k.key_value);
  UPDATE politician_keys SET politician_id = p_keep WHERE politician_id = p_remove;
  UPDATE citizen_questions SET politician_id = p_keep WHERE politician_id = p_remove;
  UPDATE contribution_votes SET resolved_politician_id = p_keep WHERE resolved_politician_id = p_remove;
  UPDATE politician_identity_reviews SET resolved_politician_id = p_keep WHERE resolved_politician_id = p_remove;

  -- 保留那筆的空欄用併入那筆補
  IF v_keep.birth_year IS NULL AND v_remove.birth_year IS NOT NULL THEN UPDATE politicians SET birth_year = v_remove.birth_year WHERE id = p_keep; v_filled := v_filled || 'birth_year'; END IF;
  IF v_keep.avatar_url IS NULL AND v_remove.avatar_url IS NOT NULL THEN UPDATE politicians SET avatar_url = v_remove.avatar_url WHERE id = p_keep; v_filled := v_filled || 'avatar_url'; END IF;
  IF v_keep.education_level IS NULL AND v_remove.education_level IS NOT NULL THEN UPDATE politicians SET education_level = v_remove.education_level WHERE id = p_keep; v_filled := v_filled || 'education_level'; END IF;
  IF v_keep.bio IS NULL AND v_remove.bio IS NOT NULL THEN UPDATE politicians SET bio = v_remove.bio WHERE id = p_keep; v_filled := v_filled || 'bio'; END IF;
  IF v_keep.current_position IS NULL AND v_remove.current_position IS NOT NULL THEN UPDATE politicians SET current_position = v_remove.current_position WHERE id = p_keep; v_filled := v_filled || 'current_position'; END IF;
  IF v_keep.sub_region IS NULL AND v_remove.sub_region IS NOT NULL THEN UPDATE politicians SET sub_region = v_remove.sub_region WHERE id = p_keep; v_filled := v_filled || 'sub_region'; END IF;
  IF v_keep.region IS NULL AND v_remove.region IS NOT NULL THEN UPDATE politicians SET region = v_remove.region WHERE id = p_keep; v_filled := v_filled || 'region'; END IF;

  -- 舊列留著、標記併入誰；查核履歷兩邊各記一筆
  UPDATE politicians SET merged_into = p_keep WHERE id = p_remove;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('politicians', p_remove::TEXT, 'merged_into', NULL, to_jsonb(p_keep::TEXT), p_contribution, p_agent),
         ('politicians', p_keep::TEXT, 'merged_from', NULL, to_jsonb(p_remove::TEXT), p_contribution, p_agent);
  INSERT INTO politician_pair_resolutions (pair_key, a, b, resolution, contribution_id)
  VALUES (politician_pair_key(p_keep, p_remove), LEAST(p_keep, p_remove), GREATEST(p_keep, p_remove), 'same', p_contribution)
  ON CONFLICT (pair_key) DO UPDATE SET resolution = 'same', contribution_id = EXCLUDED.contribution_id, resolved_at = now();

  RETURN jsonb_build_object('moved_policies', v_policies, 'moved_elections', v_elections, 'filled', to_jsonb(v_filled));
END;
$$;
COMMENT ON FUNCTION merge_politician IS '軟合併：remove 的政見／參選／鍵／提問／指認搬到 keep，keep 空欄補上，remove 留列標 merged_into；只由 apply 呼叫（merge_politician 貢獻通過後）';

-- 視圖多露 merged_into（CREATE OR REPLACE 只能在尾巴加欄位）；前端清單過濾、人物頁轉向
CREATE OR REPLACE VIEW politicians_with_elections AS
 SELECT p.id, p.name, p.party, p.status, p.election_type, p."position", p.current_position,
    COALESCE(r.region, p.region) AS region,
    COALESCE(r.sub_region, p.sub_region) AS sub_region,
    COALESCE(r.village, p.village) AS village,
    p.avatar_url, p.slogan, p.bio, p.education, p.experience, p.birth_year, p.education_level,
    COALESCE(( SELECT json_agg(pe.election_id) FROM politician_elections pe WHERE pe.politician_id = p.id), '[]'::json) AS election_ids,
    COALESCE(( SELECT json_agg(json_build_object('electionId', pe.election_id, 'position', COALESCE(pe."position", p."position"), 'slogan', COALESCE(pe.slogan, p.slogan), 'electionType', COALESCE(pe.election_type, p.election_type), 'regionId', pe.region_id, 'region', COALESCE(per.region, r.region, p.region), 'subRegion', COALESCE(per.sub_region, r.sub_region, p.sub_region), 'village', COALESCE(per.village, r.village, p.village), 'candidateStatus', pe.candidate_status, 'electionResult', pe.election_result, 'sourceNote', pe.source_note))
           FROM politician_elections pe LEFT JOIN regions per ON pe.region_id = per.id
          WHERE pe.politician_id = p.id), '[]'::json) AS elections,
    p.merged_into
   FROM politicians p LEFT JOIN regions r ON p.region_id = r.id;

-- 2+3. 任務：同名＋（同縣市 或 同出生年）；Jev 已高信心判「不同人」的不派；已有結論或已有人在交的不派
CREATE OR REPLACE FUNCTION contribution_auto_tasks_dup()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH n AS (
    SELECT p.id, p.name, p.party, p.region, p.birth_year, p.current_position,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey
    FROM politicians p WHERE p.merged_into IS NULL
  )
  SELECT 'auto:duplicate_politician:' || a.id || '|' || b.id, 'duplicate_politician',
         jsonb_build_object(
           'pair_key', a.id || '|' || b.id,
           'a', jsonb_build_object('id', a.id, 'name', a.name, 'party', a.party, 'region', a.region, 'birth_year', a.birth_year, 'current_position', a.current_position),
           'b', jsonb_build_object('id', b.id, 'name', b.name, 'party', b.party, 'region', b.region, 'birth_year', b.birth_year, 'current_position', b.current_position)),
         '「' || a.name || '」有兩筆人物資料（' || COALESCE(a.region, '') || ' ' || COALESCE(a.party, '') || '／' || COALESCE(b.region, '') || ' ' || COALESCE(b.party, '') || '），很可能是同一個人。'
           || '請查中選會候選人資料庫（歷屆參選、出生年、政黨）或官方名單，確認是不是同一人。'
           || '用 merge_politician 回報：same_person=true 帶 keep_id（保留資料較完整、參選紀錄較多的那筆）與 remove_id；確認是不同人就 same_person=false。'
           || '兩種都要 reason（≥20 字）與 source_urls。item.current.a／b 是兩筆的全欄＋參選紀錄＋政見標題，current.system_vote 是系統的判定。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，同一人會列在同一筆', 'POST /functions/v1/fetch-cec-data {"queryName":"姓名"}', '該縣市議會／政府官網的人物簡介'],
         2, COALESCE(a.region, b.region)
  FROM n a JOIN n b ON a.nkey = b.nkey AND a.id < b.id
  WHERE (COALESCE(a.region, '') = COALESCE(b.region, '') OR (a.birth_year IS NOT NULL AND a.birth_year = b.birth_year))
    AND NOT EXISTS (SELECT 1 FROM politician_pair_resolutions x WHERE x.pair_key = a.id || '|' || b.id)
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.subject_id = a.id || '|' || b.id
        AND j.choice = 'diff' AND j.probability >= system_one_min_probability())
    AND NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.contribution_type = 'merge_politician' AND c.status IN ('pending', 'verified', 'disputed')
        AND c.payload->>'keep_id' ~* '^[0-9a-f-]{36}$' AND c.payload->>'remove_id' ~* '^[0-9a-f-]{36}$'
        AND politician_pair_key((c.payload->>'keep_id')::UUID, (c.payload->>'remove_id')::UUID) = a.id || '|' || b.id)
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_dup IS '同名人物配對 → duplicate_politician 任務；Jev 高信心「不同人」的、已有結論的、已有人在交的都不派';

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT ''
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward
  FROM (SELECT * FROM contribution_auto_tasks_raw() UNION ALL SELECT * FROM contribution_auto_tasks_dup()) t
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id
        AND tc.checked_at > now() - (task_check_cooldown_days() || ' days')::INTERVAL
    )
  ORDER BY
    -- 第一層：Jev 有高信心答案的排前面（政見缺屆別；同名配對判「同一人」）
    CASE WHEN system_one_priority_enabled() AND (
      EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'election' AND j.choice <> 'unknown'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:policy_election_missing:' || j.subject_id)
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.choice = 'same'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:duplicate_politician:' || j.subject_id)
    ) THEN 0 ELSE 1 END,
    md5(t.task_id || COALESCE(p_seed, ''))
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;

-- 門檻：merge_politician 跟 removal 同級（3 票，不看來源）；系統票合格型別加進去
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'merge_politician' THEN 'removal'
    WHEN p_type = 'candidacy'
         AND p_payload->>'election_result' IN ('elected', 'not_elected')
         AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'past_result'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 4 WHEN 'media' THEN 6 WHEN 'social' THEN 8 ELSE 8 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'past_result' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 4
  END;
END;
$$;

CREATE OR REPLACE FUNCTION system_vote_eligible(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('policy', 'candidacy', 'politician', 'correction', 'policy_progress', 'merge_politician')
$$;

-- 預判候選：merge_politician 沒有來源網址也要進來（它的「來源」是那兩筆資料本身，precheck 會問 Jev 同一人）
CREATE OR REPLACE FUNCTION system_one_precheck_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (contribution_id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND system_vote_eligible(c.contribution_type)
    AND (c.contribution_type = 'merge_politician' OR (c.source_urls IS NOT NULL AND array_length(c.source_urls, 1) >= 1))
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
    )
  ORDER BY c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;

-- 清單用的視圖：已合併的不列（人物頁用 politicians_with_elections 讀到 merged_into 再轉向）
CREATE OR REPLACE VIEW politicians_with_policies AS
 SELECT id, name, party, status, election_type, "position", current_position, region, sub_region, village,
        avatar_url, slogan, bio, education, experience, birth_year, education_level, election_ids, elections, merged_into
   FROM politicians_with_elections p
  WHERE EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = p.id AND pl.removed_at IS NULL)
    AND p.merged_into IS NULL;
