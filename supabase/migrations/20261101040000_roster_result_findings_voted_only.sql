-- 名冊差異：「結果」類（缺人的當選、結果空白／不一致）只算投票日已過的屆
-- 起因：20261101020000 的 roster_diff_findings 把 election_results／elected_missing 兩臂的輸出直接當 finding，並寫死 voted=true。
--   但 election_results 臂的投票日條件早已移到 activity_rules（P2 20261008070000，「投票日 +1 起」），臂函式本身不比日期，
--   於是 2026（投票日 2026-11-28 還沒到）的 19,158 筆「結果」finding（635 個單位，其中 569 個單位只有結果差異、被開成 findings_only 的 roster_check）
--   冒出來。此處在兩條結果臂的 finding 上補 election_date < CURRENT_DATE（與 activity_rules 的「投票日 +1 起」同義）。
-- 已掛在 roster_check target.items 與 findings_only 任務上的 2026 結果項目：items 與任務都由總表每輪重算，函式改了下一輪 seed 就自動清掉、
--   findings_only 任務隨缺口消失收回，不另寫資料遷移。

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
  -- 以參選紀錄為單位的五種（任務編號最後一段就是 politician_elections.id）
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
  -- 當選名單有、站上沒有（已投票屆）
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
     WHERE ev.election_date < CURRENT_DATE  -- 投票日已過才有「結果」類差異
  ),
  -- 結果空白或不一致（已投票屆）：整批件展開成逐位，逐位件與「我們標的跟中選會相反」件直接用
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
       AND ev.election_date < CURRENT_DATE  -- 投票日已過才有「結果」類差異（election_results 臂不比日期，閘門在 activity_rules；這裡自己守）
  ),
  -- 縣市長縣市不符（單位＝官方名冊的縣市）
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
COMMENT ON FUNCTION roster_diff_findings IS '名冊類差異（finding）：缺人／政黨／鄉鎮／縣市／結果／掛錯人。結果類（elected_missing、election_results）只算投票日已過的屆。2026-11-01';
