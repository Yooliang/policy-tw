-- 「同意票已達標、但有一張反對票」不再永久懸空，改為進裁決。
--
-- 2026-09-17 小良哥看那題 Facebook 提問的任務卡：「我看他有出現在任務裡，2 綠 1 紅？」
-- 追下去發現那是制度的死角，不是 bug：
--   通過要 agree ≥ 門檻 **且 disagree = 0**；變成爭議要 disagree ≥ 2。
--   於是「2 同意 1 反對」兩邊都不成立 → 永遠 pending，沒有任何人會再處理它。
--
-- 實查全站有 3 筆卡在這個縫裡，其中兩筆很要緊：
--   - Meshyai 09-12 對那題 Facebook 提問的 no_change（查證過：連結回 400、要登入）
--   - 金門／連江 region 錯置的 task_suggestion（09-12 提出，卡到今天都沒變成任務，
--     今天是維護者手動修掉那筆資料的，流程本身從來沒動）
--
-- 真的有人反對，就該由第三方裁決，不是被無聲擱置。規則改成：
--   disagree ≥ 2，或（同意已達標卻仍有人反對）→ disputed（會自動開裁決任務）
--   同意達標且無人反對 → verified
--   其餘 → pending

CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_status TEXT; v_new TEXT; v_need INTEGER;
BEGIN
  SELECT
    COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'agree'),
    COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'disagree'),
    COUNT(*) FILTER (WHERE verdict = 'unsure')
  INTO v_agree, v_disagree, v_unsure
  FROM contribution_votes WHERE contribution_id = p_contribution_id;

  SELECT status, contribution_required_agree(contribution_type, payload, source_urls) INTO v_status, v_need
  FROM contributions WHERE id = p_contribution_id;
  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 兩張反對＝爭議；一張反對但同意已達標，也是爭議（不能既不通過又不裁決）
    IF v_disagree >= 2 OR (v_disagree >= 1 AND v_agree >= v_need) THEN v_new := 'disputed';
    ELSIF v_agree >= v_need AND v_disagree = 0 THEN v_new := 'verified';
    ELSE v_new := 'pending';
    END IF;
  END IF;

  UPDATE contributions SET
    agree_count = v_agree,
    disagree_count = v_disagree,
    unsure_count = v_unsure,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;

-- 把現在卡在縫裡的重算一次，讓它們馬上進裁決
DO $$
DECLARE r RECORD; v_moved INTEGER := 0;
BEGIN
  FOR r IN
    SELECT id FROM contributions
    WHERE status = 'pending' AND disagree_count >= 1
      AND agree_count >= contribution_required_agree(contribution_type, payload, source_urls)
  LOOP
    PERFORM contribution_apply_consensus(r.id);
    v_moved := v_moved + 1;
  END LOOP;
  RAISE NOTICE '重算了 % 筆卡在「同意達標＋有反對」的貢獻', v_moved;
END $$;
