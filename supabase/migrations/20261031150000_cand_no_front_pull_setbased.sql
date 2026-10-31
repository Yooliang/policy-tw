-- cand_no_front_pull 逾時修正（2026-10-31，熱修）
--   根因：20261031140000 版把驗證列的判斷寫成「每一列 task_dispatches 各跑一個相關子查詢，條件 d2.task_id = 'verify:' || c.id::text」。
--   這個運算式對 contributions 無法走索引，每列掃一次整張表；加了 no_change 一種之後 12:03 的排程撞 statement timeout（cron.job_run_details：failed，canceling statement due to statement timeout），
--   整支 UPDATE 回滾，234 張補號次缺口的 no_change 驗證票 boost 全是 0。
--   改法：先把 contributions 一次掃完、算出每張驗證票要的秒數（CTE v），再用 task_id 等值連到 task_dispatches（集合式，一次掃描）。語意與 140000 版一字不差。
--   結尾呼叫一次函式，讓現有票立刻插隊。
CREATE OR REPLACE FUNCTION cand_no_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER; v_boost BIGINT; v_top BIGINT; v_seq BIGINT; v_cur TEXT;
BEGIN
  IF activity_today() > DATE '2026-11-28' THEN RETURN 0; END IF;
  SELECT 2 * q.visitor_front_seconds, 3 * q.visitor_front_seconds, 5 * q.visitor_front_seconds / 2
    INTO v_boost, v_top, v_seq FROM queue_settings q WHERE q.id = 1;
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
            -- 補號次缺口任務的 no_change（「找不到號次」）：任務被它擋住（冷卻）、驗證票沒插隊排在後面，驗掉才會解除並帶新 hint 重派（2026-10-31）
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
     AND d.boost_seconds < x.want;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION cand_no_front_pull IS '號次的缺口列與等票的驗證列（單人 candidacy 帶 cand_no、整批 cand_numbers 都算），插隊秒數至少拉到 2 × visitor_front_seconds；縣市長、縣市議員 3 ×；依序清單（鄉鎮市長→山地原住民區長→鄉鎮市民代表→山地原住民區民代表→村里長）中第一個還有缺口列的職位拉到 2.5 ×；擋住號次缺口的同名人物合併任務（target.cand_no_gap）3 ×；pg_cron 每小時第 3 分；2026-11-28 之後不做事（2026-10-31）';

SET LOCAL statement_timeout = '5min';
SELECT cand_no_front_pull();
