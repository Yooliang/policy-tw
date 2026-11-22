-- 日本站計分：不確定票不再扣分，只計入投太多輪（#1031 的 JP 版；維護者 2026-11-22 17:10 點頭「日本站第 1 項」）
--
-- 背景：台灣站 20261122170000 已把 contribution_unsure_penalty 改恆回 0、退件備註不再印「第 2 張起每張 −1」；
-- 日本站（20261102230000）原本抄的是舊罰則（第 2 張起每張 −1），這支讓兩站一致。
--
-- 改了什麼（只動 policy_jp）：
--   1. policy_jp.contribution_unsure_penalty 恆回 0（函式留著，呼叫端不必動）。
--   2. policy_jp.contribution_apply_consensus：計分註解改寫、退件備註不再印「第 2 張起每張 −1」，其餘與 20261104130000 的日本版逐字相同。
-- 不動：unsure 單票權重 0、unsure_count 欄、投太多輪的張數（contribution_overvoted_* 與 vote_baseline 仍把 unsure 算進票數）。
-- 不回頭改資料：不 UPDATE 任何交件；已退件的維持原判，pending 的件下一次計分自然套新規則。
-- 回滾：重貼 20261102230000 的 policy_jp.contribution_unsure_penalty 與 20261104130000 的 policy_jp.contribution_apply_consensus。

CREATE OR REPLACE FUNCTION policy_jp.contribution_unsure_penalty(p_unsure INTEGER) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT 0
$$;

CREATE OR REPLACE FUNCTION policy_jp.contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_payload JSONB; v_new TEXT; v_target INTEGER; v_reject INTEGER;
BEGIN
  -- 每個投票人只算最新那一票（維護者 2026-11-04：投票不看 IP，同網段的兩個代理各算一票）。
  -- 投票人的鍵：DiTrust 帳號＝actor_id，匿名＝小寫代號（TS 鏡像 consensus.ts 的 voterKey）。
  WITH latest AS (
    SELECT DISTINCT ON (voter_key) voter_key, verdict, COALESCE(weight, policy_jp.contribution_vote_weight(verdict, judge_backed)) AS weight
    FROM (SELECT *, CASE WHEN actor_id LIKE 'ditrust:%' THEN actor_id ELSE lower(agent_name) END AS voter_key
            FROM policy_jp.contribution_votes WHERE contribution_id = p_contribution_id) vv
    ORDER BY voter_key, created_at DESC
  )
  SELECT COUNT(*) FILTER (WHERE verdict = 'agree'),
         COUNT(*) FILTER (WHERE verdict = 'disagree'),
         COUNT(*) FILTER (WHERE verdict = 'unsure'),
         COALESCE(SUM(weight), 0),
         COUNT(*) FILTER (WHERE verdict IN ('agree', 'disagree'))
    INTO v_agree, v_disagree, v_unsure, v_score, v_ips
    FROM latest;
  -- 不確定的罰則：2026-11-22 起恆 0（policy_jp.contribution_unsure_penalty）；weight 欄不動
  v_score := v_score - policy_jp.contribution_unsure_penalty(v_unsure);

  SELECT status, contribution_type, payload INTO v_status, v_type, v_payload FROM policy_jp.contributions WHERE id = p_contribution_id;
  v_target := COALESCE(policy_jp.contribution_effective_agree(p_contribution_id), 2);
  v_reject := policy_jp.contribution_reject_floor(v_type);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 退件門檻固定（2026-09-23）：不用 −v_target，目標被 Jev 調高時退件不該跟著變難
    IF v_score <= -v_reject THEN
      v_new := 'rejected';
    ELSIF v_status = 'disputed' AND EXISTS (
            SELECT 1 FROM policy_jp.contribution_tasks t
             WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.created_by = 'auto-overvoted'
               AND t.target->>'contribution_id' = p_contribution_id::TEXT) THEN
      -- 投太多輪轉來的裁決（20261017020100）：裁決任務開著就留在 disputed，由裁決定案；重算不能把它改回 pending
      -- （保持原狀態，不是「計分產生 disputed」：分數制不產生 disputed 的規則照舊，thresholds.test.ts 盯著）
      v_new := v_status;
    ELSIF v_score >= v_target THEN
      -- 不再要求兩個不同來源（維護者 2026-11-04）：分數到了就過；v_ips 只記不同投票人數
      v_new := 'verified';
    ELSE
      v_new := 'pending';
    END IF;
  END IF;

  UPDATE policy_jp.contributions SET
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
  -- 裁決中的交件被分數退件了：原貢獻已定案，開著的裁決任務沒有意義（同 _shared/adjudication.ts closeAdjudicationTasks）
  IF v_new = 'rejected' AND v_status = 'disputed' THEN
    UPDATE policy_jp.contribution_tasks SET status = 'closed', closed_at = now()
     WHERE task_type = 'adjudicate' AND status = 'open' AND target->>'contribution_id' = p_contribution_id::TEXT;
  END IF;
  RETURN v_new;
END;
$$;
