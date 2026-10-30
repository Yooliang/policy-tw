-- 號次整批交件：一個單位一份交件、一張驗證票（issue #781，維護者 2026-10-30 批准）
--
-- 背景：補號次任務一個單位最多 50 人一件，代理卻是每人交一份 candidacy，每人一張驗證票（待補 13,158 人），
-- 同一份抽籤公告 PDF 被打開幾十次。改成新型別 cand_numbers：一份交件 payload.items 每人一列 {politician_election_id, cand_no}，
-- 一張驗證票逐列核對；驗證者可在 agree 票附 bad_items 標出不對的列，落庫時那幾列不寫、其餘照過（沒寫的列 cand_no 仍空，缺口臂自然重派）。
-- 裁決：docs/decisions/2026-10-30-號次整批交件一張驗證票.md
--
-- 本檔四件事（新增貢獻型別要清點的 DB 側）：
--   1. contribution_votes.bad_items（驗證者標錯的列；NULL＝沒標）
--   2. contributions_contribution_type_check 加 cand_numbers
--   3. contribution_required_agree：cand_numbers 走風險等級 cand_no（目標 1，不看來源）；needs_two_ips 的清單本來就不含它（不用動）
--   4. cand_no_batch_conflicts(items)：號次重複的落庫前逐列檢查（整批內部同號、與已上線的他人同號的列）
-- TS 鏡像：_shared/consensus.ts 的 riskLevel／AGREE_THRESHOLDS.cand_no、_shared/cand-numbers.ts。
-- 守門測試從函式名最後一次出現處往後解析，所以這段說明不放在函式後面。

-- 1. 驗證者標錯的列
ALTER TABLE contribution_votes ADD COLUMN IF NOT EXISTS bad_items JSONB;
COMMENT ON COLUMN contribution_votes.bad_items IS '整批型別（cand_numbers）的 agree 票標出的錯列：politician_election_id 的整數陣列；落庫時這幾列不寫、回到缺口重派。NULL＝沒標（2026-10-30，#781）';

-- 2. 貢獻型別 CHECK（漏這個的話代理交件全被擋而測試全綠）
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'election_results', 'reassign_candidacy', 'regional_stat', 'cand_numbers'));

-- 3. 目標分數：以 20261029020000 的現行定義為底，cand_numbers 也走 cand_no 級（目標 1）
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'merge_politician' THEN 'high'
    WHEN p_type = 'election_results' THEN 'batch_result'
    WHEN p_type = 'regional_stat' THEN 'regional_stat'
    WHEN p_type = 'cand_numbers' THEN 'cand_no'
    WHEN p_type = 'candidacy'
         AND p_payload->>'election_result' IN ('elected', 'not_elected')
         AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'past_result'
    WHEN p_type = 'candidacy' AND p_payload->>'cand_no' ~ '^0*[1-9][0-9]{0,5}$' THEN 'cand_no'
    WHEN p_type = 'correction' AND correction_only_from_rumor(p_payload) THEN 'normal'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'past_result' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'batch_result' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'regional_stat' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 1 WHEN 'social' THEN 1 ELSE 1 END
    WHEN v_risk = 'cand_no' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 1 WHEN 'social' THEN 1 ELSE 1 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 3
  END;
END;
$$;

-- 4. 號次重複的落庫前逐列檢查：回傳「不能寫」的列與原因（整批沒衝突就回空）
--    衝突有兩種：①同一批裡另一位（同選舉、同號次單位、不同人）填了同一個號次——兩列都回，不知道誰抄錯；
--    ②已上線的參選紀錄裡另一位（同選舉別、同號次單位、不是同一個人）已經是這個號次。
--    號次單位的算法與重複檢查（cand_no_dup_conflicts）、視圖 ballot_number_units 同一支 ballot_number_unit，單位算不出來的列不檢查。
--    唯讀、STABLE；一次最多 150 列（呼叫端已擋），每列只走 politician_elections 的主鍵與（選舉, 號次）查找。
CREATE OR REPLACE FUNCTION cand_no_batch_conflicts(p_items JSONB) RETURNS TABLE (politician_election_id INTEGER, cand_no INTEGER, reason TEXT)
LANGUAGE sql STABLE AS $$
  WITH it AS (
    SELECT (x->>'politician_election_id')::INTEGER AS pe_id, (x->>'cand_no')::INTEGER AS no
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) x
     WHERE (x->>'politician_election_id') ~ '^[0-9]{1,9}$' AND (x->>'cand_no') ~ '^[0-9]{1,6}$' AND (x->>'cand_no')::INTEGER > 0
  ),
  me AS (
    SELECT it.pe_id, it.no, pe.election_id, pe.election_type, p.id AS pid, p.name,
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit
      FROM it
      JOIN politician_elections pe ON pe.id = it.pe_id
      JOIN politicians p ON p.id = pe.politician_id
      LEFT JOIN regions r ON r.id = pe.region_id
  ),
  intra AS (
    SELECT a.pe_id, a.no, '同一批的「' || b.name || '」也填了 ' || a.no || ' 號（同一個號次單位：' || replace(a.unit, '|', ' ') || '）' AS why
      FROM me a
      JOIN me b ON b.pe_id <> a.pe_id AND b.election_id = a.election_id AND b.election_type = a.election_type AND b.unit = a.unit AND b.no = a.no AND b.pid <> a.pid
     WHERE a.unit IS NOT NULL
  ),
  recs AS (
    SELECT a.pe_id, a.no, '已上線的「' || p2.name || '」已經是 ' || a.no || ' 號（同一個號次單位：' || replace(a.unit, '|', ' ') || '）' AS why
      FROM me a
      JOIN politician_elections pe2 ON pe2.election_id = a.election_id AND pe2.election_type = a.election_type AND pe2.cand_no = a.no AND pe2.id <> a.pe_id
      JOIN politicians p2 ON p2.id = pe2.politician_id AND p2.merged_into IS NULL AND p2.id <> a.pid
      LEFT JOIN regions r2 ON r2.id = pe2.region_id
     WHERE a.unit IS NOT NULL
       AND ballot_number_unit(pe2.election_type, COALESCE(r2.region, p2.region), r2.sub_region, r2.sub_region, r2.village) = a.unit
  )
  SELECT x.pe_id, x.no, string_agg(DISTINCT x.why, '；') FROM (SELECT * FROM intra UNION ALL SELECT * FROM recs) x GROUP BY x.pe_id, x.no
$$;
COMMENT ON FUNCTION cand_no_batch_conflicts IS '整批號次（cand_numbers）落庫前的逐列重複檢查：回傳不能寫的列（同批同號、或已上線的他人同號）與原因；沒衝突回空。號次單位同 cand_no_dup_conflicts（#781）';
REVOKE EXECUTE ON FUNCTION cand_no_batch_conflicts(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cand_no_batch_conflicts(JSONB) TO service_role;

-- 5. 票數預算影子排程的候選型別：TS 的 VOTE_DIMENSIONS 有 cand_numbers，SQL 候選清單要同步（vote-budget-cron.test.ts 盯兩邊一致）。以 20261009240100 的定義為底，只多 'cand_numbers'
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link',
                                'party_info', 'election_results', 'reassign_candidacy', 'regional_stat', 'cand_numbers')
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
