-- 參選紀錄改掛（reassign_candidacy）與人物合併（merge_politician）的後續（維護者 10-06；#349 第一階段留下的待辦）
-- ============================================================
--
-- 1. merge_politician 合併人物時，一起搬 lineage_participants（政策脈絡的角色）與 handovers（交接）。
--    #349 第一階段只讓讀取端用 merged_into 對到保留的那位，兩張表本身沒搬——併進來的人 id 之後若被拿去做別的事，
--    或哪天要刪掉舊列，這兩張表就會指到一個已經不存在的人。這支補上，跟政見、參選紀錄、身份鍵同一個做法：每個寫入各記一列
--    edit_history（搬動記舊→新、刪列記整列），/apply 的 revert 能整筆倒回。
--      - lineage_participants：同一條脈絡、同一種依據（basis）保留那位已經有一列的 → 併進來的那列整列記下再刪；其餘搬過去。
--      - handovers：搬過去之後前後兩任變成同一個人同一屆（違反 handovers_distinct_terms）、或跟保留那位已有的同一對任期撞鍵的
--        → 整列記下再刪；其餘把 from／to 改到保留那位（任期表的對應 from_office_id／to_office_id 由既有觸發器重算）。
--    回傳的 jsonb 多兩個數字：moved_participants、moved_handovers。其餘（政見、參選紀錄、身份鍵、提問、票的指認、補空欄、
--    配對結論）一字不改，照抄 20261006220000。
--
-- 2. 參選紀錄改掛後，原人物若變成空殼（沒有任何參選紀錄、政見、任期、學經歷、公民提問、脈絡角色與交接、也沒有別人併進來），
--    走既有的移除流程：沿用 placeholder_politician 任務型別（removal 移除整個人，不直接刪），在同一支派工臂
--    contribution_auto_tasks_placeholder_politicians() 多派一種「空殼」（target.kind＝orphan）：只派「有一筆參選紀錄被改掛走
--    （edit_history 的 politician_elections.politician_id 舊值是他、貢獻是 reassign_candidacy、沒被還原）」的人，
--    所以新匯入、參選紀錄還沒掛上的人不會被誤派。改掛當下他若還有別屆的參選紀錄或政見就不是空殼、不派；之後變空才派。
--    不動 contribution_auto_tasks_arms（避免跟同時改派工臂的 PR 互相蓋掉）。
--
-- 引用到的既有欄位（10-06 唯讀查詢確認存在）：
--   lineage_participants(id, lineage_id, politician_id, basis)、
--   handovers(id, lineage_id, from_politician_id, from_election_id, to_politician_id, to_election_id)、
--   edit_history(table_name, record_id, field, old_value, new_value, contribution_id, agent_name, reverted_at)、
--   politician_elections(politician_id)、policies(politician_id)、politician_offices(politician_id)、politician_careers(politician_id)、
--   citizen_questions(politician_id)、politicians(id, name, region, party, merged_into)、contributions(contribution_type, status, payload)

-- ── 1. merge_politician ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION merge_politician(p_keep uuid, p_remove uuid, p_contribution uuid, p_agent text)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_keep politicians%ROWTYPE; v_remove politicians%ROWTYPE;
  v_policies INTEGER := 0; v_elections INTEGER := 0; v_filled TEXT[] := ARRAY[]::TEXT[];
  v_participants INTEGER := 0; v_handovers INTEGER := 0; v_new_from UUID; v_new_to UUID;
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
      FOREACH v_field IN ARRAY ARRAY['position', 'slogan', 'election_type', 'region_id', 'source_note'] LOOP
        IF to_jsonb(k)->v_field IS NULL OR to_jsonb(k)->v_field = 'null'::jsonb THEN
          IF to_jsonb(r)->v_field IS NOT NULL AND to_jsonb(r)->v_field <> 'null'::jsonb THEN
            -- 補空欄用 FROM 來源列、不用 $1.欄位：r 是匿名 RECORD，經 USING 傳進動態 SQL 之後讀不到欄位（could not identify column in record data type）
            EXECUTE format('UPDATE politician_elections AS tgt SET %I = src.%I FROM politician_elections AS src WHERE tgt.id = $1 AND src.id = $2', v_field, v_field) USING k.id, r.id;
            INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
            VALUES ('politician_elections', k.id::TEXT, v_field, NULL, to_jsonb(r)->v_field, p_contribution, p_agent);
          END IF;
        END IF;
      END LOOP;
      -- 結果（當選、落選）：keep 那列還沒有結果、remove 那列有，就補過去（以前的 election_result 就是這樣補空欄）；
      -- 登記階段與退選以 keep 為準，不互相覆蓋。得票數、得票率不再搬（#345：待刪、不再寫入）
      IF r.candidacy_status IN ('elected', 'not_elected')
         AND COALESCE(k.candidacy_status, '') NOT IN ('elected', 'not_elected') THEN
        UPDATE politician_elections SET candidacy_status = r.candidacy_status WHERE id = k.id;
        INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('politician_elections', k.id::TEXT, 'candidacy_status', to_jsonb(k.candidacy_status), to_jsonb(r.candidacy_status), p_contribution, p_agent);
      END IF;
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

  -- 政策脈絡的角色（#349）：同一條脈絡、同一種依據保留那位已經有的 → 整列記下再刪；其餘搬過去
  FOR r IN SELECT * FROM lineage_participants lp WHERE lp.politician_id = p_remove LOOP
    IF EXISTS (SELECT 1 FROM lineage_participants k3 WHERE k3.politician_id = p_keep AND k3.lineage_id = r.lineage_id AND k3.basis = r.basis) THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_participants', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM lineage_participants WHERE id = r.id;
    ELSE
      UPDATE lineage_participants SET politician_id = p_keep WHERE id = r.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('lineage_participants', r.id::TEXT, 'politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
    END IF;
    v_participants := v_participants + 1;
  END LOOP;

  -- 交接（#349）：前後任任何一端是併進來的人就改到保留那位；改完前後變成同一人同一屆、或跟已有的同一對任期撞鍵 → 整列記下再刪
  -- （任期表的對應 from_office_id／to_office_id 由觸發器 trg_handovers_fill_office 照新的人重算）
  FOR r IN SELECT * FROM handovers h WHERE h.from_politician_id = p_remove OR h.to_politician_id = p_remove LOOP
    v_new_from := CASE WHEN r.from_politician_id = p_remove THEN p_keep ELSE r.from_politician_id END;
    v_new_to := CASE WHEN r.to_politician_id = p_remove THEN p_keep ELSE r.to_politician_id END;
    IF (v_new_from = v_new_to AND r.from_election_id IS NOT DISTINCT FROM r.to_election_id)
       OR EXISTS (SELECT 1 FROM handovers h2
                   WHERE h2.id <> r.id AND h2.lineage_id = r.lineage_id
                     AND h2.from_politician_id = v_new_from AND h2.from_election_id IS NOT DISTINCT FROM r.from_election_id
                     AND h2.to_politician_id = v_new_to AND h2.to_election_id IS NOT DISTINCT FROM r.to_election_id) THEN
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
      VALUES ('handovers', r.id::TEXT, '*', to_jsonb(r), NULL, p_contribution, p_agent);
      DELETE FROM handovers WHERE id = r.id;
    ELSE
      UPDATE handovers SET from_politician_id = v_new_from, to_politician_id = v_new_to WHERE id = r.id;
      IF r.from_politician_id = p_remove THEN
        INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('handovers', r.id::TEXT, 'from_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
      END IF;
      IF r.to_politician_id = p_remove THEN
        INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
        VALUES ('handovers', r.id::TEXT, 'to_politician_id', to_jsonb(p_remove::TEXT), to_jsonb(p_keep::TEXT), p_contribution, p_agent);
      END IF;
    END IF;
    v_handovers := v_handovers + 1;
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

  RETURN jsonb_build_object('moved_policies', v_policies, 'moved_elections', v_elections, 'filled', to_jsonb(v_filled),
                            'moved_participants', v_participants, 'moved_handovers', v_handovers);
END;
$$;
COMMENT ON FUNCTION merge_politician IS '軟合併：每個寫入各記一列 edit_history（搬動記舊→新、刪列記整列），/apply 的 revert 能整筆倒回；只由 apply 呼叫｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result｜2026-10-06：政策脈絡的角色（lineage_participants）與交接（handovers）一起搬（#349）';

-- ── 2. 參選紀錄改掛後留下的空殼人物 → 走既有的移除流程 ──────────────────
-- 沿用 placeholder_politician（removal 移除整個人）；同一支派工臂多派「空殼」那一種（target.kind＝orphan）。
-- 其餘（測試資料姓名那一種）一字不改，照抄 20261006140000。
CREATE OR REPLACE FUNCTION contribution_auto_tasks_placeholder_politicians()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:placeholder_politician:' || p.id,
         'placeholder_politician',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'region', p.region, 'party', p.party,
                            'elections', (SELECT jsonb_agg(jsonb_build_object('id', pe.id, 'election_id', pe.election_id, 'election_type', pe.election_type,
                                                                              'candidacy_status', pe.candidacy_status, 'source_note', pe.source_note)
                                                           ORDER BY pe.election_id)
                                            FROM politician_elections pe WHERE pe.politician_id = p.id)),
         '人物「' || p.name || '」（' || COALESCE(p.region, '縣市未知') || '）的姓名看起來是測試資料，不像真的參選人。'
           || '請到中選會選舉資料庫、選委會公告與媒體查有沒有這個人：**查無此人** → 用 removal 型別回報，target_table 填 politicians、target_id 填「' || p.id
           || '」、reason（≥20 字）寫你查了哪些地方都沒有這個人；通過後整個人連參選紀錄一起移除（留查核履歷、可還原）。'
           || '**真有其人** → 用 no_change（outcome=confirmed）回報，checked_urls 放看得到他的官方頁面。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || p.name || ' ← 中選會歷屆參選',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, p.region
    FROM politicians p
   WHERE p.merged_into IS NULL AND politician_name_is_placeholder(p.name)
     -- 已經有人交了移除這個人、還在等票的先不派
     AND NOT EXISTS (SELECT 1 FROM contributions c
                      WHERE c.contribution_type = 'removal' AND c.status IN ('pending', 'verified')
                        AND c.payload->>'target_table' = 'politicians' AND c.payload->>'target_id' = p.id::TEXT)
  UNION ALL
  -- 空殼：有一筆參選紀錄被 reassign_candidacy 改掛走（沒被還原），而且現在名下什麼都沒有。
  -- 姓名像測試資料的由上面那一種派，這裡不重複（task_id 同一種格式，會撞號）
  SELECT 'auto:placeholder_politician:' || p.id,
         'placeholder_politician',
         jsonb_build_object('kind', 'orphan', 'politician_id', p.id, 'name', p.name, 'region', p.region, 'party', p.party, 'elections', '[]'::JSONB,
                            'reassigned', (SELECT jsonb_agg(DISTINCT jsonb_build_object('politician_election_id', h.record_id,
                                                                                         'contribution_id', h.contribution_id))
                                             FROM edit_history h
                                            WHERE h.table_name = 'politician_elections' AND h.field = 'politician_id'
                                              AND h.old_value = to_jsonb(p.id::TEXT) AND h.reverted_at IS NULL)),
         '人物「' || p.name || '」（' || COALESCE(p.region, '縣市未知') || '）名下已經沒有任何參選紀錄、政見、任期、學經歷、公民提問或政策脈絡——'
           || '他的參選紀錄被確認掛錯人、改掛到別的同名的人身上之後，這一位就成了空殼。'
           || '請到中選會選舉資料庫、選委會公告與媒體查有沒有這個人（別屆、別地方有沒有參選或任職）：**查無此人** → 用 removal 型別回報，target_table 填 politicians、target_id 填「' || p.id
           || '」、reason（≥20 字）寫你查了哪些地方都沒有這個人；通過後整個人移除（留查核履歷、可還原）。'
           || '**真有其人** → 用 no_change（outcome=confirmed）回報，checked_urls 放看得到他的官方頁面，並用對應的型別補上他的參選紀錄或政見。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || p.name || ' ← 中選會歷屆參選',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, p.region
    FROM politicians p
   WHERE p.merged_into IS NULL AND NOT politician_name_is_placeholder(p.name)
     AND EXISTS (SELECT 1 FROM edit_history h JOIN contributions rc ON rc.id = h.contribution_id AND rc.contribution_type = 'reassign_candidacy'
                  WHERE h.table_name = 'politician_elections' AND h.field = 'politician_id'
                    AND h.old_value = to_jsonb(p.id::TEXT) AND h.reverted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM politician_elections x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM policies x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM politician_offices x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM politician_careers x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM citizen_questions x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM lineage_participants x WHERE x.politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM handovers x WHERE x.from_politician_id = p.id OR x.to_politician_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM politicians x WHERE x.merged_into = p.id)
     AND NOT EXISTS (SELECT 1 FROM contributions c
                      WHERE c.contribution_type = 'removal' AND c.status IN ('pending', 'verified')
                        AND c.payload->>'target_table' = 'politicians' AND c.payload->>'target_id' = p.id::TEXT)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_placeholder_politicians IS
  '姓名看起來是測試資料的人物（politician_name_is_placeholder），新任務型別 placeholder_politician，查無此人就交 removal（2026-10-06）｜'
  '同日加「空殼」那一種（target.kind＝orphan）：參選紀錄被 reassign_candidacy 改掛走、現在名下什麼都沒有的人，走同一條移除流程，不直接刪';

DO $$
BEGIN
  RAISE NOTICE '疑似測試資料與改掛後空殼的人物：% 件', (SELECT count(*) FROM contribution_auto_tasks_placeholder_politicians());
END $$;

NOTIFY pgrst, 'reload schema';
