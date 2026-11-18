-- 止血：回滾 #977（20261118010000）的階梯函式，2026-11-18。
--
-- 原因：#977 部署後（08:41Z），pg_cron 的 seed-auto-task-queue-10min 每輪都在 task_check_prebulletin_cutoff 內
--   撞 120 秒 statement timeout（08:50、09:00 兩輪），task_dispatches 自 08:36Z 起沒有任何 refresh。
-- 做法：work_key_ladder_state、task_check_cooldown_days_for 還原成 20261111100000 的原定義（一字不差），
--   並移除 task_check_prebulletin_cutoff。只動函式，不動任何資料列。
-- 規則 D（公報上架前的查無不計階梯）另案重做。
-- 不刪、不改已套用的 20261118010000（遠端 history 已有它）。


CREATE OR REPLACE FUNCTION work_key_ladder_state(p_work_key TEXT)
RETURNS TABLE (checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT tc.id, tc.task_id, tc.outcome, tc.checked_at,
           (tc.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(tc.task_id)) AS laddered
      FROM task_checks tc
     WHERE tc.work_key = p_work_key
  ), n AS (
    SELECT t.*, CASE WHEN t.laddered THEN row_number() OVER (PARTITION BY t.laddered ORDER BY t.checked_at, t.id) END AS n,
           (task_check_cooldown_days_for(t.task_id, t.outcome, t.checked_at, t.id) || ' days')::INTERVAL AS d
      FROM t
  )
  SELECT count(*) FILTER (WHERE n.laddered),
         COALESCE(bool_or(n.laddered AND task_check_ladder_days(n.outcome, n.n) IS NULL), FALSE),
         min(n.checked_at) FILTER (WHERE n.laddered AND task_check_ladder_days(n.outcome, n.n) IS NULL),
         max(n.checked_at) FILTER (WHERE n.laddered),
         max(n.checked_at + n.d) FILTER (WHERE n.checked_at > now() - n.d AND n.checked_at > now() - make_interval(days => task_cooldown_max_days())),
         max(n.checked_at + n.d) FILTER (WHERE n.outcome IN ('not_found', 'confirmed') AND n.checked_at > now() - n.d
                                          AND n.checked_at > now() - make_interval(days => task_cooldown_max_days()))
    FROM n
$$;
COMMENT ON FUNCTION work_key_ladder_state IS '一張工作卡（work_key）的查核階梯與冷卻狀態：結案與否、累計次數、最晚冷卻結束時間。只掃這個鍵的 task_checks（task_checks_work_key_idx）。2026-11-11';

CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()
           WHEN p_outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(p_task_id) THEN
             COALESCE(task_check_ladder_days(p_outcome,
                        (SELECT count(*) FROM task_checks x
                          WHERE x.work_key = one.wk AND x.outcome IN ('not_found', 'confirmed') AND (x.checked_at, x.id) <= (p_checked_at, p_id))),
                      (SELECT l.days[cardinality(l.days)] FROM task_check_ladder_settings l WHERE l.outcome = p_outcome))
           WHEN p_outcome = 'not_found' AND s.enabled AND split_part(p_task_id, ':', 2) = ANY (s.task_types)
                AND (SELECT count(*) FROM task_checks x
                      WHERE x.work_key = one.wk AND x.outcome = 'not_found' AND (x.checked_at, x.id) <= (p_checked_at, p_id)) >= 2
             THEN s.not_found_repeat_days
           WHEN p_outcome = 'not_found' THEN task_not_found_cooldown_days()
           ELSE task_check_cooldown_days()
         END
    FROM (SELECT COALESCE((SELECT y.work_key FROM task_checks y WHERE y.id = p_id), task_work_key(p_task_id, NULL), 'task:' || p_task_id) AS wk) AS one
    LEFT JOIN task_cooldown_settings s ON s.id = 1
$$;
COMMENT ON FUNCTION task_check_cooldown_days_for IS
  '一筆 task_checks 的冷卻天數（2026-11-11 起次序按工作卡 work_key 累計，換號、換臂不歸零）：unreachable＝task_unreachable_cooldown_days()；非例外任務的 not_found／confirmed＝階梯（task_check_ladder_days，同一張卡兩種合計的第 n 次）；例外任務（task_check_ladder_exempt）not_found＝2 天（進度類第二次起 not_found_repeat_days）、confirmed 與其餘＝task_check_cooldown_days()';

-- 函式已還原，不再被引用，最後移除。
DROP FUNCTION IF EXISTS task_check_prebulletin_cutoff(text);
