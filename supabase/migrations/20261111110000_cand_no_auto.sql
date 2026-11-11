-- 號次：中選會名冊鏡像唯一對上由系統直接寫入，對不上才派代理（維護者 2026-11-11 裁示；不升協議版）
-- ============================================================
--
-- 更正 2026-09-24／2026-10-08「號次不做系統核對」：當時登記彙總表沒有號次，現在名冊鏡像（cec_roster_2026，20261031160000）有。
-- 樣板：cec_results_auto_*（20261019100000）、roster_reconcile_*（20261019120000）。
--
-- 做法（只用 SQL＋pg_cron，不新增 Edge Function；鏡像抓取仍是 cec-roster-mirror）：
--   1. 計畫 cand_no_auto_plan()：2026 參選紀錄 candidacy_status＝filed、cand_no 空、人物沒被併走的列 × 名冊鏡像「fresh」單位
--      （近 3 天內抓成功，定義同 cec_roster_diff）。配對鍵＝單位＋roster_name_key（完全相同才算，不做容錯；容錯的留給代理）。
--      唯一對上＝我們這邊同單位同名只有一列、鏡像那邊同單位同名只有一列、鏡像那列有號次、同號次單位沒有別人用這個號次。
--      其他一律 action＝unresolved 附原因碼，留給既有的 cand_no 派工臂（臂本來就只派 cand_no 空的，系統寫完缺口自然收回，總表函式不動）：
--        no_unit（我們的參選紀錄算不出號次單位）／unit_not_fresh（鏡像沒有這個單位或超過 3 天沒抓成功）／ambiguous_ours（我們同單位同名多筆）／
--        not_in_roster（鏡像同單位找不到這個名字）／ambiguous_roster（鏡像同單位同名多筆）／roster_no_cand_no（鏡像那列沒有號次）／
--        duplicate_in_unit（同號次單位已有別人用這個號次，或這一輪兩位要寫同號次）。
--      村里長鏡像只到鄉鎮（JSON 沒有村里名）：用鄉鎮＋姓名配對，重複檢查用我們的村里單位（需要參選紀錄有村里，沒有就 no_unit）。
--      與 20261109190000「不在名冊的人不派」不衝突：那條排除的是名冊上找不到的人（not_in_roster，永遠沒號次），這裡寫的是名冊上有的人。
--   2. 寫入 cand_no_auto_apply(p_limit, p_dry_run)：只補空白、寫 politician_elections.cand_no，每筆進 edit_history（agent_name＝cand-no-auto，
--      contribution_id 留空）、cand_no_auto_log 留證據（politician_election_id 唯一）；一輪一個 run（cand_no_auto_runs）；
--      cand_no_auto_revert(run_id) 只還原「現值仍是它寫的」的列，還原時自動關開關，被還原的列之後不再由系統寫。
--   3. 開關 cand_no_auto_settings（單列，enabled 預設 false、batch_limit 預設 100）；pg_cron cand-no-auto-10min 呼叫 apply，關著不做事。
--      計畫函式開關關著時一列都不回（p_ignore_enabled＝true 可乾跑）。
--   4. 現況視圖 cand_no_auto_status（pending／written／unresolved 計數，不看開關）。
-- migration 不寫任何參選紀錄。守門：_shared/cand-no-auto.test.ts。

-- ── 1. 設定（單列、有開關） ────────────────────────────────────
CREATE TABLE IF NOT EXISTS cand_no_auto_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  batch_limit INTEGER NOT NULL DEFAULT 100 CHECK (batch_limit BETWEEN 1 AND 20000),
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO cand_no_auto_settings (id, note) VALUES (1, '2026-11-11：預設關。上線流程：先 SELECT cand_no_auto_apply(NULL, true) 乾跑核對數字（關著也能乾跑），再 UPDATE enabled = true（batch_limit 100）小批試寫，核對 cand_no_auto_log／edit_history 無誤再調大 batch_limit；關著時計畫函式不回任何列，派工臂照舊派給代理') ON CONFLICT (id) DO NOTHING;
ALTER TABLE cand_no_auto_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON cand_no_auto_settings;
CREATE POLICY "Public read" ON cand_no_auto_settings FOR SELECT USING (true);
COMMENT ON TABLE cand_no_auto_settings IS '號次由名冊鏡像唯一對上由系統寫入的設定（單列）：enabled 開關、batch_limit 每輪最多寫幾位；改值進 edit_history（activity-audit）（2026-11-11）';
DROP TRIGGER IF EXISTS trg_cand_no_auto_settings_touch ON cand_no_auto_settings;
CREATE TRIGGER trg_cand_no_auto_settings_touch BEFORE UPDATE ON cand_no_auto_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_cand_no_auto_settings_audit ON cand_no_auto_settings;
CREATE TRIGGER trg_cand_no_auto_settings_audit AFTER INSERT OR UPDATE OR DELETE ON cand_no_auto_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ── 2. run 與 log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cand_no_auto_runs (
  id             BIGSERIAL PRIMARY KEY,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  written        INTEGER NOT NULL DEFAULT 0,
  first_edit_id  BIGINT,
  last_edit_id   BIGINT,
  reverted_at    TIMESTAMPTZ,
  reverted_by    TEXT
);
CREATE TABLE IF NOT EXISTS cand_no_auto_log (
  id                      BIGSERIAL PRIMARY KEY,
  run_id                  BIGINT NOT NULL REFERENCES cand_no_auto_runs(id) ON DELETE CASCADE,
  politician_election_id  INTEGER NOT NULL UNIQUE,
  roster_id               BIGINT,      -- cec_roster_2026.id（鏡像整檔替換後 id 會變，證據以下面的單位與姓名為準）
  roster_unit_url         TEXT,
  roster_unit             TEXT,
  roster_name             TEXT,
  cand_no                 INTEGER,     -- 寫入值（skipped 時是鏡像上的號次）
  result                  TEXT NOT NULL CHECK (result IN ('written', 'skipped', 'reverted')),
  reason                  TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cand_no_auto_log_run_idx ON cand_no_auto_log (run_id);
ALTER TABLE cand_no_auto_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cand_no_auto_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON cand_no_auto_runs;
CREATE POLICY "Public read" ON cand_no_auto_runs FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read" ON cand_no_auto_log;
CREATE POLICY "Public read" ON cand_no_auto_log FOR SELECT USING (true);
COMMENT ON TABLE cand_no_auto_runs IS '號次系統寫入的每一輪（有寫東西才留一列）；first_edit_id～last_edit_id 框出這輪的 edit_history（agent_name＝cand-no-auto），cand_no_auto_revert(run_id) 整輪還原（2026-11-11）';
COMMENT ON TABLE cand_no_auto_log IS '號次系統寫入的證據：每位參選紀錄一列（politician_election_id 唯一）。written＝已寫（鏡像單位、姓名、號次）；skipped＝寫入前發現同單位已有人用這個號次（duplicate_in_unit），沒寫；reverted＝已還原，之後系統不再寫這一筆（2026-11-11）';

-- ── 3. 計畫（唯讀） ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION cand_no_auto_plan(p_ignore_enabled BOOLEAN DEFAULT FALSE)
RETURNS TABLE (politician_election_id INTEGER, politician_id UUID, election_type TEXT, county TEXT, unit TEXT, our_name TEXT,
               roster_id BIGINT, roster_unit_url TEXT, roster_unit TEXT, roster_name TEXT, cand_no INTEGER, action TEXT, reason TEXT)
LANGUAGE sql STABLE SET enable_nestloop = off AS $fn$
  WITH
  en AS MATERIALIZED (SELECT (p_ignore_enabled OR COALESCE((SELECT s.enabled FROM cand_no_auto_settings s WHERE s.id = 1), false)) AS on_),
  -- fresh 定義同 cec_roster_diff：近 3 天內抓成功的單位（跟下面 cand_no_auto_mismatch 視圖各自一份，刻意不共用）
  fresh AS MATERIALIZED (
    SELECT u.election_type, replace(u.county, '臺', '台') AS county, replace(u.town, '臺', '台') AS town
      FROM cec_roster_units u WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'
  ),
  r AS MATERIALIZED (
    SELECT x.id, x.election_type, x.unit_key AS unit, x.name, COALESCE(x.name_key, roster_name_key(x.name)) AS nkey, x.cand_no, x.unit_url
      FROM cec_roster_2026 x
      JOIN fresh f ON f.election_type = x.election_type AND f.county = replace(x.county, '臺', '台')
                  AND (x.election_type <> '村里長' OR f.town = replace(x.town, '臺', '台'))
  ),
  -- 鏡像一個（單位、姓名鍵）一列：n＝同單位同名幾筆（>1 就是同名多筆，不唯一）
  rc AS MATERIALIZED (
    SELECT r.election_type, r.unit, r.nkey, count(*)::INTEGER AS n, min(r.id) AS id, min(r.cand_no) AS cand_no, min(r.unit_url) AS unit_url, min(r.name) AS name
      FROM r GROUP BY r.election_type, r.unit, r.nkey
  ),
  -- 我們這邊：2026、非退選、人物沒被併走；fu＝我們的號次單位（村里長到村里），mu＝配對用的單位（跟鏡像同粒度，村里長只到鄉鎮）
  o0 AS MATERIALIZED (
    SELECT pe.id AS pe_id, pe.politician_id, p.name, roster_name_key(p.name) AS nkey, pe.election_id, pe.election_type,
           replace(COALESCE(rg.region, p.region), '臺', '台') AS county,
           CASE WHEN pe.election_type = '村里長' THEN COALESCE(replace(rg.sub_region, '臺', '台'), '') ELSE '' END AS scope_town,
           pe.cand_no, pe.candidacy_status AS status,
           cec_roster_norm_unit(ballot_number_unit(pe.election_type, COALESCE(rg.region, p.region), rg.sub_region, rg.sub_region, rg.village)) AS fu
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.election_id = 2026
       AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
       AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
  ),
  o AS MATERIALIZED (
    SELECT o0.*, CASE WHEN o0.election_type = '村里長' THEN CASE WHEN o0.scope_town <> '' THEN o0.county || '|' || o0.scope_town END ELSE o0.fu END AS mu
      FROM o0
  ),
  oc AS MATERIALIZED (SELECT o.election_type, o.mu, o.nkey, count(*)::INTEGER AS n FROM o WHERE o.mu IS NOT NULL GROUP BY 1, 2, 3),
  -- 候選：filed、cand_no 空；被還原過的不再寫
  c AS MATERIALIZED (
    SELECT o.* FROM o
     WHERE o.status = 'filed' AND o.cand_no IS NULL
       AND NOT EXISTS (SELECT 1 FROM cand_no_auto_log l WHERE l.politician_election_id = o.pe_id AND l.result = 'reverted')
  ),
  -- 號次單位已被用掉的號次（含退選但有號次的：抽籤時他在名單裡，號次不會讓出來；同 ballot_number_units 的判準）。
  -- 候選的 cand_no 都是空的，所以自己不在這裡面
  ud AS MATERIALIZED (
    SELECT x.fu, x.cand_no, count(*)::INTEGER AS n
      FROM (SELECT cec_roster_norm_unit(ballot_number_unit(pe.election_type, COALESCE(rg.region, p.region), rg.sub_region, rg.sub_region, rg.village)) AS fu, pe.cand_no
              FROM politician_elections pe
              JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
              LEFT JOIN regions rg ON rg.id = pe.region_id
             WHERE pe.election_id = 2026 AND pe.cand_no IS NOT NULL) x
     WHERE x.fu IS NOT NULL
     GROUP BY x.fu, x.cand_no
  ),
  j AS MATERIALIZED (
    SELECT c.*, rc.id AS rid, rc.unit_url AS rurl, rc.unit AS runit, rc.name AS rname, rc.cand_no AS rno,
           CASE
             WHEN c.mu IS NULL OR (c.election_type = '村里長' AND c.fu IS NULL) THEN 'no_unit'
             WHEN NOT EXISTS (SELECT 1 FROM fresh f WHERE f.election_type = c.election_type AND f.county = c.county AND f.town = c.scope_town) THEN 'unit_not_fresh'
             WHEN oc.n > 1 THEN 'ambiguous_ours'
             WHEN rc.n IS NULL THEN 'not_in_roster'
             WHEN rc.n > 1 THEN 'ambiguous_roster'
             WHEN rc.cand_no IS NULL THEN 'roster_no_cand_no'
             WHEN ud.n > 0 THEN 'duplicate_in_unit'
           END AS reason
      FROM c
      LEFT JOIN oc ON oc.election_type = c.election_type AND oc.mu = c.mu AND oc.nkey = c.nkey
      LEFT JOIN rc ON rc.election_type = c.election_type AND rc.unit = c.mu AND rc.nkey = c.nkey
      LEFT JOIN ud ON ud.fu = c.fu AND ud.cand_no = rc.cand_no
  ),
  k AS MATERIALIZED (
    SELECT j.*,
           COALESCE(j.reason, CASE WHEN count(*) OVER (PARTITION BY j.fu, j.rno) > 1 THEN 'duplicate_in_unit' END) AS final_reason
      FROM j
  )
  SELECT k.pe_id, k.politician_id, k.election_type, k.county, k.fu, k.name,
         k.rid, k.rurl, k.runit, k.rname, k.rno,
         CASE WHEN k.final_reason IS NULL THEN 'write' ELSE 'unresolved' END,
         k.final_reason
    FROM k
   WHERE (SELECT en.on_ FROM en)
$fn$;
COMMENT ON FUNCTION cand_no_auto_plan IS
  '號次由名冊鏡像唯一對上的計畫：2026 filed、cand_no 空的參選紀錄 × 鏡像 fresh 單位（近 3 天抓成功），配對鍵＝單位＋roster_name_key（完全相同）。action＝write（我們同單位同名一列、鏡像同單位同名一列、鏡像有號次、同號次單位沒人用這個號次）；其餘 unresolved＋reason（no_unit／unit_not_fresh／ambiguous_ours／not_in_roster／ambiguous_roster／roster_no_cand_no／duplicate_in_unit），留給既有 cand_no 派工臂。關著開關一列都不回（p_ignore_enabled 可乾跑）。唯讀。2026-11-11';

-- ── 4. 寫入：只補空白、每筆進 edit_history、整輪可還原 ──────────
CREATE OR REPLACE FUNCTION cand_no_auto_apply(p_limit INTEGER DEFAULT NULL, p_dry_run BOOLEAN DEFAULT FALSE) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit INTEGER;
  v_run BIGINT;
  v_written INTEGER := 0; v_logged INTEGER := 0; v_skipped INTEGER := 0;
  v_first BIGINT; v_last BIGINT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('cand_no_auto_apply')) THEN
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;
  IF NOT p_dry_run AND NOT COALESCE((SELECT s.enabled FROM cand_no_auto_settings s WHERE s.id = 1), false) THEN
    RETURN jsonb_build_object('skipped', 'disabled');
  END IF;
  v_limit := GREATEST(1, LEAST(COALESCE(p_limit, (SELECT s.batch_limit FROM cand_no_auto_settings s WHERE s.id = 1), 100), 20000));

  IF p_dry_run THEN
    -- 乾跑（不寫、不看開關）：能寫幾筆、unresolved 各原因幾筆、依職位分布
    RETURN jsonb_build_object('dry_run', true,
      'would_write', (SELECT count(*) FROM cand_no_auto_plan(true) a WHERE a.action = 'write'),
      'unresolved', COALESCE((SELECT jsonb_object_agg(g.reason, g.n) FROM (SELECT a.reason, count(*) AS n FROM cand_no_auto_plan(true) a WHERE a.action = 'unresolved' GROUP BY a.reason) g), '{}'::jsonb),
      'by_type', COALESCE((SELECT jsonb_agg(jsonb_build_object('election_type', g.election_type, 'write', g.w, 'unresolved', g.u) ORDER BY g.election_type)
                             FROM (SELECT a.election_type, count(*) FILTER (WHERE a.action = 'write') AS w, count(*) FILTER (WHERE a.action = 'unresolved') AS u
                                     FROM cand_no_auto_plan(true) a GROUP BY a.election_type) g), '[]'::jsonb));
  END IF;

  INSERT INTO cand_no_auto_runs DEFAULT VALUES RETURNING id INTO v_run;

  WITH plan AS MATERIALIZED (
    SELECT * FROM cand_no_auto_plan() a WHERE a.action = 'write' ORDER BY a.politician_election_id LIMIT v_limit
  ),
  upd AS (
    UPDATE politician_elections pe SET cand_no = p.cand_no
      FROM plan p
     WHERE pe.id = p.politician_election_id
       -- 寫之前再確認一次還是空白（計畫到這一句之間別人補了就不寫；只補空白、不覆蓋）
       AND pe.cand_no IS NULL AND pe.candidacy_status = 'filed'
    RETURNING pe.id AS pe_id, p.cand_no, p.roster_id, p.roster_unit_url, p.roster_unit, p.roster_name
  ),
  ins AS (
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    SELECT 'politician_elections', u.pe_id::TEXT, 'cand_no', NULL, to_jsonb(u.cand_no), NULL, 'cand-no-auto' FROM upd u
    RETURNING id
  ),
  lg AS (
    INSERT INTO cand_no_auto_log (run_id, politician_election_id, roster_id, roster_unit_url, roster_unit, roster_name, cand_no, result)
    SELECT v_run, u.pe_id, u.roster_id, u.roster_unit_url, u.roster_unit, u.roster_name, u.cand_no, 'written' FROM upd u
    -- 之前記過 skipped（同號次單位有人用）、後來可以寫了：改記 written
    ON CONFLICT (politician_election_id) DO UPDATE SET run_id = EXCLUDED.run_id, roster_id = EXCLUDED.roster_id, roster_unit_url = EXCLUDED.roster_unit_url,
      roster_unit = EXCLUDED.roster_unit, roster_name = EXCLUDED.roster_name, cand_no = EXCLUDED.cand_no, result = 'written', reason = NULL, created_at = now()
    RETURNING id
  )
  SELECT (SELECT count(*) FROM upd), (SELECT min(id) FROM ins), (SELECT max(id) FROM ins), (SELECT count(*) FROM lg)
    INTO v_written, v_first, v_last, v_logged;

  -- 號次重複的留一筆記錄（鏡像上有號次、同號次單位已有別人用；沒寫、不重試記錄，計畫每輪照算）
  WITH dup AS (
    SELECT a.politician_election_id AS pe_id, a.roster_id, a.roster_unit_url, a.roster_unit, a.roster_name, a.cand_no
      FROM cand_no_auto_plan() a WHERE a.reason = 'duplicate_in_unit'
  ), sk AS (
    INSERT INTO cand_no_auto_log (run_id, politician_election_id, roster_id, roster_unit_url, roster_unit, roster_name, cand_no, result, reason)
    SELECT v_run, d.pe_id, d.roster_id, d.roster_unit_url, d.roster_unit, d.roster_name, d.cand_no, 'skipped', 'duplicate_in_unit' FROM dup d
    ON CONFLICT (politician_election_id) DO NOTHING
    RETURNING id
  )
  SELECT count(*) INTO v_skipped FROM sk;

  IF v_written = 0 AND v_skipped = 0 THEN
    DELETE FROM cand_no_auto_runs WHERE id = v_run;
    RETURN jsonb_build_object('run_id', NULL, 'written', 0);
  END IF;
  UPDATE cand_no_auto_runs SET written = v_written, first_edit_id = v_first, last_edit_id = v_last WHERE id = v_run;
  RETURN jsonb_build_object('run_id', v_run, 'written', v_written, 'logged', v_logged, 'skipped_duplicate', v_skipped, 'edit_history', jsonb_build_array(v_first, v_last));
END;
$$;
COMMENT ON FUNCTION cand_no_auto_apply IS
  '系統直接寫號次：鏡像唯一對上的，補 politician_elections.cand_no（只補空白）；每筆進 edit_history（agent_name＝cand-no-auto）、cand_no_auto_log 留證據；一輪一個 run，整輪可 cand_no_auto_revert。同號次單位已有人用的不寫、記 skipped／duplicate_in_unit。每 10 分鐘由 pg_cron 叫，一輪最多 batch_limit 位，開關關著不做事（2026-11-11）';

-- 還原：edit_history 的現值還是我們寫的那個號次才倒回（別人後來改過的不動、算 blocked）。還原時自動關開關，
-- 被還原的那幾位 log 記 reverted、之後系統不再寫（派工臂這時會把他們派回給代理）
CREATE OR REPLACE FUNCTION cand_no_auto_revert(p_run_id BIGINT, p_by TEXT DEFAULT 'maintainer') RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  run cand_no_auto_runs%ROWTYPE;
  r RECORD;
  v_reverted INTEGER := 0; v_blocked INTEGER := 0; v_n INTEGER;
BEGIN
  -- 跟 apply 同一把鎖（阻塞等待；還原是人手動、可以等）：不跟寫入同時進行
  PERFORM pg_advisory_xact_lock(hashtext('cand_no_auto_apply'));
  SELECT * INTO run FROM cand_no_auto_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cand_no_auto_runs % 不存在', p_run_id; END IF;
  IF run.reverted_at IS NOT NULL THEN RAISE EXCEPTION 'run % 已經在 % 還原過', p_run_id, run.reverted_at; END IF;

  FOR r IN
    SELECT h.id AS eh_id, h.record_id, h.new_value #>> '{}' AS new_no
      FROM edit_history h
     WHERE h.agent_name = 'cand-no-auto' AND h.table_name = 'politician_elections' AND h.field = 'cand_no'
       AND h.id BETWEEN run.first_edit_id AND run.last_edit_id AND h.reverted_at IS NULL
  LOOP
    UPDATE politician_elections pe SET cand_no = NULL
     WHERE pe.id = r.record_id::INTEGER AND pe.cand_no IS NOT DISTINCT FROM r.new_no::INTEGER;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
      v_reverted := v_reverted + 1;
      UPDATE edit_history SET reverted_at = now(), reverted_by = p_by WHERE id = r.eh_id;
      UPDATE cand_no_auto_log SET result = 'reverted' WHERE politician_election_id = r.record_id::INTEGER AND run_id = p_run_id;
    ELSE
      v_blocked := v_blocked + 1;
    END IF;
  END LOOP;

  UPDATE cand_no_auto_runs SET reverted_at = now(), reverted_by = p_by WHERE id = p_run_id;
  UPDATE cand_no_auto_settings SET enabled = false, note = left('還原 run ' || p_run_id || ' 時自動關閉（' || p_by || '，' || now()::TEXT || '）；查清楚再打開', 500) WHERE id = 1;
  RETURN jsonb_build_object('run_id', p_run_id, 'reverted', v_reverted, 'blocked', v_blocked, 'auto_disabled', true);
END;
$$;
COMMENT ON FUNCTION cand_no_auto_revert IS
  '整輪還原 cand_no_auto_apply 的一個 run：現值還是系統寫的那個號次才倒回 NULL，別人後來改過的不動（blocked）；被還原的 log 記 reverted、系統之後不再寫；還原時自動關 cand_no_auto_settings.enabled（2026-11-11）';

REVOKE EXECUTE ON FUNCTION cand_no_auto_apply(INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION cand_no_auto_revert(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION cand_no_auto_plan(BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cand_no_auto_apply(INTEGER, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION cand_no_auto_revert(BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION cand_no_auto_plan(BOOLEAN) TO service_role;

-- ── 5. 站上號次跟鏡像不一致（唯讀，只列不寫） ──────────────────
-- 我方已有號次、鏡像同單位同名唯一對上（我們這邊也只有一列）、鏡像有號次而且跟站上不同的 filed 列。
-- fresh 條件（近 3 天抓成功）在計畫函式與這個視圖各自寫一份，刻意不抽共用函式（同 cec_roster_diff 也是各自一份；抽出去要動 cec_roster_diff 的計畫，改動不小）；改 fresh 定義時三處一起看，cand-no-auto.test.ts 的還原驗證兩份都會抓。
-- 實例（2026-11-11 乾跑對照）：站上三筆錯、鏡像對（中選會 JSON 核過）。系統不寫已有的號次（只補空白），這裡只讓人看得到，改正走更正流程。
CREATE OR REPLACE VIEW cand_no_auto_mismatch AS
  WITH fresh AS MATERIALIZED (
    SELECT u.election_type, replace(u.county, '臺', '台') AS county, replace(u.town, '臺', '台') AS town
      FROM cec_roster_units u WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'
  ),
  rc AS MATERIALIZED (
    SELECT x.election_type, x.unit_key AS unit, COALESCE(x.name_key, roster_name_key(x.name)) AS nkey,
           count(*)::INTEGER AS n, min(x.cand_no) AS cand_no, min(x.unit_url) AS unit_url, min(x.name) AS name
      FROM cec_roster_2026 x
      JOIN fresh f ON f.election_type = x.election_type AND f.county = replace(x.county, '臺', '台')
                  AND (x.election_type <> '村里長' OR f.town = replace(x.town, '臺', '台'))
     GROUP BY x.election_type, x.unit_key, COALESCE(x.name_key, roster_name_key(x.name))
  ),
  o AS MATERIALIZED (
    SELECT pe.id AS pe_id, pe.politician_id, p.name, roster_name_key(p.name) AS nkey, pe.election_type, pe.cand_no, pe.candidacy_status AS status,
           cec_roster_norm_unit(ballot_number_unit(pe.election_type, COALESCE(rg.region, p.region), rg.sub_region, rg.sub_region, rg.village)) AS fu,
           CASE WHEN pe.election_type = '村里長'
                THEN CASE WHEN COALESCE(rg.sub_region, '') <> '' THEN replace(COALESCE(rg.region, p.region), '臺', '台') || '|' || replace(rg.sub_region, '臺', '台') END
                ELSE cec_roster_norm_unit(ballot_number_unit(pe.election_type, COALESCE(rg.region, p.region), rg.sub_region, rg.sub_region, rg.village)) END AS mu
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.election_id = 2026
       AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
       AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
  ),
  oc AS MATERIALIZED (SELECT o.election_type, o.mu, o.nkey, count(*)::INTEGER AS n FROM o WHERE o.mu IS NOT NULL GROUP BY 1, 2, 3)
  SELECT o.pe_id AS politician_election_id, o.politician_id, o.name AS our_name, o.election_type, o.fu AS unit,
         o.cand_no AS our_cand_no, rc.cand_no AS roster_cand_no, rc.name AS roster_name, rc.unit_url AS roster_unit_url, u.fetched_at AS roster_fetched_at
    FROM o
    JOIN oc ON oc.election_type = o.election_type AND oc.mu = o.mu AND oc.nkey = o.nkey AND oc.n = 1
    JOIN rc ON rc.election_type = o.election_type AND rc.unit = o.mu AND rc.nkey = o.nkey AND rc.n = 1
    JOIN cec_roster_units u ON u.url = rc.unit_url
   WHERE o.status = 'filed' AND o.cand_no IS NOT NULL AND rc.cand_no IS NOT NULL AND rc.cand_no <> o.cand_no;
COMMENT ON VIEW cand_no_auto_mismatch IS
  '站上已有號次、但名冊鏡像（近 3 天抓成功的單位）同單位同名唯一對上且號次不同的 filed 參選紀錄：只列不寫（系統只補空白）。2026-11-11 乾跑實例三筆，中選會 JSON 核過都是站上錯、鏡像對；改正走更正流程';
REVOKE ALL ON cand_no_auto_mismatch FROM PUBLIC, anon, authenticated;  -- 內部錯誤清單，不公開（主線裁，2026-11-11）
GRANT SELECT ON cand_no_auto_mismatch TO service_role;

-- ── 6. 現況視圖與排程 ──────────────────────────────────────────
-- 不看開關（關著也看得到若打開會寫多少）；pending 在排程跑完應歸零，unresolved 是留給代理的
CREATE OR REPLACE VIEW cand_no_auto_status AS
  WITH p AS MATERIALIZED (SELECT * FROM cand_no_auto_plan(true))
  SELECT s.enabled, s.batch_limit,
         (SELECT count(*) FROM p WHERE p.action = 'write')::INTEGER AS pending,
         (SELECT count(*) FROM cand_no_auto_log l WHERE l.result = 'written')::INTEGER AS written,
         (SELECT count(*) FROM cand_no_auto_log l WHERE l.result = 'reverted')::INTEGER AS reverted,
         (SELECT count(*) FROM p WHERE p.action = 'unresolved')::INTEGER AS unresolved,
         COALESCE((SELECT jsonb_object_agg(g.reason, g.n) FROM (SELECT p.reason, count(*) AS n FROM p WHERE p.action = 'unresolved' GROUP BY p.reason) g), '{}'::jsonb) AS unresolved_by_reason,
         (SELECT max(r.ran_at) FROM cand_no_auto_runs r WHERE r.reverted_at IS NULL) AS last_run_at,
         (SELECT count(*) FROM cand_no_auto_mismatch)::INTEGER AS mismatch
    FROM cand_no_auto_settings s
   WHERE s.id = 1;
COMMENT ON VIEW cand_no_auto_status IS
  '號次系統寫入的現況（一列）：還有多少位等著寫（pending，排程跑完應歸零）、已寫（written）、已還原（reverted）、留給代理的（unresolved，依原因分）、站上號次跟鏡像不一致的（mismatch，視圖 cand_no_auto_mismatch，只列不寫）。不看開關（2026-11-11）';
REVOKE ALL ON cand_no_auto_status FROM PUBLIC, anon, authenticated;  -- 內部清單，不公開（主線裁，2026-11-11）
GRANT SELECT ON cand_no_auto_status TO service_role;

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'cand-no-auto-10min';
    -- 錯開 cec-results-auto（7,17,… 分）與 seed（*/10）
    EXECUTE $q$SELECT cron.schedule('cand-no-auto-10min', '3,13,23,33,43,53 * * * *', 'SELECT cand_no_auto_apply();')$q$;
  END IF;
END
$$;
