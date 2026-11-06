-- 「查無」不進投票、冷卻 2 天（2026-11-07，維護者小良，協議 1.119.0）
--   任何任務的 no_change＋outcome=not_found 不再等驗證票：交件當下直接落庫為 applied（contribute-handler，reviewed_by＝system:not-found-direct），
--   任務冷卻 2 天後重新派出。驗證原本是為了擋「錯報查無就鎖 14 天」，冷卻只剩 2 天，錯報代價小、票是浪費。confirmed 的 no_change 不變，仍要票。
--   手動任務（uuid）的 not_found 也一樣：記一筆 task_checks 進冷卻、不關任務（TS applyNoChange）。
--   進度追蹤類（task_cooldown_settings.task_types）同一個任務第二次起的 not_found 保留設定表的 not_found_repeat_days（30 天）。
--   本檔四件事：1. task_check_cooldown_days_for  2. cand_no_front_pull 不再把冷卻中的缺口拉回隊頭  3. 舊的等票中查無一次清掉  4. 清掉冷卻中缺口的殘留插隊秒數。

-- ------------------------------------------------------------
-- 1. 冷卻天數：not_found 一律 2 天（進度追蹤類第二次起照設定表）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_not_found_cooldown_days() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;
COMMENT ON FUNCTION task_not_found_cooldown_days IS '「查無」（no_change not_found）的冷卻天數＝2（2026-11-07）；跟 TS NOT_FOUND_COOLDOWN_DAYS 同一個數字，not-found-direct.test.ts 盯著';

-- 以 20261030150100 為底：拿掉號次專用的那條 WHEN（併入所有任務的 not_found）；進度類第一次不再讀 not_found_first_days
CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()
           WHEN p_outcome = 'not_found' AND s.enabled AND split_part(p_task_id, ':', 2) = ANY (s.task_types)
                AND (SELECT count(*) FROM task_checks x
                      WHERE x.task_id = p_task_id AND x.outcome = 'not_found' AND (x.checked_at, x.id) <= (p_checked_at, p_id)) >= 2
             THEN s.not_found_repeat_days
           WHEN p_outcome = 'not_found' THEN task_not_found_cooldown_days()
           ELSE task_check_cooldown_days()
         END
    FROM (SELECT 1) AS one LEFT JOIN task_cooldown_settings s ON s.id = 1
$$;
COMMENT ON FUNCTION task_check_cooldown_days_for IS
  '一筆 task_checks 的冷卻天數：unreachable＝task_unreachable_cooldown_days()；not_found＝task_not_found_cooldown_days()（2 天，所有任務，2026-11-07 起）、但型別在 task_cooldown_settings.task_types 且設定開著的第二次起＝not_found_repeat_days；其餘＝task_check_cooldown_days()';

-- ------------------------------------------------------------
-- 2. cand_no_front_pull：冷卻中的缺口不拉回隊頭
--    20261031150000 版把每張號次缺口列的 boost_seconds 拉到很大、cooling 設 false，蓋掉 cool_until——回報查無的缺口每小時被重派（有的 49 次）。
--    加兩個條件：cool_until 還沒過的不動；cool_until 還沒被 refresh_dispatch_blocked 算出來（最多 10 分鐘）時，看 task_checks 有沒有還在 2 天內的 not_found。
--    驗證列的分支（no_change 的票）不動：not_found 不再進票，剩下的只有 confirmed。其餘一字不差。
-- ------------------------------------------------------------
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
     -- >>> 查無冷卻中不拉（2026-11-07）
     AND (d.cool_until IS NULL OR d.cool_until <= now())
     AND NOT EXISTS (SELECT 1 FROM task_checks tc
                      WHERE tc.task_id = d.task_id AND tc.outcome = 'not_found'
                        AND tc.checked_at > now() - make_interval(days => task_not_found_cooldown_days()));
     -- <<< 查無冷卻中不拉
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION cand_no_front_pull IS '號次的缺口列與等票的驗證列（單人 candidacy 帶 cand_no、整批 cand_numbers 都算），插隊秒數至少拉到 2 × visitor_front_seconds；縣市長、縣市議員 3 ×；依序清單（鄉鎮市長→山地原住民區長→鄉鎮市民代表→山地原住民區民代表→村里長）中第一個還有缺口列的職位拉到 2.5 ×；擋住號次缺口的同名人物合併任務（target.cand_no_gap）3 ×；查無冷卻中（cool_until 未過，或 task_checks 有 2 天內的 not_found）的缺口列不拉；pg_cron 每小時第 3 分；2026-11-28 之後不做事（2026-10-31；2026-11-07 加冷卻條件）';

-- ------------------------------------------------------------
-- 3. 舊資料：等票中的 no_change＋not_found 一次清掉（可重跑：只動 status='pending' 的列，動完就不再是）
--    對每一筆照 TS applyNoChange 的 not_found 行為：
--      · auto: 任務 → 記一筆 task_checks（outcome=not_found，contribution_id 指回）→ 冷卻 2 天（進度追蹤類第二次起照設定表）
--      · 手動任務（uuid）→ 任務還在且不是 question → 記 task_checks（任務不關）；任務不存在或 task_id 形狀不對 → 標 superseded；question 型任務 → 只標 applied
--    貢獻標 applied（或 superseded）、reviewed_by＝system:not-found-direct，並把它的驗證票（task_dispatches 的 verify:<id>）收掉，
--    寫法同 seed_auto_task_queue 的「已經不是 pending 的貢獻，它的驗證列沒有意義了」。
--    沒寫 edit_history（applyNoChange 對 task_checks 呼叫的 recordInsert 在這裡沒有等價物）：task_checks.contribution_id 就是來源，可據以刪除。
-- ------------------------------------------------------------
DROP TABLE IF EXISTS _nf_old;
CREATE TEMP TABLE _nf_old AS
SELECT c.id, c.agent_name, c.payload->>'task_id' AS task_id,
       COALESCE(c.payload->>'finding', c.payload->>'note', c.note) AS note,
       CASE
         WHEN c.payload->>'task_id' LIKE 'auto:%' THEN 'check'
         WHEN c.payload->>'task_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
           CASE WHEN t.id IS NULL THEN 'gone'
                WHEN t.task_type = 'question' THEN 'applied_only'
                ELSE 'check' END
         ELSE 'gone'
       END AS kind
  FROM contributions c
  LEFT JOIN contribution_tasks t
    ON c.payload->>'task_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND t.id::text = lower(c.payload->>'task_id')
 WHERE c.contribution_type = 'no_change' AND c.status = 'pending' AND c.payload->>'outcome' = 'not_found';

INSERT INTO task_checks (task_id, agent_name, note, contribution_id, outcome, checked_at)
SELECT n.task_id, n.agent_name, n.note, n.id, 'not_found', now()
  FROM _nf_old n
 WHERE n.kind = 'check'
   AND NOT EXISTS (SELECT 1 FROM task_checks x WHERE x.contribution_id = n.id);

UPDATE contributions c
   SET status = CASE WHEN n.kind = 'gone' THEN 'superseded' ELSE 'applied' END,
       review_notes = '[系統] 2026-11-07 規則改：「查無」不再需要別人驗證，直接記錄；這個任務 2 天內不會再派，之後會重新派出。'
                      || CASE WHEN n.kind = 'gone' THEN '（任務已不存在或編號不是 /next 給的格式，只標結案。）' ELSE '' END,
       reviewed_by = 'system:not-found-direct',
       reviewed_at = now(),
       applied_at = CASE WHEN n.kind = 'gone' THEN NULL ELSE now() END
  FROM _nf_old n
 WHERE c.id = n.id AND c.status = 'pending';

DELETE FROM task_dispatches d
 USING _nf_old n
 WHERE d.task_id = 'verify:' || n.id::text;

DROP TABLE _nf_old;

-- ------------------------------------------------------------
-- 4. 查無冷卻中的缺口：清掉 cand_no_front_pull 之前留下的插隊秒數（它們被拉到很大，蓋掉冷卻，一小時就重派一次）
--    只動號次缺口（target.kind='cand_no'）且 2 天內有 not_found 查核的列；冷卻過了照常會再被拉回。
-- ------------------------------------------------------------
UPDATE task_dispatches d
   SET boost_seconds = 0
 WHERE d.target->>'kind' = 'cand_no' AND d.boost_seconds > 0
   AND EXISTS (SELECT 1 FROM task_checks tc
                WHERE tc.task_id = d.task_id AND tc.outcome = 'not_found'
                  AND tc.checked_at > now() - make_interval(days => task_not_found_cooldown_days()));
