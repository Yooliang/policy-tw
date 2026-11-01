-- 名單清查收斂：名冊類差異併進既有的 roster_check（一個地區／選舉單位一張任務）
-- ============================================================
--
-- 起因（小良哥 2026-11-01 核准「併」；機制梳理報告第 1-A、2-1、3 節）：同一個人同一個單位可能同時掛在 roster_check（缺人）、party_roster／party_gap（缺政黨）、
--   township_gap（缺鄉鎮）、region_gap（缺縣市或選區）、elected_missing／election_results（當選或結果）、owner_mismatch（掛錯人）幾張任務上，
--   代理一個一個領、一次只補一個欄位；縣市長的縣市不符（region_mismatch）又是落庫當下開的另一個佇列。
--
-- 做法（不改常設原則：資料一律走代理交件＋同儕驗證，系統不直接寫參選欄位；官方名單只當代理的提示與派工判準）：
--   1. 名冊差異函式 roster_diff_findings()：輸出 finding（單位、人、差異種類：缺人／政黨／鄉鎮／縣市／結果／掛錯人，附現值、官方值、官方來源網址）。
--      各種差異的算法不重寫——沿用原本各臂的函式（它們都還在，臂停用不是刪除），這裡把它們的輸出對應到單位；縣市長縣市不符（2026）改由官方名冊鏡像
--      直接算（roster_region_mismatch_findings：我們記的縣市名冊上沒有他、別的縣市名冊上只有一位同名者）。
--   2. 單位彙總 roster_unit_findings()：一個單位一列，items（每列含 kind、name、current、official、source_url、origin_task_id；最多 120 項）。
--      單位＝任務編號 auto:roster_check:<屆>:<單位>:<選舉別>，跟原本 raw／roster_villages／roster_cec_gap 三處產的同一個編號：
--      單位已經有 roster_check 就把 items 掛上去（target.items），沒有就為這個單位開一張（target.findings_only）。派工判準＝該單位有任一 finding。
--   3. 總表 contribution_auto_tasks_arms()：原臂（party_roster、party_gap、township_gap、region_gap、elected_missing、election_results、owner_mismatch）
--      在 roster_unify_settings.enabled 為真時停止產生任務（分支留著，關掉開關就回復）；單位清查掛 items。
--      單位清查的臂名沿用：已投票屆＝roster_cec_gap、2026 村里長＝roster_villages、其餘 2026＝raw:roster_check（時間窗與優先規則照這幾支臂的）。
--   4. 已開的舊任務：roster_unify_close_merged()（本檔結尾跑一次，之後每次都可重跑）——舊臂的任務已經在單位清查的 items 裡的，從派工佇列收回，
--      gap_events 記 closed（reason＝rule_change，detail 帶 via＝roster_unify 與 merged_into＝併入的單位任務編號）；沒有對到單位的由 seed 照一般缺口消失收回。
--      region_mismatch 是 contribution_tasks 裡的手動任務，不硬關：讓它自然結束（落庫當下不再為單位清查已列出的差異開新任務，見 roster_unify_lists_region_mismatch）。
--   5. 號次（ballot_numbers／cand_no）不併：它已經是依單位，但自有 cand_numbers 整批交件、cand_no_front_pull 插隊與 11/28 自停，每週 8,960 筆交件的量與驗證流程
--      跟名冊差異不同；併進去會讓一個單位的名冊差異被號次任務的插隊秒數與冷卻拖著走。保留獨立臂，單位清查的 items 不含號次。
--
-- 回復：UPDATE roster_unify_settings SET enabled = false WHERE id = 1; —— 原臂下一輪 seed 重新產生任務，單位清查不再掛 items、不再開 findings_only 任務。
-- 守門：_shared/roster-unify.test.ts（PGlite：finding 產生、派工判準、原臂停用、舊任務併入關閉，每條有還原驗證）。

-- ------------------------------------------------------------
-- 1. 開關
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roster_unify_settings (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     BOOLEAN NOT NULL DEFAULT true,
  max_items   INTEGER NOT NULL DEFAULT 120 CHECK (max_items BETWEEN 20 AND 400),
  note        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO roster_unify_settings (id, enabled, note)
VALUES (1, true, '單列參數：enabled＝false 讓原臂（party_roster、party_gap、township_gap、region_gap、elected_missing、election_results、owner_mismatch）恢復產生任務、單位清查不再掛 items；max_items＝一個單位清查最多列幾項。2026-11-01')
ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE roster_unify_settings IS '名單清查收斂的開關與每單位項數上限（單列）；改值走 migration 的 UPDATE，審計進 edit_history（2026-11-01）';
ALTER TABLE roster_unify_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_unify_settings_read ON roster_unify_settings;
CREATE POLICY roster_unify_settings_read ON roster_unify_settings FOR SELECT USING (true);
GRANT SELECT ON roster_unify_settings TO anon, authenticated;
DROP TRIGGER IF EXISTS trg_roster_unify_settings_audit ON roster_unify_settings;
CREATE TRIGGER trg_roster_unify_settings_audit AFTER INSERT OR UPDATE OR DELETE ON roster_unify_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

CREATE OR REPLACE FUNCTION roster_unify_on() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT s.enabled FROM roster_unify_settings s WHERE s.id = 1), false)
$$;
COMMENT ON FUNCTION roster_unify_on IS '名冊類差異是否併進單位清查（roster_unify_settings.enabled）；總表用它停用原臂、掛 items。2026-11-01';

-- ------------------------------------------------------------
-- 2. 縣市長縣市不符（2026）：官方名冊鏡像直接算
-- ------------------------------------------------------------
-- 我們記的縣市有新鮮的官方名冊（3 天內抓成功）、那份名冊上沒有他，別的縣市的名冊上只有一位同名者→縣市可能記錯。
-- 單位＝官方名冊那個縣市（他應該在的地方）；current 是我們現在記的縣市，official 是名冊縣市與 regions 的縣市層級 id（correction 改 region_id 用）。
CREATE OR REPLACE FUNCTION roster_region_mismatch_findings()
RETURNS TABLE (politician_election_id INTEGER, politician_id UUID, name TEXT, election_id INTEGER, cur_county TEXT, official_county TEXT,
               proposed_region_id INTEGER, current_region_id INTEGER, source_url TEXT)
LANGUAGE sql STABLE AS $$
  WITH fresh AS MATERIALIZED (
    SELECT DISTINCT replace(u.county, '臺', '台') AS county
      FROM cec_roster_units u
     WHERE u.election_type = '縣市長' AND u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'
  ),
  r AS MATERIALIZED (
    SELECT replace(x.county, '臺', '台') AS county, COALESCE(x.name_key, roster_name_key(x.name)) AS nk, x.unit_url
      FROM cec_roster_2026 x
     WHERE x.election_type = '縣市長' AND replace(x.county, '臺', '台') IN (SELECT f.county FROM fresh f)
  ),
  o AS MATERIALIZED (
    SELECT pe.id AS pe_id, p.id AS pid, p.name, pe.election_id, pe.region_id,
           replace(COALESCE(rg.region, p.region), '臺', '台') AS county, roster_name_key(p.name) AS nk
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE pe.election_id = 2026 AND pe.election_type = '縣市長' AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
       AND NOT politician_name_is_placeholder(p.name)
       -- 現在記的是縣市層級（跟 correction 改 region_id 的落庫守門同一條件）
       AND (pe.region_id IS NULL OR (rg.sub_region IS NULL AND rg.village IS NULL))
  )
  SELECT o.pe_id, o.pid, o.name, o.election_id, o.county, w.county, g.id, o.region_id, w.unit_url
    FROM o
    CROSS JOIN LATERAL (SELECT min(x.county) AS county, min(x.unit_url) AS unit_url, count(*) AS n FROM r x WHERE x.nk = o.nk AND x.county <> o.county) w
    LEFT JOIN LATERAL (SELECT rg.id FROM regions rg WHERE replace(rg.region, '臺', '台') = w.county AND rg.sub_region IS NULL AND rg.village IS NULL ORDER BY rg.id LIMIT 1) g ON true
   WHERE o.county IS NOT NULL
     AND w.n = 1
     AND EXISTS (SELECT 1 FROM fresh f WHERE f.county = o.county)
     AND NOT EXISTS (SELECT 1 FROM r x WHERE x.nk = o.nk AND x.county = o.county)
$$;
COMMENT ON FUNCTION roster_region_mismatch_findings IS '縣市長（2026）縣市不符：我們記的縣市有新鮮的官方名冊、名冊上沒有他，別的縣市只有一位同名者。單位清查列出（kind＝縣市），取代落庫當下開的 region_mismatch 任務。2026-11-01';

-- 落庫當下用：這個差異單位清查已經列出來了嗎（列出了就不再另開 region_mismatch 任務）
CREATE OR REPLACE FUNCTION roster_unify_lists_region_mismatch(p_pe_id INTEGER, p_proposed_region_id INTEGER) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT roster_unify_on() AND EXISTS (
    SELECT 1 FROM roster_region_mismatch_findings() f WHERE f.politician_election_id = p_pe_id AND f.proposed_region_id = p_proposed_region_id)
$$;

-- ------------------------------------------------------------
-- 3. 名冊差異（finding）
-- ------------------------------------------------------------
-- 單位的算法：已投票屆（投票日已過）村里長、鄉鎮市民代表、原住民區民代表以「縣市＋鄉鎮」為單位（同 roster_cec_gap）；
--   還沒投票的屆只有村里長以鄉鎮為單位（同 roster_villages），其餘都是縣市（同 raw 的 roster_check）；縣市長與議員、立委一律縣市。
CREATE OR REPLACE FUNCTION roster_unify_town(p_voted BOOLEAN, p_type TEXT, p_sub_region TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN (p_voted AND p_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')) OR p_type = '村里長'
              THEN COALESCE(NULLIF(replace(regexp_replace(COALESCE(p_sub_region, ''), '(第[0-9]+)?選舉區$', ''), '臺', '台'), ''), '')
              ELSE '' END
$$;

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
     WHERE NOT politician_name_is_placeholder(c.name)
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
COMMENT ON FUNCTION roster_diff_findings IS '名冊類差異（finding）：缺人／政黨／鄉鎮／縣市／結果／掛錯人，每筆帶單位、人、現值、官方值、官方來源網址與舊任務編號。算法沿用原本各臂的函式（臂停用不刪），縣市長縣市不符由官方名冊鏡像算。2026-11-01';

-- 單位清查的小工具（先於 roster_unit_findings 定義：SQL 函式本體在建立時就檢查引用的函式存在）
-- 掛在 roster_check target 上的欄位（單位已經有清查任務時用；findings_only 的任務也用同一份）
CREATE OR REPLACE FUNCTION roster_unify_extra(p_items JSONB, p_count INTEGER, p_kinds JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('items', p_items, 'items_count', p_count, 'items_kinds', COALESCE(p_kinds, '{}'::JSONB),
                            'items_truncated', p_count > COALESCE(jsonb_array_length(p_items), 0))
$$;

CREATE OR REPLACE FUNCTION roster_unify_kinds_text(p_kinds JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(string_agg(k.key || ' ' || k.value, '、' ORDER BY k.key), '') FROM jsonb_each_text(COALESCE(p_kinds, '{}'::JSONB)) k
$$;

-- 怎麼處理每一種（掛在說明後面；細節在 skill-types.md 的 roster_check 一節）
CREATE OR REPLACE FUNCTION roster_unify_text(p_count INTEGER, p_voted BOOLEAN) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT '【逐項核對】target.items 每項有 kind（缺人／政黨／鄉鎮／縣市／結果／掛錯人）、name、current（我們的現值）、official（官方值）、source_url（官方來源網址）、origin_task_id（併進來的舊任務編號）。'
    || '同名不代表同一人，先看 current 與 official 是不是同一個人再動手；每一項各用既有的交件型別、各走自己的驗證門檻：'
    || '缺人→candidacy（補一筆參選紀錄）；政黨、鄉鎮、縣市（缺或錯的欄位）→candidacy 重交同一人同一屆（politician_id、election_id、election_type 照 item，補上該欄位）；'
    || '縣市長縣市不符（item.official.proposed_region_id）→correction 改 politician_elections.region_id；結果空白或不一致→candidacy 補 election_result，同單位多位可用 election_results 整批交；'
    || '掛錯人→reassign_candidacy，確認是同一人就 no_change（outcome=confirmed）。官方資料有誤、現值才對的項目用 no_change 說明並附來源，不要硬改。'
    || CASE WHEN p_voted THEN '這一屆已經投票，官方名單在中選會選舉資料庫（db.cec.gov.tw）。' ELSE '這一屆還沒投票，官方名單是中選會登記彙總表與選舉專區候選人 JSON。' END
$$;

-- 既有的 roster_check（cec_gap 的 target.missing）轉成缺人項（總表用，讓同一個單位的所有差異在 target.items 一次看齊）
CREATE OR REPLACE FUNCTION roster_unify_missing_items(p_target JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'kind', '缺人', 'name', m->>'name', 'current', jsonb_build_object('region', p_target->>'county', 'record', NULL),
           'official', (m - 'name'), 'source_url', 'https://db.cec.gov.tw/ElecTable/Election'))), '[]'::JSONB)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_target->'missing') = 'array' THEN p_target->'missing' ELSE '[]'::JSONB END) m
$$;

-- ------------------------------------------------------------
-- 4. 單位彙總：一個單位一列
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION roster_unit_findings()
RETURNS TABLE (task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT, voted BOOLEAN,
               items JSONB, items_count INTEGER, kinds JSONB, origin_task_ids TEXT[], target JSONB, what_we_need TEXT, hint_sources TEXT[])
LANGUAGE sql STABLE AS $$
  WITH cap AS (SELECT COALESCE((SELECT s.max_items FROM roster_unify_settings s WHERE s.id = 1), 120) AS n),
  f AS MATERIALIZED (
    SELECT d.*, d.county || d.town AS unit,
           'auto:roster_check:' || d.election_id || ':' || d.county || d.town || ':' || d.election_type AS tid,
           jsonb_strip_nulls(jsonb_build_object('kind', d.kind, 'name', d.name, 'politician_id', d.politician_id, 'politician_election_id', d.politician_election_id,
                                                'current', d.current_value, 'official', d.official_value, 'source_url', d.source_url, 'origin_task_id', d.origin_task_id)) AS item,
           CASE d.kind WHEN '缺人' THEN 1 WHEN '結果' THEN 2 WHEN '縣市' THEN 3 WHEN '鄉鎮' THEN 4 WHEN '政黨' THEN 5 ELSE 6 END AS krank
      FROM roster_diff_findings() d
  ),
  k AS (SELECT x.tid, jsonb_object_agg(x.kind, x.n) AS kinds FROM (SELECT f.tid, f.kind, count(*) AS n FROM f GROUP BY 1, 2) x GROUP BY x.tid),
  g AS (
    SELECT f.tid, f.election_id, f.election_type, f.county, f.town, f.unit, bool_or(f.voted) AS voted, count(*)::INTEGER AS n,
           jsonb_path_query_array(jsonb_agg(f.item ORDER BY f.krank, f.name, f.politician_election_id NULLS LAST, f.origin_task_id), ('$[0 to ' || ((SELECT cap.n FROM cap) - 1) || ']')::jsonpath) AS items,
           array_agg(DISTINCT f.origin_task_id) FILTER (WHERE f.origin_task_id IS NOT NULL) AS origins
      FROM f GROUP BY f.tid, f.election_id, f.election_type, f.county, f.town, f.unit
  )
  SELECT g.tid,
         CASE WHEN g.voted THEN 'roster_cec_gap' WHEN g.election_type = '村里長' THEN 'roster_villages' ELSE 'raw:roster_check' END,
         g.election_id, g.election_type, g.county, g.town, g.unit, g.voted, g.items, g.n, k.kinds, COALESCE(g.origins, ARRAY[]::TEXT[]),
         jsonb_build_object('election_id', g.election_id, 'region', g.unit, 'county', g.county, 'township', NULLIF(g.town, ''), 'election_type', g.election_type,
                            'findings_only', true, 'voted', g.voted) || roster_unify_extra(g.items, g.n, k.kinds),
         g.unit || ' ' || g.election_id || ' ' || g.election_type || '名冊差異：這個單位有 ' || g.n || ' 項要核對（' || roster_unify_kinds_text(k.kinds) || '），逐項列在 target.items。'
           || roster_unify_text(g.n, g.voted)
           || '全部處理完用 roster_check 收尾（election_id、region、election_type 照 target 原樣帶回，region 就是「' || g.unit || '」這一串；cec_count 可留空，note 寫處理了哪幾項）；'
           || '只處理一部分就不要交 roster_check——差異還在，系統下一輪會把剩下的項目再列出來。',
         CASE WHEN g.voted
              THEN ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：選該屆、該選舉、該縣市（鄉鎮）看完整名單與得票',
                         'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 逐位核對歷屆參選與當選',
                         'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":' || g.election_id || '}']
              ELSE ARRAY['https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表',
                         'https://info.cec.gov.tw/vote2026/static/json/ ← 中選會選舉專區候選人名單（含號次）',
                         g.county || '選舉委員會官網的登記公告'] END
    FROM g
    LEFT JOIN k ON k.tid = g.tid
$$;
COMMENT ON FUNCTION roster_unit_findings IS '名冊差異按單位彙總（一個單位一列、items 最多 roster_unify_settings.max_items 項）：task_id 與 raw／roster_villages／roster_cec_gap 的 roster_check 同一個編號。總表掛 items 或為只有差異的單位開一張。2026-11-01';

-- ------------------------------------------------------------
-- 5. 已開的舊任務併入關閉
-- ------------------------------------------------------------
-- 舊臂的任務（派工列）若已經在某個單位清查的 items 裡（origin_task_id 對得上），從佇列收回並在 gap_events 記併入哪一張；之後可重跑。
-- 收回走 task_dispatches 的刪除觸發器寫 closed（reason＝rule_change）；contribution_tasks 的手動任務（region_mismatch）不碰。
CREATE OR REPLACE FUNCTION roster_unify_close_merged() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE r RECORD; n INTEGER := 0;
BEGIN
  IF NOT roster_unify_on() THEN RETURN 0; END IF;
  PERFORM set_config('gap.close_reason', 'rule_change', true);
  FOR r IN
    SELECT d.task_id AS old_id, m.task_id AS unit_task_id
      FROM task_dispatches d
      JOIN (SELECT u.task_id, o.origin FROM roster_unit_findings() u CROSS JOIN LATERAL unnest(u.origin_task_ids) AS o(origin)) m ON m.origin = d.task_id
     WHERE d.task_id ~ '^auto:(candidacy_source_missing:(party:)?[0-9]+|election_results?_missing:.+|candidacy_owner_mismatch:[0-9]+)$'
     ORDER BY d.task_id
  LOOP
    PERFORM set_config('gap.close_detail', jsonb_build_object('via', 'roster_unify', 'merged_into', r.unit_task_id)::TEXT, true);
    DELETE FROM task_dispatches WHERE task_id = r.old_id;
    n := n + 1;
  END LOOP;
  PERFORM set_config('gap.close_reason', '', true);
  PERFORM set_config('gap.close_detail', '', true);
  RETURN n;
END;
$$;
COMMENT ON FUNCTION roster_unify_close_merged IS '舊臂已開的派工列併入單位清查而收回（gap_events closed，reason＝rule_change，detail.merged_into＝單位任務編號）；開關關著不做事，可重跑。2026-11-01';

REVOKE ALL ON FUNCTION roster_unify_lists_region_mismatch(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION roster_unify_close_merged() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION roster_unify_lists_region_mismatch(INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION roster_unify_close_merged() TO service_role;

-- ------------------------------------------------------------
-- 6. 總表（前一版＝20261011120000_traffic_watch_arms.sql；機械式替換三處，標記 >>> 名單清查收斂）
-- ------------------------------------------------------------

-- 單位已經有清查任務時：既有的缺人清單（cec_gap 的 target.missing）加上這個單位的名冊差異，合成 target.items；沒有任何項目回 NULL
CREATE OR REPLACE FUNCTION roster_unify_attach(p_target JSONB, p_items JSONB, p_count INTEGER, p_kinds JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  WITH a AS (
    SELECT roster_unify_missing_items(p_target) || COALESCE(p_items, '[]'::JSONB) AS items,
           jsonb_array_length(roster_unify_missing_items(p_target)) AS mn
  )
  SELECT CASE WHEN jsonb_array_length(a.items) = 0 THEN NULL
              ELSE roster_unify_extra(a.items, a.mn + COALESCE(p_count, 0),
                                      COALESCE(p_kinds, '{}'::JSONB) || CASE WHEN a.mn > 0 THEN jsonb_build_object('缺人', a.mn + COALESCE((p_kinds->>'缺人')::INTEGER, 0)) ELSE '{}'::JSONB END) END
    FROM a
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),
       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）
       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),
       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),
       -- >>> 名單清查收斂：名冊類差異按單位彙總（開關關著就不算）；原臂在開關開著時停用，單位清查掛 items（見 20261101020000）
       fnd AS MATERIALIZED (SELECT * FROM roster_unit_findings() WHERE roster_unify_on()),
       -- <<< 名單清查收斂
       tagged0 AS (
  SELECT 'raw:' || r.task_type AS arm, r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END AS what_we_need,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
  UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t
  UNION ALL SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM contribution_auto_tasks_mismatch() t
  UNION ALL SELECT 'policy_dup' AS arm, t.* FROM contribution_auto_tasks_policy_dup() t
  UNION ALL SELECT 'not_running' AS arm, t.* FROM contribution_auto_tasks_not_running() t
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t
  UNION ALL SELECT 'roster_villages' AS arm, t.* FROM contribution_auto_tasks_roster_villages() t
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'roster_cec_gap' AS arm, t.* FROM contribution_auto_tasks_roster_cec_gap() t
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM contribution_auto_tasks_district_seats() t
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM contribution_auto_tasks_policy_elements() t
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM contribution_auto_tasks_lineage_candidates() t
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM contribution_auto_tasks_handover_missing() t
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM contribution_auto_tasks_lineage_roles() t
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM contribution_auto_tasks_lineage_links() t
  UNION ALL SELECT 'career_sources' AS arm, t.* FROM contribution_auto_tasks_career_sources() t
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM contribution_auto_tasks_withdrawn_filing() t
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t
       ),
       -- >>> 名單清查收斂：單位已經有 roster_check（raw、roster_villages、roster_cec_gap）就掛 items；沒有、但有差異的單位開一張（findings_only）
       tagged AS (
  SELECT t0.arm, t0.task_id, t0.task_type, t0.target || COALESCE(x.extra, '{}'::JSONB) AS target,
         CASE WHEN x.extra IS NULL THEN t0.what_we_need
              ELSE t0.what_we_need || ' ' || roster_unify_text((x.extra->>'items_count')::INTEGER, COALESCE(f.voted, t0.target->>'list_source' = 'cec', false)) END AS what_we_need,
         t0.hint_sources, t0.reward, t0.region
    FROM tagged0 t0
    LEFT JOIN fnd f ON t0.task_type = 'roster_check' AND f.task_id = t0.task_id
    CROSS JOIN LATERAL (SELECT CASE WHEN t0.task_type = 'roster_check' AND roster_unify_on() THEN roster_unify_attach(t0.target, f.items, f.items_count, f.kinds) END AS extra) x
  UNION ALL
  SELECT f.arm, f.task_id, 'roster_check', f.target, f.what_we_need, f.hint_sources, 2, f.county
    FROM fnd f
   WHERE NOT EXISTS (SELECT 1 FROM tagged0 t0 WHERE t0.task_id = f.task_id)
       ),
       -- <<< 名單清查收斂
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       -- >>> 村里長進度：target 沒有職位的臂（進度追蹤的 progress_stale、deadline_due），若這支臂有規則要看職位（except_election_types 排除清單或 election_types 正向清單，任何一種），職位從人物在那一屆的參選紀錄補；其餘臂的分組一個字不變
       -- 兩種都要看：只看排除清單的話，排除規則一被停用，職位全是 NULL，「村里長、要流量」那條正向規則就永遠比對不到、缺口被無聲收回（agy 審查 #480）
       needs_etype AS MATERIALIZED (SELECT DISTINCT r.activity FROM activity_rules r WHERE r.enabled AND (r.except_election_types IS NOT NULL OR r.election_types IS NOT NULL)
                                    -- >>> 有人看才追：來源臂一律補職位（要照職位決定歸不歸流量臂）
                                    UNION SELECT s.arm FROM unnest(traffic_watch_source_arms()) AS s(arm)
                                    -- <<< 有人看才追
                                   ),
       -- <<< 村里長進度
       keyed0 AS (
  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid,
         COALESCE(NULLIF(g.target->>'election_type', ''),
                  CASE WHEN g.arm IN (SELECT n.activity FROM needs_etype n)
                       THEN (SELECT pe.election_type FROM politician_elections pe
                              WHERE pe.politician_id = uuid_or_null(g.target->>'politician_id') AND pe.election_id = election_id_or_null(g.target->>'election_id')
                              ORDER BY pe.id LIMIT 1) END) AS etype
    FROM tagged g
       ),
       -- >>> 有人看才追：來源臂裡、職位在 traffic_watch_levels 開著的列，改歸流量臂 traffic:<型別>（task_id、內容一個字不變，只換臂名）；其餘照舊
       traffic_levels AS MATERIALIZED (SELECT l.election_type FROM traffic_watch_levels l WHERE l.enabled),
       keyed AS (
  SELECT CASE WHEN k.arm = ANY (traffic_watch_source_arms()) AND k.etype IN (SELECT t.election_type FROM traffic_levels t)
              THEN traffic_watch_arm(k.arm) ELSE k.arm END AS arm,
         k.task_id, k.task_type, k.target, k.what_we_need, k.hint_sources, k.reward, k.region, k.eid, k.etype
    FROM keyed0 k
       ),
       -- <<< 有人看才追
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE activity_require_rule(x.arm) OFFSET 0) k  -- 每組（約 84 組）檢查一次；OFFSET 0 擋住檢查被推到 7 千多列上去
    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們
      SELECT * FROM activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o ON true
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         CASE WHEN w.ok THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until,
           'traffic_gate', CASE WHEN g.arm LIKE 'traffic:%' THEN true END)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
    -- >>> 流量開窗：窗口有開（o.source），而且是流量臂（traffic:）時，這一列的人物頁或政見頁要在 page_traffic_hot；沒開的列照舊（旗標 gap.arms_all 開著時留下，opened_by 是 NULL）
    CROSS JOIN LATERAL (SELECT o.source IS NOT NULL AND (g.arm NOT LIKE 'traffic:%' OR EXISTS (
           SELECT 1 FROM page_traffic_hot h
            WHERE (h.kind = 'politician' AND h.target_id = g.target->>'politician_id') OR (h.kind = 'policy' AND h.target_id = g.target->>'policy_id'))) AS ok) w
    -- <<< 流量開窗
   WHERE (w.ok OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
     AND (g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT)))
$$;

COMMENT ON FUNCTION contribution_auto_tasks_arms IS '派工總表。20261101020000：名冊類差異併進 roster_check（原臂在 roster_unify_settings.enabled 為真時停用；單位清查掛 target.items）';

-- ------------------------------------------------------------
-- 7. 已開的舊任務併入關閉（一次；失敗不擋 migration，seed 會照一般缺口消失收回）
-- ------------------------------------------------------------
DO $$
DECLARE v INTEGER;
BEGIN
  EXECUTE 'SET LOCAL statement_timeout = 0';
  v := roster_unify_close_merged();
  RAISE NOTICE 'roster_unify_close_merged：收回 % 列', v;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'roster_unify_close_merged 失敗（%），舊任務交給 seed 收回', SQLERRM;
END $$;

-- ------------------------------------------------------------
-- 8. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT roster_unify_on() THEN RAISE EXCEPTION 'roster_unify_settings 開關沒有開'; END IF;
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'roster_unify_on()') = 0 THEN
    RAISE EXCEPTION '總表沒有帶上名單清查收斂的閘';
  END IF;
END $$;
