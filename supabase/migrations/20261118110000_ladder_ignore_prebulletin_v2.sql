-- 查核階梯規則 D（重做，2026-11-18）：候選人公報上架日之前做的「查無」不計入補政見工作卡的冷卻與階梯結案。
--
-- 規則（與 #977 相同）：同時符合下列的 task_checks 列，算階梯與冷卻時當作不存在（資料列一筆不動）：
--   ① outcome＝not_found　② 工作卡是補政見（work_key 形如 politician:<pid>:policies:<屆>，auto 與手動任務共用同一把鍵）
--   ③ 該候選人在那一屆有公報　④ 查核時間早於該公報 listed_on 的隔天 00:00 UTC。其餘一律照舊。
-- 與 #977 的差別（為何這次不會慢）：
--   #977 用逐卡呼叫的 task_check_prebulletin_cutoff 去查整個 politician_bulletins 視圖（視圖含 2022/2024 的姓名比對，單次約 1 秒、
--   不會往下推條件），放進逐卡呼叫的 work_key_ladder_state，refresh 每輪撞 120 秒逾時，已由 20261118091000 回滾。
--   這次：
--   1. 截止時間改成「集合」函式 task_prebulletin_cutoffs()：只走參選紀錄→選舉單位→公報索引三表（不碰視圖的姓名比對、不展開網址陣列），
--      全量約 0.4 秒，並且在 work_key_ladder_states() 裡只算一次、一次 LEFT JOIN 進 task_checks。
--   2. 單卡版 task_check_prebulletin_cutoff(work_key) 走 politician_elections 主鍵（politician_id, election_id）直接查一列，毫秒級；
--      只給 /next 等單卡路徑用，refresh 與視圖不呼叫它（手動任務結案段除外，只對該段少數 not_found 列呼叫）。
--   只涵蓋「公報索引是 2026 才上線」的屆別（參選紀錄直接對選舉單位的那一段，與 politician_bulletins 視圖的 own 段同一個對法）。
--   2022／2024 走中選會名單姓名比對（視圖 cec 段）、索引 listed_on 是 10-06 匯入日，不在此規則範圍（受影響僅 5 筆查核）。
-- 改動的函式：work_key_ladder_states（集合版，加規則 D）、work_key_ladder_state／task_check_cooldown_days_for（單卡版，同語意，
--   與 #977 審過的版本相同，只是 cutoff 函式換成上面的輕量版）、refresh_dispatch_blocked（手動任務結案段加規則 D，#979；其餘與 20261118100000 一字不差）。
-- 回滾：把 work_key_ladder_states、work_key_ladder_state、task_check_cooldown_days_for、refresh_dispatch_blocked 用 20261118100000／20261111100000
--   的定義 CREATE OR REPLACE 還原（20261118091000 已有前兩個單卡函式的原版），task_prebulletin_cutoffs／task_check_prebulletin_cutoff 可 DROP。
-- 不動資料：已經被關掉的手動任務（status=closed）不會自動重開，見 PR 說明。

CREATE OR REPLACE FUNCTION task_prebulletin_cutoffs()
RETURNS TABLE (politician_id UUID, election_id TEXT, cut TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT pe.politician_id, pe.election_id::TEXT, max((eb.listed_on + 1)::TIMESTAMP AT TIME ZONE 'UTC')
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
    JOIN regions r ON r.id = pe.region_id
    JOIN election_bulletins eb
      ON eb.election_id = pe.election_id AND eb.election_type = pe.election_type
     AND eb.region = r.region AND eb.sub_region = COALESCE(r.sub_region, '') AND eb.village = COALESCE(r.village, '')
   WHERE pe.election_id <> ALL (ARRAY[2022, 2024])
     AND pe.candidacy_status = ANY (ARRAY['filed', 'elected', 'not_elected'])
   GROUP BY pe.politician_id, pe.election_id
$$;
COMMENT ON FUNCTION task_prebulletin_cutoffs IS '每個（候選人、屆）的「公報上架前」截止時間＝該候選人那一屆公報 listed_on 的隔天 00:00 UTC（規則 D，2026-11-18）。對法與 politician_bulletins 視圖 own 段相同（2022／2024 不含）。work_key_ladder_states 一次呼叫、整表只算一次';

CREATE OR REPLACE FUNCTION task_check_prebulletin_cutoff(p_work_key TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql STABLE AS $$
DECLARE c TIMESTAMPTZ;
BEGIN
  -- 不是補政見卡就直接回（plpgsql：計畫在連線內快取，單卡路徑上對其他卡零成本）
  IF p_work_key IS NULL OR p_work_key NOT LIKE 'politician:%:policies:%' THEN RETURN NULL; END IF;
  SELECT max((eb.listed_on + 1)::TIMESTAMP AT TIME ZONE 'UTC') INTO c
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
    JOIN regions r ON r.id = pe.region_id
    JOIN election_bulletins eb
      ON eb.election_id = pe.election_id AND eb.election_type = pe.election_type
     AND eb.region = r.region AND eb.sub_region = COALESCE(r.sub_region, '') AND eb.village = COALESCE(r.village, '')
   WHERE pe.politician_id = uuid_or_null(split_part(p_work_key, ':', 2))
     AND pe.election_id::TEXT = split_part(p_work_key, ':', 4)
     AND pe.election_id <> ALL (ARRAY[2022, 2024])
     AND pe.candidacy_status = ANY (ARRAY['filed', 'elected', 'not_elected']);
  RETURN c;
END;
$$;
COMMENT ON FUNCTION task_check_prebulletin_cutoff IS '單張補政見工作卡（work_key＝politician:<pid>:policies:<屆>）的公報上架截止時間；不是補政見卡或沒公報＝NULL。與 task_prebulletin_cutoffs() 同語意，走 politician_elections 主鍵直接查一列（2026-11-18，規則 D）。只給單卡路徑用，不要放進逐列呼叫的大查詢';

CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()
           WHEN p_outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(p_task_id) THEN
             COALESCE(task_check_ladder_days(p_outcome,
                        (SELECT count(*) FROM task_checks x
                          WHERE x.work_key = one.wk AND x.outcome IN ('not_found', 'confirmed') AND (x.checked_at, x.id) <= (p_checked_at, p_id)
                            AND NOT COALESCE(x.outcome = 'not_found' AND x.checked_at < one.cut, FALSE))),
                      (SELECT l.days[cardinality(l.days)] FROM task_check_ladder_settings l WHERE l.outcome = p_outcome))
           WHEN p_outcome = 'not_found' AND s.enabled AND split_part(p_task_id, ':', 2) = ANY (s.task_types)
                AND (SELECT count(*) FROM task_checks x
                      WHERE x.work_key = one.wk AND x.outcome = 'not_found' AND (x.checked_at, x.id) <= (p_checked_at, p_id)
                        AND NOT COALESCE(x.outcome = 'not_found' AND x.checked_at < one.cut, FALSE)) >= 2
             THEN s.not_found_repeat_days
           WHEN p_outcome = 'not_found' THEN task_not_found_cooldown_days()
           ELSE task_check_cooldown_days()
         END
    FROM (SELECT w.wk, task_check_prebulletin_cutoff(w.wk) AS cut
            FROM (SELECT COALESCE((SELECT y.work_key FROM task_checks y WHERE y.id = p_id), task_work_key(p_task_id, NULL), 'task:' || p_task_id) AS wk) w) AS one
    LEFT JOIN task_cooldown_settings s ON s.id = 1
$$;
COMMENT ON FUNCTION task_check_cooldown_days_for IS
  '一筆 task_checks 的冷卻天數（2026-11-11 起次序按工作卡 work_key 累計，換號、換臂不歸零；2026-11-18 起「第 n 次」不計公報上架前的查無，見 task_check_prebulletin_cutoff）：unreachable＝task_unreachable_cooldown_days()；非例外任務的 not_found／confirmed＝階梯（task_check_ladder_days，同一張卡兩種合計的第 n 次）；例外任務（task_check_ladder_exempt）not_found＝2 天（進度類第二次起 not_found_repeat_days）、confirmed 與其餘＝task_check_cooldown_days()';

CREATE OR REPLACE FUNCTION work_key_ladder_state(p_work_key TEXT)
RETURNS TABLE (checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT tc.id, tc.task_id, tc.outcome, tc.checked_at,
           (tc.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(tc.task_id)) AS laddered
      FROM task_checks tc
     WHERE tc.work_key = p_work_key
       AND NOT COALESCE(tc.outcome = 'not_found' AND tc.checked_at < (SELECT task_check_prebulletin_cutoff(p_work_key)), FALSE)
  ), n AS (
    SELECT t.*, CASE WHEN t.laddered THEN row_number() OVER (PARTITION BY t.laddered ORDER BY t.checked_at, t.id) END AS n,
           (task_check_cooldown_days_for(t.task_id, t.outcome, t.checked_at, t.id) || ' days')::INTERVAL AS d
      FROM t
  )
  SELECT count(*) FILTER (WHERE n.laddered),
         COALESCE(bool_or(n.laddered AND task_check_ladder_days(n.outcome, n.n) IS NULL), FALSE),
         min(n.checked_at) FILTER (WHERE n.laddered AND task_check_ladder_days(n.outcome, n.n) IS NULL),
         max(n.checked_at) FILTER (WHERE n.laddered),
         max(n.checked_at + n.d) FILTER (WHERE n.checked_at > now() - n.d AND n.checked_at > now() - make_interval(days => task_cooldown_max_days())),
         max(n.checked_at + n.d) FILTER (WHERE n.outcome IN ('not_found', 'confirmed') AND n.checked_at > now() - n.d
                                          AND n.checked_at > now() - make_interval(days => task_cooldown_max_days()))
    FROM n
$$;
COMMENT ON FUNCTION work_key_ladder_state IS '一張工作卡（work_key）的查核階梯與冷卻狀態：結案與否、累計次數、最晚冷卻結束時間。只掃這個鍵的 task_checks（task_checks_work_key_idx），不計公報上架前的查無（task_check_prebulletin_cutoff，2026-11-18）。2026-11-11';

CREATE OR REPLACE FUNCTION work_key_ladder_states()
RETURNS TABLE (work_key TEXT, checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH cfg AS (
    -- 常數只讀一次（單卡版每一筆都重新呼叫）；LEFT JOIN 讓設定列不存在時行為同 task_check_cooldown_days_for
    SELECT s.enabled AS rep_on, s.task_types, s.not_found_repeat_days AS rep_days,
           task_unreachable_cooldown_days() AS unreach_days, task_not_found_cooldown_days() AS nf_days,
           task_check_cooldown_days() AS default_days, make_interval(days => task_cooldown_max_days()) AS max_window
      FROM (SELECT 1) AS one LEFT JOIN task_cooldown_settings s ON s.id = 1
  ), cuts AS MATERIALIZED (
    -- 規則 D：每個（候選人、屆）的公報上架截止時間，整張表只算一次（不是逐卡）
    SELECT * FROM task_prebulletin_cutoffs()
  ), t AS MATERIALIZED (
    SELECT tc.id, tc.work_key, tc.task_id, tc.outcome, tc.checked_at,
           (tc.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(tc.task_id)) AS laddered,
           -- 同卡累計到這一筆為止（含這一筆；(checked_at, id) 全序）：not_found＋confirmed 合計（含例外任務，同 task_check_cooldown_days_for）、only not_found
           count(*) FILTER (WHERE tc.outcome IN ('not_found', 'confirmed')) OVER w AS cnt_nc,
           count(*) FILTER (WHERE tc.outcome = 'not_found') OVER w AS cnt_nf
      FROM task_checks tc
      LEFT JOIN cuts c
        ON tc.outcome = 'not_found' AND tc.work_key LIKE 'politician:%:policies:%'
       AND c.politician_id = uuid_or_null(split_part(tc.work_key, ':', 2))
       AND c.election_id = split_part(tc.work_key, ':', 4)
     WHERE tc.work_key IS NOT NULL
       -- 規則 D：公報上架前的查無當作不存在（在視窗函數之前濾掉，所以不計入「第幾次」與冷卻）
       AND NOT COALESCE(tc.outcome = 'not_found' AND tc.checked_at < c.cut, FALSE)
    WINDOW w AS (PARTITION BY tc.work_key ORDER BY tc.checked_at, tc.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  ), n AS MATERIALIZED (
    SELECT t.*,
           -- 階梯次序：只數套階梯的那幾筆（例外任務不算），同 work_key_ladder_state
           CASE WHEN t.laddered THEN row_number() OVER (PARTITION BY t.work_key, t.laddered ORDER BY t.checked_at, t.id) END AS n
      FROM t
  ), d AS MATERIALIZED (
    SELECT n.*,
           -- 這一筆的冷卻天數：task_check_cooldown_days_for 的同一個 CASE，計數改取上面的視窗值
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
COMMENT ON FUNCTION work_key_ladder_states IS '全部有查核紀錄的工作卡的階梯與冷卻狀態，一次對 task_checks 做集合運算（#981）。每張卡的結果與 work_key_ladder_state(work_key) 逐欄一致（不計公報上架前的查無，規則 D，2026-11-18，截止時間整表只算一次）；seed 排程（refresh_dispatch_blocked）與視圖 task_ladder_closed 用它。單卡呼叫者（/next、task_in_check_cooldown）仍用 work_key_ladder_state。';

CREATE OR REPLACE FUNCTION refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  -- >>> 查核階梯：手動任務（uuid）結案＝關閉（open 的才動）。只看「它自己的」查核（按自己的 task_id 累計，維持 work_key 之前的行為）：
  --     同一張卡（同人同 need）被 auto: 任務的查核結案時，手動任務（網站請求、提議）留 open、不關
  UPDATE contribution_tasks t SET status = 'closed', closed_at = now()
   WHERE t.status = 'open'
     AND EXISTS (
       SELECT 1 FROM (SELECT x.outcome, row_number() OVER (ORDER BY x.checked_at, x.id) AS n
                        FROM task_checks x
                       WHERE x.task_id = t.id::text AND x.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(x.task_id)
                         -- 規則 D（#979）：公報上架前的查無不計
                         AND NOT COALESCE(x.outcome = 'not_found' AND x.checked_at < task_check_prebulletin_cutoff(x.work_key), FALSE)) z
        WHERE task_check_ladder_days(z.outcome, z.n) IS NULL);
  -- <<< 查核階梯
  -- >>> #981：階梯狀態對 task_checks 一次集合運算（物化一次，b 與 cool 共用；取代逐卡呼叫 work_key_ladder_state 與視圖 task_ladder_closed）
  WITH ls AS MATERIALIZED (SELECT * FROM work_key_ladder_states()),
  saturated AS (
    SELECT c.task_id FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed')
    GROUP BY c.task_id HAVING COUNT(*) >= 5
  ), nochange AS (
    SELECT DISTINCT c.payload->>'task_id' AS task_id FROM contributions c
    WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified')
      AND c.payload->>'task_id' IS NOT NULL
  ), b AS (
    SELECT task_id FROM saturated UNION SELECT task_id FROM nochange
    -- >>> 查核階梯：結案的 auto: 任務永久不派
    --     （與視圖 task_ladder_closed 同一份定義：結案卡上每一個任務代號，查核紀錄出現過的加派工列掛著這個 work_key 的）
    UNION SELECT m.task_id
            FROM ls
            JOIN (SELECT tc.work_key AS wk, tc.task_id FROM task_checks tc WHERE tc.work_key IS NOT NULL
                  UNION
                  SELECT d.work_key, d.task_id FROM task_dispatches d WHERE d.work_key IS NOT NULL AND d.task_id NOT LIKE 'verify:%') m ON m.wk = ls.work_key
           WHERE ls.closed AND m.task_id LIKE 'auto:%'
    -- <<< 查核階梯
  )
  , cool AS (
    -- 工作卡鍵（20261111100000）：同一張卡的查核一起算，冷卻取最晚的一筆（換號、換臂、手動任務與自動缺口都延續）；每個鍵只掃自己的 task_checks
    -- cool_until 非空必有一筆窗口內的查核，所以不用另外濾「30 天內有查核的鍵」
    SELECT ls.work_key, ls.cool_until AS until FROM ls WHERE ls.cool_until IS NOT NULL
  )
  -- >>> 多人分組任務：逐人冷卻
  , st AS MATERIALIZED (SELECT * FROM roster_group_person_status())
  , gp AS (
    SELECT t.id::TEXT AS task_id, COALESCE(s.closed, FALSE) AS closed, s.cool_until AS until
      FROM contribution_tasks t
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.target->'people', '[]'::JSONB)) e
      LEFT JOIN st s ON s.cid = roster_group_check_task_id(e->>'key', e->>'action', e->>'politician_election_id')
     WHERE t.status = 'open' AND t.target->>'origin' = 'roster_group'
  ), g AS (
    SELECT gp.task_id,
           CASE WHEN count(*) FILTER (WHERE NOT gp.closed) > 0
                 AND count(*) FILTER (WHERE NOT gp.closed AND NOT COALESCE(gp.until > now(), FALSE)) = 0
                THEN min(gp.until) FILTER (WHERE NOT gp.closed) END AS until
      FROM gp GROUP BY gp.task_id
  )
  -- <<< 多人分組任務
  , x AS (
    SELECT d.task_id,
           CASE WHEN d.task_id LIKE 'auto:%' THEN b.task_id IS NOT NULL ELSE d.blocked END AS blocked,
           CASE WHEN g.task_id IS NOT NULL THEN g.until ELSE c.until END AS until,
           task_queue_key(d.last_dispatched_at, d.priority_seconds, CASE WHEN g.task_id IS NOT NULL THEN g.until ELSE c.until END, d.boost_seconds)
             > now() + make_interval(secs => (SELECT q.dispatch_horizon_seconds FROM queue_settings q WHERE q.id = 1)) AS cooling
      FROM task_dispatches d LEFT JOIN cool c ON c.work_key = COALESCE(d.work_key, 'task:' || d.task_id) LEFT JOIN g ON g.task_id = d.task_id
           -- #981：原本是逐列 EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id)，每一列都重跑一次 b（約 2.9 萬列 × 1.6 毫秒＝47 秒）；b 是 UNION 已去重，改成 LEFT JOIN 只算一次，結果相同
           LEFT JOIN b ON b.task_id = d.task_id
     WHERE d.task_id NOT LIKE 'verify:%'
  )
  UPDATE task_dispatches d
     SET blocked = x.blocked, cool_until = x.until, cooling = COALESCE(x.cooling, false)
    FROM x
   WHERE x.task_id = d.task_id
     AND (d.blocked, d.cool_until, d.cooling) IS DISTINCT FROM (x.blocked, x.until, COALESCE(x.cooling, false));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
