-- 派工：插隊改天級（2026-11-14，維護者拍板；網站請求依目標選舉階段分選前／選後兩個值，小良哥 #683 裁示）
-- ============================================================
--
-- 插隊（boost_seconds）原本是年級：/boost 與維護者建的手動任務 5 年、網站請求與公民提問 10 年。年級的插隊比全部優先因素加起來
-- （選舉年 2600 天＋前段＋需求＋類別 ≈ 2,623 天）還大，一插隊就壓過一切；改成天級，插隊只在同一屆上下做微調。
--
-- 新值（queue_settings，秒）：
--   boost_seconds                         157680000（5 年）→ 2592000（30 天）   /boost 一次的插隊
--   manual_front_seconds                  157680000（5 年）→ 2592000（30 天）   維護者建的手動任務與裁決第一次進佇列
--   網站請求、公民提問第一次進佇列、固定時段拉回、請求併入缺口、併卡插隊：依「目標對應那一屆選舉」的階段分兩個值，不再是單一的 10 年——
--     visitor_front_pre_election_seconds  （新欄）預設 8640000（100 天）：選前，目標選舉的投票日 ≥ 今天（台北日期，投票日當天算選前）
--     visitor_front_seconds               （舊欄 315360000＝10 年，改成選後／預設值）預設 4320000（50 天）：選後（投票日 < 今天），
--                                          以及對不上任何選舉的目標（沒有 election_id、查無這場選舉、公民提問…）
--   兩個值都能 UPDATE 調整。判斷集中在新函式 visitor_front_seconds_for(target)，四個讀 visitor_front_seconds 的地方
--   （manual_front_seconds、manual_front_pull、web_request_gap_boost、work_card_attach）都改呼叫它；選舉用 target.election_id → elections.election_date。
-- 回退：見 docs/decisions/2026-11-14-派工優先依選舉類別提前天數.md 的「插隊改天級」段（舊值、回退 SQL）。
--
-- 沒動：
--   · 號次拉前（cand_no_front_pull，20／25／30 年，到 2026-11-28 止）：原本用 visitor_front_seconds 的 2×、3×、2.5× 算，
--     改小 visitor_front_seconds 會連帶縮成很小的值，所以這支把三個值改成寫死的原值（630720000、788400000、946080000 秒），其餘一字不動
--   · 驗證票跟著母任務／同卡帶動的取最大邏輯、排序鍵公式、冷卻、優先秒數：不動，只是數值變小
--   · 日本站（policy_jp.queue_settings 另有一份）：不跟
--
-- 既有佇列上的 boost_seconds 一次性縮放（冪等：queue_settings.boost_days_applied_at 有值就整段跳過）：
--   · 一般比例：新值 ＝ 舊值 × 2592000 ÷ 157680000（5 年→30 天、10 年→60 天、15 年→90 天；分不出來源的，例如兩次 /boost 疊成的 10 年，一律用這個比例）
--   · 例外一（網站請求來源）：值正好是 10 年（315360000）、而且是網站請求／公民提問的手動任務（manual_task_is_visitor），
--     或缺口列上有 opened_by.web_request_boost_ids（請求併入缺口時標的）→ 改成「依該件目標選舉階段」的值（選前 100 天、選後與對不上 50 天）
--   · 例外二（號次拉前）：20／25／30 年（630720000、788400000、946080000）不縮（正式庫唯讀實測 2026-11-14：全是驗證票，20 年 17 張、25 年 4 張）
--   縮放前後的分布由 NOTICE 在套用當下印出。觸發器 task_dispatches_queue_key 跟著重算 queue_at；cooling 由 refresh_dispatch_blocked 十分鐘內重算。
--   正式庫唯讀實測 2026-11-14（縮放前，任務列：5 年 805 列、10 年 4 列、15 年 1 列；驗證票：20 年 17 張、25 年 4 張）：
--     5 年的 805 列是自動缺口 profile_gap 431、policy_missing 301、policy_election_missing 3 與少數手動任務（uuid）；10 年 4 列、15 年 1 列。

ALTER TABLE queue_settings ALTER COLUMN boost_seconds         SET DEFAULT 2592000;
ALTER TABLE queue_settings ALTER COLUMN manual_front_seconds  SET DEFAULT 2592000;
ALTER TABLE queue_settings ALTER COLUMN visitor_front_seconds SET DEFAULT 4320000;
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS visitor_front_pre_election_seconds BIGINT NOT NULL DEFAULT 8640000 CHECK (visitor_front_pre_election_seconds >= 0);
COMMENT ON COLUMN queue_settings.boost_seconds IS '/boost 插隊一次加幾秒（2026-11-14 起 30 天，原 5 年）；插兩次加兩份；任務列派出就歸零';
COMMENT ON COLUMN queue_settings.visitor_front_seconds IS '網站請求／公民提問的插隊秒數，選後與對不上選舉的目標用這個值（2026-11-14 起 50 天，原 10 年）；選前用 visitor_front_pre_election_seconds。判斷在 visitor_front_seconds_for(target)';
COMMENT ON COLUMN queue_settings.visitor_front_pre_election_seconds IS '網站請求／公民提問的插隊秒數，目標選舉的投票日 ≥ 今天（選前）用這個值（100 天）。2026-11-14，小良哥 #683 裁示';
COMMENT ON COLUMN queue_settings.manual_front_seconds IS '維護者建的手動任務與裁決第一次進佇列的插隊秒數（2026-11-14 起 30 天，原 5 年）';

ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS boost_days_applied_at TIMESTAMPTZ;
COMMENT ON COLUMN queue_settings.boost_days_applied_at IS '插隊改天級（20261114020000）的一次性縮放做完的時間；有值＝已套用，重跑 migration 不再縮。2026-11-14';

-- 網站請求的插隊秒數：看目標對應的那一屆選舉。target.election_id → elections.election_date；投票日 ≥ 今天（台北日期）＝選前，其餘（選後、沒有選舉、查無）＝選後值
CREATE OR REPLACE FUNCTION visitor_front_seconds_for(p_target JSONB) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN e.election_date IS NOT NULL AND e.election_date >= activity_today() THEN q.visitor_front_pre_election_seconds ELSE q.visitor_front_seconds END
    FROM queue_settings q
    LEFT JOIN elections e ON e.id = election_id_or_null(p_target->>'election_id')
   WHERE q.id = 1
$$;
COMMENT ON FUNCTION visitor_front_seconds_for IS '網站請求／公民提問的插隊秒數（20261114020000）：目標選舉（target.election_id）投票日 ≥ 今天＝visitor_front_pre_election_seconds（100 天），投票日已過、沒有選舉、查無這場選舉＝visitor_front_seconds（50 天）。2026-11-14，小良哥 #683 裁示';


CREATE OR REPLACE FUNCTION manual_front_seconds(p_task_id TEXT) RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t.created_by = 'auto-overvoted' THEN 0
              WHEN manual_task_is_visitor(t.source, t.task_type) THEN visitor_front_seconds_for(t.target)  -- 依目標選舉階段（20261114020000）
              WHEN t.source IN ('manual', 'auto_dispute') THEN q.manual_front_seconds
              ELSE 0 END
    FROM contribution_tasks t CROSS JOIN queue_settings q
   WHERE q.id = 1 AND t.id::TEXT = p_task_id
$$;

CREATE OR REPLACE FUNCTION manual_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_slot TIMESTAMPTZ := visitor_front_slot_start(); n INTEGER;
BEGIN
  IF v_slot IS NULL THEN RETURN 0; END IF;
  -- >>> 優先秒數（20261011320000）：拉回前段＝插隊一次（visitor_front_seconds，原本排到 1970）；已經拉過的（插隊秒數已達這個值）不重複加
  UPDATE task_dispatches d SET boost_seconds = visitor_front_seconds_for(d.target)  -- 依目標選舉階段（20261114020000）
    FROM queue_settings q
   WHERE q.id = 1
     AND d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(true) m)
     AND (d.dispatch_count = 0 OR d.last_dispatched_at < v_slot)
     AND d.boost_seconds < visitor_front_seconds_for(d.target)
     -- >>> 查核階梯冷卻中不拉（2026-11-09；原 2026-11-07 的「2 天內有 not_found」）：10 年的插隊秒數會把排序鍵拉到 2016 年，cooling 變 false，冷卻中的任務又被派出去
     AND NOT task_in_check_cooldown(d.task_id);
     -- <<< 查核階梯冷卻中不拉
  -- <<< 優先秒數
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION web_request_gap_boost(p_gap TEXT DEFAULT NULL, p_req UUID DEFAULT NULL) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  WITH fresh AS (
    SELECT c.gap_task_id, jsonb_agg(c.task_id::TEXT ORDER BY c.requested_at, c.task_id) AS ids
      FROM web_request_coverage c
     WHERE NOT c.boost_counted AND (p_gap IS NULL OR c.gap_task_id = p_gap) AND (p_req IS NULL OR c.task_id = p_req)
     GROUP BY c.gap_task_id),
  upd AS (
    UPDATE task_dispatches d
       SET boost_seconds = GREATEST(d.boost_seconds, visitor_front_seconds_for(d.target)),  -- 依目標選舉階段（20261114020000）
           opened_by = jsonb_set(COALESCE(d.opened_by, '{}'::JSONB), '{web_request_boost_ids}',
                                 COALESCE(d.opened_by->'web_request_boost_ids', '[]'::JSONB) || f.ids)
      FROM fresh f
     WHERE d.task_id = f.gap_task_id
       AND (d.cool_until IS NULL OR d.cool_until <= now())
       AND NOT task_in_check_cooldown(d.task_id)
    RETURNING 1)
  SELECT count(*) INTO n FROM upd;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION work_card_attach(p_work_key TEXT, p_kind TEXT, p_actor TEXT, p_boost BOOLEAN DEFAULT FALSE, p_scope TEXT DEFAULT NULL,
                                     p_note TEXT DEFAULT NULL, p_source TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task  TEXT;
  v_added BOOLEAN := FALSE;
  v_boosted INTEGER := 0;
  v_cool  TIMESTAMPTZ;
  v_last  TIMESTAMPTZ;
BEGIN
  IF COALESCE(p_work_key, '') = '' OR p_work_key LIKE 'task:%' THEN
    RETURN jsonb_build_object('attached', FALSE, 'work_key', p_work_key);
  END IF;
  v_task := work_card_resolve(p_work_key, p_scope);
  IF v_task IS NULL THEN
    RETURN jsonb_build_object('attached', FALSE, 'work_key', p_work_key);
  END IF;
  IF p_kind IS NOT NULL THEN
    v_added := work_card_signal_add(p_work_key, p_kind, p_actor);
  END IF;
  IF COALESCE(p_note, '') <> '' THEN
    INSERT INTO work_card_notes (work_key, source, actor, note) VALUES (p_work_key, COALESCE(p_source, 'unknown'), NULLIF(p_actor, ''), left(p_note, 2000));
  END IF;
  -- 卡在查核冷卻中：訊號照寫（冷卻結束後 ① 的需求疊加會把它帶回前面，不用插隊），回報給呼叫端當「近期查過」
  SELECT st.check_cool_until, st.last_checked_at INTO v_cool, v_last FROM work_key_ladder_state(p_work_key) st;
  IF v_cool IS NOT NULL AND v_cool > now() THEN
    RETURN jsonb_build_object('attached', TRUE, 'task_id', v_task, 'work_key', p_work_key, 'signal_added', v_added, 'boosted', 0,
                              'cooling', TRUE, 'cool_until', v_cool, 'last_checked_at', v_last);
  END IF;
  -- 插隊：只在這次真的新增（或續期）了訊號時，同 #912 的待遇：GREATEST（不疊加）、查核冷卻中不插
  IF p_boost AND v_added THEN
    UPDATE task_dispatches d
       SET boost_seconds = GREATEST(d.boost_seconds, visitor_front_seconds_for(d.target))  -- 依目標選舉階段（20261114020000）
     WHERE d.work_key = p_work_key AND d.task_id NOT LIKE 'verify:%'
       AND (d.cool_until IS NULL OR d.cool_until <= now())
       AND NOT task_in_check_cooldown(d.task_id)
       AND d.boost_seconds < visitor_front_seconds_for(d.target);
    GET DIAGNOSTICS v_boosted = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('attached', TRUE, 'task_id', v_task, 'work_key', p_work_key, 'signal_added', v_added, 'boosted', v_boosted, 'cooling', FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION cand_no_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER; v_boost BIGINT; v_top BIGINT; v_seq BIGINT; v_cur TEXT;
BEGIN
  IF activity_today() > DATE '2026-11-28' THEN RETURN 0; END IF;
  -- >>> 插隊改天級（20261114020000）：號次拉前不跟著 visitor_front_seconds 縮小，維持原本的 20／30／25 年（原值＝2×、3×、2.5× 的 315360000 秒），到 2026-11-28 為止
  v_boost := 630720000; v_top := 946080000; v_seq := 788400000;
  -- <<< 插隊改天級
  IF v_boost IS NULL OR v_boost <= 0 THEN RETURN 0; END IF;
  -- 當前提前職位：依序清單中第一個還有號次缺口列的職位
  SELECT s.et INTO v_cur
    FROM unnest(ARRAY['鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長']) WITH ORDINALITY AS s(et, ord)
   WHERE EXISTS (SELECT 1 FROM task_dispatches t WHERE t.target->>'kind' = 'cand_no' AND t.target->>'election_type' = s.et)
   ORDER BY s.ord LIMIT 1;
  WITH v AS (
    SELECT 'verify:' || c.id::text AS tid,
           CASE WHEN c.contribution_type = 'no_change' THEN v_top   -- 補號次缺口的 no_change 驗證票：3 ×，快點驗掉
                WHEN c.payload->>'election_type' IN ('縣市長', '縣市議員') THEN v_top
                WHEN c.contribution_type = 'cand_numbers' AND c.payload->>'election_type' = v_cur THEN v_seq
                ELSE v_boost END AS want
      FROM contributions c
     WHERE c.status = 'pending'
       AND ((c.contribution_type = 'candidacy' AND c.payload ? 'cand_no')
            OR c.contribution_type = 'cand_numbers'
            -- 補號次缺口任務的 no_change（confirmed；not_found 2026-11-07 起不進票）
            OR (c.contribution_type = 'no_change' AND c.payload->>'task_id' LIKE 'auto:candidacy_source_missing:cand_no:%'))
  )
  UPDATE task_dispatches d
     SET boost_seconds = x.want, cooling = false
    FROM (
      SELECT d2.task_id,
             CASE WHEN d2.target->>'cand_no_gap' = 'true' THEN v_top   -- 擋住號次缺口的同名人物合併任務（contribution_auto_tasks_dup 的 target.cand_no_gap）
                  WHEN d2.target->>'kind' = 'cand_no' THEN
                    CASE WHEN d2.target->>'election_type' IN ('縣市長', '縣市議員') THEN v_top
                         WHEN d2.target->>'election_type' = v_cur THEN v_seq
                         ELSE v_boost END
                  ELSE v.want
             END AS want
        FROM task_dispatches d2
        LEFT JOIN v ON v.tid = d2.task_id
    ) x
   WHERE d.task_id = x.task_id
     AND x.want IS NOT NULL
     AND d.boost_seconds < x.want
     -- >>> 查核階梯冷卻中不拉（2026-11-07 查無 2 天；2026-11-09 改看階梯，號次缺口不再是階梯的例外）
     AND (d.cool_until IS NULL OR d.cool_until <= now())
     AND NOT task_in_check_cooldown(d.task_id);
     -- <<< 查核階梯冷卻中不拉
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

DO $$
DECLARE r RECORD; v_n INTEGER; v_v INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM queue_settings WHERE id = 1 AND boost_days_applied_at IS NOT NULL) THEN
    RAISE NOTICE '插隊改天級已套用過，略過';
    RETURN;
  END IF;

  FOR r IN SELECT (d.task_id LIKE 'verify:%') AS is_verify, d.boost_seconds AS b, count(*) AS n
             FROM task_dispatches d WHERE d.boost_seconds > 0 GROUP BY 1, 2 ORDER BY 1, 2 LOOP
    RAISE NOTICE '縮放前 驗證票＝% 插隊 % 秒（% 天）：% 列', r.is_verify, r.b, round(r.b / 86400.0, 1), r.n;
  END LOOP;

  UPDATE queue_settings
     SET boost_seconds = 2592000, manual_front_seconds = 2592000, visitor_front_seconds = 4320000, visitor_front_pre_election_seconds = 8640000,
         note = COALESCE(note || '；', '') || '2026-11-14 插隊改天級：/boost 5 年→30 天、維護者建的 5 年→30 天、網站請求 10 年→選前 100 天／選後 50 天（舊值 157680000／157680000／315360000）'
   WHERE id = 1;

  -- 例外一：網站請求來源的 10 年（手動任務是網站請求／公民提問，或缺口列標了 web_request_boost_ids）→ 依目標選舉階段
  UPDATE task_dispatches d
     SET boost_seconds = visitor_front_seconds_for(d.target)
   WHERE d.boost_seconds = 315360000
     AND (d.opened_by ? 'web_request_boost_ids'
          OR EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = d.task_id AND manual_task_is_visitor(t.source, t.task_type)));
  GET DIAGNOSTICS v_v = ROW_COUNT;
  RAISE NOTICE '網站請求來源的 10 年（依目標選舉階段改成選前 100 天／選後 50 天）：% 列', v_v;

  -- 一般比例（含分不出來源的 10 年）；號次拉前的 20／25／30 年不縮；上面已改成天級的（≤ 100 天）不再縮
  UPDATE task_dispatches d
     SET boost_seconds = GREATEST(1, d.boost_seconds * 2592000 / 157680000)
   WHERE d.boost_seconds > 8640000
     AND d.boost_seconds NOT IN (630720000, 788400000, 946080000);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '依 /boost 比例縮放 % 列的 boost_seconds', v_n;

  FOR r IN SELECT (d.task_id LIKE 'verify:%') AS is_verify, d.boost_seconds AS b, count(*) AS n
             FROM task_dispatches d WHERE d.boost_seconds > 0 GROUP BY 1, 2 ORDER BY 1, 2 LOOP
    RAISE NOTICE '縮放後 驗證票＝% 插隊 % 秒（% 天）：% 列', r.is_verify, r.b, round(r.b / 86400.0, 1), r.n;
  END LOOP;

  UPDATE queue_settings SET boost_days_applied_at = now() WHERE id = 1;
END;
$$;

NOTIFY pgrst, 'reload schema';
