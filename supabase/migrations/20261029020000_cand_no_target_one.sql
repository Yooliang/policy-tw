-- 號次交件（candidacy 且 payload 帶正整數 cand_no）共識目標分數 3 → 1（維護者 2026-10-29 點頭）
--
-- 一張同意即達標。保留：①candidacy 的「至少兩台不同機器」規則（contribution_needs_two_ips 不動）；
-- ②號次重複的系統票 cand_no_dup_system_check（not_supported，目標 +1）照舊，所以重複時 1+1＝2 張；
-- ③一張反對照舊擋得住（同意 +1 配反對 −1＝0，到不了 1；退件門檻仍 3）。
-- 補「已投票選舉結果」(past_result，帶 election_result＋politician_id) 的 candidacy 不受影響，仍是 3。
-- 裁決：docs/decisions/2026-10-29-號次目標分降為一.md
--
-- 門檻函式以 20261027080000 的現行定義為底，只多一個風險等級 cand_no（目標 1，不看來源），判斷放在 past_result 之後、candidacy 一般級之前。
-- 簽名不變；contribution_effective_agree／contribution_apply_consensus／contribution_reject_floor 呼叫它、不鏡射數字，不用重寫。
-- TS 鏡像：_shared/consensus.ts 的 AGREE_THRESHOLDS.cand_no／hasCandNo／riskLevel。
-- 不重算現有 pending：此刻的 pending 若已有票，下一次投票或共識重算時自然以新目標判定。
-- 守門測試從函式名最後一次出現處往後解析，所以這段說明不放在函式後面。

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
