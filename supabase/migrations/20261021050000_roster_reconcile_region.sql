-- 名冊對帳加「補地區」動作（#731，維護者 2026-10-19 裁決「官方資料比對得上由系統寫入」）
--
-- 現象：名冊對帳 category＝both（姓名＋縣市唯一對上）但我們那筆參選紀錄 region_id 是空的，名單清查不會再派（對上了）、
-- 按地區算的人數又不含他，兩邊都沒在處理。全國 2026 filed／declared 而 region_id 空的 44 筆（2026-10-21 唯讀查）。
--
-- 做法：Edge Function roster-reconcile 多一種動作 region（settings.actions 預設仍只 {new}，要另外開）：
--   * roster_reconcile_region_next(p_limit)：category＝both、我們那筆 region_id 為空、還沒記過 region log 的人；
--   * 對 regions 的找法在 TS（_shared/apply-contribution.ts 的 resolveCandidacyRegion，跟 applyCandidacy 同一套、只讀不建）；
--   * roster_reconcile_set_region(...)：只補空白（WHERE region_id IS NULL）、同一個交易記 edit_history（agent_name＝system:*、contribution_id 空）與 log；
--   * 還原：roster_reconcile_revert 同一個函式多還原這個動作（region_id 改回 NULL，僅限那一輪寫的、現值還是它寫的、之後沒被別人改過 region_id）。
--
-- log 怎麼存：roster_reconcile_log 的 reg_id 唯一，且對帳視圖 roster_reconcile_rows() 以 reg_id 直接 LEFT JOIN 它——
--   同一位登記者可能已有一筆 new／attach 的 log（建參選紀錄時 regions 沒對到，才會留下空 region_id），改成 (reg_id, action) 唯一就得重寫整支視圖函式。
--   最小改動＝另開一張 roster_reconcile_region_log（reg_id 唯一，同樣「每位登記者最多處理一次、對不到不重試」），視圖與既有 log 一個字都不動。
-- 對不到唯一一列的不寫，log 記 unresolved 與原因（reason：village_empty、no_town、village_row_missing、town_row_missing、district_row_missing、county_row_missing…）。
--
-- 引用到的既有物件（2026-10-21 唯讀查正式庫確認存在）：roster_reconcile_rows()（pe_id、category、election_type、county、sub_region、village、district、source_url、row_no）、
-- politician_elections（id、region_id、politician_id）、regions（region、sub_region、village；唯一索引 regions_unique_combo NULLS NOT DISTINCT）、
-- edit_history（table_name、record_id、field、old_value、new_value、contribution_id、agent_name、applied_at、reverted_at、reverted_by）、
-- roster_reconcile_log、roster_reconcile_settings（actions 的 CHECK 約束名 roster_reconcile_settings_actions_check）、roster_reconcile_refresh_units()。
-- migration 不寫任何人物或參選紀錄資料；不動 settings 的值（actions 預設仍 {new}）。
-- 守門：_shared/roster-reconcile-region.test.ts。

-- ▼▼ SECTION: tables ▼▼
-- settings.actions 多收 region（預設值不變，仍只 new）
ALTER TABLE roster_reconcile_settings DROP CONSTRAINT IF EXISTS roster_reconcile_settings_actions_check;
ALTER TABLE roster_reconcile_settings ADD CONSTRAINT roster_reconcile_settings_actions_check
  CHECK (actions <@ ARRAY['new', 'attach', 'region'] AND cardinality(actions) >= 1);
COMMENT ON COLUMN roster_reconcile_settings.actions IS '系統做哪幾種：new＝建新人物，attach＝掛既有人物，region＝補參選紀錄的地區（#731）；預設只放 new，漸進上線';

CREATE TABLE IF NOT EXISTS roster_reconcile_region_log (
  id                     BIGSERIAL PRIMARY KEY,
  reg_id                 BIGINT NOT NULL UNIQUE,   -- cec_registrations.id；每位登記者最多處理一次（補地區），對不到不重試
  run_id                 UUID NOT NULL,
  outcome                TEXT NOT NULL CHECK (outcome IN ('applied', 'unresolved', 'error')),
  reason                 TEXT,                     -- unresolved 的原因代碼（見 resolveCandidacyRegion）
  message                TEXT,
  level                  TEXT CHECK (level IN ('district', 'village', 'town', 'county')),   -- applied：寫進哪一層
  source_url             TEXT NOT NULL,
  row_no                 INTEGER NOT NULL,
  politician_election_id INTEGER NOT NULL,
  region_id              INTEGER,                  -- applied：寫進去的 regions.id
  agent_name             TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverted_at            TIMESTAMPTZ,
  reverted_by            TEXT
);
CREATE INDEX IF NOT EXISTS roster_reconcile_region_log_run_idx ON roster_reconcile_region_log (run_id);
COMMENT ON TABLE roster_reconcile_region_log IS '名冊對帳「補地區」處理過的登記者：寫進哪個 region_id、或對不到唯一一列的原因；可用 roster_reconcile_revert 還原（#731，2026-10-21）';
ALTER TABLE roster_reconcile_region_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_reconcile_region_log_read ON roster_reconcile_region_log;
CREATE POLICY roster_reconcile_region_log_read ON roster_reconcile_region_log FOR SELECT USING (true);
-- ▲▲ SECTION: tables ▲▲

-- ▼▼ SECTION: run ▼▼
CREATE OR REPLACE FUNCTION roster_reconcile_region_next(p_limit INTEGER DEFAULT 100)
RETURNS TABLE (reg_id BIGINT, pe_id INTEGER, politician_id UUID, election_id INTEGER, election_type TEXT, county TEXT, sub_region TEXT, village TEXT, district TEXT,
               name TEXT, source_url TEXT, row_no INTEGER)
LANGUAGE sql STABLE SET enable_nestloop = off AS $$
  SELECT r.reg_id, r.pe_id, r.politician_id, r.election_id, r.election_type, r.county, r.sub_region, r.village, r.district, r.name, r.source_url, r.row_no
    FROM roster_reconcile_rows() r
    JOIN politician_elections pe ON pe.id = r.pe_id
   WHERE r.category = 'both'
     AND r.reg_id IS NOT NULL
     AND pe.region_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM roster_reconcile_region_log l WHERE l.reg_id = r.reg_id)
   ORDER BY CASE r.election_type WHEN '縣市長' THEN 1 WHEN '縣市議員' THEN 2 WHEN '鄉鎮市長' THEN 3 WHEN '直轄市山地原住民區長' THEN 4
                                 WHEN '鄉鎮市民代表' THEN 5 WHEN '直轄市山地原住民區民代表' THEN 6 ELSE 7 END, r.reg_id
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500))
$$;
COMMENT ON FUNCTION roster_reconcile_region_next(INTEGER) IS '補地區這一輪要處理的人：category＝both、我們那筆 region_id 為空、還沒記過 region log；只授權 service_role（#731，2026-10-21）';

-- 只補空白：WHERE region_id IS NULL；寫入、edit_history、log 在同一個交易（log 唯一鍵衝突整筆回滾）。回 false＝挑出來之後這筆已經有地區，不覆蓋、記 unresolved。
CREATE OR REPLACE FUNCTION roster_reconcile_set_region(
  p_reg_id BIGINT, p_pe_id INTEGER, p_region_id INTEGER, p_run UUID, p_agent TEXT, p_source_url TEXT, p_row_no INTEGER, p_level TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF p_agent IS NULL OR p_agent NOT LIKE 'system:%' THEN
    RAISE EXCEPTION 'roster_reconcile_set_region 的 agent_name 必須是 system: 開頭，收到「%」', p_agent;
  END IF;
  UPDATE politician_elections SET region_id = p_region_id WHERE id = p_pe_id AND region_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    INSERT INTO roster_reconcile_region_log (reg_id, run_id, outcome, reason, message, source_url, row_no, politician_election_id, agent_name)
    VALUES (p_reg_id, p_run, 'unresolved', 'region_already_set', '挑出來之後這筆已經有地區（或已不存在），不覆蓋', p_source_url, p_row_no, p_pe_id, p_agent);
    RETURN false;
  END IF;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
  VALUES ('politician_elections', p_pe_id::TEXT, 'region_id', NULL, to_jsonb(p_region_id), NULL, p_agent);
  INSERT INTO roster_reconcile_region_log (reg_id, run_id, outcome, message, level, source_url, row_no, politician_election_id, region_id, agent_name)
  VALUES (p_reg_id, p_run, 'applied', '名冊對帳補地區', p_level, p_source_url, p_row_no, p_pe_id, p_region_id, p_agent);
  RETURN true;
END;
$$;
COMMENT ON FUNCTION roster_reconcile_set_region(BIGINT, INTEGER, INTEGER, UUID, TEXT, TEXT, INTEGER, TEXT) IS '補地區的寫入：只補空白、同交易記 edit_history 與 log；只授權 service_role（#731，2026-10-21）';

-- 還原（同一支函式，簽名不變）：先還原補地區（region_id 改回 NULL；現值還是那一輪寫的、之後沒有別人改過 region_id 才還原，否則 skipped），
-- 再照舊還原系統建的參選紀錄。整輪（p_run）或逐筆（p_reg_ids）。
CREATE OR REPLACE FUNCTION roster_reconcile_revert(p_run UUID DEFAULT NULL, p_reg_ids BIGINT[] DEFAULT NULL, p_by TEXT DEFAULT 'maintainer') RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l roster_reconcile_log%ROWTYPE;
  g roster_reconcile_region_log%ROWTYPE;
  v_eh BIGINT;
  v_pe INTEGER := 0; v_pol INTEGER := 0; v_skip INTEGER := 0; v_kept INTEGER := 0;
  v_reg INTEGER := 0; v_reg_skip INTEGER := 0;
BEGIN
  IF p_run IS NULL AND p_reg_ids IS NULL THEN
    RAISE EXCEPTION 'roster_reconcile_revert 要指定 p_run（一輪）或 p_reg_ids（逐筆）';
  END IF;
  FOR g IN SELECT * FROM roster_reconcile_region_log
            WHERE outcome = 'applied' AND reverted_at IS NULL AND region_id IS NOT NULL
              AND (p_run IS NULL OR run_id = p_run) AND (p_reg_ids IS NULL OR reg_id = ANY (p_reg_ids))
            ORDER BY id DESC LOOP
    SELECT max(h.id) INTO v_eh FROM edit_history h
     WHERE h.table_name = 'politician_elections' AND h.record_id = g.politician_election_id::TEXT AND h.field = 'region_id'
       AND h.agent_name = g.agent_name AND h.reverted_at IS NULL AND h.new_value = to_jsonb(g.region_id);
    IF v_eh IS NULL
       OR EXISTS (SELECT 1 FROM edit_history h
                   WHERE h.table_name = 'politician_elections' AND h.record_id = g.politician_election_id::TEXT AND h.field = 'region_id'
                     AND h.id > v_eh AND h.reverted_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM politician_elections x WHERE x.id = g.politician_election_id AND x.region_id = g.region_id) THEN
      v_reg_skip := v_reg_skip + 1;
      CONTINUE;
    END IF;
    UPDATE politician_elections SET region_id = NULL WHERE id = g.politician_election_id AND region_id = g.region_id;
    UPDATE edit_history SET reverted_at = now(), reverted_by = p_by WHERE id = v_eh;
    UPDATE roster_reconcile_region_log SET reverted_at = now(), reverted_by = p_by WHERE id = g.id;
    v_reg := v_reg + 1;
  END LOOP;
  FOR l IN SELECT * FROM roster_reconcile_log
            WHERE outcome = 'applied' AND reverted_at IS NULL AND politician_election_id IS NOT NULL
              AND (p_run IS NULL OR run_id = p_run) AND (p_reg_ids IS NULL OR reg_id = ANY (p_reg_ids))
            ORDER BY id DESC LOOP
    IF EXISTS (SELECT 1 FROM edit_history h
                WHERE h.table_name = 'politician_elections' AND h.record_id = l.politician_election_id::TEXT
                  AND h.agent_name IS DISTINCT FROM l.agent_name AND h.reverted_at IS NULL) THEN
      v_skip := v_skip + 1;
      CONTINUE;
    END IF;
    DELETE FROM source_refs WHERE target_table = 'politician_elections' AND target_id = l.politician_election_id::TEXT;
    DELETE FROM politician_elections WHERE id = l.politician_election_id;
    v_pe := v_pe + 1;
    IF l.created_politician THEN
      IF NOT EXISTS (SELECT 1 FROM politician_elections x WHERE x.politician_id = l.politician_id)
         AND NOT EXISTS (SELECT 1 FROM policies x WHERE x.politician_id = l.politician_id) THEN
        BEGIN
          DELETE FROM politicians WHERE id = l.politician_id;
          v_pol := v_pol + 1;
        EXCEPTION WHEN foreign_key_violation THEN
          v_kept := v_kept + 1;   -- 別的表已經指到這個人（例：人物頁的其他資料）：人物留著，只還原參選紀錄
        END;
      ELSE
        v_kept := v_kept + 1;
      END IF;
    END IF;
    UPDATE edit_history SET reverted_at = now(), reverted_by = p_by
     WHERE agent_name = l.agent_name AND reverted_at IS NULL
       AND ((table_name = 'politician_elections' AND record_id = l.politician_election_id::TEXT)
            OR (l.created_politician AND table_name = 'politicians' AND record_id = l.politician_id::TEXT AND NOT EXISTS (SELECT 1 FROM politicians x WHERE x.id = l.politician_id)));
    UPDATE roster_reconcile_log SET reverted_at = now(), reverted_by = p_by WHERE id = l.id;
  END LOOP;
  PERFORM roster_reconcile_refresh_units();
  RETURN jsonb_build_object('politician_elections_deleted', v_pe, 'politicians_deleted', v_pol, 'politicians_kept', v_kept, 'skipped_touched', v_skip,
                            'regions_reverted', v_reg, 'regions_skipped_touched', v_reg_skip);
END;
$$;
COMMENT ON FUNCTION roster_reconcile_revert(UUID, BIGINT[], TEXT) IS '還原系統（名冊對帳）做的事：補的地區（region_id 改回 NULL）與建的參選紀錄；整輪（p_run）或逐筆（p_reg_ids）；只授權 service_role；別人動過的不還原（2026-10-19，2026-10-21 加補地區）';

REVOKE ALL ON FUNCTION roster_reconcile_region_next(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_reconcile_region_next(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION roster_reconcile_set_region(BIGINT, INTEGER, INTEGER, UUID, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_reconcile_set_region(BIGINT, INTEGER, INTEGER, UUID, TEXT, TEXT, INTEGER, TEXT) TO service_role;
REVOKE ALL ON FUNCTION roster_reconcile_revert(UUID, BIGINT[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_reconcile_revert(UUID, BIGINT[], TEXT) TO service_role;
-- ▲▲ SECTION: run ▲▲
