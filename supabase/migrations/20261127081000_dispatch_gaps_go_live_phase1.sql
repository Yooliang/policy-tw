-- 派工臂事件驅動化：legacy／mismatch／issue_too_broad／ballot_numbers 四支臂切 live（2026-11-27）
--
-- 理由：維護者 2026-11-27 裁示「直接切，不 shadow」，跳過計畫書第 1 期的 7 天雙軌觀察。
--   四支臂是總表最貴的幾支（探針合計約 15 秒，seed 單輪預期 70 秒 → 約 40 秒）。
--   ballot_numbers 是總表的真 UNION 分支，且列在 activity_arm_names()（20261008150000 登記），
--   dispatch_gap_set_mode 的守門（20261127044503，只拒不在 activity_arm_names() 的輔助函式）放行，所以臂名就是 ballot_numbers 本身。
--
-- 做法（一個交易）：
--   ① 四支臂各做一次 dispatch_gap_reconcile_arm(臂, true, 'reconcile', '0 seconds')：切之前先把常駐表 dispatch_gaps
--      對齊即時輸出（missing 補開、extra 補關、changed 改寫，一律套用，不留寬限）。
--   ② dispatch_gap_set_mode(臂, 'live', 備註) ×4：總表這四支臂改讀 dispatch_gaps 開著的列。
--   ③ 自我檢查：四支 mode 都是 live；總表在 live 下跑得動；各臂開著的列數等於對帳當下的即時筆數（不一致整支失敗、全部回滾）。
--
-- 回滾（每支臂一行，下一輪 seed 生效；常駐表留著、事件仍繼續維護，所以隨時可再切回 live）：
--   SELECT dispatch_gap_set_mode('legacy',          'shadow', '回滾');
--   SELECT dispatch_gap_set_mode('mismatch',        'shadow', '回滾');
--   SELECT dispatch_gap_set_mode('issue_too_broad', 'shadow', '回滾');
--   SELECT dispatch_gap_set_mode('ballot_numbers',  'shadow', '回滾');
--   （要完全退回即時算、不再維護常駐表：把 'shadow' 換成 'off'。）
--
-- 風險：
--   · live 之後總表看的是常駐表，事件漏接（觸發器沒涵蓋的來源，見設計文件各期「事件盲區」）會讓缺口晚開或晚收；
--     最久 1 小時由每小時比對修正（PR gaps/live-hourly-apply：live 臂的比對結果直接套用），每日 03:32 對帳兜底。
--   · ballot_numbers 切 shadow 才一天（2026-11-27 起），其餘三支是 11-26 起；雙軌觀察期被跳過，以上面的對帳與每小時套用補。
--   · 本支只切模式，不改任何函式、觸發器、排程；總表與 seed 一字不動。
--   · 遷移內 reconcile 會各跑一次整臂（mismatch 約 8 秒、issue_too_broad 約 3 秒、legacy 約 2 秒、ballot_numbers 約 1 秒），
--     所以交易內放寬逾時。

SET LOCAL statement_timeout = '300s';
SET LOCAL work_mem = '16MB';   -- 13:56 資料庫重啟疑似 migration 初始灌入吃記憶體：每支臂各自一段、各自一個語句，不堆成一個大查詢

-- ── 一、legacy：先對齊、再切 live、再檢查開著的列數＝對帳當下即時筆數 ──
DO $$
DECLARE
  v_arm  CONSTANT TEXT := 'legacy';
  v_run  dispatch_gap_reconcile_runs;
  v_open BIGINT;
BEGIN
  v_run := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds');
  PERFORM dispatch_gap_set_mode(v_arm, 'live', '2026-11-27 老闆裁示直接切；回滾：dispatch_gap_set_mode(''legacy'',''shadow'')');
  SELECT count(*) INTO v_open FROM dispatch_gaps g WHERE g.arm = v_arm AND g.closed_at IS NULL;
  IF v_open <> v_run.live_count THEN
    RAISE EXCEPTION '切 live 前對齊失敗：臂 % 常駐表開著 % 列，即時輸出 % 列', v_arm, v_open, v_run.live_count;
  END IF;
  RAISE NOTICE '切 live：臂 % 對齊前 missing=% extra=% changed=%，切換後開著 % 列', v_arm, v_run.missing, v_run.extra, v_run.changed, v_open;
END
$$;

-- ── 二、mismatch（最貴，約 8 秒）──
DO $$
DECLARE
  v_arm  CONSTANT TEXT := 'mismatch';
  v_run  dispatch_gap_reconcile_runs;
  v_open BIGINT;
BEGIN
  v_run := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds');
  PERFORM dispatch_gap_set_mode(v_arm, 'live', '2026-11-27 老闆裁示直接切；回滾：dispatch_gap_set_mode(''mismatch'',''shadow'')');
  SELECT count(*) INTO v_open FROM dispatch_gaps g WHERE g.arm = v_arm AND g.closed_at IS NULL;
  IF v_open <> v_run.live_count THEN
    RAISE EXCEPTION '切 live 前對齊失敗：臂 % 常駐表開著 % 列，即時輸出 % 列', v_arm, v_open, v_run.live_count;
  END IF;
  RAISE NOTICE '切 live：臂 % 對齊前 missing=% extra=% changed=%，切換後開著 % 列', v_arm, v_run.missing, v_run.extra, v_run.changed, v_open;
END
$$;

-- ── 三、issue_too_broad ──
DO $$
DECLARE
  v_arm  CONSTANT TEXT := 'issue_too_broad';
  v_run  dispatch_gap_reconcile_runs;
  v_open BIGINT;
BEGIN
  v_run := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds');
  PERFORM dispatch_gap_set_mode(v_arm, 'live', '2026-11-27 老闆裁示直接切；回滾：dispatch_gap_set_mode(''issue_too_broad'',''shadow'')');
  SELECT count(*) INTO v_open FROM dispatch_gaps g WHERE g.arm = v_arm AND g.closed_at IS NULL;
  IF v_open <> v_run.live_count THEN
    RAISE EXCEPTION '切 live 前對齊失敗：臂 % 常駐表開著 % 列，即時輸出 % 列', v_arm, v_open, v_run.live_count;
  END IF;
  RAISE NOTICE '切 live：臂 % 對齊前 missing=% extra=% changed=%，切換後開著 % 列', v_arm, v_run.missing, v_run.extra, v_run.changed, v_open;
END
$$;

-- ── 四、ballot_numbers ──
DO $$
DECLARE
  v_arm  CONSTANT TEXT := 'ballot_numbers';
  v_run  dispatch_gap_reconcile_runs;
  v_open BIGINT;
BEGIN
  v_run := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds');
  PERFORM dispatch_gap_set_mode(v_arm, 'live', '2026-11-27 老闆裁示直接切；回滾：dispatch_gap_set_mode(''ballot_numbers'',''shadow'')');
  SELECT count(*) INTO v_open FROM dispatch_gaps g WHERE g.arm = v_arm AND g.closed_at IS NULL;
  IF v_open <> v_run.live_count THEN
    RAISE EXCEPTION '切 live 前對齊失敗：臂 % 常駐表開著 % 列，即時輸出 % 列', v_arm, v_open, v_run.live_count;
  END IF;
  RAISE NOTICE '切 live：臂 % 對齊前 missing=% extra=% changed=%，切換後開著 % 列', v_arm, v_run.missing, v_run.extra, v_run.changed, v_open;
END
$$;

-- 自我檢查：四支都是 live，而且 live 下的總表跑得動
DO $$
DECLARE
  v_live INTEGER;
  v_rows BIGINT;
BEGIN
  SELECT count(*) INTO v_live FROM dispatch_gap_arms a
   WHERE a.arm IN ('legacy', 'mismatch', 'issue_too_broad', 'ballot_numbers') AND a.mode = 'live';
  IF v_live <> 4 THEN
    RAISE EXCEPTION '切 live 後 dispatch_gap_arms 只有 % 支是 live（應為 4）', v_live;
  END IF;

  SELECT count(*) INTO v_rows FROM contribution_auto_tasks_arms();
  RAISE NOTICE '切 live 後總表輸出 % 列', v_rows;
END
$$;
