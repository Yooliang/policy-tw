-- 派工臂事件驅動化：名單族 roster_cec_gap／roster_villages／district_seats／raw:roster_check 四支臂切 live（2026-11-27）
--
-- 理由：維護者 2026-11-27 裁示「直接切，不 shadow」，跳過計畫書第 2 期的 7 天雙軌觀察（含兩個週六）。
--   · 11-27 13:56 與 16:15 資料庫兩次因記憶體吃緊重啟，總表每輪即時算整個名單族（roster_diff_findings 底下七支臂函式、cec_roster_diff 等）是大宗成本之一；
--     四支臂切 live 後總表只讀常駐表 dispatch_gaps 開著的列，seed 單輪要再少算這四支（現算的減少量以部署後 seed_arm_timings 為準，不在這裡寫死）。
--   · 四支都在 activity_arm_names()：roster_cec_gap、roster_villages、district_seats 是總表的 UNION 分支，
--     raw:roster_check 是 raw 分支依任務型別拆出的一型（總表用 'raw:' || task_type 當臂名，20261126180000 的二段式條件就是這樣判 live）。
--     dispatch_gap_set_mode 的守門（只拒不在 activity_arm_names() 的輔助函式）放行，所以臂名就是 raw:roster_check 本身。
--
-- 做法（一個交易，四支各一個 DO 段）：
--   ① 各做一次 dispatch_gap_reconcile_arm(臂, true, 'reconcile', '0 seconds')：切之前先把常駐表 dispatch_gaps 對齊即時輸出
--      （missing 補開、extra 補關、changed 改寫，一律套用，不留寬限）。
--   ② dispatch_gap_set_mode(臂, 'live', 備註)：總表這支臂改讀 dispatch_gaps 開著的列。
--   ③ 檢查開著的列數＝對帳當下的即時筆數（不一致整支失敗、全部回滾）。檢查用「等於」不用「大於 0」：
--      raw:roster_check 與 roster_villages 的 2026 窗口 11-07 起被 activity_overrides 設 closed，對帳當下即時筆數很可能就是 0，那是正常的。
--   結尾自我檢查：live 臂集合＝原四支（legacy、mismatch、issue_too_broad、ballot_numbers）加這四支，共 8 支，不多不少；總表在 live 下跑得動。
--
-- 回滾（每支臂一行，下一輪 seed 生效；常駐表留著、事件仍繼續維護，所以隨時可再切回 live）：
--   SELECT dispatch_gap_set_mode('roster_cec_gap',   'shadow', '回滾');
--   SELECT dispatch_gap_set_mode('roster_villages',  'shadow', '回滾');
--   SELECT dispatch_gap_set_mode('district_seats',   'shadow', '回滾');
--   SELECT dispatch_gap_set_mode('raw:roster_check', 'shadow', '回滾');
--   （要完全退回即時算、不再維護常駐表：把 'shadow' 換成 'off'。）
--
-- 風險：
--   · live 之後總表看的是常駐表，事件漏接會讓缺口晚開或晚收，最久 1 小時由每小時比對修正
--     （live 臂的比對結果直接套用，20261127061500），每日 03:32 對帳兜底。名單族的特有來源：
--     名冊鏡像（cec_roster_units）每日台北 02～06 點更新；開票夜 cec-sync 每 10 分鐘跑，單位事件由 cec-sync 結尾入列；
--     時間型的變化沒有事件（roster_checks 的重查冷卻到期、名冊鏡像 3 天新鮮度過期），一樣靠每小時比對與 03:32 對帳；
--     roster_cec_gap 的「是否已對上」是縣市層級、缺口鍵是鄉鎮層級，同縣市別的鄉鎮連動也靠這兩道補。
--   · 這四支的 shadow 只跑了不到一天（11-27 起），原定 7 天雙軌（含兩個週六）被跳過，以上面的對帳與每小時套用補。
--   · 本支只切模式，不改任何函式、觸發器、排程；總表與 seed 一字不動。
--   · 遷移內 reconcile 各跑一次整臂（roster_cec_gap 含 cec_roster_diff，約數秒），所以交易內放寬逾時、work_mem。

SET LOCAL statement_timeout = '300s';
SET LOCAL work_mem = '16MB';   -- 13:56、16:15 兩次資料庫重啟疑似 migration 初始灌入吃記憶體：每支臂各自一段、各自一個語句，不堆成一個大查詢

-- ── 一、roster_cec_gap：先對齊、再切 live、再檢查開著的列數＝對帳當下即時筆數 ──
DO $$
DECLARE
  v_arm  CONSTANT TEXT := 'roster_cec_gap';
  v_run  dispatch_gap_reconcile_runs;
  v_open BIGINT;
BEGIN
  v_run := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds');
  PERFORM dispatch_gap_set_mode(v_arm, 'live', '2026-11-27 老闆裁示直接切；回滾：dispatch_gap_set_mode(''roster_cec_gap'',''shadow'')');
  SELECT count(*) INTO v_open FROM dispatch_gaps g WHERE g.arm = v_arm AND g.closed_at IS NULL;
  IF v_open <> v_run.live_count THEN
    RAISE EXCEPTION '切 live 前對齊失敗：臂 % 常駐表開著 % 列，即時輸出 % 列', v_arm, v_open, v_run.live_count;
  END IF;
  RAISE NOTICE '切 live：臂 % 對齊前 missing=% extra=% changed=%，切換後開著 % 列', v_arm, v_run.missing, v_run.extra, v_run.changed, v_open;
END
$$;

-- ── 二、roster_villages（2026 窗口 11-07 起 closed，即時筆數可能是 0）──
DO $$
DECLARE
  v_arm  CONSTANT TEXT := 'roster_villages';
  v_run  dispatch_gap_reconcile_runs;
  v_open BIGINT;
BEGIN
  v_run := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds');
  PERFORM dispatch_gap_set_mode(v_arm, 'live', '2026-11-27 老闆裁示直接切；回滾：dispatch_gap_set_mode(''roster_villages'',''shadow'')');
  SELECT count(*) INTO v_open FROM dispatch_gaps g WHERE g.arm = v_arm AND g.closed_at IS NULL;
  IF v_open <> v_run.live_count THEN
    RAISE EXCEPTION '切 live 前對齊失敗：臂 % 常駐表開著 % 列，即時輸出 % 列', v_arm, v_open, v_run.live_count;
  END IF;
  RAISE NOTICE '切 live：臂 % 對齊前 missing=% extra=% changed=%，切換後開著 % 列', v_arm, v_run.missing, v_run.extra, v_run.changed, v_open;
END
$$;

-- ── 三、district_seats ──
DO $$
DECLARE
  v_arm  CONSTANT TEXT := 'district_seats';
  v_run  dispatch_gap_reconcile_runs;
  v_open BIGINT;
BEGIN
  v_run := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds');
  PERFORM dispatch_gap_set_mode(v_arm, 'live', '2026-11-27 老闆裁示直接切；回滾：dispatch_gap_set_mode(''district_seats'',''shadow'')');
  SELECT count(*) INTO v_open FROM dispatch_gaps g WHERE g.arm = v_arm AND g.closed_at IS NULL;
  IF v_open <> v_run.live_count THEN
    RAISE EXCEPTION '切 live 前對齊失敗：臂 % 常駐表開著 % 列，即時輸出 % 列', v_arm, v_open, v_run.live_count;
  END IF;
  RAISE NOTICE '切 live：臂 % 對齊前 missing=% extra=% changed=%，切換後開著 % 列', v_arm, v_run.missing, v_run.extra, v_run.changed, v_open;
END
$$;

-- ── 四、raw:roster_check（raw 分支的一型，整表版＝dispatch_gap_full_raw_roster_check()；2026 窗口 11-07 起 closed，即時筆數可能是 0）──
DO $$
DECLARE
  v_arm  CONSTANT TEXT := 'raw:roster_check';
  v_run  dispatch_gap_reconcile_runs;
  v_open BIGINT;
BEGIN
  v_run := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile', '0 seconds');
  PERFORM dispatch_gap_set_mode(v_arm, 'live', '2026-11-27 老闆裁示直接切；回滾：dispatch_gap_set_mode(''raw:roster_check'',''shadow'')');
  SELECT count(*) INTO v_open FROM dispatch_gaps g WHERE g.arm = v_arm AND g.closed_at IS NULL;
  IF v_open <> v_run.live_count THEN
    RAISE EXCEPTION '切 live 前對齊失敗：臂 % 常駐表開著 % 列，即時輸出 % 列', v_arm, v_open, v_run.live_count;
  END IF;
  RAISE NOTICE '切 live：臂 % 對齊前 missing=% extra=% changed=%，切換後開著 % 列', v_arm, v_run.missing, v_run.extra, v_run.changed, v_open;
END
$$;

-- 自我檢查：live 臂集合＝原四支加這四支（不多不少），而且 live 下的總表跑得動
DO $$
DECLARE
  v_live INTEGER;
  v_rows BIGINT;
BEGIN
  SELECT count(*) INTO v_live FROM dispatch_gap_arms a
   WHERE a.mode = 'live'
     AND a.arm IN ('legacy', 'mismatch', 'issue_too_broad', 'ballot_numbers', 'roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check');
  IF v_live <> 8 OR EXISTS (SELECT 1 FROM dispatch_gap_arms a WHERE a.mode = 'live'
       AND a.arm NOT IN ('legacy', 'mismatch', 'issue_too_broad', 'ballot_numbers', 'roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check')) THEN
    RAISE EXCEPTION '切 live 後 live 臂集合不對：指定八支中有 % 支是 live（應為 8），或有指定以外的 live 臂', v_live;
  END IF;

  SELECT count(*) INTO v_rows FROM contribution_auto_tasks_arms();
  RAISE NOTICE '切 live 後總表輸出 % 列', v_rows;
END
$$;
