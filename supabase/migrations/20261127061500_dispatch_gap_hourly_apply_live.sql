-- 派工缺口每小時比對：mode＝'live' 的臂改為「比對並修正」，mode＝'shadow'／'off' 的臂維持只記錄
--
-- 理由：老闆 2026-11-27 要縮短 shadow 期，條件是「漏事件的影響上限從 24 小時縮成 1 小時」。
--   現況：dispatch_gap_shadow_compare()（每小時 cron 經 dispatch_gap_shadow_run()）對所有非 off 的臂只記錄差異，
--         要等每日 03:32 的 dispatch_gap_reconcile_all() 才補，所以 live 臂漏一筆事件最久會錯 24 小時。
--   改後：live 臂每小時比對時直接以整表結果為準補開、補關、補更新（同一支 dispatch_gap_reconcile_arm，p_apply＝true），
--         漏事件最久錯 1 小時；shadow 臂照舊只寫 dispatch_gap_reconcile_runs 一列、不碰常駐表。
--
-- 改動（三處，其餘逐字沿用 20261126180000／20261126170000 的 dispatch_gap_shadow_compare）：
--   ① 呼叫 reconcile_arm 時 p_apply＝(gap_arm_mode(臂)='live')，mode 字串 live 臂＝'hourly'、其餘＝'shadow'（巡檢可分出每小時修正與每日對帳）。
--   ② dispatch_gap_reconcile_runs.mode 的 CHECK 原本只允許 reconcile／shadow，加入 'hourly'（小表、保留 30 天，換約束瞬間完成）。
--   ③ 有 live 臂要 apply 時，先取與 drain、reconcile_all 同一把 advisory lock（hashtext('dispatch_gap_writer')），
--      兩個寫入者不同時動常駐表；拿不到鎖（剛好撞上 drain）這一輪 live 臂退回只記錄（mode＝'shadow'、不補），下一小時再補。
--      shadow 臂不需要鎖（從不寫常駐表），沒有 live 臂時完全不取鎖，行為與前一版相同。
--
-- apply 的範圍：dispatch_gap_apply_fresh 只對 dispatch_gaps（常駐缺口表）做 UPDATE／INSERT ON CONFLICT；不碰 task_dispatches，
--   也不碰任何派工佇列。task_dispatches 仍只由 seed_auto_task_queue 寫（總表二段式在 live 時讀常駐表，下一輪 seed 才反映）。
-- 風險：只多 live 臂「有差異才寫」的補開補關（與每日對帳同一套邏輯）；cron 排程與呼叫量不變。
-- 回滾：重貼 20261126180000_dispatch_gaps_phase0b.sql 檔內的 dispatch_gap_shadow_compare 定義（p_apply 固定 false、mode 固定 'shadow'），
--   （'hourly' 已寫入的歷史列留著無害；若要同時還原約束，先 DELETE 那些列再把 CHECK 改回 IN ('reconcile','shadow')）。

ALTER TABLE dispatch_gap_reconcile_runs DROP CONSTRAINT IF EXISTS dispatch_gap_reconcile_runs_mode_check;
ALTER TABLE dispatch_gap_reconcile_runs
  ADD CONSTRAINT dispatch_gap_reconcile_runs_mode_check CHECK (mode IN ('reconcile', 'shadow', 'hourly'));

CREATE OR REPLACE FUNCTION dispatch_gap_shadow_compare(p_arms TEXT[] DEFAULT NULL, p_grace INTERVAL DEFAULT '2 minutes')
RETURNS SETOF dispatch_gap_reconcile_runs
LANGUAGE plpgsql AS $$
DECLARE
  v_arm    TEXT;
  v_row    dispatch_gap_reconcile_runs;
  v_live   BOOLEAN;
  v_lock   BOOLEAN;      -- NULL＝還沒試過；第一支 live 臂才試一次，之後沿用結果
  v_mode   TEXT;
BEGIN
  FOR v_arm IN SELECT arm FROM dispatch_gap_arm_keys WHERE p_arms IS NULL OR arm = ANY (p_arms) ORDER BY arm LOOP
    v_live := (gap_arm_mode(v_arm) = 'live');
    IF v_live AND v_lock IS NULL THEN
      v_lock := pg_try_advisory_xact_lock(hashtext('dispatch_gap_writer'));
    END IF;
    v_live := v_live AND COALESCE(v_lock, false);
    v_mode := CASE WHEN v_live THEN 'hourly' ELSE 'shadow' END;
    BEGIN
      v_row := dispatch_gap_reconcile_arm(v_arm, v_live, v_mode, p_grace);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO dispatch_gap_reconcile_runs (arm, mode, error) VALUES (v_arm, v_mode, left(SQLERRM, 500)) RETURNING * INTO v_row;
    END;
    RETURN NEXT v_row;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION dispatch_gap_shadow_compare(TEXT[], INTERVAL) FROM PUBLIC, anon, authenticated;
