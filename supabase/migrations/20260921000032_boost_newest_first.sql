-- 插隊改成「最新的排最前」（2026-09-22，candlefish 實測：領到的是 boost#1 那批，不是剛插的六都）
--
-- 000030 把第 n 次插隊放在 1980-01-01 + n 分鐘，先插的先派（FIFO）。使用者要的「插隊」是字面意思：
-- 剛插的排到最前面，之前插的往後順延。改成 1980-01-01 − n 分鐘：n 越大越早。
-- 訪客看得到的驗證（提問回答、網站按鈕觸發）仍要在所有插隊之前，改給 1970-01-01。
-- 000020 硬編碼優先留下的 35 筆（queue_at 正好 1980-01-01 的任務列）跟 boost#1 是同一條規則，併到 boost#1 的位置。

CREATE OR REPLACE FUNCTION contribution_queue_at(p_contribution_type TEXT, p_task_id TEXT, p_created_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_contribution_type = 'question_answer' THEN TIMESTAMPTZ '1970-01-01'
    WHEN EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = p_task_id AND t.source = 'web_request') THEN TIMESTAMPTZ '1970-01-01'
    ELSE p_created_at
  END;
$$;

CREATE OR REPLACE FUNCTION task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  PERFORM seed_auto_task_queue();
  INSERT INTO task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  -- 最新的插隊最前：第 n 次 → 1980-01-01 減 n 分鐘
  v_at := TIMESTAMPTZ '1980-01-01' - (v_id * INTERVAL '1 minute');
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM task_boost_matches(p_filter);
  UPDATE contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  UPDATE task_dispatches d SET queue_at = LEAST(d.queue_at, v_at)
    FROM _boost_hits h WHERE h.task_id = d.task_id;
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;

-- 既有的列換算到新規則（只動 1980 年段、還沒被領走的）
UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1970-01-01'
 WHERE task_id LIKE 'verify:%' AND queue_at = TIMESTAMPTZ '1980-01-01';
UPDATE task_dispatches SET queue_at = TIMESTAMPTZ '1980-01-01' - INTERVAL '1 minute'
 WHERE task_id NOT LIKE 'verify:%' AND queue_at = TIMESTAMPTZ '1980-01-01';
UPDATE task_dispatches d SET queue_at = TIMESTAMPTZ '1980-01-01' - (b.id * INTERVAL '1 minute')
  FROM task_boosts b
 WHERE d.queue_at = TIMESTAMPTZ '1980-01-01' + (b.id * INTERVAL '1 minute');

-- 剩餘量的判準：1990 年以前都算插隊段（1970／1979 都涵蓋），不用改
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT to_char(queue_at, 'YYYY-MM-DD HH24:MI') AS q, count(*) AS n FROM task_dispatches WHERE queue_at < '1990-01-01' GROUP BY 1 ORDER BY 1 LOOP
    RAISE NOTICE '插隊段 % → % 筆', r.q, r.n;
  END LOOP;
END $$;
