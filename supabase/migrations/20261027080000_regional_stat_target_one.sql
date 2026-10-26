-- 地方基本統計（regional_stat）共識目標分數 3 → 1（#741，維護者 2026-10-27 語音要求）
--
-- 一位驗證人同意（+1 或 +2 都行）即上線；一張反對照舊擋得住（退件門檻 3、2 張帶反證轉爭議不變）。
-- 理由：數字來自官方統計，協議規定查不到不得推估、已有不同值不覆蓋、每網段只算一票、不能驗自己。
-- 先例：roster_check 逐位吻合的目標 1。裁決：docs/decisions/2026-10-27-區域統計目標分數降為1.md
--
-- 1. 門檻函式：以 20261006141500 的現行定義為底，只多一個風險等級 regional_stat（目標 1，不看來源）。
--    簽名不變；contribution_effective_agree／contribution_apply_consensus／contribution_reject_floor 都是呼叫它、
--    不鏡射數字，所以不用重寫（regional_stat 沒有系統票：目標就是 1，且 contribution_needs_two_ips 不含它）。
--    TS 鏡像：_shared/consensus.ts 的 AGREE_THRESHOLDS.regional_stat／riskLevel。
-- 2. 重算現有 pending 的 regional_stat：呼叫既有的共識函式（不手改分數、不 UPDATE 任何正式資料表），
--    只會動 contributions 的共識欄位（target_score…）與派工快照 task_dispatches.verify_target。
--    沒有票的列分數 0 < 1，維持 pending（不會被自動落庫）；已有票且分數到 1 的才會照新門檻轉 verified，之後由 apply-verified 照常落庫。
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
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 3
  END;
END;
$$;

-- 現有 pending 的 regional_stat 以新門檻重算（共識函式會寫 target_score、分數、狀態；沒票的列維持 pending）
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE contribution_type = 'regional_stat' AND status = 'pending' LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END;
$$;

-- 驗證池的目標快照（target_score 為 NULL 時才會用到）一併對齊，免得殘留舊的 3
UPDATE task_dispatches d
   SET verify_target = contribution_effective_agree(c.id)
  FROM contributions c
 WHERE d.task_id LIKE 'verify:%'
   AND c.id = substring(d.task_id FROM 8)::uuid
   AND c.contribution_type = 'regional_stat'
   AND c.status = 'pending';
