-- 多個獨立來源降低目標分數（維護者 2026-10-09；工作單 Yooliang/policy-ops#39；裁決 policy-ops docs/decisions/2026-10-09-多個獨立來源降低目標分數.md；協議 1.88.0）
--
-- 系統票（Jev 核對提交者附的來源，system-one?action=precheck）現在最多看 4 個網址，挑出獨立來源
-- （同媒體子網域算同一個、同一篇轉載算同一個，_shared/independent-sources.ts），每個獨立來源各判一次；
-- supported 時把「核得過的獨立來源數」記在 jev_decisions.state.supported_sources。
-- 目標分數：supported 降 1（現行）、2 個以上獨立來源核得過降 2（上限），最低 1——系統票不算分數，所以永遠至少要一張
-- 別台機器（不同 IP）的同意票（自己不能驗自己，verify-handler 的 isSelfVote）。not_supported +1、名冊逐位吻合直接 1，都不變。
-- 舊的系統票（沒有 supported_sources）照舊當 1 個。TS 鏡像：_shared/consensus.ts effectiveRequiredAgree，thresholds.test.ts 盯兩邊。

-- 最新那張有效系統票（同 contribution_system_vote 的合格條件）是 supported 時，核得過幾個獨立來源（1～2；不是 supported＝NULL）
CREATE OR REPLACE FUNCTION contribution_system_vote_sources(p_contribution_id UUID) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN j.choice = 'supported'
              THEN LEAST(2, GREATEST(1, COALESCE(CASE WHEN jsonb_typeof(j.state->'supported_sources') = 'number'
                                                      THEN floor((j.state->>'supported_sources')::NUMERIC)::INTEGER END, 1)))
         END
  FROM jev_decisions j
  JOIN contributions c ON c.id = p_contribution_id
  WHERE j.subject_type = 'contribution' AND j.subject_id = p_contribution_id::TEXT
    AND j.question = 'source_support'
    AND j.choice IN ('supported', 'not_supported')
    AND j.probability >= system_one_min_probability()
    AND (system_vote_eligible(c.contribution_type) OR j.model LIKE 'policy-tw/moi-check%')
  ORDER BY j.asked_at DESC
  LIMIT 1
$$;
COMMENT ON FUNCTION contribution_system_vote_sources IS
  '最新有效系統票 supported 時核得過的獨立來源數（1～2，沒記＝1）；contribution_effective_agree 依它降 1～2 分（policy-ops#39）';

CREATE OR REPLACE FUNCTION contribution_effective_agree(p_contribution_id UUID) RETURNS INTEGER
LANGUAGE plpgsql STABLE AS $$
DECLARE v_need INTEGER; v_sys TEXT;
BEGIN
  SELECT contribution_required_agree(contribution_type, payload, source_urls) INTO v_need
  FROM contributions WHERE id = p_contribution_id;
  IF v_need IS NULL THEN RETURN NULL; END IF;
  v_sys := contribution_system_vote(p_contribution_id);
  RETURN CASE WHEN v_sys = 'supported' AND contribution_roster_matched(p_contribution_id) THEN LEAST(v_need, 1)
              WHEN v_sys = 'supported' THEN GREATEST(1, v_need - COALESCE(contribution_system_vote_sources(p_contribution_id), 1))
              WHEN v_sys = 'not_supported' THEN v_need + 1
              ELSE v_need END;
END;
$$;
COMMENT ON FUNCTION contribution_effective_agree IS
  '這筆貢獻的目標分數：原門檻依系統票 supported −1、兩個以上獨立來源核得過 −2（最少 1；名冊逐位吻合直接 1）／not_supported +1。計票、派工池、回應欄位共用這一支。';

-- 已經在等票的、這次不重算（舊系統票沒有 supported_sources，目標不會變）；之後新判的照新規則，contribution_apply_consensus 照常寫 target_score
