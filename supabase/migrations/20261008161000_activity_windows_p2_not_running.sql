-- 派工與排程的啟用時間窗，P2（一支臂一個 PR）：not_running——被標成不參選、沒人對過登記名冊的參選紀錄（2026-10-08，docs/PLAN-task-activation.md）
-- ============================================================
--
-- P2 一臂一個 PR 的第六支：臂內寫死的兩個日期條件翻成規則，今天（2026-10-08）派工輸出逐件不變。
--
-- not_running（contribution_auto_tasks_not_running，產出 not_running_recheck、task_id＝auto:not_running_recheck:<參選紀錄 id>）：
--   臂內的日期條件（WHERE 裡兩處）：
--     (1) s.registration_closed_on <= CURRENT_DATE            登記已經截止（名冊查得到了才問「他有沒有登記」）
--     (2) (e.election_date IS NULL OR e.election_date >= CURRENT_DATE)   投票日還沒過（過了就該問結果，不必再問有沒有登記）
--   這是第二支「有迄日」的臂（第一支是 party_roster）：起點是登記截止，迄點是投票日當天。
--
-- 規則（把 P1 的「永遠開」種子原地改成窗口，rule_id 不變）：
--   * activity='not_running'：window_kind='event'、from_kind='registration_close'、from_offset=0、until_kind='polling'、until_offset=0、min_status='announced'；範圍不限。
--       - 起日：登記截止當天起（含當天），跟原條件 registration_closed_on <= CURRENT_DATE 同；迄日：投票日當天（含），跟原條件 election_date >= CURRENT_DATE 同。
--         2026：09-03 關、09-04 開、11-28 開、11-29 關。
--       - 日界：規則用台北時間（activity_today()），原條件的 CURRENT_DATE 是資料庫 UTC 的日期，所以窗口比原本早 8 小時開、早 8 小時關。今天沒有任何一場選舉落在這 8 小時內，輸出不變。
--       - 登記截止的里程碑是「每個職位一列」（election_milestones 的 registration_close，election_type 填職位，來自 roster_check_scope.registration_closed_on，
--         20261008140000 之後由里程碑衍生）；臂的 target 帶 election_id 與 election_type，規則找得到同職位的那一列。
--       - min_status 用預設 announced：「預估」的登記截止日不開窗（原條件把 scope 欄位當事實；欄位現在只有官方公告過的日期，里程碑 status 是 done）。
--       - 屆別：不限定。每場選舉各自從自己的登記截止到自己的投票日，2028 不用再改（要先有那一場的 registration_close 里程碑）。
--   * 2022、2024 與重行選舉沒有 registration_close 里程碑，窗口永遠關。這不改變今天的輸出：臂本來就 JOIN roster_check_scope（只有 2026 有列），
--     舊屆別現行輸出就是 0（唯讀查正式庫快照：not_running 分支的列 election_id 全是 2026）；而且舊屆別的投票日都過了，原條件 (2) 本來也不成立。不需要另外想辦法讓舊屆輸出不變。
--   * 沒有 election_date 的選舉：原條件 (2) 把 NULL 當成「還沒投票」而開著；沒有投票日就沒有 polling 里程碑，規則找不到迄點＝關（fail closed）。
--     正式庫 elections 每一場都有投票日（activity_health 的 election_without_polling 是空的），所以今天沒有差別；以後有這種選舉時 health 會報出來。
--   * 臂本身現在也算登記截止之前、投票日之後的列（目前沒有：scope 只有 2026，登記已於 09-04 截止，投票日 11-28 還沒到），輸出再由總表依規則濾掉。
--   * opened_by：帶起點里程碑（registration_close 與它的日期）、expected_open_on（登記截止當天）與 open_until（投票日）。
--
-- 收回原因 window／filled：第一支有迄日的臂（20261008121000 party_roster）已經讓 seed 分得出；這支是第二支用到。投票日 +1 起，所有還沒補上的 2026 不參選重查派工列被收回，原因 window。
--
-- 臂的改法（現行定義＋機械式替換）：
--   * 本體＝20261006220000 的現行定義（與正式庫 pg_get_functiondef 一字不差，2026-10-08 比對過），只把 WHERE 裡兩個日期條件
--     （registration_closed_on <= CURRENT_DATE、election_date 的那一條與它上面的註解）換成一行說明註解。其餘一字不差。
--     JOIN elections e 留著（FK 保證有列，拿掉是另一個改動）。同簽名、同回傳型別（CREATE OR REPLACE，不用分兩次上）；
--     呼叫它的只有 contribution_auto_tasks_arms()（2026-10-08 唯讀查正式庫 pg_proc 確認，沒有 Edge Function 直接呼叫）。
--   * 這支不動總表與 seed（另有一支 PR 同時在改 arms()，這支刻意不碰）。
--
-- 守門：supabase/functions/_shared/activity-not-running.test.ts（文字層：臂＝前一版加一處機械式替換；規則只改這一條；
--   PGlite：假時鐘 09-03 關、09-04 開、11-28 開、11-29 關、舊屆別永遠關、今天輸出與 P1 逐件相同、seed 的 window 收回；還原驗證）；
--   scripts/arms-parity-p2.ts check not_running <snapshot.json>：正式庫唯讀快照，新舊輸出筆數與全欄雜湊相等（不進 CI，PR 說明附結果）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：P0／P1 的 activity_rules、election_milestones_all（registration_close 來自 election_milestones；polling 來自 elections.election_date）；
-- 臂本來就用的表（politician_elections、politicians、regions、roster_check_scope、elections、edit_history）沒有新增引用。

-- ------------------------------------------------------------
-- 1. contribution_auto_tasks_not_running：WHERE 拿掉兩個日期條件（其餘一字不差）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_not_running()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:not_running_recheck:' || pe.id, 'not_running_recheck',
         jsonb_build_object('politician_election_id', pe.id, 'politician_id', p.id, 'name', p.name,
                            'election_id', pe.election_id, 'election_type', pe.election_type,
                            'region', COALESCE(r.region, p.region), 'source_note', pe.source_note,
                            'registration_closed_on', s.registration_closed_on),
         p.name || '（' || COALESCE(r.region, p.region, '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '') || '）'
           || '被標成「不參選」，但沒有任何人對過官方登記名單——這一列多半是早期匯入時就這樣寫的。'
           || '**這個標記的代價很大**：標成不參選之後，這個人的政見、基本資料、參選來源、選舉結果四種缺口都不會再被派給任何人，所以它值得被核對一次。'
           || '登記已經在 ' || s.registration_closed_on::TEXT || ' 截止，名單現在查得到。請打開該縣市選舉委員會的登記公告（或媒體整理的完整登記名單）核對：'
           || '**他在名單上** → 用 correction 把 politician_elections.candidate_status 改成 registered，附那份名單；'
           || '**確實不在名單上** → 用 no_change 回報、outcome 填 confirmed，checked_urls 放你核對的那份名單（這時系統才會把這一列標成已核對，不再重派）；'
           || '**找不到該縣市的名單** → no_change 但 outcome 填 unreachable 或 not_found，那不會把它標成已核對，過幾天換人再試。'
           || 'target.source_note 是這一列的匯入來歷，僅供參考——實測很多寫著「可能再次挑戰」卻被標成不參選，不要拿它當證據。',
         ARRAY['該縣市選舉委員會官網的登記公告', 'cna.com.tw 登記參選名單', 'ltn.com.tw', 'udn.com'],
         2, COALESCE(r.region, p.region)
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
  LEFT JOIN regions r ON r.id = pe.region_id
  JOIN roster_check_scope s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
  JOIN elections e ON e.id = pe.election_id
  WHERE pe.candidacy_status = 'withdrawn'
    -- 登記截止之後、投票日當天（含）之前才派：移到規則（activity_rules「not_running」：登記截止 +0 起、投票日 +0 止，P2 20261008161000）；這裡不再比日期
    AND pe.verified IS NOT TRUE
    -- 退選前有沒有登記（#345 後續，2026-10-06）：看不出來的由 contribution_auto_tasks_withdrawn_filing 派（同一份名冊一起問）；
    -- 登記後退選的本來就在名冊上，再問「在不在名冊上」會把退選改回已登記；代理照名冊查過、交更正補上這一欄的，等於核對過名冊
    AND NOT (pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS NULL)
    AND pe.withdrawn_after_filing IS NOT TRUE
    AND NOT EXISTS (SELECT 1 FROM edit_history h
                     WHERE h.table_name = 'politician_elections' AND h.record_id = pe.id::TEXT
                       AND h.field = 'withdrawn_after_filing' AND h.reverted_at IS NULL)
$$;

-- ------------------------------------------------------------
-- 2. 規則：把 P1 的「永遠開」種子原地改成「登記截止當天起、到投票日當天止」（rule_id 不變；審計觸發器照寫 edit_history）
-- ------------------------------------------------------------
-- 不限屆別與職位、min_status 用預設 announced（理由見檔頭）。可重跑：已經是這個形狀的規則再改一次不變
UPDATE activity_rules
   SET window_kind = 'event', from_kind = 'registration_close', from_offset = 0, until_kind = 'polling', until_offset = 0, min_status = 'announced',
       recur_months = NULL, reasons = NULL, levels = NULL, election_types = NULL, jurisdictions = NULL, enabled = true,
       note = 'P2：登記截止當天起、到投票日當天止（原臂內條件 registration_closed_on <= CURRENT_DATE 且 election_date >= CURRENT_DATE，台北日界）；範圍不限、每場選舉各自從自己的登記截止（每職位一列的 registration_close 里程碑）到自己的投票日；沒有登記截止里程碑的屆別窗口永遠關'
 WHERE activity = 'not_running'
   AND (window_kind = 'always' OR (from_kind = 'registration_close' AND until_kind = 'polling'));

-- 沒改到、改到多條、或這個活動還有別條規則（OR 會讓窗口比預期寬）都不能上線
DO $$
BEGIN
  IF (SELECT count(*) FROM activity_rules r WHERE r.activity = 'not_running') <> 1
     OR NOT EXISTS (SELECT 1 FROM activity_rules r
                     WHERE r.activity = 'not_running' AND r.enabled AND r.window_kind = 'event'
                       AND r.from_kind = 'registration_close' AND r.from_offset = 0 AND r.until_kind = 'polling' AND r.until_offset = 0 AND r.min_status = 'announced'
                       AND r.reasons IS NULL AND r.levels IS NULL AND r.election_types IS NULL AND r.jurisdictions IS NULL) THEN
    RAISE EXCEPTION 'P2（not_running）：not_running 的規則不是預期的一條「登記截止 +0 起、投票日 +0 止」';
  END IF;
END
$$;

-- 函式備註補一句（只補一次：已經有標記就不再補）
DO $$
DECLARE v_old TEXT := obj_description('contribution_auto_tasks_not_running()'::regprocedure, 'pg_proc');
BEGIN
  IF v_old IS NOT NULL AND v_old NOT LIKE '%P2 20261008161000%' THEN
    EXECUTE format('COMMENT ON FUNCTION contribution_auto_tasks_not_running IS %L',
                   v_old || '｜2026-10-08（P2 20261008161000）：「登記已截止、投票日還沒過」改由規則 activity_rules「not_running」（登記截止 +0 起、投票日 +0 止）決定，臂內不再比日期');
  END IF;
END
$$;
