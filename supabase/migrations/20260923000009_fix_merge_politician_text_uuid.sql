-- 修 merge_politician：contribution_votes.resolved_politician_id 是 TEXT（要能存 "new"），函式拿它直接跟 UUID 參數比
-- → Postgres「operator does not exist: text = uuid」。2026-09-23 第一次有合併達標（金門 7 筆，leatherback-ec 提交），
-- 4 筆全數落庫失敗；全站 merge_politician 從來沒有 applied 過，這條路從 09-19 上線起就沒真正走通。
-- 只改那兩行（WHERE 與 SET 都轉成 TEXT），其餘照 20260920000001 原樣。

CREATE OR REPLACE FUNCTION merge_politician(p_keep UUID, p_remove UUID, p_contribution UUID, p_agent TEXT)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_keep politicians%ROWTYPE; v_remove politicians%ROWTYPE;
  v_policies INTEGER := 0; v_elections INTEGER := 0; v_filled TEXT[] := ARRAY[]::TEXT[];
  r RECORD; k RECORD; v_pair TEXT; v_res_id UUID; v_field TEXT;
BEGIN
  IF p_keep = p_remove THEN RAISE EXCEPTION 'keep 與 remove 是同一筆'; END IF;
  SELECT * INTO v_keep FROM politicians WHERE id = p_keep;
  SELECT * INTO v_remove FROM politicians WHERE id = p_remove;
  IF v_keep.id IS NULL OR v_remove.id IS NULL THEN RAISE EXCEPTION '找不到人物'; END IF;
  IF v_keep.merged_into IS NOT NULL THEN RAISE EXCEPTION '保留的那筆本身已被合併'; END IF;
  IF v_remove.merged_into IS NOT NULL THEN RAISE EXCEPTION '要併入的那筆已經合併過'; END IF;
  v_pair := politician_pair_key(p_keep, p_remove);

  -- 政見：每筆一列
  FOR r IN SELECT id FROM policies WHERE politician_id = p_remove LOOP
    UPDATE policies SET politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('policies', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    v_policies := v_policies + 1;
  END LOOP;

  -- 參選紀錄：同一場已有 → keep 那列補空欄（每欄一列）、remove 那列整列記下再刪；沒有 → 整列搬過去
  FOR r IN SELECT * FROM politician_elections WHERE politician_id = p_remove LOOP
    SELECT * INTO k FROM politician_elections WHERE politician_id = p_keep AND election_id = r.election_id;
    IF k.id IS NOT NULL THEN
      FOREACH v_field IN ARRAY ARRAY['position', 'slogan', 'election_type', 'region_id', 'election_result', 'votes_received', 'vote_percentage', 'source_note'] LOOP
        IF to_jsonb(k)->v_field IS NULL OR to_jsonb(k)->v_field = 'null'::jsonb THEN
          IF to_jsonb(r)->v_field IS NOT NULL AND to_jsonb(r)->v_field <> 'null'::jsonb THEN
            EXECUTE format('UPDATE politician_elections SET %I = $1.%I WHERE id = $2', v_field, v_field) USING r, k.id;
            INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
            VALUES ('politician_elections', k.id::TEXT, v_field, NULL, to_jsonb(r)->v_field, p_contribution, p_agent);
          END IF;
        END IF;
      END LOOP;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM politician_elections WHERE id = r.id;
    ELSE
      UPDATE politician_elections SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_elections', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
    v_elections := v_elections + 1;
  END LOOP;

  -- 身份鍵：keep 已有的整列記下再刪；其餘搬過去
  FOR r IN SELECT * FROM politician_keys kk WHERE kk.politician_id = p_remove LOOP
    IF EXISTS (SELECT 1 FROM politician_keys k2 WHERE k2.politician_id = p_keep AND k2.key_type = r.key_type AND k2.key_value = r.key_value) THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_keys', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM politician_keys WHERE id = r.id;
    ELSE
      UPDATE politician_keys SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politician_keys', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
  END LOOP;

  -- 提問、票的指認、審查的指認：每列一筆
  FOR r IN SELECT id FROM citizen_questions WHERE politician_id = p_remove LOOP
    UPDATE citizen_questions SET politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('citizen_questions', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;
  FOR r IN SELECT id FROM contribution_votes WHERE resolved_politician_id = p_remove::TEXT LOOP
    UPDATE contribution_votes SET resolved_politician_id = p_keep::TEXT WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('contribution_votes', r.id::TEXT, 'resolved_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;
  FOR r IN SELECT id FROM politician_identity_reviews WHERE resolved_politician_id = p_remove LOOP
    UPDATE politician_identity_reviews SET resolved_politician_id = p_keep WHERE id = r.id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    VALUES ('politician_identity_reviews', r.id::TEXT, 'resolved_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
  END LOOP;

  -- 保留那筆的空欄用併入那筆補：每欄一列
  FOREACH v_field IN ARRAY ARRAY['birth_year', 'avatar_url', 'education_level', 'bio', 'current_position', 'sub_region', 'region'] LOOP
    IF (to_jsonb(v_keep)->v_field IS NULL OR to_jsonb(v_keep)->v_field = 'null'::jsonb)
       AND to_jsonb(v_remove)->v_field IS NOT NULL AND to_jsonb(v_remove)->v_field <> 'null'::jsonb THEN
      EXECUTE format('UPDATE politicians SET %I = $1.%I WHERE id = $2', v_field, v_field) USING v_remove, p_keep;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('politicians', p_keep::TEXT, v_field, NULL, to_jsonb(v_remove)->v_field, p_contribution, p_agent);
      v_filled := v_filled || v_field;
    END IF;
  END LOOP;

  -- 舊列留著、標記併入誰
  UPDATE politicians SET merged_into = p_keep WHERE id = p_remove;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('politicians', p_remove::TEXT, 'merged_into', NULL, to_jsonb(p_keep::TEXT), p_contribution, p_agent);

  -- 配對結論：整列記下（revert 會把它刪掉，這一對就會重新派任務）
  DELETE FROM politician_pair_resolutions WHERE pair_key = v_pair;
  INSERT INTO politician_pair_resolutions (pair_key, a, b, resolution, contribution_id)
  VALUES (v_pair, LEAST(p_keep, p_remove), GREATEST(p_keep, p_remove), 'same', p_contribution)
  RETURNING id INTO v_res_id;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  SELECT 'politician_pair_resolutions', v_res_id::TEXT, '*', NULL, to_jsonb(x), p_contribution, p_agent FROM politician_pair_resolutions x WHERE x.id = v_res_id;

  RETURN jsonb_build_object('moved_policies', v_policies, 'moved_elections', v_elections, 'filled', to_jsonb(v_filled));
END;
$$;
COMMENT ON FUNCTION merge_politician IS '軟合併：每個寫入各記一列 edit_history（搬動記舊→新、刪列記整列），/apply 的 revert 能整筆倒回；只由 apply 呼叫';
