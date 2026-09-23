-- 退件門檻固定，不跟著目標分數放大（小良哥 2026-09-23）
--
-- 09-21 分數制：分數 ≥ 目標→上線、≤ −目標→退件，兩邊對稱。但目標會被往上調：Jev 核提交者的來源判「不支持」→ 目標 4，
-- 退件就要 −4——Jev 已經說這筆來源撐不住，反而要更多反對票才退得掉，方向相反（實查 4 筆等票中的貢獻是這狀態）。
-- 票數預算（Jev 依風險維度加成 0～5）若接上，目標可到 5～7，退件要 −5～−7，風險越高越難退，更不合理。
--
-- 改成：上線門檻照目標走；退件門檻固定 −3（不動正式資料的型別 −2），不隨 Jev 的調整變動。
-- 目標被調高只代表「要更多證據才敢上線」，不代表「要更多證據才能退」。
-- 這是對 09-21 §8.1「≤ −目標 直接 rejected」的更正（docs/DECISIONS.md 09-23）。

CREATE OR REPLACE FUNCTION contribution_reject_floor(p_type TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 2
    ELSE 3
  END;
$$;
COMMENT ON FUNCTION contribution_reject_floor IS
  '退件門檻：分數 ≤ −這個數就退件。固定 3（不動正式資料的型別 2），不隨目標分數（系統票、票數預算）調整。跟 _shared/consensus.ts 的 rejectFloor 同步。';

CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_new TEXT; v_target INTEGER; v_reject INTEGER;
BEGIN
  -- 每個來源 IP 只算最新那一票（沿用「代理票依來源 IP 去重」的精神）
  WITH latest AS (
    SELECT DISTINCT ON (verifier_ip_hash) verifier_ip_hash, verdict, COALESCE(weight, contribution_vote_weight(verdict, judge_backed)) AS weight
    FROM contribution_votes WHERE contribution_id = p_contribution_id
    ORDER BY verifier_ip_hash, created_at DESC
  )
  SELECT COUNT(*) FILTER (WHERE verdict = 'agree'),
         COUNT(*) FILTER (WHERE verdict = 'disagree'),
         COUNT(*) FILTER (WHERE verdict = 'unsure'),
         COALESCE(SUM(weight), 0),
         COUNT(*) FILTER (WHERE verdict IN ('agree', 'disagree'))
    INTO v_agree, v_disagree, v_unsure, v_score, v_ips
    FROM latest;

  SELECT status, contribution_type INTO v_status, v_type FROM contributions WHERE id = p_contribution_id;
  v_target := COALESCE(contribution_effective_agree(p_contribution_id), 2);
  v_reject := contribution_reject_floor(v_type);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 退件門檻固定（2026-09-23）：不用 −v_target，目標被 Jev 調高時退件不該跟著變難
    IF v_score <= -v_reject THEN
      v_new := 'rejected';
    ELSIF v_score >= v_target
      -- 高風險型別的分數不得由單一來源 IP 湊足：分數高不等於看過的人多
      AND (v_type NOT IN ('merge_politician', 'candidacy', 'removal') OR v_ips >= 2) THEN
      v_new := 'verified';
    ELSE
      v_new := 'pending';
    END IF;
  END IF;

  UPDATE contributions SET
    agree_count = v_agree,
    disagree_count = v_disagree,
    unsure_count = v_unsure,
    score = v_score,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
    review_notes = CASE WHEN v_new = 'rejected' AND v_status <> 'rejected'
                        THEN COALESCE(review_notes || E'\n', '') || '[系統] 分數 ' || v_score || ' ≤ −退件門檻 ' || v_reject || '，依分數制退件'
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;
COMMENT ON FUNCTION contribution_apply_consensus IS
  '分數制（2026-09-21；退件門檻 09-23 固定）：每個來源 IP 只算最新一票的 weight，總分 ≥ 目標→verified（高風險型別另要求 ≥2 IP）、≤ −退件門檻（3，不動正式資料的型別 2，不隨目標調整）→rejected、其餘 pending。目標＝contribution_effective_agree()。不再產生 disputed。';
