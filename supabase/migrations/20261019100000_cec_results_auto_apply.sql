-- 官方資料比對得上的由系統寫入，對不上的才是缺口（維護者 2026-10-19，#678；協議 1.100.0）
--
-- 以前：結果空白一律聚成批次派代理（2022 年 13,313 筆在中選會名單唯一對上卻仍空白），再靠「系統票＋代理同意」上線。
-- 現在：中選會選舉資料庫 API（結構化 JSON，cec-sync 寫進 cec_candidates）唯一對上、而且那個選區已開完的，
-- 由系統直接寫 politician_elections.candidacy_status（elected／not_elected）與推薦政黨；
-- 缺口只剩「對不上」的：名單有我們沒有（elected_missing，不動）、我們有名單對不到、同名多筆、我們標的跟中選會不一樣、選區開沒開完確認不了。
--
-- 「選區已開完」的定義（cec_unit_status.complete，一個單位＝cec_candidates 的 屆別×職位×縣市×選舉區×村里）：
--   election_districts 登錄了應選名額 seats，而且中選會名單在這個單位標當選的人數＝seats、沒有任何一列當選與否是空的，
--   而且投票日已過（台北日期，activity_today()：投票日當天算還沒投票）。
--   名額空白（還沒查證）的單位一律不算開完——election_districts 的規矩：不要用候選人數或當選人數推。
-- 為什麼要這道守門：cec_candidates.elected 是布林，開票途中沒標當選的會存成 false（cec-sync 開票夜每 10 分鐘抓一次半成品），
--   拿 false 當「落選」會把還沒開完的選區整批標錯。
--
-- 只限 JSON 結構化資料：登記彙總表、名單公告、公報這些從 PDF 讀出來的不在範圍（cec_registrations 不碰）。
--
-- 系統寫入的規矩（「事實一律走流程，系統只對已驗證進庫的事實做反應」：這裡把中選會 API 視為官方事實來源）：
--   ①只補空白、不覆蓋；②每一筆進 edit_history（agent_name＝cec-results-auto）、cec_results_auto_log 留比對證據（單位、應選席次、當選數、中選會 id）；
--   ③一次執行是一個 run（cec_auto_apply_runs），整個 run 可由 cec_results_auto_revert() 還原；④單列設定表 cec_results_auto_settings 有開關，
--   關掉時計畫函式不回任何列，派工臂就退回原本把這些列派給代理（不會有「系統不寫、代理也沒收到」的洞）。
-- migration 本身不改任何正式資料：函式建好、排程掛上（cec-results-auto-10min），第一次執行是部署後的排程。
--
-- 其他路徑的守門（同一支 migration 或同一個 PR）：
--   系統票 election_results_compare 多一種狀態 unit_open（選區沒開完不算 match，不投票）；
--   cec-verify／cec-check／fetch-cec-data 開票後 3 天內不採用中選會人名查詢的「落選」（TS：cec-candidate.ts 的 withoutUnsettledResults）；
--   整批補結果（applyElectionResults）投票日已過才寫。

-- ── 1. 單位鍵 ─────────────────────────────────────────────────
-- 同一個單位在 cec_candidates 與 election_districts 兩邊的寫法一樣（region／sub_region／village），null 與空字串視為同一個；
-- 做成一個鍵字串，連接才走雜湊（兩邊的 IS NOT DISTINCT FROM 連接在正式庫實測要 3.9 秒）
CREATE OR REPLACE FUNCTION cec_unit_key(p_election_id INTEGER, p_election_type TEXT, p_region TEXT, p_sub_region TEXT, p_village TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_election_id::TEXT || '|' || COALESCE(p_election_type, '') || '|' || replace(COALESCE(p_region, ''), '臺', '台') || '|' || COALESCE(p_sub_region, '') || '|' || COALESCE(p_village, '')
$$;
COMMENT ON FUNCTION cec_unit_key IS '一個開票單位的鍵：屆別｜職位｜縣市（臺→台）｜選舉區或鄉鎮｜村里；cec_candidates 與 election_districts 共用（#678，2026-10-19）';

-- ── 2. 設定（單列、有開關） ────────────────────────────────────
CREATE TABLE IF NOT EXISTS cec_results_auto_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  batch_limit INTEGER NOT NULL DEFAULT 2000 CHECK (batch_limit BETWEEN 1 AND 20000),
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO cec_results_auto_settings (id, note) VALUES (1, '2026-10-19 #678：中選會比對得上由系統寫入；關掉（enabled＝false）計畫函式不回任何列，派工臂退回派給代理') ON CONFLICT (id) DO NOTHING;
ALTER TABLE cec_results_auto_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON cec_results_auto_settings;
CREATE POLICY "Public read" ON cec_results_auto_settings FOR SELECT USING (true);
COMMENT ON TABLE cec_results_auto_settings IS '中選會比對得上由系統寫入的設定（單列）：enabled 開關、batch_limit 每次最多寫幾位；改值＝一行 migration 的 UPDATE，進 edit_history（activity-audit）（#678）';
DROP TRIGGER IF EXISTS trg_cec_results_auto_settings_touch ON cec_results_auto_settings;
CREATE TRIGGER trg_cec_results_auto_settings_touch BEFORE UPDATE ON cec_results_auto_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_cec_results_auto_settings_audit ON cec_results_auto_settings;
CREATE TRIGGER trg_cec_results_auto_settings_audit AFTER INSERT OR UPDATE OR DELETE ON cec_results_auto_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ── 3. 「開完了沒」 ────────────────────────────────────────────
-- 整場選舉的結算天數：投票日後這麼多個台北日曆日，名額沒登錄的單位也視為結果底定（跟 cec_sync_phase 的 live 窗口 3 天一致）。
-- TS 鏡像：_shared/cec-candidate.ts 的 RESULT_SETTLE_DAYS（守門測試對齊）
CREATE OR REPLACE FUNCTION cec_results_settle_days() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

CREATE OR REPLACE FUNCTION cec_results_settled(p_election_id INTEGER) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT activity_today() >= e.election_date + cec_results_settle_days() FROM elections e WHERE e.id = p_election_id), false)
$$;
COMMENT ON FUNCTION cec_results_settled IS '整場選舉結果底定：台北今天 ≥ 投票日 + 3 天。系統票對名額沒登錄的單位用這個（系統「直接寫入」不看這個，只認 cec_unit_status.complete）（#678）';

-- 一個單位一列：中選會名單標當選幾位 vs 應選席次。complete＝名額已登錄、當選數＝席次、沒有當選與否空白的、投票日已過
CREATE OR REPLACE VIEW cec_unit_status AS
  SELECT u.election_id, u.election_type, u.region, u.sub_region, u.village,
         cec_unit_key(u.election_id, u.election_type, u.region, u.sub_region, u.village) AS unit_key,
         u.cec_n, u.cec_elected, u.cec_unknown, d.seats, e.election_date,
         (d.seats IS NOT NULL AND u.cec_unknown = 0 AND u.cec_elected = d.seats AND e.election_date < activity_today()) AS complete
    FROM (SELECT c.election_id, c.election_type, replace(c.region, '臺', '台') AS region, c.sub_region, c.village,
                 count(*)::INTEGER AS cec_n,
                 (count(*) FILTER (WHERE c.elected IS TRUE))::INTEGER AS cec_elected,
                 (count(*) FILTER (WHERE c.elected IS NULL))::INTEGER AS cec_unknown
            FROM cec_candidates c
           GROUP BY c.election_id, c.election_type, replace(c.region, '臺', '台'), c.sub_region, c.village) u
    JOIN elections e ON e.id = u.election_id
    LEFT JOIN election_districts d
           ON cec_unit_key(d.election_id, d.election_type, d.region, d.sub_region, d.village)
            = cec_unit_key(u.election_id, u.election_type, u.region, u.sub_region, u.village);
COMMENT ON VIEW cec_unit_status IS
  '中選會名單的每個開票單位：標當選幾位（cec_elected）對應選席次（seats，election_districts）。complete＝名額已登錄、當選數＝席次、當選與否沒有空白、投票日已過（台北日期）。名額沒登錄的單位不算開完（不要用人數推）。系統直接寫入只認 complete（#678，2026-10-19）';

-- ── 4. 系統寫入：政黨依據多一個值 cec、紀錄表 ────────────────────
ALTER TABLE politician_elections DROP CONSTRAINT IF EXISTS politician_elections_party_basis_check;
ALTER TABLE politician_elections ADD CONSTRAINT politician_elections_party_basis_check
  CHECK (party_basis IN ('contribution', 'person_single', 'cec'));
COMMENT ON COLUMN politician_elections.party_basis IS
  'party_id 的根據：contribution＝candidacy 交件寫的政黨（之後每筆落庫由觸發器寫）／person_single＝這人只有這一筆參選紀錄、人物政黨沒改過（只在 10-06 回填用）／cec＝系統照中選會名冊（cec_candidates.party）直接寫，選區已開完才寫（cec_results_auto_apply，2026-10-19 #678）';

CREATE TABLE IF NOT EXISTS cec_auto_apply_runs (
  id             BIGSERIAL PRIMARY KEY,
  ran_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  results_written INTEGER NOT NULL DEFAULT 0,
  parties_written INTEGER NOT NULL DEFAULT 0,
  first_edit_id  BIGINT,
  last_edit_id   BIGINT,
  reverted_at    TIMESTAMPTZ,
  reverted_by    TEXT
);
CREATE TABLE IF NOT EXISTS cec_results_auto_log (
  id                      BIGSERIAL PRIMARY KEY,
  run_id                  BIGINT NOT NULL REFERENCES cec_auto_apply_runs(id) ON DELETE CASCADE,
  politician_election_id  INTEGER NOT NULL,
  evidence                JSONB NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cec_results_auto_log_run_idx ON cec_results_auto_log (run_id);
CREATE INDEX IF NOT EXISTS cec_results_auto_log_pe_idx ON cec_results_auto_log (politician_election_id);
ALTER TABLE cec_auto_apply_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cec_results_auto_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON cec_auto_apply_runs;
CREATE POLICY "Public read" ON cec_auto_apply_runs FOR SELECT USING (true);
DROP POLICY IF EXISTS "Public read" ON cec_results_auto_log;
CREATE POLICY "Public read" ON cec_results_auto_log FOR SELECT USING (true);
COMMENT ON TABLE cec_auto_apply_runs IS '系統直接寫入的每一次執行（有寫東西才留一列）；first_edit_id～last_edit_id 框出這次的 edit_history（agent_name＝cec-results-auto），cec_results_auto_revert(run_id) 整次還原（#678）';
COMMENT ON TABLE cec_results_auto_log IS '系統直接寫入的比對證據：每寫一位一列，evidence 帶單位（屆別、職位、縣市、選舉區、村里）、應選席次、中選會標當選數、中選會候選人 id 與場次、來源（中選會選舉資料庫 API 快照）（#678）';

-- ── 5. 計畫：這一刻系統「寫得了」與「不一致」的是哪些列 ───────────────
-- 範圍：投票日已過（台北日期）的全部參選紀錄（含已有結果的：不一致與「同一位中選會名單被我們兩筆對到」都要看得到）。
-- 比對照 election_result_cec_matches（比對規則只有一份）；單位開完了沒照 cec_unit_status.complete。
--   write_result：我們結果空白（不是 elected／not_elected／withdrawn）、唯一對上、中選會有當選與否、單位開完、而且沒有第二筆參選紀錄對到同一位 → 寫
--   write_party ：party_basis 空、唯一對上、單位開完、沒有第二筆對到同一位、名冊的政黨寫法對得到 party_aliases → 寫（無黨籍那一族＝party_id 空、party_basis＝cec）
--   mismatch    ：我們已有結果（elected／not_elected），唯一對上、單位開完，而且跟中選會名單相反 → 不覆蓋，派代理
-- 派工臂拿 write_result／write_party 排除、拿 mismatch 派；寫入函式只拿 write_*。關掉開關時一列都不回。
CREATE OR REPLACE FUNCTION cec_results_auto_plan()
RETURNS TABLE (
  politician_election_id INTEGER, politician_id UUID, name TEXT, election_id INTEGER, election_type TEXT,
  county TEXT, town TEXT, village TEXT,
  cur_status TEXT, cur_party_id BIGINT, cur_party_basis TEXT,
  cec_elected BOOLEAN, cec_sub_region TEXT, cec_village TEXT, cec_birth_year INTEGER, cec_cand_id INTEGER, cec_theme_id TEXT, cec_party TEXT,
  unit_seats INTEGER, unit_elected INTEGER, new_party_id BIGINT,
  write_result BOOLEAN, write_party BOOLEAN, mismatch BOOLEAN)
LANGUAGE sql STABLE AS $$
  WITH scope AS (
    SELECT pe.id
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
     WHERE (SELECT s.enabled FROM cec_results_auto_settings s WHERE s.id = 1)
       AND e.election_date < activity_today()
       AND NOT politician_name_is_placeholder(p.name)
  ),
  m AS (
    SELECT * FROM election_result_cec_matches(ARRAY(SELECT sc.id FROM scope sc))
  ),
  j AS (
    SELECT m.politician_election_id AS pe_id, m.politician_id AS pid, m.name AS pname, m.election_id AS eid, m.election_type AS etype,
           m.county AS county, m.town AS town, m.village AS village,
           pe.candidacy_status AS cur_status, pe.party_id AS cur_party_id, pe.party_basis AS cur_party_basis,
           m.cec_hits, m.cec_elected AS c_elected, m.cec_sub_region AS c_sub, m.cec_village AS c_vil, m.cec_birth_year AS c_birth,
           m.cec_cand_id AS c_cand, m.cec_theme_id AS c_theme,
           us.complete AS unit_complete, us.seats AS u_seats, us.cec_elected AS u_elected,
           cc.party AS c_party, a.party_id AS alias_party_id, (a.alias_key IS NOT NULL) AS alias_ok,
           -- 同一位中選會名單被我們幾筆參選紀錄對到：多於一筆＝我們有重複的人，寫誰都可能寫成兩位當選
           count(*) FILTER (WHERE m.cec_hits = 1) OVER (PARTITION BY m.election_id, m.election_type, m.county, m.cec_sub_region, m.cec_village, cec_name_key(m.name)) AS same_target_n
      FROM m
      JOIN politician_elections pe ON pe.id = m.politician_election_id
      LEFT JOIN cec_unit_status us ON m.cec_hits = 1
           AND us.unit_key = cec_unit_key(m.election_id, m.election_type, m.county, m.cec_sub_region, m.cec_village)
      LEFT JOIN LATERAL (
        SELECT x.party FROM cec_candidates x
         WHERE m.cec_hits = 1 AND x.election_id = m.election_id AND x.name_norm = cec_name_key(m.name)
           AND x.election_type = m.election_type AND x.region = m.county
           AND x.sub_region IS NOT DISTINCT FROM m.cec_sub_region AND x.village IS NOT DISTINCT FROM m.cec_village
         LIMIT 1) cc ON true
      LEFT JOIN party_aliases a ON a.alias_key = party_alias_key(cc.party)
  ),
  f AS (
    SELECT j.*,
           (COALESCE(j.cur_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')
            AND j.cec_hits = 1 AND j.c_elected IS NOT NULL AND COALESCE(j.unit_complete, false) AND j.same_target_n = 1) AS w_result,
           (j.cur_party_basis IS NULL
            AND j.cec_hits = 1 AND COALESCE(j.unit_complete, false) AND j.same_target_n = 1
            AND j.alias_ok AND NULLIF(btrim(COALESCE(j.c_party, '')), '') IS NOT NULL) AS w_party,
           (j.cur_status IN ('elected', 'not_elected')
            AND j.cec_hits = 1 AND j.c_elected IS NOT NULL AND COALESCE(j.unit_complete, false)
            AND ((j.cur_status = 'elected') IS DISTINCT FROM j.c_elected)) AS w_mismatch
      FROM j
  )
  SELECT f.pe_id, f.pid, f.pname, f.eid, f.etype, f.county, f.town, f.village,
         f.cur_status, f.cur_party_id, f.cur_party_basis,
         f.c_elected, f.c_sub, f.c_vil, f.c_birth, f.c_cand, f.c_theme, f.c_party,
         f.u_seats, f.u_elected, f.alias_party_id,
         f.w_result, f.w_party, f.w_mismatch
    FROM f
   WHERE f.w_result OR f.w_party OR f.w_mismatch
$$;
ALTER FUNCTION cec_results_auto_plan() ROWS 2000;
COMMENT ON FUNCTION cec_results_auto_plan IS
  '中選會比對得上、選區已開完的：系統這一刻寫得了的（write_result／write_party）與「我們標的跟中選會相反」的（mismatch）。範圍＝投票日已過（台北日期）的全部參選紀錄；關掉 cec_results_auto_settings.enabled 一列都不回。寫入由 cec_results_auto_apply，派工臂用它排除／派不一致（#678，2026-10-19）';

-- ── 6. 寫入：只補空白、每筆進 edit_history、整次可還原 ───────────────
CREATE OR REPLACE FUNCTION cec_results_auto_apply(p_limit INTEGER DEFAULT NULL, p_dry_run BOOLEAN DEFAULT FALSE) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit INTEGER;
  v_run BIGINT;
  v_results INTEGER := 0; v_parties INTEGER := 0; v_logged INTEGER := 0;
  v_first BIGINT; v_last BIGINT;
  v_plan_results INTEGER; v_plan_parties INTEGER; v_mismatch INTEGER;
BEGIN
  IF NOT COALESCE((SELECT s.enabled FROM cec_results_auto_settings s WHERE s.id = 1), false) THEN
    RETURN jsonb_build_object('skipped', 'disabled');
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('cec_results_auto_apply')) THEN
    RETURN jsonb_build_object('skipped', 'locked');
  END IF;
  v_limit := GREATEST(1, LEAST(COALESCE(p_limit, (SELECT s.batch_limit FROM cec_results_auto_settings s WHERE s.id = 1), 2000), 20000));

  IF p_dry_run THEN
    SELECT count(*) FILTER (WHERE a.write_result), count(*) FILTER (WHERE a.write_party), count(*) FILTER (WHERE a.mismatch)
      INTO v_plan_results, v_plan_parties, v_mismatch
      FROM cec_results_auto_plan() a;
    RETURN jsonb_build_object('dry_run', true, 'would_write_results', v_plan_results, 'would_write_parties', v_plan_parties, 'mismatches', v_mismatch);
  END IF;

  INSERT INTO cec_auto_apply_runs DEFAULT VALUES RETURNING id INTO v_run;

  WITH plan AS MATERIALIZED (
    SELECT * FROM cec_results_auto_plan() a
     WHERE a.write_result OR a.write_party
     ORDER BY a.politician_election_id
     LIMIT v_limit
  ),
  upd AS (
    UPDATE politician_elections pe
       SET candidacy_status = CASE WHEN p.write_result THEN CASE WHEN p.cec_elected THEN 'elected' ELSE 'not_elected' END ELSE pe.candidacy_status END,
           party_id = CASE WHEN p.write_party THEN p.new_party_id ELSE pe.party_id END,
           party_basis = CASE WHEN p.write_party THEN 'cec' ELSE pe.party_basis END
      FROM plan p
     WHERE pe.id = p.politician_election_id
       -- 寫之前再確認一次還是空白（計畫到這一句之間別人補了就不寫；只補空白、不覆蓋）
       AND (NOT p.write_result OR COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn'))
       AND (NOT p.write_party OR pe.party_basis IS NULL)
    RETURNING pe.id AS pe_id, p.write_result, p.write_party, p.cur_status, p.cur_party_id, p.new_party_id, p.cec_elected,
              p.election_id, p.election_type, p.county, p.cec_sub_region, p.cec_village, p.cec_cand_id, p.cec_theme_id, p.cec_party,
              p.unit_seats, p.unit_elected
  ),
  ins AS (
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name)
    SELECT 'politician_elections', u.pe_id::TEXT, f.field, f.old_v, f.new_v, NULL, 'cec-results-auto'
      FROM upd u
     CROSS JOIN LATERAL (VALUES
        ('candidacy_status', to_jsonb(u.cur_status), to_jsonb(CASE WHEN u.cec_elected THEN 'elected' ELSE 'not_elected' END), u.write_result),
        ('party_id', to_jsonb(u.cur_party_id), to_jsonb(u.new_party_id), u.write_party AND u.cur_party_id IS DISTINCT FROM u.new_party_id),
        ('party_basis', NULL::JSONB, to_jsonb('cec'::TEXT), u.write_party)
     ) AS f(field, old_v, new_v, ok)
     WHERE f.ok
    RETURNING id
  ),
  lg AS (
    INSERT INTO cec_results_auto_log (run_id, politician_election_id, evidence)
    SELECT v_run, u.pe_id,
           jsonb_build_object('source', '中選會選舉資料庫 API（db.cec.gov.tw，cec-sync 快照 cec_candidates）',
                              'wrote', jsonb_strip_nulls(jsonb_build_object('candidacy_status', CASE WHEN u.write_result THEN CASE WHEN u.cec_elected THEN 'elected' ELSE 'not_elected' END END,
                                                                            'party', CASE WHEN u.write_party THEN u.cec_party END)),
                              'unit', jsonb_build_object('election_id', u.election_id, 'election_type', u.election_type, 'region', u.county,
                                                         'sub_region', u.cec_sub_region, 'village', u.cec_village,
                                                         'seats', u.unit_seats, 'cec_elected', u.unit_elected),
                              'cec', jsonb_build_object('cand_id', u.cec_cand_id, 'theme_id', u.cec_theme_id, 'elected', u.cec_elected))
      FROM upd u
    RETURNING id
  )
  SELECT (SELECT count(*) FROM upd WHERE write_result), (SELECT count(*) FROM upd WHERE write_party),
         (SELECT min(id) FROM ins), (SELECT max(id) FROM ins), (SELECT count(*) FROM lg)
    INTO v_results, v_parties, v_first, v_last, v_logged;

  IF v_results = 0 AND v_parties = 0 THEN
    DELETE FROM cec_auto_apply_runs WHERE id = v_run;
    RETURN jsonb_build_object('run_id', NULL, 'results_written', 0, 'parties_written', 0);
  END IF;
  UPDATE cec_auto_apply_runs SET results_written = v_results, parties_written = v_parties, first_edit_id = v_first, last_edit_id = v_last WHERE id = v_run;
  RETURN jsonb_build_object('run_id', v_run, 'results_written', v_results, 'parties_written', v_parties, 'logged', v_logged, 'edit_history', jsonb_build_array(v_first, v_last));
END;
$$;
COMMENT ON FUNCTION cec_results_auto_apply IS
  '系統直接寫：中選會名單唯一對上、選區已開完的，補 candidacy_status 與推薦政黨（party_basis＝cec）。只補空白；每筆進 edit_history（agent_name＝cec-results-auto）、cec_results_auto_log 留證據；一次執行一個 run，整次可 cec_results_auto_revert。每 10 分鐘由 pg_cron 叫，一次最多 batch_limit 位（#678，2026-10-19）';

-- 整次還原：edit_history 的現值還是我們寫的那個值才倒回（別人後來改過的不動、算 blocked）。還原後那幾位又成空白，
-- 想讓系統不再補回去，先把 cec_results_auto_settings.enabled 關掉（派工臂這時會把它們派回給代理）
CREATE OR REPLACE FUNCTION cec_results_auto_revert(p_run_id BIGINT, p_by TEXT DEFAULT 'maintainer') RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  run cec_auto_apply_runs%ROWTYPE;
  r RECORD;
  v_reverted INTEGER := 0; v_blocked INTEGER := 0; v_n INTEGER;
BEGIN
  SELECT * INTO run FROM cec_auto_apply_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cec_auto_apply_runs % 不存在', p_run_id; END IF;
  IF run.reverted_at IS NOT NULL THEN RAISE EXCEPTION 'run % 已經在 % 還原過', p_run_id, run.reverted_at; END IF;

  FOR r IN
    SELECT h.record_id,
           jsonb_object_agg(h.field, jsonb_build_object('old', h.old_value, 'new', h.new_value)) AS f
      FROM edit_history h
     WHERE h.agent_name = 'cec-results-auto' AND h.table_name = 'politician_elections'
       AND h.id BETWEEN run.first_edit_id AND run.last_edit_id AND h.reverted_at IS NULL
     GROUP BY h.record_id
  LOOP
    UPDATE politician_elections pe
       SET candidacy_status = CASE WHEN r.f ? 'candidacy_status' THEN r.f -> 'candidacy_status' -> 'old' #>> '{}' ELSE pe.candidacy_status END,
           party_id = CASE WHEN r.f ? 'party_id' THEN (r.f -> 'party_id' -> 'old' #>> '{}')::BIGINT
                           WHEN r.f ? 'party_basis' THEN NULL ELSE pe.party_id END,
           party_basis = CASE WHEN r.f ? 'party_basis' THEN NULL ELSE pe.party_basis END
     WHERE pe.id = r.record_id::INTEGER
       AND (NOT r.f ? 'candidacy_status' OR pe.candidacy_status IS NOT DISTINCT FROM (r.f -> 'candidacy_status' -> 'new' #>> '{}'))
       AND (NOT r.f ? 'party_id' OR pe.party_id IS NOT DISTINCT FROM (r.f -> 'party_id' -> 'new' #>> '{}')::BIGINT)
       AND (NOT r.f ? 'party_basis' OR pe.party_basis IS NOT DISTINCT FROM (r.f -> 'party_basis' -> 'new' #>> '{}'));
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
      v_reverted := v_reverted + 1;
      UPDATE edit_history SET reverted_at = now(), reverted_by = p_by
       WHERE agent_name = 'cec-results-auto' AND table_name = 'politician_elections' AND record_id = r.record_id
         AND id BETWEEN run.first_edit_id AND run.last_edit_id AND reverted_at IS NULL;
    ELSE
      v_blocked := v_blocked + 1;
    END IF;
  END LOOP;

  UPDATE cec_auto_apply_runs SET reverted_at = now(), reverted_by = p_by WHERE id = p_run_id;
  RETURN jsonb_build_object('run_id', p_run_id, 'reverted', v_reverted, 'blocked', v_blocked);
END;
$$;
COMMENT ON FUNCTION cec_results_auto_revert IS
  '整次還原 cec_results_auto_apply 的一個 run：現值還是系統寫的那個值才倒回，別人後來改過的不動（blocked）；還原不會擋系統再補，要先關 cec_results_auto_settings.enabled（#678）';

REVOKE EXECUTE ON FUNCTION cec_results_auto_apply(INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION cec_results_auto_revert(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cec_results_auto_apply(INTEGER, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION cec_results_auto_revert(BIGINT, TEXT) TO service_role;

-- ── 5. 派工臂：只派「比對失敗」的 ─────────────────────────────
-- 補選舉結果（整批＋逐位＋不一致）：本體照 20261010170000 的版本，只多三處（auto CTE、units 排除系統寫得了的、最後 UNION 不一致）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_election_results()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  -- 系統自己寫得了的（唯一對上＋選區已開完）與「我們標的跟中選會相反」的，都從同一支計畫函式來；整支只算一次
  WITH auto AS MATERIALIZED (SELECT * FROM cec_results_auto_plan()),
  gap AS (
    SELECT pe.id
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
     -- 投票日之後才派：移到規則（activity_rules「election_results」：投票日 +1 起，P2 20261008070000）；這裡不再比日期
     WHERE COALESCE(pe.candidacy_status, '') NOT IN ('elected', 'not_elected', 'withdrawn')
  ),
  -- 已經有人交了、還在等票的不再派（同一份名單抄一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT (it->>'politician_election_id')::INTEGER AS id
      FROM contributions c
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'items') = 'array' THEN c.payload->'items' ELSE '[]'::jsonb END) it
     WHERE c.contribution_type = 'election_results' AND c.status IN ('pending', 'verified')
       AND (it->>'politician_election_id') ~ '^[0-9]{1,9}$'
  ),
  m AS (
    SELECT * FROM election_result_cec_matches(ARRAY(SELECT g.id FROM gap g WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.id = g.id)))
  ),
  units AS (
    SELECT m.*,
           CASE WHEN m.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN m.town END AS unit_town
      FROM m
     WHERE m.cec_hits = 1
       -- 唯一對上而且那個選區已開完的，由系統直接寫（cec_results_auto_apply），不派代理；
       -- 剩下的（應選名額還沒登錄、當選數對不上席次、同一位中選會名單被我們兩筆對到）才聚成批次派
       AND m.politician_election_id NOT IN (SELECT a.politician_election_id FROM auto a WHERE a.write_result)
  ),
  numbered AS (
    SELECT u.*,
           (row_number() OVER w - 1) / 120 + 1 AS part,
           (count(*) OVER (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town) - 1) / 120 + 1 AS parts
      FROM units u
    WINDOW w AS (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town
                 ORDER BY u.town NULLS LAST, u.village NULLS LAST, u.name, u.politician_election_id)
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts,
           count(*) AS items_count,
           jsonb_agg(n.politician_election_id ORDER BY n.town NULLS LAST, n.village NULLS LAST, n.name, n.politician_election_id) AS ids
      FROM numbered n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  )
  -- 批次：一個單位一件（超過 120 位拆成幾件）
  SELECT 'auto:election_results_missing:' || g.election_id || ':' || g.election_type || ':' || g.county
           || COALESCE(':' || g.unit_town, '') || CASE WHEN g.parts > 1 THEN ':p' || g.part ELSE '' END,
         'election_results_missing',
         jsonb_build_object('election_id', g.election_id, 'election_type', g.election_type, 'region', g.county,
                            'sub_region', g.unit_town, 'election_date', e.election_date,
                            'part', g.part, 'parts', g.parts, 'items_count', g.items_count,
                            'politician_election_ids', g.ids),
         g.county || COALESCE(g.unit_town, '') || ' ' || g.election_id || ' ' || g.election_type || '：'
           || '我們有 ' || g.items_count || ' 位參選人的選舉結果還空著'
           || CASE WHEN g.parts > 1 THEN '（這個單位太大，拆成 ' || g.parts || ' 件，這是第 ' || g.part || ' 件）' ELSE '' END
           || '，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。系統已經把「中選會名單唯一對上、而且那個選區已開完（標當選的人數＝應選席次）」的直接寫進去了；留給你的是系統確認不了的（這個選區的應選名額還沒登錄、當選數對不上席次、或同一位中選會名單被我們兩筆對到）。名單在 current.items：每一位附系統比對到的中選會那一列（cec），那是線索不是答案。'
           || '請打開中選會選舉資料庫這個單位的結果逐位核對（同名不同人要看選區、村里、出生年），交一筆 election_results：'
           || 'election_id 填 ' || g.election_id || '、election_type 填「' || g.election_type || '」、region 填「' || g.county || '」'
           || CASE WHEN g.unit_town IS NOT NULL THEN '、sub_region 填「' || g.unit_town || '」' ELSE '' END
           || '，items 每位一項 {politician_election_id, election_result：elected 或 not_elected}。核對不了或不是同一個人的不要放進 items，在 note 寫是哪幾位。'
           || 'source_urls 第一個放你核對的中選會那一頁。',
         ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：依屆別、選舉、縣市（鄉鎮）點到結果表，當選者有標記',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 個別查一位的歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 直接回中選會的當選與否'],
         1, g.county
    FROM grouped g
    JOIN elections e ON e.id = g.election_id
  UNION ALL
  -- 對不上的（同縣市同名多位、名單查無）：各自派 election_result_missing，附名單上同縣市同名的人請代理指認。
  -- 名下有政見的也在這裡派（20261010170000 起逐筆版 raw:election_result_missing 收掉，OPS #72）
  SELECT 'auto:election_result_missing:' || m.politician_election_id,
         'election_result_missing',
         jsonb_build_object('politician_id', m.politician_id, 'name', m.name, 'region', m.county,
                            'sub_region', m.town, 'village', m.village,
                            'election_id', m.election_id, 'election_type', m.election_type, 'election_date', e.election_date,
                            'cec_hits', m.cec_hits,
                            'cec_same_name', COALESCE((
                              SELECT jsonb_agg(jsonb_build_object('sub_region', cc.sub_region, 'village', cc.village, 'birth_year', cc.birth_year,
                                                                  'elected', cc.elected, 'cec_cand_id', cc.cec_cand_id, 'cec_theme_id', cc.cec_theme_id)
                                               ORDER BY cc.sub_region, cc.village)
                                FROM cec_candidates cc
                               WHERE cc.election_id = m.election_id AND cc.election_type = m.election_type
                                 AND cc.region = m.county AND cc.name_norm = cec_name_key(m.name)), '[]'::jsonb)),
         m.name || '（' || COALESCE(m.county, '') || COALESCE(' ' || m.town, '') || COALESCE(' ' || m.village, '') || ' '
           || m.election_id || ' ' || m.election_type || '）的選舉結果還空著，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。'
           || CASE WHEN m.cec_hits = 0 THEN '系統在中選會名單上找不到同縣市同名、地區也對得上的人（多半是地區或姓名寫錯）。'
                   ELSE '中選會名單上同縣市同名、地區也對得上的有 ' || m.cec_hits || ' 位，系統分不出是哪一位（target.cec_same_name）。' END
           || '請到中選會選舉資料庫核對他是哪一位，用 candidacy 補 election_result（elected 或 not_elected），帶 politician_id；'
           || '名單上真的沒有他、或確定不是同一個人，用 no_change 回報你查了哪些網址，不要猜。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || m.name || ' ← 中選會歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || m.name || '","electionId":' || m.election_id || '}'],
         1, m.county
    FROM m
    JOIN elections e ON e.id = m.election_id
   WHERE m.cec_hits <> 1
  UNION ALL
  -- 我們標的跟中選會不一樣：唯一對上、那個選區已開完，而且我們已經有結果（elected／not_elected）卻跟名單相反。
  -- 系統不覆蓋（維護者 2026-10-19：不一致才是缺口），派代理核對是不是同一個人、哪一邊錯。task_id 與逐位件同一個形式（這一筆不是空白，兩邊不會撞）
  SELECT 'auto:election_result_missing:' || x.politician_election_id,
         'election_result_missing',
         jsonb_build_object('kind', 'result_mismatch', 'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'sub_region', x.town, 'village', x.village,
                            'election_id', x.election_id, 'election_type', x.election_type, 'election_date', e.election_date,
                            'ours', jsonb_build_object('candidacy_status', x.cur_status),
                            'cec', jsonb_build_object('elected', x.cec_elected, 'sub_region', x.cec_sub_region, 'village', x.cec_village,
                                                      'birth_year', x.cec_birth_year, 'cec_cand_id', x.cec_cand_id, 'cec_theme_id', x.cec_theme_id),
                            'unit', jsonb_build_object('seats', x.unit_seats, 'cec_elected', x.unit_elected)),
         x.name || '（' || COALESCE(x.county, '') || COALESCE(' ' || x.town, '') || COALESCE(' ' || x.village, '') || ' '
           || x.election_id || ' ' || x.election_type || '）我們標的是「' || CASE WHEN x.cur_status = 'elected' THEN '當選' ELSE '落選' END
           || '」，但中選會這個選區已經開完（應選 ' || x.unit_seats || ' 席、名單上標當選 ' || x.unit_elected || ' 位），名單上同縣市同名、地區也對得上的他是「'
           || CASE WHEN x.cec_elected THEN '當選' ELSE '落選' END || '」，兩邊不一致。'
           || '請到中選會選舉資料庫核對：①是不是同一個人（同名不同人看選區、村里、出生年）；②他到底當選了沒有。'
           || '我們標錯了就用 candidacy 改 election_result（帶 politician_id，附中選會那一頁）；中選會那一列是別人、或名單本身有誤，就用 no_change 回報你查了哪些網址。'
           || '系統不會自動覆蓋我們已有的結果。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name || ' ← 中選會歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || x.name || '","electionId":' || x.election_id || '}',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, x.county
    FROM auto x
    JOIN elections e ON e.id = x.election_id
   WHERE x.mismatch
$$;

-- 補政黨：本體照 20261008120000 的版本，只多一處（排除系統寫得了的）
CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_gap()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    -- candidate_status＝交件協議的詞（派工說明「照現況填」那一句用），由 candidacy_status 換算，不是舊欄位
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, candidacy_protocol_status(pe.candidacy_status, candidacy_list_published(pe.election_id, pe.election_type, CURRENT_DATE)) AS candidate_status,
           p.id AS politician_id, p.name, p.party AS person_party,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id
      -- 投票日之後才派：移到規則（activity_rules「party_gap」：投票日 +1 起，P2 20261008120000）；這裡不再比日期
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.party_basis IS NULL
       -- 中選會名冊唯一對上而且那個選區已開完的，由系統直接寫（cec_results_auto_apply，party_basis＝cec），不派代理
       AND pe.id NOT IN (SELECT a.politician_election_id FROM cec_results_auto_plan() a WHERE a.write_party)
  ),
  m AS (
    -- 中選會名單上同屆、同選舉別、同縣市、同名只有一位（同名多位不派，免得指錯人）；名冊的政黨寫法要對得到（對不到的看 party_alias_gaps）
    SELECT g.*, c.name AS cec_name, c.region AS cec_region, c.sub_region AS cec_sub_region, c.village AS cec_village,
           c.party AS cec_party, c.cand_no, c.elected, c.cec_cand_id, c.cec_theme_id,
           a.party_id AS cec_party_id, a.kind = 'independent' AS cec_independent, pt.name AS cec_party_name
      FROM g
      JOIN LATERAL (
        SELECT x.*, count(*) OVER () AS n
          FROM cec_candidates x
         WHERE x.election_id = g.election_id AND x.election_type = g.election_type
           AND replace(x.region, '臺', '台') = g.county AND x.name_norm = cec_name_key(g.name)
      ) c ON c.n = 1
      JOIN party_aliases a ON a.alias_key = party_alias_key(c.party)
      LEFT JOIN parties pt ON pt.id = a.party_id
  ),
  x AS (
    SELECT m.*,
           -- candidacy 的地區欄位：照中選會那一筆填（跟 roster_cec_gap 同一套；縣市議員沒帶選舉區交件會被退回）
           CASE
             WHEN m.election_type = '村里長'
               THEN jsonb_build_object('region', m.county, 'sub_region', m.cec_sub_region, 'village', m.cec_village)
             WHEN m.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
               THEN jsonb_build_object('region', m.county, 'sub_region', NULLIF(regexp_replace(COALESCE(m.cec_sub_region, ''), '(第[0-9]+)?選舉區$', ''), ''))
             WHEN m.election_type IN ('鄉鎮市長', '直轄市山地原住民區長')
               THEN jsonb_build_object('region', m.county, 'sub_region', m.cec_sub_region)
             WHEN m.election_type IN ('縣市議員', '立法委員')
               THEN jsonb_build_object('region', m.county, 'electoral_district', m.cec_sub_region)
             ELSE jsonb_build_object('region', m.county)
           END AS fill,
           CASE WHEN m.elected THEN 'elected' ELSE 'not_elected' END AS cec_result
      FROM m
     -- 已經有人交了這一人這一屆的 candidacy 還在等票的先不派（落庫時就會寫政黨；退件了就會再派）
     WHERE NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = m.politician_id::TEXT AND c.payload->>'election_id' = m.election_id::TEXT)
  )
  SELECT 'auto:candidacy_source_missing:party:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('kind', 'party', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'missing', jsonb_build_array('party'),
                            'person_party', x.person_party,
                            'fill', x.fill,
                            'cec', jsonb_build_object('name', x.cec_name, 'region', x.cec_region, 'sub_region', x.cec_sub_region, 'village', x.cec_village,
                                                      'party', x.cec_party, 'cand_no', x.cand_no, 'elected', x.elected, 'election_result', x.cec_result,
                                                      'cec_cand_id', x.cec_cand_id, 'cec_theme_id', x.cec_theme_id),
                            'cec_party', jsonb_build_object('text', x.cec_party, 'party_id', x.cec_party_id, 'party_name', x.cec_party_name,
                                                            'independent', x.cec_independent)),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '）這一次參選的政黨我們不知道——'
           || '網站只看得到他現在登記的政黨（「' || COALESCE(x.person_party, '空的') || '」），過去的參選要記當時的政黨，人會換黨。'
           || '中選會名冊上這一屆的他（' || COALESCE(x.cec_region || COALESCE(' ' || x.cec_sub_region, '') || COALESCE(' ' || x.cec_village, ''), '')
           || COALESCE('，號次 ' || x.cand_no, '') || '，' || CASE WHEN x.elected THEN '當選' ELSE '落選' END
           || '）推薦政黨記的是「' || x.cec_party || '」'
           || CASE WHEN x.cec_independent THEN '（無黨籍）' WHEN x.cec_party_name IS NOT NULL AND x.cec_party_name <> x.cec_party THEN '（＝' || x.cec_party_name || '）' ELSE '' END || '。'
           || '請打開中選會選舉資料庫核對是同一個人後，用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、name 填「' || x.name
           || '」、election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、地區照 target.fill 填'
           || '、party 照名冊填「' || x.cec_party || '」（不要填他現在的政黨）、candidate_status 照現況填「' || COALESCE(x.candidate_status, '') || '」'
           || '、election_result 照中選會填 ' || x.cec_result || '；source_urls 附你核對的中選會頁面。'
           || '系統會拿中選會的資料自動核對：我們只有一位同名、當選與否與推薦政黨都對得上就直接上線。'
           || '名冊上的不是同一個人（同名同姓）就不要交 candidacy，改用 no_change 回報、finding 寫「掛錯人」；查不到就用 no_change 說明你查了哪些網址。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name || ' ← 中選會歷屆參選（含推薦政黨、當選與否）',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || x.name || '","electionId":' || x.election_id || '}',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, x.county
    FROM x
$$;

-- ── 6. 比對與系統票：選區沒開完不投 ─────────────────────────────
-- 本體照 20261006141500 的版本，只多兩處（unit_open 狀態與它用的 LEFT JOIN）
CREATE OR REPLACE FUNCTION election_results_compare(p_contribution_id UUID)
RETURNS TABLE (
  politician_election_id INTEGER, name TEXT, county TEXT, town TEXT, village TEXT, district TEXT,
  claimed TEXT, current_result TEXT, status TEXT, cec_hits INTEGER, cec_elected BOOLEAN,
  cec_sub_region TEXT, cec_village TEXT, cec_birth_year INTEGER, cec_cand_id INTEGER, cec_theme_id TEXT
)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT payload FROM contributions WHERE id = p_contribution_id AND contribution_type = 'election_results'
  ),
  items AS (
    SELECT CASE WHEN (t.it->>'politician_election_id') ~ '^[0-9]{1,9}$' THEN (t.it->>'politician_election_id')::INTEGER END AS pe_id,
           t.it->>'election_result' AS claimed, t.ord
      FROM c
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'items') = 'array' THEN c.payload->'items' ELSE '[]'::jsonb END)
           WITH ORDINALITY AS t(it, ord)
  ),
  m AS (
    SELECT * FROM election_result_cec_matches(ARRAY(SELECT i.pe_id FROM items i WHERE i.pe_id IS NOT NULL))
  )
  SELECT i.pe_id, m.name, m.county, m.town, m.village, m.district, i.claimed, m.current_result,
         CASE WHEN m.politician_election_id IS NULL THEN 'no_record'
              WHEN m.election_id::TEXT IS DISTINCT FROM (SELECT c.payload->>'election_id' FROM c)
                OR m.election_type IS DISTINCT FROM (SELECT c.payload->>'election_type' FROM c)
                OR m.county IS DISTINCT FROM replace((SELECT c.payload->>'region' FROM c), '臺', '台') THEN 'wrong_unit'
              WHEN m.cec_hits = 0 THEN 'not_found'
              WHEN m.cec_hits > 1 THEN 'ambiguous'
              -- 開票途中 cec_candidates.elected 是布林、未標當選會存成 false：選區沒開完（當選數沒到應選席次）、投票日剛過，
              -- 都不能拿來當「落選」。名額沒登錄的選區改看整場選舉是否過了結算天數（cec_results_settled）
              WHEN NOT (COALESCE(us.complete, false) OR cec_results_settled(m.election_id)) THEN 'unit_open'
              WHEN m.cec_elected IS NULL THEN 'unknown'
              WHEN (m.cec_elected AND i.claimed = 'elected') OR (NOT m.cec_elected AND i.claimed = 'not_elected') THEN 'match'
              ELSE 'differs' END,
         m.cec_hits, m.cec_elected, m.cec_sub_region, m.cec_village, m.cec_birth_year, m.cec_cand_id, m.cec_theme_id
    FROM items i
    LEFT JOIN m ON m.politician_election_id = i.pe_id
    LEFT JOIN cec_unit_status us ON m.cec_hits = 1
         AND us.unit_key = cec_unit_key(m.election_id, m.election_type, m.county, m.cec_sub_region, m.cec_village)
   ORDER BY i.ord
$$;
COMMENT ON FUNCTION election_results_compare IS
  '一筆 election_results 交件逐位跟中選會名單比（status：match／differs／ambiguous／not_found／unknown／wrong_unit／no_record／unit_open）。系統票與驗證項共用（2026-10-06）｜2026-10-19：選區沒開完（cec_unit_status.complete 不成立、而且整場還沒過結算天數）一律 unit_open，不算 match，開票途中的 false 不當落選';

-- 撿還沒核過的 election_results 跑系統票：本體照 20261006141500，只多一個條件（因 unit_open 沒投的，滿一小時再核）
CREATE OR REPLACE FUNCTION election_results_check_pending(p_limit INTEGER DEFAULT 50) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_n INTEGER := 0; v_supported INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.id FROM contributions c
     WHERE c.contribution_type = 'election_results' AND c.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM jev_decisions j
                        WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT
                          AND j.question = 'source_support' AND j.model LIKE 'policy-tw/cec-results-batch%'
                          -- 只因為選區還沒開完而沒投的（unit_open），滿一小時再核一次；其他一律核過就不再核
                          AND NOT (j.choice = 'cannot_tell' AND j.asked_at < now() - INTERVAL '1 hour' AND j.state::TEXT LIKE '%unit_open%'))
     ORDER BY c.created_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
  LOOP
    v_n := v_n + 1;
    IF election_results_system_check(r.id) = 'supported' THEN v_supported := v_supported + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_n, 'supported', v_supported);
END;
$$;

-- ── 7. 備註（接在原本的備註後面，只補一次） ─────────────────────────
DO $$
DECLARE
  v_er TEXT := obj_description('contribution_auto_tasks_election_results()'::regprocedure, 'pg_proc');
  v_pg TEXT := obj_description('contribution_auto_tasks_party_gap()'::regprocedure, 'pg_proc');
  v_ck TEXT := obj_description('election_results_check_pending(integer)'::regprocedure, 'pg_proc');
BEGIN
  IF v_er IS NOT NULL AND v_er NOT LIKE '%20261019100000%' THEN
    EXECUTE format('COMMENT ON FUNCTION contribution_auto_tasks_election_results IS %L',
      v_er || '｜2026-10-19（20261019100000，#678）：只派比對失敗的——中選會名單唯一對上、選區已開完的由系統直接寫（cec_results_auto_apply），不再派；批次只剩系統確認不了的（名額沒登錄、當選數對不上席次、同一位被我們兩筆對到）；多一段「我們標的跟中選會相反」的逐位件（target.kind＝result_mismatch）');
  END IF;
  IF v_pg IS NOT NULL AND v_pg NOT LIKE '%20261019100000%' THEN
    EXECUTE format('COMMENT ON FUNCTION contribution_auto_tasks_party_gap IS %L',
      v_pg || '｜2026-10-19（20261019100000，#678）：中選會名冊唯一對上、選區已開完的由系統直接寫（cec_results_auto_apply，party_basis＝cec），不再派；只派系統寫不了的');
  END IF;
  IF v_ck IS NOT NULL AND v_ck NOT LIKE '%20261019100000%' THEN
    EXECUTE format('COMMENT ON FUNCTION election_results_check_pending IS %L',
      v_ck || '｜2026-10-19（20261019100000，#678）：因選區沒開完（unit_open）沒投的，滿一小時再核一次');
  END IF;
END
$$;

-- ── 8. 狀態視圖與排程 ──────────────────────────────────────────
-- 正常時 pending_* 在每次排程後歸零（一次最多 batch_limit 位，第一次部署後會分幾輪）；mismatches 是派給代理的不一致件數
CREATE OR REPLACE VIEW cec_results_auto_status AS
  WITH p AS MATERIALIZED (SELECT * FROM cec_results_auto_plan())
  SELECT s.enabled, s.batch_limit,
         (SELECT count(*) FROM p WHERE p.write_result)::INTEGER AS pending_results,
         (SELECT count(*) FROM p WHERE p.write_party)::INTEGER AS pending_parties,
         (SELECT count(*) FROM p WHERE p.mismatch)::INTEGER AS mismatches,
         (SELECT max(r.ran_at) FROM cec_auto_apply_runs r WHERE r.reverted_at IS NULL) AS last_run_at,
         (SELECT count(*) FROM cec_auto_apply_runs r WHERE r.reverted_at IS NULL)::INTEGER AS runs
    FROM cec_results_auto_settings s
   WHERE s.id = 1;
COMMENT ON VIEW cec_results_auto_status IS
  '系統直接寫入的現況（一列）：還有多少位等著寫（pending_results／pending_parties，排程跑完應歸零）、不一致幾位（派給代理）、最近一次寫入時間、有效的 run 數。關掉開關時 pending 與 mismatches 都是 0（#678）';

DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'cec-results-auto-10min';
    -- 錯開 seed（*/10）與 cec-sync 開票夜的整點輪
    EXECUTE $q$SELECT cron.schedule('cec-results-auto-10min', '3,13,23,33,43,53 * * * *', 'SELECT cec_results_auto_apply();')$q$;
  END IF;
END
$$;
