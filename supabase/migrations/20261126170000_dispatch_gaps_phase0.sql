-- 派工臂事件驅動化 第 0 期 PR-1：常駐缺口表、事件入列、工人骨架、對帳與雙軌比對（只建不派）
--
-- 設計文件：docs/dispatch-arms-event-driven-plan.md（第 2、5 節與附錄 A）。
--
-- 這一支只蓋地基，現行派工行為一個字不改：
--   · 不碰 seed_auto_task_queue()、contribution_auto_tasks_arms() 與任何臂函式（守門 dispatch-gaps-phase0.test.ts 比對）。
--   · 不掛任何觸發器到正式表（觸發器函式 dispatch_gap_on_change() 只建本體，掛法留給第 1 期）。
--   · 不排 pg_cron（drain、reconcile、shadow_compare 都只是函式，等雙軌數據出來才排）。
--   · 沒有任何現行程式讀這些新物件，所以上線等於多放幾張空表與幾支沒人呼叫的函式。
--
-- 與設計文件附錄 A 的差異（刻意的，第 1 期再決定要不要收斂）：
--   · 附錄的待重算清單 dispatch_gap_dirty，這裡叫 dispatch_gap_events（擁有者交辦的命名），欄位多了 kind、processed_at（處理完留著當事件歷史，
--     不刪）；「同一單位未處理只留一筆」由部分唯一索引做到，等價於附錄的 PRIMARY KEY (arm, scope_key)。
--   · 附錄的 dispatch_gap_arms（含 mode off／shadow／live）本期不建：沒有任何東西讀模式。本期只建登記表 dispatch_gap_arm_keys（臂函式名、缺口鍵規則），
--     模式欄位與 gap_arm_mode() 留給第 1 期的總表二段式一起做。
--   · gap_reconcile_log 叫 dispatch_gap_reconcile_runs，多 mode（reconcile／shadow）、changed、applied、error 欄。
--   · 按鍵重算函式（xxx(p_keys)）本期沒有：drain 對沒有 recompute_fn 的臂走「保底實作」＝把整支臂函式跑一次，只取落在這批鍵上的缺口，再 diff 進常駐表。
--     第 1 期逐臂補 recompute_fn 後，drain 自動改走按鍵版（登記表改一欄就生效）。
--
-- 缺口鍵規則（gap_key＝臂輸出的 task_id；scope_key＝重算單位）：
--   legacy           task_id auto:legacy_audit:<政見 id>                       → scope_key policy:<政見 id>
--   mismatch         task_id auto:policy_election_mismatch:<政見 id>           → scope_key policy:<政見 id>
--   issue_too_broad  task_id auto:issue_too_broad:<選舉 id>:<縣市>:<議題>      → scope_key issue:<選舉 id>:<縣市>:<議題>（task_id 去掉前綴）
--   其他臂（第 2、3 期才接）一律 scope_key＝task_id。
--   scope_key＝'*' 是特殊值：整臂重算（設定表變動、或無法反推單位時用）。
--   規則實作在 dispatch_gap_scope_key()；對照說明存在 dispatch_gap_arm_keys.key_expr_desc。
--
-- 回滾（一支遷移就夠，沒有任何東西依賴這些物件）：
--   DROP FUNCTION dispatch_gap_shadow_compare(TEXT[], INTERVAL), dispatch_gap_reconcile_all(TEXT[]), dispatch_gap_reconcile_arm(TEXT, BOOLEAN, TEXT, INTERVAL),
--     dispatch_gap_diff_loaded(TEXT, INTERVAL), dispatch_gap_drain(INTEGER), dispatch_gap_sync(TEXT, TEXT[], TEXT), dispatch_gap_apply_fresh(TEXT, TEXT[], TEXT),
--     dispatch_gap_load_fresh(TEXT, TEXT[]), dispatch_gap_on_change(), dispatch_gap_enqueue(TEXT, TEXT, TEXT), dispatch_gap_events_enabled(),
--     dispatch_gap_scope_key(TEXT, TEXT);
--   DROP TABLE dispatch_gap_reconcile_runs, dispatch_gap_events, dispatch_gaps, dispatch_gap_arm_keys, dispatch_gap_settings;
--
-- 風險：無（見上）。上線後可手動 SELECT dispatch_gap_shadow_compare() 看一次雙軌差異（只寫 reconcile_runs 一批列，不改任何其他表），
--   但它會把每支登記臂的整表函式各跑一次（約 14 秒，三支合計），不要在 seed 剛開始的整十分鐘前後手動跑。

-- ------------------------------------------------------------
-- 1. 表
-- ------------------------------------------------------------

-- 常駐缺口：一列＝一個缺口在「臂函式輸出」那一層的樣子（還沒套規則窗口）
CREATE TABLE IF NOT EXISTS dispatch_gaps (
  arm            TEXT        NOT NULL,
  gap_key        TEXT        NOT NULL,                       -- 就是 task_id
  scope_key      TEXT        NOT NULL,                       -- 重算單位
  payload        JSONB       NOT NULL,                       -- 臂函式輸出去掉 task_id：task_type、target、what_we_need、hint_sources、reward、region
  eid            INTEGER,                                    -- 第 1 期起寫入時順手算好的選舉、職位、涉及人物；本期不填
  etype          TEXT,
  person_ids     UUID[]      NOT NULL DEFAULT '{}',
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  closed_reason  TEXT        CHECK (closed_reason IN ('filled', 'reconcile', 'superseded')),
  source_version BIGINT      NOT NULL DEFAULT 1,
  recomputed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (arm, gap_key),
  CHECK ((closed_at IS NULL) = (closed_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS dispatch_gaps_open_scope_idx ON dispatch_gaps (arm, scope_key) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS dispatch_gaps_people_idx ON dispatch_gaps USING gin (person_ids) WHERE closed_at IS NULL;
ALTER TABLE dispatch_gaps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_gaps FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE dispatch_gaps IS '派工臂常駐缺口（20261126170000，第 0 期只建不派）。(arm, gap_key) 一列；closed_at 空＝開著。第 1 期起 seed 才讀。';

-- 事件佇列：觸發器只往這裡丟一列，不重算
CREATE TABLE IF NOT EXISTS dispatch_gap_events (
  id           BIGSERIAL   PRIMARY KEY,
  arm          TEXT        NOT NULL,
  scope_key    TEXT        NOT NULL,                         -- 重算單位；'*'＝整臂
  kind         TEXT        NOT NULL CHECK (btrim(kind) <> ''),   -- insert／update／delete／config／manual…（只記錄，不影響處理）
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  attempts     INTEGER     NOT NULL DEFAULT 0,
  last_error   TEXT
);
-- 同 arm＋單位未處理的只留一列（事件風暴自然壓平）
CREATE UNIQUE INDEX IF NOT EXISTS dispatch_gap_events_pending_uidx ON dispatch_gap_events (arm, scope_key) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS dispatch_gap_events_pending_idx ON dispatch_gap_events (enqueued_at, id) WHERE processed_at IS NULL;
ALTER TABLE dispatch_gap_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_gap_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE dispatch_gap_events_id_seq FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE dispatch_gap_events IS '派工缺口事件佇列（20261126170000）。processed_at 空＝待消化；失敗 attempts＋1 並留錯誤，超過 5 次不再自動取（等巡檢）。處理完的列保留當歷史，清理排程另案。';

-- 每次對帳／雙軌比對的結果
CREATE TABLE IF NOT EXISTS dispatch_gap_reconcile_runs (
  id          BIGSERIAL   PRIMARY KEY,
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  arm         TEXT        NOT NULL,
  mode        TEXT        NOT NULL CHECK (mode IN ('reconcile', 'shadow')),
  live_count  INTEGER,                                       -- 現行臂函式算出幾個缺口
  table_count INTEGER,                                       -- 常駐表開著幾個
  missing     INTEGER,                                       -- 臂函式有、常駐表沒有（漏開）
  extra       INTEGER,                                       -- 常駐表有、臂函式沒有（漏關）
  changed     INTEGER,                                       -- 兩邊都有但內容不同（漏更新）
  applied     BOOLEAN     NOT NULL DEFAULT false,            -- reconcile 才會 true：已依整表結果補開、補關、補更新
  duration_ms INTEGER,
  error       TEXT                                           -- 這一臂算失敗時的訊息（其餘欄位為空）
);
CREATE INDEX IF NOT EXISTS dispatch_gap_reconcile_runs_run_at_idx ON dispatch_gap_reconcile_runs (run_at);
ALTER TABLE dispatch_gap_reconcile_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_gap_reconcile_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE dispatch_gap_reconcile_runs_id_seq FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE dispatch_gap_reconcile_runs IS '派工缺口對帳／雙軌比對結果（20261126170000）。missing／extra／changed 長期應為 0。';

-- 臂登記與缺口鍵對照
CREATE TABLE IF NOT EXISTS dispatch_gap_arm_keys (
  arm           TEXT PRIMARY KEY,
  full_fn       TEXT NOT NULL,                               -- 整表函式，例：contribution_auto_tasks_legacy()（對帳、shadow、保底重算用）
  recompute_fn  TEXT,                                        -- 按鍵版，例：contribution_auto_tasks_legacy(text[])；空＝走保底實作
  key_expr_desc TEXT NOT NULL,                               -- scope_key／gap_key 怎麼組（人看的說明，實作在 dispatch_gap_scope_key）
  key_example   TEXT
);
ALTER TABLE dispatch_gap_arm_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_gap_arm_keys FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE dispatch_gap_arm_keys IS '派工臂登記與缺口鍵規則（20261126170000）。第 1 期三支臂（legacy、mismatch、issue_too_broad）先登記；新增臂要在這裡登記才會被 drain／對帳處理。';

INSERT INTO dispatch_gap_arm_keys (arm, full_fn, recompute_fn, key_expr_desc, key_example) VALUES
  ('legacy', 'contribution_auto_tasks_legacy()', NULL,
   'gap_key＝task_id（auto:legacy_audit:<政見 id>）；scope_key＝policy:<政見 id>。事件來源：policies、source_refs、edit_history（audit／*）。',
   'auto:legacy_audit:6f1c… → policy:6f1c…'),
  ('mismatch', 'contribution_auto_tasks_mismatch()', NULL,
   'gap_key＝task_id（auto:policy_election_mismatch:<政見 id>）；scope_key＝policy:<政見 id>。事件來源：policies、jev_decisions（政見×屆別題）。',
   'auto:policy_election_mismatch:6f1c… → policy:6f1c…'),
  ('issue_too_broad', 'contribution_auto_tasks_issue_too_broad()', NULL,
   'gap_key＝task_id（auto:issue_too_broad:<選舉 id>:<縣市>:<議題>）；scope_key＝issue:<選舉 id>:<縣市>:<議題>（task_id 去掉前綴）。政見變動反推不出縣市與議題，事件一律入 scope_key=''*''（整臂重算）。',
   'auto:issue_too_broad:2026:臺北市:交通 → issue:2026:臺北市:交通')
ON CONFLICT (arm) DO NOTHING;

-- 單列設定：緊急開關（關掉時入列函式直接返回，不需要 DDL）
CREATE TABLE IF NOT EXISTS dispatch_gap_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  events_enabled BOOLEAN NOT NULL DEFAULT true,
  max_attempts   INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1)
);
INSERT INTO dispatch_gap_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE dispatch_gap_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE dispatch_gap_settings FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. 鍵與入列
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION dispatch_gap_events_enabled() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT events_enabled FROM dispatch_gap_settings WHERE id = 1), true)
$$;

-- gap_key（task_id）→ 重算單位 scope_key
CREATE OR REPLACE FUNCTION dispatch_gap_scope_key(p_arm TEXT, p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_arm
    WHEN 'legacy'          THEN 'policy:' || regexp_replace(p_task_id, '^.*:', '')
    WHEN 'mismatch'        THEN 'policy:' || regexp_replace(p_task_id, '^.*:', '')
    WHEN 'issue_too_broad' THEN 'issue:' || regexp_replace(p_task_id, '^auto:issue_too_broad:', '')
    ELSE p_task_id
  END
$$;

-- 入列：只 INSERT 一列事件；同 arm＋單位已有未處理的就不重複。回傳這次是否真的新增。不重算、不查大表
CREATE OR REPLACE FUNCTION dispatch_gap_enqueue(p_arm TEXT, p_key TEXT, p_kind TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF NOT dispatch_gap_events_enabled() THEN
    RETURN false;
  END IF;
  INSERT INTO dispatch_gap_events (arm, scope_key, kind)
  VALUES (p_arm, p_key, p_kind)
  ON CONFLICT (arm, scope_key) WHERE processed_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;

-- 觸發器函式本體（本期不掛到任何正式表；PGlite 測試掛在同名測試表驗證）。
-- 只判斷「這次改的會不會影響缺口」並算出受影響的 (arm, scope_key) 入列，不呼叫臂函式、不查大表。
-- 第 1 期三支臂已涵蓋的來源：policies、jev_decisions、edit_history、source_refs，加設定表（整臂 '*'）。
-- 尚未涵蓋（第 1 期掛觸發器前要補）：politician_elections／politicians／contributions／tracking_logs 對 mismatch、legacy 的影響（附錄 A.1），
--   目前這幾張表掛上本函式會得到 WARNING 並略過，不會擋寫入。
CREATE OR REPLACE FUNCTION dispatch_gap_on_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_new     JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_old     JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_row     JSONB;
  v_kind    TEXT := lower(TG_OP);
  v_cols    TEXT[];
  v_changed BOOLEAN;
  v_arm     TEXT;
BEGIN
  IF NOT dispatch_gap_events_enabled() THEN
    RETURN NULL;
  END IF;
  v_row := COALESCE(v_new, v_old);

  IF TG_TABLE_NAME = 'policies' THEN
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['title', 'description', 'category', 'status', 'proposed_date', 'last_updated', 'progress',
                      'election_id', 'politician_id', 'removed_at', 'lineage_id'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_changed;
      IF NOT v_changed THEN
        RETURN NULL;
      END IF;
    END IF;
    PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'id'), v_kind);
    PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || (v_row ->> 'id'), v_kind);
    PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);   -- 反推不出（縣市，議題），整臂重算；同一時段只會留一筆

  ELSIF TG_TABLE_NAME = 'jev_decisions' THEN
    IF TG_OP = 'INSERT' AND v_row ->> 'subject_type' = 'policy' AND v_row ->> 'question' = 'election' THEN
      PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || (v_row ->> 'subject_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'edit_history' THEN
    IF TG_OP = 'INSERT' AND v_row ->> 'table_name' = 'policies' AND v_row ->> 'field' IN ('audit', '*') THEN
      PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'record_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'source_refs' THEN
    IF TG_OP IN ('INSERT', 'DELETE') AND v_row ->> 'target_table' = 'policies' THEN
      PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'target_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME IN ('elections', 'election_milestones', 'activity_rules', 'activity_overrides', 'election_task_config',
                          'traffic_watch_levels', 'lineage_settings') THEN
    -- 規則與設定變動：登記的每一支臂都整臂重算
    FOR v_arm IN SELECT arm FROM dispatch_gap_arm_keys ORDER BY arm LOOP
      PERFORM dispatch_gap_enqueue(v_arm, '*', 'config');
    END LOOP;

  ELSE
    RAISE WARNING 'dispatch_gap_on_change：不認得的來源表 %，略過', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------
-- 3. 重算與 diff
-- ------------------------------------------------------------

-- 把某臂（或其中幾個單位）現在的缺口算出來，放進暫存表 _dg_fresh（交易結束自動消失）。
-- p_keys 為 NULL 或含 '*'＝整臂；有 recompute_fn 且給了鍵 → 走按鍵版；否則整支臂函式跑一次，只留落在這批鍵上的缺口（保底實作）。
CREATE OR REPLACE FUNCTION dispatch_gap_load_fresh(p_arm TEXT, p_keys TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_reg   dispatch_gap_arm_keys;
  v_whole BOOLEAN := (p_keys IS NULL OR '*' = ANY (p_keys));
  v_fn    TEXT;
  v_n     INTEGER;
BEGIN
  SELECT * INTO v_reg FROM dispatch_gap_arm_keys WHERE arm = p_arm;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_gap：臂 % 沒有登記在 dispatch_gap_arm_keys', p_arm;
  END IF;

  DROP TABLE IF EXISTS _dg_fresh;
  CREATE TEMP TABLE _dg_fresh (
    gap_key   TEXT  PRIMARY KEY,
    scope_key TEXT  NOT NULL,
    payload   JSONB NOT NULL
  ) ON COMMIT DROP;

  IF NOT v_whole AND v_reg.recompute_fn IS NOT NULL THEN
    v_fn := to_regprocedure(v_reg.recompute_fn)::regproc::TEXT;
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'dispatch_gap：臂 % 的按鍵函式 % 不存在', p_arm, v_reg.recompute_fn;
    END IF;
    EXECUTE format(
      'INSERT INTO _dg_fresh SELECT DISTINCT ON (t.task_id) t.task_id, dispatch_gap_scope_key(%L, t.task_id), to_jsonb(t) - ''task_id'' - ''arm'' - ''opened_by'' FROM %s($1) t ORDER BY t.task_id',
      p_arm, v_fn) USING p_keys;
  ELSE
    v_fn := to_regprocedure(v_reg.full_fn)::regproc::TEXT;
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'dispatch_gap：臂 % 的整表函式 % 不存在', p_arm, v_reg.full_fn;
    END IF;
    IF v_whole THEN
      EXECUTE format(
        'INSERT INTO _dg_fresh SELECT DISTINCT ON (t.task_id) t.task_id, dispatch_gap_scope_key(%L, t.task_id), to_jsonb(t) - ''task_id'' - ''arm'' - ''opened_by'' FROM %s() t ORDER BY t.task_id',
        p_arm, v_fn);
    ELSE
      EXECUTE format(
        'INSERT INTO _dg_fresh SELECT DISTINCT ON (t.task_id) t.task_id, dispatch_gap_scope_key(%L, t.task_id), to_jsonb(t) - ''task_id'' - ''arm'' - ''opened_by'' FROM %s() t WHERE dispatch_gap_scope_key(%L, t.task_id) = ANY ($1) ORDER BY t.task_id',
        p_arm, v_fn, p_arm) USING p_keys;
    END IF;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- 把 _dg_fresh 套進常駐表：沒了的關（closed_reason＝p_close_reason）、新的開、內容變了的更新（內容沒變不寫）。
-- p_keys 為 NULL 或含 '*'＝整臂；否則只動 scope_key 在 p_keys 裡的缺口。
CREATE OR REPLACE FUNCTION dispatch_gap_apply_fresh(p_arm TEXT, p_keys TEXT[], p_close_reason TEXT)
RETURNS TABLE (n_opened INTEGER, n_updated INTEGER, n_closed INTEGER)
LANGUAGE plpgsql AS $$
DECLARE
  v_whole BOOLEAN := (p_keys IS NULL OR '*' = ANY (p_keys));
BEGIN
  UPDATE dispatch_gaps g
     SET closed_at = now(), closed_reason = p_close_reason,
         source_version = g.source_version + 1, recomputed_at = now()
   WHERE g.arm = p_arm AND g.closed_at IS NULL
     AND (v_whole OR g.scope_key = ANY (p_keys))
     AND NOT EXISTS (SELECT 1 FROM _dg_fresh f WHERE f.gap_key = g.gap_key);
  GET DIAGNOSTICS n_closed = ROW_COUNT;

  WITH up AS (
    INSERT INTO dispatch_gaps (arm, gap_key, scope_key, payload)
    SELECT p_arm, f.gap_key, f.scope_key, f.payload FROM _dg_fresh f
    ON CONFLICT (arm, gap_key) DO UPDATE
       SET payload        = EXCLUDED.payload,
           scope_key      = EXCLUDED.scope_key,
           opened_at      = CASE WHEN dispatch_gaps.closed_at IS NULL THEN dispatch_gaps.opened_at ELSE now() END,
           closed_at      = NULL,
           closed_reason  = NULL,
           recomputed_at  = now(),
           source_version = dispatch_gaps.source_version + 1
     WHERE (dispatch_gaps.payload, dispatch_gaps.scope_key, dispatch_gaps.closed_at)
           IS DISTINCT FROM (EXCLUDED.payload, EXCLUDED.scope_key, NULL::TIMESTAMPTZ)
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted)::INTEGER, count(*) FILTER (WHERE NOT inserted)::INTEGER
    INTO n_opened, n_updated FROM up;
  RETURN NEXT;
END;
$$;

-- 重算並套用（drain 與手動修復用）
CREATE OR REPLACE FUNCTION dispatch_gap_sync(p_arm TEXT, p_keys TEXT[], p_close_reason TEXT)
RETURNS TABLE (n_opened INTEGER, n_updated INTEGER, n_closed INTEGER)
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dispatch_gap_load_fresh(p_arm, p_keys);
  RETURN QUERY SELECT * FROM dispatch_gap_apply_fresh(p_arm, p_keys, p_close_reason);
END;
$$;

-- 比對 _dg_fresh（整臂）與常駐表開著的列，不寫任何永久表。
-- p_grace：常駐表那邊「最近這段時間內才重算過」的列不計入 extra／changed，避免剛消化完的暫態誤報（雙軌比對用 2 分鐘，對帳用 0）。
CREATE OR REPLACE FUNCTION dispatch_gap_diff_loaded(p_arm TEXT, p_grace INTERVAL DEFAULT '0 seconds')
RETURNS TABLE (live_count INTEGER, table_count INTEGER, missing INTEGER, extra INTEGER, changed INTEGER)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT
    (SELECT count(*) FROM _dg_fresh)::INTEGER,
    (SELECT count(*) FROM dispatch_gaps g WHERE g.arm = p_arm AND g.closed_at IS NULL)::INTEGER,
    (SELECT count(*) FROM _dg_fresh f
      WHERE NOT EXISTS (SELECT 1 FROM dispatch_gaps g WHERE g.arm = p_arm AND g.closed_at IS NULL AND g.gap_key = f.gap_key))::INTEGER,
    (SELECT count(*) FROM dispatch_gaps g
      WHERE g.arm = p_arm AND g.closed_at IS NULL AND g.recomputed_at <= now() - p_grace
        AND NOT EXISTS (SELECT 1 FROM _dg_fresh f WHERE f.gap_key = g.gap_key))::INTEGER,
    (SELECT count(*) FROM dispatch_gaps g JOIN _dg_fresh f ON f.gap_key = g.gap_key
      WHERE g.arm = p_arm AND g.closed_at IS NULL AND g.recomputed_at <= now() - p_grace
        AND g.payload IS DISTINCT FROM f.payload)::INTEGER;
END;
$$;

-- ------------------------------------------------------------
-- 4. 工人：drain
-- ------------------------------------------------------------

-- 消化事件：取最舊一批未處理事件（每批上限 p_limit 個鍵），依臂分組，逐臂重算並套進常駐表。
-- 回傳這次處理掉的事件數。advisory lock 防重入（拿不到＝別的工人正在跑，回 0）；
-- 單一臂失敗只回滾那一臂（子交易），事件 attempts＋1 留錯誤，其他臂照常。超過 max_attempts 的事件不再自動取。
CREATE OR REPLACE FUNCTION dispatch_gap_drain(p_limit INTEGER DEFAULT 500) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  a        RECORD;
  v_done   INTEGER := 0;
  v_max    INTEGER := COALESCE((SELECT max_attempts FROM dispatch_gap_settings WHERE id = 1), 5);
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('dispatch_gap_writer')) THEN
    RETURN 0;
  END IF;

  FOR a IN
    SELECT e.arm, array_agg(e.scope_key ORDER BY e.id) AS keys, array_agg(e.id ORDER BY e.id) AS ids
      FROM (SELECT id, arm, scope_key
              FROM dispatch_gap_events
             WHERE processed_at IS NULL AND attempts < v_max
             ORDER BY enqueued_at, id
             LIMIT p_limit
               FOR UPDATE SKIP LOCKED) e
     GROUP BY e.arm
     ORDER BY min(e.id)
  LOOP
    BEGIN
      PERFORM dispatch_gap_sync(a.arm, a.keys, 'filled');
      UPDATE dispatch_gap_events SET processed_at = now(), last_error = NULL WHERE id = ANY (a.ids);
      v_done := v_done + cardinality(a.ids);
    EXCEPTION WHEN OTHERS THEN
      UPDATE dispatch_gap_events SET attempts = attempts + 1, last_error = left(SQLERRM, 500) WHERE id = ANY (a.ids);
    END;
  END LOOP;
  RETURN v_done;
END;
$$;

-- ------------------------------------------------------------
-- 5. 對帳與雙軌比對
-- ------------------------------------------------------------

-- 單臂：整表函式算一次與常駐表 diff，結果寫 reconcile_runs 一列。
-- p_apply＝true（mode reconcile）：以整表結果為準補開、補關（closed_reason＝'reconcile'）、補更新；
-- p_apply＝false（mode shadow）：只比不改，永久表只多 reconcile_runs 一列。
CREATE OR REPLACE FUNCTION dispatch_gap_reconcile_arm(p_arm TEXT, p_apply BOOLEAN, p_mode TEXT, p_grace INTERVAL DEFAULT '0 seconds')
RETURNS dispatch_gap_reconcile_runs
LANGUAGE plpgsql AS $$
DECLARE
  v_t0   TIMESTAMPTZ := clock_timestamp();
  d      RECORD;
  v_row  dispatch_gap_reconcile_runs;
  v_did  BOOLEAN := false;
BEGIN
  PERFORM dispatch_gap_load_fresh(p_arm, NULL);
  SELECT * INTO d FROM dispatch_gap_diff_loaded(p_arm, p_grace);
  IF p_apply AND (d.missing + d.extra + d.changed) > 0 THEN
    PERFORM dispatch_gap_apply_fresh(p_arm, NULL, 'reconcile');
    v_did := true;
  END IF;
  INSERT INTO dispatch_gap_reconcile_runs (arm, mode, live_count, table_count, missing, extra, changed, applied, duration_ms)
  VALUES (p_arm, p_mode, d.live_count, d.table_count, d.missing, d.extra, d.changed, v_did,
          round(EXTRACT(EPOCH FROM (clock_timestamp() - v_t0)) * 1000)::INTEGER)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

-- 全量對帳（本期不排 cron）：登記的臂（或 p_arms 指定的）逐臂 reconcile_arm(apply)。
-- 與 drain 共用 advisory lock（兩個寫入者不同時動常駐表）；一臂失敗只回滾那一臂並寫一列 error。
CREATE OR REPLACE FUNCTION dispatch_gap_reconcile_all(p_arms TEXT[] DEFAULT NULL) RETURNS SETOF dispatch_gap_reconcile_runs
LANGUAGE plpgsql AS $$
DECLARE
  v_arm TEXT;
  v_row dispatch_gap_reconcile_runs;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('dispatch_gap_writer')) THEN
    RETURN;
  END IF;
  FOR v_arm IN SELECT arm FROM dispatch_gap_arm_keys WHERE p_arms IS NULL OR arm = ANY (p_arms) ORDER BY arm LOOP
    BEGIN
      v_row := dispatch_gap_reconcile_arm(v_arm, true, 'reconcile');
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO dispatch_gap_reconcile_runs (arm, mode, error) VALUES (v_arm, 'reconcile', left(SQLERRM, 500)) RETURNING * INTO v_row;
    END;
    RETURN NEXT v_row;
  END LOOP;
END;
$$;

-- 雙軌比對（第 1 期切換前連跑 7 天用）：登記的臂逐臂「整表函式 vs 常駐表開著的列」，每臂只寫 reconcile_runs 一列，不改任何其他永久表。
CREATE OR REPLACE FUNCTION dispatch_gap_shadow_compare(p_arms TEXT[] DEFAULT NULL, p_grace INTERVAL DEFAULT '2 minutes')
RETURNS SETOF dispatch_gap_reconcile_runs
LANGUAGE plpgsql AS $$
DECLARE
  v_arm TEXT;
  v_row dispatch_gap_reconcile_runs;
BEGIN
  FOR v_arm IN SELECT arm FROM dispatch_gap_arm_keys WHERE p_arms IS NULL OR arm = ANY (p_arms) ORDER BY arm LOOP
    BEGIN
      v_row := dispatch_gap_reconcile_arm(v_arm, false, 'shadow', p_grace);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO dispatch_gap_reconcile_runs (arm, mode, error) VALUES (v_arm, 'shadow', left(SQLERRM, 500)) RETURNING * INTO v_row;
    END;
    RETURN NEXT v_row;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION dispatch_gap_events_enabled() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_scope_key(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_enqueue(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_on_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_load_fresh(TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_apply_fresh(TEXT, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_sync(TEXT, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_diff_loaded(TEXT, INTERVAL) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_drain(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_reconcile_arm(TEXT, BOOLEAN, TEXT, INTERVAL) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_reconcile_all(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_shadow_compare(TEXT[], INTERVAL) FROM PUBLIC, anon, authenticated;
