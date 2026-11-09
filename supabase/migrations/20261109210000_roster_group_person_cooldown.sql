-- 名冊分組（多人）任務：逐人查核階梯＋「不同人」裁決不再算重複（2026-11-09，協議 1.125.0）
--   起因（正式庫 2026-11-09 實查）：
--   1. 0166f1c8…（重複：林振德，dup:205592b7…|c275bbd0…）派了 14 次。三位代理交 merge_politician「不同人」都上線了
--      （politician_pair_resolutions 有 different），但 cec_roster_diff() 的 dup 只看「同單位同號次、至少一筆對不上官方」，
--      不看裁決，所以那一對永遠留在 roster_group_people()、任務永遠不空。
--   2. d9042ce1…（掛錯人：許明全）派了 15 次。三位代理交 no_change not_found 都上線了，但多人任務的 no_change 分支沒寫 task_checks，
--      任務本身也沒有冷卻，所以一直派。1.122.0 只對「掛錯人 confirmed」逐人寫 task_checks。
--   做法：
--   A. cec_roster_diff() 的 dup 輸出排除已有 resolution='different' 的一對（只擋輸出；dx／dr 仍把那兩筆從 extra／missing 排除，
--      因為官方那一格已經由 dup 判斷過）。pair_key 與 politician_pair_key() 同形（較小 uuid|較大 uuid）。
--   B. 逐人查核：TS 對多人任務的 no_change（not_found／confirmed／unreachable）逐人寫 task_checks，task_id＝roster_group_check_task_id()
--      （掛錯人沿用 auto:candidacy_owner_mismatch:<pe_id>，其餘 auto:roster_group_person:<person_key>），所以階梯（5/10/20、5/10，
--      task_check_ladder_settings）逐人累計：冷卻中、結案的人不再出現在派出的說明裡；結案的人下一輪對帳從任務移除，也不會再開新任務。
--   C. 派工列冷卻：refresh_dispatch_blocked() 對 origin＝roster_group 的任務，只有「剩下沒結案的人全部在冷卻」才冷卻，
--      cool_until＝他們冷卻結束時間的最小值（有任何一位沒在冷卻就照派）；人全部結案由對帳關任務。
--   D. 舊資料回填：open 分組任務上、已上線但沒寫 task_checks 的 not_found／confirmed 補寫（checked_at＝當時上線時間，可用 contribution_id 追溯）。
--   不寫任何人物或參選資料。守門 roster-group-cooldown.test.ts。

-- ------------------------------------------------------------
-- A. dup 排除已裁決「不同人」的一對
-- ------------------------------------------------------------
DO $do$
DECLARE v_def TEXT;
BEGIN
  v_def := pg_get_functiondef('cec_roster_diff()'::regprocedure);
  IF position('politician_pair_resolutions' IN v_def) = 0 THEN
    IF position('FROM dg g' IN v_def) = 0 THEN RAISE EXCEPTION 'cec_roster_diff：找不到 dup 輸出的 FROM dg g'; END IF;
    v_def := replace(v_def, 'FROM dg g',
      E'FROM dg g\n   WHERE NOT EXISTS (SELECT 1 FROM politician_pair_resolutions x WHERE x.pair_key = g.a_pid::TEXT || ''|'' || g.b_pid::TEXT AND x.resolution = ''different'')');
    EXECUTE v_def;
  END IF;
END
$do$;
COMMENT ON FUNCTION cec_roster_diff IS '官方名冊鏡像 × 我們的 2026 參選紀錄（非 withdrawn）的差異：extra（我們有、官方沒有）、missing（官方有、我們沒有）、dup（同單位同號次兩筆人物，至少一筆對不上官方；已有 politician_pair_resolutions＝different 的一對不算）。只比近 3 天內抓成功的單位；容錯規則見 cec_name_fuzzy_eq。唯讀。2026-10-31，2026-11-09 dup 排除已裁決不同人';

-- ------------------------------------------------------------
-- B. 逐人查核的鍵與狀態
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION roster_group_check_task_id(p_key TEXT, p_action TEXT, p_pe TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_action = 'wrong_owner' AND p_pe ~ '^[1-9][0-9]{0,9}$' THEN 'auto:candidacy_owner_mismatch:' || p_pe
              ELSE 'auto:roster_group_person:' || p_key END
$$;
COMMENT ON FUNCTION roster_group_check_task_id IS '多人（名冊分組）任務裡「這一位」的查核鍵（task_checks.task_id）：掛錯人＝auto:candidacy_owner_mismatch:<pe_id>（跟掛錯人臂共用，1.122.0）；其餘＝auto:roster_group_person:<person_key>。TS personCheckTaskId 同一份';

-- 每個有查核紀錄的人：是否被階梯結案、冷卻到什麼時候（NULL＝沒有進行中的冷卻）
CREATE OR REPLACE FUNCTION roster_group_person_status() RETURNS TABLE (cid TEXT, closed BOOLEAN, cool_until TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT i.task_id, (cl.task_id IS NOT NULL),
         (SELECT max(tc.checked_at + (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL)
            FROM task_checks tc
           WHERE tc.task_id = i.task_id AND tc.checked_at > now() - make_interval(days => task_cooldown_max_days()))
    FROM (SELECT DISTINCT tc.task_id FROM task_checks tc
           WHERE tc.task_id LIKE 'auto:roster_group_person:%' OR tc.task_id LIKE 'auto:candidacy_owner_mismatch:%') i
    LEFT JOIN (SELECT l.task_id FROM task_ladder_closed l
                WHERE l.task_id LIKE 'auto:roster_group_person:%' OR l.task_id LIKE 'auto:candidacy_owner_mismatch:%') cl ON cl.task_id = i.task_id
$$;
COMMENT ON FUNCTION roster_group_person_status IS '多人任務逐人查核狀態：closed＝階梯結案（不再派）、cool_until＝最近一筆查核的冷卻結束時間（過了就是過去的時間，呼叫端要比 now()）';
REVOKE ALL ON FUNCTION roster_group_check_task_id(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION roster_group_person_status() FROM PUBLIC, anon, authenticated;

-- 開任務：結案或冷卻中的人不開（冷卻過了下一輪才開）
DO $do$
DECLARE
  v_def TEXT;
  v_old CONSTANT TEXT := 'WHERE NOT EXISTS (SELECT 1 FROM cov WHERE cov.k = x.person_key)';
BEGIN
  v_def := pg_get_functiondef('roster_group_tasks_create(text,integer,integer)'::regprocedure);
  IF position('roster_group_person_status' IN v_def) = 0 THEN
    IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'roster_group_tasks_create：找不到 cov 條件'; END IF;
    v_def := replace(v_def, v_old, v_old || E'\n       AND NOT EXISTS (SELECT 1 FROM roster_group_person_status() s WHERE s.cid = roster_group_check_task_id(x.person_key, x.action, x.pe_id::TEXT) AND (s.closed OR s.cool_until > now()))');
    EXECUTE v_def;
  END IF;
END
$do$;

-- 對帳：結案的人移除；冷卻中的人留在 target.people（交件仍認得 person_key）但不寫進說明
CREATE OR REPLACE FUNCTION roster_group_tasks_sweep() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_cur TEXT[]; v_closed INTEGER := 0; v_left JSONB; v_vis JSONB; v_n_left INTEGER; v_n_old INTEGER; v_desc TEXT; v_st JSONB;
  r RECORD;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT x.person_key), ARRAY[]::TEXT[]) INTO v_cur FROM roster_group_people() x;
  SELECT COALESCE(jsonb_object_agg(s.cid, jsonb_build_object('closed', s.closed, 'until', s.cool_until)), '{}'::JSONB) INTO v_st FROM roster_group_person_status() s;
  FOR r IN SELECT t.id, t.target, t.description FROM contribution_tasks t WHERE t.status = 'open' AND t.target->>'origin' = 'roster_group' LOOP
    v_n_old := COALESCE(jsonb_array_length(r.target->'people'), 0);
    WITH e AS (
      SELECT x.p, x.ord,
             COALESCE((v_st -> roster_group_check_task_id(x.p->>'key', x.p->>'action', x.p->>'politician_election_id') ->> 'closed')::BOOLEAN, FALSE) AS closed,
             COALESCE((v_st -> roster_group_check_task_id(x.p->>'key', x.p->>'action', x.p->>'politician_election_id') ->> 'until')::TIMESTAMPTZ > now(), FALSE) AS cooling
        FROM jsonb_array_elements(COALESCE(r.target->'people', '[]'::JSONB)) WITH ORDINALITY AS x(p, ord)
    ), k AS (
      SELECT e.* FROM e
       WHERE ((e.p->>'key') = ANY (v_cur)
              -- 缺人、多、缺號次是拿官方名冊鏡像比出來的：鏡像過期時「清單裡沒有他」不能當成處理完（掛錯人、政黨、縣市、鄉鎮不靠鏡像）
              OR (e.p->>'action' IN ('missing', 'extra', 'cand_no') AND NOT roster_group_fresh(e.p->>'election_type', e.p->>'county', e.p->>'town')))
         AND NOT e.closed
    )
    SELECT COALESCE(jsonb_agg(k.p ORDER BY k.ord), '[]'::JSONB), COALESCE(jsonb_agg(k.p ORDER BY k.ord) FILTER (WHERE NOT k.cooling), '[]'::JSONB), count(*)::INTEGER
      INTO v_left, v_vis, v_n_left FROM k;
    IF v_n_left = 0 THEN
      UPDATE contribution_tasks SET status = 'closed', closed_at = now() WHERE id = r.id AND status = 'open';
      v_closed := v_closed + 1;
    ELSE
      v_desc := roster_group_description(r.target->>'header', v_vis);
      IF v_n_left < v_n_old OR v_desc IS DISTINCT FROM r.description THEN
        UPDATE contribution_tasks
           SET target = CASE WHEN v_n_left < v_n_old THEN target || jsonb_build_object('people', v_left, 'people_count', v_n_left) ELSE target END,
               description = v_desc,
               title = (target->>'title_base') || v_n_left || ' 位'
         WHERE id = r.id AND status = 'open';
      END IF;
    END IF;
  END LOOP;
  RETURN v_closed;
END;
$$;
COMMENT ON FUNCTION roster_group_tasks_sweep IS '分組任務對帳（每小時）：人不在 roster_group_people() 且該單位官方名冊鏡像新鮮，或逐人查核階梯結案＝處理完；全部處理完就 closed，否則更新說明與標題的人數；冷卻中的人不寫進說明。回傳關掉的張數。2026-11-07，2026-11-09 加逐人階梯';
REVOKE ALL ON FUNCTION roster_group_tasks_sweep() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- C. refresh_dispatch_blocked：以 20261109150000 為底，多算分組任務的 cool_until（只有剩下的人全部冷卻才冷卻，取最早結束的那一位）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_dispatch_blocked() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  -- >>> 查核階梯：手動任務（uuid）結案＝關閉（open 的才動）
  UPDATE contribution_tasks t SET status = 'closed', closed_at = now()
    FROM task_ladder_closed lc
   WHERE lc.task_id = t.id::text AND t.status = 'open';
  -- <<< 查核階梯
  WITH saturated AS (
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
    UNION SELECT lc.task_id FROM task_ladder_closed lc WHERE lc.task_id LIKE 'auto:%'
    -- <<< 查核階梯
  )
  , cool AS (
    SELECT tc.task_id, max(tc.checked_at + (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL) AS until
      FROM task_checks tc
    WHERE tc.checked_at > now() - (task_check_cooldown_days_for(tc.task_id, tc.outcome, tc.checked_at, tc.id) || ' days')::INTERVAL
      AND tc.checked_at > now() - make_interval(days => (SELECT task_cooldown_max_days()))
    GROUP BY tc.task_id
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
           CASE WHEN d.task_id LIKE 'auto:%' THEN EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id) ELSE d.blocked END AS blocked,
           CASE WHEN g.task_id IS NOT NULL THEN g.until ELSE c.until END AS until,
           task_queue_key(d.last_dispatched_at, d.priority_seconds, CASE WHEN g.task_id IS NOT NULL THEN g.until ELSE c.until END, d.boost_seconds)
             > now() + make_interval(secs => (SELECT q.dispatch_horizon_seconds FROM queue_settings q WHERE q.id = 1)) AS cooling
      FROM task_dispatches d LEFT JOIN cool c ON c.task_id = d.task_id LEFT JOIN g ON g.task_id = d.task_id
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

-- ------------------------------------------------------------
-- D. 回填：open 分組任務上、已上線卻沒寫 task_checks 的 not_found／confirmed（掛錯人 confirmed 1.122.0 起就有，會被 NOT EXISTS 擋掉）
-- ------------------------------------------------------------
INSERT INTO task_checks (task_id, agent_name, note, contribution_id, outcome, checked_at)
SELECT roster_group_check_task_id(p.e->>'key', p.e->>'action', p.e->>'politician_election_id'), c.agent_name,
       left('多人任務 ' || t.id::TEXT || '「' || (p.e->>'key') || '」：' || COALESCE(c.payload->>'finding', c.payload->>'note', c.note, ''), 2000),
       c.id, c.payload->>'outcome', COALESCE(c.applied_at, c.created_at)
  FROM contributions c
  JOIN contribution_tasks t ON c.payload->>'task_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND t.id::TEXT = lower(c.payload->>'task_id')
  CROSS JOIN LATERAL (
    SELECT e
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.target->'people') = 'array' THEN t.target->'people' ELSE '[]'::JSONB END) AS e
     WHERE e ? 'key'
       AND CASE WHEN COALESCE(c.payload->>'person_key', '') <> '' THEN e->>'key' = btrim(c.payload->>'person_key')
                ELSE COALESCE(c.payload->>'politician_election_id', '') <> '' AND e->>'politician_election_id' = c.payload->>'politician_election_id'
                     AND (SELECT count(*) FROM jsonb_array_elements(t.target->'people') e2 WHERE e2->>'politician_election_id' = c.payload->>'politician_election_id') = 1
           END
     LIMIT 1
  ) p
 WHERE c.contribution_type = 'no_change' AND c.status = 'applied' AND c.payload->>'outcome' IN ('not_found', 'confirmed')
   AND t.status = 'open' AND t.target->>'origin' = 'roster_group'
   AND NOT EXISTS (SELECT 1 FROM task_checks x WHERE x.contribution_id = c.id);

SELECT roster_group_tasks_sweep();
SELECT refresh_dispatch_blocked();
