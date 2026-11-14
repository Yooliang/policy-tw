-- 派工：插隊改天級（2026-11-14，維護者拍板）
-- ============================================================
--
-- 插隊（boost_seconds）原本是年級：/boost 與維護者建的手動任務 5 年、網站請求與公民提問 10 年。年級的插隊比全部優先因素加起來
-- （選舉年 2600 天＋前段＋需求＋類別 ≈ 2,623 天）還大，一插隊就壓過一切；改成天級，插隊只在同一屆上下做微調。
--
-- 新值（queue_settings，秒）：
--   boost_seconds            157680000（5 年）→ 2592000（30 天）   /boost 一次的插隊
--   manual_front_seconds     157680000（5 年）→ 2592000（30 天）   維護者建的手動任務與裁決第一次進佇列
--   visitor_front_seconds    315360000（10 年）→ 5184000（60 天）  網站請求、公民提問第一次進佇列與固定時段拉回；「請求併入缺口」與併卡插隊
--                                                                    （web_request_gap_boost、work_card_attach）本來就讀這一欄，所以跟著變，沒有寫死年數
-- 回退：見 docs/decisions/2026-11-14-派工優先依選舉類別提前天數.md 的「插隊改天級」段（舊值、回退 SQL）。
--
-- 沒動：
--   · 號次拉前（cand_no_front_pull，20／25／30 年，到 2026-11-28 止）：原本用 visitor_front_seconds 的 2×、3×、2.5× 算，
--     改小 visitor_front_seconds 會連帶縮成 120／150／180 天，所以這支把三個值改成寫死的原值（630720000、788400000、946080000 秒），其餘一字不動
--   · 驗證票跟著母任務／同卡帶動的取最大邏輯、排序鍵公式、冷卻、優先秒數：不動，只是數值變小
--   · 日本站（policy_jp.queue_settings 另有一份）：不跟
--
-- 既有佇列上的 boost_seconds 一次性縮放（冪等：queue_settings.boost_days_applied_at 有值就整段跳過）：
--   新值 ＝ 舊值 × 2592000 ÷ 157680000（5 年→30 天、10 年→60 天、15 年→90 天，同一個比例，所以不必分辨「兩次 /boost」還是「一次網站請求」）。
--   例外：20／25／30 年（630720000、788400000、946080000）的列是號次拉前（正式庫唯讀實測 2026-11-14：全是驗證票，20 年 17 張、25 年 4 張），不縮。
--   縮放前後的分布由 NOTICE 在套用當下印出。觸發器 task_dispatches_queue_key 跟著重算 queue_at；cooling 由 refresh_dispatch_blocked 十分鐘內重算。
--   正式庫唯讀實測 2026-11-14（縮放前，任務列：5 年 805 列、10 年 4 列、15 年 1 列；驗證票：20 年 17 張、25 年 4 張）：
--     5 年的 805 列是自動缺口 profile_gap 431、policy_missing 301、policy_election_missing 3 與少數手動任務（uuid）；10 年 4 列、15 年 1 列。

ALTER TABLE queue_settings ALTER COLUMN boost_seconds         SET DEFAULT 2592000;
ALTER TABLE queue_settings ALTER COLUMN manual_front_seconds  SET DEFAULT 2592000;
ALTER TABLE queue_settings ALTER COLUMN visitor_front_seconds SET DEFAULT 5184000;
COMMENT ON COLUMN queue_settings.boost_seconds IS '/boost 插隊一次加幾秒（2026-11-14 起 30 天，原 5 年）；插兩次加兩份；任務列派出就歸零';
COMMENT ON COLUMN queue_settings.visitor_front_seconds IS '網站請求／公民提問第一次進佇列、固定時段拉回、請求併入缺口與併卡時的插隊秒數（2026-11-14 起 60 天，原 10 年）';
COMMENT ON COLUMN queue_settings.manual_front_seconds IS '維護者建的手動任務與裁決第一次進佇列的插隊秒數（2026-11-14 起 30 天，原 5 年）';

ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS boost_days_applied_at TIMESTAMPTZ;
COMMENT ON COLUMN queue_settings.boost_days_applied_at IS '插隊改天級（20261114020000）的一次性縮放做完的時間；有值＝已套用，重跑 migration 不再縮。2026-11-14';

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
DECLARE r RECORD; v_n INTEGER;
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
     SET boost_seconds = 2592000, manual_front_seconds = 2592000, visitor_front_seconds = 5184000,
         note = COALESCE(note || '；', '') || '2026-11-14 插隊改天級：/boost 5 年→30 天、維護者建的 5 年→30 天、網站請求 10 年→60 天（舊值 157680000／157680000／315360000）'
   WHERE id = 1;

  UPDATE task_dispatches d
     SET boost_seconds = GREATEST(1, d.boost_seconds * 2592000 / 157680000)
   WHERE d.boost_seconds > 0
     AND d.boost_seconds NOT IN (630720000, 788400000, 946080000);   -- 號次拉前（20／25／30 年）不縮
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '縮放 % 列的 boost_seconds', v_n;

  FOR r IN SELECT (d.task_id LIKE 'verify:%') AS is_verify, d.boost_seconds AS b, count(*) AS n
             FROM task_dispatches d WHERE d.boost_seconds > 0 GROUP BY 1, 2 ORDER BY 1, 2 LOOP
    RAISE NOTICE '縮放後 驗證票＝% 插隊 % 秒（% 天）：% 列', r.is_verify, r.b, round(r.b / 86400.0, 1), r.n;
  END LOOP;

  UPDATE queue_settings SET boost_days_applied_at = now() WHERE id = 1;
END;
$$;

NOTIFY pgrst, 'reload schema';
