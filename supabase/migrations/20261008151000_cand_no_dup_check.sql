-- 號次重複檢查：交件的 cand_no 跟同一個號次單位裡的另一位同號，系統票 not_supported（+1）（2026-10-08，缺口盤點 R8；接 20261008150000 補號次）
-- ============================================================
--
-- 維護者 10-08：「同一場選舉的號次有沒有重複很好被找出來」。號次是每個號次單位各自從 1 編起的（函式 ballot_number_unit：縣市長＝縣市、縣市議員＝選舉區、鄉鎮市長與區長＝鄉鎮市區、村里長＝村里；
-- 代表的選舉區我們沒記、單位算不出來＝不檢查），同一個單位不會有兩位同號。
--
-- 做法（照現有系統票的寫法，同 election_results_system_check／results-batch-10min）：
--   * cand_no_dup_conflicts(貢獻)：這筆 candidacy 的號次，在同一個號次單位裡還被誰用——①已上線的參選紀錄（politician_elections.cand_no，別人的）②等票中（pending／verified）的另一筆 candidacy
--     （包含同一批交件裡的另一位、跨批的另一位）。同一個人（politician_id 相同，沒給就比姓名）不算。單位算不出來、沒有 election_id、號次不是正整數的回 NULL＝不檢查。
--   * cand_no_dup_system_check(貢獻)：有衝突就寫一張系統票 source_support／not_supported（model policy-tw/cand-no-dup-20261008，state.reason 寫明「號次 N 與某某重複」），再重算共識——
--     not_supported 讓目標 +1（一般 candidacy 3 → 4），不觸發裁決、不是反對票。沒有衝突不寫任何東西：一般的 Jev 預判（system_one_precheck_candidates 以「沒有真的判過」為條件）照舊可以判這一筆，
--     寫了 not_supported 之後 Jev 就不會再判它，所以 Jev 事後的 supported 蓋不掉重複的 not_supported。
--   * cand_no_dup_check_pending(上限)：每 10 分鐘（system-one?action=cand_no_check，排程 cand-no-check-10min）把所有帶 cand_no、還沒被這個檢查標過的 pending candidacy 各檢查一次。
--     每次都重新檢查「還沒標過」的全部，所以後到的那一筆會先被標、先到的也會在下一輪看到後到的而被標（兩邊都 +1）。
--   * 這是內部一致性檢查，不是來源核對：不看來源網頁、不讀 PDF，不牴觸 09-24 的名冊例外範圍。
--   * 已知限制：標過 not_supported 的不收回（共識的系統票只認「最新一張 supported／not_supported」，沒辦法用 cannot_tell 蓋掉）；衝突的另一筆後來被退件，這筆多要的一票仍在——
--     代價只是多一張同意票，不會誤擋（not_supported 不會讓貢獻被退件）。
--
-- 不動：contribution_system_vote／contribution_apply_consensus／system_vote_eligible（candidacy 本來就在系統票的型別裡）。
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：jev_decisions（subject_type=contribution、question=source_support 都在 CHECK 裡）、contribution_apply_consensus(uuid)、
--   contributions(payload, status, contribution_type)、politician_elections／politicians／regions、20261008150000 的 ballot_number_unit。
-- 守門：supabase/functions/_shared/ballot-number-checks.test.ts（跨批、同批、不同選舉區同號、村里長按村里、同一人、單位算不出來、已標過不重複寫、還原驗證）。

CREATE OR REPLACE FUNCTION cand_no_dup_conflicts(p_contribution_id UUID) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT c.id,
           CASE WHEN (c.payload->>'cand_no') ~ '^[0-9]{1,6}$' AND (c.payload->>'cand_no')::INTEGER > 0 THEN (c.payload->>'cand_no')::INTEGER END AS no,
           CASE WHEN (c.payload->>'election_id') ~ '^[0-9]{1,9}$' THEN (c.payload->>'election_id')::INTEGER END AS eid,
           c.payload->>'election_type' AS etype,
           NULLIF(c.payload->>'politician_id', '') AS pid,
           NULLIF(btrim(c.payload->>'name'), '') AS pname,
           ballot_number_unit(c.payload->>'election_type', c.payload->>'region', c.payload->>'electoral_district', c.payload->>'sub_region', c.payload->>'village') AS unit
      FROM contributions c
     WHERE c.id = p_contribution_id AND c.contribution_type = 'candidacy'
  ),
  recs AS (  -- 已上線：同一場選舉、同一個號次單位、同號的另一位
    SELECT jsonb_build_object('source', 'record', 'politician_election_id', pe.id, 'politician_id', p.id, 'name', p.name, 'cand_no', pe.cand_no) AS j
      FROM me
      JOIN politician_elections pe ON pe.election_id = me.eid AND pe.election_type = me.etype AND pe.cand_no = me.no
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE me.unit IS NOT NULL AND me.no IS NOT NULL
       AND ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) = me.unit
       AND NOT (CASE WHEN me.pid IS NOT NULL THEN p.id::TEXT = me.pid ELSE p.name = me.pname END)
  ),
  pend AS (  -- 等票中：另一筆 candidacy（同一批或跨批），同一場選舉、同一個號次單位、同號、不是同一個人
    SELECT jsonb_build_object('source', 'contribution', 'contribution_id', c2.id, 'politician_id', c2.payload->>'politician_id', 'name', c2.payload->>'name', 'cand_no', me.no) AS j
      FROM me
      JOIN contributions c2 ON c2.contribution_type = 'candidacy' AND c2.status IN ('pending', 'verified') AND c2.id <> me.id
       AND c2.payload->>'election_id' = me.eid::TEXT AND c2.payload->>'election_type' = me.etype AND c2.payload->>'cand_no' = me.no::TEXT
     WHERE me.unit IS NOT NULL AND me.no IS NOT NULL
       AND ballot_number_unit(c2.payload->>'election_type', c2.payload->>'region', c2.payload->>'electoral_district', c2.payload->>'sub_region', c2.payload->>'village') = me.unit
       AND NOT (CASE WHEN me.pid IS NOT NULL AND NULLIF(c2.payload->>'politician_id', '') IS NOT NULL THEN c2.payload->>'politician_id' = me.pid
                     ELSE NULLIF(btrim(c2.payload->>'name'), '') IS NOT DISTINCT FROM me.pname END)
  )
  SELECT CASE WHEN me.unit IS NULL OR me.no IS NULL OR me.eid IS NULL THEN NULL
              ELSE jsonb_build_object('unit', me.unit, 'cand_no', me.no,
                                      'conflicts', COALESCE((SELECT jsonb_agg(x.j) FROM (SELECT j FROM recs UNION ALL SELECT j FROM pend) x), '[]'::jsonb)) END
    FROM me
$$;
COMMENT ON FUNCTION cand_no_dup_conflicts IS
  '這筆 candidacy 的號次在同一個號次單位（ballot_number_unit）裡還被誰用：已上線的參選紀錄、等票中（pending／verified）的另一筆 candidacy；同一個人不算。單位算不出來／沒有 election_id／號次不是正整數回 NULL＝不檢查。唯讀。補號次 20261008151000';

-- 系統票：有衝突就投 not_supported（+1），沒有衝突不寫任何東西；已經標過的不重複寫
CREATE OR REPLACE FUNCTION cand_no_dup_system_check(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_res JSONB; v_names TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contributions WHERE id = p_contribution_id AND contribution_type = 'candidacy' AND status = 'pending') THEN
    RETURN NULL;
  END IF;
  v_res := cand_no_dup_conflicts(p_contribution_id);
  IF v_res IS NULL OR jsonb_array_length(v_res->'conflicts') = 0 THEN RETURN 'ok'; END IF;
  IF EXISTS (SELECT 1 FROM jev_decisions j
              WHERE j.subject_type = 'contribution' AND j.subject_id = p_contribution_id::TEXT AND j.question = 'source_support'
                AND j.model LIKE 'policy-tw/cand-no-dup%' AND j.choice = 'not_supported') THEN
    RETURN 'not_supported';
  END IF;
  SELECT string_agg(COALESCE(x->>'name', '（姓名不明）'), '、') INTO v_names FROM jsonb_array_elements(v_res->'conflicts') x;
  INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability, confidence, probabilities, model, state, cost_usd)
  VALUES ('contribution', p_contribution_id::TEXT, 'source_support', 'not_supported', 1, NULL, NULL,
          'policy-tw/cand-no-dup-20261008',
          jsonb_build_object('reason', '號次 ' || (v_res->>'cand_no') || ' 與 ' || v_names || ' 重複（同一個號次單位：' || replace(v_res->>'unit', '|', ' ') || '）',
                             'unit', v_res->>'unit', 'cand_no', (v_res->>'cand_no')::INTEGER, 'conflicts', v_res->'conflicts',
                             'rule', '同一個號次單位（縣市長＝縣市、縣市議員＝選舉區、鄉鎮市長與區長＝鄉鎮市區、村里長＝村里）每個號次只有一位；跟已上線或等票中的另一位同號就投 not_supported（目標 +1）。這是內部一致性檢查，不核對來源'),
          0);
  PERFORM contribution_apply_consensus(p_contribution_id);
  RETURN 'not_supported';
END;
$$;
COMMENT ON FUNCTION cand_no_dup_system_check IS '號次重複的系統票（2026-10-08）：同一個號次單位有同號的另一位（已上線或等票中）→ source_support／not_supported（+1），原因寫在 state.reason；沒有衝突不寫；寫完重算共識';

-- 還沒被標過的帶號次 pending candidacy 各檢查一次（system-one?action=cand_no_check 每 10 分鐘叫）
CREATE OR REPLACE FUNCTION cand_no_dup_check_pending(p_limit INTEGER DEFAULT 200) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_n INTEGER := 0; v_flagged INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.id FROM contributions c
     WHERE c.contribution_type = 'candidacy' AND c.status = 'pending'
       AND (c.payload->>'cand_no') ~ '^[0-9]{1,6}$'
       AND NOT EXISTS (SELECT 1 FROM jev_decisions j
                        WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
                          AND j.model LIKE 'policy-tw/cand-no-dup%' AND j.choice = 'not_supported')
     ORDER BY c.created_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000))
  LOOP
    v_n := v_n + 1;
    IF cand_no_dup_system_check(r.id) = 'not_supported' THEN v_flagged := v_flagged + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_n, 'flagged', v_flagged);
END;
$$;
COMMENT ON FUNCTION cand_no_dup_check_pending IS '撿還沒被標過的帶號次 pending candidacy 跑重複檢查（cand-no-check-10min）';

-- 寫系統票的兩支只給服務角色（排程與 system-one）；比對本身是唯讀的，照預設公開
REVOKE EXECUTE ON FUNCTION cand_no_dup_system_check(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION cand_no_dup_check_pending(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cand_no_dup_system_check(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION cand_no_dup_check_pending(INTEGER) TO service_role;

-- 排程（跟 roster-batch 2,12…、results-batch 6,16…、reassign-check 8,18… 錯開）
SELECT cron.unschedule('cand-no-check-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cand-no-check-10min');
SELECT cron.schedule('cand-no-check-10min', '4,14,24,34,44,54 * * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=cand_no_check',
                       headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);
