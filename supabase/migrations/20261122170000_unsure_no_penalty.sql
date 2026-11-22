-- 不確定票不再扣分，只計入投太多輪（維護者 2026-11-22 14:45 裁示：「unsure 將他改成不扣分」）
--
-- 背景：2026-10-17（協議 1.95.0，20261017020000）起，同一份交件的 unsure 第 2 張起每張 −1，當初目的是防代理洗輪次；
-- 現在這件事由「驗證票投太多輪停派線」（vote_baseline 每小時重算）接管。11-21 夜間 74 筆退件有 25 筆含不確定罰分，
-- 待驗證「差一分」的件多數也是被它扣的。
--
-- 改了什麼（只動正見 public；日本站 policy_jp 複本照舊不跟，policy-jp-dispatch-drift.test.ts 登記）：
--   1. contribution_unsure_penalty 恆回 0（函式與 TS 鏡像 unsurePenalty() 留著，呼叫端不必動）。
--   2. contribution_apply_consensus：退件備註不再印「第 2 張起每張 −1」，其餘與 20261104130000 逐字相同。
-- 不動：unsure 單票權重 0、unsure_count 欄、驗證票投太多輪的張數（contribution_overvoted_* 與 vote_baseline 仍把 unsure 算進票數）。
-- 不回頭改資料：不 UPDATE 任何交件；已退件的維持原判。仍 pending 的件下一次計分（有人投票、或任何呼叫 apply_consensus）會自然套新規則。
-- 回滾：重貼 20261104130000 的 contribution_apply_consensus 與 20261017020000 的 contribution_unsure_penalty。

CREATE OR REPLACE FUNCTION contribution_unsure_penalty(p_unsure INTEGER) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT 0
$$;
COMMENT ON FUNCTION contribution_unsure_penalty IS
  '不確定不扣分（2026-11-22 起恆 0；2026-10-17～11-22 曾是第 2 張起每張 −1）。unsure 仍計入驗證票投太多輪的張數。TS 鏡像 unsurePenalty()。';

CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_payload JSONB; v_new TEXT; v_target INTEGER; v_reject INTEGER;
BEGIN
  -- 每個投票人只算最新那一票（維護者 2026-11-04：投票不看 IP，同網段的兩個代理各算一票）。
  -- 投票人的鍵：DiTrust 帳號＝actor_id，匿名＝小寫代號（TS 鏡像 consensus.ts 的 voterKey）。
  WITH latest AS (
    SELECT DISTINCT ON (voter_key) voter_key, verdict, COALESCE(weight, contribution_vote_weight(verdict, judge_backed)) AS weight
    FROM (SELECT *, CASE WHEN actor_id LIKE 'ditrust:%' THEN actor_id ELSE lower(agent_name) END AS voter_key
            FROM contribution_votes WHERE contribution_id = p_contribution_id) vv
    ORDER BY voter_key, created_at DESC
  )
  SELECT COUNT(*) FILTER (WHERE verdict = 'agree'),
         COUNT(*) FILTER (WHERE verdict = 'disagree'),
         COUNT(*) FILTER (WHERE verdict = 'unsure'),
         COALESCE(SUM(weight), 0),
         COUNT(*) FILTER (WHERE verdict IN ('agree', 'disagree'))
    INTO v_agree, v_disagree, v_unsure, v_score, v_ips
    FROM latest;
  -- 不確定的罰則：2026-11-22 起恆 0（contribution_unsure_penalty）；weight 欄不動
  v_score := v_score - contribution_unsure_penalty(v_unsure);

  SELECT status, contribution_type, payload INTO v_status, v_type, v_payload FROM contributions WHERE id = p_contribution_id;
  v_target := COALESCE(contribution_effective_agree(p_contribution_id), 2);
  v_reject := contribution_reject_floor(v_type);

  v_new := v_status;
  IF v_status IN ('pending', 'verified', 'disputed') THEN
    -- 退件門檻固定（2026-09-23）：不用 −v_target，目標被 Jev 調高時退件不該跟著變難
    IF v_score <= -v_reject THEN
      v_new := 'rejected';
    ELSIF v_status = 'disputed' AND EXISTS (
            SELECT 1 FROM contribution_tasks t
             WHERE t.task_type = 'adjudicate' AND t.status = 'open' AND t.created_by = 'auto-overvoted'
               AND t.target->>'contribution_id' = p_contribution_id::TEXT) THEN
      -- 投太多輪轉來的裁決（20261017020100）：裁決任務開著就留在 disputed，由裁決定案；重算不能把它改回 pending
      -- （保持原狀態，不是「計分產生 disputed」：分數制不產生 disputed 的規則照舊，thresholds.test.ts 盯著）
      v_new := v_status;
    ELSIF v_score >= v_target THEN
      -- 不再要求兩個不同來源（維護者 2026-11-04）：分數到了就過；v_ips 只記不同投票人數
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
  -- 裁決中的交件被分數退件了：原貢獻已定案，開著的裁決任務沒有意義（同 _shared/adjudication.ts closeAdjudicationTasks）
  IF v_new = 'rejected' AND v_status = 'disputed' THEN
    UPDATE contribution_tasks SET status = 'closed', closed_at = now()
     WHERE task_type = 'adjudicate' AND status = 'open' AND target->>'contribution_id' = p_contribution_id::TEXT;
  END IF;
  RETURN v_new;
END;
$$;

