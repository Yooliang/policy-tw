-- 號次重複檢查每次只撈 50 筆（2026-10-30）
-- 背景：cand-no-check-10min 每次預設撈 200 筆約 20 秒，超過 authenticator 的 8 秒 statement_timeout（57014），整批被取消、積壓越來越多。
-- 改：SQL 函式預設 50 筆；system-one 預設也是 50，遇超時減半重試（下限 5）。cron 指令沒帶 limit，不用改。
CREATE OR REPLACE FUNCTION cand_no_dup_check_pending(p_limit INTEGER DEFAULT 50) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_n INTEGER := 0; v_flagged INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.id FROM contributions c
      LEFT JOIN cand_no_dup_checks k ON k.contribution_id = c.id
     WHERE c.contribution_type = 'candidacy' AND c.status = 'pending'
       AND (c.payload->>'cand_no') ~ '^[0-9]{1,6}$'
       AND NOT EXISTS (SELECT 1 FROM jev_decisions j
                        WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
                          AND j.model LIKE 'policy-tw/cand-no-dup%' AND j.choice = 'not_supported')
     ORDER BY k.checked_at NULLS FIRST, c.created_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 1000))
  LOOP
    v_n := v_n + 1;
    IF cand_no_dup_system_check(r.id) = 'not_supported' THEN v_flagged := v_flagged + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_n, 'flagged', v_flagged);
END;
$$;
COMMENT ON FUNCTION cand_no_dup_check_pending IS '輪替檢查帶號次的 pending candidacy（戳記最舊的先），cand-no-check-10min；預設 50 筆（2026-10-30）';
