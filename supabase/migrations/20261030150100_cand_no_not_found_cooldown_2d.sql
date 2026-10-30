-- 號次缺口任務「查無」冷卻改 2 天（2026-10-30，維護者）
--   cand_no 號次缺口任務（task_id 形如 auto:candidacy_source_missing:cand_no:…，target.kind＝cand_no）交 no_change not_found 後
--   原本冷卻 14 天，會錯過 11/17 名單公告日。只有這一種任務的 not_found 改 2 天；cand_no_recheck、其他任務型別、其他 outcome 不變。
-- 做法：以 20261009010000 的 task_check_cooldown_days_for 為底，在 unreachable 之後加一條 WHEN。天數寫在函式裡（2 天，同 unreachable 的量級）。
CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()
           WHEN p_outcome = 'not_found' AND split_part(p_task_id, ':', 2) = 'candidacy_source_missing' AND split_part(p_task_id, ':', 3) = 'cand_no'
             THEN 2
           WHEN p_outcome = 'not_found' AND s.enabled AND split_part(p_task_id, ':', 2) = ANY (s.task_types)
             THEN CASE WHEN (SELECT count(*) FROM task_checks x
                              WHERE x.task_id = p_task_id AND x.outcome = 'not_found' AND (x.checked_at, x.id) <= (p_checked_at, p_id)) >= 2
                       THEN s.not_found_repeat_days ELSE s.not_found_first_days END
           ELSE task_check_cooldown_days()
         END
    FROM (SELECT 1) AS one LEFT JOIN task_cooldown_settings s ON s.id = 1
$$;
COMMENT ON FUNCTION task_check_cooldown_days_for IS
  '一筆 task_checks 的冷卻天數：unreachable＝task_unreachable_cooldown_days()；號次缺口任務（candidacy_source_missing 的 cand_no）的 not_found＝2 天（2026-10-30，錯過名單公告日的修正）；型別在 task_cooldown_settings.task_types 且 outcome＝not_found 且設定開著＝第一次 not_found_first_days、第二次起 not_found_repeat_days；其餘＝task_check_cooldown_days()';
