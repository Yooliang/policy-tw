-- #345／#346 後續第二輪（主線 10-06 裁定，接 #384、#386 的未決）
-- ============================================================
--
-- 照 10-05 常設裁決「資料一律走流程」：這支加守門、派工臂與一次「照已落庫交件補紀錄」的回填，**不改任何人物、參選紀錄、政黨的內容**。
--
-- 1. 不參選重查的「已核對」章補蓋（#384 未決 2）：落庫端原本用 uuid 的樣子比對整數的參選紀錄 id，
--    「確實不在登記名單上」的 no_change 通過了卻一筆都沒蓋到章（#384 已修）。這裡照已落庫、outcome=confirmed 的那些交件，
--    把 politician_elections.verified 補成 true，每一筆寫 edit_history（contribution_id＝那一筆交件，跟落庫當下會寫的一模一樣，可以照交件還原）。
--    只補「現在還是不參選」的：那之後狀態被改過（例如有人補成已登記）的，那一次的結論已經不適用，不補。
-- 2. 2026 參選紀錄缺政黨（#386 未決 1）：還沒投票、中選會選舉資料庫沒有名單，照中選會候選人登記彙總表派——
--    新臂 contribution_auto_tasks_party_roster，已登記（candidacy_status＝filed）而 party_basis 空的一筆一件，
--    沿用 candidacy_source_missing、task_id 跟已投票那支同一個形狀（auto:candidacy_source_missing:party:<參選紀錄 id>，
--    投完票之後同一件改由那支接手），target.kind＝party_roster，附登記彙總表網址（查證來源清單裡的中選會名冊）。
--    驗證沿用既有的中選會名冊逐位核對（引用登記彙總表 PDF 的 candidacy，系統核姓名、縣市、政黨，吻合一票就過），不新增計分規則。
--    表態不參選、沒登記的（withdrawn 80 筆、declared 2 筆）名冊上沒有他，不派。
-- 3. 補縣市、補選區兩支臂（#386 未決 2）：說明原本叫代理「其餘欄位照現有資料原樣帶」，target.party 又是他「現在」的政黨，
--    換過黨的人照抄就被中選會自動核對退件、也會把現在的政黨寫進過去的參選。改成「其餘欄位照那一屆的名冊填」，
--    target 的 party 改名 person_party（只供對照），已投票屆別中選會名單唯一對上時附那一屆的推薦政黨（cec_party）。
-- 4. 政黨資訊派工（#386 未決 3）：新任務型別 party_info_missing → party_info，三種缺口各一件：
--    rename 改名的界線日（新名稱 valid_from、舊名稱 valid_to）、off_registry 名冊外的政黨（是不是誰改名前的名字、何時停用）、
--    dissolved 名冊狀態是自行解散／廢止備案／撤銷備案而停用日空著的。已經有人交了那個政黨的 party_info 在等票的先不派。
-- 5. 測試資料（#386 驗證時發現的「測試候選人ABC／XYZ／QQQ」，2024 台東縣立委）：
--    a. 守門：資料庫觸發器擋新增或改名成測試名的人物（politician_name_is_placeholder，跟 _shared/placeholder-name.ts 同一份字詞），
--       不論哪一條寫入端——這三筆查不到來路（2026-01 早期整批匯入那段時間寫進來的，沒有任何交件、查核履歷是空的）。
--    b. 移除走流程：新任務型別 placeholder_politician → removal（removal 這次開放 politicians，只收身上沒有政見、任期、學經歷、
--       提問、脈絡、沒有別人併進來的人；整個人連參選紀錄整列留履歷、可還原；見 apply-contribution.ts）。上線當下 3 件。
--
-- 引用到的既有欄位（10-06 唯讀查詢確認存在）：
--   contributions(id, contribution_type, status, task_id, payload, agent_name, applied_at)、
--   politician_elections(id, politician_id, election_id, election_type, candidate_status, candidacy_status, verified, party_basis, region_id)、
--   edit_history(table_name, record_id, field, old_value, new_value, contribution_id, agent_name, applied_at, reverted_at)、
--   politicians(id, name, party, region, merged_into)、elections(id, election_date)、regions(id, region, sub_region, village)、
--   verification_sources(kind, status, list_url, provides, election_types, regions, sort, id)、
--   parties(id, name, short_name, moi_no, moi_name, moi_status, valid_from, valid_to, predecessor_id)、cec_candidates(party 等)

-- ── 1. 不參選重查的章：照已落庫的交件補蓋 ───────────────────────────────
DO $$
DECLARE v_n INTEGER := 0; r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (pe.id) pe.id AS pe_id, c.id AS contribution_id, c.agent_name, c.applied_at
      FROM contributions c
      JOIN politician_elections pe ON c.task_id = 'auto:not_running_recheck:' || pe.id
     WHERE c.contribution_type = 'no_change' AND c.status = 'applied' AND c.payload->>'outcome' = 'confirmed'
       AND pe.verified IS NOT TRUE
       AND pe.candidate_status = 'not_running'
     ORDER BY pe.id, c.applied_at DESC NULLS LAST, c.id
  LOOP
    UPDATE politician_elections SET verified = true WHERE id = r.pe_id;
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, contribution_id, agent_name, applied_at)
    VALUES ('politician_elections', r.pe_id::TEXT, 'verified', 'false'::JSONB, 'true'::JSONB, r.contribution_id, r.agent_name, coalesce(r.applied_at, now()));
    v_n := v_n + 1;
  END LOOP;
  RAISE NOTICE '不參選重查的章補蓋 % 筆', v_n;
  -- 自我檢查：照同一個條件，補完不該再有漏的
  IF EXISTS (SELECT 1 FROM contributions c JOIN politician_elections pe ON c.task_id = 'auto:not_running_recheck:' || pe.id
              WHERE c.contribution_type = 'no_change' AND c.status = 'applied' AND c.payload->>'outcome' = 'confirmed'
                AND pe.verified IS NOT TRUE AND pe.candidate_status = 'not_running') THEN
    RAISE EXCEPTION '不參選重查的章還有沒補到的';
  END IF;
END $$;

-- ── 5a. 測試資料的姓名：任何寫入端都擋 ────────────────────────────────
-- 字詞跟 supabase/functions/_shared/placeholder-name.ts 同一份（round2-followups.test.ts 盯著）：中文的測試、範例、示範、假資料；
-- 英文的 test、dummy、sample、placeholder 要是完整的一個詞（Testa、Sampleton 這種不算）。10-06 只命中那三位。
CREATE OR REPLACE FUNCTION politician_name_is_placeholder(p_name TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(normalize(p_name, NFKC) ~* '(測試|範例|示範|假資料)|(^|[^A-Za-z])(test|dummy|sample|placeholder)([^A-Za-z]|$)', false)
$$;
COMMENT ON FUNCTION politician_name_is_placeholder IS '姓名看起來是測試資料（測試、範例、示範、假資料、test、dummy、sample、placeholder）；2026-10-06';

CREATE OR REPLACE FUNCTION politicians_reject_placeholder_name() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF politician_name_is_placeholder(NEW.name) THEN
    RAISE EXCEPTION '姓名「%」看起來是測試資料，正式資料不收', NEW.name USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_politicians_reject_placeholder_name ON politicians;
CREATE TRIGGER trg_politicians_reject_placeholder_name
  BEFORE INSERT OR UPDATE OF name ON politicians
  FOR EACH ROW EXECUTE FUNCTION politicians_reject_placeholder_name();

-- ── 3. 補縣市、補選區：其餘欄位照那一屆的名冊填，不叫代理照抄現在的政黨（其餘一字不改） ──────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_region_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.candidate_status, pe.position,
           p.id AS politician_id, p.name, p.party,
           COALESCE(r.region, p.region) AS county,
           NULLIF(concat_ws(' ', r.sub_region, r.village), '') AS attached_below_county,
           pe.region_id IS NULL AS no_region,
           pe.election_type IN ('縣市議員', '立法委員')
             AND pe.candidate_status <> 'not_running'
             AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region) AS no_district,
           -- 掛錯層級：不是縣市層級、也不是這種選舉的選區（立委的「全國」那一列算縣市層級，缺的是選區）
           pe.region_id IS NOT NULL
             AND (r.village IS NOT NULL
                  OR (r.sub_region IS NOT NULL AND NOT region_is_electoral_district(pe.election_type, r.region, r.sub_region))) AS wrong_level
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_type IN ('縣市長', '縣市議員', '立法委員')
  ),
  gaps AS (
    SELECT g.*,
           -- 縣市長掛錯層級＝縣市待確認；議員、立委掛錯層級本來就算缺選區
           g.no_region OR (g.wrong_level AND g.election_type = '縣市長') AS need_region,
           CASE g.candidate_status
             WHEN 'not_running' THEN '表態不參選' WHEN 'registered' THEN '已登記' WHEN 'confirmed' THEN '表態參選'
             WHEN 'qualified' THEN '審定合格' ELSE g.candidate_status END AS status_label,
           CASE WHEN g.election_type = '立法委員'
                THEN '「第NN選區」（區域立委）；不分區或原住民立委 region 填「全國」、electoral_district 填「不分區」「平地原住民」或「山地原住民」'
                ELSE '「第NN選舉區」（例：第04選舉區）' END AS district_how
      FROM g
     WHERE g.no_region OR g.no_district OR g.wrong_level
  )
  SELECT 'auto:candidacy_source_missing:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'person_party', x.party, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'politician_election_id', x.pe_id,
                            'missing', to_jsonb(array_remove(ARRAY[CASE WHEN x.need_region THEN 'region' END,
                                                                   CASE WHEN x.no_district THEN 'electoral_district' END], NULL)),
                            'attached_to', CASE WHEN x.wrong_level THEN x.county || ' ' || x.attached_below_county END,
                            'submitted_region', sub.submitted_region,
                            'cec_listed_as', cec.listed_as, 'cec_party', cec.party),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，' || x.status_label || '）的參選紀錄'
           || CASE WHEN x.no_region AND x.no_district THEN '沒有縣市也沒有選區'
                   WHEN x.no_region THEN '沒有縣市'
                   WHEN x.wrong_level
                   THEN '掛在「' || x.county || ' ' || x.attached_below_county || '」——'
                        || CASE WHEN x.election_type = '縣市長' THEN '縣市長的參選紀錄只該記到縣市' ELSE '那不是' || x.election_type || '的選區' END
                        || '（多半是同一個人其他選舉的地區，例如里長那一筆的村里、立委那一筆的選區）'
                   ELSE '只記到縣市、沒有選區' END
           || '，網站的' || CASE WHEN x.no_region THEN '縣市篩選撈不到他'
                                WHEN x.wrong_level AND x.election_type = '縣市長' THEN '參選地區顯示錯了'
                                WHEN x.wrong_level THEN '選區分組把他放錯地方'
                                ELSE '選區篩選撈不到他' END || '。'
           || CASE WHEN sub.submitted_region IS NOT NULL
                   THEN '【先確認是不是同一個人】建立這筆紀錄的交件寫的縣市是「' || sub.submitted_region || '」，現在卻記在「' || COALESCE(x.county, '（空的）')
                        || '」——多半是同名的另一個人被對到這位人物名下。請用登記名冊與出生年、經歷核對：是同一個人就照名冊填 region 與選區重交；'
                        || '不是同一個人就不要交 candidacy（會把別人的參選掛在他名下），改用 no_change 回報，finding 寫「掛錯人：名冊上的是' || sub.submitted_region || '的同名者」。'
                   ELSE '' END
           || CASE WHEN x.candidate_status = 'not_running'
                   THEN '這筆是「表態不參選」的紀錄，要補的是他當初被傳要選、後來表態不選的那個縣市'
                        || COALESCE('（職位欄現在寫「' || x.position || '」，可以當線索，但要附出處）', '') || '。'
                   ELSE '' END
           || '請查證後用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、region 填縣市（用「台」不用「臺」）'
           || CASE WHEN x.no_district THEN '、electoral_district 填' || x.district_how ELSE '' END
           || '，candidate_status 照現況填「' || x.candidate_status || '」（狀態本身有錯是另一件事，不要在這筆改），其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party）；'
           || CASE WHEN cec.party IS NOT NULL THEN '中選會名單上他那一屆的推薦政黨是「' || cec.party || '」。' ELSE '' END
           || 'source_urls 附看得出' || CASE WHEN x.no_district THEN '選區' ELSE '縣市' END || '的出處。'
           || CASE WHEN cec.listed_as IS NOT NULL
                   THEN '中選會選舉資料庫的名單上記的是「' || cec.listed_as || '」：請打開 db.cec.gov.tw 核對是同一個人後照填，source_urls 附你核對的那一頁。'
                   WHEN x.election_id = 2026 AND x.candidate_status <> 'not_running'
                   THEN '2026 的縣市與選區在中選會候選人登記彙總表（web.cec.gov.tw/central/article/64709，各級選舉的 PDF 逐列寫著選區）；'
                        || '已登記的要附中選會名冊或登記截止後的報導，不然交件會被擋；附名冊網址的，系統會逐位核對、吻合的一票就過。'
                   WHEN x.candidate_status = 'not_running'
                   THEN '不參選的出處通常是當事人表態或政黨提名的新聞報導。'
                   ELSE '' END
           || '查不到可信出處就用 no_change 回報你查了哪些網址，不要猜。',
         CASE WHEN x.candidate_status = 'not_running'
              THEN ARRAY['cna.com.tw', 'udn.com', 'ltn.com.tw', '政黨官網的提名公告']
              WHEN x.election_id = 2026
              THEN ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表（逐列有選區）',
                         COALESCE(x.county, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com']
              ELSE ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 中選會歷屆參選，回選舉區',
                         'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份}', 'cna.com.tw'] END,
         1, x.county
    FROM gaps x
    -- 中選會名單（已投票的屆別才有）上全國同名同選舉別只有一位時，把他的縣市＋選區當線索附上；同名多位就不給，免得指錯人
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) = 1 THEN min(c.region || COALESCE(' ' || c.sub_region, '')) END AS listed_as,
             CASE WHEN count(*) = 1 THEN min(c.party) END AS party
        FROM cec_candidates c
       WHERE c.election_id = x.election_id AND c.election_type = x.election_type AND c.name_norm = cec_name_key(x.name)
    ) cec ON true
    -- 建立這筆參選紀錄的交件寫的縣市（只看建立那一次；edit_history 有 (table_name, record_id) 索引，缺口只有幾百筆）。
    -- 跟現在記的縣市一樣、交件沒寫縣市、是全國、或現在根本沒有縣市（那是「補縣市」，不是對錯人）就不提
    LEFT JOIN LATERAL (
      SELECT s.submitted_region
        FROM (SELECT translate(c.payload->>'region', '臺', '台') AS submitted_region
                FROM edit_history eh
                JOIN contributions c ON c.id = eh.contribution_id
               WHERE eh.table_name = 'politician_elections' AND eh.record_id = x.pe_id::TEXT AND eh.field = '*'
               ORDER BY eh.applied_at
               LIMIT 1) s
       WHERE x.county IS NOT NULL
         AND s.submitted_region IS NOT NULL AND s.submitted_region <> '全國'
         AND s.submitted_region <> translate(x.county, '臺', '台')
    ) sub ON true
$$;
COMMENT ON FUNCTION contribution_auto_tasks_region_gap IS
  '縣市長／縣市議員／立委：參選紀錄缺縣市（region_id 空）、缺選區（議員、立委只到縣市層級）、或掛錯層級（村里、鄉鎮、別種選舉的選區），沿用 candidacy_source_missing 型別；建立時交件的縣市跟現在不同會在說明裡講出來（2026-10-05）；'
  '2026-10-06 起其餘欄位照那一屆的名冊填、不叫代理照抄現在的政黨（target.person_party 只供對照、cec_party 是那一屆的推薦政黨）';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_township_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:candidacy_source_missing:' || pe.id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'person_party', p.party, 'region', p.region,
                            'election_id', pe.election_id, 'election_type', pe.election_type, 'candidate_status', pe.candidate_status),
         CASE WHEN pe.election_type = '村里長' THEN
           p.name || '（' || COALESCE(p.region, '') || ' ' || pe.election_id || ' 村里長候選人）的參選紀錄少了鄉鎮市區與村里，網站沒辦法把他放進正確的村里頁。'
             || '請查這個人的登記資料，確認他參選的鄉鎮市區與村里，用 candidacy 型別重交同一人同一屆：region 填「' || COALESCE(p.region, '')
             || '」、sub_region 填鄉鎮市區、village 填村里名，candidate_status 照現況，其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party），'
             || 'source_urls 附名冊或登記公告網址（中選會名冊系統會逐位核對、吻合的一票就過）。'
         ELSE
           p.name || '（' || COALESCE(p.region, '') || ' ' || pe.election_id || ' ' || pe.election_type || '候選人）的參選紀錄少了鄉鎮市區，網站沒辦法把他放進正確的鄉鎮頁。'
             || '請查這個人的登記資料，確認他參選的鄉鎮市區，用 candidacy 型別重交同一人同一屆：region 填「' || COALESCE(p.region, '')
             || '」、sub_region 填鄉鎮市區，candidate_status 照現況，其餘欄位照那一屆的名冊填（party 填那一屆的推薦政黨，不要照抄他現在的政黨——人會換黨；查不到就不要帶 party），source_urls 附名冊或登記公告網址（中選會名冊系統會逐位核對、吻合的一票就過）。'
         END,
         ARRAY['web.cec.gov.tw/central/article/64709 候選人登記彙總表', COALESCE(p.region, '') || '選舉委員會官網的登記公告', 'cna.com.tw', 'udn.com'],
         1, p.region
  FROM politician_elections pe
  JOIN politicians p ON p.id = pe.politician_id
  WHERE pe.election_id = 2026
    AND pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
    AND pe.region_id IS NULL
    AND pe.candidate_status NOT IN ('not_running')
    AND p.merged_into IS NULL
$$;
COMMENT ON FUNCTION contribution_auto_tasks_township_gap IS
  '2026 鄉鎮層級五種選舉的參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing；2026-10-06 起其餘欄位照那一屆的名冊填、不叫代理照抄現在的政黨';

-- ── 2. 2026 參選紀錄缺政黨：照中選會候選人登記彙總表 ──────────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_roster()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.candidate_status,
           p.id AS politician_id, p.name, p.party AS person_party,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county, r.sub_region
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id AND e.election_date >= CURRENT_DATE
      LEFT JOIN regions r ON r.id = pe.region_id
     -- 還沒投票的屆別、已登記（名冊上才有他）、我們不知道這一次的政黨
     WHERE pe.party_basis IS NULL AND pe.candidacy_status = 'filed'
  ),
  x AS (
    SELECT g.*,
           (SELECT array_agg(v.list_url ORDER BY v.sort, v.id) FROM verification_sources v
             WHERE v.kind = 'cec' AND v.status = 'ok' AND v.list_url IS NOT NULL AND 'roster' = ANY (v.provides)
               AND g.election_type = ANY (v.election_types) AND g.county = ANY (v.regions)) AS rosters
      FROM g
     -- 已經有人交了這一人這一屆的 candidacy 還在等票的先不派
     WHERE NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = g.politician_id::TEXT AND c.payload->>'election_id' = g.election_id::TEXT)
  )
  SELECT 'auto:candidacy_source_missing:party:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('kind', 'party_roster', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'missing', jsonb_build_array('party'), 'person_party', x.person_party,
                            'rosters', to_jsonb(x.rosters)),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '，已登記）這一次參選的政黨我們不知道——'
           || '網站只看得到他現在登記的政黨（「' || COALESCE(x.person_party, '空的') || '」），參選紀錄要記的是這一次登記時的推薦政黨。'
           || '這一屆還沒投票，中選會選舉資料庫還沒有名單：請打開中選會候選人登記彙總表'
           || COALESCE('（' || array_to_string(x.rosters, '、') || '）', '（web.cec.gov.tw/central/article/64709）')
           || '找到他那一列，用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、name 填「' || x.name
           || '」、election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、region 填「' || COALESCE(x.county, '') || '」'
           || CASE WHEN x.election_type = '縣市議員' THEN '、electoral_district 填名冊上的選舉區' ELSE '' END
           || '、party 照那一列的「推薦之政黨」原字填（寫「無」就填「無」，不要填他現在的政黨）、candidate_status 照現況填「' || COALESCE(x.candidate_status, '') || '」；'
           || 'source_urls 第一個放那份登記彙總表：系統會逐位核對名冊上的姓名、縣市、政黨，吻合的一票就過。名冊上找不到他就用 no_change 回報，不要猜。',
         COALESCE(x.rosters, ARRAY[]::TEXT[]) || ARRAY['https://web.cec.gov.tw/central/article/64709 ← 中選會各級選舉候選人登記彙總表'],
         1, x.county
    FROM x
$$;
COMMENT ON FUNCTION contribution_auto_tasks_party_roster IS
  '還沒投票的屆別、已登記而參選紀錄缺政黨（party_basis 空的）的，照中選會候選人登記彙總表補；沿用 candidacy_source_missing'
  '（target.kind＝party_roster，task_id 跟已投票那支同形狀，投完票由 contribution_auto_tasks_party_gap 接手）（2026-10-06）';

-- ── 4. 政黨資訊缺口 → party_info ─────────────────────────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_info()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH queued AS (
    -- 已經有人交了這個政黨的 party_info、還在等票的先不派
    SELECT DISTINCT (e ->> 'party_id') AS party_id
      FROM contributions c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload -> 'parties') = 'array' THEN c.payload -> 'parties' ELSE '[]'::JSONB END) e
     WHERE c.contribution_type = 'party_info' AND c.status IN ('pending', 'verified')
  ),
  gaps AS (
    -- rename：改名的界線日（新名稱開始用、舊名稱停用）還空著
    SELECT 'rename'::TEXT AS kind, n.id AS party_id, jsonb_build_array(n.id, o.id) AS party_ids,
           n.name, o.name AS other_name, n.moi_status,
           array_remove(ARRAY[CASE WHEN n.valid_from IS NULL THEN 'valid_from' END, CASE WHEN o.valid_to IS NULL THEN 'valid_to' END], NULL) AS missing
      FROM parties n JOIN parties o ON o.id = n.predecessor_id
     WHERE n.valid_from IS NULL OR o.valid_to IS NULL
    UNION ALL
    -- off_registry：內政部名冊查無此名稱、也還沒對到是誰改名前的名字
    SELECT 'off_registry', p.id, jsonb_build_array(p.id), p.name, NULL, NULL, ARRAY['predecessor_id', 'valid_to']
      FROM parties p
     WHERE p.moi_no IS NULL AND NOT EXISTS (SELECT 1 FROM parties c WHERE c.predecessor_id = p.id)
    UNION ALL
    -- dissolved：名冊上是解散、廢止、撤銷，停用日空著（名冊只有狀態、沒有日期）
    SELECT 'dissolved', p.id, jsonb_build_array(p.id), p.name, NULL, p.moi_status, ARRAY['valid_to']
      FROM parties p
     WHERE p.moi_status IN ('自行解散', '廢止備案', '撤銷備案') AND p.valid_to IS NULL
       AND NOT EXISTS (SELECT 1 FROM parties c WHERE c.predecessor_id = p.id)
  )
  SELECT 'auto:party_info_missing:' || g.kind || ':' || g.party_id,
         'party_info_missing',
         jsonb_build_object('kind', g.kind, 'party_id', g.party_id, 'party_ids', g.party_ids, 'name', g.name,
                            'predecessor_name', g.other_name, 'moi_status', g.moi_status, 'missing', to_jsonb(g.missing)),
         CASE g.kind
           WHEN 'rename' THEN '「' || g.other_name || '」改名為「' || g.name || '」，但改名是哪一天還不知道（政黨表的 '
             || array_to_string(g.missing, '、') || ' 空著）。請查內政部政黨資訊網、內政部公告或政黨自己的公告，'
             || '用 party_info 交：新名稱「' || g.name || '」那一項給 valid_from（開始用新名稱的日子）、舊名稱「' || g.other_name || '」那一項給 valid_to（停用的日子），兩筆一起交。'
           WHEN 'off_registry' THEN '「' || g.name || '」出現在我們的資料裡，但內政部政黨名冊查無此名稱。請查它是不是名冊上某個政黨改名前的名字：'
             || '是的話用 party_info 交兩項——名冊上那個政黨給 predecessor_id 填 ' || g.party_id || '（＋改名日 valid_from），「' || g.name || '」給 valid_to（停用的日子）；'
             || '要有來源講明是同一個政黨改名，名字像不算。只查到它停止活動的日子就只交它自己的 valid_to。'
           ELSE '「' || g.name || '」在內政部政黨名冊上的狀態是「' || g.moi_status || '」，但哪一天解散、廢止還不知道（政黨表的 valid_to 空著）。'
             || '請查內政部政黨資訊網那個政黨的頁面、內政部公告，用 party_info 交：這個政黨給 valid_to（解散或廢止生效的日子）。'
         END
           || '查不到確切的日子就不要交那一欄（不要填月初、年初湊），用 no_change 說明你查了哪些網址；臉書、IG、Threads 不算出處。',
         ARRAY['https://party.moi.gov.tw/PartyMain.aspx?n=16100&sms=13073 ← 內政部政黨資訊網：查政黨（點政黨名稱看備案、解散、廢止的紀錄）',
               '內政部全球資訊網的公告', '政黨官網的公告'],
         1, NULL::TEXT
    FROM gaps g
   WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.party_id = g.party_id::TEXT)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_party_info IS
  '政黨資訊缺口（2026-10-06）：改名的界線日、名冊外政黨的對應、解散廢止的停用日，新任務型別 party_info_missing，代理交 party_info';

-- ── 5b. 測試資料的人物 → removal ────────────────────────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_placeholder_politicians()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:placeholder_politician:' || p.id,
         'placeholder_politician',
         jsonb_build_object('politician_id', p.id, 'name', p.name, 'region', p.region, 'party', p.party,
                            'elections', (SELECT jsonb_agg(jsonb_build_object('id', pe.id, 'election_id', pe.election_id, 'election_type', pe.election_type,
                                                                              'candidate_status', pe.candidate_status, 'source_note', pe.source_note)
                                                           ORDER BY pe.election_id)
                                            FROM politician_elections pe WHERE pe.politician_id = p.id)),
         '人物「' || p.name || '」（' || COALESCE(p.region, '縣市未知') || '）的姓名看起來是測試資料，不像真的參選人。'
           || '請到中選會選舉資料庫、選委會公告與媒體查有沒有這個人：**查無此人** → 用 removal 型別回報，target_table 填 politicians、target_id 填「' || p.id
           || '」、reason（≥20 字）寫你查了哪些地方都沒有這個人；通過後整個人連參選紀錄一起移除（留查核履歷、可還原）。'
           || '**真有其人** → 用 no_change（outcome=confirmed）回報，checked_urls 放看得到他的官方頁面。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || p.name || ' ← 中選會歷屆參選',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, p.region
    FROM politicians p
   WHERE p.merged_into IS NULL AND politician_name_is_placeholder(p.name)
     -- 已經有人交了移除這個人、還在等票的先不派
     AND NOT EXISTS (SELECT 1 FROM contributions c
                      WHERE c.contribution_type = 'removal' AND c.status IN ('pending', 'verified')
                        AND c.payload->>'target_table' = 'politicians' AND c.payload->>'target_id' = p.id::TEXT)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_placeholder_politicians IS
  '姓名看起來是測試資料的人物（politician_name_is_placeholder），新任務型別 placeholder_politician，查無此人就交 removal（2026-10-06）';

-- ── 6. 接進派工（其餘照抄 20261006100100） ─────────────────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due())
  SELECT r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_villages()
  UNION ALL SELECT * FROM contribution_auto_tasks_township_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_region_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_elected_missing()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_cec_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_district_seats()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_elements()
  UNION ALL SELECT * FROM due
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_candidates()
  UNION ALL SELECT * FROM contribution_auto_tasks_handover_missing()
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_roles()
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_links()
  UNION ALL SELECT * FROM contribution_auto_tasks_career_sources()
  UNION ALL SELECT * FROM contribution_auto_tasks_withdrawn_filing()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_roster()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_info()
  UNION ALL SELECT * FROM contribution_auto_tasks_placeholder_politicians()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-06 加學經歷補出處、退選前有沒有登記、參選紀錄缺政黨（#345／#346）。'
  '2026-10-06 加 2026 參選紀錄缺政黨（登記彙總表）、政黨資訊缺口（party_info_missing）、疑似測試資料的人物（placeholder_politician）。';

DO $$
BEGIN
  RAISE NOTICE '2026 缺政黨 % 件；政黨資訊 % 件；疑似測試資料 % 件',
    (SELECT count(*) FROM contribution_auto_tasks_party_roster()),
    (SELECT count(*) FROM contribution_auto_tasks_party_info()),
    (SELECT count(*) FROM contribution_auto_tasks_placeholder_politicians());
END $$;

NOTIFY pgrst, 'reload schema';
