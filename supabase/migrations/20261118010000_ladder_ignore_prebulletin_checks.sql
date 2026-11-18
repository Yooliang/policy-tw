-- 查核階梯：候選人公報索引上架前做的「查無」查核不計入補政見任務的冷卻與階梯結案（方案 D，2026-11-18）。
--
-- 為什麼：2026 地方選舉公報索引（election_bulletins／politician_bulletins，#976）2026-11-17 才上線（19:00Z）。
--   在那之前代理對 2026 候選人回 not_found，是因為索引不存在、查不到公報，不是候選人真的沒有政見。
--   這些查核卻讓 3,600 多張補政見工作卡躺在 5／10／20 天冷卻，其中 26 張被階梯（第 4 次）結案、永久不再派。
-- 規則：同時符合下列條件的 task_checks 列，算階梯與冷卻時當作不存在（資料列一筆不動）：
--   ① outcome＝not_found　② 任務是 auto:policy_missing:／auto:term_policy_missing:（工作卡 politician:<pid>:policies:<屆>）
--   ③ 該候選人在那一屆有公報（politician_bulletins）　④ 查核時間早於公報上架日（election_bulletins.listed_on）的隔天台北 00:00
--   （上架日整天都算尚未上架：索引實際上線在 listed_on 當天 19:00Z＝隔天 03:00 台北，用「隔天 00:00」才不會漏掉當天的查無）。
--   其他 outcome、其他任務型別、公報上架後的查核、沒有公報的候選人一律照舊。
-- 範圍：只改讀取端三處，讓所有讀者一致——
--   1. task_check_prebulletin：新函式，判斷一筆 task_checks 是不是上面那種
--   2. work_key_ladder_state：階梯與冷卻狀態的 CTE 排除那種列（視圖 task_ladder_closed、task_in_check_cooldown、refresh_dispatch_blocked 都經過它）
--   3. task_check_cooldown_days_for：「第 n 次」的累計也排除那種列（否則 n 會被灌大、冷卻天數仍偏長）
--   其餘與 20261111100000 的現行定義一字不差。不改 task_checks／task_dispatches 資料；refresh_dispatch_blocked 約 10 分鐘重算後冷卻與結案自動解除。
-- 影響面（正式庫唯讀模擬，2026-11-18）：2026 屆 5,014 筆查無（3,753 張卡，其中 30 天窗內 3,613 張）不再計入；2022 屆 4 筆（30 天窗外，只影響結案計數）。
-- 回滾：再一支 migration，把 work_key_ladder_state、task_check_cooldown_days_for 還原成 20261111100000 的定義（task_check_prebulletin 可留著不用）。

CREATE OR REPLACE FUNCTION task_check_prebulletin(p_task_id TEXT, p_work_key TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT p_outcome = 'not_found'
     AND (p_task_id LIKE 'auto:policy_missing:%' OR p_task_id LIKE 'auto:term_policy_missing:%')
     AND p_work_key LIKE 'politician:%:policies:%'
     AND EXISTS (
       SELECT 1
         FROM politician_bulletins pb
         JOIN election_bulletins eb
           ON eb.election_id = pb.election_id AND eb.election_type = pb.election_type
          AND eb.region = pb.region AND eb.sub_region = pb.sub_region AND eb.village = pb.village
        WHERE pb.politician_id = uuid_or_null(split_part(p_work_key, ':', 2))
          AND pb.election_id::TEXT = split_part(p_work_key, ':', 4)
          AND p_checked_at < ((eb.listed_on + 1)::TIMESTAMP AT TIME ZONE 'Asia/Taipei'))
$$;
COMMENT ON FUNCTION task_check_prebulletin IS '這筆查核是不是「公報索引上架前的查無」：補政見任務（policy_missing／term_policy_missing）的 not_found，且該候選人那一屆有公報、查核時間早於公報上架日隔天台北 00:00。是的話階梯與冷卻不計它（2026-11-18，方案 D）；work_key_ladder_state、task_check_cooldown_days_for 呼叫';

CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()
           WHEN p_outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(p_task_id) THEN
             COALESCE(task_check_ladder_days(p_outcome,
                        (SELECT count(*) FROM task_checks x
                          WHERE x.work_key = one.wk AND x.outcome IN ('not_found', 'confirmed') AND (x.checked_at, x.id) <= (p_checked_at, p_id)
                            AND NOT task_check_prebulletin(x.task_id, x.work_key, x.outcome, x.checked_at))),
                      (SELECT l.days[cardinality(l.days)] FROM task_check_ladder_settings l WHERE l.outcome = p_outcome))
           WHEN p_outcome = 'not_found' AND s.enabled AND split_part(p_task_id, ':', 2) = ANY (s.task_types)
                AND (SELECT count(*) FROM task_checks x
                      WHERE x.work_key = one.wk AND x.outcome = 'not_found' AND (x.checked_at, x.id) <= (p_checked_at, p_id)
                        AND NOT task_check_prebulletin(x.task_id, x.work_key, x.outcome, x.checked_at)) >= 2
             THEN s.not_found_repeat_days
           WHEN p_outcome = 'not_found' THEN task_not_found_cooldown_days()
           ELSE task_check_cooldown_days()
         END
    FROM (SELECT COALESCE((SELECT y.work_key FROM task_checks y WHERE y.id = p_id), task_work_key(p_task_id, NULL), 'task:' || p_task_id) AS wk) AS one
    LEFT JOIN task_cooldown_settings s ON s.id = 1
$$;
COMMENT ON FUNCTION task_check_cooldown_days_for IS
  '一筆 task_checks 的冷卻天數（2026-11-11 起次序按工作卡 work_key 累計，換號、換臂不歸零；2026-11-18 起「第 n 次」不計公報上架前的查無，見 task_check_prebulletin）：unreachable＝task_unreachable_cooldown_days()；非例外任務的 not_found／confirmed＝階梯（task_check_ladder_days，同一張卡兩種合計的第 n 次）；例外任務（task_check_ladder_exempt）not_found＝2 天（進度類第二次起 not_found_repeat_days）、confirmed 與其餘＝task_check_cooldown_days()';

CREATE OR REPLACE FUNCTION work_key_ladder_state(p_work_key TEXT)
RETURNS TABLE (checks BIGINT, closed BOOLEAN, closed_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, cool_until TIMESTAMPTZ, check_cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT tc.id, tc.task_id, tc.outcome, tc.checked_at,
           (tc.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(tc.task_id)) AS laddered
      FROM task_checks tc
     WHERE tc.work_key = p_work_key
       AND NOT task_check_prebulletin(tc.task_id, tc.work_key, tc.outcome, tc.checked_at)
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
COMMENT ON FUNCTION work_key_ladder_state IS '一張工作卡（work_key）的查核階梯與冷卻狀態：結案與否、累計次數、最晚冷卻結束時間。只掃這個鍵的 task_checks（task_checks_work_key_idx），不計公報上架前的查無（task_check_prebulletin，2026-11-18）。2026-11-11';
