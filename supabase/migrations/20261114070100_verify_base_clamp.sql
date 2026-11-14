-- 驗證票基準夾限（保險，2026-11-14）
-- ============================================================
--
-- 20261114070000 補回了已開驗證票的舊插隊。這支讓以後不會再發生：驗證票入列時從母任務列抄 dispatch_base_at，
-- 抄來的值不得早於「母任務不含插隊的位置 − (最大合法插隊 ＋ verify_priority_seconds)」。
--   · 母任務不含插隊的位置 ＝ task_queue_key(母任務.last_dispatched_at, 母任務.priority_seconds, NULL, 0)（不含插隊、不含冷卻）
--   · 最大合法插隊 ＝ queue_settings 的 boost_seconds、manual_front_seconds、visitor_front_seconds、visitor_front_pre_election_seconds 取最大（現在 100 天），不寫死
--   · 加上 verify_priority_seconds（現在 14 天）是票自己本來就比母任務前面的那一段
-- 新函式 verify_ticket_base_floor_seconds() ＝ 上面第二、三項相加（秒）。
-- verify_ticket_base 以 20261112005000 的現行定義為底，只差一處（標 >>> 基準夾限）：一般任務的交件取母任務基準時夾限。
-- 新增型、沒有母任務基準的退路（交件建立時間）不受影響；觸發器、verify_ticket_key、既有列都不動。
--
-- 回滾：把 verify_ticket_base 換回 20261112005000 的定義、DROP FUNCTION verify_ticket_base_floor_seconds()；已入列的票不受影響（基準凍結在列上）。

CREATE OR REPLACE FUNCTION verify_ticket_base_floor_seconds() RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(q.boost_seconds, q.manual_front_seconds, q.visitor_front_seconds, q.visitor_front_pre_election_seconds) + q.verify_priority_seconds
    FROM queue_settings q WHERE q.id = 1
$$;
COMMENT ON FUNCTION verify_ticket_base_floor_seconds IS '驗證票基準夾限的寬度（20261114070100）：queue_settings 四個插隊值的最大者 ＋ verify_priority_seconds。基準不得早於「母任務不含插隊的位置」減這個數。2026-11-14';

CREATE OR REPLACE FUNCTION verify_ticket_base(p_verify_task_id TEXT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN t.contribution_type IS NULL THEN NULL
           WHEN t.is_new THEN COALESCE(t.created_at, now()) - make_interval(secs => verify_ticket_election_seconds(p_verify_task_id))  -- >>> 選舉年優先
           ELSE COALESCE((SELECT GREATEST(p.dispatch_base_at,  -- >>> 基準夾限（20261114070100）：不早於母任務不含插隊的位置 − (最大合法插隊 ＋ 14 天)；位置算不出來就不夾
                                          task_queue_key(p.last_dispatched_at, p.priority_seconds, NULL, 0) - make_interval(secs => COALESCE(verify_ticket_base_floor_seconds(), 0)))
                            FROM task_dispatches p
                           WHERE p.task_id = t.parent_id AND p.dispatch_base_at IS NOT NULL
                             AND p.last_dispatched_at <= COALESCE(t.created_at, now())),
                         COALESCE(t.created_at, now()) - make_interval(secs => verify_ticket_election_seconds(p_verify_task_id)))  -- >>> 選舉年優先
         END
    FROM (SELECT 1) x LEFT JOIN verify_ticket_parent(p_verify_task_id) t ON true
$$;
COMMENT ON FUNCTION verify_ticket_base IS '驗證票入列時的基準 B（2026-11-04，20261112005000 加選舉年，20261114070100 加夾限）：新增型＝交件建立時間 − 選舉年秒數；一般任務＝母任務列的 dispatch_base_at（交件之後才又被派出的不採用），但不早於母任務不含插隊的位置 − (最大合法插隊 ＋ verify_priority_seconds)；沒有基準＝交件建立時間 − 選舉年秒數';

NOTIFY pgrst, 'reload schema';
