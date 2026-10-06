-- 同名人物接錯：參選紀錄改掛到正確的人（reassign_candidacy）＋派工臂找疑似掛錯的（candidacy_owner_mismatch）
-- ============================================================
--
-- 小良哥 10-06 點頭（#370 未決 1：「掛錯人沒有流程可以修」）。簡嘉佑：台中市第09選舉區的民進黨簡嘉佑（1987 年生），
-- 2026 參選紀錄掛到了 1959 年生的桃園市豐林里長；楊寶楨：2022 台北市議員那位名下掛著 2026 台中市議員的參選紀錄。
-- 代理確認掛錯之後只能回 no_change——correction 的 politician_elections 只開放狀態、職位、選舉別，同名合併
-- （merge_politician）是兩筆人物併成一位，方向相反。
--
-- 做了什麼（只加不刪）：
--   1. 貢獻型別 reassign_candidacy：指定一筆參選紀錄，改掛到既有的另一位（to_politician_id）或新建一位
--      （new_politician：姓名、出生年、政黨）；evidence 寫出處上這一筆的分辨資料（中選會名冊的出生年／推薦政黨／選區），
--      reason 寫分辨根據。落庫在 apply-contribution.ts：UPDATE politician_elections.politician_id、記 edit_history、
--      兩人記成「不同人」（politician_pair_resolutions，同名清查不再配這一對），整筆可還原。人物的衍生欄位
--      （最新一屆、任期）照既有觸發器重算（trg_sync_politician_latest、trg_sync_politician_office 都看 politician_id 的變動）。
--   2. 伺服器檢查（交件與落庫各一次，_shared/reassign-candidacy.ts）：新舊兩人同名或已知別名、不是同一人
--      （出生年都有而且一樣就擋；記成同一人的擋）、出處的出生年對得上新的、對不上舊的、改掛後同一個人同一屆不會有兩筆。
--   3. 門檻：比照 merge_politician 要兩台不同機器（contribution_needs_two_ips）；分數門檻用一般值 3（不動計分）。
--      系統票照現有規則（supported −1／not_supported +1）：reassign_candidacy_system_check 拿中選會名冊（cec_candidates，
--      已投票的屆別）唯一對上的那一列的出生年，跟新舊兩人比——對得上新的、對不上舊的 → supported；反過來 → not_supported；
--      其餘（2026 還沒進名冊、名冊沒出生年、同名分不出）棄權。一般 Jev 預判不撿（system_vote_cec_only）。
--   4. 派工臂 contribution_auto_tasks_owner_mismatch（任務型別 candidacy_owner_mismatch），訊號
--      （candidacy_owner_mismatch_signals）：①中選會名冊唯一對上的出生年跟人物不同；②建立這筆的交件寫的縣市跟現在掛的不同；
--      ③同一人相隔一屆在不同縣市參選地方選舉；④查證者在這筆的任務上回 no_change、理由寫明「不是同一人」；
--      ⑤驗證者理由寫明「不是同一人」、這筆卻掛在一位另有別屆紀錄的既有人物上。確認是同一人（no_change confirmed 通過）的不再派。
--      10-06 唯讀實跑抓到 11 件（簡嘉佑、楊寶楨都在），抽樣見 PR 說明。
--
-- 錯了的代價：改掛錯了＝把一筆參選紀錄從對的人身上拿走；所以要兩台機器、要寫分辨根據，而且整筆可還原。
-- 舊的人掛著的同一屆政見不會跟著搬（回覆會講有幾筆），要另外處理。

-- 引用到的既有欄位與函式（10-06 唯讀查詢確認存在）：
--   politician_elections(id, politician_id, election_id, election_type, region_id, election_result, candidate_status)、
--   politicians(id, name, birth_year, party, region, sub_region, village, merged_into)、regions、elections(election_date)、
--   cec_candidates(election_id, election_type, region, sub_region, village, name_norm, birth_year, elected)、
--   contributions(contribution_type, status, payload, task_id, applied_politician_id, note)、contribution_votes(note)、
--   task_checks(task_id, outcome)、politician_pair_resolutions(pair_key, resolution)、jev_decisions、
--   cec_name_key、election_result_cec_matches（20261006141500）、contribution_apply_consensus

-- ── 1. 貢獻型別 ──────────────────────────────────────────────────
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'election_results', 'reassign_candidacy'));

-- ── 2. 兩台機器（比照 merge_politician；分數、目標、退件門檻不動） ─────
CREATE OR REPLACE FUNCTION contribution_needs_two_ips(p_type TEXT, p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('merge_politician', 'candidacy', 'removal', 'reassign_candidacy')
      OR (p_type = 'lineage_handover' AND COALESCE(p_payload->>'handover_type', '') = 'stop')
$$;
COMMENT ON FUNCTION contribution_needs_two_ips IS
  '分數不得由單一來源 IP 湊足的貢獻：同名合併、加減參選人、移除、參選紀錄改掛（2026-10-06，比照合併），以及「中止」交接（#349）';

-- ── 3. 系統票：有，但只由中選會名冊核對投 ──────────────────────────
-- 改掛的系統票：中選會名冊（已投票的屆別）唯一對上的那一列有出生年才判。照現有規則：supported −1、not_supported +1、其餘棄權
CREATE OR REPLACE FUNCTION reassign_candidacy_system_check(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payload JSONB; v_pe INTEGER; v_from_by INTEGER; v_to_by INTEGER; v_hits INTEGER; v_cec_by INTEGER; v_choice TEXT; v_why TEXT;
BEGIN
  SELECT payload INTO v_payload FROM contributions
   WHERE id = p_contribution_id AND contribution_type = 'reassign_candidacy' AND status = 'pending';
  IF v_payload IS NULL THEN RETURN NULL; END IF;
  v_pe := CASE WHEN (v_payload->>'politician_election_id') ~ '^[0-9]{1,9}$' THEN (v_payload->>'politician_election_id')::INTEGER END;
  SELECT p.birth_year INTO v_from_by FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE pe.id = v_pe;
  IF (v_payload->>'to_politician_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    SELECT birth_year INTO v_to_by FROM politicians WHERE id = (v_payload->>'to_politician_id')::UUID;
  ELSIF (v_payload->'new_politician'->>'birth_year') ~ '^[0-9]{4}$' THEN
    v_to_by := (v_payload->'new_politician'->>'birth_year')::INTEGER;
  END IF;
  SELECT m.cec_hits, m.cec_birth_year INTO v_hits, v_cec_by FROM election_result_cec_matches(ARRAY[v_pe]) m;
  v_choice := CASE
    WHEN v_hits = 1 AND v_cec_by IS NOT NULL AND v_to_by = v_cec_by AND v_from_by IS DISTINCT FROM v_cec_by THEN 'supported'
    WHEN v_hits = 1 AND v_cec_by IS NOT NULL AND v_from_by = v_cec_by AND v_to_by IS DISTINCT FROM v_cec_by THEN 'not_supported'
    ELSE 'cannot_tell' END;
  v_why := CASE v_choice
    WHEN 'supported' THEN '中選會名冊這一筆的出生年跟改掛的對象一樣、跟現在掛的這位不同'
    WHEN 'not_supported' THEN '中選會名冊這一筆的出生年跟現在掛的這位一樣、跟改掛的對象不同'
    WHEN 'cannot_tell' THEN CASE WHEN COALESCE(v_hits, 0) = 0 THEN '中選會名冊沒有這一屆（2026 還沒投票）或找不到同縣市同名的人'
                                 WHEN v_hits > 1 THEN '中選會名冊同縣市同名不只一位'
                                 WHEN v_cec_by IS NULL THEN '中選會名冊這一筆沒有出生年'
                                 ELSE '新舊兩人的出生年都跟名冊一樣或都不一樣（或沒有出生年），分不出來' END
  END;
  INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability, confidence, probabilities, model, state, cost_usd)
  VALUES ('contribution', p_contribution_id::TEXT, 'source_support', v_choice,
          CASE WHEN v_choice = 'cannot_tell' THEN 0 ELSE 1 END, NULL, NULL,
          'policy-tw/cec-reassign-check-20261006',
          jsonb_build_object('politician_election_id', v_pe, 'cec_hits', v_hits, 'cec_birth_year', v_cec_by,
                             'from_birth_year', v_from_by, 'to_birth_year', v_to_by, 'reason', v_why),
          0);
  PERFORM contribution_apply_consensus(p_contribution_id);
  RETURN v_choice;
END;
$$;
COMMENT ON FUNCTION reassign_candidacy_system_check IS
  '參選紀錄改掛的系統票（2026-10-06）：中選會名冊唯一對上的那一列的出生年，對得上新的、對不上舊的 supported；反過來 not_supported；其餘棄權';

CREATE OR REPLACE FUNCTION reassign_candidacy_check_pending(p_limit INTEGER DEFAULT 50) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_n INTEGER := 0; v_choice TEXT; v_tally JSONB := '{}'::jsonb;
BEGIN
  FOR r IN
    SELECT c.id FROM contributions c
     WHERE c.contribution_type = 'reassign_candidacy' AND c.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM jev_decisions j
                        WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT
                          AND j.question = 'source_support' AND j.model LIKE 'policy-tw/cec-reassign-check%')
     ORDER BY c.created_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
  LOOP
    v_n := v_n + 1;
    v_choice := COALESCE(reassign_candidacy_system_check(r.id), 'skipped');
    v_tally := jsonb_set(v_tally, ARRAY[v_choice], to_jsonb(COALESCE((v_tally->>v_choice)::INTEGER, 0) + 1));
  END LOOP;
  RETURN jsonb_build_object('checked', v_n, 'tally', v_tally);
END;
$$;
COMMENT ON FUNCTION reassign_candidacy_check_pending IS '撿還沒核過的 reassign_candidacy 跑系統票（reassign-check-10min）';

REVOKE EXECUTE ON FUNCTION reassign_candidacy_system_check(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reassign_candidacy_check_pending(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reassign_candidacy_system_check(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION reassign_candidacy_check_pending(INTEGER) TO service_role;

-- ── 4. 派工：疑似掛錯的訊號 ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION candidacy_owner_mismatch_signals()
RETURNS TABLE (politician_election_id INTEGER, signal TEXT, detail TEXT)
LANGUAGE sql STABLE AS $$
  WITH pe AS (
    SELECT pe.id, pe.politician_id, pe.election_id, pe.election_type, e.election_date, p.name, p.birth_year,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      LEFT JOIN regions r ON r.id = pe.region_id
  ),
  -- ①中選會名冊唯一對上的那一列，出生年跟人物不同
  cec AS (
    SELECT m.politician_election_id AS id, m.cec_birth_year
      FROM election_result_cec_matches(ARRAY(
             SELECT x.id FROM pe x
              WHERE x.birth_year IS NOT NULL AND x.election_id IN (SELECT DISTINCT c.election_id FROM cec_candidates c))) m
     WHERE m.cec_hits = 1
  )
  SELECT x.id, 'cec_birth_year', '中選會名冊上這一筆的出生年是 ' || c.cec_birth_year || '，這個人記的是 ' || x.birth_year
    FROM pe x JOIN cec c ON c.id = x.id
   WHERE c.cec_birth_year IS NOT NULL AND c.cec_birth_year <> x.birth_year
  UNION ALL
  -- ②建立這筆的交件寫的縣市，跟現在掛的縣市不同（簡嘉佑：交件寫台中市，掛到了桃園市的同名者）
  SELECT DISTINCT x.id, 'submitted_region',
         '建立這筆的交件寫的是「' || replace(c.payload->>'region', '臺', '台') || '」，現在掛的這個人在「' || x.county || '」'
    FROM pe x JOIN contributions c
      ON c.contribution_type = 'candidacy' AND c.status = 'applied' AND c.applied_politician_id = x.politician_id
     AND c.payload->>'election_id' = x.election_id::TEXT
   WHERE x.county IS NOT NULL AND c.payload->>'region' IS NOT NULL AND c.payload->>'region' <> '全國'
     AND left(replace(c.payload->>'region', '臺', '台'), 3) <> left(x.county, 3)
  UNION ALL
  -- ③同一人相隔一屆在不同縣市參選地方選舉（楊寶楨：2022 台北市議員、2026 台中市議員）
  SELECT DISTINCT b.id, 'county_jump',
         '同一個人 ' || a.election_id || ' 在' || a.county || '參選' || a.election_type || '，這一筆在' || b.county
    FROM pe a JOIN pe b ON a.politician_id = b.politician_id AND a.election_date < b.election_date
   WHERE a.election_type IN ('縣市議員', '鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
     AND b.election_type IN ('縣市議員', '鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
     AND a.county IS NOT NULL AND b.county IS NOT NULL AND a.county <> b.county AND a.county <> '全國' AND b.county <> '全國'
     AND b.election_date - a.election_date < 1700
  UNION ALL
  -- ④查證者在這筆的任務上回 no_change、理由寫明「不是同一人」（沒有改掛的型別時只能這樣回）
  SELECT DISTINCT x.id, 'said_different', '有人在這筆的任務上回報「不是同一人」，但當時只能回 no_change'
    FROM contributions c
    JOIN pe x ON x.id = substring(c.task_id FROM ':([0-9]{1,9})$')::INTEGER
   WHERE c.contribution_type = 'no_change' AND c.status NOT IN ('rejected', 'withdrawn')
     AND c.task_id ~ '^auto:[a-z_]+:[0-9]{1,9}$'
     AND COALESCE(c.payload->>'finding', '') || ' ' || COALESCE(c.note, '') ~ '(不是|並非|非|不為)同一(個)?(人|位)|同名不同人|掛錯'
     AND COALESCE(c.payload->>'finding', '') || ' ' || COALESCE(c.note, '') !~ '(不是|非|並非)同名不同人'
  UNION ALL
  -- ⑤驗證者理由寫明「不是同一人」，這筆卻掛在一位另有別屆紀錄的既有人物上（楊忠俊：驗證者說分不出、同意建新人物，結果掛到了金寧鄉長）
  SELECT DISTINCT x.id, 'vote_said_different', '驗證這筆的人寫了「不是同一人」，這筆卻掛在一位另有別屆紀錄的既有人物上'
    FROM contribution_votes v
    JOIN contributions c ON c.id = v.contribution_id AND c.contribution_type = 'candidacy' AND c.status = 'applied'
    JOIN pe x ON x.politician_id = c.applied_politician_id AND c.payload->>'election_id' = x.election_id::TEXT
   WHERE v.note ~ '(不是|並非|非)同一(個)?(人|位)|同名不同人'
     AND v.note !~ '(不是|非|並非)同名不同人'
     AND EXISTS (SELECT 1 FROM politician_elections o WHERE o.politician_id = x.politician_id AND o.id <> x.id)
$$;
COMMENT ON FUNCTION candidacy_owner_mismatch_signals IS
  '疑似掛錯人的參選紀錄與理由（2026-10-06）：名冊出生年不符、交件縣市不符、相隔一屆換縣市、查證者或驗證者寫明不是同一人';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_owner_mismatch()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
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
                                                 'region', ro.region, 'district', ro.sub_region, 'village', ro.village, 'election_result', o.election_result)
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
COMMENT ON FUNCTION contribution_auto_tasks_owner_mismatch IS
  '參選紀錄疑似掛錯人（candidacy_owner_mismatch，2026-10-06）：訊號見 candidacy_owner_mismatch_signals；有人交改掛在等票的、確認過是同一人的不派';

-- ── 5. 接進派工（其餘每一支照抄 20261006141500） ─────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due())
  SELECT r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_villages()
  UNION ALL SELECT * FROM contribution_auto_tasks_township_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_region_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_elected_missing()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_cec_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_district_seats()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_elements()
  UNION ALL SELECT * FROM due
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_candidates()
  UNION ALL SELECT * FROM contribution_auto_tasks_handover_missing()
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_roles()
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_links()
  UNION ALL SELECT * FROM contribution_auto_tasks_career_sources()
  UNION ALL SELECT * FROM contribution_auto_tasks_withdrawn_filing()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_roster()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_info()
  UNION ALL SELECT * FROM contribution_auto_tasks_placeholder_politicians()
  UNION ALL SELECT * FROM contribution_auto_tasks_election_results()
  UNION ALL SELECT * FROM contribution_auto_tasks_owner_mismatch()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-06 加學經歷補出處（contribution_auto_tasks_career_sources，沿用 profile_detail_gap，#346）。'
  '2026-10-06 加退選前有沒有登記（contribution_auto_tasks_withdrawn_filing，沿用 not_running_recheck，#345）。'
  '2026-10-06 加參選紀錄缺政黨（contribution_auto_tasks_party_gap，沿用 candidacy_source_missing，#346）。'
  '2026-10-06 加 2026 參選紀錄缺政黨（登記彙總表）、政黨資訊缺口（party_info_missing）、疑似測試資料的人物（placeholder_politician）。'
  '2026-10-06 加補選舉結果（contribution_auto_tasks_election_results：批次 election_results_missing＋對不上的 election_result_missing，#377）。'
  '2026-10-06 加參選紀錄疑似掛錯人（contribution_auto_tasks_owner_mismatch：candidacy_owner_mismatch，#370 未決 1）。';

-- 票數預算影子模式的候選清單加 reassign_candidacy（兩個維度在 vote-budget.ts；其餘照抄 20261006141500）
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link',
                                'party_info', 'election_results', 'reassign_candidacy')
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget'
        AND (c.contribution_type <> 'no_change' OR j.state->'target' ? 'outcome')
    )
    AND (c.contribution_type <> 'no_change' OR (
      SELECT COUNT(*) FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget') < 2)
  -- 新的先：新件的影子結果之後才對得到它的實際結果；舊件一天內也會輪到
  ORDER BY c.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 60));
$$;

-- 系統票合格型別與名單核對專屬型別（放在最後：守門測試從定義處讀到檔尾）
CREATE OR REPLACE FUNCTION system_vote_eligible(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('policy', 'candidacy', 'politician', 'correction', 'policy_progress', 'election_results', 'reassign_candidacy')
$$;

CREATE OR REPLACE FUNCTION system_vote_cec_only(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('election_results', 'reassign_candidacy')
$$;
COMMENT ON FUNCTION system_vote_cec_only IS
  '系統票只由中選會名單核對投的型別（election_results、reassign_candidacy，2026-10-06）：一般預判不撿，免得讀網頁的判定蓋掉名單核對';

-- ── 6. 排程（跟 results-batch 錯開） ─────────────────────────────
SELECT cron.unschedule('reassign-check-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reassign-check-10min');
SELECT cron.schedule('reassign-check-10min', '8,18,28,38,48,58 * * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=reassign_check',
                       headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);

-- ── 7. 自我檢查 ──────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '參選紀錄疑似掛錯人派工：上線當下 % 件', (SELECT count(*) FROM contribution_auto_tasks_owner_mismatch());
END $$;

NOTIFY pgrst, 'reload schema';
