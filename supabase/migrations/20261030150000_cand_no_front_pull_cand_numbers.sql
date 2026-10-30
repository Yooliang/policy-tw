-- 整批號次驗證票（cand_numbers）也要插隊（2026-10-30，#784 漏的）
--   cand_no_front_pull() 把驗證列插隊的條件寫死 contribution_type='candidacy' AND payload ? 'cand_no'，
--   #784（20261030130000）新增的 cand_numbers 型別（一個單位一張整批驗證票，職位在 payload.election_type）沒被納入，
--   237 張整批驗證票 boost_seconds=0，被已插隊的缺口任務擠在後面。
-- 做法：以 20261030050000 的函式為底，驗證列的條件加上 cand_numbers；倍數比照同單位缺口任務：
--   縣市長／縣市議員 3 ×；當前提前職位（依序清單第一個還有缺口列的職位）2.5 ×；其餘 2 ×。單人 candidacy 驗證列維持原規則。
--   只補不減、被派出歸零、每小時第 3 分、2026-11-28 停，全不變。
-- 守門：cand-no-front-pull-verify-types.test.ts（新增號次相關驗證型別沒被涵蓋就紅）。
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
  UPDATE task_dispatches d
     SET boost_seconds = x.want, cooling = false
    FROM (
      SELECT d2.task_id,
             CASE WHEN d2.target->>'kind' = 'cand_no' THEN
                    CASE WHEN d2.target->>'election_type' IN ('縣市長', '縣市議員') THEN v_top
                         WHEN d2.target->>'election_type' = v_cur THEN v_seq
                         ELSE v_boost END
                  ELSE
                    (SELECT CASE WHEN c.payload->>'election_type' IN ('縣市長', '縣市議員') THEN v_top
                                 WHEN c.contribution_type = 'cand_numbers' AND c.payload->>'election_type' = v_cur THEN v_seq
                                 ELSE v_boost END
                       FROM contributions c
                      WHERE d2.task_id = 'verify:' || c.id::text
                        AND c.status = 'pending'
                        AND ((c.contribution_type = 'candidacy' AND c.payload ? 'cand_no')
                             OR c.contribution_type = 'cand_numbers'))
             END AS want
        FROM task_dispatches d2
    ) x
   WHERE d.task_id = x.task_id
     AND x.want IS NOT NULL
     AND d.boost_seconds < x.want;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION cand_no_front_pull IS '號次的缺口列與等票的驗證列（單人 candidacy 帶 cand_no、整批 cand_numbers 都算），插隊秒數至少拉到 2 × visitor_front_seconds；縣市長、縣市議員 3 ×；依序清單（鄉鎮市長→山地原住民區長→鄉鎮市民代表→山地原住民區民代表→村里長）中第一個還有缺口列的職位拉到 2.5 ×；pg_cron 每小時第 3 分；2026-11-28 之後不做事（2026-10-30，維護者）';
-- 上線當下先跑一次，不用等到下個整點
SELECT cand_no_front_pull();
