-- 查核階梯：候選人公報索引上架前做的「查無」查核不計入補政見工作卡的冷卻與階梯結案（方案 D，2026-11-18）。
--
-- 為什麼：2026 地方選舉公報索引（election_bulletins／politician_bulletins，#976）2026-11-17 19:00Z 才上線。
--   在那之前代理對 2026 候選人回 not_found，是因為索引不存在、查不到公報，不是候選人真的沒有政見。
--   這些查核卻讓 3,600 多張補政見工作卡躺在 5／10／20 天冷卻，其中 26 張被階梯（第 4 次）結案、永久不再派。
-- 規則：同時符合下列條件的 task_checks 列，算階梯與冷卻時當作不存在（資料列一筆不動）：
--   ① outcome＝not_found
--   ② 工作卡是補政見（work_key 形如 politician:<pid>:policies:<屆>；auto: 的 policy_missing／term_policy_missing 與網站請求等手動任務共用同一把鍵，不分來源）
--   ③ 該候選人在那一屆有公報（politician_bulletins 對到 election_bulletins）
--   ④ 查核時間早於該公報 listed_on 的隔天 00:00 UTC（索引實際上線在 listed_on 當天 19:00Z，隔天 00:00Z 之前的查無都沒有索引可查）
--   其他 outcome、其他工作卡、公報上架後的查核、沒有公報的候選人一律照舊。
-- 寫法（效能）：refresh_dispatch_blocked 外層的 seed 排程已逼近語句逾時，所以「每張卡只查一次公報」——
--   task_check_prebulletin_cutoff(work_key) 回該卡的截止時間（沒公報＝NULL），列級只比 outcome 與 checked_at；NULL 截止自然不排除任何列。
--   work_key_ladder_state 在 CTE 算一次；task_check_cooldown_days_for 在 one 子查詢算一次，兩處「第 n 次」累計共用。
-- 範圍：只改讀取端——視圖 task_ladder_closed、task_in_check_cooldown、refresh_dispatch_blocked 都經過 work_key_ladder_state，所以讀者一致。
--   兩個函式其餘與 20261111100000 的現行定義一字不差。不改 task_checks／task_dispatches 資料；refresh_dispatch_blocked 約 10 分鐘重算後冷卻與結案自動解除。
--   不含：refresh_dispatch_blocked 開頭「手動任務（uuid）結案」那一段只看該任務自己的查核、不經過 work_key_ladder_state，這支不動它。
-- 回滾：再一支 migration，把 work_key_ladder_state、task_check_cooldown_days_for 還原成 20261111100000 的定義（task_check_prebulletin_cutoff 可留著不用）。

CREATE OR REPLACE FUNCTION task_check_prebulletin_cutoff(p_work_key TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE AS $$
  SELECT max((eb.listed_on + 1)::TIMESTAMP AT TIME ZONE 'UTC')
    FROM politician_bulletins pb
    JOIN election_bulletins eb
      ON eb.election_id = pb.election_id AND eb.election_type = pb.election_type
     AND eb.region = pb.region AND eb.sub_region = pb.sub_region AND eb.village = pb.village
   WHERE p_work_key LIKE 'politician:%:policies:%'
     AND pb.politician_id = uuid_or_null(split_part(p_work_key, ':', 2))
     AND pb.election_id::TEXT = split_part(p_work_key, ':', 4)
$$;
COMMENT ON FUNCTION task_check_prebulletin_cutoff IS '一張補政見工作卡（work_key＝politician:<pid>:policies:<屆>）的「公報上架前」截止時間：該候選人那一屆公報 listed_on 的隔天 00:00 UTC；沒有公報或不是補政見卡＝NULL。這個時間以前的 not_found 查核，階梯與冷卻不計（2026-11-18，方案 D）；work_key_ladder_state、task_check_cooldown_days_for 每張卡呼叫一次';

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
