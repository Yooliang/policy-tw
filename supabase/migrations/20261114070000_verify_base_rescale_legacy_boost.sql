-- 驗證票基準補回舊插隊（一次性修正，2026-11-14）
-- ============================================================
--
-- 問題：驗證票 queue_at ＝ dispatch_base_at − 14 天 − 自己的插隊 ＋ 7 天 × 領走次數，dispatch_base_at 是母任務被派出當下「派出前的位置」，含當時的插隊。
-- 20261114020000 把任務列的插隊一次性縮小（5 年→30 天、10 年→60 天／網站請求依選舉階段 100／50 天、15 年→90 天），
-- 但已開出的驗證票的 dispatch_base_at 沒跟著縮，仍帶著舊的年級插隊，永遠排在所有任務前面。
-- 實例：驗證票 4e8ac143（母任務 auto:profile_gap:e2cb5632…）基準 2014-09-20，母任務現在的位置 2019-09-27，差 5 年又 7 天。
--
-- 做法（冪等，只動還沒結案＝contributions.status = 'pending' 的驗證票，且只動有母任務列可比對的）：
--   參考點 U ＝母任務列「不含插隊、不含冷卻」的位置 ＝ task_queue_key(last_dispatched_at, priority_seconds, NULL, 0)。
--   差距 gap ＝ U − dispatch_base_at。正常的票 gap 只有母任務在佇列裡等的時間加上當時的合法插隊；
--   帶舊插隊的 gap 多出 5／10／15 年。判定條件（兩個都要成立才動，不成立的只印 NOTICE 不動）：
--     1. gap > 最大合法插隊（queue_settings 四個插隊值的最大者）＋ verify_priority_seconds ＋ verify_redispatch_seconds（目前 100＋14＋7 ＝ 121 天）
--     2. gap 離 5 年的整數倍（1、2、3 倍）不到 365 天
--   補的秒數 ＝ 舊插隊 − 新插隊，跟 20261114020000 的換算一致：
--     5 年（157680000）→ 30 天（2592000）            補 155088000
--     10 年（315360000）→ 母任務是網站請求（manual_task_is_visitor 或缺口列有 web_request_boost_ids）：visitor_front_seconds_for(母任務目標)
--                          （選前 100 天、選後 50 天）；其餘 60 天（5184000）
--     15 年（473040000）→ 90 天（7776000）
--   不手動改 queue_at：task_dispatches_queue_key 觸發器在 UPDATE 時照 verify_ticket_key 重算。
--
-- 回滾（只還原本支動過的列；先看 NOTICE 印的筆數與 task_id）：
--   UPDATE task_dispatches SET dispatch_base_at = dispatch_base_at - make_interval(secs => <補的秒數>) WHERE task_id IN (<NOTICE 印出的 task_id>);
--   補的秒數見 NOTICE 逐列輸出；5 年那種是 155088000。回滾後 queue_at 同樣由觸發器重算。
--
-- 沒動：已結案的驗證票、沒有母任務列的驗證票（沒有參考點）、新增型的票（基準是交件建立時間）、票自己的 20／25／30 年號次拉前插隊（boost_seconds，到 2026-11-28 止，另案）。

DO $$
DECLARE
  r RECORD;
  v_thr BIGINT;
  v_n INTEGER;
BEGIN
  SELECT GREATEST(q.boost_seconds, q.manual_front_seconds, q.visitor_front_seconds, q.visitor_front_pre_election_seconds)
         + q.verify_priority_seconds + q.verify_redispatch_seconds
    INTO v_thr FROM queue_settings q WHERE q.id = 1;
  IF v_thr IS NULL THEN RAISE EXCEPTION 'queue_settings 沒有 id = 1 這一列'; END IF;

  CREATE TEMP TABLE _vb_fix ON COMMIT DROP AS
  SELECT d.task_id, d.dispatch_base_at AS old_base, d.queue_at AS old_queue, g.k, g.gap,
         (g.k * 157680000)::BIGINT AS old_boost,
         CASE g.k
           WHEN 1 THEN 2592000::BIGINT
           WHEN 2 THEN CASE WHEN p.opened_by ? 'web_request_boost_ids'
                                  OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = p.task_id AND manual_task_is_visitor(t.source, t.task_type))
                             THEN COALESCE(visitor_front_seconds_for(p.target), 5184000) ELSE 5184000::BIGINT END
           ELSE 7776000::BIGINT
         END AS new_boost
    FROM task_dispatches d
    JOIN contributions c ON c.id = uuid_or_null(substr(d.task_id, 8)) AND c.status = 'pending'
    JOIN task_dispatches p ON p.task_id = COALESCE(c.task_id, c.payload->>'task_id')
   CROSS JOIN LATERAL (
     SELECT EXTRACT(EPOCH FROM (task_queue_key(p.last_dispatched_at, p.priority_seconds, NULL, 0) - d.dispatch_base_at)) AS gap,
            round(EXTRACT(EPOCH FROM (task_queue_key(p.last_dispatched_at, p.priority_seconds, NULL, 0) - d.dispatch_base_at)) / 157680000.0) AS k
   ) g
   WHERE d.task_id LIKE 'verify:%' AND d.dispatch_base_at IS NOT NULL
     AND g.gap > v_thr
     AND g.k BETWEEN 1 AND 3
     AND abs(g.gap - g.k * 157680000.0) < 31536000;

  SELECT count(*) INTO v_n FROM _vb_fix;
  RAISE NOTICE '驗證票基準補回舊插隊：待補 % 張（門檻 % 天）', v_n, round(v_thr / 86400.0, 1);
  FOR r IN SELECT k, new_boost, count(*) AS n FROM _vb_fix GROUP BY 1, 2 ORDER BY 1, 2 LOOP
    RAISE NOTICE '  舊插隊 % 年 → 新插隊 % 天：% 張，各補 % 秒', r.k * 5, round(r.new_boost / 86400.0, 1), r.n, (r.k * 157680000)::BIGINT - r.new_boost;
  END LOOP;
  FOR r IN SELECT task_id, old_boost - new_boost AS shift, old_base FROM _vb_fix ORDER BY task_id LOOP
    RAISE NOTICE '  %：基準 % 補 % 秒', r.task_id, r.old_base, r.shift;
  END LOOP;

  -- gap 超過門檻、但不是 5 年的整數倍的（可能是母任務等太久或別的原因）：只列出不動
  FOR r IN
    SELECT d.task_id, round(EXTRACT(EPOCH FROM (task_queue_key(p.last_dispatched_at, p.priority_seconds, NULL, 0) - d.dispatch_base_at)) / 86400.0) AS gap_days
      FROM task_dispatches d
      JOIN contributions c ON c.id = uuid_or_null(substr(d.task_id, 8)) AND c.status = 'pending'
      JOIN task_dispatches p ON p.task_id = COALESCE(c.task_id, c.payload->>'task_id')
     WHERE d.task_id LIKE 'verify:%' AND d.dispatch_base_at IS NOT NULL
       AND EXTRACT(EPOCH FROM (task_queue_key(p.last_dispatched_at, p.priority_seconds, NULL, 0) - d.dispatch_base_at)) > v_thr
       AND d.task_id NOT IN (SELECT task_id FROM _vb_fix)
  LOOP
    RAISE NOTICE '  未動（差距超過門檻但不像舊插隊）：% 差 % 天', r.task_id, r.gap_days;
  END LOOP;

  UPDATE task_dispatches d
     SET dispatch_base_at = d.dispatch_base_at + make_interval(secs => (f.old_boost - f.new_boost)::DOUBLE PRECISION)
    FROM _vb_fix f
   WHERE d.task_id = f.task_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '已補 % 張驗證票的 dispatch_base_at（queue_at 由觸發器重算）', v_n;
END;
$$;

NOTIFY pgrst, 'reload schema';
