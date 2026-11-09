-- 手動任務的「查無冷卻中不拉」改看查核階梯（2026-11-09，接 1.123.0／20261109150000）
--   20261107010000 的 manual_front_pull 與出生觸發器寫死「2 天內有 not_found」：階梯第 1 格改 5 天、也多了 confirmed 與結案之後，
--   第 3～5 天之間手動任務又會被 10 年插隊拉回、冷卻被蓋掉。改成問同一個函式 task_in_check_cooldown：
--   task_checks（not_found／confirmed）有一筆「查核時間＋該筆自己的冷卻天數（task_check_cooldown_days_for）」還沒過，或任務已被階梯結案（task_ladder_closed）→ 不拉、出生不給插隊。
--   cand_no_front_pull 不動：它處理的是號次缺口（auto:candidacy_source_missing:cand_no*，階梯的例外型別，not_found 本來就是 2 天），
--   而且已同時看 cool_until（含 confirmed 的 14 天）與 2 天內 not_found 兩道。

CREATE OR REPLACE FUNCTION task_in_check_cooldown(p_task_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
           SELECT 1 FROM task_checks tc
            WHERE tc.task_id = p_task_id AND tc.outcome IN ('not_found', 'confirmed')
              AND tc.checked_at > now() - make_interval(days => (SELECT task_cooldown_max_days()))
              AND tc.checked_at + (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL > now())
      OR EXISTS (SELECT 1 FROM task_ladder_closed lc WHERE lc.task_id = p_task_id)
$$;
COMMENT ON FUNCTION task_in_check_cooldown IS '這個任務現在是不是在「查無／確認無誤」的冷卻中（依查核階梯算每一筆自己的天數），或已被階梯結案。manual_front_pull 與手動任務出生觸發器用它決定不給插隊';

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
     -- >>> 查核階梯冷卻中不拉（2026-11-09；原 2026-11-07 的「2 天內有 not_found」）：10 年的插隊秒數會把排序鍵拉到 2016 年，cooling 變 false，冷卻中的任務又被派出去
     AND NOT task_in_check_cooldown(d.task_id);
     -- <<< 查核階梯冷卻中不拉
  -- <<< 優先秒數
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
COMMENT ON FUNCTION manual_front_pull IS
  '固定時段插隊（seed 每輪呼叫；時段＝台北每 visitor_front_slot_hours() 小時的前 visitor_front_window_minutes() 分鐘）：把仍 open 的網站請求與公民提問中「從沒派過、或最後派出時間早於本時段開始」的列插隊一次（visitor_front_seconds）；'
  '查核冷卻中（task_in_check_cooldown：查無／確認無誤依階梯算的天數還沒過，或已被階梯結案）的不拉。時段內第二次 seed 冪等；其他時段什麼都不做。2026-10-08；2026-11-07 加查無冷卻條件；2026-11-09 改看階梯';

CREATE OR REPLACE FUNCTION task_dispatches_nf_cooling_no_boost() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.boost_seconds > 0
     AND NEW.task_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND task_in_check_cooldown(NEW.task_id) THEN
    NEW.boost_seconds := 0;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION task_dispatches_nf_cooling_no_boost IS '手動任務（uuid）的派工列出生當下，若在查核階梯的冷卻中（或已結案），插隊秒數歸零（否則 10 年的出生插隊把冷卻蓋掉）。BEFORE INSERT，只管 INSERT：維護者從主控台明確的插隊（task_boost，UPDATE）照舊。2026-11-09 改看階梯（原 2 天內 not_found）';

-- 舊資料（可重跑：動完就不再符合條件）：冷卻中、插隊秒數正好是自動給的值的手動任務列，插隊歸零、cooling 設回 true
UPDATE task_dispatches d
   SET boost_seconds = 0, cooling = true
  FROM queue_settings q
 WHERE q.id = 1
   AND d.task_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND d.boost_seconds > 0 AND d.boost_seconds IN (q.visitor_front_seconds, q.manual_front_seconds)
   AND task_in_check_cooldown(d.task_id);

NOTIFY pgrst, 'reload schema';
