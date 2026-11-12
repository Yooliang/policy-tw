-- 工作卡②：插隊帶動同卡驗證票（2026-11-12，docs/PLAN-workcard-123.md 第 2 節，維護者裁決①②③都做）
--
-- 問題：/boost 只對 task_boost_matches 命中的列加 boost_seconds，命中只靠 filter，所以任務被插隊、同一張工作卡（同 work_key）
--   底下已經在隊的驗證票沒有跟著前移，交件之後的驗證排在別處。
-- 做法：task_boost 在命中之後，把「同 work_key 的驗證票列」（task_id 以 verify: 開頭、在 task_dispatches 裡）補進暫存表 _boost_hits
--   （kind＝'card_verify'）。filter 命中的列照舊「加一份 queue_settings.boost_seconds」；帶動的票改成「吃同一份」而不是累加：
--   票的插隊不因派出歸零（20261104120000），累加的話重複 /boost 同一任務票會一路疊（正式庫曾有票疊到 20～40 年），
--   所以票的 boost_seconds ＝ GREATEST(票現值, 同卡被命中任務列加完之後的 boost_seconds)（同卡多個命中任務取最大）。
--   驗證票的 queue_at 由觸發器 task_dispatches_queue_key 讀 boost_seconds 照 verify_ticket_key 重算（20261104120000）。
--   · 只由「命中的任務列（kind='task'）」帶出同卡的票；命中的驗證票不反向帶任務、不帶別張票（計畫第 2.3 節：不做反向）
--   · 已經因 filter 命中的票不算帶動（NOT EXISTS 去重），照 filter 命中的規則加一份
--   · 帶動的票 cooling 暫時設 false（同被插隊的列），10 分鐘內由 refresh_dispatch_blocked 重算
--   · filter 新增 card_tickets（boolean，預設 true）：false＝只插任務、不帶票。task_boost_matches 不動（它對沒讀的鍵一律忽略）
--   · 回傳多 card_tickets（帶動的驗證票數）；task_boosts 新欄位 card_ticket_ids（被帶動的 task_id，事後查得到誰被帶動）；
--     matched_verifies 維持「filter 命中的票數」；queue_at 仍是 filter 命中的列的最前面排序鍵（不把帶動的票算進去）
--   · 不動 priority_seconds、不動 seed、不動 #936 的選舉年項；簽名與回傳型別（jsonb）不變，只多一個鍵，
--     既有呼叫端（Edge Function boost／jp-boost 只轉傳 data）不受影響
--   · 日本站（policy_jp.task_boost）不跟（沒有 work_key）；policy-jp-boost.test.ts 的骨架對照停在 20261017 之前，不受影響
-- 以 20261019050000 的現行定義為底整支重貼（20261104110000 只改權限，不動本體）；標 >>> 的是這次新增。

ALTER TABLE task_boosts ADD COLUMN IF NOT EXISTS card_ticket_ids TEXT[];
COMMENT ON COLUMN task_boosts.card_ticket_ids IS '這次插隊帶動的同卡驗證票 task_id（2026-11-12；filter.card_tickets=false 或沒有同卡票時是空陣列）';

CREATE OR REPLACE FUNCTION task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ; v_cards INTEGER := 0; v_card_ids TEXT[] := '{}';
BEGIN
  INSERT INTO task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM task_boost_matches(p_filter);
  -- >>> 同卡驗證票（20261112060000）：命中的任務列同一張卡（work_key）底下的驗證票一起插隊；filter.card_tickets＝false 時略過
  IF COALESCE((p_filter->>'card_tickets')::BOOLEAN, true) THEN
    INSERT INTO _boost_hits
      SELECT DISTINCT v.task_id, 'card_verify'
        FROM task_dispatches v
        JOIN task_dispatches p ON p.work_key = v.work_key AND p.task_id NOT LIKE 'verify:%'
        JOIN _boost_hits h ON h.kind = 'task' AND h.task_id = p.task_id
       WHERE v.task_id LIKE 'verify:%'
         AND v.work_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM _boost_hits x WHERE x.task_id = v.task_id);
    SELECT COALESCE(array_agg(task_id ORDER BY task_id), '{}'), count(*)::INTEGER INTO v_card_ids, v_cards FROM _boost_hits WHERE kind = 'card_verify';
  END IF;
  -- <<< 同卡驗證票
  UPDATE contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  -- 任務列與驗證票一樣加插隊秒數（queue_settings.boost_seconds，插幾次加幾份，派出就歸零），queue_at 由觸發器照排序鍵馬上重算；插隊的不受冷卻擋
  UPDATE task_dispatches d SET boost_seconds = d.boost_seconds + q.boost_seconds, cooling = false
    FROM _boost_hits h, queue_settings q WHERE q.id = 1 AND h.task_id = d.task_id AND h.kind <> 'card_verify';
  -- >>> 同卡驗證票（20261112060000）：帶動的票吃同一份（取同卡命中任務列加完後的 boost_seconds 與票現值的較大者），不累加
  UPDATE task_dispatches d SET boost_seconds = GREATEST(d.boost_seconds, m.b), cooling = false
    FROM (SELECT v.task_id, max(p.boost_seconds) AS b
            FROM _boost_hits hv
            JOIN task_dispatches v ON v.task_id = hv.task_id
            JOIN task_dispatches p ON p.work_key = v.work_key AND p.task_id NOT LIKE 'verify:%'
            JOIN _boost_hits hp ON hp.kind = 'task' AND hp.task_id = p.task_id
           WHERE hv.kind = 'card_verify'
           GROUP BY v.task_id) m
   WHERE d.task_id = m.task_id;
  -- <<< 同卡驗證票
  -- 母任務剛被插隊的，它還跟著它的驗證票跟著走
  PERFORM refresh_verify_ticket_keys();
  -- 回傳值的 queue_at：這次插隊 filter 命中的列現在最前面的排序鍵（沒有命中的列就是 NULL；帶動的票不算）
  SELECT min(d.queue_at) INTO v_at FROM task_dispatches d JOIN _boost_hits h ON h.task_id = d.task_id AND h.kind <> 'card_verify';
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies, card_ticket_ids = v_card_ids WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'card_tickets', v_cards, 'queue_at', v_at);
END;
$$;
