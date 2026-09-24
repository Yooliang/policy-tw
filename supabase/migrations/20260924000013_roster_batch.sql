-- 中選會登記名冊逐位核對＋整批放行（小良哥 2026-09-24 選 B：只對中選會的登記名冊開放讀 PDF，系統整批逐位核對）
--
-- 這是 09-20「系統不解析 PDF」的例外，範圍只限 web.cec.gov.tw/api/file/*.pdf（_shared/cec-roster.ts）。
-- 1. system-one?action=roster_batch（每 10 分鐘）：引用中選會名冊的待驗參選紀錄，逐位比對姓名／縣市／政黨，
--    寫系統票（model policy-tw/roster-batch-…，對得上 supported、對不上 not_supported 並寫原因）——不用 Jev，純比對。
--    實測當天就抓到 wang.shihchieh 當成台中市議員交的 181 位裡，86 位其實是台南、3 位是高雄。
-- 2. 名冊那筆（roster_check）通過落庫時，同一任務、同一來源交的參選紀錄裡系統核對過的，整批標成已驗證（batch_verified_by），
--    計票照舊跑但不再退回 pending（跌到退件門檻仍會退件）；對不上的照舊逐筆驗。

ALTER TABLE contributions ADD COLUMN IF NOT EXISTS batch_verified_by UUID;
COMMENT ON COLUMN contributions.batch_verified_by IS '隨哪一筆名冊清查（roster_check 貢獻）整批驗證通過；NULL＝逐筆驗';

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

-- 還沒核過、引用中選會名冊的待驗參選紀錄（roster_batch 用）
CREATE OR REPLACE FUNCTION roster_batch_candidates(p_limit INTEGER DEFAULT 500)
RETURNS TABLE (id UUID, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.payload, c.source_urls FROM contributions c
   WHERE c.status = 'pending' AND c.contribution_type = 'candidacy'
     AND EXISTS (SELECT 1 FROM unnest(c.source_urls) u WHERE u ~* '^https://web\.cec\.gov\.tw/api/file/[0-9a-f-]+\.pdf$')
     AND NOT EXISTS (SELECT 1 FROM jev_decisions j WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT
                       AND j.question = 'source_support' AND j.model LIKE 'policy-tw/roster-batch%')
   ORDER BY c.created_at
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 1000))
$$;

-- 名冊清查的那一批：同一任務、同一代號或同一來源 IP、前後 6 小時內交的待驗參選紀錄
CREATE OR REPLACE FUNCTION roster_batch_ids(p_roster_id UUID) RETURNS SETOF UUID
LANGUAGE sql STABLE AS $$
  SELECT c.id FROM contributions c JOIN contributions r ON r.id = p_roster_id
   WHERE c.contribution_type = 'candidacy' AND c.status = 'pending'
     AND c.task_id = r.task_id
     AND (c.agent_name = r.agent_name OR c.contributor_ip_hash = r.contributor_ip_hash)
     AND c.created_at BETWEEN r.created_at - INTERVAL '6 hours' AND r.created_at + INTERVAL '6 hours'
$$;

-- 名冊清查通過時呼叫：這批裡系統核對過（roster-batch supported）的，整批標成已驗證
CREATE OR REPLACE FUNCTION roster_batch_approve(p_roster_id UUID) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  UPDATE contributions c
     SET batch_verified_by = p_roster_id, status = 'verified', verified_at = now(),
         review_notes = COALESCE(c.review_notes || E'
', '') || '[batch] 隨名冊清查 ' || p_roster_id || ' 整批驗證通過（系統已逐位核對中選會名冊）'
   WHERE c.id IN (SELECT roster_batch_ids(p_roster_id))
     AND (SELECT j.choice FROM jev_decisions j
           WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
             AND j.model LIKE 'policy-tw/roster-batch%'
           ORDER BY j.asked_at DESC LIMIT 1) = 'supported';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

SELECT cron.unschedule('roster-batch-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'roster-batch-10min');
SELECT cron.schedule('roster-batch-10min', '2,12,22,32,42,52 * * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=roster_batch',
                       headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);
