-- 派工與排程的啟用時間窗，P2（一支臂一個 PR）：party_gap——已投票屆別參選紀錄缺政黨（2026-10-08，docs/PLAN-task-activation.md）
-- ============================================================
--
-- P1（20261008060000）讓派工總表 contribution_auto_tasks_arms() 對每個活動過規則，P2「選舉結果」（20261008070000）示範了第一組：把臂內寫死的
-- 日期條件翻成規則。這支做第二組：party_gap 一支臂，同一個型（投票日 +1 起、無迄日）。今天（2026-10-08）派工輸出逐件不變，之後的日期改由規則決定。
--
-- party_gap（contribution_auto_tasks_party_gap，產出 candidacy_source_missing、target.kind＝party）：
--   臂內的日期條件：g CTE 的 JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE（「已投票屆別」）。
--   這是臂裡唯一一處拿投票日跟 CURRENT_DATE 比的地方。candidacy_list_published(…, CURRENT_DATE) 是名單公告日（算 candidate_status 的字眼用），
--   不是「這支臂何時開」，不在 P2 範圍、不動。
--
-- 規則（把 P1 的「永遠開」種子原地改成窗口，rule_id 不變）：
--   * activity='party_gap'：window_kind='event'、from_kind='polling'、from_offset=+1、沒有迄日、min_status='announced'；範圍不限。
--       - 起日：原條件「election_date < CURRENT_DATE」＝投票日的隔天起。規則的日界是台北時間（activity_today()），原條件的 CURRENT_DATE 是資料庫 UTC 的日期，
--         所以窗口比原本早 8 小時開（投票日 +1 的台北 00:00 起，原本是 08:00 起）。今天沒有任何一場選舉落在這 8 小時內，輸出不變。
--       - 迄日：不設。「缺政黨」本身就是缺口的終點（補上了這件自己消失），舊屆別要持續派。
--       - 屆別：不限定。2022、2024、重行選舉各自從自己的投票日 +1 起算，2026 與之後每一場選舉也是——2028 不用再改。
--       - election_date 空的選舉沒有 polling 里程碑＝窗口關（原條件 NULL < CURRENT_DATE 也不成立，行為相同）。
--   * 與 party_roster（還沒投票、已登記，下一個 PR）銜接：兩支臂產出同形狀的 task_id（auto:candidacy_source_missing:party:<pe_id>），原本靠 election_date 的方向分工，
--     之後靠兩條規則分工（party_gap 從投票日 +1 起、party_roster 到投票日當天為止），台北日界下兩個窗口不重疊也不留縫。
--
-- 臂的改法（現行定義＋機械式替換）：
--   * 本體＝20261006220000 的現行定義（與正式庫 pg_get_functiondef 一字不差，2026-10-08 比對過），只把「JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE」
--     換成「JOIN elections e ON e.id = pe.election_id」加一行說明註解。其餘一字不差。
--   * 同簽名、同回傳型別（CREATE OR REPLACE，不用分兩次上）；呼叫它的只有 contribution_auto_tasks_arms()（2026-10-08 唯讀查正式庫 pg_proc 確認，沒有 Edge Function 直接呼叫）。
--
-- 需要注意的連帶效果：
--   * 臂本身現在也算投票日之前的屆別（2026：缺政黨的參選紀錄很多），輸出再由總表依規則濾掉，所以 2026-11-28 之前這些列不會進派工列。
--     多算的成本（m CTE 對 2026 的列去 cec_candidates 查名單，目前 2026 沒有名冊所以幾乎是空查）見 PR 說明的 EXPLAIN ANALYZE 實測。
--   * 窗口開了之後，每件新缺口的 opened_by 帶 expected_open_on（投票日 +1）。
--   * gap_events 的關閉原因仍一律記 filled：這條規則沒有迄日，窗口只會「到點才開」、不會「到點關」，收回只可能是缺口補上了；
--     分 window 與 filled 的機制跟第一支有迄日的臂（party_roster，下一個 PR）一起做。
--
-- 守門：supabase/functions/_shared/activity-party-gap.test.ts（文字層：臂＝前一版加一處機械式替換；規則只改這一條；PGlite：假時鐘 2026-11-28 當天不開、11-29 開、舊選舉照常開、
--   今天輸出與 P1 逐件相同、與 party_roster 的 task_id 分工；還原驗證）；scripts/arms-parity-p2.ts check party_gap <snapshot.json>：正式庫唯讀快照，新舊輸出筆數與全欄雜湊相等（不進 CI，PR 說明附結果）。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：P0／P1 的 activity_rules、election_milestones_all（polling 來自 elections.election_date）；
-- 臂本來就用的表與函式（candidacy_protocol_status、candidacy_list_published、cec_name_key、party_alias_key、party_aliases、parties、cec_candidates、contributions…）沒有新增引用。

-- ------------------------------------------------------------
-- 1. contribution_auto_tasks_party_gap：g CTE 拿掉日期比較（其餘一字不差）
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 2. 規則：把 P1 的「永遠開」種子原地改成「投票日 +1 起」（rule_id 不變；審計觸發器照寫 edit_history）
-- ------------------------------------------------------------
-- 沒有迄日、不限屆別與職位、min_status 用預設 announced（理由見檔頭）。可重跑：已經是這個形狀的規則再改一次不變
UPDATE activity_rules
   SET window_kind = 'event', from_kind = 'polling', from_offset = 1, until_kind = NULL, until_offset = 0, min_status = 'announced',
       recur_months = NULL, reasons = NULL, levels = NULL, election_types = NULL, jurisdictions = NULL, enabled = true,
       note = 'P2：投票日 +1 起（原臂內條件 e.election_date < CURRENT_DATE，台北日界）；沒有迄日——缺政黨補上缺口就自己消失，舊屆別（2022、2024、重行選舉）還有缺口要持續派；範圍不限、每場選舉各自從自己的投票日算'
 WHERE activity = 'party_gap'
   AND (window_kind = 'always' OR (from_kind = 'polling' AND from_offset = 1));

-- 沒改到、改到多條、或這個活動還有別條規則（OR 會讓窗口比預期寬）都不能上線
DO $$
BEGIN
  IF (SELECT count(*) FROM activity_rules r WHERE r.activity = 'party_gap') <> 1
     OR NOT EXISTS (SELECT 1 FROM activity_rules r
                     WHERE r.activity = 'party_gap' AND r.enabled AND r.window_kind = 'event' AND r.from_kind = 'polling' AND r.from_offset = 1
                       AND r.until_kind IS NULL AND r.reasons IS NULL AND r.levels IS NULL AND r.election_types IS NULL AND r.jurisdictions IS NULL) THEN
    RAISE EXCEPTION 'P2（party_gap）：party_gap 的規則不是預期的一條「投票日 +1 起」';
  END IF;
END
$$;

-- 函式備註補一句「已投票屆別」現在由規則決定（只補一次：已經有標記就不再補）
DO $$
DECLARE v_old TEXT := obj_description('contribution_auto_tasks_party_gap()'::regprocedure, 'pg_proc');
BEGIN
  IF v_old IS NOT NULL AND v_old NOT LIKE '%P2 20261008120000%' THEN
    EXECUTE format('COMMENT ON FUNCTION contribution_auto_tasks_party_gap IS %L',
                   v_old || '｜2026-10-08（P2 20261008120000）：「已投票屆別」改由規則 activity_rules「party_gap」（投票日 +1 起）決定，臂內不再比日期');
  END IF;
END
$$;
