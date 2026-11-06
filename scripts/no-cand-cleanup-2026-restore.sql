-- ============================================================
-- 還原 scripts/no-cand-cleanup-2026.sql（policy-ops#182）：用快照表把那批人改回改之前的樣子
--
-- 只還原「現值還是那支腳本寫的」的列：candidacy_status 仍是 withdrawn 才動（之後有人改過的不蓋）。
-- 還原 candidacy_status 時退選旗標觸發器會把 withdrawn_after_filing 清成空（不是退選就清空），舊值本來就是空。
-- 異動紀錄：原本那批 edit_history（agent_name＝no-cand-cleanup-2026-11）標 reverted_at／reverted_by，再補反向各一列。
-- 任務：快照裡的任務若現在還是 closed 且 closed_at 沒變過，改回 open。
-- 結尾是 ROLLBACK＝演練；確認 NOTICE 後改成 COMMIT 再跑一次。
-- ============================================================
BEGIN;

DO $$
DECLARE v_snap BIGINT; v_n BIGINT; v_t BIGINT;
BEGIN
  SELECT count(*) INTO v_snap FROM politician_elections_no_cand_snapshot_20261103;

  CREATE TEMP TABLE _nc_restore ON COMMIT DROP AS
    SELECT s.id, s.candidacy_status, s.withdrawn_after_filing
      FROM politician_elections_no_cand_snapshot_20261103 s
      JOIN politician_elections pe ON pe.id = s.id AND pe.candidacy_status = 'withdrawn';

  UPDATE politician_elections pe SET candidacy_status = r.candidacy_status
    FROM _nc_restore r WHERE pe.id = r.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 舊值若是退選的話旗標要照舊（這批舊值都是 filed，旗標是空；這句只為完整）
  UPDATE politician_elections pe SET withdrawn_after_filing = r.withdrawn_after_filing
    FROM _nc_restore r WHERE pe.id = r.id AND pe.candidacy_status = 'withdrawn';

  UPDATE edit_history SET reverted_at = now(), reverted_by = 'no-cand-cleanup-2026-restore'
   WHERE agent_name = 'no-cand-cleanup-2026-11' AND table_name = 'politician_elections' AND reverted_at IS NULL
     AND record_id IN (SELECT id::TEXT FROM _nc_restore);

  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  SELECT 'politician_elections', r.id::TEXT, 'candidacy_status', to_jsonb('withdrawn'::TEXT), to_jsonb(r.candidacy_status), 'no-cand-cleanup-2026-restore'
    FROM _nc_restore r
  UNION ALL
  SELECT 'politician_elections', r.id::TEXT, 'withdrawn_after_filing', to_jsonb(false), to_jsonb(r.withdrawn_after_filing), 'no-cand-cleanup-2026-restore'
    FROM _nc_restore r;

  UPDATE contribution_tasks t SET status = s.status, closed_at = s.closed_at
    FROM contribution_tasks_no_cand_snapshot_20261103 s
   WHERE t.id = s.id AND t.status = 'closed'
     AND t.closed_at >= (SELECT snapshot_at FROM contribution_tasks_no_cand_snapshot_20261103 LIMIT 1);
  GET DIAGNOSTICS v_t = ROW_COUNT;

  RAISE NOTICE '快照 % 位；還原 % 位（其餘是之後有人改過，沒動）；任務還原 % 張', v_snap, v_n, v_t;
END;
$$;

ROLLBACK; -- 演練。確認後改成 COMMIT 再跑一次
