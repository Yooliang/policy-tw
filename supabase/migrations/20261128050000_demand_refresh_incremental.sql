-- work_card_demand_refresh() 由「逐卡呼叫」改成「集合運算」（2026-11-28，seed priority 段降成本）
-- ============================================================
--
-- 為什麼：正式庫實測（11-28 11:00～11:20，#1087 細分計時）seed 的 priority 段 10～12.6 秒裡，`stage:priority_demand_refresh`
--   （work_card_demand_refresh）佔 8.5～11.3 秒，其餘子步驟各 < 1.5 秒；負載高時這段曾飆到 30 秒以上。
--
-- 判讀：不是整表掃大表，是「逐卡呼叫」。refresh 先組出一份卡清單（近 30 天有訊號的卡、需求不為 0 的卡、開著的網站請求任務所在的卡），
--   再對每一張卡各呼叫一次 work_card_demand_seconds(卡)；那支函式每次又各做：一次訊號聚合、一次「建立者」子查詢（task_dispatches ⋈ contribution_tasks
--   ＋NOT EXISTS）、一次 work_cards 查找，以及一次**單卡的 work_key_ladder_state(卡)**。最後這項最貴——它掃該卡全部 task_checks，
--   並對每一筆查核各呼叫一次 task_check_cooldown_days_for（內含兩個計數子查詢與一次公報截止時間查詢，四表連接）。卡數 × 查核筆數 × 這些子查詢
--   ＝ 8～11 秒。#981 已經把同樣的問題在 refresh_dispatch_blocked 用集合版 work_key_ladder_states() 解掉，需求快照這邊沒跟上。
--
-- 做法（輸出不變，簽名不變，seed 不用改）：
--   1. 新函式 work_key_ladder_states_for(p_keys TEXT[])：work_key_ladder_states() 的「只算指定這幾張卡」版本。本體與集合版逐行相同，
--      只差兩處過濾（task_checks 只取 work_key = ANY(p_keys)，走 task_checks_work_key_idx；公報截止時間只算這幾張卡的候選人）。
--      每張卡的結果與 work_key_ladder_state(卡)、work_key_ladder_states() 逐欄一致。
--   2. work_card_demand_refresh() 整支改成一個 SQL：訊號、建立者、減半次數各整批聚合一次；先用最便宜的條件（單位數＞0 且減半次數未到上限）
--      挑出「真的需要看查核階梯」的卡，只對它們算一次 work_key_ladder_states_for；公式與 work_card_demand_seconds 同一個運算式（逐字相同）。
--      單位數是 0 的卡、減半到上限的卡不看階梯（舊版看了也是 0）。
--   3. work_card_demand_seconds 一個字不動（需求預覽視圖、守門測試、單卡路徑都還用它）。
--   不新增觸發器、排程、表或索引，所以沒有「漏接事件」的風險，也不需要另外的全量對帳：每一輪就是全量，結果與舊版逐列相同
--   （守門測試把舊版以 _legacy 裝進同一個 PGlite 並排比對）。
--
-- 預估：每輪從約 8.5～11 秒降到約 1 秒以內（task_checks 只讀有需求的那幾張卡的列，其餘都是對小表的一次聚合）。
-- 每日呼叫量變化：0（沒有新排程、沒有新增呼叫端；seed 仍每輪呼叫一次）。
--
-- 回滾：把 work_card_demand_refresh() 換回 20261114030000_demand_counts_request_creator.sql 的定義（CREATE OR REPLACE，簽名相同），
--   再 DROP FUNCTION work_key_ladder_states_for(TEXT[]);。兩者互不依賴資料，沒有資料要還原。

CREATE OR REPLACE FUNCTION work_key_ladder_states_for(p_keys TEXT[])
RETURNS TABLE (work_key TEXT, checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH cfg AS (
    SELECT s.enabled AS rep_on, s.task_types, s.not_found_repeat_days AS rep_days,
           task_unreachable_cooldown_days() AS unreach_days, task_not_found_cooldown_days() AS nf_days,
           task_check_cooldown_days() AS default_days, make_interval(days => task_cooldown_max_days()) AS max_window
      FROM (SELECT 1) AS one LEFT JOIN task_cooldown_settings s ON s.id = 1
  ), cuts AS MATERIALIZED (
    -- 與 task_prebulletin_cutoffs() 同一個算法，只多一個條件：候選人限這幾張補政見卡上的人
    SELECT pe.politician_id, pe.election_id::TEXT AS election_id, max((eb.listed_on + 1)::TIMESTAMP AT TIME ZONE 'UTC') AS cut
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN regions r ON r.id = pe.region_id
      JOIN election_bulletins eb
        ON eb.election_id = pe.election_id AND eb.election_type = pe.election_type
       AND eb.region = r.region AND eb.sub_region = COALESCE(r.sub_region, '') AND eb.village = COALESCE(r.village, '')
     WHERE pe.election_id <> ALL (ARRAY[2022, 2024])
       AND pe.candidacy_status = ANY (ARRAY['filed', 'elected', 'not_elected'])
       AND pe.politician_id IN (SELECT uuid_or_null(split_part(k, ':', 2)) FROM unnest(p_keys) k WHERE k LIKE 'politician:%:policies:%')
     GROUP BY pe.politician_id, pe.election_id
  ), t AS MATERIALIZED (
    SELECT tc.id, tc.work_key, tc.task_id, tc.outcome, tc.checked_at,
           (tc.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(tc.task_id)) AS laddered,
           count(*) FILTER (WHERE tc.outcome IN ('not_found', 'confirmed')) OVER w AS cnt_nc,
           count(*) FILTER (WHERE tc.outcome = 'not_found') OVER w AS cnt_nf
      FROM task_checks tc
      LEFT JOIN cuts c
        ON tc.outcome = 'not_found' AND tc.work_key LIKE 'politician:%:policies:%'
       AND c.politician_id = uuid_or_null(split_part(tc.work_key, ':', 2))
       AND c.election_id = split_part(tc.work_key, ':', 4)
     WHERE tc.work_key = ANY (p_keys)
       AND NOT COALESCE(tc.outcome = 'not_found' AND tc.checked_at < c.cut, FALSE)
    WINDOW w AS (PARTITION BY tc.work_key ORDER BY tc.checked_at, tc.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  ), n AS MATERIALIZED (
    SELECT t.*,
           CASE WHEN t.laddered THEN row_number() OVER (PARTITION BY t.work_key, t.laddered ORDER BY t.checked_at, t.id) END AS n
      FROM t
  ), d AS MATERIALIZED (
    SELECT n.*,
           (CASE WHEN n.outcome = 'unreachable' THEN cfg.unreach_days
                 WHEN n.laddered THEN
                   COALESCE(task_check_ladder_days(n.outcome, n.cnt_nc),
                            (SELECT l.days[cardinality(l.days)] FROM task_check_ladder_settings l WHERE l.outcome = n.outcome))
                 WHEN n.outcome = 'not_found' AND cfg.rep_on AND split_part(n.task_id, ':', 2) = ANY (cfg.task_types) AND n.cnt_nf >= 2
                   THEN cfg.rep_days
                 WHEN n.outcome = 'not_found' THEN cfg.nf_days
                 ELSE cfg.default_days
            END || ' days')::INTERVAL AS dur,
           CASE WHEN n.laddered THEN task_check_ladder_days(n.outcome, n.n) END AS ladder_days
      FROM n CROSS JOIN cfg
  )
  SELECT d.work_key,
         count(*) FILTER (WHERE d.laddered),
         COALESCE(bool_or(d.laddered AND d.ladder_days IS NULL), FALSE),
         min(d.checked_at) FILTER (WHERE d.laddered AND d.ladder_days IS NULL),
         max(d.checked_at) FILTER (WHERE d.laddered),
         max(d.checked_at + d.dur) FILTER (WHERE d.checked_at > now() - d.dur AND d.checked_at > now() - (SELECT max_window FROM cfg)),
         max(d.checked_at + d.dur) FILTER (WHERE d.outcome IN ('not_found', 'confirmed') AND d.checked_at > now() - d.dur
                                            AND d.checked_at > now() - (SELECT max_window FROM cfg))
    FROM d
   GROUP BY d.work_key
$$;
COMMENT ON FUNCTION work_key_ladder_states_for IS 'work_key_ladder_states() 的「只算指定這幾張卡」版（2026-11-28）：本體逐行相同，只多 task_checks 的 work_key = ANY(p_keys) 與公報截止時間限這幾張卡的候選人。沒有查核紀錄的卡不出列（同集合版）。work_card_demand_refresh 用它；改階梯規則時兩支要一起改（work-card-demand-refresh-set.test.ts 逐欄比對）。';

REVOKE ALL ON FUNCTION work_key_ladder_states_for(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION work_key_ladder_states_for(TEXT[]) TO service_role;

CREATE OR REPLACE FUNCTION work_card_demand_refresh() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH s AS MATERIALIZED (SELECT * FROM queue_settings WHERE id = 1),
  keys AS (
    SELECT x.work_key FROM work_card_signals x, s
     WHERE x.created_at > now() - make_interval(days => s.demand_signal_days)
    UNION
    SELECT c.work_key FROM work_cards c WHERE c.demand_seconds <> 0
    UNION
    SELECT d.work_key FROM task_dispatches d JOIN contribution_tasks t ON t.id::TEXT = d.task_id, s
     WHERE d.work_key IS NOT NULL AND t.source = 'web_request' AND t.status = 'open'
       AND t.created_at > now() - make_interval(days => s.demand_signal_days)
  ), sig AS (
    -- 每張卡的訊號數（同 work_card_demand_seconds 的 sig，整批一次）
    SELECT x.work_key,
           count(*) FILTER (WHERE x.kind <> 'view') AS direct,
           count(*) FILTER (WHERE x.kind = 'view')  AS views
      FROM work_card_signals x, s
     WHERE x.created_at > now() - make_interval(days => s.demand_signal_days)
     GROUP BY x.work_key
  ), creators AS (
    -- 第一個請求者也算一個單位（同 work_card_demand_seconds 的 creators，整批一次）
    SELECT d.work_key, count(DISTINCT t.requester_ip_hash) AS n
      FROM task_dispatches d
      JOIN contribution_tasks t ON t.id::TEXT = d.task_id
      CROSS JOIN s
     WHERE d.work_key IS NOT NULL AND d.task_id NOT LIKE 'verify:%'
       AND t.source = 'web_request' AND t.status = 'open' AND COALESCE(t.requester_ip_hash, '') <> ''
       AND t.created_at > now() - make_interval(days => s.demand_signal_days)
       AND NOT EXISTS (SELECT 1 FROM work_card_signals x WHERE x.work_key = d.work_key AND x.kind = 'request' AND x.actor = t.requester_ip_hash
                          AND x.created_at > now() - make_interval(days => s.demand_signal_days))
     GROUP BY d.work_key
  ), base AS MATERIALIZED (
    SELECT k.work_key,
           COALESCE(sig.direct, 0) AS direct, COALESCE(sig.views, 0) AS views, COALESCE(cr.n, 0) AS creators,
           COALESCE(c.no_output_dispatches, 0) AS halv
      FROM keys k
      LEFT JOIN sig ON sig.work_key = k.work_key
      LEFT JOIN creators cr ON cr.work_key = k.work_key
      LEFT JOIN work_cards c ON c.work_key = k.work_key
  ), need AS (
    -- 只有「單位數＞0 而且減半次數沒到上限」的卡，結果才可能不是 0，才需要看查核階梯；其餘不看（舊版看了也是 0）
    SELECT b.work_key FROM base b, s
     WHERE b.halv < s.demand_halving_max
       AND (b.direct + b.creators + GREATEST(0, b.views / s.demand_view_unit - 1)) > 0
  ), ls AS MATERIALIZED (
    SELECT * FROM work_key_ladder_states_for(ARRAY(SELECT n.work_key FROM need n))
  ), calc AS (
    SELECT b.work_key,
           CASE WHEN COALESCE(ls.closed OR COALESCE(ls.check_cool_until > now(), FALSE), FALSE) THEN 0   -- 防線①：冷卻中、階梯已結案不疊
                WHEN b.halv >= s.demand_halving_max THEN 0                                                -- 防線②：減半到上限視同 0
                ELSE floor(LEAST(s.demand_cap_seconds::NUMERIC,
                                 (b.direct + b.creators + GREATEST(0, b.views / s.demand_view_unit - 1)) * s.demand_unit_seconds::NUMERIC)
                           * power(0.5::NUMERIC, b.halv))::BIGINT
           END AS sec
      FROM base b CROSS JOIN s LEFT JOIN ls ON ls.work_key = b.work_key
  )
  INSERT INTO work_cards (work_key, demand_seconds)
  SELECT work_key, sec FROM calc
  ON CONFLICT (work_key) DO UPDATE SET demand_seconds = EXCLUDED.demand_seconds, updated_at = now()
   WHERE work_cards.demand_seconds IS DISTINCT FROM EXCLUDED.demand_seconds;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION work_card_demand_refresh IS 'seed 每輪呼叫：重算有訊號的卡的需求秒數並寫 work_cards.demand_seconds 快照（IS DISTINCT FROM 才寫）。不論 demand_enabled。2026-11-28 起改集合運算（訊號、建立者、減半次數整批聚合；查核階梯只對單位數＞0 且減半未到上限的卡算一次），輸出與逐卡版逐列相同。';

REVOKE ALL ON FUNCTION work_card_demand_refresh() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION work_card_demand_refresh() TO service_role;

NOTIFY pgrst, 'reload schema';
