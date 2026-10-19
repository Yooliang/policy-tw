-- /boost 插隊逾時修正（2026-10-19，正式環境 bug）：POST api.hustings.net/tw/boost 從 10-14 起每次回
--   {"error":"internal_error","message":"task_boost: canceling statement due to statement timeout"}
--
-- 根因（正式庫唯讀量測，2026-10-19）：task_boost 第一行 PERFORM seed_auto_task_queue()，整支缺口總表重算。
--   · seed 本身：cron 紀錄 seed-auto-task-queue-10min 日均 10-12 6.6 秒、10-13 7.1、10-14 7.1、10-16 7.6、10-18 7.9、10-19 9.3 秒（最慢 12.4 秒）；
--     contribution_auto_tasks_arms() 一次 EXPLAIN ANALYZE 6.4 秒。cron 用 postgres 角色沒有逾時，所以排程一直成功
--   · /boost 走 PostgREST（authenticator 角色 statement_timeout＝8 秒）：seed 平均超過 8 秒就必逾時（10-10 的修正時 seed 只要 3.3 秒，
--     當時 task_boost 沒動，留下這個尾巴；seed 越來越慢，10-14 之後再也過不了）
--   · 驗證票那段不是原因：refresh_verify_ticket_keys 對應的查詢 EXPLAIN ANALYZE 20 毫秒（task_dispatches 1.5 萬列、驗證票全 Seq Scan）；
--     task_boost_matches 16 毫秒（347 筆命中）
-- 做法：task_boost 不再先跑 seed。插隊只對「已經在佇列（task_dispatches）的任務」與待驗證貢獻生效——task_boost_matches 本來就只讀佇列
--   （20261010160000），所以不跑 seed 唯一的差別是：最近 10 分鐘內才出生、還沒被排程寫進佇列的缺口這一輪插不到，下一輪 seed 之後再插即可。
--   其餘一字不動（CREATE OR REPLACE，簽名與回傳型別不變；以 20261017010000 的現行定義為底，只拿掉 seed 那一行）。
-- 日本站（policy_jp.task_boost）不跟：它的 seed 平均 1.2 秒、最慢 3.5 秒，遠低於逾時（走樣守門 policy-jp-boost.test.ts 比對改讀這支之前的版本）。

CREATE OR REPLACE FUNCTION task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  INSERT INTO task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM task_boost_matches(p_filter);
  UPDATE contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  -- 任務列與驗證票一樣加插隊秒數（queue_settings.boost_seconds，插幾次加幾份，派出就歸零），queue_at 由觸發器照排序鍵馬上重算；插隊的不受冷卻擋
  UPDATE task_dispatches d SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
    FROM _boost_hits h, queue_settings q WHERE q.id = 1 AND h.task_id = d.task_id;
  -- 母任務剛被插隊的，它還跟著它的驗證票跟著走
  PERFORM refresh_verify_ticket_keys();
  -- 回傳值的 queue_at：這次插隊命中的列現在最前面的排序鍵（沒有命中的列就是 NULL）
  SELECT min(d.queue_at) INTO v_at FROM task_dispatches d JOIN _boost_hits h ON h.task_id = d.task_id;
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;
