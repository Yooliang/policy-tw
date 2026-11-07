-- 2026 名冊差異改成「一包 6～8 位」的手動任務；名冊對帳先暫停（小良 2026-11-07 核准的做法）
-- ============================================================
--
-- 起因：cec_roster_2026（中選會抽籤後名冊 19,491）與我們的差異：缺 76、多 37、重複 1；另外 103 張 auto:roster_check:2026:* 任務的
--   target.items 帶著 掛錯人 59、政黨 21、縣市 21、鄉鎮 4、缺號次 9。這些大包任務（一個單位一包、最多 120 項）MiniMax 代理常常做一半就放掉；
--   而「多 37」的單人任務（cec-extra-sweep，開了 120 張，只剩 24 張的人還在差異裡）派出一次後就沉到隊尾（派出歸零插隊、優先秒數只有 +3 天）。
--
-- 做法（資料一律走代理交件＋同儕驗證；本檔只開任務、停派工，不寫任何參選資料）：
--   1. 暫停 2026 名冊對帳：activity_overrides 對 raw:roster_check、roster_villages 兩個活動、election_id=2026 設 closed（有 reason、created_by），
--      下一輪 seed 把 auto:roster_check:2026:* 的派工列依「窗口關閉」收回（gap_events 記 window）；本檔同時把它們的 boost_seconds 歸零。
--      這樣同一個人不會同時被名冊對帳（單位大包）與分組任務（小包）兩頭派。
--      回復（全部做完要把名冊對帳打開）：後面的 migration 執行
--        DELETE FROM activity_overrides WHERE created_by = 'roster-group-2026-11-07';
--      臂本身不動（規則、函式都在），下一輪 seed 就把單位清查任務重新算出來。
--      舊的每日補人任務（cec_missing_person_tasks_create、cron cec-missing-person-tasks-daily）在 20261103010000 已經刪掉，這裡不復活，
--      所以名冊對帳暫停之後不會有單人重複任務冒出來；分組任務也不是每天自動新開（見下面第 4 點），只有 roster_group_tasks_create() 手動呼叫才會開。
--   2. 分組任務：roster_group_people() 把「缺人、缺號次（roster_gap_units）」「多（cec_roster_diff 的 extra）」
--      「掛錯人／政黨／縣市／鄉鎮（roster_diff_findings，2026）」攤成逐人清單；roster_group_tasks_create() 依 (縣市, 選舉別, 做法) 分組，
--      每組最多 8 位一張（組內平均分）；同（縣市, 選舉別, 做法）不足 6 位的跨縣市併成「多縣市」一組，否則一張只有 1～3 人。manual 來源的手動任務，created_by＝roster-group-2026-11-07，
--      target.multi_person＝true、target.people 逐人列（key、name、line…），說明逐人寫明：姓名、鄉鎮／村里／選區、要交什麼、官方來源網址、掛錯人的訊號。
--      冪等：人已經在某張 open 的分組任務裡就不再開（以人的 key 為準，不是以任務為準）。
--   3. 【一張任務多個人，第一位交件不能讓任務關掉或停放】現行規則：任務型別是 question／adjudicate／roster_check 的才豁免（TS 的
--      KEEP_OPEN_TASK_TYPES、SQL 的 manual_task_closes_on_applied、contribution_queue_tasks／contribution_auto_tasks／console_queue_state
--      的「任務停放」三型清單）。新增任務型別要同步 DB CHECK／TASK_TYPES／skill／task-labels 太多處，所以不新增型別，改成
--      「target.multi_person＝true 的手動任務」同樣豁免：helper task_target_multi_person(target)，四支 SQL 函式各加一個條件
--      （本檔用 pg_get_functiondef 機械式替換，每處斷言替換次數；三型原字串不動），TS 的 shouldCloseOnApplied 多收一個 target 參數、
--      applyNoChange 對多人任務也不關。仍受「在途額滿 5 筆」限制（現行規則，所有任務一樣）。
--   4. 什麼時候關：roster_group_tasks_sweep()（pg_cron 每小時 :50）逐人看「這個人還在不在差異清單」——不在就算處理完（該單位的官方名冊鏡像
--      要是新鮮的；鏡像過期不能當成處理完），從任務移除並更新說明與標題的人數；全部處理完就 closed（觸發器收回派工列）。
--      代理對某位交 no_change（官方資料有誤、查無）時任務不關、也不進冷卻（冷卻會把同一張的其他人一起擋掉）——那一位留在清單裡，
--      直到差異消失或維護者手動關任務。新出現的差異不自動開新任務（避免天天冒小張）；要補開就手動 SELECT roster_group_tasks_create()。
--   5. 關單人任務：cec-extra-sweep 的 open 任務，人已經不在 extra 差異裡（過時）或已被分組任務收進去的，一律 closed。
--   6. 插隊一次：新任務出生時 manual 來源已有 manual_front_seconds（5 年）；本檔結尾再對 boost_seconds＝0 的分組任務補一份（20261107020000 同做法，冪等）。
-- 守門：_shared/roster-group-tasks.test.ts。

-- ▼▼ SECTION: exempt ▼▼
-- ------------------------------------------------------------
-- 1. 多人任務豁免（不因一位交件而停放或關閉）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION task_target_multi_person(p_target JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(p_target->>'multi_person', '') = 'true' $$;
COMMENT ON FUNCTION task_target_multi_person IS '手動任務的 target.multi_person＝true：一張任務包著好幾個人（各交一筆貢獻），跟 question／adjudicate／roster_check 一樣不因一筆交件而停放或關閉。同 TS 的 isMultiPersonTarget。2026-11-07';

-- 手動任務被貢獻補完時要不要即時收回派工列（20261008165000 的現行定義＋多人任務豁免一行）
CREATE OR REPLACE FUNCTION manual_task_closes_on_applied(p_task_id TEXT, p_contribution_type TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM contribution_tasks t
                  WHERE t.id::TEXT = p_task_id AND t.status = 'open'
                    AND t.task_type NOT IN ('question', 'adjudicate', 'roster_check')
                    AND NOT task_target_multi_person(t.target)
                    AND p_contribution_type NOT IN ('no_change', 'adjudication', 'task_suggestion', 'question_answer', 'roster_check'))
$$;
COMMENT ON FUNCTION manual_task_closes_on_applied IS '這筆貢獻上線後，它所屬的手動任務該不該關（同 TS 的 shouldCloseOnApplied）。task_dispatches_drop_applied 用它即時收回派工列。多人任務（target.multi_person）不關。2026-10-08；2026-11-07 加多人豁免';

-- 任務停放三型清單（contribution_queue_tasks、contribution_auto_tasks、console_queue_state）：現行定義機械式替換，每處斷言次數
DO $do$
DECLARE
  v_old CONSTANT TEXT := $s$d.task_type NOT IN ('question', 'adjudicate', 'roster_check')$s$;
  v_new CONSTANT TEXT := $s$d.task_type NOT IN ('question', 'adjudicate', 'roster_check') AND NOT task_target_multi_person(d.target)$s$;
  v_def TEXT; v_n INTEGER;
  r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('contribution_queue_tasks(text,text,integer,text,text,text)', 2),
      ('contribution_auto_tasks(text,text,integer,text,text,text)', 2),
      ('console_queue_state()', 1)) AS t(sig, expected)
  LOOP
    v_def := pg_get_functiondef(r.sig::REGPROCEDURE);
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n = 0 AND strpos(v_def, 'task_target_multi_person') > 0 THEN CONTINUE; END IF;  -- 已替換過（重跑）
    IF v_n <> r.expected THEN
      RAISE EXCEPTION '% 的任務停放三型清單出現 % 次，預期 % 次——現行定義變了，這個替換要重寫', r.sig, v_n, r.expected;
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END LOOP;
END
$do$;
-- ▲▲ SECTION: exempt ▲▲

-- ▼▼ SECTION: people ▼▼
-- ------------------------------------------------------------
-- 2. 逐人清單
-- ------------------------------------------------------------
-- 做法的名稱、任務型別、怎麼交
CREATE OR REPLACE FUNCTION roster_group_label(p_action TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_action WHEN 'missing' THEN '補參選紀錄（中選會名單有、本站沒有）' WHEN 'extra' THEN '查參選狀態（中選會名單查無此人）'
                       WHEN 'wrong_owner' THEN '核對掛錯人' WHEN 'party' THEN '補政黨' WHEN 'county' THEN '補縣市' WHEN 'town' THEN '補鄉鎮'
                       WHEN 'cand_no' THEN '補號次' END
$$;

CREATE OR REPLACE FUNCTION roster_group_task_type(p_action TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_action WHEN 'extra' THEN 'candidate_status_stale' WHEN 'wrong_owner' THEN 'candidacy_owner_mismatch' ELSE 'candidacy_source_missing' END
$$;

CREATE OR REPLACE FUNCTION roster_group_howto(p_action TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_action
    WHEN 'missing' THEN
      '怎麼交：每位各交一筆 candidacy。先查人物是否已存在（同名者依出生年、縣市、經歷判斷是不是同一人）；已存在→帶 politician_id 掛上既有人物，不存在→新增（附人物基本資料）。'
      || 'election_id 2026、election_type 與縣市照本任務，村里長另填 sub_region（鄉鎮）、village（村里），議員與代表填選舉區，candidate_status 填 registered，'
      || 'cand_no 填名單上的號次（同時交號次，不用另開單），party 照名單原字，source_urls 第一個放該位的官方名單網址。'
      || '名單的姓名其實是本站某位已有的人（寫法不同）→ no_change 說明，不要重複新增；查不到明確結果也用 no_change 寫你看了哪些地方。'
    WHEN 'extra' THEN
      '怎麼交：每位各交一筆。先核對中選會名單（網址在每位後面）是不是真的沒有他：確定退選、資格不符或根本沒登記→correction，target_table＝politician_elections、'
      || 'target_id＝該位的 politician_election_id，把 candidate_status 改成 not_running，附得出出處（選委會公告、選舉公報、地方新聞）'
      || '（withdrawn_after_filing 只在已是退選的紀錄上有值，不能跟 candidate_status 同一筆改）；'
      || '名單上其實有他、只是姓名寫法不同→candidacy（號次一起交）或 correction 改 politicians.name 為官方寫法；'
      || '查不到明確結果→no_change 並寫你看了哪些地方，不要用猜的改成退選。'
    WHEN 'wrong_owner' THEN
      '怎麼交：每位各交一筆。先看每位列出的訊號、站上同名者與中選會同名者，判斷這筆參選紀錄掛的人對不對（同名不代表同一人，看出生年、縣市、政黨、經歷）：'
      || '不是同一人→reassign_candidacy（改掛正確的人物，沒有就新增人物）；是同一人→no_change（outcome＝confirmed，finding 寫你比對了什麼）。'
    WHEN 'party' THEN
      '怎麼交：每位各交一筆 candidacy，重交同一人同一屆（politician_id、election_id 2026、election_type 照該位），party 照中選會登記彙總表那一屆的推薦政黨欄原字，'
      || 'source_urls 第一個放該位的官方網址。官方資料有誤、現值才對→no_change 附來源。'
    WHEN 'county' THEN
      '怎麼交：每位各交一筆。縣市是空的→candidacy 重交同一人同一屆，補上縣市；縣市記錯（官方值帶 proposed_region_id）→correction 改 politician_elections.region_id；'
      || '現值才對→no_change 附來源。source_urls 第一個放該位的官方網址。'
    WHEN 'town' THEN
      '怎麼交：每位各交一筆 candidacy，重交同一人同一屆（politician_id 照該位），補上 sub_region（鄉鎮市區；村里長另填 village），source_urls 第一個放該位的官方網址。'
    WHEN 'cand_no' THEN
      '怎麼交：每位各交一筆 candidacy，重交同一人同一屆（politician_id 照該位），cand_no 填官方名單上的號次，source_urls 第一個放該位的官方名單網址。'
  END
$$;

-- 這個單位的官方名冊鏡像是新鮮的（status ok、3 天內抓成功）：鏡像過期時「差異清單裡沒有他」不能當成處理完
CREATE OR REPLACE FUNCTION roster_group_fresh(p_type TEXT, p_county TEXT, p_town TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM cec_roster_units u
                  WHERE u.status = 'ok' AND u.fetched_at > now() - INTERVAL '3 days' AND u.election_type = p_type
                    AND replace(u.county, '臺', '台') = replace(p_county, '臺', '台')
                    AND (p_type <> '村里長' OR replace(u.town, '臺', '台') = replace(COALESCE(p_town, ''), '臺', '台')))
$$;

-- 逐人清單：缺人／缺號次（roster_gap_units）、多（cec_roster_diff 的 extra）、掛錯人／政黨／縣市／鄉鎮（roster_diff_findings，2026）
CREATE OR REPLACE FUNCTION roster_group_people()
RETURNS TABLE (person_key TEXT, action TEXT, election_type TEXT, county TEXT, town TEXT, name TEXT, pe_id INTEGER, politician_id UUID,
               loc TEXT, line TEXT, source_url TEXT)
LANGUAGE sql STABLE AS $fn$
  WITH gu AS MATERIALIZED (
    SELECT g.election_type AS et, g.county AS cty, g.town AS tw, i.item,
           i.item->>'name' AS nm, i.item->'official'->>'village' AS vil, i.item->'official'->>'district' AS dist,
           i.item->'official'->>'cand_no' AS cno, i.item->'official'->>'party' AS party, i.item->'official'->>'birth_roc' AS birth,
           i.item->'official'->>'birth_year' AS byear, i.item->>'source_url' AS url
      FROM roster_gap_units() g CROSS JOIN LATERAL jsonb_array_elements(g.items) AS i(item)
  ),
  mi AS (
    SELECT DISTINCT ON (x.key) x.* FROM (
      SELECT 'missing:' || g.et || '|' || g.cty || g.tw || '|' || COALESCE(g.vil, '') || '|' || COALESCE(g.dist, '') || '|' || COALESCE(g.cno, '') || '|' || g.nm AS key, g.*,
             concat(g.cty, NULLIF(g.tw, ''), g.vil, CASE WHEN g.dist IS NOT NULL THEN '（' || g.dist || '）' END) AS loc
        FROM gu g WHERE g.item->>'kind' = '缺人') x
     ORDER BY x.key
  ),
  ci AS (
    SELECT DISTINCT ON (g.item->>'politician_election_id') g.*,
           concat(g.cty, NULLIF(g.tw, ''), g.vil, CASE WHEN g.dist IS NOT NULL THEN '（' || g.dist || '）' END) AS loc
      FROM gu g WHERE g.item->>'kind' = '缺號次' AND g.item->>'politician_election_id' IS NOT NULL
     ORDER BY g.item->>'politician_election_id'
  ),
  ex AS (
    SELECT d.pe_id, d.politician_id, d.our_name AS nm, d.our_status AS st, d.our_cand_no AS cno, d.election_type AS et, d.county AS cty, d.town AS tw,
           rg.sub_region AS sub, rg.village AS vil,
           (SELECT u.url FROM cec_roster_units u
             WHERE u.status = 'ok' AND u.election_type = d.election_type AND replace(u.county, '臺', '台') = d.county
               AND (d.election_type <> '村里長' OR replace(u.town, '臺', '台') = d.town)
             ORDER BY u.url LIMIT 1) AS url
      FROM cec_roster_diff() d
      LEFT JOIN politician_elections pe ON pe.id = d.pe_id
      LEFT JOIN regions rg ON rg.id = pe.region_id
     WHERE d.kind = 'extra' AND d.pe_id IS NOT NULL
  ),
  fi AS (
    SELECT DISTINCT ON (f.kind, f.politician_election_id) f.kind AS fkind, f.election_type AS et, f.county AS cty, f.town AS tw, f.name AS nm, f.politician_id,
           f.politician_election_id AS pe_id, f.current_value AS cur, f.official_value AS off, f.source_url AS url,
           concat_ws('', f.county, NULLIF(f.current_value->>'sub_region', ''), NULLIF(f.current_value->>'village', ''),
                     CASE WHEN f.current_value->>'district' IS NOT NULL THEN '（' || (f.current_value->>'district') || '）' END) AS loc
      FROM roster_diff_findings() f
     WHERE f.election_id = 2026 AND f.kind IN ('政黨', '鄉鎮', '縣市', '掛錯人') AND f.politician_election_id IS NOT NULL
     ORDER BY f.kind, f.politician_election_id
  )
  SELECT m.key, 'missing'::TEXT, m.et, m.cty, m.tw, m.nm, NULL::INTEGER, NULL::UUID, m.loc,
         '「' || m.nm || '」' || m.loc || '｜號次 ' || COALESCE(m.cno, '（無）') || '｜政黨 ' || COALESCE(m.party, '（無）')
           || COALESCE('｜出生 ' || m.birth || '（民國年月日' || COALESCE('，西元 ' || m.byear || ' 年', '') || '）', '')
           || COALESCE('｜站上同名者：' || (SELECT string_agg(s.id || '（' || COALESCE(s.birth_year::TEXT, '?') || ' 年生，' || COALESCE(s.region, '?') || '，' || COALESCE(s.party, '?') || '）', '；')
                                          FROM (SELECT p.id, p.birth_year, p.region, p.party FROM politicians p WHERE p.merged_into IS NULL AND p.name = m.nm ORDER BY p.id LIMIT 3) s), '')
           || COALESCE('｜官方名單：' || m.url, ''),
         m.url
    FROM mi m
  UNION ALL
  SELECT 'cand_no:' || (c.item->>'politician_election_id'), 'cand_no', c.et, c.cty, c.tw, c.nm, (c.item->>'politician_election_id')::INTEGER, (c.item->>'politician_id')::UUID, c.loc,
         '「' || c.nm || '」' || c.loc || '｜politician_election_id ' || (c.item->>'politician_election_id') || '｜politician_id ' || COALESCE(c.item->>'politician_id', '')
           || '｜官方號次 ' || COALESCE(c.cno, '') || '｜政黨 ' || COALESCE(c.party, '（無）') || COALESCE('｜出生 ' || c.birth, '') || COALESCE('｜官方名單：' || c.url, ''),
         c.url
    FROM ci c
  UNION ALL
  SELECT 'extra:' || e.pe_id, 'extra', e.et, e.cty, e.tw, e.nm, e.pe_id, e.politician_id,
         concat(e.cty, NULLIF(e.tw, ''), CASE WHEN e.et <> '村里長' THEN e.sub END, e.vil),
         '「' || e.nm || '」' || concat(e.cty, NULLIF(e.tw, ''), CASE WHEN e.et <> '村里長' THEN e.sub END, e.vil)
           || '｜politician_election_id ' || e.pe_id || '｜politician_id ' || e.politician_id || '｜站上狀態 ' || COALESCE(e.st, '（空）')
           || COALESCE('、號次 ' || e.cno, '') || '｜中選會名單查無此人' || COALESCE('｜官方名單：' || e.url, ''),
         e.url
    FROM ex e
  UNION ALL
  SELECT f.fkind || ':' || f.pe_id,
         CASE f.fkind WHEN '政黨' THEN 'party' WHEN '鄉鎮' THEN 'town' WHEN '縣市' THEN 'county' ELSE 'wrong_owner' END,
         f.et, f.cty, f.tw, f.nm, f.pe_id, f.politician_id, f.loc,
         '「' || f.nm || '」' || f.loc || '｜politician_election_id ' || f.pe_id || '｜politician_id ' || COALESCE(f.politician_id::TEXT, '')
           || CASE f.fkind
                WHEN '掛錯人' THEN
                  COALESCE('｜現值：' || concat_ws('、', (f.cur->>'birth_year') || ' 年生', f.cur->>'party'), '')
                  || COALESCE('｜訊號：' || (SELECT string_agg(s->>'detail', '；') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.off->'signals') = 'array' THEN f.off->'signals' ELSE '[]'::JSONB END) s), '')
                  || COALESCE('｜站上同名者：' || (SELECT string_agg(concat_ws('，', s->>'politician_id', (s->>'birth_year') || ' 年生', s->>'region', s->>'party'), '；')
                                                 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(f.off->'same_name') = 'array' THEN f.off->'same_name' ELSE '[]'::JSONB END) s), '')
                  || CASE WHEN jsonb_typeof(f.off->'cec_same_name') = 'array' AND jsonb_array_length(f.off->'cec_same_name') > 0 THEN '｜中選會同名：' || (f.off->'cec_same_name')::TEXT ELSE '' END
                  || CASE WHEN jsonb_typeof(f.cur->'other_records') = 'array' AND jsonb_array_length(f.cur->'other_records') > 0 THEN '｜這個人的其他屆紀錄：' || (f.cur->'other_records')::TEXT ELSE '' END
                ELSE '｜現值 ' || COALESCE(f.cur::TEXT, '{}') || '｜官方值 ' || COALESCE(f.off::TEXT, '{}')
              END
           || COALESCE('｜官方來源：' || f.url, ''),
         f.url
    FROM fi f
$fn$;
COMMENT ON FUNCTION roster_group_people IS '2026 名冊差異逐人清單（person_key、做法、縣市、選舉別、姓名、說明行、官方網址）：缺人／缺號次來自 roster_gap_units，多來自 cec_roster_diff 的 extra，掛錯人／政黨／縣市／鄉鎮來自 roster_diff_findings。只讀，不寫。2026-11-07';
-- ▲▲ SECTION: people ▲▲

-- ▼▼ SECTION: tasks ▼▼
-- ------------------------------------------------------------
-- 3. 分組開任務、對帳關任務、關單人任務
-- ------------------------------------------------------------
-- 任務說明＝表頭 + 還沒處理的人（target.header 存表頭；清單變短時 sweep 用它重組）
CREATE OR REPLACE FUNCTION roster_group_description(p_header TEXT, p_people JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_header || E'\n' || COALESCE((SELECT string_agg(x.ord::TEXT || '. ' || (x.p->>'line'), E'\n' ORDER BY x.ord)
                                         FROM jsonb_array_elements(p_people) WITH ORDINALITY AS x(p, ord)), '')
$$;

CREATE OR REPLACE FUNCTION roster_group_tasks_create(p_created_by TEXT DEFAULT 'roster-group-2026-11-07', p_max INTEGER DEFAULT 8, p_pool_min INTEGER DEFAULT 6)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH cov AS MATERIALIZED (
    SELECT DISTINCT e->>'key' AS k
      FROM contribution_tasks t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.target->'people', '[]'::JSONB)) e
     WHERE t.status = 'open' AND t.target->>'origin' = 'roster_group'
  ), p AS MATERIALIZED (
    SELECT x.* FROM roster_group_people() x WHERE NOT EXISTS (SELECT 1 FROM cov WHERE cov.k = x.person_key)
  ), p2 AS (
    -- 同（縣市, 選舉別, 做法）不足 p_pool_min 位的，跨縣市併成一組（'＊'），否則一張只有 1～3 人
    SELECT p.*, CASE WHEN count(*) OVER (PARTITION BY p.county, p.election_type, p.action) >= p_pool_min THEN p.county ELSE '＊' END AS gk FROM p
  ), g AS (
    SELECT p2.*, count(*) OVER w AS n, row_number() OVER (w ORDER BY p2.county, p2.town, p2.loc, p2.name, p2.person_key) AS rn
      FROM p2 WINDOW w AS (PARTITION BY p2.gk, p2.election_type, p2.action)
  ), c AS (
    -- 每組最多 p_max 位一張：張數＝ceil(n / p_max)，組內平均分（整數除法：第 rn 位落在第 (rn-1)*張數/n 張）
    SELECT g.*, ((g.rn - 1) * ceil(g.n::NUMERIC / p_max)::BIGINT / g.n) AS chunk FROM g
  ), t AS (
    SELECT CASE WHEN c.gk = '＊'
                THEN '多縣市（' || array_to_string((array_agg(DISTINCT c.county))[1:4], '、')
                     || CASE WHEN count(DISTINCT c.county) > 4 THEN '等 ' || count(DISTINCT c.county) || ' 縣市' ELSE '' END || '）'
                ELSE c.gk END AS county,
           min(c.county) AS region_county,
           c.election_type, c.action, c.chunk, count(*)::INTEGER AS cnt,
           jsonb_agg(jsonb_build_object('key', c.person_key, 'name', c.name, 'politician_election_id', c.pe_id, 'politician_id', c.politician_id,
                                        'action', c.action, 'election_type', c.election_type, 'county', c.county, 'town', c.town, 'line', c.line, 'source_url', c.source_url)
                     ORDER BY c.rn) AS people,
           (array_agg(DISTINCT c.source_url) FILTER (WHERE c.source_url IS NOT NULL))[1:6] AS urls,
           md5(string_agg(c.person_key, '|' ORDER BY c.person_key)) AS gh
      FROM c GROUP BY c.gk, c.election_type, c.action, c.chunk
  ), ins AS (
    INSERT INTO contribution_tasks (title, description, task_type, target, region, priority, reward, status, source, created_by, hint_sources)
    SELECT left(t.county || ' ' || t.election_type || '｜' || roster_group_label(t.action) || '｜', 100) || t.cnt || ' 位',
           roster_group_description(h.header, t.people),
           roster_group_task_type(t.action),
           jsonb_build_object('multi_person', true, 'origin', 'roster_group', 'kind', 'roster_group', 'action', t.action,
                              'election_id', 2026, 'election_type', t.election_type, 'region', t.region_county, 'county', t.county,
                              'group_key', t.county || '|' || t.election_type || '|' || t.action || '|' || left(t.gh, 8),
                              'title_base', left(t.county || ' ' || t.election_type || '｜' || roster_group_label(t.action) || '｜', 100),
                              'header', h.header, 'people_count', t.cnt, 'people', t.people),
           t.region_county, 0, 1, 'open', 'manual', p_created_by,
           t.urls || ARRAY['https://web.cec.gov.tw/central/article/64709', 'https://info.cec.gov.tw/vote2026/']
      FROM t
      CROSS JOIN LATERAL (SELECT '【一張任務多個人】' || t.county || t.election_type || '「' || roster_group_label(t.action) || '」共 ' || t.cnt || ' 位。'
                                 || '每位各交一筆貢獻（task_id 都填本任務 id，不要把好幾位塞進同一筆）；交完一位任務不會結束，也不必一次做完——做幾位交幾位，沒做的留給下一個人。'
                                 || '系統每小時對帳一次，處理完（差異不在了）的人會從下面的清單消失，全部處理完任務自動關閉。'
                                 || roster_group_howto(t.action) || E'\n名單：' AS header) h
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION roster_group_tasks_create IS '把 roster_group_people() 依（縣市, 選舉別, 做法）分組、每張最多 p_max 位開成手動任務（target.multi_person）；人已在某張 open 分組任務裡就不再開。只開任務、不改參選資料。回傳新開張數。2026-11-07';
REVOKE ALL ON FUNCTION roster_group_tasks_create(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;

-- 對帳：人不在差異清單裡（且該單位官方名冊鏡像新鮮）就算處理完；全部處理完就關任務，清單變短就更新說明與標題。回傳關掉的張數
CREATE OR REPLACE FUNCTION roster_group_tasks_sweep() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_cur TEXT[]; v_closed INTEGER := 0; v_left JSONB; v_n_left INTEGER; v_n_old INTEGER;
  r RECORD;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT x.person_key), ARRAY[]::TEXT[]) INTO v_cur FROM roster_group_people() x;
  FOR r IN SELECT t.id, t.target FROM contribution_tasks t WHERE t.status = 'open' AND t.target->>'origin' = 'roster_group' LOOP
    v_n_old := COALESCE(jsonb_array_length(r.target->'people'), 0);
    SELECT COALESCE(jsonb_agg(e.p ORDER BY e.ord), '[]'::JSONB), count(*)::INTEGER INTO v_left, v_n_left
      FROM jsonb_array_elements(COALESCE(r.target->'people', '[]'::JSONB)) WITH ORDINALITY AS e(p, ord)
     WHERE (e.p->>'key') = ANY (v_cur)
        -- 缺人、多、缺號次是拿官方名冊鏡像比出來的：鏡像過期時「清單裡沒有他」不能當成處理完（掛錯人、政黨、縣市、鄉鎮不靠鏡像）
        OR (e.p->>'action' IN ('missing', 'extra', 'cand_no') AND NOT roster_group_fresh(e.p->>'election_type', e.p->>'county', e.p->>'town'));
    IF v_n_left = 0 THEN
      UPDATE contribution_tasks SET status = 'closed', closed_at = now() WHERE id = r.id AND status = 'open';
      v_closed := v_closed + 1;
    ELSIF v_n_left < v_n_old THEN
      UPDATE contribution_tasks
         SET target = target || jsonb_build_object('people', v_left, 'people_count', v_n_left),
             description = roster_group_description(target->>'header', v_left),
             title = (target->>'title_base') || v_n_left || ' 位'
       WHERE id = r.id AND status = 'open';
    END IF;
  END LOOP;
  RETURN v_closed;
END;
$$;
COMMENT ON FUNCTION roster_group_tasks_sweep IS '分組任務對帳（每小時）：人不在 roster_group_people() 且該單位官方名冊鏡像新鮮＝處理完；全部處理完就 closed，否則更新說明與標題的人數。回傳關掉的張數。2026-11-07';
REVOKE ALL ON FUNCTION roster_group_tasks_sweep() FROM PUBLIC, anon, authenticated;

-- cec-extra-sweep 的單人任務：人已不在 extra 差異（過時，且該單位名冊新鮮）或已被分組任務收進去的，關掉。回傳關掉的張數
CREATE OR REPLACE FUNCTION roster_group_close_extra_singles() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH ex AS MATERIALIZED (SELECT d.pe_id FROM cec_roster_diff() d WHERE d.kind = 'extra' AND d.pe_id IS NOT NULL),
  cov AS MATERIALIZED (
    SELECT DISTINCT e->>'key' AS k
      FROM contribution_tasks g CROSS JOIN LATERAL jsonb_array_elements(COALESCE(g.target->'people', '[]'::JSONB)) e
     WHERE g.status = 'open' AND g.target->>'origin' = 'roster_group'
  ), done AS (
    UPDATE contribution_tasks t SET status = 'closed', closed_at = now()
     WHERE t.created_by = 'cec-extra-sweep' AND t.status = 'open' AND t.task_type = 'candidate_status_stale'
       AND ((NOT EXISTS (SELECT 1 FROM ex WHERE ex.pe_id::TEXT = t.target->>'politician_election_id')
             AND roster_group_fresh(t.target->>'election_type', t.target->>'region', t.target->>'sub_region'))
            OR EXISTS (SELECT 1 FROM cov WHERE cov.k = 'extra:' || (t.target->>'politician_election_id')))
    RETURNING 1)
  SELECT count(*) INTO v_n FROM done;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION roster_group_close_extra_singles IS '關 cec-extra-sweep 的單人「查參選狀態」任務：人不在 extra 差異裡（過時）或已被分組任務收進去。只關任務。回傳關掉的張數。2026-11-07';
REVOKE ALL ON FUNCTION roster_group_close_extra_singles() FROM PUBLIC, anon, authenticated;
-- ▲▲ SECTION: tasks ▲▲

-- ▼▼ SECTION: run ▼▼
-- ------------------------------------------------------------
-- 4. 暫停 2026 名冊對帳（可逆：DELETE FROM activity_overrides WHERE created_by = 'roster-group-2026-11-07'）
-- ------------------------------------------------------------
INSERT INTO activity_overrides (activity, election_id, "force", reason, created_by)
SELECT a.activity, 2026, 'closed',
       '2026 名冊差異改成一包 6～8 位的分組手動任務（created_by roster-group-2026-11-07），名冊對帳先暫停，避免同一個人兩頭派；全部做完再刪這兩列把名冊對帳打開（小良 2026-11-07）',
       'roster-group-2026-11-07'
  FROM (VALUES ('raw:roster_check'), ('roster_villages')) AS a(activity)
 WHERE NOT EXISTS (SELECT 1 FROM activity_overrides o WHERE o.activity = a.activity AND o.election_id = 2026 AND o.created_by = 'roster-group-2026-11-07');

-- 派工列在下一輪 seed 依窗口關閉收回；先把插隊歸零（收回前的幾分鐘也不被插隊拉到前面）
UPDATE task_dispatches SET boost_seconds = 0 WHERE task_id LIKE 'auto:roster_check:2026%' AND boost_seconds <> 0;

-- 5. 開分組任務、關單人任務
SELECT roster_group_tasks_create('roster-group-2026-11-07');
SELECT roster_group_close_extra_singles();

-- 6. 插隊一次（新任務出生時 manual 來源已有 manual_front_seconds；只補 boost_seconds＝0 的，冪等）
UPDATE task_dispatches d
   SET boost_seconds = q.boost_seconds
  FROM queue_settings q, contribution_tasks t
 WHERE q.id = 1 AND t.id::TEXT = d.task_id AND t.created_by = 'roster-group-2026-11-07' AND t.status = 'open'
   AND d.boost_seconds = 0 AND NOT d.blocked AND (d.cool_until IS NULL OR d.cool_until <= now());

-- 7. 排程：每小時 :50 對帳（UTC）
DO $do$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'roster-group-tasks-hourly';
    PERFORM cron.schedule('roster-group-tasks-hourly', '50 * * * *', $q$SELECT roster_group_tasks_sweep();$q$);
  END IF;
END
$do$;
-- ▲▲ SECTION: run ▲▲

NOTIFY pgrst, 'reload schema';
