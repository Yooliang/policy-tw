-- task_boost 透過 PostgREST（RPC）呼叫時炸：「DELETE requires a WHERE clause」（2026-09-22 09:00 第一發 POST /boost）
-- Supabase 的 safeupdate 擋沒有 WHERE 的 DELETE；migration 裡直接呼叫時是 CLI 連線所以沒擋到。暫存表清空改用 TRUNCATE。
CREATE OR REPLACE FUNCTION task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  -- 還沒發號碼牌的先發，不然排不到
  PERFORM seed_auto_task_queue();
  INSERT INTO task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  v_at := TIMESTAMPTZ '1980-01-01' + (v_id * INTERVAL '1 minute');
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM task_boost_matches(p_filter);
  -- 手動任務的順序在 TS 用 last_dispatched_at 算（沒派過＝最前），這裡把它清成 NULL 就等於插到最前
  UPDATE contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  UPDATE task_dispatches d SET queue_at = LEAST(d.queue_at, v_at)
    FROM _boost_hits h WHERE h.task_id = d.task_id;
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;

-- 09:00 那一發失敗時 INSERT 已回滾（同一交易），task_boosts 不會留下空紀錄；這裡只確認
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM task_boosts WHERE matched_tasks = 0 AND matched_verifies = 0;
  IF n > 0 THEN RAISE NOTICE 'task_boosts 有 % 筆零命中的紀錄（失敗那發若留下來會在這裡）', n; END IF;
END $$;
