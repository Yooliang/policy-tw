-- 派工臂事件驅動化 第 2 期 PR-2：名單清查整族（後半）——roster_cec_gap／roster_villages／district_seats／raw:roster_check 按單位重算、
--   把單位鍵推進 roster_diff_findings()／cec_roster_diff()、補事件盲區的觸發器，切 shadow（派工輸出不變）
--
-- 設計文件：docs/dispatch-arms-event-driven-plan.md 第 5 節「第 2 期」與附錄 A.1／A.3。接第 2 期 PR-1（20261127044503）。
--
-- 這一支做的事（派工輸出一個字不變；總表、seed、四支臂本體都不碰）：
--   A. 四支臂的按鍵重算函式（輸出欄位與原臂相同；p_keys 是 dispatch_gap_scope_key 的 scope_key，'*' 不會送進來——整臂走整表函式）：
--        dispatch_gap_recompute_roster_cec_gap／_roster_villages／_district_seats／_raw_roster_check(p_keys)
--      本體與現行臂函式逐字相同，只多一行單位鍵過濾（roster_cec_gap：marked 的來源 c 一行；roster_villages、district_seats、raw:roster_check：最後的 WHERE 一行）；
--      測試逐行比對最新定義。raw 的八個任務型別共用一支大函式，只有 roster_check 這一段進來：按鍵版把那一段與它用到的兩個小 CTE（ours、filed_out）原樣搬出，
--      整表版 dispatch_gap_full_raw_roster_check() 則是「contribution_auto_tasks_raw() 只取 roster_check」，雙軌比對拿它對帳，不跟按鍵版共用本體。
--      登記進 dispatch_gap_arm_keys，四支都切 shadow（它們都是總表的 UNION 分支或 raw 的型別分支，之後可切 live；本期不切）。
--   B. 把單位鍵推進底層：cec_roster_diff(p_keys TEXT[] DEFAULT NULL) 與 roster_diff_findings(p_keys TEXT[] DEFAULT NULL)。
--      NULL＝整表（輸出與舊版一個字不變；測試對舊版真定義雙向 EXCEPT 為 0）；非 NULL＝只算那些單位。
--      舊簽名（無參數）先 DROP 再建新簽名（同一個交易，沒有空窗；既有呼叫 cec_roster_diff()／roster_diff_findings() 的 SQL 函式與 Edge Function 照舊可用）。
--      cec_roster_diff：所有配對都在「同選舉別、同縣市（村里長到鄉鎮）」之內，所以鍵過濾直接放在輸入端（fresh 單位與我們的參選紀錄 o），整支只算該單位。
--      roster_diff_findings：七支臂函式（party_roster、party_gap、township_gap、region_gap、owner_mismatch、elected_missing、election_results）仍整支跑一次
--      （它們各自是現行的 SQL 函式，沒有單位參數；把鍵推進它們要各自出按鍵版，留給 PR-3）；本支把過濾提到各分支最早的位置：
--      結果類的 election_result_cec_matches（整份裡最貴的一段）只算該單位的參選紀錄，其餘分支在合併前就過濾。
--      PR-1 的 dispatch_gap_recompute_roster_unit_findings／_roster_gap_units 改成把鍵傳下去（本體其餘不動）。
--   C. cec-sync 結尾入列：新函式 dispatch_gap_enqueue_cec_units(p_units jsonb)（只給 service_role）把「名單被動過的同步單位」展開成名冊族各臂的受影響單位鍵
--      （村里長、代表再展開該縣市每個鄉鎮）；Edge Function cec-sync 在迴圈結束後呼叫一次。cec_candidates 的三支語句層級觸發器拿掉（原本每次同步都入一筆整臂）。
--      cec_registrations 的語句層級觸發器保留（只有 migration 載入登記彙總表時才寫；本期多入 district_seats 整臂）。
--      部署順序：migration 先（CI 本來就是先 db push 再部署函式）；兩者之間的幾分鐘內若剛好有同步，那幾個單位沒有事件，由每小時雙軌比對與每日對帳補。
--   D. 事件盲區：regions、election_districts、task_checks、edit_history（參選紀錄建立那一筆）、verification_sources、cec_registration_sources、
--      parties／party_aliases 掛上觸發器（cec_results_auto_plan_rows 不掛：cec_results_auto_refresh 狀態鍵一變就整表 DELETE，語句觸發器連空表也觸發，會把拿掉的整臂觸發器換個地方加回來；它的輸入 cec_candidates、參選紀錄、選舉區已有單位事件；regions 只掛 UPDATE／DELETE，INSERT 新選區的影響靠該選區後續的參選紀錄事件與對帳）；另補新臂自己的來源：roster_checks、roster_reconcile_units、roster_check_scope、electoral_district_areas，
--      contributions 多收 district_seats 型別。politician_pair_resolutions 查過：它只改 cec_roster_diff 的 dup 輸出，而 dup 不進名單族任何一支臂，所以不掛。
--      掛不了單位鍵的（regions、parties 這類）入整臂；task_dispatches 對 roster_cec_gap 的自我參照（已派出去的單位補到一半仍留著）不是事件，見風險。
--
-- 事件來源與鍵：
--   roster_cec_gap、roster_villages、raw:roster_check 與 PR-1 的名冊兩支共用鍵 unit:<選舉>:<縣市＋鄉鎮>:<職位>（臺→台，task_id 去掉前綴）；
--     raw:roster_check 的 task_id 是縣市層級（auto:roster_check:<選舉>:<縣市>:<職位>），鍵同一個組法。
--   district_seats 新鍵 seats:<選舉>:<縣市>:<職位>（task_id＝auto:district_seats_missing:<選舉>:<縣市>:<職位>）；
--     election_districts 一列對到的鍵：本身職位，加上「鄉鎮市長→鄉鎮市民代表」「直轄市山地原住民區長→直轄市山地原住民區民代表」（那兩種代表的縣市清單由區長／市長的選舉區推出來）。
--   dispatch_gap_enqueue_units() 現在一次入名冊三支（PR-1 的兩支＋本期三支，district_seats 不在其中）＋補號次；入列單位的新函式 dispatch_gap_enqueue_roster_arms()。
--
-- 與現行觸發器的關係：
--   dispatch_gap_on_change() 以 20261127044503 版為底重定義（原有分支的行為一個字不變，只加新分支與少數幾行）；
--   dispatch_gap_on_batch_new／_old 加 cec_candidates → roster_cec_gap、cec_registrations → district_seats 整臂；
--   contributions 觸發器重建一次（WHEN 多一個 district_seats 型別，其餘不變）。
--
-- 徹底回滾：貼 docs/rollback/20261127093000_dispatch_gaps_phase2b_rollback.sql（兩支舊簽名的完整定義、31 支觸發器的 DROP、未處理事件的 DELETE 都在裡面，
--   PR-1 函式的換回照該檔註解貼 20261127044503 的行範圍，不需要字串替換）。下面是逐項說明：
-- 回滾（互不依賴）：
--   退回即時算：SELECT dispatch_gap_set_mode('roster_cec_gap', 'off'); roster_villages、district_seats、raw:roster_check 同樣。
--   關事件：UPDATE dispatch_gap_settings SET events_enabled = false WHERE id = 1;
--   新增的觸發器：trg_dispatch_gap_roster_checks、_roster_reconcile_units、_roster_check_scope、_election_districts、_verification_sources、
--     _cec_registration_sources、_task_checks_owner、_edit_history_pe（各 DROP TRIGGER ... ON <表>）；語句層級：trg_dispatch_gap_regions_stmt、_parties_stmt、
--     _party_aliases_stmt、_electoral_district_areas_stmt。contributions 的觸發器換回 20261127044503 的 WHEN。
--   cec_candidates 的三支語句層級觸發器補回（照 20261127044503 的寫法）：trg_dispatch_gap_cec_candidates_ins／_upd／_del（REFERENCING NEW／OLD TABLE AS new_rows／old_rows，
--     FOR EACH STATEMENT，EXECUTE FUNCTION dispatch_gap_on_batch_new／_old）；cec-sync 結尾的呼叫留著無害（函式還在就會入列），要拿掉就把 Edge Function 那幾行還原。
--   dispatch_gap_on_change()、dispatch_gap_on_batch_new／_old、dispatch_gap_enqueue_units()、dispatch_gap_scope_key()、
--     dispatch_gap_recompute_roster_unit_findings／_roster_gap_units 換回 20261127044503 的定義。
--   cec_roster_diff／roster_diff_findings 換回無參數版（DROP 帶參數的新簽名、依 20261109210000＋20261031160000／20261101040000 的原文重建）：
--     DROP FUNCTION cec_roster_diff(TEXT[]); DROP FUNCTION roster_diff_findings(TEXT[]);（先換回上面兩支按鍵版與整表呼叫者，再 DROP，再重建舊簽名）
--   徹底退出（順序要照）：
--     ① 先清未處理事件：DELETE FROM dispatch_gap_events WHERE arm IN ('roster_cec_gap','roster_villages','district_seats','raw:roster_check') AND processed_at IS NULL;
--     ② 把 dispatch_gap_on_change()、dispatch_gap_scope_key() 換回舊定義、拔上面的觸發器，再 DROP 被它們呼叫的函式；
--     ③ DELETE FROM dispatch_gap_arm_keys WHERE arm IN (...四支...); 四支的 dispatch_gap_arms 模式改回 off；DELETE FROM dispatch_gaps WHERE arm IN (...四支...);
--     ④ DROP FUNCTION dispatch_gap_recompute_roster_cec_gap(TEXT[]), dispatch_gap_recompute_roster_villages(TEXT[]), dispatch_gap_recompute_district_seats(TEXT[]),
--        dispatch_gap_recompute_raw_roster_check(TEXT[]), dispatch_gap_full_raw_roster_check(), dispatch_gap_seats_unit_key(INTEGER, TEXT, TEXT),
--        dispatch_gap_seats_scope(TEXT), dispatch_gap_seats_keys(INTEGER, TEXT, TEXT), dispatch_gap_enqueue_seats(INTEGER, TEXT, TEXT, TEXT),
--        dispatch_gap_enqueue_roster_arms(INTEGER, TEXT, TEXT, TEXT, TEXT), dispatch_gap_enqueue_cec_units(JSONB), dispatch_gap_on_stmt();
--
-- 風險：部署時多跑約 5 秒（四支臂初始灌入：roster_cec_gap 約 1 秒、raw 整支約 1 秒、roster_villages、district_seats 各不到 1 秒）；第一輪 seed 開頭的 drain 再補整臂約同量；
--   shadow 期間每小時比對多約 3 秒。
--   roster_cec_gap 的缺口門檻有一條自我參照（單位已經在 task_dispatches 裡就繼續派，補到一半缺口變小也不收）：派工列被收回／出生是 seed 的輸出，不是來源表事件，
--   所以「單位剛好從派工列消失」這種變化要等下一次該單位有任何事件、或每小時雙軌比對與每日對帳才補（雙軌短暫出現差異，不是漏接）；它與現行即時算的語意一致。
--   時間型的變化沒有事件（靠每小時雙軌比對與每日對帳補）：roster_checks 的重查冷卻（recheck_days、roster_attempt_cooldown_days 到期）、
--   名冊鏡像 3 天新鮮度；投票日與名單公告日的翻面由 dispatch_gap_date_flip_roster 補整臂事件（本期擴到 district_seats、raw:roster_check、roster_villages）。
--   roster_cec_gap 的「我們是否已對上」是縣市層級（ours 以選舉＋職位＋縣市＋姓名鍵比），而缺口鍵是鄉鎮層級：鄉鎮 A 的事件（例如補了一位）
--   可能讓同縣市鄉鎮 B 的 matched 也變，這種連動不會自動入列，靠雙軌比對與對帳補（雙軌短暫出現差異，不是漏接錯誤）。
--   cec_roster_diff／roster_diff_findings 的 DROP＋CREATE 取函式鎖，CREATE TRIGGER 取表鎖，放在最後、SET LOCAL lock_timeout 30 秒，拿不到就整支失敗（重跑即可）。

-- ------------------------------------------------------------
-- 1. 鍵的組法（district_seats；名冊三支沿用 PR-1 的 unit 鍵）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_gap_seats_unit_key(p_eid INTEGER, p_etype TEXT, p_county TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'seats:' || p_eid || ':' || replace(p_county, '臺', '台') || ':' || p_etype
$$;

-- 應選名額任務 task_id（auto:district_seats_missing:<選舉>:<縣市>:<職位>）→ 單位鍵
CREATE OR REPLACE FUNCTION dispatch_gap_seats_scope(p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_task_id ~ '^auto:district_seats_missing:[0-9]{1,9}:[^:]+:[^:]+$'
    THEN dispatch_gap_seats_unit_key(split_part(p_task_id, ':', 3)::INTEGER, split_part(p_task_id, ':', 5), split_part(p_task_id, ':', 4))
    ELSE p_task_id
  END
$$;

-- gap_key（task_id）→ 重算單位 scope_key（以 20261127044503 版為底，加四支臂；其餘臂與規則一字不變）
CREATE OR REPLACE FUNCTION dispatch_gap_scope_key(p_arm TEXT, p_task_id TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_arm
    WHEN 'legacy'               THEN 'policy:' || regexp_replace(p_task_id, '^.*:', '')
    WHEN 'mismatch'             THEN 'policy:' || regexp_replace(p_task_id, '^.*:', '')
    WHEN 'issue_too_broad'      THEN 'issue:' || regexp_replace(p_task_id, '^auto:issue_too_broad:', '')
    WHEN 'roster_unit_findings' THEN dispatch_gap_roster_scope(p_task_id)
    WHEN 'roster_gap_units'     THEN dispatch_gap_roster_scope(p_task_id)
    WHEN 'ballot_numbers'       THEN dispatch_gap_ballot_scope(p_task_id)
    WHEN 'raw:roster_check'     THEN dispatch_gap_roster_scope(p_task_id)
    WHEN 'roster_villages'      THEN dispatch_gap_roster_scope(p_task_id)
    WHEN 'roster_cec_gap'       THEN dispatch_gap_roster_scope(p_task_id)
    WHEN 'district_seats'       THEN dispatch_gap_seats_scope(p_task_id)
    ELSE p_task_id
  END
$$;

-- 一列選舉區（選舉、職位、縣市）對到的名額單位鍵：本身職位，加上由它推出縣市清單的代表職位
CREATE OR REPLACE FUNCTION dispatch_gap_seats_keys(p_eid INTEGER, p_etype TEXT, p_region TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(
    SELECT DISTINCT dispatch_gap_seats_unit_key(p_eid, t.et, p_region)
      FROM (VALUES (p_etype),
                   (CASE p_etype WHEN '鄉鎮市長' THEN '鄉鎮市民代表' WHEN '直轄市山地原住民區長' THEN '直轄市山地原住民區民代表' END)) AS t(et)
     WHERE t.et IS NOT NULL
     ORDER BY 1)
$$;

-- 入列應選名額單位（沒登記的臂不入）；回傳這次真的新增幾筆事件
CREATE OR REPLACE FUNCTION dispatch_gap_enqueue_seats(p_eid INTEGER, p_etype TEXT, p_region TEXT, p_kind TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_k TEXT;
  v_n INTEGER := 0;
BEGIN
  IF p_eid IS NULL OR COALESCE(p_etype, '') = '' OR COALESCE(btrim(p_region), '') = '' THEN
    RETURN 0;
  END IF;
  FOREACH v_k IN ARRAY dispatch_gap_seats_keys(p_eid, p_etype, p_region) LOOP
    IF dispatch_gap_enqueue_reg('district_seats', v_k, p_kind) THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- 入列名冊族後半三支（raw:roster_check、roster_cec_gap、roster_villages）的受影響單位：用 PR-1 的「可能鍵」超集（已投票與未投票兩種切法都列，多出來的鍵重算後什麼都沒有），
-- raw:roster_check 的 task_id 是縣市層級，再補一個縣市層級的鍵（村里長到鄉鎮的可能鍵裡沒有縣市層級那一個）
CREATE OR REPLACE FUNCTION dispatch_gap_enqueue_roster_arms(p_eid INTEGER, p_etype TEXT, p_county TEXT, p_sub TEXT, p_kind TEXT) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_k TEXT;
  v_n INTEGER := 0;
BEGIN
  IF p_eid IS NULL OR COALESCE(p_etype, '') = '' OR COALESCE(btrim(p_county), '') = '' THEN
    RETURN 0;
  END IF;
  FOREACH v_k IN ARRAY dispatch_gap_roster_keys(p_eid, p_etype, p_county, p_sub) LOOP
    IF dispatch_gap_enqueue_reg('raw:roster_check', v_k, p_kind) THEN v_n := v_n + 1; END IF;
    IF dispatch_gap_enqueue_reg('roster_cec_gap', v_k, p_kind) THEN v_n := v_n + 1; END IF;
    IF p_etype = '村里長' AND dispatch_gap_enqueue_reg('roster_villages', v_k, p_kind) THEN v_n := v_n + 1; END IF;
  END LOOP;
  IF dispatch_gap_enqueue_reg('raw:roster_check', dispatch_gap_roster_unit_key(p_eid, p_county, p_etype), p_kind) THEN v_n := v_n + 1; END IF;
  RETURN v_n;
END;
$$;

-- 公開入列（同步函式結束處用）：PR-1 的名冊兩支與補號次，加本期三支
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
  v_n := v_n + dispatch_gap_enqueue_roster_arms(p_eid, p_etype, p_county, p_sub, p_kind);
  FOREACH v_k IN ARRAY dispatch_gap_ballot_keys(p_eid, p_etype, p_county, p_sub) LOOP
    IF dispatch_gap_enqueue_reg('ballot_numbers', v_k, p_kind) THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- 同步函式（Edge Function cec-sync）寫完名單後一次呼叫：p_units 是 [{election_id, election_type, region, sub_region?}, ...]，每個是「名單被動過的同步單位」。
-- 展開成名冊族各臂的受影響單位鍵：縣市層級一組；村里長、鄉鎮市民代表、原住民區民代表（單位到縣市＋鄉鎮）再展開該縣市每個鄉鎮——
-- 鄉鎮清單取「這個縣市在 cec_candidates 現在有的」加「regions 裡這個縣市有的」（先刪後寫，被刪掉的鄉鎮不在新資料裡，要靠 regions 補上）。
-- 回傳這次真的新增幾筆事件（同鍵未處理的不重複）。
CREATE OR REPLACE FUNCTION dispatch_gap_enqueue_cec_units(p_units JSONB) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  u     RECORD;
  v_t   TEXT;
  v_n   INTEGER := 0;
BEGIN
  IF NOT dispatch_gap_events_enabled() OR jsonb_typeof(p_units) IS DISTINCT FROM 'array' THEN
    RETURN 0;
  END IF;
  FOR u IN
    SELECT x.election_id, x.election_type, x.region
      FROM jsonb_to_recordset(p_units) AS x(election_id INTEGER, election_type TEXT, region TEXT)
     WHERE x.election_id IS NOT NULL AND COALESCE(x.election_type, '') <> '' AND COALESCE(btrim(x.region), '') <> ''
     GROUP BY x.election_id, x.election_type, x.region
  LOOP
    v_n := v_n + dispatch_gap_enqueue_roster_units(u.election_id, u.election_type, u.region, NULL, 'cec_sync')
               + dispatch_gap_enqueue_roster_arms(u.election_id, u.election_type, u.region, NULL, 'cec_sync');
    IF u.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN
      FOR v_t IN
        SELECT DISTINCT s.t FROM (
          SELECT NULLIF(regexp_replace(COALESCE(c.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '') AS t
            FROM cec_candidates c
           WHERE c.election_id = u.election_id AND c.election_type = u.election_type AND c.region = u.region
          UNION
          SELECT NULLIF(regexp_replace(COALESCE(r.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '')
            FROM regions r
           WHERE replace(r.region, '臺', '台') = replace(u.region, '臺', '台')
        ) s
         WHERE s.t IS NOT NULL
         ORDER BY 1
      LOOP
        v_n := v_n + dispatch_gap_enqueue_roster_units(u.election_id, u.election_type, u.region, v_t, 'cec_sync')
                   + dispatch_gap_enqueue_roster_arms(u.election_id, u.election_type, u.region, v_t, 'cec_sync');
      END LOOP;
    END IF;
  END LOOP;
  RETURN v_n;
END;
$$;

-- ------------------------------------------------------------
-- 2. B：把單位鍵推進 cec_roster_diff()／roster_diff_findings()
--    舊簽名（無參數）DROP 掉、建帶 p_keys 的新簽名；NULL＝整表。同一個交易，沒有空窗。
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS cec_roster_diff();

-- 本體＝20261031160000 的 cec_roster_diff()＋20261109210000 的 dup 排除已裁決不同人，只多三處鍵過濾（標 ★）
CREATE OR REPLACE FUNCTION cec_roster_diff(p_keys TEXT[] DEFAULT NULL)
RETURNS TABLE (kind TEXT, diff_key TEXT, election_type TEXT, county TEXT, town TEXT, unit TEXT, cand_no INTEGER,
               pe_id INTEGER, politician_id UUID, our_name TEXT, our_status TEXT, our_cand_no INTEGER,
               roster_id BIGINT, roster_name TEXT, roster_party TEXT, roster_birth TEXT, roster_url TEXT, roster_li_code TEXT,
               partner_pe_id INTEGER, partner_politician_id UUID, partner_name TEXT)
LANGUAGE sql STABLE SET enable_nestloop = off AS $fn$
  WITH
  fresh AS MATERIALIZED (
    SELECT u.election_type, replace(u.county, '臺', '台') AS county, replace(u.town, '臺', '台') AS town
      FROM cec_roster_units u WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days'
       -- ★ 單位鍵過濾：所有配對都在「同選舉別、同縣市（村里長到鄉鎮）」之內，鍵放在輸入端整支就只算該單位
       AND (p_keys IS NULL OR dispatch_gap_roster_unit_key(2026, replace(u.county, '臺', '台') || CASE WHEN u.election_type = '村里長' THEN replace(u.town, '臺', '台') ELSE '' END, u.election_type) = ANY (p_keys))
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
       -- ★ 單位鍵過濾
       AND (p_keys IS NULL OR dispatch_gap_roster_unit_key(2026, o0.county || o0.scope_town, o0.election_type) = ANY (p_keys))
  ),
  -- 第一輪：同單位、同姓名鍵，一對一（同名的依號次排名配對）
  ro AS MATERIALIZED (SELECT r.*, row_number() OVER (PARTITION BY r.election_type, r.unit, r.nkey ORDER BY r.cand_no, r.id) AS rk FROM r),
  oo AS MATERIALIZED (SELECT o.*, row_number() OVER (PARTITION BY o.election_type, o.unit, o.nkey ORDER BY o.cand_no, o.pe_id) AS rk FROM o WHERE o.unit IS NOT NULL),
  m1 AS MATERIALIZED (
    SELECT oo.pe_id, ro.id AS rid FROM oo JOIN ro ON ro.election_type = oo.election_type AND ro.unit = oo.unit AND ro.nkey = oo.nkey AND ro.rk = oo.rk
  ),
  -- 第二輪：剩下的在同單位做容錯
  lo AS MATERIALIZED (SELECT o.* FROM o WHERE o.unit IS NOT NULL AND NOT EXISTS (SELECT 1 FROM m1 WHERE m1.pe_id = o.pe_id)),
  lr AS MATERIALIZED (SELECT r.* FROM r WHERE NOT EXISTS (SELECT 1 FROM m1 WHERE m1.rid = r.id)),
  m2 AS MATERIALIZED (
    SELECT lo.pe_id, lr.id AS rid FROM lo JOIN lr ON lr.election_type = lo.election_type AND lr.unit = lo.unit AND cec_name_fuzzy_eq(lo.nkey, lr.nkey, lo.cand_no, lr.cand_no)
  ),
  -- 第三輪：參選紀錄沒有選區／鄉鎮（單位算不出來），退到縣市（村里長到鄉鎮）層級比姓名
  m3 AS MATERIALIZED (
    SELECT o.pe_id, r.id AS rid FROM o JOIN r ON r.election_type = o.election_type AND r.county = o.county
                                               AND (o.election_type <> '村里長' OR r.town = o.scope_town)
     WHERE o.unit IS NULL AND cec_name_fuzzy_eq(o.nkey, r.nkey, o.cand_no, r.cand_no)
  ),
  mo AS MATERIALIZED (SELECT pe_id FROM m1 UNION SELECT pe_id FROM m2 UNION SELECT pe_id FROM m3),
  mr AS MATERIALIZED (SELECT rid FROM m1 UNION SELECT rid FROM m2 UNION SELECT rid FROM m3),
  -- 同單位同號次、我們有兩筆不同人物，且其中至少一筆對不上官方名冊，而官方在該單位有這個號次（村里長的單位是村里，官方只到鄉鎮）
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
COMMENT ON FUNCTION cec_roster_diff(TEXT[]) IS '官方名冊鏡像 × 我們的 2026 參選紀錄（非 withdrawn）的差異：extra（我們有、官方沒有）、missing（官方有、我們沒有）、dup（同單位同號次兩筆人物，至少一筆對不上官方；已有 politician_pair_resolutions＝different 的一對不算）。只比近 3 天內抓成功的單位；容錯規則見 cec_name_fuzzy_eq。唯讀。p_keys（unit:2026:<縣市＋鄉鎮>:<職位>）為 NULL＝整表，非 NULL＝只算那些單位。2026-10-31，2026-11-09 dup 排除已裁決不同人，2026-11-27 加單位鍵';

DROP FUNCTION IF EXISTS roster_diff_findings();

-- 本體＝20261101040000 的 roster_diff_findings()，只多鍵過濾（標 ★）：七支臂函式本身仍整支跑一次（它們沒有單位參數），
-- 過濾提到各分支最早的位置：結果類的 election_result_cec_matches 只算該單位的參選紀錄；其餘分支在合併前就過濾
CREATE OR REPLACE FUNCTION roster_diff_findings(p_keys TEXT[] DEFAULT NULL)
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
     -- ★ 單位鍵過濾
     WHERE (p_keys IS NULL OR dispatch_gap_roster_unit_key(x.election_id, x.county || roster_unify_town(x.voted, x.election_type, x.r_sub), x.election_type) = ANY (p_keys))
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
       -- ★ 單位鍵過濾
       AND (p_keys IS NULL OR dispatch_gap_roster_unit_key((t.target->>'election_id')::INTEGER, replace(t.target->>'region', '臺', '台'), t.target->>'election_type') = ANY (p_keys))
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
       -- ★ 單位鍵過濾（超集，下面 er_f 再做精確的）：先把不在這批單位的參選紀錄擋掉，election_result_cec_matches 才不用算整份
       AND (p_keys IS NULL OR EXISTS (SELECT 1 FROM politician_elections pk
                                        JOIN politicians pp ON pp.id = pk.politician_id
                                        LEFT JOIN regions rk ON rk.id = pk.region_id
                                       WHERE pk.id = x.id::INTEGER
                                         AND dispatch_gap_roster_keys(pk.election_id, pk.election_type, COALESCE(rk.region, pp.region), COALESCE(rk.sub_region, pp.sub_region)) && p_keys))
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
       -- ★ 單位鍵過濾
       AND (p_keys IS NULL OR dispatch_gap_roster_unit_key(c.election_id, c.county || roster_unify_town(true, c.election_type, c.town), c.election_type) = ANY (p_keys))
  ),
  -- 縣市長縣市不符（單位＝官方名冊的縣市）
  rm AS (
    SELECT m.election_id, '縣市長'::TEXT AS election_type, m.official_county AS county, ''::TEXT AS town, false AS voted, '縣市'::TEXT AS kind,
           m.politician_id AS pid, m.politician_election_id AS pe_id, m.name,
           jsonb_build_object('region', m.cur_county, 'region_id', m.current_region_id, 'kind', 'region_mismatch') AS cur,
           jsonb_build_object('region', m.official_county, 'proposed_region_id', m.proposed_region_id, 'fix', 'correction 改 politician_elections.region_id') AS off,
           m.source_url AS url, NULL::TEXT AS task_id
      FROM roster_region_mismatch_findings() m
     -- ★ 單位鍵過濾
     WHERE (p_keys IS NULL OR dispatch_gap_roster_unit_key(m.election_id, m.official_county, '縣市長') = ANY (p_keys))
  )
  SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM pe_f f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM em f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM er_f f
  UNION ALL SELECT f.election_id, f.election_type, f.county, f.town, f.voted, f.kind, f.pid, f.pe_id, f.name, f.cur, f.off, f.url, f.task_id FROM rm f
$$;
COMMENT ON FUNCTION roster_diff_findings(TEXT[]) IS '名冊類差異（finding）：缺人／政黨／鄉鎮／縣市／結果／掛錯人。結果類（elected_missing、election_results）只算投票日已過的屆。p_keys（unit:<選舉>:<縣市＋鄉鎮>:<職位>）為 NULL＝整表，非 NULL＝只回那些單位（七支臂函式仍整支跑，過濾提到各分支最早的位置）。2026-11-01，2026-11-27 加單位鍵';

-- ------------------------------------------------------------
-- 3. A：四支臂的按鍵重算
-- ------------------------------------------------------------

-- roster_cec_gap：與 20261008180000 的 contribution_auto_tasks_roster_cec_gap() 逐字相同，只在 marked 的來源 c 多一行單位鍵過濾
--   （units 以 election_id、election_type、county、town 分組，整個單位的列都在鍵裡，不會算出半個單位）
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_roster_cec_gap(p_keys TEXT[])
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT c.election_id, c.election_type, c.name, c.name_norm, c.sub_region, c.village, c.elected, c.cand_no, c.cec_cand_id,
           replace(c.region, '臺', '台') AS county,
           -- 一個鄉鎮動輒幾十人的三種，以鄉鎮市區為單位；代表的 sub_region 是「南投市第01選舉區」「蘭嶼鄉選舉區」，去掉選舉區
           CASE WHEN c.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')
                THEN COALESCE(NULLIF(regexp_replace(COALESCE(c.sub_region, ''), '(第[0-9]+)?選舉區$', ''), ''), '')
                ELSE '' END AS town
      FROM cec_candidates c
     -- 不分區立委是政黨名單，不是個人參選；當選的由 contribution_auto_tasks_elected_missing 派
     WHERE NOT (c.region = '全國' AND c.sub_region = '不分區')
  ),
  ours AS MATERIALIZED (
    SELECT DISTINCT pe.election_id, pe.election_type, replace(COALESCE(r.region, p.region), '臺', '台') AS county, cec_name_key(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_id IN (SELECT DISTINCT x.election_id FROM cec_candidates x)
  ),
  marked AS MATERIALIZED (
    SELECT c.*,
           EXISTS (SELECT 1 FROM ours o
                    WHERE o.election_id = c.election_id AND o.election_type = c.election_type
                      AND o.county = c.county AND o.nn = c.name_norm) AS matched,
           -- 當選而且是 elected_missing 那五種：那支臂逐位派任務，這裡不重複列
           COALESCE(c.elected, false) AND c.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長') AS covered_elsewhere
      FROM c
     WHERE dispatch_gap_roster_unit_key(c.election_id, c.county || c.town, c.election_type) = ANY (p_keys)
  ),
  units AS (
    SELECT m.election_id, m.election_type, m.county, m.town,
           count(*) AS cec_n,
           count(*) FILTER (WHERE m.elected) AS cec_elected,
           count(*) FILTER (WHERE m.matched) AS ours_n,
           count(*) FILTER (WHERE NOT m.matched) AS missing_n,
           count(*) FILTER (WHERE NOT m.matched AND NOT m.covered_elsewhere) AS list_n,
           jsonb_agg(jsonb_build_object('name', m.name, 'sub_region', m.sub_region, 'village', m.village,
                                        'elected', m.elected, 'cand_no', m.cand_no, 'cec_cand_id', m.cec_cand_id)
                     ORDER BY m.sub_region, m.village, m.cand_no, m.name)
             FILTER (WHERE NOT m.matched AND NOT m.covered_elsewhere) AS missing
      FROM marked m
     GROUP BY m.election_id, m.election_type, m.county, m.town
  ),
  picked AS (
    SELECT u.*, u.county || u.town AS unit,
           -- 這一種選舉，candidacy 的地區欄怎麼填
           CASE
             WHEN u.election_type = '村里長'
               THEN 'region 填「' || u.county || '」、sub_region 填「' || u.town || '」、village 填每位的村里（target.missing 的 village）'
             WHEN u.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
               THEN 'region 填「' || u.county || '」、sub_region 填「' || u.town || '」（鄉鎮市區名，不要寫選舉區）'
             WHEN u.election_type IN ('鄉鎮市長', '直轄市山地原住民區長')
               THEN 'region 填「' || u.county || '」、sub_region 填每位的鄉鎮市區（target.missing 的 sub_region）'
             WHEN u.election_type = '縣市議員'
               THEN 'region 填「' || u.county || '」、electoral_district 填每位的選舉區（target.missing 的 sub_region，例：第07選舉區）'
             WHEN u.election_type = '立法委員' AND u.county = '全國'
               THEN 'region 填「全國」、electoral_district 填每位的 sub_region（平地原住民或山地原住民）'
             WHEN u.election_type = '立法委員'
               THEN 'region 填「' || u.county || '」、electoral_district 填每位的選區（target.missing 的 sub_region）'
             ELSE 'region 填「' || u.county || '」'
           END AS fields_how
      FROM units u
     WHERE u.list_n > 0
       -- 我們 0 筆，或明顯偏少（少 3 位以上而且少兩成以上）；零星一兩位多半是姓名寫法不同，交給 cec_reconcile 那條路
       AND (u.ours_n = 0 OR (u.missing_n >= 3 AND u.missing_n * 5 >= u.cec_n)
            -- 已經派出去的單位：補到一半缺口變小（中山區 87 位補了 70 位，剩 17 位不到兩成）也要繼續派，
            -- 直到補完、或有人交 roster_check 收尾——不然門檻會在補到一半時把任務收回，剩下的人永遠沒人補（PGlite 實跑抓到的）
            OR EXISTS (SELECT 1 FROM task_dispatches d
                        WHERE d.task_id = 'auto:roster_check:' || u.election_id || ':' || u.county || u.town || ':' || u.election_type))
  )
  SELECT 'auto:roster_check:' || x.election_id || ':' || x.unit || ':' || x.election_type,
         'roster_check',
         jsonb_build_object('election_id', x.election_id, 'region', x.unit, 'county', x.county, 'township', NULLIF(x.town, ''),
                            'election_type', x.election_type, 'list_source', 'cec',
                            'cec_count', x.cec_n, 'cec_elected', x.cec_elected, 'ours_count', x.ours_n,
                            'missing_count', x.list_n,
                            -- 一件最多列 120 位（大安區 98 位是目前最多的）；多的補完一批，下一輪會列出剩下的
                            'missing', jsonb_path_query_array(x.missing, '$[0 to 119]'),
                            'missing_truncated', x.list_n > 120,
                            'last_checked', rc.last_checked, 'last_failed_attempt', rc.last_attempt_without_count),
         x.unit || ' ' || x.election_id || ' ' || x.election_type || '名單缺人：中選會選舉資料庫上有 ' || x.cec_n || ' 位候選人（當選 '
           || x.cec_elected || ' 位），我們只對得上 ' || x.ours_n || ' 位；要補的 ' || x.list_n || ' 位列在 target.missing'
           || CASE WHEN x.list_n > 120 THEN '（只列前 120 位，補完下一輪會列出剩下的）' ELSE '' END || '。'
           || '這一屆已經投票，名單就在中選會選舉資料庫（db.cec.gov.tw），不用去找登記公告。'
           || '請逐位核對後，每位用 candidacy 型別補一筆：election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、'
           || x.fields_how
           || '、candidate_status 填 qualified（中選會名單上的人；confirmed 只表示表態參選）、election_result 照中選會填 elected 或 not_elected（查得到號次 cand_no 就一起附；得票數不收），'
           || 'source_urls 附你核對的中選會頁面；系統會拿中選會的資料自動核對，我們資料庫裡已有這個人（同名只有一位）而且姓名、縣市、當選與否都對得上的，直接上線。'
           || '名字相同不代表同一人：先用第 7 節的唯讀查詢看我們有沒有同名的人、他的參選紀錄與出生年，確定是同一人才填他的 politician_id，不是就只填 name。'
           || '一次最多 20 筆，可分多次交。全部補完才用 roster_check 收尾（election_id、region、election_type 照 target 原樣帶回，region 就是「'
           || x.unit || '」這一串；cec_count 填中選會名單上的人數）；只補了一部分就不要交 roster_check，剩下的人系統下一輪會再派。',
         ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：選該屆、該選舉、該縣市（鄉鎮）看完整名單與得票',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 逐位核對歷屆參選與當選',
               'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":' || x.election_id || '}'],
         2, x.county
    FROM picked x
    LEFT JOIN LATERAL (
      -- 兩個時鐘（同 2026 的清查）：真的清查完的（cec_count 有值）壓 30 天；只是試過沒查到的壓 roster_attempt_cooldown_days
      SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
             MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
        FROM roster_checks k
       WHERE k.election_id = x.election_id AND k.region = x.unit AND k.election_type = x.election_type
    ) rc ON TRUE
   WHERE (rc.last_checked IS NULL OR rc.last_checked < now() - INTERVAL '30 days')
     AND (rc.last_attempt_without_count IS NULL
          OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
$$;

-- roster_villages：與 20261029030000 的 contribution_auto_tasks_roster_villages() 逐字相同，只在最後的 WHERE 多一行單位鍵過濾
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_roster_villages(p_keys TEXT[])
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    -- roc_year：名冊標題的民國年（原本寫死 115）
    SELECT sc.*, (EXTRACT(YEAR FROM e.election_date)::INTEGER - 1911) AS roc_year
      FROM roster_check_scope sc JOIN elections e ON e.id = sc.election_id
     WHERE sc.election_type = '村里長' AND sc.enabled
  ),
  towns AS (
    SELECT DISTINCT replace(a.region, '臺', '台') AS county, a.township
    FROM electoral_district_areas a
    WHERE a.township IS NOT NULL AND btrim(a.township) <> ''
  ),
  ours AS (
    SELECT pe.election_id, per.region AS county, per.sub_region AS township, COUNT(*) AS n
    FROM politician_elections pe
    JOIN regions per ON per.id = pe.region_id
    WHERE pe.election_id IN (SELECT s.election_id FROM s) AND pe.election_type::TEXT = '村里長'  -- 清查範圍那幾屆（原本寫死 2026）
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:roster_check:' || s.election_id || ':' || t.county || t.township || ':村里長',
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', t.county || t.township, 'county', t.county, 'township', t.township,
                            'election_type', '村里長', 'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked,
                            'last_failed_attempt', rc.last_attempt_without_count, 'list_announced_on', s.list_announced_on,
                            'official_list_published', CURRENT_DATE >= s.list_announced_on,
                            'reconcile', rr.u),
         t.county || t.township || ' ' || s.election_id || ' 村里長的名單需要清查。請找這個鄉鎮市區的村里長候選人登記名單'
           || '（中選會「' || s.roc_year || ' 年村里長選舉候選人登記彙總表」PDF，或' || t.county || '選舉委員會的登記公告），跟我們現有的 '
           || COALESCE(o.n, 0) || ' 筆比對。' || roster_reconcile_text(rr.u) || '名單上有、我們沒有的，每位用 candidacy 型別補一筆：region 填「' || t.county
           || '」、sub_region 填「' || t.township || '」、village 填村里名、election_type 填村里長、candidate_status 填 registered，'
           || 'source_urls 附名冊網址（中選會 web.cec.gov.tw/api/file/…pdf 的名冊系統會逐位核對、吻合的一票就過）；一次最多 80 筆（整批都是 candidacy、source_urls 放這份名冊、每一筆都跟名冊逐位吻合才收；其他型別一次最多 20 筆），可分多次交。'
           || '最後用 roster_check 回報：election_id、region、election_type 三欄照任務 target 原樣帶回（region 就是「' || t.county || t.township
           || '」這一串），cec_count 填這個鄉鎮市區名冊上的人數。查不到名冊就不要猜：roster_check 的 cec_count 留空、note 寫你查了哪些網址。',
         ARRAY['web.cec.gov.tw ' || s.roc_year || ' 年村里長選舉候選人登記彙總表', t.county || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'],
         2, t.county
  FROM s
  CROSS JOIN towns t
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.county = t.county AND o.township = t.township
  -- 名冊對帳（roster_reconcile_units；沒有資料＝NULL＝照舊派）
  LEFT JOIN LATERAL (SELECT roster_reconcile_unit(s.election_id, '村里長', t.county, t.township) AS u) rr ON TRUE
  LEFT JOIN LATERAL (
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = t.county || t.township AND x.election_type = '村里長'
  ) rc ON TRUE
  -- 名冊對帳：登記彙總表有的鄉鎮市區，只在有「系統對不上」的人時才派；沒有對帳資料的照舊派
  WHERE (rr.u IS NULL OR (rr.u->>'needs_agent')::BOOLEAN)
    AND dispatch_gap_roster_unit_key(s.election_id, t.county || t.township, '村里長') = ANY (p_keys)
    AND (rc.last_checked IS NULL OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
$$;

-- district_seats：與 20261011080000 的 contribution_auto_tasks_district_seats() 逐字相同，只在最後的 WHERE 多一行單位鍵過濾（want 的一列就是一個單位）
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_district_seats(p_keys TEXT[])
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH want AS (
    -- 縣市議員：每個縣市都有（內政部縣市清單，「臺」寫成「台」）
    SELECT e.id AS election_id, e.election_date, '縣市議員'::TEXT AS election_type, replace(a.county, '臺', '台') AS county
      FROM elections e
      JOIN admin_divisions a ON a.level = 'county'
     WHERE '縣市議員' = ANY (e.election_types)
    UNION
    -- 鄉鎮市民代表：這一屆有鄉鎮市長選舉區的縣（縣轄鄉鎮市）
    SELECT DISTINCT e.id, e.election_date, '鄉鎮市民代表'::TEXT, d.region
      FROM elections e
      JOIN election_districts d ON d.election_id = e.id AND d.election_type = '鄉鎮市長'
     WHERE '鄉鎮市民代表' = ANY (e.election_types)
    UNION
    -- 原住民區民代表：這一屆有原住民區長選舉區的直轄市
    SELECT DISTINCT e.id, e.election_date, '直轄市山地原住民區民代表'::TEXT, d.region
      FROM elections e
      JOIN election_districts d ON d.election_id = e.id AND d.election_type = '直轄市山地原住民區長'
     WHERE '直轄市山地原住民區民代表' = ANY (e.election_types)
  ),
  have AS (
    SELECT d.election_id, d.election_type, d.region,
           count(*) AS districts,
           count(d.seats) AS with_seats,
           jsonb_agg(jsonb_build_object('district', d.sub_region, 'kind', d.district_kind, 'seats', d.seats)
                     ORDER BY d.sub_region) AS known
      FROM election_districts d
     WHERE d.election_type IN ('縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表')
     GROUP BY d.election_id, d.election_type, d.region
  ),
  -- 中選會登記名冊上有人登記的選舉區（議員、代表才有 district；代表的選舉區編號每個鄉鎮各自從第01起，要連鄉鎮一起算）：
  -- 我們的選舉區比它少＝漏了區（常是原住民選舉區），既有的名額都補齊了也要再派（2026-10-11，policy-ops#23）
  reg AS (
    SELECT g.election_id, g.election_type, g.region, count(DISTINCT COALESCE(g.sub_region, '') || '|' || g.district) AS districts
      FROM cec_registrations g
      JOIN cec_registration_sources src ON src.source_url = g.source_url AND src.superseded_by IS NULL
     WHERE g.district IS NOT NULL AND g.district <> ''
       AND g.election_type IN ('縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表')
     GROUP BY g.election_id, g.election_type, g.region
  ),
  -- 已經有人交了、還在等票的縣市不再派（同一份公告抄一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT c.payload->>'election_id' AS election_id, c.payload->>'election_type' AS election_type, c.payload->>'region' AS region
      FROM contributions c
     WHERE c.contribution_type = 'district_seats' AND c.status IN ('pending', 'verified')
  )
  SELECT 'auto:district_seats_missing:' || w.election_id || ':' || w.county || ':' || w.election_type,
         'district_seats_missing',
         jsonb_build_object('election_id', w.election_id, 'election_type', w.election_type, 'region', w.county,
                            'election_date', w.election_date,
                            'known_count', COALESCE(h.districts, 0), 'missing_seats_count', COALESCE(h.districts - h.with_seats, 0),
                            'known_districts', COALESCE(h.known, '[]'::jsonb)),
         w.county || ' ' || w.election_id || ' ' || w.election_type || '各選舉區的應選名額：'
           || CASE WHEN h.districts IS NULL THEN '我們一個選舉區都還沒有。'
                   ELSE '我們知道 ' || h.districts || ' 個選舉區、其中 ' || (h.districts - h.with_seats) || ' 個還沒有名額（target.known_districts）。' END
           || CASE WHEN h.districts < g.districts
                   THEN '中選會登記名冊上這個縣市有 ' || g.districts || ' 個選舉區有人登記，比我們知道的多 ' || (g.districts - h.districts)
                     || ' 個（常是原住民選舉區）：缺的那幾區要連名額一起補上。'
                   ELSE '' END
           || CASE WHEN s.ok
                   THEN '請找這一屆的選舉公告（附各選舉區應選名額表的 PDF；網址在 current.verification_sources 與 hint_sources，先看那幾個。'
                     || '選舉公報不一定印應選名額，鄉鎮市民代表的公報大多沒有，別在公報裡找半天），'
                   ELSE '請找這一屆的選舉公告（應選名額表；我們還沒登錄這一屆這個縣市的公告網址，要自己找，先看 hint_sources；'
                     || '已投票的屆別，選舉公報有的在每個選舉區的開頭印著應選名額），' END
           || '把公告上這個縣市每一個選舉區的名額交成一筆 district_seats：election_id 填 ' || w.election_id
           || '、election_type 填「' || w.election_type || '」、region 填「' || w.county || '」，districts 每區一項 {district, seats}，'
           || '原住民選舉區加 kind（indigenous_plain 或 indigenous_mountain）。名額只能照公告抄，不要用候選人數或當選人數推。'
           || '公告上這個縣市有幾個選舉區就交幾個（含原住民選舉區），不要只填 target.known_districts——那只是我們目前知道的，常比公告少；'
           || '交件前把你列的名額加總，對一下公告上這個縣市的名額總額。'
           || 'source_urls 第一個放公告本身。',
         CASE WHEN w.election_date < CURRENT_DATE
              THEN ARRAY[CASE WHEN s.ok
                              THEN 'current.verification_sources ← 這一屆這個縣市的選舉公告網址已經附在任務裡，先看那幾個（PDF 在 web.cec.gov.tw/api/file/<編號>.pdf）'
                              ELSE 'https://eebulletin.cec.gov.tw/ ← 中選會選舉公報（我們還沒登錄這一屆這個縣市的公告網址）：依屆別、縣市、選舉別點到每個選舉區的公報，有的在開頭印著應選名額，鄉鎮市民代表的大多沒有' END,
                         'https://web.cec.gov.tw/central/article/list/145 ← 中選會最新消息：標題「公告…選舉之選舉種類、名額、選舉區之劃分、投票日期…」的那一則就是選舉公告，附件 PDF 有各選舉區應選名額表',
                         'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：看得到有哪些選舉區（含原住民選舉區），但當選人數不是名額']
              ELSE ARRAY[CASE WHEN s.ok
                              THEN 'current.verification_sources ← 這一屆這個縣市的選舉公告網址已經附在任務裡，先看那幾個（PDF 在 web.cec.gov.tw/api/file/<編號>.pdf）'
                              ELSE '（我們還沒登錄這一屆這個縣市的公告網址，先看下面兩條自己找）' END,
                         'https://web.cec.gov.tw/central/article/list/145 ← 中選會最新消息：議員的選舉公告由中選會發布；鄉鎮市民代表、區民代表的由各縣市選委會發布，中選會同一天有一則索引（標題「…鄉(鎮、市)民代表…之選舉公告」），點進你的縣市',
                         '該縣市選舉委員會官網的「選舉公告」（附各選舉區應選名額表；列表頁常回 500，從中選會那則索引進去比較穩）']
         END,
         2, w.county
    FROM want w
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM verification_sources v
                         WHERE 'seats' = ANY (v.provides)
                           AND (v.election_types IS NULL OR w.election_type = ANY (v.election_types))
                           AND (v.regions IS NULL OR w.county = ANY (v.regions))
                           AND (v.election_ids IS NULL OR cardinality(v.election_ids) = 0 OR w.election_id = ANY (v.election_ids))) AS ok) s
    LEFT JOIN have h ON h.election_id = w.election_id AND h.election_type = w.election_type AND h.region = w.county
    LEFT JOIN reg g ON g.election_id = w.election_id AND g.election_type = w.election_type AND g.region = w.county
   WHERE (h.districts IS NULL OR h.with_seats < h.districts OR h.districts < g.districts)
     AND NOT EXISTS (SELECT 1 FROM queued q
                      WHERE q.election_id = w.election_id::TEXT AND q.election_type = w.election_type AND q.region = w.county)
     AND dispatch_gap_seats_unit_key(w.election_id, w.election_type, w.county) = ANY (p_keys)
$$;

-- raw:roster_check：與 20261115010000 的 contribution_auto_tasks_raw() 裡 roster_check 那一段（含它用到的 ours、filed_out 兩個 CTE）逐字相同，
-- 只在 WHERE s.enabled 後多一行單位鍵過濾（roster_check_scope × locations 的一列就是一個縣市層級的單位）
CREATE OR REPLACE FUNCTION dispatch_gap_recompute_raw_roster_check(p_keys TEXT[])
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH ours AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n,
           -- 名單缺口用：名冊內人數＝排除 considering（可能參選）與 withdrawn（退選），其餘都算——已登記、已表態，選後的當選／落選也算（只算 filed、declared 的話，選後人數歸零、缺口永遠成立）
           COUNT(*) FILTER (WHERE COALESCE(pe.candidacy_status, '') NOT IN ('considering', 'withdrawn')) AS n_listed
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidacy_status IS DISTINCT FROM 'withdrawn'
    GROUP BY 1, 2, 3
  ),
  -- 登記後才退選的人（withdrawn_after_filing 為真）：他們在中選會登記名冊上，但 ours 不收退選的，名冊人數比我們的名冊內人數多出這幾位
  filed_out AS (
    SELECT pe.election_id, pe.election_type, COALESCE(r.region, p.region) AS region, COUNT(*) AS n_filed_out
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.candidacy_status = 'withdrawn' AND pe.withdrawn_after_filing IS TRUE
    GROUP BY 1, 2, 3
  )
  SELECT 'auto:roster_check:' || s.election_id || ':' || l.name || ':' || s.election_type,
         'roster_check',
         jsonb_build_object('election_id', s.election_id, 'region', l.name, 'election_type', s.election_type,
                            'ours_count', COALESCE(o.n, 0), 'last_checked', rc.last_checked,
                            'last_failed_attempt', rc.last_attempt_without_count,
                            'list_announced_on', s.list_announced_on,
                            'official_list_published', CURRENT_DATE >= s.list_announced_on,
                            'reconcile', rr.u),
         l.name || ' ' || s.election_id || ' ' || s.election_type
           || ' 的名單需要清查。把該縣市這個選舉的參選人名單全部列出來，跟我們現有的比對；我們目前有 '
           || COALESCE(o.n, 0) || ' 筆。名單上有、我們沒有的，每一位用 candidacy 型別補一筆。'
           || roster_reconcile_text(rr.u)
           -- 名單分兩個階段，講清楚現在該補哪一種，否則兩個階段的資料會混在一起
           || CASE WHEN CURRENT_DATE >= s.list_announced_on THEN
                '【現在是審定名單階段】官方候選人名單已於 ' || s.list_announced_on::TEXT
                  || ' 公告，請以公告名單為準：candidacy 的 candidate_status 填 qualified（名單上的人；confirmed 只表示表態參選），查得到號次就一起附上。'
              ELSE
                '【現在是登記階段】'
                  -- 時程句（登記截止、名單公告、資格審查、抽號次）：日期都讀 roster_check_scope，過了日期的不再出現
                  || roster_schedule_text(s.registration_closed_on, s.list_announced_on, s.municipal_mayor_list_on,
                                          s.qualification_review_by, s.ballot_draw_on)
                  || '所以現在補的是「已登記」而不是「已審定」：candidacy 的 candidate_status 填 registered，不要填 confirmed'
                  -- 號次要等抽籤日之後才有；抽完了就不再說「還沒有號次可填」
                  || CASE WHEN s.ballot_draw_on IS NULL OR s.ballot_draw_on >= CURRENT_DATE THEN '，也還沒有號次可填' ELSE '' END
                  || '。'
                  || '另外，登記已經截止，所以我們資料裡還標著 rumored（傳聞參選）或 likely（可能參選）的人，只要不在登記名單上就是沒登記：請用 correction 把他那筆的 candidate_status 改成 not_running。'
              END
           || '最後用 roster_check 型別回報這次清查（名單上共幾人、我們幾人、你補了幾筆），那筆回報會把這個縣市標記為已清查。'
           -- 前一位代理查不到時，明講不要再去 db.cec.gov.tw：那是舊版把它排在第一個
           -- 造成的，43 個縣市一次都沒清查成功過，不寫清楚下一位會重蹈同一條死路。
           || CASE WHEN rc.last_attempt_without_count IS NOT NULL
                   THEN '注意：前一位代理回報查不到官方名單（見 target.last_failed_attempt）。'
                        || '請不要再去 db.cec.gov.tw 找——那是選舉結果資料庫，它自己標明「投票後 7 日內更新」，'
                        || election_year_text(s.election_id) || ' 的資料要等 ' || to_char((SELECT e.election_date + 7 FROM elections e WHERE e.id = s.election_id), 'FMMM') || ' 月才會進去。改從該縣市選舉委員會官網的登記公告、或媒體的登記名單彙整下手。'
                   ELSE '' END
           || '查不到名單就不要猜：用 roster_check 回報並把 cec_count 留空，在 note 說明你查了哪些網址——那筆不會把縣市標記為已清查，只會讓它隔天再派。',
         CASE WHEN CURRENT_DATE >= s.list_announced_on
              THEN ARRAY['該縣市選舉委員會官網的候選人名單公告', 'bulletin.cec.gov.tw 選舉公報', 'web.cec.gov.tw 中選會公告', 'cna.com.tw 候選人名單彙整']
              ELSE ARRAY['該縣市選舉委員會官網的登記公告', 'web.cec.gov.tw 中選會新聞稿', 'cna.com.tw 登記參選名單彙整', 'ltn.com.tw／udn.com 登記名單'] END,
         2, l.name
  FROM roster_check_scope s
  CROSS JOIN locations l
  LEFT JOIN ours o ON o.election_id = s.election_id AND o.election_type = s.election_type AND o.region = l.name
  LEFT JOIN filed_out fo ON fo.election_id = s.election_id AND fo.election_type = s.election_type AND fo.region = l.name
  -- 名冊對帳（roster_reconcile_units；沒有資料＝NULL＝照舊派）
  LEFT JOIN LATERAL (SELECT roster_reconcile_unit(s.election_id, s.election_type, l.name) AS u) rr ON TRUE
  LEFT JOIN LATERAL (
    -- 兩個時鐘：真的清查完的（cec_count 有值）壓 recheck_days；
    -- 只是試過沒找到的壓 roster_attempt_cooldown_days
    SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
           MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count,
           -- 最近一次真的清查（cec_count 有值）回報的中選會人數
           (array_agg(cec_count ORDER BY checked_at DESC, id DESC) FILTER (WHERE cec_count IS NOT NULL))[1] AS last_cec_count
    FROM roster_checks x
    WHERE x.election_id = s.election_id AND x.region = l.name AND x.election_type = s.election_type
  ) rc ON TRUE
  WHERE s.enabled
    AND dispatch_gap_roster_unit_key(s.election_id, l.name, s.election_type) = ANY (p_keys)
    -- 最近一次回報的 cec_count 比我們現在的名冊內人數多＝缺口還在：不套 recheck_days，繼續派；落差為 0（或我們比較多）才套
    AND (rc.last_checked IS NULL
         -- 登記後才退選的人在名冊上、不在我們的名冊內人數裡：回報的名冊人數先扣掉他們再比（不扣，名冊 88 位、我們 86 位加 2 位登記後退選，會永遠派下去）
         OR COALESCE(rc.last_cec_count, 0) - COALESCE(fo.n_filed_out, 0) > COALESCE(o.n_listed, 0)
         OR rc.last_checked < now() - (s.recheck_days || ' days')::INTERVAL)
    AND (rc.last_attempt_without_count IS NULL
         OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
    -- 名冊對帳：登記彙總表有的單位，只在有「系統對不上」的人時才派（唯一對上的由系統建）；沒有對帳資料的單位照舊派
    AND (rr.u IS NULL OR (rr.u->>'needs_agent')::BOOLEAN)
$$;

-- raw:roster_check 的整表版（雙軌比對與保底重算用）：就是現行的 raw 函式只取 roster_check，不跟按鍵版共用本體
CREATE OR REPLACE FUNCTION dispatch_gap_full_raw_roster_check()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT r.task_id, r.task_type, r.target, r.what_we_need, r.hint_sources, r.reward, r.region
    FROM contribution_auto_tasks_raw() r
   WHERE r.task_type = 'roster_check'
$$;

-- ------------------------------------------------------------
-- 4. PR-1 兩支名冊函式的按鍵版：把鍵傳進 roster_diff_findings()／cec_roster_diff()（其餘本體與 20261127044503 相同）
-- ------------------------------------------------------------

-- roster_unit_findings：來源 roster_diff_findings(p_keys)；底下的鍵過濾那一行保留（兩層都過濾，結果相同）
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
      FROM roster_diff_findings(p_keys) d
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

-- roster_gap_units：來源 cec_roster_diff(p_keys)；cn（官方有號次、本站已有此人卻沒有 cand_no）的單位鍵過濾提到 cn 裡（最貴的是它跟 cec_roster_2026 的連接）；
-- 最後 SELECT 的鍵過濾那一行保留（本體其餘與 20261127044503 相同，含 SET enable_nestloop = off）
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
      FROM cec_roster_diff(p_keys) d
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
       AND dispatch_gap_roster_unit_key(2026, o.county || o.scope_town, pe.election_type) = ANY (p_keys)
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

-- ------------------------------------------------------------
-- 5. 觸發器函式：以 20261127044503 版為底，加 D 與新臂的分支
--    · politician_elections、politicians、cec_roster_units、election_milestones 等原有分支的行為不變（入列單位的公開函式本身多入新臂）
--    · contributions：多 district_seats 型別（payload 組得出單位就入單位，組不出就整臂）；名單族型別組不出單位時，整臂多入新三支
--    · elections：另入 district_seats 與 raw:roster_check 整臂（名額的選舉職位清單、投票日；raw 說明文字的日期）
--    · election_milestones：另入 raw:roster_check 整臂
--    · 新分支：roster_checks、roster_reconcile_units、roster_check_scope、election_districts、verification_sources、cec_registration_sources、
--      task_checks（只有掛錯人任務的查核）、edit_history（參選紀錄建立那一筆）
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
  v_pe      INTEGER;
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
    ELSIF TG_OP = 'INSERT' AND v_row ->> 'table_name' = 'politician_elections' AND v_row ->> 'field' = '*' AND (v_row ->> 'record_id') ~ '^[0-9]{1,9}$' THEN
      -- region_gap 看「建立這筆參選紀錄的交件寫的縣市」（edit_history 的 '*' 那一筆）：入這筆參選紀錄所屬的單位
      -- 每筆貢獻都會寫 edit_history：入列出任何錯都只丟 WARNING，不能讓貢獻套用失敗
      BEGIN
        v_pe := (v_row ->> 'record_id')::INTEGER;
        SELECT pe.election_id, pe.election_type, COALESCE(rg.region, p.region), rg.sub_region INTO v_ceid, v_cet, v_county, v_sub
          FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id LEFT JOIN regions rg ON rg.id = pe.region_id
         WHERE pe.id = v_pe;
        IF v_county IS NOT NULL THEN
          PERFORM dispatch_gap_enqueue_units(v_ceid, v_cet, v_county, v_sub, v_kind);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'dispatch_gap_on_change（edit_history）：%', SQLERRM;
      END;
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
    -- cand_numbers／candidacy（補號次排除在途整批與在途帶號次的 candidacy）、election_results／reassign_candidacy（名單清查各種差異的在途排除）、
    -- district_seats（應選名額排除在途交件）
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
    ELSIF v_ctype = 'district_seats' THEN
      -- 名額任務的單位＝（選舉、職位、縣市），交件 payload 帶同樣三欄；組不出就整臂。同上，包例外處理
      BEGIN
        v_pl := COALESCE(v_row -> 'payload', '{}'::JSONB);
        v_ceid := CASE WHEN v_pl ->> 'election_id' ~ '^[0-9]{1,9}$' THEN (v_pl ->> 'election_id')::INTEGER END;
        v_cet := NULLIF(v_pl ->> 'election_type', '');
        v_county := NULLIF(v_pl ->> 'region', '');
        IF v_ceid IS NOT NULL AND v_cet IS NOT NULL AND v_county IS NOT NULL THEN
          PERFORM dispatch_gap_enqueue_seats(v_ceid, v_cet, v_county, v_kind);
        ELSE
          PERFORM dispatch_gap_enqueue_reg('district_seats', '*', v_kind);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'dispatch_gap_on_change（contributions 名額）：%', SQLERRM;
      END;
    ELSIF v_ctype IN ('cand_numbers', 'candidacy', 'election_results', 'reassign_candidacy') THEN
      -- 名單族的新段包例外：payload 是使用者交的內容，任何怪值（超大整數、型別不對）都不能讓這筆 contributions 寫入失敗
      BEGIN
        v_pl := COALESCE(v_row -> 'payload', '{}'::JSONB);
        v_ceid := CASE WHEN v_pl ->> 'election_id' ~ '^[0-9]{1,9}$' THEN (v_pl ->> 'election_id')::INTEGER END;
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
          PERFORM dispatch_gap_enqueue_reg('raw:roster_check', '*', v_kind);
          PERFORM dispatch_gap_enqueue_reg('roster_cec_gap', '*', v_kind);
          PERFORM dispatch_gap_enqueue_reg('roster_villages', '*', v_kind);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'dispatch_gap_on_change（contributions 名單族）：%', SQLERRM;
      END;
    END IF;

  ELSIF TG_TABLE_NAME = 'policy_subtopics' THEN
    PERFORM dispatch_gap_enqueue('issue_too_broad', '*', v_kind);   -- 細項落庫／刪除只影響「還沒有細項」的承諾數；對不到縣市，整臂

  ELSIF TG_TABLE_NAME = 'elections' THEN
    PERFORM dispatch_gap_enqueue('mismatch', '*', v_kind);          -- 投票日變更：by_date／by_future／by_not_elected 都看它
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', v_kind);   -- 名冊差異的 voted（投票日是否已過）、補號次的窗口都看它
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', v_kind);
    PERFORM dispatch_gap_enqueue_reg('district_seats', '*', v_kind);         -- 名額任務：選舉的職位清單、投票日（hint_sources 分已投票與未投票）
    PERFORM dispatch_gap_enqueue_reg('raw:roster_check', '*', v_kind);       -- 清查說明裡的「投票後 7 日」日期

  ELSIF TG_TABLE_NAME = 'election_milestones' THEN
    -- 抽籤日、名單公告日改動：補號次 target 帶 draw_on／list_on 與候選狀態的詞，名冊差異的候選狀態詞也看名單公告日
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('roster_gap_units', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('raw:roster_check', '*', 'config');

  ELSIF TG_TABLE_NAME = 'cec_roster_units' THEN
    -- 官方名冊鏡像的批次寫入點（cec_roster_replace_unit 每個單位最後一步 UPDATE 這一列）：入該單位；
    -- 補號次的「不在官方名冊」排除是縣市層級，單位內成員一變所有鄉鎮的號次件都可能變，所以補號次入整臂
    -- 鄉鎮市民代表、直轄市山地原住民區民代表：這張表的 town 是空的，但投票後（roster_unify_town）名冊差異的單位是縣市＋鄉鎮，鍵對不上，所以這兩個職位改入整臂
    IF v_row ->> 'election_type' IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN
      PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', v_kind);
      PERFORM dispatch_gap_enqueue_reg('roster_gap_units', '*', v_kind);
    ELSE
      PERFORM dispatch_gap_enqueue_roster_units(2026, v_row ->> 'election_type', v_row ->> 'county', NULLIF(v_row ->> 'town', ''), v_kind);
    END IF;
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', v_kind);

  ELSIF TG_TABLE_NAME = 'contribution_tasks' THEN
    -- 參選狀態查證任務（origin＝cec_roster_extra）開著時，補號次那筆參選紀錄不派；任務開關要重算
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', v_kind);

  ELSIF TG_TABLE_NAME = 'roster_unify_settings' THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('roster_gap_units', '*', 'config');

  ELSIF TG_TABLE_NAME = 'roster_checks' THEN
    -- 名單清查回報（一個單位一筆）：region 就是單位字串（縣市，或縣市＋鄉鎮），三支清查臂各用自己的鍵形，鍵同一個組法
    BEGIN
      FOR v_r IN SELECT x FROM unnest(ARRAY[v_new, v_old]) AS x WHERE x IS NOT NULL LOOP
        IF COALESCE(v_r ->> 'election_id', '') ~ '^[0-9]{1,9}$' AND COALESCE(v_r ->> 'region', '') <> '' AND COALESCE(v_r ->> 'election_type', '') <> '' THEN
          v_tid := dispatch_gap_roster_unit_key((v_r ->> 'election_id')::INTEGER, v_r ->> 'region', v_r ->> 'election_type');
          PERFORM dispatch_gap_enqueue_reg('raw:roster_check', v_tid, v_kind);
          PERFORM dispatch_gap_enqueue_reg('roster_cec_gap', v_tid, v_kind);
          PERFORM dispatch_gap_enqueue_reg('roster_villages', v_tid, v_kind);
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'dispatch_gap_on_change（roster_checks）：%', SQLERRM;
    END;

  ELSIF TG_TABLE_NAME = 'roster_reconcile_units' THEN
    -- 名冊對帳單位彙總（內容沒變的單位不寫，所以每次觸發都是真的變了）：縣市層級的清查（raw）與縣市＋鄉鎮的清查（村里長）各入自己的鍵
    BEGIN
      FOR v_r IN SELECT x FROM unnest(ARRAY[v_new, v_old]) AS x WHERE x IS NOT NULL LOOP
        IF COALESCE(v_r ->> 'election_id', '') ~ '^[0-9]{1,9}$' AND COALESCE(v_r ->> 'county', '') <> '' AND COALESCE(v_r ->> 'election_type', '') <> '' THEN
          PERFORM dispatch_gap_enqueue_reg('raw:roster_check',
            dispatch_gap_roster_unit_key((v_r ->> 'election_id')::INTEGER, v_r ->> 'county', v_r ->> 'election_type'), v_kind);
          PERFORM dispatch_gap_enqueue_reg('raw:roster_check',
            dispatch_gap_roster_unit_key((v_r ->> 'election_id')::INTEGER, (v_r ->> 'county') || COALESCE(v_r ->> 'town', ''), v_r ->> 'election_type'), v_kind);
          IF v_r ->> 'election_type' = '村里長' THEN
            PERFORM dispatch_gap_enqueue_reg('roster_villages',
              dispatch_gap_roster_unit_key((v_r ->> 'election_id')::INTEGER, (v_r ->> 'county') || COALESCE(v_r ->> 'town', ''), '村里長'), v_kind);
          END IF;
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'dispatch_gap_on_change（roster_reconcile_units）：%', SQLERRM;
    END;

  ELSIF TG_TABLE_NAME = 'roster_check_scope' THEN
    -- 清查範圍（開關、重查天數、日期欄）：低頻設定，整臂
    PERFORM dispatch_gap_enqueue_reg('raw:roster_check', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('roster_villages', '*', 'config');

  ELSIF TG_TABLE_NAME = 'election_districts' THEN
    -- 選舉區（名額）：名額任務的鍵（含鄉鎮市長、原住民區長推出來的代表職位）；region_gap 看選舉區的現況，整臂入名冊差異
    BEGIN
      FOR v_r IN SELECT x FROM unnest(ARRAY[v_new, v_old]) AS x WHERE x IS NOT NULL LOOP
        IF COALESCE(v_r ->> 'election_id', '') ~ '^[0-9]{1,9}$' THEN
          PERFORM dispatch_gap_enqueue_seats((v_r ->> 'election_id')::INTEGER, v_r ->> 'election_type', v_r ->> 'region', v_kind);
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'dispatch_gap_on_change（election_districts）：%', SQLERRM;
    END;
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', v_kind);

  ELSIF TG_TABLE_NAME = 'verification_sources' THEN
    -- 查證來源清單（名額任務的「已登錄公告網址」旗標）：低頻，整臂
    PERFORM dispatch_gap_enqueue_reg('district_seats', '*', 'config');

  ELSIF TG_TABLE_NAME = 'cec_registration_sources' THEN
    -- 登記彙總表來源（現行版／被取代）：名額任務與名冊差異的政黨、選舉區都看它，整臂
    PERFORM dispatch_gap_enqueue_reg('district_seats', '*', 'config');
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', 'config');

  ELSIF TG_TABLE_NAME = 'task_checks' THEN
    -- 掛錯人（owner_mismatch）任務的查核紀錄（確認過是同一人的不再派）：task_id 最後一段是參選紀錄 id，入那筆所屬的單位
    IF TG_OP = 'INSERT' AND (v_row ->> 'task_id') ~ '^auto:candidacy_owner_mismatch:[0-9]{1,9}$' THEN
      BEGIN
        v_pe := regexp_replace(v_row ->> 'task_id', '^.*:', '')::INTEGER;
        SELECT pe.election_id, pe.election_type, COALESCE(rg.region, p.region), rg.sub_region INTO v_ceid, v_cet, v_county, v_sub
          FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id LEFT JOIN regions rg ON rg.id = pe.region_id
         WHERE pe.id = v_pe;
        IF v_county IS NOT NULL THEN
          PERFORM dispatch_gap_enqueue_roster_units(v_ceid, v_cet, v_county, v_sub, v_kind);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'dispatch_gap_on_change（task_checks）：%', SQLERRM;
      END;
    END IF;

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

-- 語句層級（轉換表）：以 20261127044503 版為底，cec_registrations 多入 district_seats（整臂）。
-- cec_candidates 的語句層級觸發器本期拿掉（由 cec-sync 結尾呼叫 dispatch_gap_enqueue_cec_units 入受影響單位），cec_registrations 的保留：
-- 它只有 migration 載入登記彙總表時才會寫，拿掉沒有任何好處，反而讓日後載入新名冊的 migration 要記得自己入列
CREATE OR REPLACE FUNCTION dispatch_gap_on_batch_new() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF dispatch_gap_events_enabled() AND EXISTS (SELECT 1 FROM new_rows) THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', lower(TG_OP));
    IF TG_TABLE_NAME = 'cec_registrations' THEN
      PERFORM dispatch_gap_enqueue_reg('district_seats', '*', lower(TG_OP));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION dispatch_gap_on_batch_old() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF dispatch_gap_events_enabled() AND EXISTS (SELECT 1 FROM old_rows) THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', lower(TG_OP));
    IF TG_TABLE_NAME = 'cec_registrations' THEN
      PERFORM dispatch_gap_enqueue_reg('district_seats', '*', lower(TG_OP));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- 低頻小表的語句層級（沒有轉換表：這幾張表一年改不了幾次，語句沒影響到列也多入一筆整臂，同一時段只會留一筆）
--   regions（縣市、鄉鎮、村里改名：影響參選紀錄的單位歸屬）、parties／party_aliases（政黨對照：政黨差異）、cec_results_auto_plan_rows（自動寫入計畫快取：結果差異）
CREATE OR REPLACE FUNCTION dispatch_gap_on_stmt() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT dispatch_gap_events_enabled() THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'regions' THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', lower(TG_OP));
    PERFORM dispatch_gap_enqueue_reg('roster_gap_units', '*', lower(TG_OP));
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', lower(TG_OP));
    PERFORM dispatch_gap_enqueue_reg('roster_cec_gap', '*', lower(TG_OP));
    PERFORM dispatch_gap_enqueue_reg('raw:roster_check', '*', lower(TG_OP));
    PERFORM dispatch_gap_enqueue_reg('roster_villages', '*', lower(TG_OP));
  ELSIF TG_TABLE_NAME = 'electoral_district_areas' THEN
    -- 鄉鎮清單（村里長逐鄉鎮清查的來源，靜態參考資料）
    PERFORM dispatch_gap_enqueue_reg('roster_villages', '*', lower(TG_OP));
  ELSIF TG_TABLE_NAME IN ('parties', 'party_aliases') THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', lower(TG_OP));
  END IF;
  RETURN NULL;
END;
$$;

-- 時間翻轉（以 20261127044503 版為底）：投票日前後多補 district_seats（hint_sources 看 election_date < CURRENT_DATE）；
-- 名單公告日前後補 raw:roster_check、roster_villages 整臂（說明分「登記階段」「審定名單階段」，看 CURRENT_DATE >= list_announced_on）。回傳 1＝有補事件
CREATE OR REPLACE FUNCTION dispatch_gap_date_flip_roster() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_n INTEGER := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM elections e
              WHERE e.election_date BETWEEN LEAST(CURRENT_DATE, activity_today()) - 3 AND GREATEST(CURRENT_DATE, activity_today()) + 1) THEN
    PERFORM dispatch_gap_enqueue_reg('roster_unit_findings', '*', 'date_flip');
    PERFORM dispatch_gap_enqueue_reg('ballot_numbers', '*', 'date_flip');
    PERFORM dispatch_gap_enqueue_reg('district_seats', '*', 'date_flip');
    v_n := 1;
  END IF;
  IF EXISTS (SELECT 1 FROM roster_check_scope s WHERE s.list_announced_on BETWEEN CURRENT_DATE - 2 AND CURRENT_DATE + 1) THEN
    PERFORM dispatch_gap_enqueue_reg('raw:roster_check', '*', 'date_flip');
    PERFORM dispatch_gap_enqueue_reg('roster_villages', '*', 'date_flip');
    v_n := 1;
  END IF;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION dispatch_gap_seats_unit_key(INTEGER, TEXT, TEXT) IS '20261127093000：應選名額單位鍵 seats:<選舉>:<縣市>:<職位>（臺→台）。task_id 去掉前綴就是它，鍵與 dispatch_gap_scope_key 的 district_seats 分支同一個組法。';
COMMENT ON FUNCTION dispatch_gap_recompute_roster_cec_gap(TEXT[]) IS '20261127093000：roster_cec_gap 的按鍵版（鍵＝unit:<選舉>:<縣市＋鄉鎮>:<職位>），本體同現行臂函式、只在 marked 的來源多一行單位鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_recompute_roster_villages(TEXT[]) IS '20261127093000：roster_villages 的按鍵版（鍵同上），本體同現行臂函式、只在最後的 WHERE 多一行單位鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_recompute_district_seats(TEXT[]) IS '20261127093000：district_seats 的按鍵版（鍵＝seats:<選舉>:<縣市>:<職位>），本體同現行臂函式、只在最後的 WHERE 多一行單位鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_recompute_raw_roster_check(TEXT[]) IS '20261127093000：raw 臂裡 roster_check 這一型的按鍵版（鍵同名冊族），本體同現行 raw 函式的 roster_check 段、只在 WHERE 多一行單位鍵過濾。登記在 dispatch_gap_arm_keys.recompute_fn。';
COMMENT ON FUNCTION dispatch_gap_full_raw_roster_check() IS '20261127093000：raw:roster_check 的整表版（現行 contribution_auto_tasks_raw() 只取 roster_check），雙軌比對與保底重算用。';
COMMENT ON FUNCTION dispatch_gap_enqueue_roster_arms(INTEGER, TEXT, TEXT, TEXT, TEXT) IS '20261127093000：入列一個單位在 raw:roster_check、roster_cec_gap、roster_villages 的所有可能鍵（PR-1 的 dispatch_gap_roster_keys 超集，再補 raw 的縣市層級鍵）。';

REVOKE ALL ON FUNCTION dispatch_gap_seats_unit_key(INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_seats_scope(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_seats_keys(INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_enqueue_seats(INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_enqueue_roster_arms(INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_scope_key(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_roster_cec_gap(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_roster_villages(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_district_seats(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_raw_roster_check(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_full_raw_roster_check() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_roster_unit_findings(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_recompute_roster_gap_units(TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_on_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_on_batch_new() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_on_batch_old() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_on_stmt() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_date_flip_roster() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION dispatch_gap_enqueue_cec_units(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION dispatch_gap_enqueue_units(INTEGER, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION dispatch_gap_enqueue_cec_units(JSONB) TO service_role;

-- ------------------------------------------------------------
-- 6. 登記四支臂（鍵規則與按鍵版）
-- ------------------------------------------------------------
INSERT INTO dispatch_gap_arm_keys (arm, full_fn, recompute_fn, key_expr_desc, key_example) VALUES
  ('roster_cec_gap', 'contribution_auto_tasks_roster_cec_gap()', 'dispatch_gap_recompute_roster_cec_gap(text[])',
   '已投票屆的名單缺人（中選會選舉資料庫 vs 我們的參選紀錄）：gap_key＝task_id（auto:roster_check:<選舉>:<縣市＋鄉鎮>:<職位>）；scope_key＝unit:<選舉>:<縣市＋鄉鎮>:<職位>（臺→台，與名冊族同一個鍵）。事件來源：cec_candidates（語句層級整臂）、politician_elections、politicians、regions、roster_checks、contributions（名單族型別）。',
   'auto:roster_check:2022:臺北市:縣市長 → unit:2022:台北市:縣市長'),
  ('roster_villages', 'contribution_auto_tasks_roster_villages()', 'dispatch_gap_recompute_roster_villages(text[])',
   '村里長名單清查（逐鄉鎮）：gap_key＝task_id（auto:roster_check:<選舉>:<縣市＋鄉鎮>:村里長）；scope_key＝unit:<選舉>:<縣市＋鄉鎮>:村里長。事件來源：roster_checks、roster_reconcile_units、roster_check_scope、politician_elections、regions、contributions。',
   'auto:roster_check:2026:花蓮縣花蓮市:村里長 → unit:2026:花蓮縣花蓮市:村里長'),
  ('district_seats', 'contribution_auto_tasks_district_seats()', 'dispatch_gap_recompute_district_seats(text[])',
   '應選名額缺口（縣市議員、鄉鎮市民代表、原住民區民代表）：gap_key＝task_id（auto:district_seats_missing:<選舉>:<縣市>:<職位>）；scope_key＝seats:<選舉>:<縣市>:<職位>（臺→台）。事件來源：election_districts（含由鄉鎮市長、原住民區長推出的代表職位）、elections、verification_sources、cec_registrations／cec_registration_sources（整臂）、contributions（district_seats）。',
   'auto:district_seats_missing:2026:臺北市:縣市議員 → seats:2026:台北市:縣市議員'),
  ('raw:roster_check', 'dispatch_gap_full_raw_roster_check()', 'dispatch_gap_recompute_raw_roster_check(text[])',
   'raw 的名單清查型（縣市層級）：gap_key＝task_id（auto:roster_check:<選舉>:<縣市>:<職位>）；scope_key＝unit:<選舉>:<縣市>:<職位>（同名冊族）。整表版＝contribution_auto_tasks_raw() 只取 roster_check。事件來源：roster_checks、roster_reconcile_units、roster_check_scope、election_milestones、elections、politician_elections、regions、contributions（名單族型別）。',
   'auto:roster_check:2026:臺北市:縣市長 → unit:2026:台北市:縣市長')
ON CONFLICT (arm) DO UPDATE SET full_fn = EXCLUDED.full_fn, recompute_fn = EXCLUDED.recompute_fn,
  key_expr_desc = EXCLUDED.key_expr_desc, key_example = EXCLUDED.key_example;

-- ------------------------------------------------------------
-- 7. 切 shadow ＋ 初始灌入（觸發器之前做，不讓 CREATE TRIGGER 的表鎖等著它）
-- ------------------------------------------------------------
SELECT dispatch_gap_set_mode('roster_cec_gap', 'shadow', '第 2 期 PR-2：雙軌開始');
SELECT dispatch_gap_set_mode('roster_villages', 'shadow', '第 2 期 PR-2：雙軌開始');
SELECT dispatch_gap_set_mode('district_seats', 'shadow', '第 2 期 PR-2：雙軌開始');
SELECT dispatch_gap_set_mode('raw:roster_check', 'shadow', '第 2 期 PR-2：雙軌開始');

DO $$
BEGIN
  -- 與 seed 的 drain 共用 advisory lock：恰好撞上就拿不到鎖、這裡什麼都沒灌；下面補的整臂事件會讓第一輪 seed 補上
  PERFORM count(*) FROM dispatch_gap_reconcile_all(ARRAY['roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check']);
END $$;

-- ------------------------------------------------------------
-- 8. 自我檢查（觸發器之前；DDL 的表鎖到交易結束才放，所以能先做的檢查都先做完）：
--    本期四支是 shadow、除已切 live 的四支外沒有 live、按鍵版都在且已登記、新簽名的兩支函式在而且舊簽名不在、兩個開關開著
-- ------------------------------------------------------------
DO $$
BEGIN
  -- 前面 20261127081000 已把 legacy、mismatch、issue_too_broad、ballot_numbers 切 live：這裡不能有別的 live 臂，本期四支必須是 shadow
  --（實際臂數：這支跑完 shadow 是 roster_unit_findings、roster_gap_units 加本期四支共 6、live 是那四支；測試環境沒有 081000，四支是 shadow，所以不寫死總數）
  IF (SELECT count(*) FROM dispatch_gap_arms WHERE mode = 'shadow' AND arm IN ('roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check')) <> 4
     OR EXISTS (SELECT 1 FROM dispatch_gap_arms WHERE mode = 'shadow'
                 AND arm NOT IN ('legacy', 'mismatch', 'issue_too_broad', 'roster_unit_findings', 'roster_gap_units', 'ballot_numbers',
                                 'roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check'))
     OR EXISTS (SELECT 1 FROM dispatch_gap_arms WHERE mode = 'live'
                 AND arm NOT IN ('legacy', 'mismatch', 'issue_too_broad', 'ballot_numbers')) THEN
    RAISE EXCEPTION '第 2 期 PR-2：本期四支要是 shadow；除了已切 live 的 legacy、mismatch、issue_too_broad、ballot_numbers，不能有別的 live 臂';
  END IF;
  IF EXISTS (SELECT 1 FROM dispatch_gap_arm_keys k WHERE k.arm IN ('roster_cec_gap', 'roster_villages', 'district_seats', 'raw:roster_check')
              AND (k.recompute_fn IS NULL OR to_regprocedure(k.recompute_fn) IS NULL OR to_regprocedure(k.full_fn) IS NULL)) THEN
    RAISE EXCEPTION '第 2 期 PR-2：四支臂的按鍵版或整表版沒有登記或函式不存在';
  END IF;
  IF to_regprocedure('cec_roster_diff()') IS NOT NULL OR to_regprocedure('roster_diff_findings()') IS NOT NULL
     OR to_regprocedure('cec_roster_diff(text[])') IS NULL OR to_regprocedure('roster_diff_findings(text[])') IS NULL THEN
    RAISE EXCEPTION '第 2 期 PR-2：cec_roster_diff／roster_diff_findings 要只剩帶 p_keys 的新簽名';
  END IF;
  IF NOT dispatch_gap_events_enabled() OR NOT dispatch_gap_seed_drain_enabled() THEN
    RAISE EXCEPTION '第 2 期 PR-2：事件與 seed drain 兩個開關都要是開';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 9. 補整臂事件（灌入到掛上觸發器之間漏掉的變更，第一輪 seed 的 drain 一次補齊）
-- ------------------------------------------------------------
SELECT dispatch_gap_enqueue('roster_cec_gap', '*', 'migration');
SELECT dispatch_gap_enqueue('roster_villages', '*', 'migration');
SELECT dispatch_gap_enqueue('district_seats', '*', 'migration');
SELECT dispatch_gap_enqueue('raw:roster_check', '*', 'migration');

-- ------------------------------------------------------------
-- 10. 觸發器（最後才掛；表鎖到交易結束）：低頻表先掛，contributions 這張熱表最後、緊接結尾
-- ------------------------------------------------------------
SET LOCAL lock_timeout = '30s';

-- C：cec_candidates 的三支語句層級觸發器拿掉（cec-sync 結尾改呼叫 dispatch_gap_enqueue_cec_units 入受影響單位）
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_ins ON cec_candidates;
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_upd ON cec_candidates;
DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_candidates_del ON cec_candidates;

-- 低頻表（列層級）
DROP TRIGGER IF EXISTS trg_dispatch_gap_roster_checks ON roster_checks;
CREATE TRIGGER trg_dispatch_gap_roster_checks
  AFTER INSERT OR UPDATE OF election_id, region, election_type, checked_at, cec_count OR DELETE
  ON roster_checks FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_roster_reconcile_units ON roster_reconcile_units;
CREATE TRIGGER trg_dispatch_gap_roster_reconcile_units
  AFTER INSERT OR UPDATE OF needs_agent, total, creatable_n, ambiguous_n, extra_n, status_mismatch_n, both_n, people OR DELETE
  ON roster_reconcile_units FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_roster_check_scope ON roster_check_scope;
CREATE TRIGGER trg_dispatch_gap_roster_check_scope
  AFTER INSERT OR UPDATE OR DELETE
  ON roster_check_scope FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_election_districts ON election_districts;
CREATE TRIGGER trg_dispatch_gap_election_districts
  AFTER INSERT OR UPDATE OF election_id, election_type, region, sub_region, seats, district_kind OR DELETE
  ON election_districts FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_verification_sources ON verification_sources;
CREATE TRIGGER trg_dispatch_gap_verification_sources
  AFTER INSERT OR UPDATE OR DELETE
  ON verification_sources FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_cec_registration_sources ON cec_registration_sources;
CREATE TRIGGER trg_dispatch_gap_cec_registration_sources
  AFTER INSERT OR UPDATE OR DELETE
  ON cec_registration_sources FOR EACH ROW EXECUTE FUNCTION dispatch_gap_on_change();

-- 低頻小表（語句層級，沒有轉換表）
DROP TRIGGER IF EXISTS trg_dispatch_gap_regions_stmt ON regions;
CREATE TRIGGER trg_dispatch_gap_regions_stmt
  AFTER UPDATE OR DELETE ON regions FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_stmt();   -- 不掛 INSERT：新選區由 apply-contribution 建，影響靠該選區後續的參選紀錄事件與對帳

DROP TRIGGER IF EXISTS trg_dispatch_gap_electoral_district_areas_stmt ON electoral_district_areas;
CREATE TRIGGER trg_dispatch_gap_electoral_district_areas_stmt
  AFTER INSERT OR UPDATE OR DELETE ON electoral_district_areas FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_stmt();

DROP TRIGGER IF EXISTS trg_dispatch_gap_parties_stmt ON parties;
CREATE TRIGGER trg_dispatch_gap_parties_stmt
  AFTER INSERT OR UPDATE OR DELETE ON parties FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_stmt();

DROP TRIGGER IF EXISTS trg_dispatch_gap_party_aliases_stmt ON party_aliases;
CREATE TRIGGER trg_dispatch_gap_party_aliases_stmt
  AFTER INSERT OR UPDATE OR DELETE ON party_aliases FOR EACH STATEMENT EXECUTE FUNCTION dispatch_gap_on_stmt();


-- 有 WHEN 的表（task_checks、edit_history 都是寫入頻繁的表，WHEN 擋掉不相干的列，連函式都不叫）
DROP TRIGGER IF EXISTS trg_dispatch_gap_task_checks_owner ON task_checks;
CREATE TRIGGER trg_dispatch_gap_task_checks_owner
  AFTER INSERT
  ON task_checks FOR EACH ROW WHEN (NEW.task_id LIKE 'auto:candidacy_owner_mismatch:%')
  EXECUTE FUNCTION dispatch_gap_on_change();

DROP TRIGGER IF EXISTS trg_dispatch_gap_edit_history_pe ON edit_history;
CREATE TRIGGER trg_dispatch_gap_edit_history_pe
  AFTER INSERT
  ON edit_history FOR EACH ROW WHEN (NEW.table_name = 'politician_elections' AND NEW.field = '*')
  EXECUTE FUNCTION dispatch_gap_on_change();

-- 熱表（重建：WHEN 多一個 district_seats 型別）最後一組
DROP TRIGGER IF EXISTS trg_dispatch_gap_contributions ON contributions;
CREATE TRIGGER trg_dispatch_gap_contributions
  AFTER INSERT OR UPDATE OF status, applied_policy_id
  ON contributions FOR EACH ROW
  WHEN (NEW.contribution_type IN ('policy', 'policy_subtopics', 'cand_numbers', 'candidacy', 'election_results', 'reassign_candidacy', 'district_seats'))
  EXECUTE FUNCTION dispatch_gap_on_change();

-- 觸發器計數（只讀 pg_catalog，不取任何表鎖）：前兩期 22 支－cec_candidates 三支＋本期新增 12 支，contributions 重建不增加
DO $$
DECLARE
  v_n INTEGER;
BEGIN
  SELECT count(*) INTO v_n FROM pg_trigger WHERE tgname LIKE 'trg\_dispatch\_gap\_%' AND NOT tgisinternal;
  IF v_n <> 31 THEN
    RAISE EXCEPTION '第 2 期 PR-2：預期共掛 31 支觸發器（前兩期 22 支－cec_candidates 三支＋本期新增 12 支，contributions 重建不增加），實際 %', v_n;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
