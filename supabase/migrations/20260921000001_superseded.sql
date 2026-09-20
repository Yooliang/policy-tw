-- 同一宣稱已上線，其他還在等票的提交要收編（使用者 2026-09-21）。
-- 蔡培慧 2024 立委落選那筆：三個代理各交一份（都在 #70「重複提交自動轉成同意票」上線之前），一筆已上線、兩筆還躺著等票——
-- 驗證者會繼續把票投在已成事實的東西上，頁面也一直顯示三筆。全站這種上線前的重複還有 11 群、15 筆。
--
-- 1. 新狀態 superseded：「同一宣稱已由別筆上線」。不是退件（內容沒錯），也不是通過（沒有各自落庫）。
-- 2. 一次性回補：#70 之前留下的 candidacy 重複，照 #70 的規則併成最早那筆的同意票（不同來源 IP 才算一票）；
--    最早那筆已上線的就只收編。之後由 apply 路徑（TS supersedeDuplicates）在每次上線時做。

ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_status_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_status_check
  CHECK (status IN ('pending', 'verified', 'disputed', 'rejected', 'applied', 'apply_failed', 'reverted', 'superseded'));

DO $$
DECLARE g RECORD; d RECORD; v_target contributions%ROWTYPE; v_votes INTEGER := 0; v_superseded INTEGER := 0;
BEGIN
  FOR g IN
    WITH k AS (
      SELECT id, agent_name, contributor_ip_hash, created_at, status,
             lower(regexp_replace(coalesce(payload->>'politician_id','') || '|' || coalesce(payload->>'election_id','') || '|' || coalesce(payload->>'election_type','') || '|' || coalesce(payload->>'candidate_status','') || '|' || coalesce(payload->>'election_result',''), '\s+', '', 'g')) AS key
      FROM contributions
      WHERE contribution_type = 'candidacy' AND payload->>'politician_id' IS NOT NULL
        AND status IN ('pending', 'verified', 'applied')
    )
    SELECT key FROM k GROUP BY key HAVING count(*) FILTER (WHERE status = 'pending') >= 1 AND count(*) >= 2
  LOOP
    -- 目標：已上線的那筆優先，否則最早的一筆
    SELECT c.* INTO v_target FROM contributions c
    WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified', 'applied')
      AND lower(regexp_replace(coalesce(c.payload->>'politician_id','') || '|' || coalesce(c.payload->>'election_id','') || '|' || coalesce(c.payload->>'election_type','') || '|' || coalesce(c.payload->>'candidate_status','') || '|' || coalesce(c.payload->>'election_result',''), '\s+', '', 'g')) = g.key
    ORDER BY (c.status = 'applied') DESC, c.created_at ASC LIMIT 1;
    FOR d IN
      SELECT c.* FROM contributions c
      WHERE c.id <> v_target.id AND c.contribution_type = 'candidacy' AND c.status = 'pending'
        AND lower(regexp_replace(coalesce(c.payload->>'politician_id','') || '|' || coalesce(c.payload->>'election_id','') || '|' || coalesce(c.payload->>'election_type','') || '|' || coalesce(c.payload->>'candidate_status','') || '|' || coalesce(c.payload->>'election_result',''), '\s+', '', 'g')) = g.key
    LOOP
      -- 目標還在等票：重複提交＝一張同意票（不同 IP、還沒投過、不是目標的提交者）
      IF v_target.status IN ('pending', 'verified')
         AND d.contributor_ip_hash IS DISTINCT FROM v_target.contributor_ip_hash
         AND NOT EXISTS (SELECT 1 FROM contribution_votes v WHERE v.contribution_id = v_target.id AND v.verifier_ip_hash = d.contributor_ip_hash) THEN
        INSERT INTO contribution_votes (contribution_id, verdict, note, agent_name, agent_tool, verifier_ip_hash, actor_id)
        VALUES (v_target.id, 'agree', '重複提交併入（2026-09-21 回補 #70 之前的重複）：' || d.id::TEXT, d.agent_name, d.agent_tool, d.contributor_ip_hash, d.actor_id);
        v_votes := v_votes + 1;
      END IF;
      UPDATE contributions SET status = 'superseded',
        review_notes = '同一宣稱已由 ' || coalesce(v_target.agent_name, '?') || ' 的提交（' || v_target.id::TEXT || '）' || CASE WHEN v_target.status = 'applied' THEN '上線' ELSE '先交，這筆併成它的同意票' END
      WHERE id = d.id;
      v_superseded := v_superseded + 1;
    END LOOP;
    IF v_target.status IN ('pending', 'verified') THEN PERFORM contribution_apply_consensus(v_target.id); END IF;
  END LOOP;
  RAISE NOTICE '回補：併成同意票 % 張、收編 % 筆', v_votes, v_superseded;
END $$;
