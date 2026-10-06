-- #345 第二階段 A：讀取端全部改讀新欄位——參選狀態讀 politician_elections.candidacy_status、職稱讀任期表 politician_offices
-- （只換「讀的來源」；不刪任何欄位、不改任何函式簽名，刪舊欄位是第二階段 B，另一個 PR）
--
-- 做了什麼：
--   ① 新函式 candidacy_protocol_status()：新欄位 → 交件協議的詞（派工說明「candidate_status 照現況填」那一句用）。
--      協議（public/skill.md）的 candidate_status／election_result 是交件的欄位名，這一步不改；改的是資料庫裡「讀哪個欄位」
--   ② 任期同步觸發器改聽新欄位：trg_sync_politician_office 原本是 AFTER UPDATE OF election_result, …。
--      新的寫入端只寫 candidacy_status、舊欄位由 BEFORE 觸發器 sync_candidacy_status 同步——而 PostgreSQL 的 AFTER UPDATE OF 欄位清單
--      只看 UPDATE 語句自己寫了哪些欄位、不看 BEFORE 觸發器順手改的（PGlite 實測：只改 a、BEFORE 觸發器改 b，AFTER UPDATE OF b 不會響）。
--      所以清單加上 candidacy_status（舊的 election_result 留著，過渡期還有舊寫入端），函式也改看 candidacy_status
--   ③ 派工臂與其他讀舊兩欄的函式（共 24 支）：篩選改看 candidacy_status
--      （not_running → withdrawn、election_result = elected／not_elected → candidacy_status 同值、傳聞 → 空值）；
--      target 與說明裡要給代理看的「candidate_status 現況」改由 candidacy_status 換算（協議的詞），鍵名不變
--   ④ 視圖：politicians_with_elections 的 offices 改讀任期表 politician_offices（已就任、卸任日為空；職稱逐人比對 8,544 位一樣，
--      見下面第 ⑤ 段的核對）；elected_politicians、politician_bulletins 改看 candidacy_status。
--      politicians_with_elections 的 elections[] 仍帶舊的 candidateStatus／electionResult 兩鍵（畫面已經不讀，給還沒更新的舊前端用；第二階段 B 拿掉）
--   ⑤ 核對（對不上整支退回）：任期表現任的職稱跟舊視圖 politician_offices_derived 逐人一致
--
-- 不動的：candidacy_status_from_legacy／legacy_status_from_candidacy／sync_candidacy_status（過渡期的雙向同步，第二階段 B 一起刪）、
-- contribution_required_agree／correction_only_from_rumor（看的是交件 payload 的欄位名，不是資料庫欄位）、
-- 舊視圖 politician_offices_derived 與差異視圖 politician_offices_gap（第二階段 B 刪）。
--
-- 順序：CI 先 db push、再部署函式（CLAUDE.md「部署順序」）。新函式（只寫 candidacy_status）要等這支先上線，
-- 任期觸發器才聽得到——手動先部署函式、後跑這支的話，標當選的交件不會建任期。

-- ── ① 新欄位 → 協議的詞 ────────────────────────────────────────
CREATE OR REPLACE FUNCTION candidacy_protocol_status(p_candidacy_status TEXT, p_list_published BOOLEAN)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_candidacy_status
    WHEN 'withdrawn' THEN 'not_running'
    WHEN 'declared' THEN 'confirmed'
    WHEN 'filed' THEN CASE WHEN COALESCE(p_list_published, false) THEN 'qualified' ELSE 'registered' END
    WHEN 'elected' THEN 'qualified'
    WHEN 'not_elected' THEN 'qualified'
    WHEN 'considering' THEN 'likely'
    ELSE 'rumored'
  END
$$;
COMMENT ON FUNCTION candidacy_protocol_status IS '新的 candidacy_status 換成交件協議的詞（派工說明「candidate_status 照現況填」用）：名單公告後在名單上的填 qualified、公告前填 registered、選完了（當選落選）名單早已公告填 qualified；空值（傳聞）回 rumored（現況的描述，協議不收這個值）。TS 鏡像 _shared/candidacy-status.ts 的 protocolStatusFromCandidacy（#345 第二階段 A）';
GRANT EXECUTE ON FUNCTION candidacy_protocol_status(TEXT, BOOLEAN) TO anon, authenticated;

-- ── ② 任期同步觸發器改聽 candidacy_status ─────────────────────────
CREATE OR REPLACE FUNCTION sync_politician_office_from_election()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  o politician_offices%ROWTYPE;
  v_year INTEGER;
  v_start DATE;
  v_end DATE;
  v_new politician_offices%ROWTYPE;
BEGIN
  SELECT * INTO o FROM politician_offices WHERE politician_election_id = NEW.id;

  IF NEW.candidacy_status = 'elected' THEN
    SELECT EXTRACT(YEAR FROM e.election_date)::INTEGER INTO v_year FROM elections e WHERE e.id = NEW.election_id;
    IF v_year IS NULL OR NEW.election_type IS NULL
       OR NEW.election_type NOT IN ('總統副總統', '立法委員', '縣市長', '縣市議員', '鄉鎮市長',
                                    '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長') THEN
      RETURN NEW;  -- 選舉別不明的當選紀錄算不出任期，不建；politician_offices_gap 也看不到它（舊視圖同樣算不出）
    END IF;
    v_start := office_term_start(v_year, NEW.election_type);
    v_end := office_term_end(v_year, NEW.election_type);
    IF o.id IS NULL THEN
      INSERT INTO politician_offices (politician_id, election_type, region_id, start_date, scheduled_end_date,
                                      election_id, politician_election_id, basis, note)
      VALUES (NEW.politician_id, NEW.election_type, NEW.region_id, v_start, v_end,
              NEW.election_id, NEW.id, 'election_result', '參選紀錄標了當選')
      RETURNING * INTO v_new;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', v_new.id::TEXT, '*', NULL, to_jsonb(v_new), 'office-sync');
    ELSIF o.politician_id IS DISTINCT FROM NEW.politician_id OR o.election_type IS DISTINCT FROM NEW.election_type
       OR o.region_id IS DISTINCT FROM NEW.region_id OR o.election_id IS DISTINCT FROM NEW.election_id
       OR o.basis <> 'election_result' THEN
      UPDATE politician_offices
         SET politician_id = NEW.politician_id, election_type = NEW.election_type, region_id = NEW.region_id,
             election_id = NEW.election_id, basis = 'election_result',
             start_date = v_start, scheduled_end_date = v_end, updated_at = now()
       WHERE id = o.id
      RETURNING * INTO v_new;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', o.id::TEXT, '*', to_jsonb(o), to_jsonb(v_new), 'office-sync');
    END IF;
    PERFORM politician_offices_close_ended(CURRENT_DATE, NEW.politician_id);
    IF TG_OP = 'UPDATE' AND OLD.politician_id IS DISTINCT FROM NEW.politician_id THEN
      PERFORM politician_offices_close_ended(CURRENT_DATE, OLD.politician_id);
    END IF;
  ELSIF o.id IS NOT NULL THEN
    IF NEW.candidacy_status = 'not_elected' OR o.basis = 'election_result' THEN
      -- 標成落選／退選，或原本靠「我們標的當選」、現在當選被拿掉：這個任期從來不存在，刪掉（整列記在 edit_history 可還原）
      DELETE FROM politician_offices WHERE id = o.id;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', o.id::TEXT, '*', to_jsonb(o), NULL, 'office-sync');
    ELSIF o.politician_id IS DISTINCT FROM NEW.politician_id OR o.region_id IS DISTINCT FROM NEW.region_id THEN
      -- 中選會那條回填的：參選紀錄換人（合併人物）或換地區時跟著改；選舉別、屆別變了就對不上中選會那一列，交給 politician_offices_gap
      UPDATE politician_offices SET politician_id = NEW.politician_id, region_id = NEW.region_id, updated_at = now()
       WHERE id = o.id RETURNING * INTO v_new;
      INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
      VALUES ('politician_offices', o.id::TEXT, '*', to_jsonb(o), to_jsonb(v_new), 'office-sync');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION sync_politician_office_from_election IS '#345：參選紀錄標了當選就建任期、當選被拿掉就刪；職位、地區、人物指認跟著改；每筆記 edit_history（office-sync）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';
DROP TRIGGER IF EXISTS trg_sync_politician_office ON politician_elections;
CREATE TRIGGER trg_sync_politician_office
  AFTER INSERT OR UPDATE OF candidacy_status, election_result, election_type, region_id, politician_id, election_id ON politician_elections
  FOR EACH ROW EXECUTE FUNCTION sync_politician_office_from_election();

-- ── ③ 派工臂與其他函式 ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION merge_politician(p_keep uuid, p_remove uuid, p_contribution uuid, p_agent text)
RETURNS jsonb
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
COMMENT ON FUNCTION merge_politician IS '軟合併：每個寫入各記一列 edit_history（搬動記舊→新、刪列記整列），/apply 的 revert 能整筆倒回；只由 apply 呼叫｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION politician_latest_election(p_politician_id uuid)
RETURNS TABLE(election_id integer, candidate_status text, "position" text, slogan text, election_type text, region_id integer)
LANGUAGE sql STABLE AS $$
  SELECT pe.election_id, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)), pe."position", pe.slogan, pe.election_type, pe.region_id
    FROM politician_elections pe
   WHERE pe.politician_id = p_politician_id
   ORDER BY (COALESCE(pe.candidacy_status, '') = 'withdrawn'), pe.election_id DESC
   LIMIT 1
$$;
COMMENT ON FUNCTION politician_latest_election IS '人物的「最新一屆」：最近一屆有在選的參選紀錄（表態不參選排最後，全部都是表態不參選才用最近一筆）。politicians 的 position／slogan／election_type／region_id 由它衍生（trg_sync_politician_latest），2026-10-05｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION is_2026_mayor_candidate(p_politician_id uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM politician_elections pe
    WHERE pe.politician_id = p_politician_id
      AND pe.election_id = 2026 AND pe.election_type = '縣市長'
      AND pe.candidacy_status IN ('declared', 'filed')
  );
$$;
COMMENT ON FUNCTION is_2026_mayor_candidate IS '2026 已登記的縣市長候選人：他們的基本資料與政見是網站首要內容，派工排最前（使用者 2026-09-21）。｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION news_screen_people()
RETURNS TABLE(politician_id uuid, name text, region text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p.id, p.name, p.region,
         string_agg(DISTINCT pe.election_id::TEXT || ' ' || pe.election_type::TEXT
                    || CASE WHEN pe.candidacy_status = 'elected' THEN '當選' ELSE '參選' END, '、')
    FROM politicians p
    JOIN politician_elections pe ON pe.politician_id = p.id
   WHERE p.merged_into IS NULL
     AND char_length(btrim(p.name)) >= 2
     AND ((pe.election_id IN (2022, 2024) AND pe.candidacy_status = 'elected')
       OR (pe.election_id = 2026 AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'))
   GROUP BY p.id, p.name, p.region
$$;
COMMENT ON FUNCTION news_screen_people IS '新聞初篩的人名池：2022／2024 當選或 2026 參選中（排除不參選、退選、已合併、姓名不到兩字）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION cec_reconcile_findings()
RETURNS TABLE(kind text, election_id integer, election_type text, region text, pe_id integer, politician_id uuid, name text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH synced AS (
    SELECT DISTINCT c.election_id, c.election_type FROM cec_candidates c
  ),
  ours AS (
    SELECT pe.id AS pe_id, pe.politician_id, pe.election_id, pe.election_type,
           COALESCE(r.region, p.region) AS region, r.sub_region, p.name, cec_name_norm(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
      JOIN synced s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
     WHERE pe.candidacy_status IN ('declared', 'filed', 'elected', 'not_elected')
  )
  SELECT 'not_in_cec', o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name,
         '中選會 ' || o.election_id || ' ' || o.election_type || ' 全國名單查無同名者'
    FROM ours o
   WHERE NOT EXISTS (SELECT 1 FROM cec_candidates c
                      WHERE c.election_id = o.election_id AND c.election_type = o.election_type AND c.name_norm = o.nn)
     -- 只判那個縣市已經同步到的：同步中斷漏掉的縣市不能被當成「整個縣市查無此人」（09-26 金門縣村里長）
     AND EXISTS (SELECT 1 FROM cec_candidates c3
                  WHERE c3.election_id = o.election_id AND c3.election_type = o.election_type AND c3.region = o.region)
  UNION ALL
  SELECT 'region_mismatch', o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name,
         '中選會名單上在 ' || string_agg(DISTINCT c.region || COALESCE(' ' || c.sub_region, ''), '、') || '，我們存的是 ' || COALESCE(o.region, '（空）')
    FROM ours o
    JOIN cec_candidates c ON c.election_id = o.election_id AND c.election_type = o.election_type AND c.name_norm = o.nn
   WHERE NOT EXISTS (SELECT 1 FROM cec_candidates c2
                      WHERE c2.election_id = o.election_id AND c2.election_type = o.election_type AND c2.name_norm = o.nn
                        AND c2.region = o.region)
   GROUP BY o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name
$$;
COMMENT ON FUNCTION cec_reconcile_findings IS '我們的參選紀錄 vs 中選會名單（只看已同步的屆別×選舉別）：查無此人、縣市不符｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION election_result_cec_matches(p_ids integer[])
RETURNS TABLE(politician_election_id integer, politician_id uuid, name text, election_id integer, election_type text, county text, town text, village text, district text, current_result text, cec_hits integer, cec_elected boolean, cec_cand_id integer, cec_theme_id text, cec_sub_region text, cec_village text, cec_birth_year integer)
LANGUAGE sql STABLE AS $$
  WITH pe AS (
    SELECT pe.id, pe.politician_id, p.name, pe.election_id, pe.election_type,
           CASE WHEN pe.candidacy_status IN ('elected', 'not_elected') THEN pe.candidacy_status END AS election_result,
           cec_name_key(p.name) AS nn,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           -- 鄉鎮層級的選舉：參選紀錄自己那一列的鄉鎮，沒有才看人物的；代表的「麥寮鄉第01選舉區」去掉選舉區只留鄉鎮
           CASE WHEN pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                THEN NULLIF(regexp_replace(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.sub_region END, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '')
           END AS town,
           CASE WHEN pe.election_type = '村里長'
                THEN NULLIF(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.village END, p.village, ''), '')
           END AS village,
           CASE WHEN r.id IS NOT NULL THEN r.sub_region END AS district
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.id = ANY (p_ids)
  )
  SELECT x.id, x.politician_id, x.name, x.election_id, x.election_type,
         x.county, x.town, x.village, x.district, x.election_result,
         m.n, c.elected, c.cec_cand_id, c.cec_theme_id, c.sub_region, c.village, c.birth_year
    FROM pe x
    LEFT JOIN LATERAL (
      SELECT count(*)::INTEGER AS n, min(cc.id) AS cec_id
        FROM cec_candidates cc
       WHERE cc.election_id = x.election_id AND cc.election_type = x.election_type
         AND cc.region = x.county AND cc.name_norm = x.nn
         AND (x.town IS NULL OR regexp_replace(COALESCE(cc.sub_region, ''), '(第[0-9]+)?選舉區$', '') = x.town)
         AND (x.village IS NULL OR cc.village = x.village)
    ) m ON true
    LEFT JOIN cec_candidates c ON m.n = 1 AND c.id = m.cec_id
$$;
COMMENT ON FUNCTION election_result_cec_matches IS '參選紀錄 → 中選會名單（同屆、同選舉、同縣市、cec_name_key 同名；鄉鎮、村里有就一起對）。cec_hits＝對上幾列，1＝唯一對上（#377，2026-10-06）。派工、系統票、驗證項共用這一支｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION lineage_candidate_scope()
RETURNS TABLE(policy_id uuid, title text, content_md5 text, category text, status text, lineage_id uuid, politician_id uuid, name text, election_id integer, election_date date, election_type text, level text, region text, sub_region text)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT pl.id AS policy_id, pl.title, md5(pl.title || COALESCE(pl.description, '')) AS content_md5, pl.category,
           pl.status::TEXT AS status, pl.lineage_id, p.id AS politician_id, p.name, pl.election_id, e.election_date,
           x.election_type,
           -- 縣市與鄉鎮只來自那一屆參選紀錄自己（10-05 裁決：不借人物表的地區；缺地區的由「補縣市／補選區」任務補上後才進格）
           replace(r.region, '臺', '台') AS county, r.sub_region AS r_sub
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      JOIN LATERAL (
        SELECT q.election_type, q.candidacy_status, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.candidacy_status = 'elected') DESC NULLS LAST,
                  (q.candidacy_status IS DISTINCT FROM 'withdrawn') DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL AND pl.category IS NOT NULL
       AND (
         (e.election_date >= CURRENT_DATE AND x.candidacy_status IS DISTINCT FROM 'withdrawn')
         OR (e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected')
       )
  )
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'national', NULL::TEXT, NULL::TEXT
    FROM scoped s WHERE s.election_type IN ('總統副總統', '立法委員')
  UNION ALL
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'county', s.county, NULL::TEXT
    FROM scoped s
   WHERE s.county IS NOT NULL AND s.county <> '全國'
     AND (s.election_type IN ('縣市長', '縣市議員') OR s.election_type = '立法委員')
  UNION ALL
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'township', s.county, s.r_sub
    FROM scoped s
   WHERE s.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') AND s.county IS NOT NULL AND s.r_sub IS NOT NULL
$$;
COMMENT ON FUNCTION lineage_candidate_scope IS '脈絡候選的範圍（#349）：哪些政見、放在哪一格（層級＋縣市＋鄉鎮＋類別）。還沒投票的屆別看在選者、已投票的看當選者（同三要素）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_deadline_due()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:deadline_due:' || pl.id, 'deadline_due',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'status', pl.status::TEXT, 'progress', pl.progress,
                            'politician_id', p.id, 'name', p.name, 'region', p.region, 'election_id', pl.election_id,
                            'deadline_date', d.deadline_date, 'deadline_text', d.text, 'deadline_source_url', d.source_url,
                            'deadline_source_locator', d.source_locator,
                            'last_log_date', (SELECT max(tl.date) FROM tracking_logs tl WHERE tl.policy_id = pl.id)),
         '「' || pl.title || '」（' || p.name || '）原文寫的達成期限是「' || d.text || '」（換算 ' || d.deadline_date::TEXT || '），已經過了；'
           || '這條政見現在標的是「' || CASE pl.status::TEXT WHEN 'Campaign Pledge' THEN '競選承諾' WHEN 'Proposed' THEN '提出'
                                          WHEN 'In Progress' THEN '進行中' WHEN 'Stalled' THEN '滯後' ELSE pl.status::TEXT END
           || '」，期限之後沒有任何進度紀錄。請查期限到了做到沒有（施政報告、議會或立法院紀錄、預算書、新聞），'
           || '有結果就用 policy_progress 交：date 填事件日期，note 寫清楚跟期限比的結果（例：「原訂 2025 年底完工，2026-03 才通車」）；'
           || '查證後確定期限之後真的沒有任何消息，就用 no_change 回報你查了哪些來源。不要自己判定跳票——要有來源寫出結果。',
         ARRAY['縣市政府或中央機關的施政報告（*.gov.tw）', '議會、立法院的議事錄與質詢紀錄', '預算書與決算書', 'cna.com.tw'],
         1, p.region
    FROM policy_elements d
    JOIN policies pl ON pl.id = d.policy_id AND pl.removed_at IS NULL
    JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
    LEFT JOIN elections e ON e.id = pl.election_id
   WHERE d.element = 'deadline' AND d.stated AND d.deadline_date IS NOT NULL
     AND d.deadline_date < CURRENT_DATE
     AND pl.status::TEXT NOT IN ('Achieved', 'Failed')
     AND NOT EXISTS (SELECT 1 FROM tracking_logs tl WHERE tl.policy_id = pl.id AND tl.date > d.deadline_date)
     -- 競選承諾要等那場選舉投完票才問得出「做到沒有」（同 progress_stale）
     AND (pl.status::TEXT <> 'Campaign Pledge' OR (e.election_date IS NOT NULL AND e.election_date < CURRENT_DATE))
     -- 落選／退選者的承諾不會有進度（同 progress_stale）
     AND NOT EXISTS (
       SELECT 1 FROM politician_elections pe
        WHERE pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id
          AND pe.candidacy_status IN ('not_elected', 'withdrawn')
     )
$$;
COMMENT ON FUNCTION contribution_auto_tasks_deadline_due IS '達成期限的日期已過、政見未達成也未跳票、期限之後沒有追蹤紀錄 → deadline_due（查進度，交 policy_progress）。跟日本站「期限を迎えた公約」同條件（#364，2026-10-05）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_election_results()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH gap AS (
    SELECT pe.id
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE
     WHERE COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')
  ),
  -- 已經有人交了、還在等票的不再派（同一份名單抄一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT (it->>'politician_election_id')::INTEGER AS id
      FROM contributions c
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'items') = 'array' THEN c.payload->'items' ELSE '[]'::jsonb END) it
     WHERE c.contribution_type = 'election_results' AND c.status IN ('pending', 'verified')
       AND (it->>'politician_election_id') ~ '^[0-9]{1,9}$'
  ),
  m AS (
    SELECT * FROM election_result_cec_matches(ARRAY(SELECT g.id FROM gap g WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.id = g.id)))
  ),
  units AS (
    SELECT m.*,
           CASE WHEN m.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN m.town END AS unit_town
      FROM m WHERE m.cec_hits = 1
  ),
  numbered AS (
    SELECT u.*,
           (row_number() OVER w - 1) / 120 + 1 AS part,
           (count(*) OVER (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town) - 1) / 120 + 1 AS parts
      FROM units u
    WINDOW w AS (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town
                 ORDER BY u.town NULLS LAST, u.village NULLS LAST, u.name, u.politician_election_id)
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts,
           count(*) AS items_count,
           jsonb_agg(n.politician_election_id ORDER BY n.town NULLS LAST, n.village NULLS LAST, n.name, n.politician_election_id) AS ids
      FROM numbered n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  )
  -- 批次：一個單位一件（超過 120 位拆成幾件）
  SELECT 'auto:election_results_missing:' || g.election_id || ':' || g.election_type || ':' || g.county
           || COALESCE(':' || g.unit_town, '') || CASE WHEN g.parts > 1 THEN ':p' || g.part ELSE '' END,
         'election_results_missing',
         jsonb_build_object('election_id', g.election_id, 'election_type', g.election_type, 'region', g.county,
                            'sub_region', g.unit_town, 'election_date', e.election_date,
                            'part', g.part, 'parts', g.parts, 'items_count', g.items_count,
                            'politician_election_ids', g.ids),
         g.county || COALESCE(g.unit_town, '') || ' ' || g.election_id || ' ' || g.election_type || '：'
           || '我們有 ' || g.items_count || ' 位參選人的選舉結果還空著'
           || CASE WHEN g.parts > 1 THEN '（這個單位太大，拆成 ' || g.parts || ' 件，這是第 ' || g.part || ' 件）' ELSE '' END
           || '，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。名單在 current.items：每一位附系統比對到的中選會那一列（cec），那是線索不是答案。'
           || '請打開中選會選舉資料庫這個單位的結果逐位核對（同名不同人要看選區、村里、出生年），交一筆 election_results：'
           || 'election_id 填 ' || g.election_id || '、election_type 填「' || g.election_type || '」、region 填「' || g.county || '」'
           || CASE WHEN g.unit_town IS NOT NULL THEN '、sub_region 填「' || g.unit_town || '」' ELSE '' END
           || '，items 每位一項 {politician_election_id, election_result：elected 或 not_elected}。核對不了或不是同一個人的不要放進 items，在 note 寫是哪幾位。'
           || 'source_urls 第一個放你核對的中選會那一頁。',
         ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：依屆別、選舉、縣市（鄉鎮）點到結果表，當選者有標記',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 個別查一位的歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 直接回中選會的當選與否'],
         1, g.county
    FROM grouped g
    JOIN elections e ON e.id = g.election_id
  UNION ALL
  -- 對不上的（同縣市同名多位、名單查無）：各自派 election_result_missing，附名單上同縣市同名的人請代理指認。
  -- 名下有政見的那幾筆 contribution_auto_tasks_raw 原本就在派同一個 task_id，這裡不重複
  SELECT 'auto:election_result_missing:' || m.politician_election_id,
         'election_result_missing',
         jsonb_build_object('politician_id', m.politician_id, 'name', m.name, 'region', m.county,
                            'sub_region', m.town, 'village', m.village,
                            'election_id', m.election_id, 'election_type', m.election_type, 'election_date', e.election_date,
                            'cec_hits', m.cec_hits,
                            'cec_same_name', COALESCE((
                              SELECT jsonb_agg(jsonb_build_object('sub_region', cc.sub_region, 'village', cc.village, 'birth_year', cc.birth_year,
                                                                  'elected', cc.elected, 'cec_cand_id', cc.cec_cand_id, 'cec_theme_id', cc.cec_theme_id)
                                               ORDER BY cc.sub_region, cc.village)
                                FROM cec_candidates cc
                               WHERE cc.election_id = m.election_id AND cc.election_type = m.election_type
                                 AND cc.region = m.county AND cc.name_norm = cec_name_key(m.name)), '[]'::jsonb)),
         m.name || '（' || COALESCE(m.county, '') || COALESCE(' ' || m.town, '') || COALESCE(' ' || m.village, '') || ' '
           || m.election_id || ' ' || m.election_type || '）的選舉結果還空著，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。'
           || CASE WHEN m.cec_hits = 0 THEN '系統在中選會名單上找不到同縣市同名、地區也對得上的人（多半是地區或姓名寫錯）。'
                   ELSE '中選會名單上同縣市同名、地區也對得上的有 ' || m.cec_hits || ' 位，系統分不出是哪一位（target.cec_same_name）。' END
           || '請到中選會選舉資料庫核對他是哪一位，用 candidacy 補 election_result（elected 或 not_elected），帶 politician_id；'
           || '名單上真的沒有他、或確定不是同一個人，用 no_change 回報你查了哪些網址，不要猜。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || m.name || ' ← 中選會歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || m.name || '","electionId":' || m.election_id || '}'],
         1, m.county
    FROM m
    JOIN elections e ON e.id = m.election_id
   WHERE m.cec_hits <> 1
     AND NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = m.politician_id AND pl.removed_at IS NULL)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_election_results IS '補選舉結果（#377 第 4 節，2026-10-06）：已投票屆別結果空白的參選紀錄，中選會名單唯一對上的依單位（屆別×選舉×縣市，村里長與代表到鄉鎮）聚成 election_results_missing，一件最多 120 位；對不上的各自派 election_result_missing（名下有政見的由 contribution_auto_tasks_raw 派）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_handover_missing()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH exec AS (
    SELECT DISTINCT pl.lineage_id, pe.politician_id AS from_id, pe.election_id AS from_eid, pe.election_type,
           replace(r.region, '臺', '台') AS county, r.sub_region AS town, e.election_date AS from_date,
           office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, pe.election_type) AS from_term_end
      FROM policies pl
      JOIN politician_elections pe ON pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id
       AND pe.candidacy_status = 'elected' AND pe.election_type IN ('縣市長', '鄉鎮市長', '直轄市山地原住民區長')
      JOIN elections e ON e.id = pe.election_id
      JOIN regions r ON r.id = pe.region_id
     WHERE pl.lineage_id IS NOT NULL AND pl.removed_at IS NULL
  ),
  succ AS (
    -- 同一個職位、下一個當選的人（投票日在前一任之後的第一個）
    SELECT DISTINCT ON (x.lineage_id, x.from_id, x.from_eid)
           x.*, pe2.politician_id AS to_id, pe2.election_id AS to_eid
      FROM exec x
      JOIN politician_elections pe2 ON pe2.election_type = x.election_type AND pe2.candidacy_status = 'elected'
      JOIN elections e2 ON e2.id = pe2.election_id AND e2.election_date > x.from_date
      JOIN regions r2 ON r2.id = pe2.region_id
     WHERE replace(r2.region, '臺', '台') = x.county
       AND (x.election_type = '縣市長' OR r2.sub_region IS NOT DISTINCT FROM x.town)
       AND x.from_term_end < CURRENT_DATE
     ORDER BY x.lineage_id, x.from_id, x.from_eid, e2.election_date, pe2.politician_id
  )
  SELECT 'auto:handover_missing:' || s.lineage_id || ':' || substr(md5(s.from_id::TEXT || ':' || s.from_eid || ':' || s.to_id::TEXT || ':' || s.to_eid), 1, 8),
         'handover_missing',
         jsonb_build_object('lineage_id', s.lineage_id, 'lineage_title', l.title, 'level', l.level, 'region', l.region,
                            'sub_region', l.sub_region, 'office', s.election_type,
                            'from_politician_id', s.from_id, 'from_name', fp.name, 'from_election_id', s.from_eid,
                            'from_term_end', s.from_term_end,
                            'to_politician_id', s.to_id, 'to_name', tp.name, 'to_election_id', s.to_eid),
         '脈絡「' || l.title || '」裡有 ' || fp.name || '（' || s.election_type || '，' || EXTRACT(YEAR FROM s.from_date)::INTEGER || ' 年當選，'
           || s.from_term_end::TEXT || ' 卸任）任內的政見；接任的是 ' || tp.name || '，但脈絡裡還沒有這兩任之間的交接紀錄。'
           || '請查 ' || tp.name || ' 上任後這件事怎麼了：照舊做（keep 接手）、目的不變但改了做法（pivot 轉向）、規模或預算縮水但沒停（shrink 縮小）、'
           || '停掉了（stop 中止）、或曾經停掉後又重啟（resume 重新開始）。用 lineage_handover 交一筆，note 寫清楚依據（哪份預算、議會紀錄、施政報告或報導，講了什麼）。'
           || '**中止要有來源明確寫出停止、喊卡、解約或終止**——「後任政見清單裡沒有」不等於中止；中止這一型要兩台不同機器的驗證票才會上線。'
           || '還查不到後任怎麼處理（剛上任、沒有任何公開資料）→ no_change，outcome=not_found。',
         ARRAY['縣市政府施政報告、預算書（*.gov.tw）', '縣市議會議事錄與質詢紀錄', 'cna.com.tw'],
         1, COALESCE(l.region, '全國')
    FROM succ s
    JOIN lineages l ON l.id = s.lineage_id
    JOIN politicians fp ON fp.id = s.from_id
    JOIN politicians tp ON tp.id = s.to_id
   WHERE s.to_id <> s.from_id
     AND NOT EXISTS (
       SELECT 1 FROM handovers h
        WHERE h.lineage_id = s.lineage_id AND h.from_politician_id = s.from_id AND h.to_politician_id = s.to_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM contributions c
        WHERE c.contribution_type = 'lineage_handover' AND c.status IN ('pending', 'verified', 'apply_failed')
          AND c.payload->>'lineage_id' = s.lineage_id::TEXT
          AND c.payload->>'from_politician_id' = s.from_id::TEXT AND c.payload->>'to_politician_id' = s.to_id::TEXT
     )
$$;
COMMENT ON FUNCTION contribution_auto_tasks_handover_missing IS '脈絡裡有首長那一任的政見、那個職位之後換了人而前任已卸任、卻沒有交接 → handover_missing（交 lineage_handover）（#349，2026-10-06）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_roles()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH people AS (
    SELECT DISTINCT pl.lineage_id, p.id AS politician_id, p.name
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
     WHERE pl.lineage_id IS NOT NULL AND pl.removed_at IS NULL
       AND EXISTS (
         SELECT 1 FROM politician_elections pe JOIN elections e ON e.id = pe.election_id
          WHERE pe.politician_id = p.id AND pe.candidacy_status = 'elected' AND e.election_date < CURRENT_DATE
            AND pe.election_type IN ('立法委員', '縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表')
       )
       AND NOT EXISTS (SELECT 1 FROM lineage_participants lp WHERE lp.lineage_id = pl.lineage_id AND lp.politician_id = p.id)
  ),
  grp AS (
    SELECT lineage_id, jsonb_agg(jsonb_build_object('politician_id', politician_id, 'name', name) ORDER BY name, politician_id) AS people,
           string_agg(name, '、' ORDER BY name, politician_id) AS names
      FROM people GROUP BY lineage_id
  )
  SELECT 'auto:lineage_roles_missing:' || l.id, 'lineage_roles_missing',
         jsonb_build_object('lineage_id', l.id, 'lineage_title', l.title, 'level', l.level, 'region', l.region,
                            'sub_region', l.sub_region, 'category', l.category, 'people', g.people),
         '脈絡「' || l.title || '」裡有民意代表的政見（' || g.names || '），但還沒有他們在這件事裡的角色。'
           || '請到**官方紀錄**查：立法院議事系統（提案、關係文書、連署名單）、縣市議會網站（提案、議事錄）。'
           || '查到誰是提案人（proposer）、共同提案人（co_proposer）、連署人（cosigner）、或在官方紀錄裡主張推動（advocate，例：質詢、臨時提案）'
           || '——不限 target.people，同一案的其他提案、連署人也一起標——用 lineage_participants 交一筆，basis 填 official_record、出處放那一頁、source_locator 寫議案編號或頁碼。'
           || '本人在官網、新聞或答辯書裡說「我提的」而官方紀錄不是：照官方紀錄標角色，另外加一項 basis=self_claim（本人宣稱）。臉書讀不到，不收。'
           || '官方紀錄裡查不到這個人跟這件事有關 → 不要替他標角色；全部都查不到 → no_change，outcome=not_found，checked_urls 列你查過的議事系統頁面。',
         ARRAY['https://lis.ly.gov.tw/lylgmeetc/lgmeetkm ← 立法院議事系統（議案、關係文書）', 'https://ppg.ly.gov.tw ← 立法院議事暨公報資訊網', '各縣市議會官網（*.gov.tw）的提案與議事錄'],
         1, COALESCE(l.region, '全國')
    FROM grp g
    JOIN lineages l ON l.id = g.lineage_id
   WHERE NOT EXISTS (
       SELECT 1 FROM contributions c
        WHERE c.contribution_type = 'lineage_participants' AND c.status IN ('pending', 'verified', 'apply_failed')
          AND c.payload->>'lineage_id' = l.id::TEXT
     )
$$;
COMMENT ON FUNCTION contribution_auto_tasks_lineage_roles IS '脈絡裡有民意代表（當過立委、議員、代表）的政見、卻沒有他的參與角色 → lineage_roles_missing（交 lineage_participants，照官方紀錄）（#349，2026-10-06）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mismatch()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH jev AS (
    SELECT DISTINCT ON (j.subject_id) j.subject_id, j.choice, j.probability
    FROM jev_decisions j
    WHERE j.subject_type = 'policy' AND j.question = 'election'
    ORDER BY j.subject_id, j.asked_at DESC
  ),
  by_date AS (
    SELECT pl.id
    FROM policies pl
    JOIN politicians p ON p.id = pl.politician_id
    JOIN elections e ON e.id = pl.election_id
    WHERE pl.removed_at IS NULL
      AND pl.proposed_date IS NOT NULL
      AND pl.proposed_date > e.election_date
      -- 2026-09-22 #5：當選者任內提出的施政掛在當選那一屆是對的
      AND NOT EXISTS (
        SELECT 1 FROM politician_elections pe
        WHERE pe.politician_id = p.id AND pe.election_id = pl.election_id AND pe.candidacy_status = 'elected'
      )
  ),
  by_jev AS (
    SELECT pl.id
    FROM policies pl
    JOIN jev ON jev.subject_id = pl.id::TEXT
    WHERE pl.removed_at IS NULL
      AND pl.election_id IS NOT NULL
      AND jev.choice ~ '^\d{4}$'
      AND jev.choice <> pl.election_id::TEXT
      AND jev.probability >= 0.8
  ),
  ids AS (SELECT id FROM by_date UNION SELECT id FROM by_jev)
  SELECT 'auto:policy_election_mismatch:' || pl.id AS task_id, 'policy_election_mismatch' AS task_type,
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'election_id', pl.election_id, 'election_date', e.election_date, 'source_url', pl.source_url,
                            'system_guess', CASE WHEN jev.choice ~ '^\d{4}$' AND jev.choice <> pl.election_id::TEXT AND jev.probability >= 0.8
                                                 THEN jsonb_build_object('election_id', jev.choice::INTEGER, 'probability', round(jev.probability::NUMERIC, 2)) END) AS target,
         '政見「' || pl.title || '」（' || p.name || '）標的是 ' || pl.election_id || ' 那一屆，'
           || CASE WHEN pl.proposed_date IS NOT NULL AND pl.proposed_date > e.election_date
                   THEN '但提出日期 ' || pl.proposed_date::TEXT || ' 晚於那場選舉的投票日 ' || e.election_date::TEXT || '，兩者對不上。'
                   ELSE '但系統依政見內容判斷比較像 ' || jev.choice || ' 那一屆（把握 ' || round(jev.probability::NUMERIC * 100) || '%，只是線索，不是答案）。' END
           || '請打開來源確認：這是哪一場選舉的承諾（或哪個任期內的施政）？'
           || '屆別標錯 → 用 correction 把 policies.election_id 改成正確年份；提出日期填錯 → 用 correction 改 policies.proposed_date（來源有寫日期才改，沒有就清空）。'
           || '判斷依據是來源本身；原本的屆別其實是對的、或分不出來，就用 no_change 回報你查了什麼。' AS what_we_need,
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁'] AS hint_sources, 1 AS reward, p.region AS region
  FROM ids
  JOIN policies pl ON pl.id = ids.id
  JOIN politicians p ON p.id = pl.politician_id
  JOIN elections e ON e.id = pl.election_id
  LEFT JOIN jev ON jev.subject_id = pl.id::TEXT
$$;
COMMENT ON FUNCTION contribution_auto_tasks_mismatch IS '屆別可能標錯的政見 → policy_election_mismatch 任務：提出日期晚於所屬選舉投票日（當選者任內除外），或 Jev 以 ≥0.8 判成別屆｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_not_running()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:not_running_recheck:' || pe.id, 'not_running_recheck',
         jsonb_build_object('politician_election_id', pe.id, 'politician_id', p.id, 'name', p.name,
                            'election_id', pe.election_id, 'election_type', pe.election_type,
                            'region', COALESCE(r.region, p.region), 'source_note', pe.source_note,
                            'registration_closed_on', s.registration_closed_on),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '被標成「不參選」，但沒有任何人對過官方登記名單——這一列多半是早期匯入時就這樣寫的。'
           || '**這個標記的代價很大**：標成不參選之後，這個人的政見、基本資料、參選來源、選舉結果四種缺口都不會再被派給任何人，所以它值得被核對一次。'
           || '登記已經在 ' || s.registration_closed_on::TEXT || ' 截止，名單現在查得到。請打開該縣市選舉委員會的登記公告（或媒體整理的完整登記名單）核對：'
           || '**他在名單上** → 用 correction 把 politician_elections.candidate_status 改成 registered，附那份名單；'
           || '**確實不在名單上** → 用 no_change 回報、outcome 填 confirmed，checked_urls 放你核對的那份名單（這時系統才會把這一列標成已核對，不再重派）；'
           || '**找不到該縣市的名單** → no_change 但 outcome 填 unreachable 或 not_found，那不會把它標成已核對，過幾天換人再試。'
           || 'target.source_note 是這一列的匯入來歷，僅供參考——實測很多寫著「可能再次挑戰」卻被標成不參選，不要拿它當證據。',
         ARRAY['該縣市選舉委員會官網的登記公告', 'cna.com.tw 登記參選名單', 'ltn.com.tw', 'udn.com'],
         2, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
  LEFT JOIN regions r ON r.id = pe.region_id
  JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
  JOIN elections e ON e.id = pe.election_id
  WHERE pe.candidacy_status = 'withdrawn'
    AND s.registration_closed_on <= CURRENT_DATE
    -- 投票日過了就不必再問「他有沒有登記」，那時該問的是結果
    AND (e.election_date IS NULL OR e.election_date >= CURRENT_DATE)
    AND pe.verified IS NOT TRUE
    -- 退選前有沒有登記（#345 後續，2026-10-06）：看不出來的由 contribution_auto_tasks_withdrawn_filing 派（同一份名冊一起問）；
    -- 登記後退選的本來就在名冊上，再問「在不在名冊上」會把退選改回已登記；代理照名冊查過、交更正補上這一欄的，等於核對過名冊
    AND NOT (pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS NULL)
    AND pe.withdrawn_after_filing IS NOT TRUE
    AND NOT EXISTS (SELECT 1 FROM edit_history h
                     WHERE h.table_name = 'politician_elections' AND h.record_id = pe.id::TEXT
                       AND h.field = 'withdrawn_after_filing' AND h.reverted_at IS NULL)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_not_running IS '被標成不參選、但沒人對過官方登記名單的參選紀錄 → not_running_recheck 任務；no_change 且 outcome=confirmed 才把 verified 設 true。2026-10-06 起退選前有沒有登記看不出來的（withdrawn_after_filing 空的）改由 contribution_auto_tasks_withdrawn_filing 派；登記後退選的（true）、代理已照名冊交更正補上那一欄的不再問｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_owner_mismatch()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT g.politician_election_id AS id,
           jsonb_agg(jsonb_build_object('kind', g.signal, 'detail', g.detail) ORDER BY g.signal) AS signals,
           string_agg(g.detail, '；' ORDER BY g.signal) AS text
      FROM candidacy_owner_mismatch_signals() g
     GROUP BY g.politician_election_id
  )
  SELECT 'auto:candidacy_owner_mismatch:' || pe.id,
         'candidacy_owner_mismatch',
         jsonb_build_object(
           'politician_election_id', pe.id, 'politician_id', p.id, 'name', p.name, 'birth_year', p.birth_year, 'party', p.party,
           'election_id', pe.election_id, 'election_type', pe.election_type,
           'region', replace(COALESCE(r.region, p.region), '臺', '台'), 'district', r.sub_region, 'village', r.village,
           'signals', s.signals,
           -- 這個人名下其他參選紀錄（判斷是不是同一人要一起看）
           'other_records', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('politician_election_id', o.id, 'election_id', o.election_id, 'election_type', o.election_type,
                                                 'region', ro.region, 'district', ro.sub_region, 'village', ro.village, 'candidacy_status', o.candidacy_status)
                              ORDER BY o.election_id)
               FROM politician_elections o LEFT JOIN regions ro ON ro.id = o.region_id
              WHERE o.politician_id = p.id AND o.id <> pe.id), '[]'::jsonb),
           -- 資料庫裡同名的其他人（改掛的候選對象）
           'same_name', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('politician_id', q.id, 'name', q.name, 'birth_year', q.birth_year, 'party', q.party, 'region', q.region))
               FROM (SELECT q.* FROM politicians q
                      WHERE q.merged_into IS NULL AND q.id <> p.id AND cec_name_key(q.name) = cec_name_key(p.name)
                      ORDER BY q.birth_year NULLS LAST LIMIT 10) q), '[]'::jsonb),
           -- 中選會名冊上這一屆同選舉同名的人（已投票的屆別才有；出生年是分辨同名最有力的根據）
           'cec_same_name', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('region', cc.region, 'sub_region', cc.sub_region, 'village', cc.village,
                                                 'birth_year', cc.birth_year, 'elected', cc.elected) ORDER BY cc.region, cc.sub_region)
               FROM cec_candidates cc
              WHERE cc.election_id = pe.election_id AND cc.election_type = pe.election_type AND cc.name_norm = cec_name_key(p.name)), '[]'::jsonb)),
         p.name || '（' || COALESCE(replace(COALESCE(r.region, p.region), '臺', '台'), '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '')
           || '）這筆參選紀錄可能掛錯人：' || s.text || '。'
           || '請查中選會名冊（已投票的屆別看選舉資料庫的出生年；2026 看登記彙總表的推薦政黨與選舉區）與報導，判斷這筆是不是掛著的這個人。'
           || '**不是**：交 reassign_candidacy（from_politician_id 填 target.politician_id）——改掛到 target.same_name 裡的另一位（to_politician_id），或都不是就新建（new_politician：姓名、出生年、政黨）；'
           || 'evidence 寫出處上這一筆的出生年、推薦政黨或選舉區，reason 寫你憑什麼分辨。'
           || '掛錯的也可能是 target.other_records 裡的另一筆（換縣市那種兩筆都要看）：改掛時 politician_election_id 填真正掛錯的那一筆。'
           || '只是縣市或選區寫錯、人沒掛錯的，用 candidacy 重交同一人同一屆把地區改對，這一件回 no_change（outcome=confirmed）說明。'
           || '**是同一個人**（例如真的換了縣市參選）：交 no_change、outcome=confirmed，finding 寫你怎麼確認的——確認過的不會再派。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || p.name || ' ← 中選會歷屆參選（出生年、選區、政黨）',
               'https://web.cec.gov.tw/central/article/64709 ← 2026 候選人登記彙總表（選舉區、推薦政黨）',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || p.name || '","electionId":' || pe.election_id || '}'],
         1, replace(COALESCE(r.region, p.region), '臺', '台')
    FROM s
    JOIN politician_elections pe ON pe.id = s.id
    JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
    LEFT JOIN regions r ON r.id = pe.region_id
   WHERE NOT EXISTS (SELECT 1 FROM contributions c
                      WHERE c.contribution_type = 'reassign_candidacy' AND c.status IN ('pending', 'verified')
                        AND c.payload->>'politician_election_id' = pe.id::TEXT)
     -- 確認過是同一人的（no_change confirmed 通過）不再派
     AND NOT EXISTS (SELECT 1 FROM task_checks tc
                      WHERE tc.task_id = 'auto:candidacy_owner_mismatch:' || pe.id AND tc.outcome = 'confirmed')
$$;
COMMENT ON FUNCTION contribution_auto_tasks_owner_mismatch IS '參選紀錄疑似掛錯人（candidacy_owner_mismatch，2026-10-06）：訊號見 candidacy_owner_mismatch_signals；有人交改掛在等票的、確認過是同一人的不派｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_gap()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    -- candidate_status＝交件協議的詞（派工說明「照現況填」那一句用），由 candidacy_status 換算，不是舊欄位
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status,
           p.id AS politician_id, p.name, p.party AS person_party,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.party_basis IS NULL
  ),
  m AS (
    -- 中選會名單上同屆、同選舉別、同縣市、同名只有一位（同名多位不派，免得指錯人）；名冊的政黨寫法要對得到（對不到的看 party_alias_gaps）
    SELECT g.*, c.name AS cec_name, c.region AS cec_region, c.sub_region AS cec_sub_region, c.village AS cec_village,
           c.party AS cec_party, c.cand_no, c.elected, c.cec_cand_id, c.cec_theme_id,
           a.party_id AS cec_party_id, a.kind = 'independent' AS cec_independent, pt.name AS cec_party_name
      FROM g
      JOIN LATERAL (
        SELECT x.*, count(*) OVER () AS n
          FROM cec_candidates x
         WHERE x.election_id = g.election_id AND x.election_type = g.election_type
           AND replace(x.region, '臺', '台') = g.county AND x.name_norm = cec_name_key(g.name)
      ) c ON c.n = 1
      JOIN party_aliases a ON a.alias_key = party_alias_key(c.party)
      LEFT JOIN parties pt ON pt.id = a.party_id
  ),
  x AS (
    SELECT m.*,
           -- candidacy 的地區欄位：照中選會那一筆填（跟 roster_cec_gap 同一套；縣市議員沒帶選舉區交件會被退回）
           CASE
             WHEN m.election_type = '村里長'
               THEN jsonb_build_object('region', m.county, 'sub_region', m.cec_sub_region, 'village', m.cec_village)
             WHEN m.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
               THEN jsonb_build_object('region', m.county, 'sub_region', NULLIF(regexp_replace(COALESCE(m.cec_sub_region, ''), '(第[0-9]+)?選舉區$', ''), ''))
             WHEN m.election_type IN ('鄉鎮市長', '直轄市山地原住民區長')
               THEN jsonb_build_object('region', m.county, 'sub_region', m.cec_sub_region)
             WHEN m.election_type IN ('縣市議員', '立法委員')
               THEN jsonb_build_object('region', m.county, 'electoral_district', m.cec_sub_region)
             ELSE jsonb_build_object('region', m.county)
           END AS fill,
           CASE WHEN m.elected THEN 'elected' ELSE 'not_elected' END AS cec_result
      FROM m
     -- 已經有人交了這一人這一屆的 candidacy 還在等票的先不派（落庫時就會寫政黨；退件了就會再派）
     WHERE NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = m.politician_id::TEXT AND c.payload->>'election_id' = m.election_id::TEXT)
  )
  SELECT 'auto:candidacy_source_missing:party:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('kind', 'party', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'missing', jsonb_build_array('party'),
                            'person_party', x.person_party,
                            'fill', x.fill,
                            'cec', jsonb_build_object('name', x.cec_name, 'region', x.cec_region, 'sub_region', x.cec_sub_region, 'village', x.cec_village,
                                                      'party', x.cec_party, 'cand_no', x.cand_no, 'elected', x.elected, 'election_result', x.cec_result,
                                                      'cec_cand_id', x.cec_cand_id, 'cec_theme_id', x.cec_theme_id),
                            'cec_party', jsonb_build_object('text', x.cec_party, 'party_id', x.cec_party_id, 'party_name', x.cec_party_name,
                                                            'independent', x.cec_independent)),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '）這一次參選的政黨我們不知道——'
           || '網站只看得到他現在登記的政黨（「' || COALESCE(x.person_party, '空的') || '」），過去的參選要記當時的政黨，人會換黨。'
           || '中選會名冊上這一屆的他（' || COALESCE(x.cec_region || COALESCE(' ' || x.cec_sub_region, '') || COALESCE(' ' || x.cec_village, ''), '')
           || COALESCE('，號次 ' || x.cand_no, '') || '，' || CASE WHEN x.elected THEN '當選' ELSE '落選' END
           || '）推薦政黨記的是「' || x.cec_party || '」'
           || CASE WHEN x.cec_independent THEN '（無黨籍）' WHEN x.cec_party_name IS NOT NULL AND x.cec_party_name <> x.cec_party THEN '（＝' || x.cec_party_name || '）' ELSE '' END || '。'
           || '請打開中選會選舉資料庫核對是同一個人後，用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、name 填「' || x.name
           || '」、election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、地區照 target.fill 填'
           || '、party 照名冊填「' || x.cec_party || '」（不要填他現在的政黨）、candidate_status 照現況填「' || COALESCE(x.candidate_status, '') || '」'
           || '、election_result 照中選會填 ' || x.cec_result || '；source_urls 附你核對的中選會頁面。'
           || '系統會拿中選會的資料自動核對：我們只有一位同名、當選與否與推薦政黨都對得上就直接上線。'
           || '名冊上的不是同一個人（同名同姓）就不要交 candidacy，改用 no_change 回報、finding 寫「掛錯人」；查不到就用 no_change 說明你查了哪些網址。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name || ' ← 中選會歷屆參選（含推薦政黨、當選與否）',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || x.name || '","electionId":' || x.election_id || '}',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, x.county
    FROM x
$$;
COMMENT ON FUNCTION contribution_auto_tasks_party_gap IS '已投票屆別參選紀錄缺政黨（party_basis 空的）、中選會名冊（cec_candidates.party）同名唯一而且寫法對得到的，一筆一件；沿用 candidacy_source_missing（target.kind＝party），代理照名冊用 candidacy 重交（#346 第二階段，2026-10-06）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_roster()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    -- candidate_status＝交件協議的詞（派工說明「照現況填」那一句用），由 candidacy_status 換算，不是舊欄位
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status,
           p.id AS politician_id, p.name, p.party AS person_party,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county, r.sub_region
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id AND e.election_date >= CURRENT_DATE
      LEFT JOIN regions r ON r.id = pe.region_id
     -- 還沒投票的屆別、已登記（名冊上才有他）、我們不知道這一次的政黨
     WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'
  ),
  x AS (
    SELECT g.*,
           (SELECT array_agg(v.list_url ORDER BY v.sort, v.id) FROM verification_sources v
             WHERE v.kind = 'cec' AND v.status = 'ok' AND v.list_url IS NOT NULL AND 'roster' = ANY (v.provides)
               AND g.election_type = ANY (v.election_types) AND g.county = ANY (v.regions)) AS rosters
      FROM g
     -- 已經有人交了這一人這一屆的 candidacy 還在等票的先不派
     WHERE NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = g.politician_id::TEXT AND c.payload->>'election_id' = g.election_id::TEXT)
  )
  SELECT 'auto:candidacy_source_missing:party:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('kind', 'party_roster', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'missing', jsonb_build_array('party'), 'person_party', x.person_party,
                            'rosters', to_jsonb(x.rosters)),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，已登記）這一次參選的政黨我們不知道——'
           || '網站只看得到他現在登記的政黨（「' || COALESCE(x.person_party, '空的') || '」），參選紀錄要記的是這一次登記時的推薦政黨。'
           || '這一屆還沒投票，中選會選舉資料庫還沒有名單：請打開中選會候選人登記彙總表'
           || COALESCE('（' || array_to_string(x.rosters, '、') || '）', '（web.cec.gov.tw/central/article/64709）')
           || '找到他那一列，用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、name 填「' || x.name
           || '」、election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、region 填「' || COALESCE(x.county, '') || '」'
           || CASE WHEN x.election_type = '縣市議員' THEN '、electoral_district 填名冊上的選舉區' ELSE '' END
           || '、party 照那一列的「推薦之政黨」原字填（寫「無」就填「無」，不要填他現在的政黨）、candidate_status 照現況填「' || COALESCE(x.candidate_status, '') || '」；'
           || 'source_urls 第一個放那份登記彙總表：系統會逐位核對名冊上的姓名、縣市、政黨，吻合的一票就過。名冊上找不到他就用 no_change 回報，不要猜。',
         COALESCE(x.rosters, ARRAY[]::TEXT[]) || ARRAY['https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表'],
         1, x.county
    FROM x
$$;
COMMENT ON FUNCTION contribution_auto_tasks_party_roster IS '還沒投票的屆別、已登記而參選紀錄缺政黨（party_basis 空的）的，照中選會候選人登記彙總表補；沿用 candidacy_source_missing（target.kind＝party_roster，task_id 跟已投票那支同形狀，投完票由 contribution_auto_tasks_party_gap 接手）（2026-10-06）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

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
$$;
COMMENT ON FUNCTION contribution_auto_tasks_placeholder_politicians IS '姓名看起來是測試資料的人物（politician_name_is_placeholder），新任務型別 placeholder_politician，查無此人就交 removal（2026-10-06）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_elements()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH inflight AS (
    -- 已經有人交了、還在等票或自動重試中：先不派，免得兩個代理拆同一條；被退件就會回來
    SELECT DISTINCT c.payload->>'policy_id' AS policy_id
      FROM contributions c
     WHERE c.contribution_type = 'policy_elements' AND c.status IN ('pending', 'verified', 'apply_failed')
  ),
  cand AS (
    SELECT pl.id AS policy_id, pl.title, pl.status::TEXT AS status, pl.election_id, pl.source_url,
           p.id AS politician_id, p.name, p.party, COALESCE(r.region, p.region) AS region,
           x.election_type, e.election_date,
           -- 屆別年份從投票日取，不從 id 推（#344：之後新增的選舉 id 不保證是年份）
           EXTRACT(YEAR FROM e.election_date)::INTEGER AS election_year,
           office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, x.election_type) AS term_end,
           ARRAY(SELECT k FROM unnest(ARRAY['target', 'deadline', 'funding']) WITH ORDINALITY AS u(k, n)
                  WHERE NOT EXISTS (SELECT 1 FROM policy_elements pe WHERE pe.policy_id = pl.id AND pe.element = u.k)
                  ORDER BY u.n) AS missing
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      -- 這個人那一屆的參選紀錄（同一屆有兩筆時取當選的、在選的那一筆）
      JOIN LATERAL (
        SELECT q.election_type, q.candidacy_status, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.candidacy_status = 'elected') DESC NULLS LAST,
                  (q.candidacy_status IS DISTINCT FROM 'withdrawn') DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL
       AND (
         -- 還沒投票：在選的人（選前要能並排比較）
         (e.election_date >= CURRENT_DATE AND x.candidacy_status IS DISTINCT FROM 'withdrawn')
         -- 已投票：當選者、而且還沒達成也沒跳票（期限要接得上追蹤）
         OR (e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected' AND pl.status::TEXT NOT IN ('Achieved', 'Failed'))
       )
  )
  SELECT 'auto:policy_elements_missing:' || c.policy_id, 'policy_elements_missing',
         jsonb_build_object('policy_id', c.policy_id, 'policy_title', c.title, 'status', c.status, 'source_url', c.source_url,
                            'politician_id', c.politician_id, 'name', c.name, 'party', c.party, 'region', c.region,
                            'election_id', c.election_id, 'election_type', c.election_type, 'term_end', c.term_end,
                            'missing', to_jsonb(c.missing)),
         '「' || c.title || '」（' || c.name || '，' || c.election_year || ' ' || COALESCE(c.election_type, '') || '）還沒拆成政見三要素，還缺：'
           || array_to_string(ARRAY(SELECT CASE k WHEN 'target' THEN '數值目標' WHEN 'deadline' THEN '達成期限' ELSE '財源' END
                                      FROM unnest(c.missing) WITH ORDINALITY AS u(k, n) ORDER BY u.n), '、') || '。'
           || '請打開這條政見的**原文**（選舉公報、政見發表會、候選人官網或競選文宣的政見頁；政見上的 source_url 若只是轉述的新聞，先找到原文），'
           || '逐一看原文有沒有寫：數值目標（做到多少、做到什麼程度）、達成期限（什麼時候之前）、財源（錢從哪裡來）。'
           || '有寫的照原文寫進 text（120 字內，不補數字、不換算、不評價）；查過原文沒寫的 stated 填 false——那也是答案，畫面會顯示「未說明」。'
           || '每個要素都要附原句位置（source_locator），沒寫的也要寫你查的是原文哪一段。'
           || '期限換得成日期就填 deadline_date：會計年度是曆年，「2028 年前」填 2028-12-31，「任內」填這一任的卸任日 ' || COALESCE(c.term_end::TEXT, '（target.term_end）') || '。'
           || '用 policy_elements 型別交一筆；找不到原文就用 no_change 回報你查了哪裡，不要拿我們的政見摘要當原文。',
         ARRAY_REMOVE(ARRAY[
           CASE WHEN c.source_url IS NOT NULL THEN c.source_url || ' ← 這條政見現在掛的出處（先看它是不是原文）' END,
           CASE c.election_year
             WHEN 2022 THEN 'https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）地方選舉公報：點縣市 → 選舉別 → 選舉區 PDF，候選人登記的政見原文在上面'
             WHEN 2024 THEN 'https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86 ← 中選會 2024（113 年）第 11 屆立委選舉公報'
             ELSE '中選會選舉公報（投票前約兩週才出版；出版前看候選人官網、競選臉書的政見頁）'
           END,
           '政見發表會影片（各縣市選委會的 YouTube 頻道）',
           'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見）'
         ], NULL),
         1, c.region
    FROM cand c
   WHERE cardinality(c.missing) > 0
     AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.policy_id = c.policy_id::TEXT)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_policy_elements IS '政見還沒拆完三要素 → policy_elements_missing（還沒投票的屆別：在選者；已投票的屆別：當選者、未達成也未跳票）。已有人交了在等票的先不派（#364，2026-10-05）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_raw()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH c2026 AS (
    SELECT p.id, p.name, p.party, p.birth_year, p.current_position, p.avatar_url,
           COALESCE(r.region, p.region) AS region, pe.election_type, pe.source_note,
           -- candidate_status＝交件協議的詞（下面的任務說明與 target 用），由 candidacy_status 換算，不是舊欄位
           candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.election_id = 2026 AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
  ),
  ours AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn'
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:policy_missing:' || c.id, 'policy_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026, 'election_type', c.election_type),
         c.name || '（' || COALESCE(c.region, '') || ' 2026 ' || COALESCE(c.election_type, '') || '候選人）目前 0 筆政見。請找該候選人有出處的具體政見，最多 5 筆、每筆一個 policy 型別、各附自己的出處；找到幾筆交幾筆，只找到 1 筆就交 1 筆，不要為了湊數交口號、願景或個人表態。先看 current.queued_policies，別人交了還在等票的不要再交。2026 選舉政見優先；若只找得到現任任期或過去選舉的承諾也可提交，election_id 填該政見所屬的選舉（2022／2024／2026）並在 note 說明',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 1, c.region
  FROM c2026 c
  WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = c.id AND pl.removed_at IS NULL)
  UNION ALL
  SELECT 'auto:profile_gap:' || c.id, 'profile_gap',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026,
           'missing', ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN 'birth_year' END, CASE WHEN current_position_missing(c.current_position) THEN 'current_position' END, CASE WHEN c.avatar_url IS NULL THEN 'avatar_url' END], NULL)),
         c.name || '（' || COALESCE(c.region, '') || '）缺 ' || array_to_string(ARRAY_REMOVE(ARRAY[CASE WHEN c.birth_year IS NULL THEN '出生年' END, CASE WHEN current_position_missing(c.current_position) THEN '現職' END, CASE WHEN c.avatar_url IS NULL THEN '官方照片網址' END], NULL), '、') || '，請用 politician 型別補（只補查得到的）',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 回歷屆參選，含出生年與政黨',
               '所屬機關官網（現職、官方照片）', 'ly.gov.tw 立委個人頁'], 1, c.region
  FROM c2026 c
  WHERE c.birth_year IS NULL OR current_position_missing(c.current_position) OR c.avatar_url IS NULL
  UNION ALL
  SELECT 'auto:policy_validity:' || pl.id, 'policy_validity',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region),
         '「' || pl.title || '」（' || p.name || '）掛在政見底下，但我們沒有任何出處。'
           || '**先判斷它是不是政見**：政見是「當選後要做的具體事情」，看得出做什麼、給誰、做到什麼程度。'
           || '競選標語、團隊組成、行程、個人表態、選戰口號都不是政見（例如「母雞帶小雞」「溫暖創新的某某市」）。'
           || '不是政見就用 removal 型別回報（payload 帶 target_table: "policies"、target_id: 這筆政見的 id、reason ≥20 字寫清楚它是哪一類；需 3 票）；'
           || '是政見就找到原始出處，用 correction 型別補 policies.source_url。'
           || '兩邊都查不出來（找不到出處，也無法判定不是政見）就用 no_change 回報你查了什麼。',
         ARRAY['候選人官網政見頁', 'cna.com.tw', 'ltn.com.tw', 'udn.com'], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL AND (pl.source_url IS NULL OR pl.source_url = '')
  UNION ALL
  SELECT 'auto:progress_stale:' || pl.id, 'progress_stale',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'status', pl.status::TEXT, 'progress', pl.progress,
                            'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'election_id', pl.election_id, 'election_date', e.election_date),
         CASE WHEN pl.status::TEXT = 'Campaign Pledge' THEN
           '競選承諾「' || pl.title || '」（' || p.name || '）所屬的選舉已經在 ' || e.election_date::TEXT
             || ' 投票完畢，這筆卻還停在「競選承諾」。'
             || '**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，追不出進度也不該追——'
             || '那種用 removal 型別回報（需 3 票），不要為它補欄位。是政見才往下做：請先確認這個人有沒有當選：'
             || '當選就查這項承諾後來有沒有開始執行，用 policy_progress 型別把 status 改成 In Progress／Achieved／Stalled／Failed 並附上進度紀錄；'
             || '落選、或我們根本沒有他那場選舉的參選紀錄，就用 candidacy 型別補那場選舉的 election_result（附中選會網址）——補上之後這筆不會再派。'
             || '真的查不到後續，用 no_change 回報並說明你查了哪些來源。'
         ELSE
           '政見「' || pl.title || '」（' || p.name || '，' || pl.status::TEXT || '）超過 90 天沒有進度紀錄。'
             || '**第一步先判斷它是不是政見**：標語、行程、個人表態不是，那種用 removal 型別回報（需 3 票），不要補欄位。'
             || '是政見就請查施政報告、議會／立法院紀錄或新聞後用 policy_progress 型別回報。查證後確定近期真的沒有新進度，就用 no_change 回報——那也是成果，會讓這筆暫時不再派給別人'
         END,
         CASE WHEN pl.status::TEXT = 'Campaign Pledge'
              THEN ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 查這個人那一屆選上了沒有',
                         '政見本身的 source_url', 'cna.com.tw', '該機關官網施政報告']
              ELSE ARRAY['縣市政府施政報告（*.gov.tw）', 'ly.gov.tw 議事錄', '議會官網', 'cna.com.tw'] END,
         1, p.region
  FROM policies pl
  JOIN politicians p ON p.id = pl.politician_id
  LEFT JOIN elections e ON e.id = pl.election_id
  WHERE pl.removed_at IS NULL
    AND pl.status::TEXT NOT IN ('Achieved', 'Failed')
    AND pl.last_updated < CURRENT_DATE - INTERVAL '90 days'
    AND NOT EXISTS (SELECT 1 FROM tracking_logs tl WHERE tl.policy_id = pl.id AND tl.date >= CURRENT_DATE - INTERVAL '90 days')
    -- 競選承諾要等那場選舉投票完，才問得出「兌現了嗎」。2026 投票日是 11-28，
    -- 現在問它「90 天沒有進度」，代理只能回 no_change。屆別空著的也一樣問不出來，
    -- 那些先由 policy_election_missing 把屆別補上，補完就會自己流回這裡。
    AND (pl.status::TEXT <> 'Campaign Pledge'
         OR (e.election_date IS NOT NULL AND e.election_date < CURRENT_DATE))
    -- 落選／退選的人的承諾永遠不會有進度，不要每 14 天再派一次
    AND NOT EXISTS (
      SELECT 1 FROM politician_elections pe
      WHERE pe.politician_id = pl.politician_id
        AND pe.election_id = pl.election_id
        AND pe.candidacy_status IN ('not_elected', 'withdrawn')
    )
  UNION ALL
  SELECT 'auto:candidacy_source_missing:' || c.id, 'candidacy_source_missing',
         jsonb_build_object('politician_id', c.id, 'name', c.name, 'party', c.party, 'region', c.region, 'election_id', 2026, 'election_type', c.election_type, 'candidate_status', c.candidate_status),
         c.name || '（' || COALESCE(c.region, '') || ' 2026 ' || COALESCE(c.election_type, '') || '，' || c.candidate_status || '）的參選紀錄沒有可查證的網址，請用 candidacy 型別附上中選會或媒體來源重送',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名"} ← 已投票的屆別查得到；2026 尚未公告',
               '該縣市選舉委員會官網（2026 登記名單）', 'cna.com.tw 登記參選名單'], 1, c.region
  FROM c2026 c
  WHERE c.source_note IS NULL OR c.source_note !~ 'https?://'
  UNION ALL
  SELECT 'auto:roster_check:' || s.election_id || ':' || l.name || ':' || s.election_type,
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', l.name, 'election_type', s.election_type,
                            'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked,
                            'last_failed_attempt', rc.last_attempt_without_count,
                            'list_announced_on', s.list_announced_on,
                            'official_list_published', CURRENT_DATE >= s.list_announced_on),
         l.name || ' ' || s.election_id || ' ' || s.election_type
           || ' 的名單需要清查。把該縣市這個選舉的參選人名單全部列出來，跟我們現有的比對；我們目前有 '
           || COALESCE(o.n, 0) || ' 筆。名單上有、我們沒有的，每一位用 candidacy 型別補一筆。'
           -- 名單分兩個階段，講清楚現在該補哪一種，否則兩個階段的資料會混在一起
           || CASE WHEN CURRENT_DATE >= s.list_announced_on THEN
                '【現在是審定名單階段】官方候選人名單已於 ' || s.list_announced_on::TEXT
                  || ' 公告，請以公告名單為準：candidacy 的 candidate_status 填 qualified（名單上的人；confirmed 只表示表態參選），查得到號次就一起附上。'
              ELSE
                '【現在是登記階段】登記已於 2026-09-04 截止，但官方候選人名單要到 ' || s.list_announced_on::TEXT
                  || ' 才公告（直轄市長是 11-12），資格審查 10-16 前完成、10-23 抽號次。'
                  || '所以現在補的是「已登記」而不是「已審定」：candidacy 的 candidate_status 填 registered，不要填 confirmed，也還沒有號次可填。'
                  || '另外，登記已經截止，所以我們資料裡還標著 rumored（傳聞參選）或 likely（可能參選）的人，只要不在登記名單上就是沒登記：請用 correction 把他那筆的 candidate_status 改成 not_running。'
              END
           || '最後用 roster_check 型別回報這次清查（名單上共幾人、我們幾人、你補了幾筆），那筆回報會把這個縣市標記為已清查。'
           -- 前一位代理查不到時，明講不要再去 db.cec.gov.tw：那是舊版把它排在第一個
           -- 造成的，43 個縣市一次都沒清查成功過，不寫清楚下一位會重蹈同一條死路。
           || CASE WHEN rc.last_attempt_without_count IS NOT NULL
                   THEN '注意：前一位代理回報查不到官方名單（見 target.last_failed_attempt）。'
                        || '請不要再去 db.cec.gov.tw 找——那是選舉結果資料庫，它自己標明「投票後 7 日內更新」，'
                        || '2026 的資料要等 12 月才會進去。改從該縣市選舉委員會官網的登記公告、或媒體的登記名單彙整下手。'
                   ELSE '' END
           || '查不到名單就不要猜：用 roster_check 回報並把 cec_count 留空，在 note 說明你查了哪些網址——那筆不會把縣市標記為已清查，只會讓它隔天再派。',
         CASE WHEN CURRENT_DATE >= s.list_announced_on
              THEN ARRAY['該縣市選舉委員會官網的候選人名單公告', 'bulletin.cec.gov.tw 選舉公報', 'web.cec.gov.tw 中選會公告', 'cna.com.tw 候選人名單彙整']
              ELSE ARRAY['該縣市選舉委員會官網的登記公告', 'web.cec.gov.tw 中選會新聞稿', 'cna.com.tw 登記參選名單彙整', 'ltn.com.tw／udn.com 登記名單'] END,
         2, l.name
  FROM roster_check_scope s
  CROSS JOIN locations l
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.election_type = s.election_type AND o.region = l.name
  LEFT JOIN LATERAL (
    -- 兩個時鐘：真的清查完的（cec_count 有值）壓 recheck_days；
    -- 只是試過沒找到的壓 roster_attempt_cooldown_days
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type
  ) rc ON TRUE
  WHERE s.enabled
    AND (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
  UNION ALL
  SELECT 'auto:policy_election_missing:' || pl.id, 'policy_election_missing',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region,
                            'status', pl.status::TEXT, 'proposed_date', pl.proposed_date, 'source_url', pl.source_url),
         '政見「' || pl.title || '」（' || p.name || '）沒有標所屬屆別，網站上顯示成「未標註屆別」。'
           || '**第一步先判斷它是不是政見**：標語、團隊組成、行程、個人表態不是政見，那種用 removal 型別回報（需 3 票），不要補屆別。'
           || '是政見就請打開它的來源網址，確認這是哪一場選舉的承諾（或哪一個任期內的施政），'
           || '再用 correction 型別把 policies.election_id 改成該選舉的年份（2022／2024／2026）。'
           || '判斷依據是來源本身：競選承諾看那場選舉的年份，施政進度看講話當下的任期。'
           || '來源沒寫清楚、或那個人同時參選過多屆分不出來，就不要猜——用 no_change 回報並說明你查了什麼。',
         ARRAY['政見本身的 source_url', 'cec.gov.tw 選舉公報', '候選人官網政見頁', 'cna.com.tw'], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL AND pl.election_id IS NULL
  UNION ALL
  -- 登記截止之後還標著「傳聞參選」「可能參選」的，一定有結論：不是在登記名單上，就是沒登記。
  -- 這條規則原本只寫在 roster_check 的敘述裡，而名單清查一直清不動（全國性結構化名單要等 11-17
  -- 公告才有），所以 63 筆就這樣掛著。2026-09-17：「傳聞的參選人在名單出來之後，
  -- 他就應該要被確認下來」——拆成一筆一個任務，各自派出去。
  SELECT 'auto:candidate_status_stale:' || pe.id, 'candidate_status_stale',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'election_id', pe.election_id,
                            'election_type', pe.election_type, 'candidate_status', CASE WHEN pe.candidacy_status = 'considering' THEN 'likely' ELSE 'rumored' END,
                             'region', COALESCE(r.region, p.region), 'registration_closed_on', s.registration_closed_on),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '還標著「' || CASE WHEN pe.candidacy_status = 'considering' THEN '可能參選' ELSE '傳聞參選' END || '」，'
           || '但登記已經在 ' || s.registration_closed_on::TEXT || ' 截止，這時候只有兩種可能：'
           || '**在登記名單上** → 用 correction 把 politician_elections.candidate_status 改成 registered（附登記名單網址）；'
           || '**不在名單上** → 改成 not_running（一樣附你查的那份名單，說明找過了沒有他）。'
           || '兩者都要附得出那份名單；查不到該縣市的登記名單就用 no_change 回報，不要用猜的把人留在「傳聞」。',
         ARRAY['該縣市選舉委員會官網的登記公告', 'cna.com.tw 登記參選名單', 'ltn.com.tw', 'udn.com'], 1, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  LEFT JOIN regions r ON r.id = pe.region_id
  JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
  WHERE (pe.candidacy_status IS NULL OR pe.candidacy_status = 'considering')
    AND s.registration_closed_on <= CURRENT_DATE
  UNION ALL
  SELECT 'auto:election_result_missing:' || pe.id, 'election_result_missing',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'party', p.party,
                            'region', COALESCE(r.region, p.region), 'election_id', pe.election_id,
                            'election_type', pe.election_type, 'election_date', e.election_date),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '名下有政見，但我們沒有他那場選舉的結果——那場選舉 ' || e.election_date::TEXT || ' 就投票完了。'
           || '請到中選會查這個選區的結果，用 candidacy 型別補 election_result（elected 或 not_elected；得票數、得票率不收，不用查）。'
           || '這筆補上之後他名下的競選承諾才追得動：當選才要查兌現，落選就不再派任務。'
           || '查不到官方結果就不要猜，用 no_change 回報並說明你查了哪些網址。',
         ARRAY['POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 直接回中選會的當選與否、得票數、得票率',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會原始 API，回歷屆參選',
               'cna.com.tw'], 1, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  JOIN elections e ON e.id = pe.election_id
  LEFT JOIN regions r ON r.id = pe.region_id
  WHERE COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')
    AND e.election_date < CURRENT_DATE
    -- 只問名下有政見的人。已投票屆別、結果空白的參選紀錄有 14,289 筆，全倒進任務池
    -- 會把其他缺口整個擠掉；而這個缺口的用途是解鎖承諾追蹤，沒政見的人解鎖了也沒用。
    -- 這個條件把 14,289 收斂成 54。
    AND EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = pe.politician_id AND pl.removed_at IS NULL)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_raw IS '#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    -- candidate_status＝交件協議的詞（下面的任務說明與 target 用），由 candidacy_status 換算，不是舊欄位
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status, pe.position,
           p.id AS politician_id, p.name, p.party,
           COALESCE(r.region, p.region) AS county,
           NULLIF(concat_ws(' ', r.sub_region, r.village), '') AS attached_below_county,
           pe.region_id IS NULL AS no_region,
           pe.election_type IN ('縣市議員', '立法委員')
             AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
             AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region) AS no_district,
           -- 掛錯層級：不是縣市層級、也不是這種選舉的選區（立委的「全國」那一列算縣市層級，缺的是選區）
           pe.region_id IS NOT NULL
             AND (r.village IS NOT NULL
                  OR (r.sub_region IS NOT NULL AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region))) AS wrong_level
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_type IN ('縣市長', '縣市議員', '立法委員')
  ),
  gaps AS (
    SELECT g.*,
           -- 縣市長掛錯層級＝縣市待確認；議員、立委掛錯層級本來就算缺選區
           g.no_region OR (g.wrong_level AND g.election_type = '縣市長') AS need_region,
           CASE g.candidate_status
             WHEN 'not_running' THEN '表態不參選' WHEN 'registered' THEN '已登記' WHEN 'confirmed' THEN '表態參選'
             WHEN 'qualified' THEN '審定合格' ELSE g.candidate_status END AS status_label,
           CASE WHEN g.election_type = '立法委員'
                THEN '「第NN選區」（區域立委）；不分區或原住民立委 region 填「全國」、electoral_district 填「不分區」「平地原住民」或「山地原住民」'
                ELSE '「第NN選舉區」（例：第04選舉區）' END AS district_how
      FROM g
     WHERE g.no_region OR g.no_district OR g.wrong_level
  )
  SELECT 'auto:candidacy_source_missing:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'person_party', x.party, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'politician_election_id', x.pe_id,
                            'missing', to_jsonb(array_remove(ARRAY[CASE WHEN x.need_region THEN 'region' END,
                                                                   CASE WHEN x.no_district THEN 'electoral_district' END], NULL)),
                            'attached_to', CASE WHEN x.wrong_level THEN x.county || ' ' || x.attached_below_county END,
                            'submitted_region', sub.submitted_region,
                            'cec_listed_as', cec.listed_as, 'cec_party', cec.party),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，' || x.status_label || '）的參選紀錄'
           || CASE WHEN x.no_region AND x.no_district THEN '沒有縣市也沒有選區'
                   WHEN x.no_region THEN '沒有縣市'
                   WHEN x.wrong_level
                   THEN '掛在「' || x.county || ' ' || x.attached_below_county || '」——'
                        || CASE WHEN x.election_type = '縣市長' THEN '縣市長的參選紀錄只該記到縣市' ELSE '那不是' || x.election_type || '的選區' END
                        || '（多半是同一個人其他選舉的地區，例如里長那一筆的村里、立委那一筆的選區）'
                   ELSE '只記到縣市、沒有選區' END
           || '，網站的' || CASE WHEN x.no_region THEN '縣市篩選撈不到他'
                                WHEN x.wrong_level AND x.election_type = '縣市長' THEN '參選地區顯示錯了'
                                WHEN x.wrong_level THEN '選區分組把他放錯地方'
                                ELSE '選區篩選撈不到他' END || '。'
           || CASE WHEN sub.submitted_region IS NOT NULL
                   THEN '【先確認是不是同一個人】建立這筆紀錄的交件寫的縣市是「' || sub.submitted_region || '」，現在卻記在「' || COALESCE(x.county, '（空的）')
                        || '」——多半是同名的另一個人被對到這位人物名下。請用登記名冊與出生年、經歷核對：是同一個人就照名冊填 region 與選區重交；'
                        || '不是同一個人就不要交 candidacy（會把別人的參選掛在他名下），改用 no_change 回報，finding 寫「掛錯人：名冊上的是' || sub.submitted_region || '的同名者」。'
                   ELSE '' END
           || CASE WHEN x.candidate_status = 'not_running'
                   THEN '這筆是「表態不參選」的紀錄，要補的是他當初被傳要選、後來表態不選的那個縣市'
                        || COALESCE('（職位欄現在寫「' || x.position || '」，可以當線索，但要附出處）', '') || '。'
                   ELSE '' END
           || '請查證後用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、region 填縣市（用「台」不用「臺」）'
           || CASE WHEN x.no_district THEN '、electoral_district 填' || x.district_how ELSE '' END
           || '，candidate_status 照現況填「' || x.candidate_status || '」（狀態本身有錯是另一件事，不要在這筆改），其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party）；'
           || CASE WHEN cec.party IS NOT NULL THEN '中選會名單上他那一屆的推薦政黨是「' || cec.party || '」。' ELSE '' END
           || 'source_urls 附看得出' || CASE WHEN x.no_district THEN '選區' ELSE '縣市' END || '的出處。'
           || CASE WHEN cec.listed_as IS NOT NULL
                   THEN '中選會選舉資料庫的名單上記的是「' || cec.listed_as || '」：請打開 db.cec.gov.tw 核對是同一個人後照填，source_urls 附你核對的那一頁。'
                   WHEN x.election_id = 2026 AND x.candidate_status <> 'not_running'
                   THEN '2026 的縣市與選區在中選會候選人登記彙總表（web.cec.gov.tw/central/article/64709，各級選舉的 PDF 逐列寫著選區）；'
                        || '已登記的要附中選會名冊或登記截止後的報導，不然交件會被擋；附名冊網址的，系統會逐位核對、吻合的一票就過。'
                   WHEN x.candidate_status = 'not_running'
                   THEN '不參選的出處通常是當事人表態或政黨提名的新聞報導。'
                   ELSE '' END
           || '查不到可信出處就用 no_change 回報你查了哪些網址，不要猜。',
         CASE WHEN x.candidate_status = 'not_running'
              THEN ARRAY['cna.com.tw', 'udn.com', 'ltn.com.tw', '政黨官網的提名公告']
              WHEN x.election_id = 2026
              THEN ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表（逐列有選區）',
                         COALESCE(x.county, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com']
              ELSE ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，回選舉區',
                         'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份}', 'cna.com.tw'] END,
         1, x.county
    FROM gaps x
    -- 中選會名單（已投票的屆別才有）上全國同名同選舉別只有一位時，把他的縣市＋選區當線索附上；同名多位就不給，免得指錯人
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) = 1 THEN min(c.region || COALESCE(' ' || c.sub_region, '')) END AS listed_as,
             CASE WHEN count(*) = 1 THEN min(c.party) END AS party
        FROM cec_candidates c
       WHERE c.election_id = x.election_id AND c.election_type = x.election_type AND c.name_norm = cec_name_key(x.name)
    ) cec ON true
    -- 建立這筆參選紀錄的交件寫的縣市（只看建立那一次；edit_history 有 (table_name, record_id) 索引，缺口只有幾百筆）。
    -- 跟現在記的縣市一樣、交件沒寫縣市、是全國、或現在根本沒有縣市（那是「補縣市」，不是對錯人）就不提
    LEFT JOIN LATERAL (
      SELECT s.submitted_region
        FROM (SELECT translate(c.payload->>'region', '臺', '台') AS submitted_region
                FROM edit_history eh
                JOIN contributions c ON c.id = eh.contribution_id
               WHERE eh.table_name = 'politician_elections' AND eh.record_id = x.pe_id::TEXT AND eh.field = '*'
               ORDER BY eh.applied_at
               LIMIT 1) s
       WHERE x.county IS NOT NULL
         AND s.submitted_region IS NOT NULL AND s.submitted_region <> '全國'
         AND s.submitted_region <> translate(x.county, '臺', '台')
    ) sub ON true
$$;
COMMENT ON FUNCTION contribution_auto_tasks_region_gap IS '縣市長／縣市議員／立委：參選紀錄缺縣市（region_id 空）、缺選區（議員、立委只到縣市層級）、或掛錯層級（村里、鄉鎮、別種選舉的選區），沿用 candidacy_source_missing 型別；建立時交件的縣市跟現在不同會在說明裡講出來（2026-10-05）；2026-10-06 起其餘欄位照那一屆的名冊填、不叫代理照抄現在的政黨（target.person_party 只供對照、cec_party 是那一屆的推薦政黨）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_township_gap()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:candidacy_source_missing:' || pe.id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'person_party', p.party, 'region', p.region,
                            'election_id', pe.election_id, 'election_type', pe.election_type, 'candidate_status', candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE))),
         CASE WHEN pe.election_type = '村里長' THEN
           p.name || '（' || COALESCE(p.region, '') || ' ' || pe.election_id || ' 村里長候選人）的參選紀錄少了鄉鎮市區與村里，網站沒辦法把他放進正確的村里頁。'
             || '請查這個人的登記資料，確認他參選的鄉鎮市區與村里，用 candidacy 型別重交同一人同一屆：region 填「' || COALESCE(p.region, '')
             || '」、sub_region 填鄉鎮市區、village 填村里名，candidate_status 照現況，其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party），'
             || 'source_urls 附名冊或登記公告網址（中選會名冊系統會逐位核對、吻合的一票就過）。'
         ELSE
           p.name || '（' || COALESCE(p.region, '') || ' ' || pe.election_id || ' ' || pe.election_type || '候選人）的參選紀錄少了鄉鎮市區，網站沒辦法把他放進正確的鄉鎮頁。'
             || '請查這個人的登記資料，確認他參選的鄉鎮市區，用 candidacy 型別重交同一人同一屆：region 填「' || COALESCE(p.region, '')
             || '」、sub_region 填鄉鎮市區，candidate_status 照現況，其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party），source_urls 附名冊或登記公告網址（中選會名冊系統會逐位核對、吻合的一票就過）。'
         END,
         ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表', COALESCE(p.region, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'],
         1, p.region
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  WHERE pe.election_id = 2026
    AND pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
    AND pe.region_id IS NULL
    AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
    AND p.merged_into IS NULL
$$;
COMMENT ON FUNCTION contribution_auto_tasks_township_gap IS '2026 鄉鎮層級五種選舉的參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing；2026-10-06 起其餘欄位照那一屆的名冊填、不叫代理照抄現在的政黨｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_term_policies()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH pb AS (SELECT * FROM politician_bulletins),
  elected AS (
    -- 原本的對象：當選人，公報推不推得出來都派
    SELECT DISTINCT ON (pe.politician_id, pe.election_id)
           pe.politician_id, pe.election_id, pe.election_type, 'elected'::TEXT AS result,
           COALESCE(r.region, p.region) AS region, 0 AS pri
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE p.merged_into IS NULL
       AND pe.candidacy_status = 'elected'
       AND ((pe.election_id = 2022 AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長'))
            OR (pe.election_id = 2024 AND pe.election_type = '立法委員'))
     ORDER BY pe.politician_id, pe.election_id, pe.election_type
  ),
  from_bulletin AS (
    -- 推得出公報的參選人：結果以我們的紀錄為準，沒有就照中選會名單
    SELECT DISTINCT ON (b.politician_id, b.election_id)
           b.politician_id, b.election_id, b.election_type,
           COALESCE(b.election_result, CASE WHEN b.elected THEN 'elected' WHEN b.elected = false THEN 'not_elected' END) AS result,
           b.region, 1 AS pri
      FROM pb b
     ORDER BY b.politician_id, b.election_id, (b.election_type = '村里長'), b.election_type
  ),
  i0 AS (
    SELECT DISTINCT ON (u.politician_id, u.election_id) u.*
      FROM (SELECT * FROM elected UNION ALL SELECT * FROM from_bulletin) u
     ORDER BY u.politician_id, u.election_id, u.pri
  ),
  i AS (
    SELECT 'auto:term_policy_missing:' || i0.politician_id || ':' || i0.election_id AS tid,
           i0.politician_id, i0.election_id, i0.election_type, i0.result, i0.region,
           p.name, p.party, b.urls, b.cand_no, COALESCE(b.elected, i0.result = 'elected') AS is_elected,
           concat_ws(' ', b.region, NULLIF(b.sub_region, ''), NULLIF(b.village, '')) AS unit
      FROM i0
      JOIN politicians p ON p.id = i0.politician_id
      LEFT JOIN pb b ON b.politician_id = i0.politician_id AND b.election_id = i0.election_id AND b.election_type = i0.election_type
     WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i0.politician_id AND pl.election_id = i0.election_id AND pl.removed_at IS NULL)
       -- 去重：零政見的 2026 候選人留給 policy_missing（跟 raw 臂 c2026 同條件）
       AND (NOT EXISTS (SELECT 1 FROM politician_elections c WHERE c.politician_id = i0.politician_id AND c.election_id = 2026 AND c.candidacy_status IS DISTINCT FROM 'withdrawn')
            OR EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i0.politician_id AND pl.removed_at IS NULL))
  ),
  village AS (
    -- 村里長限量：已經開出去的照舊，空位依「當選人先、再依地區」遞補
    SELECT v.* FROM (
      SELECT w.*, count(*) FILTER (WHERE w.live) OVER () AS live_n,
             row_number() OVER (PARTITION BY w.live ORDER BY w.is_elected DESC, w.unit, w.cand_no, w.politician_id) AS rn
        FROM (SELECT i.*, EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_id = i.tid) AS live
                FROM i WHERE i.election_type = '村里長') w
    ) v
     WHERE v.live OR v.rn <= GREATEST(term_policy_village_cap() - v.live_n, 0)
  ),
  picked AS (
    SELECT tid, politician_id, election_id, election_type, result, region, name, party, urls, cand_no, is_elected, unit FROM i WHERE election_type <> '村里長'
    UNION ALL
    SELECT tid, politician_id, election_id, election_type, result, region, name, party, urls, cand_no, is_elected, unit FROM village
  )
  SELECT x.tid, 'term_policy_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'party', x.party, 'region', x.region,
                            'election_id', x.election_id, 'election_type', x.election_type, 'election_result', x.result)
           || CASE WHEN x.urls IS NOT NULL
                   THEN jsonb_build_object('bulletin_urls', to_jsonb(x.urls), 'cand_no', x.cand_no, 'bulletin_unit', x.unit)
                   ELSE '{}'::JSONB END,
         x.name || '（' || COALESCE(x.region, '') || ' ' || x.election_id || ' ' || x.election_type
           || CASE x.result WHEN 'elected' THEN '當選' WHEN 'not_elected' THEN '參選，未當選' ELSE '參選' END || '）'
           || '沒有任何 ' || x.election_id || ' 這一屆的政見。'
           || CASE WHEN x.urls IS NOT NULL THEN
                '**這一屆的中選會選舉公報已經找到了**：' || x.urls[1]
                || CASE WHEN cardinality(x.urls) > 1 THEN '（共 ' || cardinality(x.urls) || ' 份，見 target.bulletin_urls；正反面或分份，他在其中一份上）' ELSE '' END
                || '，他在公報上是**號次 ' || COALESCE(x.cand_no::TEXT, '？') || '**（' || x.unit || '）。'
                || '請打開公報，依姓名與號次找到他自己那一欄——公報常是圖片版，要裁切放大核對，不要看成隔壁候選人的——'
                || '把那一欄的政見**逐條**交成 policy：每條一筆、election_id 填 ' || x.election_id || '、status 填 Campaign Pledge、'
                || 'source_urls 放這份公報網址、note 寫「公報第幾頁、號次 ' || COALESCE(x.cand_no::TEXT, '？') || '、第幾點」。'
                || '公報上列幾條就交幾條，一次交完（第一筆上線後這個任務就會關）；只有口號、標語或「為民服務」這種沒有具體內容的不交。'
                || '那一欄真的是空白或只有口號，回 no_change＋outcome=not_found，checked_urls 附這份公報與你另外查過的頁面，finding 寫公報那一欄寫了什麼。'
              ELSE
                '請找他**那一屆的競選政見**：最多 5 筆、每筆一個 policy 型別、各附自己的出處；'
                || 'election_id 填 ' || x.election_id || '，status 填 Campaign Pledge（競選承諾，之後會有任務追「兌現了沒」）。'
                || '**首選中選會選舉公報**——每位候選人登記的政見原文都印在公報上（見 hint_sources 的入口，依縣市、選舉別、選舉區找 PDF）；'
                || '其次本人官網／臉書的競選政見頁、當年的新聞。'
                || '找到幾筆交幾筆，不要為了湊數交標語、口號、願景或個人表態——那些不是政見。'
              END
           || '先看 current.queued_policies 與既有政見，別人交了還在等票的不要再交；任內才宣布的施政、2026 的新政見不是這一屆的競選政見。',
         CASE WHEN x.urls IS NOT NULL THEN
           ARRAY(SELECT u || ' ← 中選會 ' || x.election_id || ' 選舉公報（號次 ' || COALESCE(x.cand_no::TEXT, '？') || '，' || x.unit || '）' FROM unnest(x.urls) AS u)
           || ARRAY['候選人當年的官網／臉書競選政見頁', 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）']
         WHEN x.election_id = 2022 THEN
           ARRAY['https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）地方選舉公報：點縣市 → 市長／縣長、議員、鄉鎮市長 → 選舉區 PDF，候選人登記的政見原文在上面',
                 '候選人當年的官網／臉書競選政見頁',
                 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）',
                 'cna.com.tw']
         ELSE
           ARRAY['https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86 ← 中選會 2024（113 年）第 11 屆立委選舉公報：區域／平地原住民／山地原住民各一個資料夾，依選舉區找 PDF（不分區的公報只有政黨政見）',
                 '候選人當年的官網／臉書競選政見頁',
                 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）',
                 'cna.com.tw']
         END,
         1, x.region
    FROM picked x
$$;
COMMENT ON FUNCTION contribution_auto_tasks_term_policies IS '補該屆政見（term_policy_missing）：當選人（2022 縣市長／縣市議員／鄉鎮市長、2024 立委）沒有那一屆的政見，或推得出選舉公報的參選人（含落選、村里長、代表、原住民區長／區民代表；村里長一次最多 term_policy_village_cap() 件）沒有那一屆的政見；推得出公報就把公報網址與號次放進 target。零政見的 2026 候選人留給 policy_missing。2026-10-02 起、10-06 擴充｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_withdrawn_filing()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH w AS (
    -- candidate_status＝交件協議的詞，由 candidacy_status 換算，不是舊欄位（這一支只看退選的，一律 not_running）
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status, pe.source_note,
           p.id AS politician_id, p.name, replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           e.election_date, e.election_date < CURRENT_DATE AS voted
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS NULL
  ),
  -- 已經有人交了這一欄的更正、還在等票的先不派（同一列交一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT c.payload->>'target_id' AS target_id
      FROM contributions c
     WHERE c.contribution_type = 'correction' AND c.status IN ('pending', 'verified')
       AND c.payload->>'target_table' = 'politician_elections'
       AND (c.payload->>'field' = 'withdrawn_after_filing' OR c.payload->'changes' @> '[{"field":"withdrawn_after_filing"}]'::jsonb)
  ),
  x AS (
    SELECT w.*,
           COALESCE(
             (SELECT array_agg(v.list_url ORDER BY v.sort, v.id) FROM verification_sources v
               WHERE v.kind = 'cec' AND v.status = 'ok' AND v.list_url IS NOT NULL AND 'roster' = ANY (v.provides)
                 AND w.election_type = ANY (v.election_types) AND w.county = ANY (v.regions)),
             (SELECT array_agg(v.list_url ORDER BY v.sort, v.id) FROM verification_sources v
               WHERE v.kind = 'cec' AND v.status = 'ok' AND v.list_url IS NOT NULL AND 'roster' = ANY (v.provides)
                 AND w.election_type = ANY (v.election_types))
           ) AS rosters,
           (SELECT jsonb_build_object('checked_at', c.applied_at, 'checked_urls', c.payload->'checked_urls')
              FROM contributions c
             WHERE c.task_id = 'auto:not_running_recheck:' || w.pe_id AND c.contribution_type = 'no_change'
               AND c.status = 'applied' AND c.payload->>'outcome' = 'confirmed'
             ORDER BY c.applied_at DESC NULLS LAST LIMIT 1) AS prior_check
      FROM w
     WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.target_id = w.pe_id::TEXT)
  )
  SELECT 'auto:not_running_recheck:filing:' || x.pe_id,
         'not_running_recheck',
         jsonb_build_object('kind', 'withdrawn_filing', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'election_date', x.election_date,
                            'candidate_status', x.candidate_status, 'source_note', x.source_note,
                            'rosters', to_jsonb(x.rosters),
                            'cec_listed_as', cec.listed_as,
                            'prior_not_on_roster', x.prior_check),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '）標成「不參選」，'
           || '但看不出他退選之前有沒有登記過，網站只能寫「不參選」——「登記後退選」跟「從沒登記、只是表態不選」對當事人是兩件很不一樣的事。'
           || '請查證後用 correction 補上：target_table 填 politician_elections、target_id 填 ' || x.pe_id
           || '，changes 改 withdrawn_after_filing，reason 要寫出他的姓名「' || x.name || '」與你核對的名冊。'
           || '**不在登記名冊上（從沒登記過）** → 改成 false，網站會寫「表態不參選」；'
           || '**在登記名冊上、後來宣布退選** → 改成 true，網站會寫「登記後退選」，再附一篇退選的報導；'
           || '**在登記名冊上、而且還在選** → 這一列標錯了，不要改這一欄，改用 correction 把 candidate_status 改成 registered（附名冊）。'
           || CASE WHEN x.voted
                   THEN '這一屆已經投票：' || CASE WHEN cec.listed_as IS NOT NULL
                                                 THEN '中選會選舉資料庫的名單上有同名的「' || cec.listed_as || '」——先確認是同一個人；在選票上就是登記過。'
                                                 ELSE '中選會選舉資料庫的名單上沒有同屆、同選舉別、同縣市、同名的人（打開 db.cec.gov.tw 再確認一次）。' END
                   WHEN x.rosters IS NOT NULL
                   THEN '中選會這一屆的候選人登記彙總表（逐列寫著選舉區、登記日期、姓名、推薦之政黨）：' || array_to_string(x.rosters, '、') || '。'
                   ELSE '登記名冊在中選會 web.cec.gov.tw/central/article/64709（各級選舉的候選人登記彙總表 PDF）。' END
           || CASE WHEN x.prior_check IS NOT NULL
                   THEN '之前不參選重查的代理（' || to_char((x.prior_check->>'checked_at')::timestamptz AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD')
                        || '）回報過他「確實不在登記名單上」（target.prior_not_on_roster），可以先打開那份名單核對。'
                   ELSE '' END
           || '找不到名冊就用 no_change（outcome 填 unreachable 或 not_found）回報你查了哪些網址，不要猜。',
         CASE WHEN x.voted
              THEN ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name || ' ← 中選會歷屆參選（在選票上＝登記過）',
                         'POST /functions/v1/fetch-cec-data {"queryName":"' || x.name || '","electionId":' || x.election_id || '}']
              ELSE COALESCE(x.rosters, ARRAY[]::TEXT[])
                   || ARRAY['https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表',
                            COALESCE(x.county, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'] END,
         2, x.county
    FROM x
    -- 已投票的屆別：中選會名單上同屆、同選舉別、同縣市、同名只有一位時當線索（同名多位不給，免得指錯人）
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) = 1 THEN min(c.region || COALESCE(' ' || c.sub_region, '') || COALESCE(' ' || c.village, '')) END AS listed_as
        FROM cec_candidates c
       WHERE x.voted AND c.election_id = x.election_id AND c.election_type = x.election_type
         AND replace(c.region, '臺', '台') = x.county AND c.name_norm = cec_name_key(x.name)
    ) cec ON true
$$;
COMMENT ON FUNCTION contribution_auto_tasks_withdrawn_filing IS '退選、看不出退選前有沒有登記過（withdrawn_after_filing 空的）的參選紀錄，一筆一件，附中選會登記名冊當線索；代理用 correction 改 withdrawn_after_filing（true 登記後退選／false 沒登記過）。沿用 not_running_recheck 型別（#345 後續，2026-10-06）｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

-- ── ④ 視圖 ──────────────────────────────────────────────────
-- politicians_with_elections：offices 改讀任期表（#345 第二階段：職稱改讀任期表）。欄位清單與順序不變（CREATE OR REPLACE 不能動欄位），只換 offices 那個子查詢；
-- CREATE OR REPLACE VIEW 會把 reloptions 清掉，security_invoker 要補回來（20261004000005 實測）。
CREATE OR REPLACE VIEW politicians_with_elections AS
SELECT p.id,
    p.name,
    p.party,
    p.status,
    p.election_type,
    p."position",
    p.current_position,
    COALESCE(r.region, p.region) AS region,
    COALESCE(r.sub_region, p.sub_region) AS sub_region,
    COALESCE(r.village, p.village) AS village,
    p.avatar_url,
    p.slogan,
    p.bio,
    p.education,
    p.experience,
    p.birth_year,
    p.education_level,
    COALESCE(( SELECT json_agg(pe.election_id) AS json_agg
           FROM politician_elections pe
          WHERE (pe.politician_id = p.id)), '[]'::json) AS election_ids,
    COALESCE(( SELECT json_agg(json_build_object('electionId', pe.election_id, 'position', COALESCE(pe."position", p."position"), 'slogan', COALESCE(pe.slogan, p.slogan), 'electionType', COALESCE(pe.election_type, p.election_type), 'regionId', pe.region_id, 'region', COALESCE(per.region, r.region, p.region), 'subRegion',
                CASE
                    WHEN (COALESCE(pe.election_type, p.election_type) = ANY (ARRAY['總統副總統'::text, '縣市長'::text, '縣市議員'::text, '立法委員'::text])) THEN per.sub_region
                    ELSE COALESCE(per.sub_region, r.sub_region, p.sub_region)
                END, 'village',
                CASE
                    WHEN (COALESCE(pe.election_type, p.election_type) = ANY (ARRAY['總統副總統'::text, '縣市長'::text, '縣市議員'::text, '立法委員'::text])) THEN per.village
                    ELSE COALESCE(per.village, r.village, p.village)
                END, 'candidateStatus', pe.candidate_status, 'electionResult', pe.election_result, 'sourceNote', pe.source_note, 'candNo', pe.cand_no, 'candidacyStatus', pe.candidacy_status, 'withdrawnAfterFiling', pe.withdrawn_after_filing)) AS json_agg
           FROM (politician_elections pe
             LEFT JOIN regions per ON ((pe.region_id = per.id)))
          WHERE (pe.politician_id = p.id)), '[]'::json) AS elections,
    p.merged_into,
    COALESCE(( SELECT json_agg(json_build_object('electionId', o.election_id, 'electionType', o.election_type, 'region', COALESCE(orr.region, p.region), 'subRegion', COALESCE(orr.sub_region, p.sub_region), 'village', COALESCE(orr.village, p.village), 'termEnd', o.scheduled_end_date) ORDER BY o.election_id DESC) AS json_agg
           FROM (politician_offices o
             LEFT JOIN regions orr ON ((orr.id = o.region_id)))
          WHERE ((o.politician_id = p.id) AND (o.end_date IS NULL) AND (o.start_date <= CURRENT_DATE))), '[]'::json) AS offices
   FROM (politicians p
     LEFT JOIN regions r ON ((p.region_id = r.id)));
ALTER VIEW politicians_with_elections SET (security_invoker = on);

CREATE OR REPLACE VIEW elected_politicians AS
SELECT p.id,
    p.name,
    p.party,
    p.status,
    p.avatar_url,
    p.region,
    p.sub_region,
    pe.election_id,
    pe."position",
    pe.election_type,
    pe.votes_received,
    pe.vote_percentage,
    e.name AS election_name,
    e.election_date
   FROM ((politicians p
     JOIN politician_elections pe ON ((p.id = pe.politician_id)))
     JOIN elections e ON ((pe.election_id = e.id)))
  WHERE (pe.candidacy_status = 'elected'::text);
ALTER VIEW elected_politicians SET (security_invoker = on);

CREATE OR REPLACE VIEW politician_bulletins AS
WITH x AS (
         SELECT DISTINCT ON (pe.politician_id, pe.election_id, pe.election_type) pe.politician_id,
            pe.election_id,
            pe.election_type,
            CASE WHEN (pe.candidacy_status = ANY (ARRAY['elected'::text, 'not_elected'::text])) THEN pe.candidacy_status ELSE NULL::text END AS election_result,
            replace(COALESCE(r.region, p.region), '臺'::text, '台'::text) AS county,
            replace(COALESCE(NULLIF(r.sub_region, ''::text), NULLIF(p.sub_region, ''::text)), '臺'::text, '台'::text) AS town,
            replace(COALESCE(NULLIF(r.village, ''::text), NULLIF(p.village, ''::text)), '臺'::text, '台'::text) AS village,
            cec_name_key(p.name) AS nn
           FROM ((politician_elections pe
             JOIN politicians p ON (((p.id = pe.politician_id) AND (p.merged_into IS NULL))))
             LEFT JOIN regions r ON ((r.id = pe.region_id)))
          WHERE (pe.election_id = ANY (ARRAY[2022, 2024]))
          ORDER BY pe.politician_id, pe.election_id, pe.election_type, pe.id
        ), m AS (
         SELECT x.politician_id,
            x.election_id,
            x.election_type,
            x.election_result,
            c.region,
            COALESCE(c.sub_region, ''::text) AS sub_region,
            COALESCE(c.village, ''::text) AS village,
            c.cand_no,
            c.elected,
            count(*) OVER (PARTITION BY x.politician_id, x.election_id, x.election_type) AS n_match
           FROM (x
             JOIN cec_candidates c ON (((c.election_id = x.election_id) AND (c.election_type = x.election_type) AND (replace(c.region, '臺'::text, '台'::text) = x.county) AND (c.name_norm = x.nn) AND ((x.town IS NULL) OR (x.election_type = ANY (ARRAY['縣市長'::text, '縣市議員'::text, '立法委員'::text])) OR (replace(COALESCE(c.sub_region, ''::text), '臺'::text, '台'::text) ~~ (x.town || '%'::text))) AND ((x.village IS NULL) OR (x.election_type <> '村里長'::text) OR (replace(COALESCE(c.village, ''::text), '臺'::text, '台'::text) = x.village)))))
        )
 SELECT m.politician_id,
    m.election_id,
    m.election_type,
    m.election_result,
    m.region,
    m.sub_region,
    m.village,
    m.cand_no,
    m.elected,
    ARRAY( SELECT (
                CASE
                    WHEN (u.p ~~ '01選舉公報/%'::text) THEN 'https://bulletin.cec.gov.tw/'::text
                    ELSE 'https://eebulletin.cec.gov.tw/'::text
                END || u.p)
           FROM unnest(b.paths) WITH ORDINALITY u(p, o)
          ORDER BY u.o) AS urls,
    b.match_basis
   FROM (m
     JOIN election_bulletins b ON (((b.election_id = m.election_id) AND (b.election_type = m.election_type) AND (b.region = m.region) AND (b.sub_region = m.sub_region) AND (b.village = m.village))))
  WHERE (m.n_match = 1);

-- ── ⑤ 核對：任期表現任的職稱跟舊視圖逐人一致 ─────────────────────
-- 舊視圖每人取最近一屆（跟網站顯示同一個集合）；任期表取現任（已就任、卸任日為空）。
-- 兩邊對不上就整支退回、不切：列出差異人數，到 politician_offices_gap 查是哪幾位。
DO $$
DECLARE
  v_old INTEGER; v_new INTEGER; v_missing INTEGER; v_extra INTEGER;
BEGIN
  WITH old AS (
    SELECT d.politician_id, d.election_id, d.election_type, d.region, d.sub_region, d.village
      FROM politician_offices_derived d
     WHERE d.election_id = (SELECT max(d2.election_id) FROM politician_offices_derived d2 WHERE d2.politician_id = d.politician_id)
  ), cur AS (
    SELECT o.politician_id, o.election_id, o.election_type,
           COALESCE(r.region, p.region) AS region, COALESCE(r.sub_region, p.sub_region) AS sub_region, COALESCE(r.village, p.village) AS village
      FROM politician_offices o
      JOIN politicians p ON p.id = o.politician_id
      LEFT JOIN regions r ON r.id = o.region_id
     WHERE o.end_date IS NULL AND o.start_date <= CURRENT_DATE
  )
  SELECT (SELECT count(*) FROM old), (SELECT count(*) FROM cur),
         (SELECT count(*) FROM (SELECT * FROM old EXCEPT SELECT * FROM cur) x),
         (SELECT count(*) FROM (SELECT * FROM cur EXCEPT SELECT * FROM old) x)
    INTO v_old, v_new, v_missing, v_extra;
  RAISE NOTICE '#345 職稱切到任期表：舊視圖 % 位、任期表現任 % 位、只在舊視圖 %、只在任期表 %', v_old, v_new, v_missing, v_extra;
  IF v_missing > 0 OR v_extra > 0 THEN
    RAISE EXCEPTION '#345 任期表跟舊視圖的職稱對不上（只在舊視圖 % 位、只在任期表 % 位），不切——先看 politician_offices_gap', v_missing, v_extra;
  END IF;
END $$;
