-- 「確認無誤」不進投票＋統一查核階梯（2026-11-09，維護者小良，協議 1.123.0；數字已由維護者定案，全在設定表一處）
--   1. 任何任務的 no_change＋outcome=confirmed 不再等驗證票：交件當下直接落庫為 applied（contribute-handler，reviewed_by＝system:confirmed-direct），
--      跟 1.119.0 的「查無」（20261107000000）同一條直接落庫路徑。多人任務（1.122.0）的逐人 task_checks 照寫。
--   2. 查核階梯：同一個任務（task_id）的 not_found＋confirmed 查核累計次數（兩種合計）n，第 n 次的冷卻天數＝「這一筆 outcome」在設定表
--      task_check_ladder_settings.days 的第 n 格；n 超過格數＝結案（auto: 任務由 refresh_dispatch_blocked 永久 blocked，手動任務關閉）。
--      初值 not_found＝{5,10,20}（第 4 次起結案）、confirmed＝{5,10}（第 3 次起結案）；改數字一行 UPDATE（TS CHECK_LADDER_DAYS 要一起改），不用動函式。
--      不套階梯的例外（task_check_ladder_exempt）：task_cooldown_settings.task_types（進度追蹤 progress_stale、deadline_due）、not_running_recheck、roster_check、
--      candidate_status_stale、election_result_missing、candidacy_source_missing 的 cand_no／cand_no_recheck（號次，等官方公告）——這些是週期性重查、本來就要回頭看，
--      維持原本冷卻（not_found 2 天、進度類第二次起 30 天、confirmed 14 天）、不自動結案。unreachable 照舊 task_unreachable_cooldown_days()。
--   3. 結案清單：視圖 task_ladder_closed（task_id、查核次數、結案時間、最後查核），維護者／主控台可看。
--   4. 舊的等票中 confirmed 一次清掉（可重跑）；既有查核歷史也算進階梯，已超過格數的任務在這支 migration 結尾呼叫 refresh_dispatch_blocked() 時結案。

-- ------------------------------------------------------------
-- 1. 階梯設定與函式
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_check_ladder_settings (
  outcome TEXT PRIMARY KEY CHECK (outcome IN ('not_found', 'confirmed')),
  days    INTEGER[] NOT NULL CHECK (cardinality(days) >= 1 AND 0 < ALL (days))
);
COMMENT ON TABLE task_check_ladder_settings IS '查核階梯（2026-11-09）：同一任務 not_found＋confirmed 累計第 n 次的冷卻天數＝該筆 outcome 的 days[n]，n 超過 days 長度＝結案。TS CHECK_LADDER_DAYS 同一份初值，confirmed-direct.test.ts 盯著；改值一行 UPDATE（兩邊要一起改）';
ALTER TABLE task_check_ladder_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON task_check_ladder_settings;
CREATE POLICY "Public read" ON task_check_ladder_settings FOR SELECT USING (true);
INSERT INTO task_check_ladder_settings (outcome, days) VALUES ('not_found', ARRAY[5, 10, 20]), ('confirmed', ARRAY[5, 10])
ON CONFLICT (outcome) DO NOTHING;

-- 第 n 次查核（n 從 1 起）的冷卻天數；超過格數回 NULL＝結案
CREATE OR REPLACE FUNCTION task_check_ladder_days(p_outcome TEXT, p_n BIGINT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$ SELECT l.days[p_n::INTEGER] FROM task_check_ladder_settings l WHERE l.outcome = p_outcome $$;
COMMENT ON FUNCTION task_check_ladder_days IS '查核階梯：該 outcome 第 n 次的冷卻天數；n 超過設定表 days 長度回 NULL（＝結案）';

CREATE OR REPLACE FUNCTION task_check_ladder_exempt(p_task_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT p_task_id LIKE 'auto:%' AND (
           split_part(p_task_id, ':', 2) = ANY (ARRAY['not_running_recheck', 'roster_check', 'candidate_status_stale', 'election_result_missing'])
        OR (split_part(p_task_id, ':', 2) = 'candidacy_source_missing' AND split_part(p_task_id, ':', 3) LIKE 'cand_no%')
        OR EXISTS (SELECT 1 FROM task_cooldown_settings s WHERE s.id = 1 AND split_part(p_task_id, ':', 2) = ANY (s.task_types)))
$$;
COMMENT ON FUNCTION task_check_ladder_exempt IS '不套查核階梯的任務（週期性重查或等官方公告，不自動結案）：進度追蹤類（task_cooldown_settings.task_types）、not_running_recheck、roster_check、candidate_status_stale、election_result_missing、號次缺口（candidacy_source_missing:cand_no*）。TS LADDER_EXEMPT_TASK_TYPES 同一份';

-- 冷卻天數：以 20261107000000 為底，非例外的 not_found／confirmed 改走階梯（結案那一筆回最後一格，結案本身由 refresh_dispatch_blocked 與視圖處理）
CREATE OR REPLACE FUNCTION task_check_cooldown_days_for(p_task_id TEXT, p_outcome TEXT, p_checked_at TIMESTAMPTZ, p_id BIGINT)
RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN p_outcome = 'unreachable' THEN task_unreachable_cooldown_days()
           WHEN p_outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(p_task_id) THEN
             COALESCE(task_check_ladder_days(p_outcome,
                        (SELECT count(*) FROM task_checks x
                          WHERE x.task_id = p_task_id AND x.outcome IN ('not_found', 'confirmed') AND (x.checked_at, x.id) <= (p_checked_at, p_id))),
                      (SELECT l.days[cardinality(l.days)] FROM task_check_ladder_settings l WHERE l.outcome = p_outcome))
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
  '一筆 task_checks 的冷卻天數：unreachable＝task_unreachable_cooldown_days()；非例外任務的 not_found／confirmed＝階梯（task_check_ladder_days，同一任務兩種合計的第 n 次）；例外任務（task_check_ladder_exempt）not_found＝2 天（進度類第二次起 not_found_repeat_days）、confirmed 與其餘＝task_check_cooldown_days()';

-- refresh_dispatch_blocked 濾掉太舊歷史用的上限：多算階梯的最大一格
CREATE OR REPLACE FUNCTION task_cooldown_max_days() RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT GREATEST(task_check_cooldown_days(), task_unreachable_cooldown_days(), COALESCE(s.not_found_first_days, 0), COALESCE(s.not_found_repeat_days, 0),
                  COALESCE((SELECT max(d) FROM task_check_ladder_settings l, unnest(l.days) AS d), 0))
    FROM (SELECT 1) AS one LEFT JOIN task_cooldown_settings s ON s.id = 1
$$;

-- 結案清單：非例外任務，累計查核（not_found＋confirmed 合計）編號超過該筆 outcome 階梯格數的
CREATE OR REPLACE VIEW task_ladder_closed AS
WITH numbered AS (
  SELECT tc.task_id, tc.outcome, tc.checked_at, tc.id,
         row_number() OVER (PARTITION BY tc.task_id ORDER BY tc.checked_at, tc.id) AS n,
         count(*) OVER (PARTITION BY tc.task_id) AS checks
    FROM task_checks tc
   WHERE tc.outcome IN ('not_found', 'confirmed') AND NOT task_check_ladder_exempt(tc.task_id)
)
SELECT task_id, max(checks) AS checks, min(checked_at) AS closed_at, max(checked_at) AS last_checked_at,
       CASE WHEN task_id LIKE 'auto:%' THEN split_part(task_id, ':', 2) ELSE 'manual' END AS task_kind
  FROM numbered
 WHERE task_check_ladder_days(outcome, n) IS NULL
 GROUP BY task_id;
COMMENT ON VIEW task_ladder_closed IS '被查核階梯結案的任務（同一個任務 not_found＋confirmed 累計超過階梯格數）：auto: 任務由 refresh_dispatch_blocked 永久 blocked、手動任務被關閉。維護者覆核用；要放回去＝刪掉那幾筆 task_checks（或改設定表 days）';

-- refresh_dispatch_blocked：以 20261011320000 為底，blocked 多算結案清單；手動任務結案就關閉
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
  , x AS (
    SELECT d.task_id,
           CASE WHEN d.task_id LIKE 'auto:%' THEN EXISTS (SELECT 1 FROM b WHERE b.task_id = d.task_id) ELSE d.blocked END AS blocked,
           c.until,
           task_queue_key(d.last_dispatched_at, d.priority_seconds, c.until, d.boost_seconds)
             > now() + make_interval(secs => (SELECT q.dispatch_horizon_seconds FROM queue_settings q WHERE q.id = 1)) AS cooling
      FROM task_dispatches d LEFT JOIN cool c ON c.task_id = d.task_id
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
-- 2. 舊資料：等票中的 no_change＋confirmed 一次清掉（可重跑：只動 status='pending' 的列，動完就不再是）
--    對每一筆照 TS applyNoChange 的 confirmed 行為：
--      · auto: 任務 → 記一筆 task_checks（outcome=confirmed，contribution_id 指回）→ 進查核階梯冷卻；再依型別：
--          duplicate_policy → policy_dupe_reviews（人物不在了→標 superseded）；lineage_candidate／lineage_link_candidate → lineage_candidate_reviews；
--          legacy_audit → 政見的 audit 履歷（edit_history）；not_running_recheck → politician_elections.verified＝true
--      · 手動任務（uuid）→ 任務不存在／task_id 形狀不對 → superseded；question 型 → 只標 applied；多人任務 → 不關任務，
--          能對到名單上那位（person_key，或舊資料用 politician_election_id 對到唯一一位）且做法是 wrong_owner → 寫 auto:candidacy_owner_mismatch:<pe_id> 的 task_checks；
--          其餘 → 關任務（open 的才動）
--    貢獻標 applied（或 superseded）、reviewed_by＝system:confirmed-direct，並把它的驗證票（task_dispatches 的 verify:<id>）收掉。
--    沒寫 edit_history（除 legacy_audit／not_running_recheck 那兩個本來就靠履歷的）：task_checks.contribution_id 就是來源，可據以刪除。
-- ------------------------------------------------------------
DROP TABLE IF EXISTS _cf_old;
CREATE TEMP TABLE _cf_old AS
SELECT c.id, c.agent_name, c.payload->>'task_id' AS task_id,
       COALESCE(c.payload->>'finding', c.payload->>'note', c.note) AS note,
       c.source_urls, t.target AS task_target,
       CASE
         WHEN c.payload->>'task_id' LIKE 'auto:%' THEN 'auto'
         WHEN c.payload->>'task_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
           CASE WHEN t.id IS NULL THEN 'gone'
                WHEN t.task_type = 'question' THEN 'applied_only'
                WHEN t.target->>'multi_person' = 'true' THEN 'multi'
                ELSE 'manual' END
         ELSE 'gone'
       END AS kind,
       c.payload->>'person_key' AS person_key,
       c.payload->>'politician_election_id' AS payload_pe
  FROM contributions c
  LEFT JOIN contribution_tasks t
    ON c.payload->>'task_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND t.id::text = lower(c.payload->>'task_id')
 WHERE c.contribution_type = 'no_change' AND c.status = 'pending' AND c.payload->>'outcome' = 'confirmed';

-- auto: 任務的 task_checks
INSERT INTO task_checks (task_id, agent_name, note, contribution_id, outcome, checked_at)
SELECT n.task_id, n.agent_name, n.note, n.id, 'confirmed', now()
  FROM _cf_old n
 WHERE n.kind = 'auto'
   AND NOT EXISTS (SELECT 1 FROM task_checks x WHERE x.contribution_id = n.id);

-- 多人任務：逐人的 task_checks（只有 wrong_owner 那位；person_key 優先，沒帶的舊資料用 politician_election_id 對到唯一一位）
INSERT INTO task_checks (task_id, agent_name, note, contribution_id, outcome, checked_at)
SELECT 'auto:candidacy_owner_mismatch:' || (p.e->>'politician_election_id'), n.agent_name,
       left('多人任務 ' || n.task_id || '「' || (p.e->>'key') || '」：' || COALESCE(n.note, ''), 2000), n.id, 'confirmed', now()
  FROM _cf_old n
  CROSS JOIN LATERAL (
    SELECT e
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.task_target->'people') = 'array' THEN n.task_target->'people' ELSE '[]'::jsonb END) AS e
     WHERE e ? 'key'
       AND CASE WHEN COALESCE(n.person_key, '') <> '' THEN e->>'key' = btrim(n.person_key)
                ELSE COALESCE(n.payload_pe, '') <> '' AND e->>'politician_election_id' = n.payload_pe
                     AND (SELECT count(*) FROM jsonb_array_elements(n.task_target->'people') e2
                           WHERE e2->>'politician_election_id' = n.payload_pe) = 1
           END
     LIMIT 1
  ) p
 WHERE n.kind = 'multi'
   AND p.e->>'action' = 'wrong_owner'
   AND (p.e->>'politician_election_id') ~ '^[1-9][0-9]{0,9}$'
   AND NOT EXISTS (SELECT 1 FROM task_checks x WHERE x.contribution_id = n.id);

-- 政見重複清查結論（人物不在了的下面標 superseded）
INSERT INTO policy_dupe_reviews (politician_id, fingerprint, agent_name, contribution_id, note)
SELECT m[1]::uuid, lower(m[2]), n.agent_name, n.id, n.note
  FROM _cf_old n
  CROSS JOIN LATERAL regexp_match(n.task_id, '^auto:duplicate_policy:([0-9a-f-]{36}):([0-9a-f]{8})$', 'i') AS m
 WHERE n.kind = 'auto' AND m IS NOT NULL
   AND EXISTS (SELECT 1 FROM politicians p WHERE p.id = m[1]::uuid)
ON CONFLICT (politician_id) DO UPDATE
  SET fingerprint = EXCLUDED.fingerprint, agent_name = EXCLUDED.agent_name, contribution_id = EXCLUDED.contribution_id, note = EXCLUDED.note, reviewed_at = now();

-- 脈絡候選清查結論（同一個 review_key 在同一批有多筆時，後面的蓋前面的；DISTINCT ON 先取最新一筆，免得同一條 INSERT 撞自己）
INSERT INTO lineage_candidate_reviews (review_key, fingerprint, agent_name, contribution_id, note)
SELECT DISTINCT ON (k.review_key) k.review_key, k.fingerprint, n.agent_name, n.id, n.note
  FROM _cf_old n
  CROSS JOIN LATERAL (
    SELECT 'block:' || lower(b[1]) AS review_key, lower(b[2]) AS fingerprint
      FROM regexp_match(n.task_id, '^auto:lineage_candidate:([0-9a-f]{12}):([0-9a-f]{8})$', 'i') AS b WHERE b IS NOT NULL
    UNION ALL
    SELECT 'link:' || lower(l[1]), lower(l[2])
      FROM regexp_match(n.task_id, '^auto:lineage_link_candidate:([0-9a-f-]{36}):([0-9a-f]{8})$', 'i') AS l WHERE l IS NOT NULL
  ) k
 WHERE n.kind = 'auto'
 ORDER BY k.review_key, n.id
ON CONFLICT (review_key) DO UPDATE
  SET fingerprint = EXCLUDED.fingerprint, agent_name = EXCLUDED.agent_name, contribution_id = EXCLUDED.contribution_id, note = EXCLUDED.note, reviewed_at = now();

-- 早期匯入核對：政見的 audit 履歷
INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
SELECT 'policies', lower(m[1]), 'audit', NULL,
       to_jsonb('已核對來源 ' || COALESCE(substring(n.source_urls[1] from '^https?://(?:www\.)?([^/]+)'), '') ||
                CASE WHEN n.note IS NOT NULL AND n.note <> '' THEN '：' || left(n.note, 200) ELSE '' END),
       n.id, n.agent_name
  FROM _cf_old n
  CROSS JOIN LATERAL regexp_match(n.task_id, '^auto:legacy_audit:([0-9a-f-]{36})$', 'i') AS m
 WHERE n.kind = 'auto' AND m IS NOT NULL
   AND EXISTS (SELECT 1 FROM policies p WHERE p.id = m[1]::uuid)
   AND NOT EXISTS (SELECT 1 FROM edit_history h WHERE h.contribution_id = n.id AND h.table_name = 'policies' AND h.field = 'audit');

-- 不參選重查：標成已核對
WITH nr AS (
  SELECT n.id, m[1]::bigint AS pe_id
    FROM _cf_old n
    CROSS JOIN LATERAL regexp_match(n.task_id, '^auto:not_running_recheck:([0-9]+)$') AS m
   WHERE n.kind = 'auto' AND m IS NOT NULL
), upd AS (
  UPDATE politician_elections pe SET verified = true
    FROM nr WHERE pe.id = nr.pe_id AND pe.verified IS NOT TRUE
  RETURNING pe.id, nr.id AS contribution_id
)
INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
SELECT 'politician_elections', upd.id::text, 'verified', 'false'::jsonb, 'true'::jsonb, upd.contribution_id,
       (SELECT o.agent_name FROM _cf_old o WHERE o.id = upd.contribution_id)
  FROM upd;

-- 一般手動任務：關任務（open 的才動）
UPDATE contribution_tasks t
   SET status = 'closed', closed_at = now()
  FROM _cf_old n
 WHERE n.kind = 'manual' AND t.id::text = lower(n.task_id) AND t.status = 'open';

-- 貢獻標結案：任務不存在／形狀不對、或政見重複清查的人物已不在 → superseded，其餘 applied
UPDATE contributions c
   SET status = CASE WHEN n.kind = 'gone' OR n.dupe_gone THEN 'superseded' ELSE 'applied' END,
       review_notes = '[系統] 2026-11-09 規則改：「確認無誤」不再需要別人驗證，直接記錄；這個任務進查核階梯冷卻（第 1 次 5 天起，累計超過階梯就結案）。'
                      || CASE WHEN n.kind = 'gone' OR n.dupe_gone THEN '（任務已不存在或編號不是 /next 給的格式，只標結案。）' ELSE '' END,
       reviewed_by = 'system:confirmed-direct',
       reviewed_at = now(),
       applied_at = CASE WHEN n.kind = 'gone' OR n.dupe_gone THEN NULL ELSE now() END
  FROM (
    SELECT o.id, o.kind,
           (o.task_id ~* '^auto:duplicate_policy:[0-9a-f-]{36}:[0-9a-f]{8}$'
            AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.id::text = lower(split_part(o.task_id, ':', 3)))) AS dupe_gone
      FROM _cf_old o
  ) n
 WHERE c.id = n.id AND c.status = 'pending';

DELETE FROM task_dispatches d
 USING _cf_old n
 WHERE d.task_id = 'verify:' || n.id::text;

DROP TABLE _cf_old;

-- 既有查核歷史與這批清掉的一起算進階梯：已超過格數的任務立刻結案（auto: 永久 blocked、手動任務關閉）
SELECT refresh_dispatch_blocked();
