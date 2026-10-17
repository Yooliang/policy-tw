-- 「不確定」第 2 張起每張 −1（維護者 2026-10-17，policy-ops docs/decisions/2026-10-17-不確定計分與投太多輪.md；補充 09-19「我看不到不是我反對」）
-- ============================================================
--
-- 現象：鄭志偉照片（臉書暫時連結已失效）9 票 7 張不確定還在等；查無異動 f708a050 13 票 9 張不確定、拖 15 天。
-- 09-19 起「看不到來源」記 unsure＝0 分，本意是不讓一張打不開的連結變成反對；但 0 分也讓一件打不開的交件永遠不死，驗證者一個接一個投「確認不了」。
--
-- 規則（同一份交件）：第 1 張 unsure 照舊 0 分；第 2 張起每張各 −1。agree／disagree 的權重、系統票、目標分數、退件門檻
-- （contribution_reject_floor：3，不動正式資料的型別 2）都不變。
--
-- 做法：扣在計分這一步（contribution_apply_consensus），不寫進 contribution_votes.weight。
--   罰則只看「每個來源 IP 最新一票是 unsure 的有幾個」＝ GREATEST(n − 1, 0)，與誰先誰後無關——
--   所以不用依 created_at 排序去分第幾張，也不用在改票、補票時回頭重寫別張票的 weight；任何時候重算結果都一樣。
--   weight 欄維持「這一票自己的分數」（unsure 一律 0），contributions.score 才是含罰則的累計分數。
-- TS 鏡像：_shared/consensus.ts 的 unsurePenalty()；守門 unsure-penalty.test.ts（兩邊要一致）。
--
-- 既有等票的交件在這支 migration 裡用同一支函式重算一次：落到退件門檻的走一般退件路徑（contribution_apply_consensus 改狀態，
-- 觸發器 contributions_drop_dispatch 收回驗證列、任務停放解除），跟一張票投下去跌到門檻的副作用相同。
-- 唯讀試算（2026-10-17）：41 份受影響、31 份退件（18 份有同意票但不確定較多）、收回 213 張不確定。
-- 只動正見（public）；日本站（policy_jp）複本暫不跟（policy-jp-dispatch-drift.test.ts 登記「日本站暫不跟」）。

CREATE OR REPLACE FUNCTION contribution_unsure_penalty(p_unsure INTEGER) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(COALESCE(p_unsure, 0) - 1, 0)
$$;
COMMENT ON FUNCTION contribution_unsure_penalty IS
  '同一份交件的不確定罰則（2026-10-17）：第 1 張 unsure 0 分，第 2 張起每張 −1，所以 n 張不確定共扣 GREATEST(n−1, 0) 分。TS 鏡像 unsurePenalty()。';

-- 計票：同 20261006034900，只多「扣不確定罰則」一行與退件說明
CREATE OR REPLACE FUNCTION contribution_apply_consensus(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_agree INTEGER; v_disagree INTEGER; v_unsure INTEGER; v_score INTEGER; v_ips INTEGER;
  v_status TEXT; v_type TEXT; v_payload JSONB; v_new TEXT; v_target INTEGER; v_reject INTEGER;
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
  -- 不確定的罰則（2026-10-17）：第 1 張 0 分、第 2 張起每張 −1；只看張數、不看順序，weight 欄不動
  v_score := v_score - contribution_unsure_penalty(v_unsure);

  SELECT status, contribution_type, payload INTO v_status, v_type, v_payload FROM contributions WHERE id = p_contribution_id;
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
      AND (NOT contribution_needs_two_ips(v_type, v_payload) OR v_ips >= 2 OR contribution_roster_matched(p_contribution_id)) THEN
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
                             || CASE WHEN v_unsure >= 2 THEN '（含不確定 ' || v_unsure || ' 張，第 2 張起每張 −1）' ELSE '' END
                        ELSE review_notes END
  WHERE id = p_contribution_id;
  RETURN v_new;
END;
$$;

-- 既有等票的交件用新規則重算一次（只有不確定 ≥ 2 張的分數會變；其餘重算結果不變，不碰）
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE status = 'pending' AND unsure_count >= 2 ORDER BY created_at LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END $$;
