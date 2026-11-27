-- 回滾 20261127093000_dispatch_gaps_phase2b.sql（第 2 期 PR-2）：整支可直接貼進 SQL 編輯器，一個交易跑完，不需要任何字串替換。
-- 只要退回即時算、不拆掉物件，用這兩行就夠（不需要這支檔）：
--   SELECT dispatch_gap_set_mode('roster_cec_gap', 'off'); roster_villages、district_seats、'raw:roster_check' 同樣；UPDATE dispatch_gap_settings SET events_enabled = false WHERE id = 1;
-- 這支是「徹底退回到 20261127044503（PR-1）的狀態」。前三段（①②③）貼完這支檔就做完了；第④段要你照註解貼 20261127044503_dispatch_gaps_phase2a.sql 的行範圍（那些行是完整的 CREATE OR REPLACE，不用改）。
--
-- 順序（照做，反過來會讓還掛著的觸發器下一次寫入就失敗）：
--   ① 清未處理事件、拔觸發器
--   ② 換回兩支舊簽名（先 DROP 帶 p_keys 的新簽名，再建無參數版）
--   ③ 換回 PR-1 的函式（見④的行範圍），再 DROP 本期新函式、取消四支臂的登記與常駐資料
BEGIN;

-- ① 未處理事件與觸發器 ------------------------------------------------------------
DELETE FROM dispatch_gap_events WHERE arm IN ('roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check') AND processed_at IS NULL;

DROP TRIGGER IF EXISTS trg_dispatch_gap_roster_checks ON roster_checks;
DROP TRIGGER IF EXISTS trg_dispatch_gap_roster_reconcile_units ON roster_reconcile_units;
DROP TRIGGER IF EXISTS trg_dispatch_gap_roster_check_scope ON roster_check_scope;
DROP TRIGGER IF EXISTS trg_dispatch_gap_election_districts ON election_districts;
DROP TRIGGER IF EXISTS trg_dispatch_gap_verification_sources ON verification_sources;
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_registration_sources ON cec_registration_sources;
DROP TRIGGER IF EXISTS trg_dispatch_gap_regions_stmt ON regions;
DROP TRIGGER IF EXISTS trg_dispatch_gap_electoral_district_areas_stmt ON electoral_district_areas;
DROP TRIGGER IF EXISTS trg_dispatch_gap_parties_stmt ON parties;
DROP TRIGGER IF EXISTS trg_dispatch_gap_party_aliases_stmt ON party_aliases;
DROP TRIGGER IF EXISTS trg_dispatch_gap_task_checks_owner ON task_checks;
DROP TRIGGER IF EXISTS trg_dispatch_gap_edit_history_pe ON edit_history;

-- contributions 觸發器換回 PR-1 的 WHEN（沒有 district_seats）
DROP TRIGGER IF EXISTS trg_dispatch_gap_contributions ON contributions;
CREATE TRIGGER trg_dispatch_gap_contributions
  AFTER INSERT OR UPDATE OF status, applied_policy_id
  ON contributions FOR EACH ROW
  WHEN (NEW.contribution_type IN ('policy', 'policy_subtopics', 'cand_numbers', 'candidacy', 'election_results', 'reassign_candidacy'))
  EXECUTE FUNCTION dispatch_gap_on_change();

-- cec_candidates 的三支語句層級觸發器補回（PR-1 的寫法）
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_ins ON cec_candidates;
CREATE TRIGGER trg_dispatch_gap_cec_candidates_ins
  AFTER INSERT ON cec_candidates REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_new();
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_upd ON cec_candidates;
CREATE TRIGGER trg_dispatch_gap_cec_candidates_upd
  AFTER UPDATE ON cec_candidates REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_new();
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_del ON cec_candidates;
CREATE TRIGGER trg_dispatch_gap_cec_candidates_del
  AFTER DELETE ON cec_candidates REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_old();

-- ② 兩支舊簽名 ------------------------------------------------------------------
DROP FUNCTION IF EXISTS cec_roster_diff(TEXT[]);
DROP FUNCTION IF EXISTS roster_diff_findings(TEXT[]);

-- cec_roster_diff()：20261031160000 的本體＋20261109210000 的 dup 排除已裁決不同人（已合成一份）
CREATE OR REPLACE FUNCTION cec_roster_diff()
RETURNS TABLE (kind TEXT, diff_key TEXT, election_type TEXT, county TEXT, town TEXT, unit TEXT, cand_no INTEGER,
               pe_id INTEGER, politician_id UUID, our_name TEXT, our_status TEXT, our_cand_no INTEGER,
               roster_id BIGINT, roster_name TEXT, roster_party TEXT, roster_birth TEXT, roster_url TEXT, roster_li_code TEXT,
               partner_pe_id INTEGER, partner_politician_id UUID, partner_name TEXT)
LANGUAGE sql STABLE SET enable_nestloop = off AS $fn$
  WITH
  fresh AS MATERIALIZED (
    SELECT u.election_type, replace(u.county, '臺', '台') AS county, replace(u.town, '臺', '台') AS town
      FROM cec_roster_units u WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'
  ),
  r AS MATERIALIZED (
    SELECT x.id, x.election_type, replace(x.county, '臺', '台') AS county, replace(x.town, '臺', '台') AS town, x.unit_key AS unit, x.name,
           COALESCE(x.name_key, roster_name_key(x.name)) AS nkey, x.cand_no, x.party, x.birth, x.unit_url, x.li_code
      FROM cec_roster_2026 x
      JOIN fresh f ON f.election_type = x.election_type AND f.county = replace(x.county, '臺', '台')
                  AND (x.election_type <> '村里長' OR f.town = replace(x.town, '臺', '台'))
  ),
  o0 AS MATERIALIZED (
    SELECT pe.id AS pe_id, pe.politician_id, p.name, roster_name_key(p.name) AS nkey, pe.election_type,
           replace(COALESCE(rg.region, p.region), '臺', '台') AS county,
           CASE WHEN pe.election_type = '村里長' THEN COALESCE(replace(rg.sub_region, '臺', '台'), '') ELSE '' END AS scope_town,
           pe.cand_no, pe.candidacy_status AS status, rg.sub_region, rg.village
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.election_id = 2026
       AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
       AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
  ),
  o AS MATERIALIZED (
    SELECT o0.*,
           CASE WHEN o0.election_type = '村里長'
                THEN CASE WHEN o0.scope_town <> '' THEN o0.county || '|' || o0.scope_town END
                ELSE cec_roster_norm_unit(ballot_number_unit(o0.election_type, o0.county, o0.sub_region, o0.sub_region, o0.village)) END AS unit
      FROM o0
     WHERE o0.county IS NOT NULL
       AND EXISTS (SELECT 1 FROM fresh f WHERE f.election_type = o0.election_type AND f.county = o0.county AND f.town = o0.scope_town)
  ),
  ro AS MATERIALIZED (SELECT r.*, row_number() OVER (PARTITION BY r.election_type, r.unit, r.nkey ORDER BY r.cand_no, r.id) AS rk FROM r),
  oo AS MATERIALIZED (SELECT o.*, row_number() OVER (PARTITION BY o.election_type, o.unit, o.nkey ORDER BY o.cand_no, o.pe_id) AS rk FROM o WHERE o.unit IS NOT NULL),
  m1 AS MATERIALIZED (
    SELECT oo.pe_id, ro.id AS rid FROM oo JOIN ro ON ro.election_type = oo.election_type AND ro.unit = oo.unit AND ro.nkey = oo.nkey AND ro.rk = oo.rk
  ),
  lo AS MATERIALIZED (SELECT o.* FROM o WHERE o.unit IS NOT NULL AND NOT EXISTS (SELECT 1 FROM m1 WHERE m1.pe_id = o.pe_id)),
  lr AS MATERIALIZED (SELECT r.* FROM r WHERE NOT EXISTS (SELECT 1 FROM m1 WHERE m1.rid = r.id)),
  m2 AS MATERIALIZED (
    SELECT lo.pe_id, lr.id AS rid FROM lo JOIN lr ON lr.election_type = lo.election_type AND lr.unit = lo.unit AND cec_name_fuzzy_eq(lo.nkey, lr.nkey, lo.cand_no, lr.cand_no)
  ),
  m3 AS MATERIALIZED (
    SELECT o.pe_id, r.id AS rid FROM o JOIN r ON r.election_type = o.election_type AND r.county = o.county
                                               AND (o.election_type <> '村里長' OR r.town = o.scope_town)
     WHERE o.unit IS NULL AND cec_name_fuzzy_eq(o.nkey, r.nkey, o.cand_no, r.cand_no)
  ),
  mo AS MATERIALIZED (SELECT pe_id FROM m1 UNION SELECT pe_id FROM m2 UNION SELECT pe_id FROM m3),
  mr AS MATERIALIZED (SELECT rid FROM m1 UNION SELECT rid FROM m2 UNION SELECT rid FROM m3),
  dg AS MATERIALIZED (
    SELECT DISTINCT ON (a.politician_id, b.politician_id)
           a.pe_id AS a_pe, a.politician_id AS a_pid, a.name AS a_name, b.pe_id AS b_pe, b.politician_id AS b_pid, b.name AS b_name,
           a.election_type, a.county, a.scope_town, a.unit, a.cand_no, rr.id AS rid, rr.name AS rname, rr.party AS rparty, rr.birth AS rbirth, rr.unit_url AS rurl, rr.li_code AS rli
      FROM o a
      JOIN o b ON b.election_type = a.election_type AND b.unit = a.unit AND b.cand_no = a.cand_no AND b.politician_id > a.politician_id
              AND COALESCE(b.village, '') = COALESCE(a.village, '')
      JOIN r rr ON rr.election_type = a.election_type AND rr.unit = a.unit AND rr.cand_no = a.cand_no
     WHERE a.unit IS NOT NULL AND a.cand_no IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM mo WHERE mo.pe_id = a.pe_id) OR NOT EXISTS (SELECT 1 FROM mo WHERE mo.pe_id = b.pe_id))
     ORDER BY a.politician_id, b.politician_id, rr.id
  ),
  dx AS MATERIALIZED (SELECT a_pe AS pe_id FROM dg UNION SELECT b_pe FROM dg),
  dr AS MATERIALIZED (SELECT rid FROM dg)
  SELECT 'extra', 'extra:' || o.pe_id, o.election_type, o.county, o.scope_town, o.unit, o.cand_no,
         o.pe_id, o.politician_id, o.name, o.status, o.cand_no,
         NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
         NULL::INTEGER, NULL::UUID, NULL::TEXT
    FROM o WHERE o.unit IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM mo WHERE mo.pe_id = o.pe_id) AND NOT EXISTS (SELECT 1 FROM dx WHERE dx.pe_id = o.pe_id)
  UNION ALL
  SELECT 'missing', 'missing:' || r.election_type || '|' || r.unit || '|' || r.li_code || '|' || COALESCE(r.cand_no::TEXT, '') || '|' || COALESCE(r.nkey, ''),
         r.election_type, r.county, CASE WHEN r.election_type = '村里長' THEN r.town ELSE '' END, r.unit, r.cand_no,
         NULL::INTEGER, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INTEGER,
         r.id, r.name, r.party, r.birth, r.unit_url, r.li_code,
         NULL::INTEGER, NULL::UUID, NULL::TEXT
    FROM (SELECT DISTINCT ON (x.election_type, x.unit, x.li_code, x.cand_no, x.nkey) x.*
            FROM r x WHERE NOT EXISTS (SELECT 1 FROM mr WHERE mr.rid = x.id) AND NOT EXISTS (SELECT 1 FROM dr WHERE dr.rid = x.id)
           ORDER BY x.election_type, x.unit, x.li_code, x.cand_no, x.nkey, x.id) r
  UNION ALL
  SELECT 'dup', 'dup:' || g.a_pid || '|' || g.b_pid, g.election_type, g.county, g.scope_town, g.unit, g.cand_no,
         g.a_pe, g.a_pid, g.a_name, NULL::TEXT, g.cand_no,
         g.rid, g.rname, g.rparty, g.rbirth, g.rurl, g.rli,
         g.b_pe, g.b_pid, g.b_name
    FROM dg g
   WHERE NOT EXISTS (SELECT 1 FROM politician_pair_resolutions x WHERE x.pair_key = g.a_pid::TEXT || '|' || g.b_pid::TEXT AND x.resolution = 'different')
$fn$;

-- roster_diff_findings()：20261101040000 的本體
CREATE OR REPLACE FUNCTION roster_diff_findings()
RETURNS TABLE (election_id INTEGER, election_type TEXT, county TEXT, town TEXT, voted BOOLEAN, kind TEXT,
               politician_id UUID, politician_election_id INTEGER, name TEXT,
               current_value JSONB, official_value JSONB, source_url TEXT, origin_task_id TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS MATERIALIZED (
              SELECT 'party_roster'::TEXT AS arm, t.* FROM contribution_auto_tasks_party_roster() t
    UNION ALL SELECT 'party_gap', t.* FROM contribution_auto_tasks_party_gap() t
    UNION ALL SELECT 'township_gap', t.* FROM contribution_auto_tasks_township_gap() t
    UNION ALL SELECT 'region_gap', t.* FROM contribution_auto_tasks_region_gap() t
    UNION ALL SELECT 'owner_mismatch', t.* FROM contribution_auto_tasks_owner_mismatch() t
  ),
  b AS MATERIALIZED (
    SELECT s.arm, s.task_id, s.target, pe.id AS pe_id, pe.election_id, pe.election_type, pe.candidacy_status,
           p.id AS pid, p.name, p.party AS person_party, p.birth_year,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county, r.region AS r_region, r.sub_region AS r_sub, r.village AS r_village,
           (e.election_date < CURRENT_DATE) AS voted
      FROM s
      JOIN politician_elections pe ON pe.id = (regexp_match(s.task_id, ':([0-9]+)$'))[1]::INTEGER
      JOIN politicians p ON p.id = pe.politician_id
      JOIN elections e ON e.id = pe.election_id
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE NOT politician_name_is_placeholder(p.name)
  ),
  pe_f AS (
    SELECT x.election_id, x.election_type, x.county, roster_unify_town(x.voted, x.election_type, x.r_sub) AS town, x.voted,
           CASE x.arm WHEN 'party_roster' THEN '政黨' WHEN 'party_gap' THEN '政黨' WHEN 'township_gap' THEN '鄉鎮' WHEN 'region_gap' THEN '縣市' ELSE '掛錯人' END AS kind,
           x.pid, x.pe_id, x.name,
           CASE x.arm
             WHEN 'party_roster' THEN jsonb_build_object('party', NULL, 'person_party', x.person_party, 'candidacy_status', x.candidacy_status)
             WHEN 'party_gap' THEN jsonb_build_object('party', NULL, 'person_party', x.person_party, 'candidacy_status', x.candidacy_status)
             WHEN 'township_gap' THEN jsonb_build_object('region', x.county, 'sub_region', NULL, 'village', x.r_village)
             WHEN 'region_gap' THEN jsonb_build_object('region', x.r_region, 'sub_region', x.r_sub, 'village', x.r_village, 'missing', x.target->'missing')
             ELSE jsonb_build_object('birth_year', x.birth_year, 'party', x.person_party, 'region', x.county, 'district', x.target->>'district', 'village', x.target->>'village',
                                     'other_records', x.target->'other_records')
           END AS cur,
           CASE x.arm
             WHEN 'party_roster' THEN jsonb_build_object('party_basis', '登記彙總表推薦之政黨欄', 'rosters', x.target->'rosters')
             WHEN 'party_gap' THEN jsonb_build_object('party', x.target->'cec'->>'party', 'cand_no', x.target->'cec'->'cand_no', 'election_result', x.target->'cec'->>'election_result',
                                                      'cec_party', x.target->'cec_party', 'fill', x.target->'fill')
             WHEN 'township_gap' THEN jsonb_build_object('need', CASE WHEN x.election_type = '村里長' THEN '鄉鎮市區與村里' ELSE '鄉鎮市區' END)
             WHEN 'region_gap' THEN jsonb_build_object('cec_districts', x.target->'cec_districts', 'cec_party', x.target->'cec_party', 'cec_source_url', x.target->'cec_source_url')
             ELSE jsonb_build_object('signals', x.target->'signals', 'same_name', x.target->'same_name', 'cec_same_name', x.target->'cec_same_name')
           END AS off,
           CASE x.arm
             WHEN 'party_roster' THEN COALESCE(x.target->'rosters'->>0, 'https://web.cec.gov.tw/central/article/64709')
             WHEN 'party_gap' THEN 'https://db.cec.gov.tw/ElecTable/Election'
             WHEN 'owner_mismatch' THEN 'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name
             ELSE COALESCE(x.target->>'cec_source_url', CASE WHEN x.voted THEN 'https://db.cec.gov.tw/ElecTable/Election' ELSE 'https://web.cec.gov.tw/central/article/64709' END)
           END AS url,
           x.task_id
      FROM b x
  ),
  em AS (
    SELECT (t.target->>'election_id')::INTEGER AS election_id, t.target->>'election_type' AS election_type,
           replace(t.target->>'region', '臺', '台') AS county, ''::TEXT AS town, true AS voted, '缺人'::TEXT AS kind,
           NULL::UUID AS pid, NULL::INTEGER AS pe_id, t.target->>'name' AS name,
           jsonb_build_object('record', NULL, 'same_name_politicians', t.target->'same_name_politicians') AS cur,
           jsonb_build_object('elected', true, 'region', t.target->>'region', 'sub_region', t.target->>'sub_region',
                              'cec_cand_id', t.target->'cec_cand_id', 'cec_theme_id', t.target->>'cec_theme_id') AS off,
           'https://db.cec.gov.tw/ElecTable/Election'::TEXT AS url, t.task_id
      FROM contribution_auto_tasks_elected_missing() t
      JOIN elections ev ON ev.id = (t.target->>'election_id')::INTEGER
     WHERE ev.election_date < CURRENT_DATE
  ),
  er AS MATERIALIZED (SELECT t.* FROM contribution_auto_tasks_election_results() t),
  er_ids AS (
    SELECT er.task_id, er.target, x.id::INTEGER AS pe_id,
           CASE WHEN er.target->>'kind' = 'result_mismatch' THEN 'result_mismatch' WHEN er.task_type = 'election_results_missing' THEN 'result_blank' ELSE 'result_unmatched' END AS sub
      FROM er
      CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(er.target->'politician_election_ids') AS id WHERE er.task_type = 'election_results_missing'
        UNION ALL SELECT (regexp_match(er.task_id, ':([0-9]+)$'))[1] WHERE er.task_type <> 'election_results_missing'
      ) x
     WHERE x.id IS NOT NULL
  ),
  cm AS MATERIALIZED (SELECT * FROM election_result_cec_matches(ARRAY(SELECT DISTINCT i.pe_id FROM er_ids i))),
  er_f AS (
    SELECT c.election_id, c.election_type, c.county,
           roster_unify_town(true, c.election_type, c.town) AS town, true AS voted, '結果'::TEXT AS kind,
           c.politician_id AS pid, c.politician_election_id AS pe_id, c.name,
           jsonb_build_object('candidacy_status', c.current_result, 'region', c.county, 'sub_region', c.town, 'village', c.village, 'district', c.district) AS cur,
           CASE WHEN i.sub = 'result_mismatch'
                THEN jsonb_build_object('elected', i.target->'cec'->'elected', 'sub_region', i.target->'cec'->>'sub_region', 'cec_cand_id', i.target->'cec'->'cec_cand_id',
                                        'cec_theme_id', i.target->'cec'->>'cec_theme_id', 'unit', i.target->'unit', 'kind', 'result_mismatch')
                ELSE jsonb_build_object('elected', c.cec_elected, 'cec_hits', c.cec_hits, 'sub_region', c.cec_sub_region, 'cec_cand_id', c.cec_cand_id,
                                        'cec_theme_id', c.cec_theme_id, 'cec_same_name', i.target->'cec_same_name', 'kind', i.sub) END AS off,
           'https://db.cec.gov.tw/ElecTable/Election'::TEXT AS url, i.task_id
      FROM er_ids i
      JOIN cm c ON c.politician_election_id = i.pe_id
      JOIN elections ev ON ev.id = c.election_id
     WHERE NOT politician_name_is_placeholder(c.name)
       AND ev.election_date < CURRENT_DATE
  ),
  rm AS (
    SELECT m.election_id, '縣市長'::TEXT AS election_type, m.official_county AS county, ''::TEXT AS town, false AS voted, '縣市'::TEXT AS kind,
           m.politician_id AS pid, m.politician_election_id AS pe_id, m.name,
           jsonb_build_object('region', m.cur_county, 'region_id', m.current_region_id, 'kind', 'region_mismatch') AS cur,
           jsonb_build_object('region', m.official_county, 'proposed_region_id', m.proposed_region_id, 'fix', 'correction 改 politician_elections.region_id') AS off,
           m.source_url AS url, NULL::TEXT AS task_id
      FROM roster_region_mismatch_findings() m
  )
  SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM pe_f f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM em f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM er_f f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM rm f
$$;

-- ③ PR-1 的函式：換回前，先停在這裡，把下面五個範圍從 supabase/migrations/20261127044503_dispatch_gaps_phase2a.sql 貼進來（各是完整的 CREATE OR REPLACE，不用改）：
--    第 106 到 117 行  dispatch_gap_scope_key
--    第 157 到 172 行  dispatch_gap_enqueue_units
--    第 179 到 218 行  dispatch_gap_recompute_roster_unit_findings
--    第 221 到 302 行  dispatch_gap_recompute_roster_gap_units
--    第 531 到 800 行  dispatch_gap_on_change、dispatch_gap_on_batch_new、dispatch_gap_on_batch_old
--    第 806 到 817 行  dispatch_gap_date_flip_roster
--    （行號以 20261127044503 那支檔為準，檔案沒被改過；那支檔的函式在檔內順序就是上面這樣）

-- 再 DROP 本期新函式（上面換回之後它們沒有呼叫者）、取消四支臂的登記與常駐資料
DELETE FROM dispatch_gap_arm_keys WHERE arm IN ('roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check');
UPDATE dispatch_gap_arms SET mode = 'off' WHERE arm IN ('roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check');
DELETE FROM dispatch_gaps WHERE arm IN ('roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check');
DROP FUNCTION IF EXISTS dispatch_gap_recompute_roster_cec_gap(TEXT[]);
DROP FUNCTION IF EXISTS dispatch_gap_recompute_roster_villages(TEXT[]);
DROP FUNCTION IF EXISTS dispatch_gap_recompute_district_seats(TEXT[]);
DROP FUNCTION IF EXISTS dispatch_gap_recompute_raw_roster_check(TEXT[]);
DROP FUNCTION IF EXISTS dispatch_gap_full_raw_roster_check();
DROP FUNCTION IF EXISTS dispatch_gap_enqueue_cec_units(JSONB);
DROP FUNCTION IF EXISTS dispatch_gap_enqueue_seats(INTEGER, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS dispatch_gap_seats_keys(INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS dispatch_gap_enqueue_roster_arms(INTEGER, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS dispatch_gap_seats_scope(TEXT);
DROP FUNCTION IF EXISTS dispatch_gap_seats_unit_key(INTEGER, TEXT, TEXT);
DROP FUNCTION IF EXISTS dispatch_gap_on_stmt();

COMMIT;
-- Edge Function cec-sync 結尾那幾行（enqueueCecUnits）留著無害：函式被 DROP 後 rpc 回錯誤，只會警告一行、不影響同步；要乾淨就還原 supabase/functions/cec-sync/index.ts 與刪 _shared/dispatch-gap-events.ts。
