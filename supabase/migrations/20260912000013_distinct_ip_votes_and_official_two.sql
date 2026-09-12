-- 一個人換一台電腦就能自己核准自己的資料：提交用一個代號、投票用另一個代號，
-- 只要兩次的來源 IP 不同，「不能驗自己提交的」那道檢查就攔不住；
-- 官方來源又只要一票就自動落庫。兩件合起來等於單人可寫入任意資料。
--
-- 這支 migration 動兩件事：
--   1. 計票時同一個來源 IP 只算一票（agree 與 disagree 都算）。投票紀錄全部保留，
--      只是不重複計入，所以稽核軌跡不會被改寫。
--   2. 一般資料的官方來源門檻從 1 票改成 2 票。
-- 兩件要一起做：只改門檻，同一台機器換個代號就能投滿；只去重 IP，一票照樣過關。
--
-- 加減參選人（high）、提議任務與無異動（light）、裁決（adjudication）的數字不變。

DROP FUNCTION IF EXISTS contribution_required_agree(TEXT, JSONB);
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 4 WHEN 'media' THEN 6 WHEN 'social' THEN 8 ELSE 8 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    ELSE 4
  END;
END;
$$;

-- 計票改成依來源 IP 去重：同一台機器不論用幾個代號投票，同一筆貢獻只算一票。
-- unsure 不影響狀態，維持原本的總筆數統計。
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
    IF v_disagree >= 2 THEN v_new := 'disputed';
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

-- 既有 pending 的貢獻重算一次，馬上套用新規則（已經 applied 的不動）。
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE status IN ('pending', 'verified', 'disputed') LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END $$;
