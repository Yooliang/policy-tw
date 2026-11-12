-- 工作卡③：開任務前用 work_key 查重併卡，並接上需求訊號（2026-11-12，docs/PLAN-workcard-123.md 項目③）
-- ============================================================
--
-- 想法：同一張工作卡（work_key）已經在派工隊列上，就不要再為「又有人要」開一筆新任務——寫一筆需求訊號（①的 work_card_signals），
-- 讓卡的優先級靠需求疊加（①）往前、不靠多開一筆平行任務。沒有卡才照舊新開。
--   1. task_work_key_for_manual(p_type, p_target)：把 task_work_key 的 uuid 手動任務分支抽成獨立純函式（輸出逐案不變），
--      這樣「還沒有 uuid 的請求」也能先算出卡；task_work_key 的 uuid 分支改呼叫它（守門 work-card-attach.test.ts A 對舊定義逐案比對）。
--   2. work_card_resolve(p_work_key, p_scope)：這張卡現在還會被派的任務（排除 blocked 與階梯已結案的卡）列（task_dispatches 非驗證列，優先；其次尚未入列的 open 手動任務）。
--      範圍（scope）例外：請求帶 tenure 只併到 scope 相同的手動任務，不併到自動缺口（自動缺口視同 pledge）；帶 pledge 時自動缺口與 scope 相同的手動任務可併。
--   3. work_card_attach(p_work_key, p_kind, p_actor, p_boost)：有卡→寫訊號（work_card_signal_add，冪等）、必要時套插隊（只在這次真的新增訊號時，
--      GREATEST 至 visitor_front_seconds、查核冷卻中不插，同 #912 web_request_gap_boost）；回 {attached, task_id, work_key, signal_added}。
--      沒有卡（或鍵不是卡的形狀）→ attached:false，由呼叫端照舊新開。p_kind 為 NULL＝只查不寫訊號（維護者指定的任務：回報命中、不算需求）。
--   4. work_card_view_signals_sync()：頁面訪問訊號（kind='view'）。page_traffic 只有各頁的不重複訪客「人數」（GA 匿名統計，沒有個別訪客），
--      所以對每個達標頁（page_traffic_hot）名下、派工隊列上現有的卡，補 min(人數, 上限) 筆 actor＝'ga:<序號>' 的訊號（冪等）。
--      人數超過門檻的部分才有效的解讀由①的公式處理（views＝floor(人數 ÷ 每單位幾人) − 1，第一個單位由流量提層領走）；頁面正被流量提層暫停時不寫。
--      由 console-fetch 每小時在 replace_page_traffic 之後呼叫。
-- #912 的事後併入（web_request_coverage／web_request_gap_boost）保留為兜底，不動。
-- 只加不刪（新函式＋同簽名的 task_work_key CREATE OR REPLACE），CI 先 db push 再部署函式的順序正確。不改協議、不升版號。

-- ------------------------------------------------------------
-- 1. 手動任務的工作卡鍵（純函式）
-- ------------------------------------------------------------
-- 不是卡的形狀（question、audit、adjudicate、roster_check、other…，或缺目標）回 NULL，呼叫端再退回 task:<uuid>
CREATE OR REPLACE FUNCTION task_work_key_for_manual(p_type TEXT, p_target JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_t    JSONB := COALESCE(p_target, '{}'::JSONB);
  v_pid  TEXT;
  v_poid TEXT;
BEGIN
  IF p_type IS NULL THEN RETURN NULL; END IF;
  v_pid  := CASE WHEN uuid_or_null(v_t->>'politician_id') IS NOT NULL THEN lower(v_t->>'politician_id') END;
  v_poid := CASE WHEN uuid_or_null(v_t->>'policy_id') IS NOT NULL THEN lower(v_t->>'policy_id') END;
  IF p_type IN ('policy_missing', 'term_policy_missing') AND v_pid IS NOT NULL THEN
    RETURN 'politician:' || v_pid || ':policies:' || COALESCE(election_id_or_null(v_t->>'election_id')::TEXT, campaign_election_id()::TEXT);
  ELSIF p_type IN ('profile_gap', 'profile_detail_gap') AND v_pid IS NOT NULL THEN
    RETURN 'politician:' || v_pid || ':profile';
  ELSIF p_type IN ('policy_elements_missing', 'progress_stale', 'deadline_due', 'policy_validity', 'policy_election_missing',
                   'policy_election_mismatch', 'policy_source_missing', 'legacy_audit') AND v_poid IS NOT NULL THEN
    RETURN 'policy:' || v_poid || ':' || p_type;
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION task_work_key_for_manual IS '手動任務（或還沒建立的請求）的工作卡鍵：task_work_key 的 uuid 分支抽出來的純函式，輸出逐案不變；不是卡的形狀回 NULL。2026-11-12';

-- ------------------------------------------------------------
-- 2. task_work_key：uuid 分支改呼叫上面那支（其餘一字不改）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_work_key(p_task_id TEXT, p_target JSONB) RETURNS TEXT
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_seg    TEXT[];
  v_n      INTEGER;
  v_arm    TEXT;
  v_u      UUID;
  v_parent TEXT;
  v_t      JSONB;
  v_type   TEXT;
  v_i      INTEGER;
  v_chunk  TEXT;
BEGIN
  IF p_task_id IS NULL OR p_task_id = '' THEN RETURN NULL; END IF;

  -- 驗證票：母任務的工作卡
  IF p_task_id LIKE 'verify:%' THEN
    v_u := uuid_or_null(substr(p_task_id, 8));
    IF v_u IS NULL THEN RETURN NULL; END IF;
    SELECT COALESCE(c.task_id, c.payload->>'task_id') INTO v_parent FROM contributions c WHERE c.id = v_u;
    IF v_parent IS NULL OR v_parent = '' OR v_parent LIKE 'verify:%' THEN RETURN NULL; END IF;
    RETURN task_work_key(v_parent, NULL);
  END IF;

  -- uuid 手動任務：從 contribution_tasks 取 target 與 task_type，交給 task_work_key_for_manual 組鍵（同一份定義，還沒有 uuid 的請求也能先算）
  v_u := uuid_or_null(p_task_id);
  IF v_u IS NOT NULL THEN
    SELECT t.task_type, t.target INTO v_type, v_t FROM contribution_tasks t WHERE t.id = v_u;
    IF NOT FOUND THEN RETURN 'task:' || p_task_id; END IF;
    RETURN COALESCE(task_work_key_for_manual(v_type, v_t), 'task:' || p_task_id);
  END IF;

  IF p_task_id NOT LIKE 'auto:%' THEN RETURN p_task_id; END IF;

  v_seg := string_to_array(p_task_id, ':');
  v_n   := array_length(v_seg, 1);
  v_arm := v_seg[2];

  -- 政見缺口：人 × 屆
  IF v_arm = 'policy_missing' AND v_n = 3 AND uuid_or_null(v_seg[3]) IS NOT NULL THEN
    RETURN 'politician:' || lower(v_seg[3]) || ':policies:' || campaign_election_id();
  ELSIF v_arm = 'term_policy_missing' AND v_n = 4 AND uuid_or_null(v_seg[3]) IS NOT NULL THEN
    RETURN 'politician:' || lower(v_seg[3]) || ':policies:' || v_seg[4];
  END IF;

  -- 基本資料
  IF v_arm IN ('profile_gap', 'profile_detail_gap') THEN
    IF v_n = 3 AND uuid_or_null(v_seg[3]) IS NOT NULL THEN
      RETURN 'politician:' || lower(v_seg[3]) || ':profile';
    ELSIF v_n = 4 AND v_seg[3] = 'sources' AND uuid_or_null(v_seg[4]) IS NOT NULL THEN
      RETURN 'politician:' || lower(v_seg[4]) || ':profile';
    END IF;
  END IF;

  -- 一條政見的臂
  IF v_arm IN ('policy_elements_missing', 'progress_stale', 'deadline_due', 'policy_validity', 'policy_election_missing',
               'policy_election_mismatch', 'policy_source_missing', 'legacy_audit') THEN
    IF v_n = 3 AND uuid_or_null(v_seg[3]) IS NOT NULL THEN
      RETURN 'policy:' || lower(v_seg[3]) || ':' || v_arm;
    ELSIF v_n = 4 AND v_arm = 'policy_validity' AND uuid_or_null(v_seg[4]) IS NOT NULL THEN
      RETURN 'policy:' || lower(v_seg[4]) || ':' || v_arm;   -- 舊形 <pe_id>:<policy_id>
    END IF;
  END IF;

  -- 帶內容指紋的臂：去掉末段指紋
  IF v_arm = ANY (task_work_key_fp_arms()) AND p_task_id ~ '^auto:[a-z_]+:[^:]+:[0-9a-f]{8,32}$' THEN
    RETURN regexp_replace(p_task_id, ':[0-9a-f]{8,32}$', '');
  END IF;

  -- 脈絡現況：末段是截至日，不是內容
  IF v_arm = 'lineage_status_stale' AND v_n = 4 THEN
    RETURN 'auto:lineage_status_stale:' || v_seg[3];
  END IF;

  -- 單位型
  IF v_arm = 'candidacy_source_missing' AND v_seg[3] IN ('cand_no', 'cand_no_recheck') AND v_n >= 6 THEN
    v_i := v_n; v_chunk := '';
    IF v_seg[v_n] ~ '^p[0-9]+$' THEN v_chunk := ':' || v_seg[v_n]; v_i := v_n - 1; END IF;
    IF v_i >= 6 THEN
      RETURN 'unit:' || v_seg[4] || ':' || v_seg[5] || ':' || array_to_string(v_seg[6:v_i], ':') || ':' || v_seg[3] || v_chunk;
    END IF;
  ELSIF v_arm = 'election_results_missing' AND v_n >= 5 AND v_seg[3] ~ '^[0-9]+$' THEN
    v_i := v_n; v_chunk := '';
    IF v_seg[v_n] ~ '^p[0-9]+$' THEN v_chunk := ':' || v_seg[v_n]; v_i := v_n - 1; END IF;
    IF v_i >= 5 THEN
      RETURN 'unit:' || v_seg[3] || ':' || v_seg[4] || ':' || array_to_string(v_seg[5:v_i], ':') || ':election_results' || v_chunk;
    END IF;
  ELSIF v_arm = 'roster_check' AND v_n = 5 AND v_seg[3] ~ '^[0-9]+$' THEN
    RETURN 'unit:' || v_seg[3] || ':' || v_seg[5] || ':' || v_seg[4] || ':roster_check';
  ELSIF v_arm = 'district_seats_missing' AND v_n = 5 AND v_seg[3] ~ '^[0-9]+$' THEN
    RETURN 'unit:' || v_seg[3] || ':' || v_seg[5] || ':' || v_seg[4] || ':district_seats';
  END IF;

  RETURN p_task_id;   -- 其他 auto:：原樣
END;
$$;
COMMENT ON FUNCTION task_work_key IS
  '工作卡鍵（2026-11-11，docs/PLAN-dispatch-work-unit.md 0.1）：同一人×同一件事同一個鍵。完整對應表見 migration 20261111100000 檔頭；'
  'policy_missing 與 term_policy_missing 同人同屆同鍵、帶指紋的臂去掉末段指紋、uuid 手動任務查 contribution_tasks 後交 task_work_key_for_manual（20261112120000 抽出）、'
  'verify:<id> 取母任務的鍵（找不到 NULL）。STABLE（讀 campaign_election_id、contribution_tasks、contributions）';

-- ------------------------------------------------------------
-- 3. 這張卡現在尚開著的任務
-- ------------------------------------------------------------
-- 優先回已在隊的（task_dispatches 非驗證列：自動缺口與已入列的手動任務），其次是還沒入列（seed 約 10 分鐘一輪）的 open 手動任務。找不到回 NULL
CREATE OR REPLACE FUNCTION work_card_resolve(p_work_key TEXT, p_scope TEXT DEFAULT NULL) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  WITH gate AS (   -- 只併到「還會被派」的卡：查核階梯已結案（查無第 4 次）的卡不併
    SELECT NOT COALESCE((SELECT st.closed FROM work_key_ladder_state(p_work_key) st), FALSE) AS ok
  ), cand AS (
    SELECT d.task_id, 0 AS rk
      FROM task_dispatches d
     WHERE p_work_key IS NOT NULL AND d.work_key = p_work_key AND d.task_id NOT LIKE 'verify:%' AND NOT d.blocked
    UNION ALL
    SELECT t.id::TEXT, 1
      FROM contribution_tasks t
     WHERE p_work_key IS NOT NULL AND t.status = 'open'
       AND ((split_part(p_work_key, ':', 1) = 'politician' AND t.target->>'politician_id' = split_part(p_work_key, ':', 2))
         OR (split_part(p_work_key, ':', 1) = 'policy' AND t.target->>'policy_id' = split_part(p_work_key, ':', 2)))
       AND task_work_key_for_manual(t.task_type, t.target) = p_work_key
       AND NOT EXISTS (SELECT 1 FROM task_dispatches d2 WHERE d2.task_id = t.id::TEXT AND d2.blocked)
  )
  SELECT c.task_id
    FROM cand c, gate
   WHERE gate.ok AND (p_scope IS NULL
      OR (CASE WHEN c.task_id LIKE 'auto:%' THEN p_scope = 'pledge'
               ELSE EXISTS (SELECT 1 FROM contribution_tasks t WHERE t.id::TEXT = c.task_id AND t.target->>'scope' = p_scope) END))
   ORDER BY c.rk, c.task_id
   LIMIT 1
$$;
COMMENT ON FUNCTION work_card_resolve IS '這張工作卡現在還會被派的任務（排除 blocked 的列與階梯已結案的卡；task_dispatches 非驗證列優先，其次未入列的 open 手動任務）；p_scope 給了（pledge／tenure）時，自動缺口只在 pledge 算、手動任務要 target.scope 相同。沒有回 NULL。2026-11-12';

-- 併卡時帶來的說明與來源（維護者指定、代理提議的標題／說明不因併卡而丟掉）。不算需求（不進 work_card_signals）、私有表
CREATE TABLE IF NOT EXISTS work_card_notes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_key    TEXT NOT NULL CHECK (work_key <> ''),
  source      TEXT NOT NULL,
  actor       TEXT,
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_card_notes_key_idx ON work_card_notes (work_key, created_at);
COMMENT ON TABLE work_card_notes IS '工作卡併卡備註（20261112120000）：維護者指定、代理提議併進既有卡時帶來的標題／說明／來源，給接手的人看。私有表：RLS 開、只有 service_role。2026-11-12';
ALTER TABLE work_card_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "work_card_notes service write" ON work_card_notes;
CREATE POLICY "work_card_notes service write" ON work_card_notes FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON work_card_notes FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 4. 併卡：寫訊號、必要時插隊
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION work_card_attach(p_work_key TEXT, p_kind TEXT, p_actor TEXT, p_boost BOOLEAN DEFAULT FALSE, p_scope TEXT DEFAULT NULL,
                                     p_note TEXT DEFAULT NULL, p_source TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_task  TEXT;
  v_added BOOLEAN := FALSE;
  v_boosted INTEGER := 0;
  v_cool  TIMESTAMPTZ;
  v_last  TIMESTAMPTZ;
BEGIN
  IF COALESCE(p_work_key, '') = '' OR p_work_key LIKE 'task:%' THEN
    RETURN jsonb_build_object('attached', FALSE, 'work_key', p_work_key);
  END IF;
  v_task := work_card_resolve(p_work_key, p_scope);
  IF v_task IS NULL THEN
    RETURN jsonb_build_object('attached', FALSE, 'work_key', p_work_key);
  END IF;
  IF p_kind IS NOT NULL THEN
    v_added := work_card_signal_add(p_work_key, p_kind, p_actor);
  END IF;
  IF COALESCE(p_note, '') <> '' THEN
    INSERT INTO work_card_notes (work_key, source, actor, note) VALUES (p_work_key, COALESCE(p_source, 'unknown'), NULLIF(p_actor, ''), left(p_note, 2000));
  END IF;
  -- 卡在查核冷卻中：訊號照寫（冷卻結束後 ① 的需求疊加會把它帶回前面，不用插隊），回報給呼叫端當「近期查過」
  SELECT st.check_cool_until, st.last_checked_at INTO v_cool, v_last FROM work_key_ladder_state(p_work_key) st;
  IF v_cool IS NOT NULL AND v_cool > now() THEN
    RETURN jsonb_build_object('attached', TRUE, 'task_id', v_task, 'work_key', p_work_key, 'signal_added', v_added, 'boosted', 0,
                              'cooling', TRUE, 'cool_until', v_cool, 'last_checked_at', v_last);
  END IF;
  -- 插隊：只在這次真的新增（或續期）了訊號時，同 #912 的待遇：GREATEST（不疊加）、查核冷卻中不插
  IF p_boost AND v_added THEN
    UPDATE task_dispatches d
       SET boost_seconds = GREATEST(d.boost_seconds, (SELECT q.visitor_front_seconds FROM queue_settings q WHERE q.id = 1))
     WHERE d.work_key = p_work_key AND d.task_id NOT LIKE 'verify:%'
       AND (d.cool_until IS NULL OR d.cool_until <= now())
       AND NOT task_in_check_cooldown(d.task_id)
       AND d.boost_seconds < (SELECT q.visitor_front_seconds FROM queue_settings q WHERE q.id = 1);
    GET DIAGNOSTICS v_boosted = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('attached', TRUE, 'task_id', v_task, 'work_key', p_work_key, 'signal_added', v_added, 'boosted', v_boosted, 'cooling', FALSE);
END;
$$;
COMMENT ON FUNCTION work_card_attach IS '併卡：這張卡有尚開著的任務就寫一筆需求訊號（p_kind 為 NULL＝只查不寫）、p_boost 時對這次新增的訊號插隊一次（GREATEST visitor_front_seconds，冷卻中不插），p_note 存進 work_card_notes（不算需求）；卡在查核冷卻中仍寫訊號但不插隊、回 cooling:true（＋last_checked_at）；回 {attached,task_id,work_key,signal_added,boosted,cooling}；沒有卡回 attached:false，呼叫端照舊新開。2026-11-12';

-- ------------------------------------------------------------
-- 5. 頁面訪問訊號
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION work_card_view_signals_sync() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cap INTEGER;
  v_ttl INTEGER;
  v_n   INTEGER;
BEGIN
  SELECT q.demand_view_unit * (CEIL(q.demand_cap_seconds::NUMERIC / GREATEST(q.demand_unit_seconds, 1))::INTEGER + 1), q.demand_signal_days
    INTO v_cap, v_ttl FROM queue_settings q WHERE q.id = 1;
  INSERT INTO work_card_signals (work_key, kind, actor)
  SELECT k.work_key, 'view', 'ga:' || g.n
    FROM page_traffic_hot h
    CROSS JOIN LATERAL (SELECT DISTINCT d.work_key FROM task_dispatches d
                         WHERE d.work_key IS NOT NULL AND d.task_id NOT LIKE 'verify:%'
                           AND split_part(d.work_key, ':', 1) = h.kind AND split_part(d.work_key, ':', 2) = h.target_id) k
    CROSS JOIN LATERAL generate_series(1, LEAST(h.users, v_cap)) AS g(n)
   WHERE NOT EXISTS (SELECT 1 FROM page_traffic_boosts b WHERE b.kind = h.kind AND b.target_id = h.target_id AND b.paused_until > now())
  ON CONFLICT (work_key, kind, actor) DO UPDATE SET created_at = now()
   WHERE work_card_signals.created_at <= now() - make_interval(days => v_ttl);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION work_card_view_signals_sync IS '頁面訪問訊號：每個達標頁（page_traffic_hot；被流量提層暫停的不算）名下派工隊列上現有的卡，補 min(不重複訪客數, 上限) 筆 view 訊號（actor＝ga:<序號>，冪等、過期續期）。上限＝每單位人數 × (需求上限 ÷ 每單位秒數 ＋ 1)。console-fetch 每小時在 replace_page_traffic 之後呼叫。2026-11-12';

REVOKE ALL ON FUNCTION task_work_key_for_manual(TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_resolve(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_attach(TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION work_card_view_signals_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION task_work_key_for_manual(TEXT, JSONB), work_card_resolve(TEXT, TEXT), work_card_attach(TEXT, TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT),
  work_card_view_signals_sync() TO service_role;
