-- 派工臂事件驅動化 第 2 期 PR-1：名單清查整族（前半）——roster_unit_findings／roster_gap_units／ballot_numbers 的按鍵重算、事件入列、切 shadow（派工輸出不變）
--
-- 設計文件：docs/dispatch-arms-event-driven-plan.md 第 5 節「第 2 期」與附錄 A.1／A.3。接第 1 期（20261126193000）。
--
-- 這一支做的事（派工輸出一個字不變；總表、seed、三支臂本體都不碰）：
--   ① 三支按鍵重算函式 dispatch_gap_recompute_roster_unit_findings／_roster_gap_units／_ballot_numbers(p_keys text[])：
--      與現行函式的本體逐字相同，只在「單位」那一層多一行鍵過濾（見各函式上方註解）；登記進 dispatch_gap_arm_keys，drain 遇到沒有 '*' 的批次就走按鍵版。
--      roster_unit_findings、roster_gap_units 是總表的輔助函式（fnd／gapu 兩個 CTE），不是 UNION 分支，所以沒有「臂模式」影響總表：
--      切 shadow 只代表常駐表維護與雙軌比對，總表永遠不讀它們（第 3 節已知限制）。ballot_numbers 是總表的真分支，shadow 時總表照舊即時算。
--   ② 重算單位與缺口鍵（scope_key；gap_key 仍是 task_id）：
--        roster_unit_findings、roster_gap_units：task_id＝auto:roster_check:<選舉>:<縣市＋鄉鎮>:<職位>  → scope_key＝unit:<選舉>:<縣市＋鄉鎮>:<職位>（臺→台）
--        ballot_numbers：task_id＝auto:candidacy_source_missing:cand_no[_recheck]:<選舉>:<職位>:<縣市>[:<鄉鎮>][:p<N>] → scope_key＝ballot:<選舉>:<職位>:<縣市>:<鄉鎮或空>
--          （同一個單位的 cand_no、cand_no_recheck 與所有分件 pN 同一個鍵；ROW_NUMBER 每 50 人切件，單位內增減一人後面的件全部位移，所以只能整單位重算，不能單人）
--      兩種鍵的組法只在 dispatch_gap_scope_key()（task_id → 鍵）與 dispatch_gap_roster_unit_key()／dispatch_gap_ballot_unit_key()（資料欄位 → 鍵）兩處，
--      測試逐筆驗兩邊對得上。
--   ③ 事件來源（只在影響缺口的欄位變動時入列）：
--        politician_elections（加 cand_no、party_id、party_basis、withdrawn_after_filing 進欄位清單）、politicians（加 birth_year、party）、
--        contributions（加 cand_numbers、candidacy、election_results、reassign_candidacy 型別；從 payload 組單位，組不出就整臂 '*'）、
--        elections（投票日變更）、election_milestones（抽籤、名單公告日）、contribution_tasks（參選狀態查證任務，補號次臂會讓開）、roster_unify_settings（開關與項數上限）。
--      名冊同步是批次寫入，不逐列觸發：
--        cec_roster_units：官方名冊鏡像每個單位同步完最後一步一定 UPDATE 這張表一列（cec_roster_replace_unit 的結尾），所以在這張表的列層級觸發器入列該單位（約每天 440 次）；
--        cec_candidates、cec_registrations：語句層級觸發器（轉換表），一個語句最多入一筆整臂 '*'（沒有影響到任何列就不入）。
--      另提供 dispatch_gap_enqueue_units(選舉, 職位, 縣市, 鄉鎮, 原因)：給「同步函式結束處一次入列受影響單位」用。Edge Function 端要呼叫它的話另一支 PR 補
--      （現在不呼叫也不漏：上面的觸發器已經涵蓋名冊同步的寫入路徑）。
--      時間造成的翻轉沒有資料變更：投票日前後（roster 的 voted、補號次的窗口）新增 pg_cron dispatch-gap-date-flip-roster（UTC 00:06 與 16:06）補整臂事件；
--      官方名冊鏡像「3 天內抓成功」的過期不是事件，靠每小時雙軌比對與每日對帳補。
--   ④ 三支臂切 shadow；初始灌入（整臂對帳一次，約 7 秒）；最後對三支補一筆整臂事件（灌入與掛觸發器之間漏掉的變更）。
--
-- 與現行觸發器的關係：
--   politician_elections、politicians、contributions 三支觸發器各重建一次（欄位清單與 WHEN 變寬，其餘不變）；dispatch_gap_on_change() 以 20261126193000 版為底重定義，
--   原有三支臂（legacy、mismatch、issue_too_broad）的入列行為一個字不變（新增的欄位只走名單族分支，舊分支的「欄位有沒有變」判斷仍用舊清單）。
--
-- 回滾（互不依賴）：
--   取消排程：SELECT cron.unschedule('dispatch-gap-date-flip-roster');
--   退回即時算：SELECT dispatch_gap_set_mode('ballot_numbers', 'off'); roster_unit_findings、roster_gap_units 同樣（本來就沒有被總表讀）。
--   關事件：UPDATE dispatch_gap_settings SET events_enabled = false WHERE id = 1;（所有觸發器直接 RETURN）
--   新增的觸發器：DROP TRIGGER trg_dispatch_gap_election_milestones ON election_milestones; DROP TRIGGER trg_dispatch_gap_cec_roster_units ON cec_roster_units;
--     DROP TRIGGER trg_dispatch_gap_contribution_tasks ON contribution_tasks; DROP TRIGGER trg_dispatch_gap_roster_unify_settings ON roster_unify_settings;
--     cec_candidates、cec_registrations 各三支：trg_dispatch_gap_<表名>_ins／_upd／_del。
--   三支被重建的觸發器換回 20261126193000 的欄位清單與 WHEN；dispatch_gap_on_change() 換回 20261126193000 的定義。
--   按鍵版改回整表保底：UPDATE dispatch_gap_arm_keys SET recompute_fn = NULL WHERE arm IN ('roster_unit_findings','roster_gap_units','ballot_numbers');
--   登記與物件：DELETE FROM dispatch_gap_arm_keys WHERE arm IN (上面三支)；DROP FUNCTION 本檔新增的函式（清單見自我檢查之前的 COMMENT）；dispatch_gap_scope_key() 換回 20261126170000 的定義。
--
-- 風險：部署時多跑約 7 秒（初始灌入）；第一輪 seed 開頭的 drain 再補整臂約 7 秒；shadow 期間每小時比對多約 7 秒（三支整表函式各一次）。
--   按鍵重算的成本：ballot_numbers 在單位層級過濾（window 函式的分區就是單位）；roster_unit_findings、roster_gap_units 的鍵過濾在「單位彙總」那一層，
--   底下的 roster_diff_findings()、cec_roster_diff() 仍整表算一次（它們是跨七支臂函式的合併，沒有單位參數），所以一批事件的成本約等於一次整臂；
--   事件入列與消化的接線與一致性先上，成本壓低（把鍵推進 roster_diff_findings）留給 PR-2。
--   CREATE TRIGGER 取表鎖，放在最後、SET LOCAL lock_timeout 30 秒，拿不到就整支失敗（重跑即可）。

-- ------------------------------------------------------------
-- 1. 鍵的組法（資料欄位 → 鍵；task_id → 鍵在 dispatch_gap_scope_key）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_roster_unit_key(p_eid INTEGER, p_unit TEXT, p_etype TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'unit:' || p_eid || ':' || replace(p_unit, '臺', '台') || ':' || p_etype
$$;

CREATE OR REPLACE FUNCTION dispatch_gap_ballot_unit_key(p_eid INTEGER, p_etype TEXT, p_county TEXT, p_town TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'ballot:' || p_eid || ':' || p_etype || ':' || replace(p_county, '臺', '台') || ':' || COALESCE(replace(p_town, '臺', '台'), '')
$$;

-- 補號次 task_id 的單位鍵（去掉型別前綴與分件尾巴 :pN，剩下 <選舉>:<職位>:<縣市>[:<鄉鎮>]）
CREATE OR REPLACE FUNCTION dispatch_gap_ballot_scope(p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_task_id ~ '^auto:candidacy_source_missing:cand_no(_recheck)?:[0-9]+:[^:]+:[^:]+'
    THEN dispatch_gap_ballot_unit_key(
           split_part(s.rest, ':', 1)::INTEGER, split_part(s.rest, ':', 2), split_part(s.rest, ':', 3), NULLIF(split_part(s.rest, ':', 4), ''))
    ELSE p_task_id
  END
  FROM (SELECT regexp_replace(regexp_replace(p_task_id, '^auto:candidacy_source_missing:cand_no(_recheck)?:', ''), ':p[0-9]+$', '') AS rest) s
$$;

CREATE OR REPLACE FUNCTION dispatch_gap_roster_scope(p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_task_id ~ '^auto:roster_check:[0-9]+:[^:]*:[^:]+$'
    THEN dispatch_gap_roster_unit_key(split_part(p_task_id, ':', 3)::INTEGER, split_part(p_task_id, ':', 4), split_part(p_task_id, ':', 5))
    ELSE p_task_id
  END
$$;

-- gap_key（task_id）→ 重算單位 scope_key（20261126170000 版加三支名單族臂；其餘臂與規則一字不變）
CREATE OR REPLACE FUNCTION dispatch_gap_scope_key(p_arm TEXT, p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_arm
    WHEN 'legacy'               THEN 'policy:' || regexp_replace(p_task_id, '^.*:', '')
    WHEN 'mismatch'             THEN 'policy:' || regexp_replace(p_task_id, '^.*:', '')
    WHEN 'issue_too_broad'      THEN 'issue:' || regexp_replace(p_task_id, '^auto:issue_too_broad:', '')
    WHEN 'roster_unit_findings' THEN dispatch_gap_roster_scope(p_task_id)
    WHEN 'roster_gap_units'     THEN dispatch_gap_roster_scope(p_task_id)
    WHEN 'ballot_numbers'       THEN dispatch_gap_ballot_scope(p_task_id)
    ELSE p_task_id
  END
$$;

-- 一個「選舉、職位、縣市、鄉鎮或選舉區」可能對到的單位鍵（不去查選舉是否已投票：已投票與未投票兩種切法都列，多出來的鍵重算後什麼都沒有，無害）
CREATE OR REPLACE FUNCTION dispatch_gap_roster_keys(p_eid INTEGER, p_etype TEXT, p_county TEXT, p_sub TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(
    SELECT DISTINCT dispatch_gap_roster_unit_key(p_eid, replace(p_county, '臺', '台') || t.town, p_etype)
      FROM (VALUES (roster_unify_town(true, p_etype, p_sub)),
                   (roster_unify_town(false, p_etype, p_sub)),
                   (CASE WHEN p_etype = '村里長' THEN COALESCE(replace(p_sub, '臺', '台'), '') ELSE '' END)) AS t(town)
     ORDER BY 1)
$$;

-- 補號次的單位鍵：派工單位的「鄉鎮」依職位與資料來源（參選紀錄的 sub_region、代表去掉選舉區）有三種寫法，全列
CREATE OR REPLACE FUNCTION dispatch_gap_ballot_keys(p_eid INTEGER, p_etype TEXT, p_county TEXT, p_sub TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(
    SELECT DISTINCT dispatch_gap_ballot_unit_key(p_eid, p_etype, p_county, t.town)
      FROM (VALUES (NULL::TEXT), (NULLIF(p_sub, '')), (NULLIF(regexp_replace(COALESCE(p_sub, ''), '(第[0-9]+)?選舉區$', ''), ''))) AS t(town)
     ORDER BY 1)
$$;

-- 入列受影響的單位（公開給同步函式用）：roster_unit_findings、roster_gap_units（只有 2026）、ballot_numbers 三支；沒登記的臂不入。回傳這次真的新增幾筆事件
CREATE OR REPLACE FUNCTION dispatch_gap_enqueue_roster_units(p_eid INTEGER, p_etype TEXT, p_county TEXT, p_sub TEXT, p_kind TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_k TEXT;
  v_n INTEGER := 0;
BEGIN
  IF p_eid IS NULL OR COALESCE(p_etype, '') = '' OR COALESCE(btrim(p_county), '') = '' THEN
    RETURN 0;
  END IF;
  FOREACH v_k IN ARRAY dispatch_gap_roster_keys(p_eid, p_etype, p_county, p_sub) LOOP
    IF dispatch_gap_enqueue_reg('roster_unit_findings', v_k, p_kind) THEN v_n := v_n + 1; END IF;
    IF p_eid = 2026 AND dispatch_gap_enqueue_reg('roster_gap_units', v_k, p_kind) THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch_gap_enqueue_units(p_eid INTEGER, p_etype TEXT, p_county TEXT, p_sub TEXT DEFAULT NULL, p_kind TEXT DEFAULT 'manual') RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_k TEXT;
  v_n INTEGER;
BEGIN
  v_n := dispatch_gap_enqueue_roster_units(p_eid, p_etype, p_county, p_sub, p_kind);
  IF p_eid IS NULL OR COALESCE(p_etype, '') = '' OR COALESCE(btrim(p_county), '') = '' THEN
    RETURN v_n;
  END IF;
  FOREACH v_k IN ARRAY dispatch_gap_ballot_keys(p_eid, p_etype, p_county, p_sub) LOOP
    IF dispatch_gap_enqueue_reg('ballot_numbers', v_k, p_kind) THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- ------------------------------------------------------------
-- 2. 三支按鍵重算函式（輸出欄位與原函式相同；p_keys 是 dispatch_gap_scope_key 的 scope_key，'*' 不會送進來——整臂走整表函式）
-- ------------------------------------------------------------

-- roster_unit_findings：與 20261101020000 的 roster_unit_findings() 逐字相同，只在 f 的來源（roster_diff_findings()）加一行鍵過濾
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_roster_unit_findings(p_keys TEXT[])
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
     WHERE dispatch_gap_roster_unit_key(d.election_id, d.county || d.town, d.election_type) = ANY (p_keys)
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

-- roster_gap_units：與 20261103010000 的 roster_gap_units() 逐字相同（含 SET enable_nestloop = off），只在最後的 SELECT 加一行鍵過濾
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_roster_gap_units(p_keys TEXT[])
RETURNS TABLE (task_id TEXT, arm TEXT, election_id INTEGER, election_type TEXT, county TEXT, town TEXT, unit TEXT,
               items JSONB, items_count INTEGER, kinds JSONB, target JSONB, what_we_need TEXT, hint_sources TEXT[])
LANGUAGE sql STABLE SET enable_nestloop = off AS $fn$
  WITH cap AS (SELECT COALESCE((SELECT s.max_items FROM roster_unify_settings s WHERE s.id = 1), 120) AS n),
  fresh AS MATERIALIZED (
    SELECT u.election_type, replace(u.county, '臺', '台') AS county, replace(u.town, '臺', '台') AS town
      FROM cec_roster_units u WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'
  ),
  -- 官方有、本站沒有（人物不存在，或不在這個單位）
  ms AS MATERIALIZED (
    SELECT d.election_type, d.county, d.town, d.unit, d.cand_no, d.roster_name AS name, d.roster_party AS party, d.roster_birth AS birth,
           d.roster_url AS url, d.roster_li_code AS li, rr.district,
           CASE WHEN length(COALESCE(d.roster_birth, '')) >= 7 THEN 1911 + NULLIF(substr(d.roster_birth, 1, 3), '')::INTEGER
                WHEN length(COALESCE(d.roster_birth, '')) = 6 THEN 1911 + NULLIF(substr(d.roster_birth, 1, 2), '')::INTEGER END AS birth_year
      FROM cec_roster_diff() d
      LEFT JOIN cec_roster_2026 rr ON rr.id = d.roster_id
     WHERE d.kind = 'missing' AND d.roster_name IS NOT NULL AND btrim(d.roster_name) <> ''
  ),
  -- 官方有號次、本站已有此人（同單位、同姓名鍵）卻沒有 cand_no
  cn AS MATERIALIZED (
    SELECT DISTINCT ON (pe.id) pe.id AS pe_id, pe.politician_id AS pid, p.name, pe.election_type, o.county, o.scope_town AS town,
           r.cand_no, r.party, r.birth, r.unit_url AS url, r.li_code AS li, r.district, rg.village
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions rg ON rg.id = pe.region_id
      CROSS JOIN LATERAL (SELECT replace(COALESCE(rg.region, p.region), '臺', '台') AS county,
                                 CASE WHEN pe.election_type = '村里長' THEN COALESCE(replace(rg.sub_region, '臺', '台'), '') ELSE '' END AS scope_town) o
      JOIN fresh f ON f.election_type = pe.election_type AND f.county = o.county AND f.town = o.scope_town
      JOIN cec_roster_2026 r ON r.election_type = pe.election_type AND replace(r.county, '臺', '台') = o.county
                            AND (pe.election_type <> '村里長' OR replace(r.town, '臺', '台') = o.scope_town)
                            AND r.cand_no IS NOT NULL
                            AND COALESCE(r.name_key, roster_name_key(r.name)) = roster_name_key(p.name)
                            AND r.unit_key = CASE WHEN pe.election_type = '村里長' THEN o.county || '|' || o.scope_town
                                                  ELSE cec_roster_norm_unit(ballot_number_unit(pe.election_type, o.county, rg.sub_region, rg.sub_region, rg.village)) END
                            AND (pe.election_type <> '村里長' OR rg.village IS NULL OR r.li_code = right(rg.admin_code, 3))
     WHERE pe.election_id = 2026 AND pe.cand_no IS NULL AND pe.candidacy_status IS DISTINCT FROM 'withdrawn'
       AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
       AND o.county IS NOT NULL
     ORDER BY pe.id, r.cand_no
  ),
  it AS MATERIALIZED (
    SELECT m.election_type, m.county, m.town, 1 AS ord, m.name AS sort_name, m.cand_no AS sort_no,
           jsonb_strip_nulls(jsonb_build_object(
             'kind', '缺人', 'name', m.name,
             'current', jsonb_build_object('region', m.county, 'record', NULL),
             'official', jsonb_build_object('village', v.village, 'district', NULLIF(m.district, ''), 'unit', m.unit, 'cand_no', m.cand_no, 'party', m.party,
                                            'birth_roc', m.birth, 'birth_year', m.birth_year),
             'source_url', m.url)) AS item
      FROM ms m
      LEFT JOIN LATERAL (
        SELECT g.village FROM regions g
         WHERE m.election_type = '村里長' AND m.li ~ '^[0-9]{3}$' AND g.village IS NOT NULL
           AND replace(g.region, '臺', '台') = m.county AND replace(g.sub_region, '臺', '台') = m.town AND right(g.admin_code, 3) = m.li
         ORDER BY g.id LIMIT 1) v ON true
    UNION ALL
    SELECT c.election_type, c.county, c.town, 2, c.name, c.cand_no,
           jsonb_strip_nulls(jsonb_build_object(
             'kind', '缺號次', 'name', c.name, 'politician_id', c.pid, 'politician_election_id', c.pe_id,
             'current', jsonb_build_object('cand_no', NULL),
             'official', jsonb_build_object('village', c.village, 'district', NULLIF(c.district, ''), 'cand_no', c.cand_no, 'party', c.party, 'birth_roc', c.birth),
             'source_url', c.url))
      FROM cn c
  ),
  g AS (
    SELECT i.election_type, i.county, i.town, i.county || i.town AS unit, count(*)::INTEGER AS n,
           jsonb_path_query_array(jsonb_agg(i.item ORDER BY i.ord, i.sort_no NULLS LAST, i.sort_name), ('$[0 to ' || ((SELECT cap.n FROM cap) - 1) || ']')::jsonpath) AS items,
           jsonb_strip_nulls(jsonb_build_object('缺人', NULLIF(count(*) FILTER (WHERE i.ord = 1), 0), '缺號次', NULLIF(count(*) FILTER (WHERE i.ord = 2), 0))) AS kinds
      FROM it i GROUP BY i.election_type, i.county, i.town
  )
  SELECT 'auto:roster_check:2026:' || g.unit || ':' || g.election_type,
         CASE WHEN g.election_type = '村里長' THEN 'roster_villages' ELSE 'raw:roster_check' END,
         2026, g.election_type, g.county, g.town, g.unit, g.items, g.n, g.kinds,
         jsonb_build_object('election_id', 2026, 'region', g.unit, 'county', g.county, 'township', NULLIF(g.town, ''), 'election_type', g.election_type,
                            'findings_only', true, 'voted', false, 'roster_gap', true) || roster_unify_extra(g.items, g.n, g.kinds),
         g.unit || ' 2026 ' || g.election_type || '名單缺口：這個單位有 ' || g.n || ' 位要補（' || roster_unify_kinds_text(g.kinds) || '），逐位列在 target.items。'
           || roster_gap_text(),
         ARRAY['https://info.cec.gov.tw/vote2026/static/json/ ← 中選會選舉專區候選人名單（含號次）', 'https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表',
               g.county || '選舉委員會官網的登記公告']
    FROM g
   WHERE dispatch_gap_roster_unit_key(2026, g.unit, g.election_type) = ANY (p_keys)
$fn$;

-- ballot_numbers：與 20261109190000 的 contribution_auto_tasks_ballot_numbers() 逐字相同，只加兩處單位鍵過濾：
--   ① ranked 的來源 g_all（派工單位＝選舉、職位、縣市、鄉鎮；ROW_NUMBER 與 count 的分區就是這個單位，整單位都在鍵裡，分件不會錯位）；
--   ② ru 的來源 ballot_number_units（重查的派工單位，分區同上）。numbered 裡「同號次單位同名」的反連接仍讀整份 g_all（同單位內比對，不受鍵影響）。
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_ballot_numbers(p_keys TEXT[])
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH pending_batch AS MATERIALIZED (
    SELECT cb.payload->>'election_id' AS election_id, bi->>'politician_election_id' AS pe_id
      FROM contributions cb, jsonb_array_elements(CASE WHEN jsonb_typeof(cb.payload->'items') = 'array' THEN cb.payload->'items' ELSE '[]'::jsonb END) bi
     WHERE cb.contribution_type = 'cand_numbers' AND cb.status IN ('pending', 'verified')
  ),
  -- >>> 不在官方名冊的人不派補號次（2026-11-09）：中選會抽籤後名單（cec_roster_2026）有這個單位的資料、而且他的姓名在名單上找不到（登記後退出、資格不符、
  --     或登記彙總表有、候選人 JSON 沒有），這種人永遠不會有號次，代理只能回「確認無誤」；舊版仍會一直把他列進缺口、整個單位反覆重派（實例：苗栗縣頭份市 黃世男）。
  --     只在「名冊有這個單位的資料」時才排除（沒抓到名冊的單位照舊派）；比對在同職位、同縣市（村里長到鄉鎮）範圍內，不看選區／村里，寧可少排除。
  roster_names AS MATERIALIZED (
    SELECT x.election_type, replace(x.county, '臺', '台') AS county,
           CASE WHEN x.election_type = '村里長' THEN replace(x.town, '臺', '台') ELSE '' END AS town,
           COALESCE(x.name_key, roster_name_key(x.name)) AS nkey
      FROM cec_roster_2026 x
  ),
  roster_scopes AS MATERIALIZED (SELECT DISTINCT rn0.election_type, rn0.county, rn0.town FROM roster_names rn0),
  -- <<< 不在官方名冊
  g_all AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.cand_no, p.id AS politician_id, p.name,
           -- 號次單位與正規化姓名（20261031090000）：排除「同單位同名不同人、對方已有號次」的列用（算法同 ballot_number_unit／同名人物配對）
           ballot_number_unit(pe.election_type, COALESCE(r.region, p.region), r.sub_region, r.sub_region, r.village) AS unit,
           regexp_replace(regexp_replace(p.name, '[．·‧・•.\s]', '', 'g'), '臺', '台', 'g') AS nkey,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           -- 名單公告是一個鄉鎮一份的：鄉鎮市長、直轄市山地原住民區長、村里長、鄉鎮市民代表、直轄市山地原住民區民代表再細到鄉鎮市區
           -- （鄉鎮市長的參選紀錄多半還沒記到鄉鎮，r.sub_region 空＝留在縣市層級那一件，代理從公告上補 sub_region）
           -- 代表的 regions.sub_region 可能是「麥寮鄉第04選舉區」（#464）：派工單位照舊是鄉鎮，選舉區放 district
           CASE WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN NULLIF(regexp_replace(r.sub_region, '(第[0-9]+)?選舉區$', ''), '')
                WHEN pe.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長') THEN r.sub_region END AS unit_town,
           -- 縣市議員的 regions.sub_region 存的是選舉區（第NN選舉區）；代表的選舉區取尾巴的「第NN選舉區」
           CASE WHEN pe.election_type = '縣市議員' THEN r.sub_region
                WHEN pe.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN substring(r.sub_region from '第[0-9]+選舉區$') END AS district,
           CASE WHEN pe.election_type = '村里長' THEN r.village END AS village
      FROM politician_elections pe
      -- 抽籤之後、投票日以前才派：窗口（起點）由規則決定（activity_rules「ballot_numbers」：draw +0 起、polling +0 止，補號次 20261008150000）；
      -- 這裡的 election_date 只是效能預篩（已投票的屆別不算，不然 seed 每 10 分鐘要掃全部歷史），不是第二份窗口。
      -- 投票日隔天還要算（- 1）：規則的窗口在隔天才關，seed 要看得到「臂還算得出來、窗口關了」才會把收回記成 window，不是 filled
      JOIN elections e ON e.id = pe.election_id AND e.election_date >= activity_today() - 1
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.candidacy_status = 'filed' AND pe.election_type IS NOT NULL AND COALESCE(r.region, p.region) IS NOT NULL
  ),
  ranked AS (
    SELECT g.*,
           (row_number() OVER w - 1) / 50 + 1 AS part,
           (count(*) OVER (PARTITION BY g.election_id, g.election_type, g.county, g.unit_town) - 1) / 50 + 1 AS parts
      FROM g_all g
     WHERE dispatch_gap_ballot_unit_key(g.election_id, g.election_type, g.county, g.unit_town) = ANY (p_keys)
    WINDOW w AS (PARTITION BY g.election_id, g.election_type, g.county, g.unit_town
                 ORDER BY g.district NULLS LAST, g.village NULLS LAST, g.name, g.pe_id)
  ),
  numbered AS (
    SELECT rk.*
      FROM ranked rk
     WHERE rk.cand_no IS NULL
       -- >>> 不在官方名冊（2026-11-09）
       AND NOT (rk.election_id = 2026
                AND EXISTS (SELECT 1 FROM roster_scopes s WHERE s.election_type = rk.election_type AND s.county = rk.county
                                                           AND s.town = COALESCE(CASE WHEN rk.election_type = '村里長' THEN rk.unit_town END, ''))
                AND NOT EXISTS (SELECT 1 FROM roster_names n WHERE n.election_type = rk.election_type AND n.county = rk.county
                                                              AND n.town = COALESCE(CASE WHEN rk.election_type = '村里長' THEN rk.unit_town END, '')
                                                              AND cec_name_fuzzy_eq(roster_name_key(rk.name), n.nkey, NULL, NULL)))
       -- <<< 不在官方名冊
       -- 整批交件（cand_numbers，#781）還在等票（pending／verified）而且 items 涵蓋他的先不派（退件了就會再派；落庫時被標錯或同號的列沒寫，缺口還在就會重派）；
       -- 等票中的整批在 pending_batch 只算一次（雜湊反連接），不是每個候選列各展開一遍
       AND NOT EXISTS (SELECT 1 FROM pending_batch pb WHERE pb.election_id = rk.election_id::TEXT AND pb.pe_id = rk.pe_id::TEXT)
       -- 同一個選舉、同一個號次單位裡有同名（正規化）的另一個人物、而對方已有號次：這一列多半是同一位候選人被建成兩筆人物，
       -- 抄公告也補不上（補上去會撞「與已上線他人同號」）。先不派，等 duplicate_politician 合併任務處理（合併後同一人只剩一列）
       -- 同一筆參選紀錄已有 open 的「查參選狀態」（candidate_status_stale、origin＝cec_roster_extra：站上已登記、中選會名單查無此人）手動任務的先不派
       -- （policy-ops#175）：這種人不在抽籤名單上，補號次只收號次、交不出答案，會一直冷卻空轉；同一個人同一件事不開兩張。
       -- 那張任務可以連號次一起交（名單上其實有他、只是寫法不同）；它結案後仍缺號次，這裡自然又派出來。
       AND NOT EXISTS (SELECT 1 FROM contribution_tasks cs
                        WHERE cs.task_type = 'candidate_status_stale' AND cs.status = 'open'
                          AND cs.target->>'origin' = 'cec_roster_extra'
                          AND cs.target->>'politician_election_id' = rk.pe_id::TEXT)
       AND NOT EXISTS (SELECT 1 FROM g_all o
                        WHERE o.election_id = rk.election_id AND o.election_type = rk.election_type AND o.unit = rk.unit AND o.nkey = rk.nkey
                          AND o.cand_no IS NOT NULL AND o.politician_id <> rk.politician_id AND rk.unit IS NOT NULL)
       -- 已經有人交了這一人這一屆帶號次的 candidacy、還在等票（pending／verified）的先不派（退件了就會再派）；
       -- 交件可以只給姓名、沒給 politician_id（協議允許）：沒給的用姓名＋選舉別＋縣市對
       AND NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'election_id' = rk.election_id::TEXT AND c.payload->>'cand_no' IS NOT NULL
                          AND (c.payload->>'politician_id' = rk.politician_id::TEXT
                               OR (NULLIF(c.payload->>'politician_id', '') IS NULL AND btrim(c.payload->>'name') = rk.name
                                   AND c.payload->>'election_type' = rk.election_type
                                   AND replace(COALESCE(c.payload->>'region', rk.county), '臺', '台') = rk.county)))
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts, count(*) AS items_count, bool_or(n.district IS NOT NULL) AS has_district,
           jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'politician_election_id', n.pe_id, 'politician_id', n.politician_id, 'name', n.name,
             'electoral_district', n.district, 'sub_region', n.unit_town, 'village', n.village))
             ORDER BY n.district NULLS LAST, n.village NULLS LAST, n.name, n.pe_id) AS items
      FROM numbered n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  ),
  u AS (
    SELECT gr.*, e.election_date,
           (SELECT m.on_date FROM election_milestones_all m
             WHERE m.election_id = gr.election_id AND m.kind = 'draw' AND (m.election_type = gr.election_type OR m.election_type IS NULL)
             ORDER BY m.election_type NULLS LAST LIMIT 1) AS draw_on,
           (SELECT m.on_date FROM election_milestones_all m
             WHERE m.election_id = gr.election_id AND m.kind = 'list_published' AND (m.election_type = gr.election_type OR m.election_type IS NULL)
             ORDER BY m.election_type NULLS LAST LIMIT 1) AS list_on,
           -- candidate_status＝交件協議的詞（名單公告前 registered、公告後 qualified），由 candidacy_status 換算，不是舊欄位
           candidacy_protocol_status('filed', candidacy_list_published(gr.election_id, gr.election_type, CURRENT_DATE)) AS candidate_status,
           -- 中選會選舉專區的候選人 JSON（含 candNo）：只有 2026 年這一屆有（static/json 路徑是 vote2026）
           CASE WHEN gr.election_id = 2026 THEN cec_vote2026_cand_url(gr.election_type, gr.county, gr.unit_town) END AS cec_url
      FROM grouped gr
      JOIN elections e ON e.id = gr.election_id
  ),
  -- 重複與跳號的重查：號次單位的名次先算在派工單位的全部號次單位上，再留下有問題的（kind 有值），一件最多 25 個號次單位
  ru AS (
    SELECT bu.*,
           CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END AS unit_town,
           (row_number() OVER w - 1) / 25 + 1 AS part,
           (count(*) OVER (PARTITION BY bu.election_id, bu.election_type, bu.county,
                           CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END) - 1) / 25 + 1 AS parts
      FROM ballot_number_units bu
     WHERE dispatch_gap_ballot_unit_key(bu.election_id, bu.election_type, bu.county, CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END) = ANY (p_keys)
    WINDOW w AS (PARTITION BY bu.election_id, bu.election_type, bu.county,
                              CASE WHEN bu.election_type IN ('鄉鎮市長', '直轄市山地原住民區長', '村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN bu.town END
                 ORDER BY bu.unit)
  ),
  rn AS (
    SELECT ru.*, ballot_number_dups(ru.members) AS duplicates, ballot_number_missing(ru.registered, ru.numbered, ru.numbers) AS missing,
           CASE WHEN position('|' IN ru.unit) > 0 THEN replace(substr(ru.unit, position('|' IN ru.unit) + 1), '|', ' ') ELSE ru.county END AS label,
           (SELECT string_agg((t.m->>'name') || CASE WHEN t.m->>'cand_no' IS NOT NULL THEN '（' || (t.m->>'cand_no') || '號）' ELSE '（沒有號次）' END, '、' ORDER BY t.ord)
              FROM jsonb_array_elements(ru.members) WITH ORDINALITY AS t(m, ord)) AS who
      FROM ru
     WHERE ru.kind IS NOT NULL
  ),
  rg AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts, count(*) AS units_count,
           jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'unit', n.label, 'anomaly', n.kind, 'registered', n.registered, 'numbered', n.numbered,
             'duplicates', to_jsonb(n.duplicates), 'missing', to_jsonb(n.missing),
             'electoral_district', n.district, 'sub_region', n.town, 'village', n.village, 'members', n.members))
             ORDER BY n.unit) AS units,
           string_agg(n.label || '：' || CASE n.kind
                        WHEN 'duplicate' THEN '號次 ' || array_to_string(n.duplicates, '、') || ' 重複'
                                              || CASE WHEN cardinality(n.missing) > 0 THEN '，名單 ' || n.registered || ' 位都有號次卻缺 ' || array_to_string(n.missing, '、') ELSE '' END
                        ELSE '名單 ' || n.registered || ' 位都有號次，但號次不是 1 到 ' || n.registered || ' 連續，缺 ' || array_to_string(n.missing, '、') END
                      || '（' || n.who || '）', '；' ORDER BY n.unit) AS summary
      FROM rn n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  ),
  rc AS (
    SELECT rg.*, e.election_date,
           candidacy_protocol_status('filed', candidacy_list_published(rg.election_id, rg.election_type, CURRENT_DATE)) AS candidate_status,
           CASE WHEN rg.election_id = 2026 THEN cec_vote2026_cand_url(rg.election_type, rg.county, rg.unit_town) END AS cec_url
      FROM rg
      JOIN elections e ON e.id = rg.election_id
  )
  SELECT 'auto:candidacy_source_missing:cand_no:' || u.election_id || ':' || u.election_type || ':' || u.county
           || COALESCE(':' || u.unit_town, '') || CASE WHEN u.parts > 1 THEN ':p' || u.part ELSE '' END,
         'candidacy_source_missing',
         jsonb_strip_nulls(jsonb_build_object('kind', 'cand_no', 'election_id', u.election_id, 'election_type', u.election_type,
                            'region', u.county, 'sub_region', u.unit_town, 'election_date', u.election_date,
                            'draw_on', u.draw_on, 'list_on', u.list_on, 'candidate_status', u.candidate_status, 'cec_json_url', u.cec_url,
                            'missing', jsonb_build_array('cand_no'),
                            'part', u.part, 'parts', u.parts, 'items_count', u.items_count, 'items', u.items)),
         u.county || COALESCE(u.unit_town, '') || ' ' || u.election_id || ' ' || u.election_type || '：我們有 ' || u.items_count || ' 位已登記的參選人還沒有選票上的號次（cand_no）'
           || CASE WHEN u.parts > 1 THEN '（這個單位太大，拆成 ' || u.parts || ' 件，這是第 ' || u.part || ' 件）' ELSE '' END
           || '。號次是抽籤決定的（中選會預定 ' || COALESCE(u.draw_on::TEXT, '抽籤日') || ' 抽籤），抽完各縣市選舉委員會公告的候選人名單（預定 ' || COALESCE(u.list_on::TEXT, '名單公告日')
           || ' 前後公告）和選舉公報上都印著每個人的號次。號次是每個選舉區（村里長是每個村里、鄉鎮市長是每個鄉鎮）各自從 1 編起的，同一個單位不會有兩位同號。'
           || CASE WHEN u.cec_url IS NOT NULL THEN '**中選會選舉專區的候選人 JSON 已含號次（candNo），請以姓名對應**：' || u.cec_url || '（靜態 JSON，直接 GET 即可、不必跑 JS；每位有 name、candNo、party、home、birth' || CASE WHEN u.election_type = '村里長' THEN '、liCode（村里序號）' ELSE '' END || CASE WHEN u.election_type IN ('縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN '，議員與代表的檔依選舉區分組（各區的 cands），要連選舉區一起對' WHEN u.election_type = '村里長' THEN '，同名要連 birth 與 liCode 對' ELSE '，這一檔涵蓋整個縣市，請只取本件單位的人' END || '；這份 JSON 裡找不到的人再退回縣市選委會公告）。' ELSE '' END
           || '名單在 target.items：請到該縣市選舉委員會網站（web.cec.gov.tw/<縣市代碼>ec/）找候選人名單公告或抽籤結果，逐位核對姓名'
           || CASE u.election_type WHEN '縣市議員' THEN '與選舉區' WHEN '村里長' THEN '與村里' ELSE '' END
           || '，查得到號次的每位列進**一份** cand_numbers 交件（整個任務一份、不要一人一份 candidacy；contribution_type 填 cand_numbers，task_id 照這一件）：payload.election_id 填 ' || u.election_id || '、election_type 填「' || u.election_type
           || '」、region 填「' || u.county || '」'
           || CASE WHEN u.unit_town IS NOT NULL THEN '、sub_region 填「' || u.unit_town || '」'
                   WHEN u.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') THEN '、sub_region 填他所在的鄉鎮市區（公告是按鄉鎮分的）' ELSE '' END
           || '，payload.items 每位一列 {politician_election_id（照 target.items 的 politician_election_id）, cand_no（公告上的號次，正整數）}，最多 150 列；'
           || 'source_urls 第一個放你看到他號次的那一頁公告網址（縣市選委會的公告頁或選舉公報），不要放登記彙總表——它沒有號次，也不會被拿來核號次。'
           || '公告上找不到的人不要放進 items，不要猜、不要依名單順序推；公告還沒出來就先不要交。'
           || '驗證者只會開一次公告逐列核對：抄錯的列會被標出來、只退那幾列（其餘照過），不會整批作廢；落庫前系統也逐列檢查同一個號次單位裡有沒有同號，同號的列不寫、回到缺口重派。',
         CASE WHEN u.cec_url IS NOT NULL THEN ARRAY[u.cec_url || ' ← 中選會選舉專區候選人 JSON（含 candNo 號次，靜態檔直接 GET，以姓名對應）'] ELSE ARRAY[]::text[] END
         || ARRAY['https://web.cec.gov.tw/<縣市選委會代碼>ec/ ← 該縣市選舉委員會網站：「候選人名單公告」「抽籤結果」（2022 年的長相：https://web.cec.gov.tw/tyec/article/37003 ← 桃園市長名單，「（1）張善政（2）賴香伶…」括號裡就是號次）',
               'https://web.cec.gov.tw/central/article/20892 ← 中選會「各種選舉公告」，列出各縣市選委會的公告',
               'https://eebulletin.cec.gov.tw ← 選舉公報（11 月中旬後上架，每位候選人那一欄印著號次）',
               '村里長、代表：鄉鎮市區公所／縣市選委會的「候選人登記冊（含抽籤號次）」（2022 年苗栗縣選委會 10-21 當天就公布了逐里的抽籤號次表）'],
         1, u.county
    FROM u
  UNION ALL
  SELECT 'auto:candidacy_source_missing:cand_no_recheck:' || rc.election_id || ':' || rc.election_type || ':' || rc.county
           || COALESCE(':' || rc.unit_town, '') || CASE WHEN rc.parts > 1 THEN ':p' || rc.part ELSE '' END,
         'candidacy_source_missing',
         jsonb_strip_nulls(jsonb_build_object('kind', 'cand_no_recheck', 'election_id', rc.election_id, 'election_type', rc.election_type,
                            'region', rc.county, 'sub_region', rc.unit_town, 'election_date', rc.election_date, 'candidate_status', rc.candidate_status, 'cec_json_url', rc.cec_url,
                            'missing', jsonb_build_array('cand_no'),
                            'part', rc.part, 'parts', rc.parts, 'units_count', rc.units_count, 'units', rc.units)),
         rc.county || COALESCE(rc.unit_town, '') || ' ' || rc.election_id || ' ' || rc.election_type || '：有 ' || rc.units_count || ' 個號次單位的號次對不起來，請對公告重查'
           || CASE WHEN rc.parts > 1 THEN '（拆成 ' || rc.parts || ' 件，這是第 ' || rc.part || ' 件）' ELSE '' END
           || '。' || rc.summary || '。'
           || '號次是每個選舉區（村里長是每個村里、鄉鎮市長是每個鄉鎮）各自從 1 編起的：同一個單位出現同號＝至少一位的號次抄錯了；名單到齊、號次卻不是 1 到 N 連續＝有號次抄錯，或公告上有人我們名單沒有。'
           || CASE WHEN rc.cec_url IS NOT NULL THEN '**中選會選舉專區的候選人 JSON 已含號次（candNo），請以姓名對應**：' || rc.cec_url || '（靜態 JSON，直接 GET 即可、不必跑 JS；每位有 name、candNo、party、home、birth' || CASE WHEN rc.election_type = '村里長' THEN '、liCode（村里序號）' ELSE '' END || CASE WHEN rc.election_type IN ('縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN '，議員與代表的檔依選舉區分組（各區的 cands），要連選舉區一起對' WHEN rc.election_type = '村里長' THEN '，同名要連 birth 與 liCode 對' ELSE '，這一檔涵蓋整個縣市，請只取本件單位的人' END || '；這份 JSON 裡找不到的人再退回縣市選委會公告）。' ELSE '' END
           || '每個單位的成員與目前記的號次在 target.units[].members。請打開該單位的候選人名單公告或選舉公報逐位核對：'
           || '①我們記錯的，用 candidacy 重交那一位（politician_id、name、election_id、election_type、region 照 target，sub_region／village／electoral_district 照 target.units，cand_no 填公告上的號次，candidate_status 填「'
           || COALESCE(rc.candidate_status, '') || '」），只交跟公告不同的；②公告上有、我們名單沒有的人，用 candidacy 補進來（附同一份公告）；'
           || '③公告本身就跳號（候選人退選或資格不符、號次沒有遞補）而我們的號次都跟公告一致，用 no_change（outcome 填 confirmed）回報，finding 寫公告上的號次與頁碼。'
           || '公告還沒出來就略過這一件，不要回 no_change not_found（14 天內不再派）。',
         CASE WHEN rc.cec_url IS NOT NULL THEN ARRAY[rc.cec_url || ' ← 中選會選舉專區候選人 JSON（含 candNo 號次，靜態檔直接 GET，以姓名對應）'] ELSE ARRAY[]::text[] END
         || ARRAY['https://web.cec.gov.tw/<縣市選委會代碼>ec/ ← 該縣市選舉委員會網站：「候選人名單公告」「抽籤結果」',
               'https://eebulletin.cec.gov.tw ← 選舉公報（每位候選人那一欄印著號次）',
               '村里長、代表：鄉鎮市區公所／縣市選委會的「候選人登記冊（含抽籤號次）」'],
         1, rc.county
    FROM rc
$$;

-- ------------------------------------------------------------
-- 3. 觸發器函式：以 20261126193000 為底，加名單族分支
--    · politician_elections：原有 mismatch／issue_too_broad 的判斷與入列一個字不變（用舊欄位清單）；名單族另看較寬的欄位清單，
--      新舊兩列（改縣市、改職位時兩個單位都受影響）各自入列所屬單位（縣市取 regions.region，沒有就取人物的縣市；鄉鎮取 regions.sub_region）
--    · politicians：name、region、merged_into 變了照舊入政見；名單族另加 birth_year、party，入該人名下每筆參選紀錄的單位（新舊縣市都入）
--    · contributions：多 cand_numbers、candidacy、election_results、reassign_candidacy 四型別；payload 組得出單位就入單位，組不出就整臂 '*'
--    · elections：投票日變更另入 roster_unit_findings、ballot_numbers 整臂；election_milestones：抽籤與名單公告日，入名單族三支整臂
--    · cec_roster_units：入該單位（官方名冊鏡像的批次寫入點）＋補號次整臂（名冊成員變了，「不在官方名冊」的排除要重算）
--    · contribution_tasks（參選狀態查證）、roster_unify_settings：整臂
--    其餘分支（policies、jev_decisions、edit_history、source_refs、policy_subtopics、activity_rules、設定表）與 20261126193000 相同，
--    只有設定表那一段拿掉 election_milestones（改走自己的分支，不再讓三支舊臂陪著整臂重算）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_on_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_new     JSONB := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  v_old     JSONB := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  v_row     JSONB;
  v_kind    TEXT := lower(TG_OP);
  v_cols    TEXT[];
  v_changed BOOLEAN;
  v_chg_old BOOLEAN;
  v_chg_ros BOOLEAN;
  v_arm     TEXT;
  v_tid     TEXT;
  v_eid     TEXT;
  v_pl      JSONB;
  v_np      UUID;
  v_op      UUID;
  v_ne      INTEGER;
  v_oe      INTEGER;
  v_ie      INTEGER;
  v_r       JSONB;
  v_county  TEXT;
  v_sub     TEXT;
  v_ceid    INTEGER;
  v_cet     TEXT;
  v_ctype   TEXT;
BEGIN
  IF NOT dispatch_gap_events_enabled() THEN
    RETURN NULL;
  END IF;
  v_row := COALESCE(v_new, v_old);

  IF TG_TABLE_NAME = 'policies' THEN
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['title', 'description', 'category', 'tags', 'status', 'proposed_date', 'last_updated', 'progress',
                      'election_id', 'politician_id', 'removed_at', 'lineage_id'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_changed;
      IF NOT v_changed THEN
        RETURN NULL;
      END IF;
    END IF;
    PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'id'), v_kind);
    PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || (v_row ->> 'id'), v_kind);
    -- 議題統計只看「issue_too_broad_election() 那一屆的競選承諾」；新舊兩邊都不是就不入列
    IF COALESCE((v_new ->> 'status') = 'Campaign Pledge' OR (v_old ->> 'status') = 'Campaign Pledge', false) THEN
      v_eid := issue_too_broad_election()::TEXT;
      IF COALESCE((v_new ->> 'election_id') = v_eid OR (v_old ->> 'election_id') = v_eid, false) THEN
        PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);   -- 反推不出（縣市，議題），整臂重算；同一時段只會留一筆
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'jev_decisions' THEN
    IF TG_OP = 'INSERT' AND v_row ->> 'subject_type' = 'policy' AND v_row ->> 'question' = 'election' THEN
      PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || (v_row ->> 'subject_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'edit_history' THEN
    IF TG_OP = 'INSERT' AND v_row ->> 'table_name' = 'policies' AND v_row ->> 'field' IN ('audit', '*') THEN
      PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'record_id'), v_kind);
    END IF;

  ELSIF TG_TABLE_NAME = 'source_refs' THEN
    -- 只有政見的主要出處會改變 policy_primary_url；更新時新舊兩邊的 target_id 都入（換掉被引用的政見）
    IF COALESCE(v_new ->> 'target_table', v_old ->> 'target_table') = 'policies'
       AND (COALESCE(v_new ->> 'role', '') = 'primary' OR COALESCE(v_old ->> 'role', '') = 'primary') THEN
      FOR v_tid IN SELECT DISTINCT t FROM unnest(ARRAY[v_new ->> 'target_id', v_old ->> 'target_id']) t WHERE t IS NOT NULL LOOP
        PERFORM dispatch_gap_enqueue('legacy', 'policy:' || v_tid, v_kind);
        PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || v_tid, v_kind);
      END LOOP;
    END IF;

  ELSIF TG_TABLE_NAME = 'politician_elections' THEN
    v_chg_old := true;
    v_chg_ros := true;
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['candidacy_status', 'election_id', 'politician_id', 'region_id', 'election_type'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_chg_old;
      v_cols := ARRAY['candidacy_status', 'election_id', 'politician_id', 'region_id', 'election_type', 'cand_no', 'party_id', 'party_basis', 'withdrawn_after_filing'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_chg_ros;
      IF NOT v_chg_old AND NOT v_chg_ros THEN
        RETURN NULL;
      END IF;
    END IF;
    v_np := (v_new ->> 'politician_id')::UUID;
    v_op := (v_old ->> 'politician_id')::UUID;
    v_ne := (v_new ->> 'election_id')::INTEGER;
    v_oe := (v_old ->> 'election_id')::INTEGER;
    IF v_chg_old THEN
      -- mismatch：只有「同一個人、同一屆」的政見會受這一列影響（by_date／by_no_candidacy／by_not_elected 都比 politician_id＋election_id）
      -- （欄位值先轉成 uuid／整數再比，policies 的 politician_id 索引才用得上；NULL 比不到任何列）
      FOR v_tid IN
        SELECT p.id::TEXT FROM policies p
         WHERE p.removed_at IS NULL AND p.politician_id = v_np AND p.election_id = v_ne
        UNION
        SELECT p.id::TEXT FROM policies p
         WHERE p.removed_at IS NULL AND p.politician_id = v_op AND p.election_id = v_oe
      LOOP
        PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || v_tid, v_kind);
      END LOOP;
      -- issue_too_broad：該屆是議題統計的那一屆、而且這個人有該屆未移除的競選承諾才入整臂
      v_ie := issue_too_broad_election();
      IF (v_ne = v_ie OR v_oe = v_ie)
         AND EXISTS (SELECT 1 FROM policies p
                      WHERE p.politician_id IN (v_np, v_op) AND p.election_id = v_ie
                        AND p.status = 'Campaign Pledge' AND p.removed_at IS NULL) THEN
        PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);
      END IF;
    END IF;
    IF v_chg_ros THEN
      -- 名單族：新舊兩列各入自己所屬的單位（縣市取參選紀錄指到的地區，沒有就取人物的縣市）
      FOR v_r IN SELECT x FROM unnest(ARRAY[v_new, v_old]) AS x WHERE x IS NOT NULL LOOP
        SELECT COALESCE(rg.region, p.region), rg.sub_region INTO v_county, v_sub
          FROM politicians p LEFT JOIN regions rg ON rg.id = (v_r ->> 'region_id')::INTEGER
         WHERE p.id = (v_r ->> 'politician_id')::UUID;
        IF v_county IS NOT NULL THEN
          PERFORM dispatch_gap_enqueue_units((v_r ->> 'election_id')::INTEGER, v_r ->> 'election_type', v_county, v_sub, v_kind);
        END IF;
      END LOOP;
    END IF;

  ELSIF TG_TABLE_NAME = 'politicians' THEN
    -- 人物改名、縣市、被合併會改變這個人名下每條政見的 legacy／mismatch 缺口內容（target 帶 name、region；legacy 排除 merged_into）；
    -- 名單族另看出生年與政黨（掛錯人、政黨差異的現值）
    v_chg_old := true;
    v_chg_ros := true;
    IF TG_OP = 'UPDATE' THEN
      v_cols := ARRAY['name', 'region', 'merged_into'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_chg_old;
      v_cols := ARRAY['name', 'region', 'merged_into', 'birth_year', 'party'];
      SELECT EXISTS (SELECT 1 FROM unnest(v_cols) c WHERE v_old -> c IS DISTINCT FROM v_new -> c) INTO v_chg_ros;
      IF NOT v_chg_old AND NOT v_chg_ros THEN
        RETURN NULL;
      END IF;
    END IF;
    v_np := (v_row ->> 'id')::UUID;
    IF v_chg_old THEN
      FOR v_tid IN SELECT p.id::TEXT FROM policies p WHERE p.politician_id = v_np AND p.removed_at IS NULL LOOP
        PERFORM dispatch_gap_enqueue('legacy', 'policy:' || v_tid, v_kind);
        PERFORM dispatch_gap_enqueue('mismatch', 'policy:' || v_tid, v_kind);
      END LOOP;
    END IF;
    IF v_chg_ros THEN
      -- 這個人名下每筆參選紀錄的單位；縣市取參選紀錄指到的地區，沒有就取人物的縣市（改縣市時新舊兩個縣市都入）
      FOR v_r IN SELECT jsonb_build_object('election_id', pe.election_id, 'election_type', pe.election_type, 'county', rg.region, 'sub', rg.sub_region)
                   FROM politician_elections pe LEFT JOIN regions rg ON rg.id = pe.region_id WHERE pe.politician_id = v_np LOOP
        FOR v_county IN SELECT DISTINCT c FROM unnest(ARRAY[v_r ->> 'county', v_new ->> 'region', v_old ->> 'region']) AS c WHERE c IS NOT NULL LOOP
          PERFORM dispatch_gap_enqueue_units((v_r ->> 'election_id')::INTEGER, v_r ->> 'election_type', v_county, v_r ->> 'sub', v_kind);
        END LOOP;
      END LOOP;
    END IF;

  ELSIF TG_TABLE_NAME = 'contributions' THEN
    -- 只有這幾種型別影響缺口：policy（legacy 排除「是貢獻建出來的政見」）、policy_subtopics（issue_too_broad 排除在途細項）、
    -- cand_numbers／candidacy（補號次排除在途整批與在途帶號次的 candidacy）、election_results／reassign_candidacy（名單清查各種差異的在途排除）
    IF TG_OP = 'UPDATE' AND v_old ->> 'status' IS NOT DISTINCT FROM v_new ->> 'status'
       AND v_old ->> 'applied_policy_id' IS NOT DISTINCT FROM v_new ->> 'applied_policy_id' THEN
      RETURN NULL;
    END IF;
    v_ctype := v_row ->> 'contribution_type';
    IF v_ctype = 'policy' THEN
      IF v_row ->> 'applied_policy_id' IS NOT NULL THEN
        PERFORM dispatch_gap_enqueue('legacy', 'policy:' || (v_row ->> 'applied_policy_id'), v_kind);
      END IF;
    ELSIF v_ctype = 'policy_subtopics' THEN
      v_pl := v_row -> 'payload';
      IF COALESCE(v_pl ->> 'election_id', '') <> '' AND COALESCE(v_pl ->> 'region', '') <> '' AND COALESCE(v_pl ->> 'issue', '') <> '' THEN
        -- 與 contribution_auto_tasks_issue_too_broad 的 task_id 同一個組法：縣市臺→台、議題空白→底線
        PERFORM dispatch_gap_enqueue('issue_too_broad',
          'issue:' || (v_pl ->> 'election_id') || ':' || replace(v_pl ->> 'region', '臺', '台') || ':' || regexp_replace(v_pl ->> 'issue', '\s+', '_', 'g'),
          v_kind);
      ELSE
        PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);
      END IF;
    ELSIF v_ctype IN ('cand_numbers', 'candidacy', 'election_results', 'reassign_candidacy') THEN
      v_pl := COALESCE(v_row -> 'payload', '{}'::JSONB);
      v_ceid := CASE WHEN v_pl ->> 'election_id' ~ '^[0-9]+$' THEN (v_pl ->> 'election_id')::INTEGER END;
      v_cet := NULLIF(v_pl ->> 'election_type', '');
      v_county := NULLIF(v_pl ->> 'region', '');
      v_sub := NULLIF(v_pl ->> 'sub_region', '');
      IF v_ceid IS NOT NULL AND v_cet IS NOT NULL AND v_county IS NOT NULL THEN
        PERFORM dispatch_gap_enqueue_units(v_ceid, v_cet, v_county, v_sub, v_kind);
        -- 補號次的派工單位在鄉鎮層級的職位，payload 沒帶鄉鎮就對不到單位：整臂
        IF v_sub IS NULL AND v_cet NOT IN ('縣市長', '縣市議員') THEN
          PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', v_kind);
        END IF;
      ELSE
        PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', v_kind);
        PERFORM dispatch_gap_enqueue_reg('roster_gap_units', '*', v_kind);
        PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', v_kind);
      END IF;
    END IF;

  ELSIF TG_TABLE_NAME = 'policy_subtopics' THEN
    PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);   -- 細項落庫／刪除只影響「還沒有細項」的承諾數；對不到縣市，整臂

  ELSIF TG_TABLE_NAME = 'elections' THEN
    PERFORM dispatch_gap_enqueue('mismatch', '*', v_kind);          -- 投票日變更：by_date／by_future／by_not_elected 都看它
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', v_kind);   -- 名冊差異的 voted（投票日是否已過）、補號次的窗口都看它
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', v_kind);

  ELSIF TG_TABLE_NAME = 'election_milestones' THEN
    -- 抽籤日、名單公告日改動：補號次 target 帶 draw_on／list_on 與候選狀態的詞，名冊差異的候選狀態詞也看名單公告日
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('roster_gap_units', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', 'config');

  ELSIF TG_TABLE_NAME = 'cec_roster_units' THEN
    -- 官方名冊鏡像的批次寫入點（cec_roster_replace_unit 每個單位最後一步 UPDATE 這一列）：入該單位；
    -- 補號次的「不在官方名冊」排除是縣市層級，單位內成員一變所有鄉鎮的號次件都可能變，所以補號次入整臂
    PERFORM dispatch_gap_enqueue_roster_units(2026, v_row ->> 'election_type', v_row ->> 'county', NULLIF(v_row ->> 'town', ''), v_kind);
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', v_kind);

  ELSIF TG_TABLE_NAME = 'contribution_tasks' THEN
    -- 參選狀態查證任務（origin＝cec_roster_extra）開著時，補號次那筆參選紀錄不派；任務開關要重算
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', v_kind);

  ELSIF TG_TABLE_NAME = 'roster_unify_settings' THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('roster_gap_units', '*', 'config');

  ELSIF TG_TABLE_NAME = 'activity_rules' THEN
    IF COALESCE(v_new ->> 'activity', v_old ->> 'activity') = 'issue_too_broad'
       OR COALESCE(v_old ->> 'activity', '') = 'issue_too_broad' THEN
      PERFORM dispatch_gap_enqueue('issue_too_broad', '*', 'config');   -- 門檻與選舉屆別在 params
    END IF;

  ELSIF TG_TABLE_NAME IN ('activity_overrides', 'election_task_config', 'traffic_watch_levels', 'lineage_settings') THEN
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

-- 語句層級（轉換表）：批次寫入的名冊類表，一個語句最多入一筆整臂事件；沒有影響到任何列就不入
CREATE OR REPLACE FUNCTION dispatch_gap_on_batch_new() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF dispatch_gap_events_enabled() AND EXISTS (SELECT 1 FROM new_rows) THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', lower(TG_OP));
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch_gap_on_batch_old() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF dispatch_gap_events_enabled() AND EXISTS (SELECT 1 FROM old_rows) THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', lower(TG_OP));
  END IF;
  RETURN NULL;
END;
$$;

-- ------------------------------------------------------------
-- 4. 時間翻轉：投票日前後 roster 的 voted（UTC 日期）與補號次的窗口（台北日期）換面，不是任何一筆資料的變更
--    今天（UTC 或台北）落在某場選舉投票日前 1 天到後 3 天之內，就補一筆整臂事件；其餘日子什麼都不做
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_date_flip_roster() RETURNS INTEGER
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM elections e
              WHERE e.election_date BETWEEN LEAST(CURRENT_DATE, activity_today()) - 3 AND GREATEST(CURRENT_DATE, activity_today()) + 1) THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', 'date_flip');
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', 'date_flip');
    RETURN 1;
  END IF;
  RETURN 0;
END;
$$;

COMMENT ON FUNCTION dispatch_gap_roster_unit_key(INTEGER, TEXT, TEXT) IS '20261127044503：名冊差異單位鍵 unit:<選舉>:<縣市＋鄉鎮>:<職位>（臺→台）。task_id 去掉前綴就是它，鍵與 dispatch_gap_scope_key 的 roster 分支同一個組法。';
COMMENT ON FUNCTION dispatch_gap_ballot_unit_key(INTEGER, TEXT, TEXT, TEXT) IS '20261127044503：補號次單位鍵 ballot:<選舉>:<職位>:<縣市>:<鄉鎮或空>（臺→台）。cand_no、cand_no_recheck 與所有分件 pN 同一個鍵。';
COMMENT ON FUNCTION dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT) IS '20261127044503：入列一個單位（選舉、職位、縣市、鄉鎮或選舉區）在名單族三支臂的所有可能鍵；給批次同步函式結束處一次呼叫。回傳新增事件數。';
COMMENT ON FUNCTION dispatch_gap_recompute_roster_unit_findings(TEXT[]) IS '20261127044503：roster_unit_findings 的按鍵版（鍵＝unit:<選舉>:<縣市＋鄉鎮>:<職位>），本體同現行函式、只在來源 roster_diff_findings() 後多一行鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_recompute_roster_gap_units(TEXT[]) IS '20261127044503：roster_gap_units 的按鍵版（鍵同上），本體同現行函式、只在最後的 SELECT 多一行鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_recompute_ballot_numbers(TEXT[]) IS '20261127044503：補號次臂的按鍵版（鍵＝ballot:<選舉>:<職位>:<縣市>:<鄉鎮或空>），本體同現行臂函式、只在 ranked 與 ru 的來源各多一行單位鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_date_flip_roster() IS '20261127044503：投票日前後補名冊差異與補號次的整臂事件（voted 與窗口隨日期換面）。pg_cron dispatch-gap-date-flip-roster UTC 00:06 與 16:06 呼叫。';

REVOKE ALL ON FUNCTION dispatch_gap_roster_unit_key(INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_ballot_unit_key(INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_ballot_scope(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_roster_scope(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_scope_key(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_roster_keys(INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_ballot_keys(INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_enqueue_roster_units(INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_roster_unit_findings(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_roster_gap_units(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_ballot_numbers(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_on_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_on_batch_new() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_on_batch_old() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_date_flip_roster() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 5. 登記三支臂（鍵規則與按鍵版）；ballot_numbers 在第 0 期已登記為 off，這裡才進 dispatch_gap_arm_keys
-- ------------------------------------------------------------
INSERT INTO dispatch_gap_arm_keys (arm, full_fn, recompute_fn, key_expr_desc, key_example) VALUES
  ('roster_unit_findings', 'roster_unit_findings()', 'dispatch_gap_recompute_roster_unit_findings(text[])',
   '名冊差異按單位彙總（總表的輔助函式，不是 UNION 分支）：gap_key＝task_id（auto:roster_check:<選舉>:<縣市＋鄉鎮>:<職位>）；scope_key＝unit:<選舉>:<縣市＋鄉鎮>:<職位>（臺→台）。事件來源：politician_elections、politicians、contributions（四型別）、elections、election_milestones、cec_roster_units、cec_candidates、cec_registrations、roster_unify_settings。',
   'auto:roster_check:2026:臺北市:縣市長 → unit:2026:台北市:縣市長'),
  ('roster_gap_units', 'roster_gap_units()', 'dispatch_gap_recompute_roster_gap_units(text[])',
   '2026 名單缺口按單位彙總（總表的輔助函式）：gap_key＝task_id（auto:roster_check:2026:<縣市＋鄉鎮>:<職位>）；scope_key 同 roster_unit_findings。事件來源同上（名冊鏡像 cec_roster_units 為主）。',
   'auto:roster_check:2026:花蓮縣花蓮市:村里長 → unit:2026:花蓮縣花蓮市:村里長'),
  ('ballot_numbers', 'contribution_auto_tasks_ballot_numbers()', 'dispatch_gap_recompute_ballot_numbers(text[])',
   '補號次：gap_key＝task_id（auto:candidacy_source_missing:cand_no[_recheck]:<選舉>:<職位>:<縣市>[:<鄉鎮>][:pN]）；scope_key＝ballot:<選舉>:<職位>:<縣市>:<鄉鎮或空>（去掉 pN，cand_no 與 cand_no_recheck 同一個鍵）。整單位重算（ROW_NUMBER 每 50 人切件）。',
   'auto:candidacy_source_missing:cand_no:2026:村里長:花蓮縣:花蓮市:p2 → ballot:2026:村里長:花蓮縣:花蓮市')
ON CONFLICT (arm) DO UPDATE SET full_fn = EXCLUDED.full_fn, recompute_fn = EXCLUDED.recompute_fn,
  key_expr_desc = EXCLUDED.key_expr_desc, key_example = EXCLUDED.key_example;

-- ------------------------------------------------------------
-- 6. 切 shadow ＋ 初始灌入（觸發器之前做，不讓 CREATE TRIGGER 的表鎖等著它）
-- ------------------------------------------------------------
SELECT dispatch_gap_set_mode('roster_unit_findings', 'shadow', '第 2 期 PR-1：雙軌開始（輔助函式，總表不讀常駐表）');
SELECT dispatch_gap_set_mode('roster_gap_units', 'shadow', '第 2 期 PR-1：雙軌開始（輔助函式，總表不讀常駐表）');
SELECT dispatch_gap_set_mode('ballot_numbers', 'shadow', '第 2 期 PR-1：雙軌開始');

DO $$
BEGIN
  -- 與 seed 的 drain 共用 advisory lock：恰好撞上就拿不到鎖、這裡什麼都沒灌；下面補的整臂事件會讓第一輪 seed 補上
  PERFORM count(*) FROM dispatch_gap_reconcile_all(ARRAY['roster_unit_findings', 'roster_gap_units', 'ballot_numbers']);
END $$;

-- ------------------------------------------------------------
-- 7. 觸發器（最後才掛；表鎖到交易結束，所以只留短短一段）
-- ------------------------------------------------------------
SET LOCAL lock_timeout = '30s';

-- 三支重建：欄位清單與 WHEN 變寬
DROP TRIGGER IF EXISTS trg_dispatch_gap_politician_elections ON politician_elections;
CREATE TRIGGER trg_dispatch_gap_politician_elections
  AFTER INSERT OR UPDATE OF candidacy_status, election_id, politician_id, region_id, election_type, cand_no, party_id, party_basis, withdrawn_after_filing OR DELETE
  ON politician_elections FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_politicians ON politicians;
CREATE TRIGGER trg_dispatch_gap_politicians
  AFTER UPDATE OF name, region, merged_into, birth_year, party
  ON politicians FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_contributions ON contributions;
CREATE TRIGGER trg_dispatch_gap_contributions
  AFTER INSERT OR UPDATE OF status, applied_policy_id
  ON contributions FOR EACH ROW
  WHEN (NEW.contribution_type IN ('policy', 'policy_subtopics', 'cand_numbers', 'candidacy', 'election_results', 'reassign_candidacy'))
  EXECUTE FUNCTION dispatch_gap_on_change();

-- 新增
DROP TRIGGER IF EXISTS trg_dispatch_gap_election_milestones ON election_milestones;
CREATE TRIGGER trg_dispatch_gap_election_milestones
  AFTER INSERT OR UPDATE OR DELETE
  ON election_milestones FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_roster_units ON cec_roster_units;
CREATE TRIGGER trg_dispatch_gap_cec_roster_units
  AFTER INSERT OR UPDATE OF status, row_count, fetched_at OR DELETE
  ON cec_roster_units FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_contribution_tasks ON contribution_tasks;
CREATE TRIGGER trg_dispatch_gap_contribution_tasks
  AFTER INSERT OR UPDATE OF status
  ON contribution_tasks FOR EACH ROW WHEN (NEW.task_type = 'candidate_status_stale')
  EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_roster_unify_settings ON roster_unify_settings;
CREATE TRIGGER trg_dispatch_gap_roster_unify_settings
  AFTER UPDATE
  ON roster_unify_settings FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_ins ON cec_candidates;
CREATE TRIGGER trg_dispatch_gap_cec_candidates_ins
  AFTER INSERT ON cec_candidates REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_new();
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_upd ON cec_candidates;
CREATE TRIGGER trg_dispatch_gap_cec_candidates_upd
  AFTER UPDATE ON cec_candidates REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_new();
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_del ON cec_candidates;
CREATE TRIGGER trg_dispatch_gap_cec_candidates_del
  AFTER DELETE ON cec_candidates REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_old();

DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_registrations_ins ON cec_registrations;
CREATE TRIGGER trg_dispatch_gap_cec_registrations_ins
  AFTER INSERT ON cec_registrations REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_new();
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_registrations_upd ON cec_registrations;
CREATE TRIGGER trg_dispatch_gap_cec_registrations_upd
  AFTER UPDATE ON cec_registrations REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_new();
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_registrations_del ON cec_registrations;
CREATE TRIGGER trg_dispatch_gap_cec_registrations_del
  AFTER DELETE ON cec_registrations REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_batch_old();

-- ------------------------------------------------------------
-- 8. 補整臂事件（灌入到掛上觸發器之間漏掉的變更，第一輪 seed 的 drain 一次補齊）
-- ------------------------------------------------------------
SELECT dispatch_gap_enqueue('roster_unit_findings', '*', 'migration');
SELECT dispatch_gap_enqueue('roster_gap_units', '*', 'migration');
SELECT dispatch_gap_enqueue('ballot_numbers', '*', 'migration');

-- ------------------------------------------------------------
-- 9. 排程：投票日前後的時間翻轉（UTC 00:06 與 16:06；分鐘避開整十、:29、:35 與奇數分鐘）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $q$SELECT cron.unschedule('dispatch-gap-date-flip-roster') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-gap-date-flip-roster')$q$;
    EXECUTE $q$SELECT cron.schedule('dispatch-gap-date-flip-roster', '6 0,16 * * *', 'SELECT dispatch_gap_date_flip_roster();')$q$;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 10. 自我檢查：六支臂是 shadow（第 1 期三支加本期三支）、按鍵版都在且已登記、觸發器都掛上、沒有 live
-- ------------------------------------------------------------
DO $$
DECLARE
  v_n INTEGER;
BEGIN
  IF (SELECT count(*) FROM dispatch_gap_arms WHERE mode = 'shadow') <> 6
     OR EXISTS (SELECT 1 FROM dispatch_gap_arms WHERE mode = 'shadow'
                 AND arm NOT IN ('legacy', 'mismatch', 'issue_too_broad', 'roster_unit_findings', 'roster_gap_units', 'ballot_numbers'))
     OR EXISTS (SELECT 1 FROM dispatch_gap_arms WHERE mode = 'live') THEN
    RAISE EXCEPTION '第 2 期 PR-1：只有第 1 期三支加 roster_unit_findings、roster_gap_units、ballot_numbers 可以是 shadow，不能有 live';
  END IF;
  IF EXISTS (SELECT 1 FROM dispatch_gap_arm_keys k WHERE k.arm IN ('roster_unit_findings', 'roster_gap_units', 'ballot_numbers')
              AND (k.recompute_fn IS NULL OR to_regprocedure(k.recompute_fn) IS NULL)) THEN
    RAISE EXCEPTION '第 2 期 PR-1：三支名單族臂的按鍵版沒有登記或函式不存在';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger WHERE tgname LIKE 'trg\_dispatch\_gap\_%' AND NOT tgisinternal;
  IF v_n <> 22 THEN
    RAISE EXCEPTION '第 2 期 PR-1：預期共掛 22 支觸發器（第 1 期 12 支＋本期新增 10 支，三支重建不增加），實際 %', v_n;
  END IF;
  IF NOT dispatch_gap_events_enabled() OR NOT dispatch_gap_seed_drain_enabled() THEN
    RAISE EXCEPTION '第 2 期 PR-1：事件與 seed drain 兩個開關都要是開';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
