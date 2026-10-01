-- 名冊逐位吻合的參選紀錄：目標分數 1（維護者 2026-10-01 核准；調整 09-19「系統票 3+1」）
--
-- 系統逐位核對中選會登記名冊（system-one?action=roster_batch，model policy-tw/roster-batch-…）判 supported
-- ——姓名、縣市、政黨都對上——原本跟一般 Jev 系統票一樣只讓目標 −1（3→2）。
-- 09-30 實測：名冊吻合的 pending 89 筆，target_score 都是 2、88 筆 0 票。名冊本身就是中選會，
-- 驗證者很難找到不同網域的第二來源拿 +2，實際要兩台機器各投一票。
-- 改成：名冊逐位吻合的 → 目標 1（一張普通同意就過），參選紀錄也不再要求兩台機器；反對照舊能擋（+1−1=0）。
-- 一般 Jev 的 supported 維持 −1。TS 鏡像：_shared/consensus.ts（effectiveRequiredAgree／scoreStatus），
-- roster-match-target.test.ts 盯兩邊。

-- 最新那張有效系統票（同 contribution_system_vote 的合格條件）是名冊逐位核對、而且 supported
CREATE OR REPLACE FUNCTION contribution_roster_matched(p_contribution_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT j.model LIKE 'policy-tw/roster-batch%' AND j.choice = 'supported'
    FROM jev_decisions j
    JOIN contributions c ON c.id = p_contribution_id
    WHERE j.subject_type = 'contribution' AND j.subject_id = p_contribution_id::TEXT
      AND j.question = 'source_support'
      AND j.choice IN ('supported', 'not_supported')
      AND j.probability >= system_one_min_probability()
      AND (system_vote_eligible(c.contribution_type) OR j.model LIKE 'policy-tw/moi-check%')
    ORDER BY j.asked_at DESC
    LIMIT 1
  ), FALSE)
$$;
COMMENT ON FUNCTION contribution_roster_matched IS
  '最新的有效系統票是中選會名冊逐位核對 supported（姓名、縣市、政黨都對上）→ 目標 1、免兩台機器（2026-10-01）';

CREATE OR REPLACE FUNCTION contribution_effective_agree(p_contribution_id UUID) RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE v_need INTEGER; v_sys TEXT;
BEGIN
  SELECT contribution_required_agree(contribution_type, payload, source_urls) INTO v_need
  FROM contributions WHERE id = p_contribution_id;
  IF v_need IS NULL THEN RETURN NULL; END IF;
  v_sys := contribution_system_vote(p_contribution_id);
  RETURN CASE WHEN v_sys = 'supported' AND contribution_roster_matched(p_contribution_id) THEN LEAST(v_need, 1)
              WHEN v_sys = 'supported' THEN GREATEST(1, v_need - 1)
              WHEN v_sys = 'not_supported' THEN v_need + 1
              ELSE v_need END;
END;
$$;
COMMENT ON FUNCTION contribution_effective_agree IS
  '這筆貢獻的目標分數：原門檻依系統票 supported −1（最少 1；名冊逐位吻合直接 1）／not_supported +1。計票、派工池、回應欄位共用這一支。';

-- 計票：同 20260924000013，只在「高風險型別要兩台機器」加上名冊吻合的例外
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
      -- 高風險型別的分數不得由單一來源 IP 湊足：分數高不等於看過的人多。
      -- 名冊逐位吻合的例外（2026-10-01）：系統已逐位核過中選會名冊，就是另一雙眼睛
      AND (v_type NOT IN ('merge_politician', 'candidacy', 'removal') OR v_ips >= 2 OR contribution_roster_matched(p_contribution_id)) THEN
      v_new := 'verified';
    ELSIF (SELECT batch_verified_by FROM contributions WHERE id = p_contribution_id) IS NOT NULL THEN
      -- 隨名冊整批驗證通過（2026-09-24）：系統逐位核對過、名冊那筆也過了，不再逐筆湊票
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
    target_score = v_target,
    voter_ips = v_ips,
    status = v_new,
    verified_at = CASE WHEN v_new = 'verified' THEN COALESCE(verified_at, now()) ELSE verified_at END,
    review_notes = CASE WHEN v_new = 'rejected' AND v_status <> 'rejected'
                        THEN COALESCE(review_notes || E'\n', '') || '[系統] 分數 ' || v_score || ' ≤ −退件門檻 ' || v_reject || '，依分數制退件'
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;

-- 現有名冊吻合的 pending 立刻重算（09-30 實測 89 筆：目標 2 → 1；其中已有一張同意的 1 筆會直接通過）
SELECT contribution_apply_consensus(c.id)
  FROM contributions c
 WHERE c.status = 'pending' AND c.contribution_type = 'candidacy'
   AND contribution_roster_matched(c.id);
