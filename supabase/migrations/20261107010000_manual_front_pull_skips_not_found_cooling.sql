-- 「查無」冷卻中的手動任務不被固定時段插隊／重新入列的插隊秒數放出來（2026-11-07，PR #875 的漏網）
--
-- 根因（正式庫唯讀實測 2026-11-06 UTC 21:00～21:30）：
--   #875 讓手動任務的 not_found 記一筆 task_checks 進冷卻 2 天（refresh_dispatch_blocked 算 cool_until／cooling），但冷卻不是閘門、而是排序鍵：
--     cooling ＝ task_queue_key(...) > now() + 一天，task_queue_key ＝ GREATEST(進隊時間 − 優先秒數, cool_until) − 插隊秒數。
--   網站請求／公民提問（manual_task_is_visitor）有兩條路給 queue_settings.visitor_front_seconds（＝315360000，10 年）的插隊秒數：
--     1. manual_front_pull()：視窗內（visitor_front_slot_hours()＝1，20261027220000 改成每小時；每小時前 20 分鐘＝:00、:10 兩輪 seed）把
--        「從沒派過、或最後派出早於本時段開始」的 open 列 boost_seconds 設成 visitor_front_seconds——不看冷卻；
--     2. 列（重新）出生（seed 新增列／contribution_tasks_insert_dispatch）：boost_seconds ＝ manual_front_seconds(task_id)——也不看冷卻（task_checks 不隨列消失）。
--   插隊秒數 10 年 → 排序鍵 ≈ 2016 年 → 下一輪 refresh_dispatch_blocked 算出 cooling ＝ false → contribution_queue_tasks 放行
--   （cool_until 還在，只是不再擋）。派出時觸發器 task_dispatches_queue_key 把插隊秒數歸零，所以事後看到 boost_seconds ＝ 0、cooling 還停在 false 直到下一輪 refresh。
--   正式庫實測：11-06 21:10～21:23 派出的 5 列 boost_seconds ＝ 0、cool_until 在 11-08、cooling ＝ false；同時另有 6 列 boost_seconds ＝ 315360000 ＋ 2 天內有 not_found、cooling ＝ false 在隊裡等著被派。
--   自動缺口早在 20261107000000 對 cand_no_front_pull 做了同樣的處理（冷卻中不拉）；手動任務這兩條路漏了。
--
-- 本檔：
--   1. manual_front_pull：以 20261011320000 的現行定義為底，多一條「2 天內有 not_found 查核的不拉」（task_checks，跟 cand_no_front_pull 同一個條件）。
--   2. 新列出生時的插隊秒數：BEFORE INSERT 觸發器，手動任務（uuid）出生當下若 2 天內有 not_found 查核，插隊秒數歸零（冷卻過了不補——冷卻結束後回到原本的位置）。
--      只管 INSERT：維護者從主控台明確的插隊（task_boost，UPDATE）照舊，不動。
--   3. 舊資料：2 天內有 not_found、插隊秒數正好是 visitor_front_seconds／manual_front_seconds（自動給的值）的手動任務列，插隊秒數歸零、cooling 設回 true（refresh 下一輪也會算同一個結果）。

-- ------------------------------------------------------------
-- 1. manual_front_pull
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION manual_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_slot TIMESTAMPTZ := visitor_front_slot_start(); n INTEGER;
BEGIN
  IF v_slot IS NULL THEN RETURN 0; END IF;
  -- >>> 優先秒數（20261011320000）：拉回前段＝插隊一次（visitor_front_seconds，原本排到 1970）；已經拉過的（插隊秒數已達這個值）不重複加
  UPDATE task_dispatches d SET boost_seconds = q.visitor_front_seconds
    FROM queue_settings q
   WHERE q.id = 1
     AND d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(true) m)
     AND (d.dispatch_count = 0 OR d.last_dispatched_at < v_slot)
     AND d.boost_seconds < q.visitor_front_seconds
     -- >>> 查無冷卻中不拉（2026-11-07）：10 年的插隊秒數會把排序鍵拉到 2016 年，cooling 變 false，冷卻中的任務又被派出去
     AND NOT EXISTS (SELECT 1 FROM task_checks tc
                      WHERE tc.task_id = d.task_id AND tc.outcome = 'not_found'
                        AND tc.checked_at > now() - make_interval(days => task_not_found_cooldown_days()));
     -- <<< 查無冷卻中不拉
  -- <<< 優先秒數
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION manual_front_pull IS
  '固定時段插隊（seed 每輪呼叫；時段＝台北每 visitor_front_slot_hours() 小時的前 visitor_front_window_minutes() 分鐘）：把仍 open 的網站請求與公民提問中「從沒派過、或最後派出時間早於本時段開始」的派工列插隊一次（visitor_front_seconds）；'
  'task_checks 有 2 天內 not_found 的（查無冷卻中）不拉。時段內第二次 seed 冪等；其他時段什麼都不做。2026-10-08；2026-11-07 加查無冷卻條件';

-- ------------------------------------------------------------
-- 2. 出生當下的插隊秒數
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_dispatches_nf_cooling_no_boost() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.boost_seconds > 0
     AND NEW.task_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND EXISTS (SELECT 1 FROM task_checks tc
                  WHERE tc.task_id = NEW.task_id AND tc.outcome = 'not_found'
                    AND tc.checked_at > now() - make_interval(days => task_not_found_cooldown_days())) THEN
    NEW.boost_seconds := 0;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION task_dispatches_nf_cooling_no_boost IS '手動任務（uuid）的派工列出生當下，若 2 天內有 not_found 查核，插隊秒數歸零（否則 10 年的出生插隊把冷卻蓋掉）。BEFORE INSERT，名字排在 trg_task_dispatches_queue_key 前面，queue_at 照歸零後的秒數算；2026-11-07';

DROP TRIGGER IF EXISTS trg_task_dispatches_nf_cooling_no_boost ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_nf_cooling_no_boost
  BEFORE INSERT ON task_dispatches
  FOR EACH ROW WHEN (NEW.task_id NOT LIKE 'verify:%' AND NEW.task_id NOT LIKE 'auto:%')
  EXECUTE FUNCTION task_dispatches_nf_cooling_no_boost();

-- ------------------------------------------------------------
-- 3. 舊資料（可重跑：動完就不再符合條件）
-- ------------------------------------------------------------
UPDATE task_dispatches d
   SET boost_seconds = 0, cooling = true
  FROM queue_settings q
 WHERE q.id = 1
   AND d.task_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND d.boost_seconds > 0 AND d.boost_seconds IN (q.visitor_front_seconds, q.manual_front_seconds)
   AND EXISTS (SELECT 1 FROM task_checks tc
                WHERE tc.task_id = d.task_id AND tc.outcome = 'not_found'
                  AND tc.checked_at > now() - make_interval(days => task_not_found_cooldown_days()));

NOTIFY pgrst, 'reload schema';
