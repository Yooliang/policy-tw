-- 系統來源票（Jev）：4 票變 3+1。設計見 docs/BLUEPRINT-jev-decisions.md §3-1（2026-09-19 改寫）。
--
-- 使用者裁決（2026-09-19）：代理的價值是找第二、第三個可信來源；Jev 的工作是核「提交者附的那個來源」
-- 支不支持這筆宣稱。所以 Jev 明確有一票，但那一票有形狀：
--   supported（機率 ≥ 門檻）  → 佔一個席位：代理 agree 門檻 −1，但最少仍要 1 張代理票，Jev 永遠不能單獨通過
--   not_supported（≥ 門檻）  → 算 1 張 disagree：1 張代理反對 + Jev 就進裁決
--   cannot_tell 或機率不到  → 棄權，門檻照舊
-- 只算有來源可核的型別；裁決、移除、no_change 沒有來源，不算。
--
-- 為什麼 agree_count／disagree_count 不把 Jev 加進去：那兩個欄位是「代理投了幾票」，貢獻榜、
-- /next 的候選池（agree_count < 門檻）、以及所有現有的閱讀方式都假設它是代理票。
-- Jev 的票只在這支函式判狀態時生效；要看它投了什麼，讀 jev_decisions。

-- 1. jev_decisions 開放新的主體與題目
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_subject_type_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_subject_type_check
  CHECK (subject_type IN ('policy', 'identity_review', 'politician_pair', 'contribution'));
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support'));

-- 2. 哪些型別有系統票（SQL 與 TS 各一份，thresholds.test 盯著一致）
CREATE OR REPLACE FUNCTION system_vote_eligible(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('policy', 'candidacy', 'politician', 'correction', 'policy_progress')
$$;

-- 3. 這筆貢獻目前的系統票：'supported'／'not_supported'／NULL（棄權）
CREATE OR REPLACE FUNCTION contribution_system_vote(p_contribution_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT j.choice
  FROM jev_decisions j
  JOIN contributions c ON c.id = p_contribution_id
  WHERE j.subject_type = 'contribution' AND j.subject_id = p_contribution_id::TEXT
    AND j.question = 'source_support'
    AND j.choice IN ('supported', 'not_supported')
    AND j.probability >= system_one_min_probability()
    AND system_vote_eligible(c.contribution_type)
  ORDER BY j.asked_at DESC
  LIMIT 1
$$;

-- 4. 計票：代理票照舊去重；系統票只在判狀態時生效
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_status TEXT; v_new TEXT; v_need INTEGER;
  v_sys TEXT; v_need_eff INTEGER; v_disagree_eff INTEGER;
BEGIN
  SELECT
    COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'agree'),
    COUNT(DISTINCT verifier_ip_hash) FILTER (WHERE verdict = 'disagree'),
    COUNT(*) FILTER (WHERE verdict = 'unsure')
  INTO v_agree, v_disagree, v_unsure
  FROM contribution_votes WHERE contribution_id = p_contribution_id;

  SELECT status, contribution_required_agree(contribution_type, payload, source_urls) INTO v_status, v_need
  FROM contributions WHERE id = p_contribution_id;

  -- 系統來源票：supported 佔一席（最少仍要 1 張代理票）；not_supported 算一張反對
  v_sys := contribution_system_vote(p_contribution_id);
  v_need_eff := CASE WHEN v_sys = 'supported' THEN GREATEST(1, v_need - 1) ELSE v_need END;
  v_disagree_eff := v_disagree + CASE WHEN v_sys = 'not_supported' THEN 1 ELSE 0 END;

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 兩張反對＝爭議；一張反對但同意已達標，也是爭議（不能既不通過又不裁決）
    IF v_disagree_eff >= 2 OR (v_disagree_eff >= 1 AND v_agree >= v_need_eff) THEN v_new := 'disputed';
    ELSIF v_agree >= v_need_eff AND v_disagree_eff = 0 THEN v_new := 'verified';
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
COMMENT ON FUNCTION contribution_apply_consensus IS
  '代理票依來源 IP 去重；系統來源票（Jev ≥門檻）supported 讓門檻 −1（最少 1）、not_supported 算一張反對。';

-- 5. 預判候選：pending、有來源、型別合格、還沒判過 source_support 的
CREATE OR REPLACE FUNCTION system_one_precheck_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (contribution_id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND system_vote_eligible(c.contribution_type)
    AND c.source_urls IS NOT NULL AND array_length(c.source_urls, 1) >= 1
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
    )
  ORDER BY c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;

-- 6. 排程：每 15 分鐘預判一批。不帶金鑰（開源倉庫），端點自己有成本上限
SELECT cron.unschedule('system-one-precheck-15min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-precheck-15min');
SELECT cron.schedule(
  'system-one-precheck-15min',
  '7,22,37,52 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=precheck&limit=20',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
