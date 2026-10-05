-- 縣市議員選區錯亂：補參考資料、顯示不再借人物的地區、補選區任務講清楚掛在哪（2026-10-05）
--
-- 小良哥在 2026 縣市頁看到「縣市議員・桃園區」「大雅區」「豐原區」「臺中市第03選區」「高雄市第08選區」這種假選區。
-- 10-05 唯讀盤點（全國 2022、2026 縣市議員參選紀錄）：
--   2026：議員選區 916 筆正常；只到縣市 100 筆、沒有地區 5 筆，其中 103 筆是名單清查照中選會登記彙總表交的
--         （名冊每一列都印著選舉區，代理沒抄、交件端沒要求、落庫只能記到縣市）。
--   2022：只到縣市 43 筆、指到鄉鎮 1 筆（2026-01 早期匯入，不是貢獻）。
--   沒有任何一筆指到村里或立委選區列——畫面上的「大雅區 上雅里」「臺中市第03選區」不是參選紀錄的地區，
--   是 politicians_with_elections 在參選紀錄沒有選區時「借」人物自己的地區：
--   COALESCE(參選紀錄那一列, 人物那一列, 人物文字欄)。陳映辰、連佳振是 2022 里長（借到里），
--   張烱春、李政憲是 2024 立委參選人（借到立委選區），鄭志偉、杜文卿是 2022 鄉鎮市長（借到鄉鎮）。
--   拿名冊核對 105 筆：借到的 47 個「第NN選舉區」有 46 個剛好對、1 個是錯的（楊寶楨顯示第03、名冊是第11），
--   另 7 筆借到假選區、1 筆縣市都錯（簡嘉佑，見下）。
--
-- 依 10-05 常設裁決（資料一律走流程）：這支**不改任何人物或參選紀錄**，只做三件事：
--   1. regions 參考資料：補 2026 議員選舉區列（中選會登記彙總表有、regions 沒有的 44 列，多半是原住民選舉區）。
--      沒有這幾列，代理照名冊交了正確選區，落庫也對不到、只能記到縣市，補選區任務會永遠派回來。
--   2. 顯示：縣市長、縣市議員、立委、總統的參選紀錄不再借人物的鄉鎮村里（視圖 politicians_with_elections）。
--      沒有選區就是沒有選區，畫面列「選區待補」，等任務補上；不要冒出假選區、也不要把 2022 的選區當 2026 的。
--   3. 補選區任務（contribution_auto_tasks_region_gap）：講清楚掛在哪一層（村里、鄉鎮、別種選舉的選區），
--      縣市長掛錯層級也派；建立這筆的交件縣市跟現在不一樣時（簡嘉佑：交件寫台中市、現在記在桃園市），
--      任務直接講出來、請代理先確認是不是同一個人，不要照著錯的縣市去找。

-- ============================================================
-- 1. regions：2026 縣市議員選舉區（中選會 115 年候選人登記彙總表，製表日期 115/09/07）
-- ============================================================
-- 直轄市議員 https://web.cec.gov.tw/api/file/ccd7e51a-5fd0-4ea0-a81b-a120cd550c9c.pdf
-- 縣市議員   https://web.cec.gov.tw/api/file/729644ff-cb01-42bb-a052-c9b3c55a1289.pdf
-- 每個縣市的選舉區都從第 1 號連續編到這個數字；跟 _shared/electoral-district.ts 的 COUNCIL_DISTRICT_COUNT_2026
-- 是同一份（_shared/council-district-flow.test.ts 核對兩邊一致、也核對名冊抽字檔）。
-- 形狀跟線上既有的 177 列一樣：region＝縣市（台）、sub_region＝第NN選舉區、village＝NULL。已經有的不動。
DO $$
DECLARE v_n INTEGER;
BEGIN
  INSERT INTO regions (region, sub_region, village)
  SELECT c.region, '第' || lpad(n::TEXT, 2, '0') || '選舉區', NULL
    FROM (VALUES
      ('台北市', 8), ('新北市', 13), ('桃園市', 14), ('台中市', 17), ('台南市', 13), ('高雄市', 15),
      ('基隆市', 9), ('新竹市', 7), ('新竹縣', 14), ('苗栗縣', 8), ('彰化縣', 10), ('南投縣', 8),
      ('雲林縣', 8), ('嘉義市', 2), ('嘉義縣', 7), ('屏東縣', 16), ('宜蘭縣', 13), ('花蓮縣', 10),
      ('台東縣', 16), ('澎湖縣', 6), ('金門縣', 3), ('連江縣', 4)
    ) AS c(region, total)
    CROSS JOIN LATERAL generate_series(1, c.total) AS n
   WHERE NOT EXISTS (
     SELECT 1 FROM regions r
      WHERE r.region = c.region AND r.sub_region = '第' || lpad(n::TEXT, 2, '0') || '選舉區' AND r.village IS NULL
   );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '補上 % 列 2026 縣市議員選舉區（10-05 線上缺 44 列）', v_n;
END $$;

-- ============================================================
-- 2. 視圖：縣市層級以上的選舉不借人物的鄉鎮村里
-- ============================================================
-- 只改 elections 裡每一屆的 subRegion／village 兩個鍵，欄位清單與型別不變（不是刪改欄位，不必分兩次上）。
-- 鄉鎮層級五種（鄉鎮市長、代表、村里長、原住民區長與區代表）照舊借：那幾種的地區本來就在鄉鎮村里，
-- region_id 空的時候退回人物的鄉鎮是既有行為（township_gap 補上之後就不再借）。
-- 其他部分照 20261004000005 的定義原樣抄。
CREATE OR REPLACE VIEW politicians_with_elections AS
 SELECT p.id,
    p.name,
    p.party,
    p.status,
    p.election_type,
    p."position",
    p.current_position,
    COALESCE(r.region, p.region) AS region,
    COALESCE(r.sub_region, p.sub_region) AS sub_region,
    COALESCE(r.village, p.village) AS village,
    p.avatar_url,
    p.slogan,
    p.bio,
    p.education,
    p.experience,
    p.birth_year,
    p.education_level,
    COALESCE(( SELECT json_agg(pe.election_id) AS json_agg
           FROM politician_elections pe
          WHERE pe.politician_id = p.id), '[]'::json) AS election_ids,
    COALESCE(( SELECT json_agg(json_build_object('electionId', pe.election_id, 'position', COALESCE(pe."position", p."position"), 'slogan', COALESCE(pe.slogan, p.slogan), 'electionType', COALESCE(pe.election_type, p.election_type), 'regionId', pe.region_id, 'region', COALESCE(per.region, r.region, p.region),
             'subRegion', CASE WHEN COALESCE(pe.election_type::TEXT, p.election_type::TEXT) IN ('總統副總統', '縣市長', '縣市議員', '立法委員')
                               THEN per.sub_region ELSE COALESCE(per.sub_region, r.sub_region, p.sub_region) END,
             'village', CASE WHEN COALESCE(pe.election_type::TEXT, p.election_type::TEXT) IN ('總統副總統', '縣市長', '縣市議員', '立法委員')
                             THEN per.village ELSE COALESCE(per.village, r.village, p.village) END,
             'candidateStatus', pe.candidate_status, 'electionResult', pe.election_result, 'sourceNote', pe.source_note, 'candNo', pe.cand_no)) AS json_agg
           FROM politician_elections pe
             LEFT JOIN regions per ON pe.region_id = per.id
          WHERE pe.politician_id = p.id), '[]'::json) AS elections,
    p.merged_into,
    COALESCE(( SELECT json_agg(json_build_object('electionId', o.election_id, 'electionType', o.election_type, 'region', o.region, 'subRegion', o.sub_region, 'village', o.village, 'termEnd', o.term_end) ORDER BY o.election_id DESC) AS json_agg
           FROM politician_offices o
          WHERE o.politician_id = p.id), '[]'::json) AS offices
   FROM politicians p
     LEFT JOIN regions r ON p.region_id = r.id;

-- CREATE OR REPLACE VIEW 會把 reloptions 清掉（20261004000005 實測），security_invoker 要補回來
ALTER VIEW politicians_with_elections SET (security_invoker = on);
COMMENT ON VIEW politicians_with_elections IS
  '人物＋每一屆參選紀錄（elections）＋現任公職（offices）。縣市長、縣市議員、立委、總統那幾屆的 subRegion／village 只來自參選紀錄自己指的那一列，不借人物的地區（2026-10-05）';

-- ============================================================
-- 3. 補縣市／補選區任務：講清楚掛在哪一層、縣市長掛錯層級也派、交件縣市不一致要講
-- ============================================================
-- 跟 20261005000400 同名同簽名（CREATE OR REPLACE），contribution_auto_tasks_arms 不必重寫。
-- 判斷與文字的差別：
--   - wrong_level：指到的列不是縣市層級、也不是這種選舉的選區（村里、鄉鎮、別種選舉的選區）。
--     議員與立委本來就算「缺選區」會派（NOT region_is_electoral_district），這裡只是把說明寫對——
--     以前一律寫「只記到縣市、沒有選區」，2022 陳怡君（新北市 中和區）那種代理看了會以為縣市層級沒錯。
--     縣市長以前完全不看層級，指到鄉鎮或村里也不派；現在當成「缺縣市」派。
--   - submitted_region：建立這筆參選紀錄的那件交件寫的縣市（edit_history 的 '*' 那一列 → contributions.payload）。
--     跟現在記的縣市不同，多半是同名的人被對錯（簡嘉佑：台中市議員參選人掛到桃園市豐林里長名下，
--     20261004000020 又照人物的縣市把參選紀錄補成桃園市）。任務直接講出來、附交件時的縣市當線索。
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
             WHEN 'not_running' THEN '表態不參選' WHEN 'registered' THEN '已登記' WHEN 'confirmed' THEN '確定參選'
             WHEN 'qualified' THEN '審定合格' ELSE g.candidate_status END AS status_label,
           CASE WHEN g.election_type = '立法委員'
                THEN '「第NN選區」（區域立委）；不分區或原住民立委 region 填「全國」、electoral_district 填「不分區」「平地原住民」或「山地原住民」'
                ELSE '「第NN選舉區」（例：第04選舉區）' END AS district_how
      FROM g
     WHERE g.no_region OR g.no_district OR g.wrong_level
  )
  SELECT 'auto:candidacy_source_missing:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('politician_id', x.politician_id, 'name', x.name, 'party', x.party, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'politician_election_id', x.pe_id,
                            'missing', to_jsonb(array_remove(ARRAY[CASE WHEN x.need_region THEN 'region' END,
                                                                   CASE WHEN x.no_district THEN 'electoral_district' END], NULL)),
                            'attached_to', CASE WHEN x.wrong_level THEN x.county || ' ' || x.attached_below_county END,
                            'submitted_region', sub.submitted_region,
                            'cec_listed_as', cec.listed_as),
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
           || '，candidate_status 照現況填「' || x.candidate_status || '」（狀態本身有錯是另一件事，不要在這筆改），其餘欄位照現有資料原樣帶；'
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
      SELECT CASE WHEN count(*) = 1 THEN min(c.region || COALESCE(' ' || c.sub_region, '')) END AS listed_as
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
  '縣市長／縣市議員／立委：參選紀錄缺縣市（region_id 空）、缺選區（議員、立委只到縣市層級）、或掛錯層級（村里、鄉鎮、別種選舉的選區），沿用 candidacy_source_missing 型別；建立時交件的縣市跟現在不同會在說明裡講出來（2026-10-05）';
