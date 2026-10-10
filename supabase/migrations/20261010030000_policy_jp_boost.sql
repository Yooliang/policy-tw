-- 日本站（policy_jp）的插隊 jp-boost：政策の系譜の派工佇列也能「一次性插隊」（2026-10-10，維護者：日本站照搬插隊）
-- ============================================================
--
-- 照搬正見（public）的插隊（20260921000030 單一佇列／000031 TRUNCATE／000032 最新的排最前／20261008165000 手動任務已在總表）：
--   * 表 policy_jp.task_boosts：誰、什麼時候、用什麼條件插了多少筆；RLS 開、公開可讀（同正見）。
--   * policy_jp.task_boost(label, filter, agent, ip_hash)：符合條件的佇列項目（自動缺口、手動任務、待驗證貢獻）queue_at 設成
--     1980-01-01 減 n 分鐘（n＝第幾次插隊，越新越前面）。LEAST 保證不會把已經更前面的（1970 訪客優先）往後推。
--   * policy_jp.task_boost_matches(filter)：條件 → 符合的佇列鍵。
--   * policy_jp.task_boost_remaining(id)：一筆插隊還剩多少沒領（GET 用）。
--
-- 一次性：派出去 task_dispatched 把 queue_at 蓋成 queue_slot（>= 2000 年），自然回到自己那一層的隊尾——這支不用動任何派工函式。
-- 與日本版 rebalance_queue 的關係（20261009300000：層＋層內 步驟→日期→先進先出）：rebalance_queue 只處理 queue_at >= 2000-01-01 的列
--   （v_start、_ready、驗證列、任務列、非可派任務列的 WHERE 都有這一句），1980 年段（插隊）與 1970（訪客優先）本來就不在它的視野裡，
--   所以插隊的列每 10 分鐘重排後仍然在最前面，不會被拉進層的交錯；領走後才回到重排的對象。本檔不改 rebalance_queue、seed_auto_task_queue、任何臂。
--
-- 日本專屬（篩選詞彙；端點無金鑰，只收固定詞彙，不收自由文字，驗證在 _shared/jp/boost-filter.ts）：
--   pref_codes       text[]  都道府県的團體碼（6 碼）。項目所屬的都道府県＝由 lg_code 算（lg_pref_code），算不出來才看 target／payload 的 pref_code
--   lg_codes         text[]  團體碼（6 碼）。項目的團體＝target／payload 的 lg_code（鏈上的缺口沒有就看 chain_lg_code）
--   task_types       text[]  任務型別（election_discovery、local_government_missing、regional_stats_missing…；驗證項目用 contribution_type 比）
--   kinds            text[]  'task'／'verify'（預設兩種都插）
--   election_before  date    項目的選舉日（target.election_date，沒有就 vote_window_from；驗證項目讀 payload.election_date）早於這天（嚴格小於）。
--                            沒有日期的項目不符合。日期格式不對一律不符合（不讓一個壞值炸掉整次插隊）
-- 不搬的（台灣專用）：regions（縣市）、election_id、election_types、missing_avatar、politician_ids——日本站沒有人物頭像，選舉別走 task_types。
--
-- 守門：supabase/functions/_shared/policy-jp-boost.test.ts（PGlite，套全部 policy_jp migration）；
--   policy-jp-dispatch-drift.test.ts 把這三支登記為日本專屬（篩選詞彙不同，不是逐字複本；插隊／還原的骨架同正見）。
-- 這支只動 policy_jp，不碰 public。

-- ------------------------------------------------------------
-- 1. 插隊紀錄（欄位同正見；公開可讀）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_jp.task_boosts (
  id BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  filter JSONB NOT NULL,
  agent_name TEXT,
  ip_hash TEXT,
  matched_tasks INTEGER NOT NULL DEFAULT 0,
  matched_verifies INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE policy_jp.task_boosts IS '插隊紀錄（日本站）：誰、什麼時候、用什麼條件把哪些任務排到最前（一次性）。filter 的詞彙見 task_boost_matches。';
ALTER TABLE policy_jp.task_boosts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_boosts_public_read ON policy_jp.task_boosts;
CREATE POLICY task_boosts_public_read ON policy_jp.task_boosts FOR SELECT USING (true);
-- 公開資料只給讀（同 tables migration 第 12 節的慣例）；寫入只走 service_role（BYPASSRLS）
REVOKE ALL ON policy_jp.task_boosts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON policy_jp.task_boosts TO anon, authenticated;
GRANT ALL ON policy_jp.task_boosts TO service_role;
GRANT ALL ON SEQUENCE policy_jp.task_boosts_id_seq TO service_role;

-- ------------------------------------------------------------
-- 2. 條件 → 符合的佇列鍵
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.task_boost_matches(p_filter JSONB)
RETURNS TABLE (task_id TEXT, kind TEXT)
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  WITH f AS (
    SELECT
      CASE WHEN p_filter ? 'pref_codes' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'pref_codes')) END AS pref_codes,
      CASE WHEN p_filter ? 'lg_codes' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'lg_codes')) END AS lg_codes,
      CASE WHEN p_filter ? 'task_types' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'task_types')) END AS task_types,
      (p_filter ? 'election_before') AS has_before,
      policy_jp.date_or_null(p_filter->>'election_before') AS election_before,
      COALESCE(CASE WHEN p_filter ? 'kinds' THEN ARRAY(SELECT jsonb_array_elements_text(p_filter->'kinds')) END, ARRAY['task', 'verify']) AS kinds
  ),
  subjects AS (
    -- 每一個佇列項目的團體、都道府県、選舉日、型別（手動任務已在總表裡，不另算 contribution_tasks）
    SELECT g.task_id, 'task'::TEXT AS kind, g.task_type AS type_key,
           COALESCE(NULLIF(g.target->>'lg_code', ''), NULLIF(g.target->>'chain_lg_code', '')) AS lg_code,
           NULLIF(g.target->>'pref_code', '') AS pref_code,
           COALESCE(policy_jp.date_or_null(g.target->>'election_date'), policy_jp.date_or_null(g.target->>'vote_window_from')) AS edate
      FROM policy_jp.contribution_auto_tasks_arms() g
    UNION ALL
    SELECT 'verify:' || c.id, 'verify', c.contribution_type,
           NULLIF(c.payload->>'lg_code', ''),
           NULLIF(c.payload->>'pref_code', ''),
           policy_jp.date_or_null(c.payload->>'election_date')
      FROM policy_jp.contributions c WHERE c.status = 'pending'
  )
  SELECT s.task_id, s.kind
    FROM subjects s
    CROSS JOIN f
   WHERE s.kind = ANY(f.kinds)
     AND (f.task_types IS NULL OR s.type_key = ANY(f.task_types))
     AND (f.lg_codes IS NULL OR s.lg_code = ANY(f.lg_codes))
     AND (f.pref_codes IS NULL OR COALESCE(policy_jp.lg_pref_code(s.lg_code), s.pref_code) = ANY(f.pref_codes))
     AND (NOT f.has_before OR s.edate < f.election_before);
$$;
COMMENT ON FUNCTION policy_jp.task_boost_matches IS
  '插隊條件 → 符合的佇列鍵（日本站）。filter 的鍵（全部可省略，同一筆內 AND）：pref_codes／lg_codes／task_types／kinds／election_before（嚴格早於）。詞彙驗證在 _shared/jp/boost-filter.ts';

-- ------------------------------------------------------------
-- 3. 插隊：符合條件的排到最前（1980 年減第 n 次的分鐘數，新的排最前），回 {id, matched_tasks, matched_verifies}
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.task_boost(p_label TEXT, p_filter JSONB, p_agent TEXT DEFAULT NULL, p_ip_hash TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SET search_path = policy_jp, pg_temp AS $$
DECLARE v_id BIGINT; v_tasks INTEGER; v_verifies INTEGER; v_at TIMESTAMPTZ;
BEGIN
  -- 還沒發號碼牌的先發，不然排不到（seed 尾端會重排，但 1980 年段不在重排的視野裡）
  PERFORM policy_jp.seed_auto_task_queue();
  INSERT INTO policy_jp.task_boosts (label, filter, agent_name, ip_hash) VALUES (p_label, p_filter, p_agent, p_ip_hash) RETURNING id INTO v_id;
  -- 最新的插隊最前：第 n 次 → 1980-01-01 減 n 分鐘
  v_at := TIMESTAMPTZ '1980-01-01' - (v_id * INTERVAL '1 minute');
  CREATE TEMP TABLE IF NOT EXISTS _boost_hits (task_id TEXT, kind TEXT) ON COMMIT DROP;
  TRUNCATE _boost_hits;
  INSERT INTO _boost_hits SELECT * FROM policy_jp.task_boost_matches(p_filter);
  UPDATE policy_jp.contribution_tasks t SET last_dispatched_at = NULL
    FROM _boost_hits h WHERE h.kind = 'task' AND h.task_id = t.id::TEXT;
  UPDATE policy_jp.task_dispatches d SET queue_at = LEAST(d.queue_at, v_at)
    FROM _boost_hits h WHERE h.task_id = d.task_id;
  SELECT count(*) FILTER (WHERE kind = 'task'), count(*) FILTER (WHERE kind = 'verify') INTO v_tasks, v_verifies FROM _boost_hits;
  UPDATE policy_jp.task_boosts SET matched_tasks = v_tasks, matched_verifies = v_verifies WHERE id = v_id;
  RETURN jsonb_build_object('id', v_id, 'label', p_label, 'matched_tasks', v_tasks, 'matched_verifies', v_verifies, 'queue_at', v_at);
END;
$$;
COMMENT ON FUNCTION policy_jp.task_boost IS
  '插隊（日本站）：符合條件的佇列項目 queue_at＝1980-01-01 減 n 分鐘（一次性；領走後 task_dispatched 蓋回隊尾）。1980 年段不在 rebalance_queue 的視野（只處理 >= 2000 年），重排後仍在最前面';

-- ------------------------------------------------------------
-- 4. 一筆插隊還剩多少沒領：跟當初條件再算一次，只數還在 1990 年以前那一段的
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.task_boost_remaining(p_id BIGINT)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT jsonb_build_object(
    'tasks', count(*) FILTER (WHERE m.kind = 'task' AND d.queue_at < TIMESTAMPTZ '1990-01-01'),
    'verifies', count(*) FILTER (WHERE m.kind = 'verify' AND d.queue_at < TIMESTAMPTZ '1990-01-01')
  )
  FROM policy_jp.task_boosts b
  JOIN LATERAL policy_jp.task_boost_matches(b.filter) m ON true
  LEFT JOIN policy_jp.task_dispatches d ON d.task_id = m.task_id
  WHERE b.id = p_id;
$$;

-- ------------------------------------------------------------
-- 5. 權限：函式只給 service_role（Edge Function 用 service_role 呼叫）；anon／authenticated 不能插隊
-- ------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION policy_jp.task_boost_matches(JSONB), policy_jp.task_boost(TEXT, JSONB, TEXT, TEXT), policy_jp.task_boost_remaining(BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.task_boost_matches(JSONB), policy_jp.task_boost(TEXT, JSONB, TEXT, TEXT), policy_jp.task_boost_remaining(BIGINT)
  TO service_role;

DO $$
DECLARE bad TEXT;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'policy_jp.task_boosts'::regclass) THEN RAISE EXCEPTION 'policy_jp.task_boosts 沒開 RLS'; END IF;
  SELECT string_agg(DISTINCT g.privilege_type || ':' || g.grantee, ', ') INTO bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'policy_jp' AND g.table_name = 'task_boosts' AND g.grantee IN ('anon', 'authenticated', 'PUBLIC') AND g.privilege_type <> 'SELECT';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'policy_jp.task_boosts 對 anon／authenticated 只能給讀：%', bad; END IF;
END $$;
