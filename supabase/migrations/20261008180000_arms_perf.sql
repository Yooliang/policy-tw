-- 派工總表的效能整理：四支臂換寫法，輸出逐件不變（2026-10-08，docs/PLAN-task-activation.md 第 11 節）
-- ============================================================
--
-- 背景：contribution_auto_tasks_arms() 一次約 4.6 秒，seed_auto_task_queue()（pg_cron 每 10 分鐘）一次 6.8～10.5 秒（中位數 7.1）。
-- 正式庫唯讀實測（EXPLAIN ANALYZE；各臂各自包成 MATERIALIZED CTE、把全部輸出欄位加總，不是只量 count(*)——
-- 只量 count(*) 時沒用到的欄位會被修剪掉，owner_mismatch 量出 480 毫秒、實際在總表裡 1,208 毫秒）：
-- 28 支分支共 4.1 秒，前五名占 83%：owner_mismatch 1,187、term_policies 629、roster_cec_gap 570、mayor_policies 540、election_results 509（毫秒）。
-- 資料表都很小（最大的 task_dispatches 1.3 萬列、politicians 1.6 萬列），慢的不是缺索引，是寫法讓同一件事被做了很多遍。
--
-- 這一支只重寫四支臂（任務內容、順序、規則、優先層一個字不動；簽名、回傳型別、語言、穩定度不動）：
--
--   一、contribution_auto_tasks_mayor_policies：540 → 14 毫秒
--     1. WHERE 裡的 is_2026_mayor_candidate(p.id) 是純量函式，對 politicians 每一列呼叫一次（1.6 萬次 × 約 30 微秒＝約 500 毫秒）；
--        本體原樣（同一個條件）寫成 EXISTS，變成半連接。is_2026_mayor_candidate 這支函式本身沒動（別處還在用）。
--     2. 「等票中的政見數」queued 原本每位候選人各掃一次 contributions（payload 沒有索引，每次約 3 毫秒、m 又被展開三次）；
--        改成整張掃一次、依人物分組（queued_by），沒有等票的人 COALESCE 成 0。m 加 MATERIALIZED，四個子查詢每人只算一次。
--
--   二、contribution_auto_tasks_roster_cec_gap：570 → 236 毫秒
--     ours（本庫已有的人，約 1.6 萬列、DISTINCT 要 75 毫秒）被 marked 裡的 matched EXISTS 用到，而 matched 又被四個聚合與一個過濾各引用一次，
--     不加 MATERIALIZED 時 EXISTS 子查詢被複製五份、ours 建了五遍（計畫裡 SubPlan 52／54／56／58／60 各 75 毫秒）。
--     ours、marked 加 MATERIALIZED：算一次。
--
--   三、contribution_auto_tasks_owner_mismatch：1,187 → 553 毫秒
--     「同名的其他人」(same_name) 對每一筆缺口掃全部人物（1.6 萬列）並對每列重算兩次 cec_name_key（正規式）；14 筆缺口 × 約 50 毫秒＝約 700 毫秒。
--     改成姓名鍵全部人物算一次（pk，MATERIALIZED），每筆缺口只在 pk 裡比對；(SELECT cec_name_key(p.name)) 讓外層姓名鍵每筆缺口只算一次
--     （直接寫 cec_name_key(p.name) 會被內嵌成每個 pk 列各算一次，實測還是 400 毫秒）。其餘約 400 毫秒是 candidacy_owner_mismatch_signals()
--     呼叫 election_result_cec_matches() 對 1.6 萬筆參選紀錄逐筆配對名單，這一支沒動（見下面「沒做的」）。
--
--   四、contribution_auto_tasks_policy_elements：140 → 87 毫秒
--     cand 加 MATERIALIZED：缺的要素陣列（missing，三個子查詢）與主要出處 policy_primary_url() 不再因為被輸出欄位、過濾條件各引用而重算。
--
-- 正式庫唯讀比對（scripts/arms-perf-parity.ts parity；新本體以子查詢原樣執行、同一個查詢快照）：
--   ① 四支臂：現行函式 vs 新本體，雙向 EXCEPT ALL 都是 0、全欄雜湊相同（25／211／14／1,114 件）
--   ② 總表：現行 contribution_auto_tasks_arms() vs 把這四支臂換成新本體後的總表，gap.arms_all 關著（預設）7,904 件、開著（seed 用，多回傳被規則濾掉的列）9,592 件，
--      兩種模式雙向 0 件差異、全欄雜湊相同
--   ③ 補充：同名人物 150 位的 same_name、有政見提交的人物 200 位的等票數（其中 26 位非 0）、1.6 萬位人物的 is_2026_mayor_candidate 與 EXISTS，逐筆 0 差異
-- 總表整體 EXPLAIN ANALYZE（現行 vs 四支臂換新本體，各三次）：4,587 → 3,171 毫秒（-31%）；seed 的總表呼叫（gap.arms_all 開著）同步變快，
-- seed 其餘部分的量測見計畫第 11 節。
--
-- 沒做的（量過、理由寫在計畫第 11 節）：
--   * 不建索引：熱點都是「同一件事做很多遍」，不是缺存取路徑；same_name 的 politicians (cec_name_key(name)) 運算式索引在唯讀環境量不出效果，
--     而 pk 的寫法已經把它降到約 30 毫秒（全部人物算一次）。
--   * 不改 election_result_cec_matches：把逐列 LATERAL 改成雜湊連接內嵌量到 77 毫秒（count(*) 修剪）、換成函式實際用的「陣列參數未知」計畫
--     （SET plan_cache_mode = force_generic_plan ＋ PREPARE）後超過 20 秒被中止——陣列長度被估成 10 筆，選了巢狀迴圈重跑聚合。原寫法 0.3 秒，維持原樣。
--   * 不改總表 arms() 與 seed（#452、#453 也在改 arms()）：總表的後處理約 450 毫秒（activity_open 對每一列各問一次約 180、
--     測試名人物過濾的兩個子查詢約 175），可以另開一個只動 arms() 的 PR，由後合併的以 main 最新版重做。
--   * term_policies（629）、election_results（509）：大頭是 politician_bulletins 視圖（270）與 election_result_cec_matches（330），都是共用物件，這一支不動。
--
-- 守門：supabase/functions/_shared/arms-perf.test.ts（文字層：新定義＝前一版加固定幾處機械式替換；行為層：PGlite 合成資料舊 vs 新逐件相同＋還原驗證）。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mayor_policies()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  -- 等票中的 2026 政見提交數：整張 contributions 掃一次、依人物分組；原本每位候選人各掃一次（payload 沒有索引，每次約 3 毫秒）
  WITH queued_by AS MATERIALIZED (
    SELECT c.payload->>'politician_id' AS pid, COUNT(*) AS n FROM contributions c
     WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified')
       AND c.payload->>'politician_id' IS NOT NULL
       AND COALESCE(NULLIF(c.payload->>'election_id', ''), '2026') = '2026'
     GROUP BY 1
  ),
  m AS MATERIALIZED (
    SELECT p.id, p.name, p.party, p.region,
           (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = p.id AND pl.removed_at IS NULL) AS n_all,
           (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = p.id AND pl.removed_at IS NULL AND pl.election_id = 2026) AS n2026,
           COALESCE((SELECT qb.n FROM queued_by qb WHERE qb.pid = p.id::TEXT), 0) AS queued,
           (SELECT string_agg(DISTINCT pl.category, '、') FROM policies pl
             WHERE pl.politician_id = p.id AND pl.removed_at IS NULL AND pl.election_id = 2026 AND pl.category IS NOT NULL) AS cats
    FROM politicians p
    WHERE p.merged_into IS NULL
      -- is_2026_mayor_candidate(p.id) 的本體原樣寫在這裡：當純量函式逐人呼叫要掃全部人物（約 1.6 萬次），寫成 EXISTS 才會變成半連接
      AND EXISTS (SELECT 1 FROM politician_elections pe
                   WHERE pe.politician_id = p.id
                     AND pe.election_id = 2026 AND pe.election_type = '縣市長'
                     AND pe.candidacy_status IN ('declared', 'filed'))
  )
  SELECT 'auto:policy_missing:' || m.id, 'policy_missing',
         jsonb_build_object('politician_id', m.id, 'name', m.name, 'party', m.party, 'region', m.region,
                            'election_id', 2026, 'election_type', '縣市長',
                            'policies_now', m.n2026, 'policies_other_terms', m.n_all - m.n2026, 'queued', m.queued,
                            'categories_now', m.cats),
         m.name || '（' || COALESCE(m.region, '') || ' 2026 縣市長候選人）**2026 這一屆**的政見只有 ' || m.n2026 || ' 筆' ||
           CASE WHEN m.queued > 0 THEN '（另有 ' || m.queued || ' 筆還在等票）' ELSE '' END ||
           CASE WHEN m.n_all - m.n2026 > 0 THEN '；另外 ' || (m.n_all - m.n2026) || ' 筆是過去任期或上屆的，不算這屆' ELSE '' END ||
           CASE WHEN m.cats IS NOT NULL THEN '。這屆已有的類別：' || m.cats ELSE '' END ||
           '。縣市長是網站的主要內容，請補這一屆的政見：找有出處的具體 2026 競選政見，最多 5 筆、每筆一個 policy 型別、各附自己的出處，election_id 填 2026，優先補還沒有的類別。' ||
           '先看 current.queued_policies 與既有政見，已經有的不要重複交；現任者任內的施政、上屆的承諾不是這屆的政見，不要當 2026 交。' ||
           '找到幾筆交幾筆，不要為了湊數交口號、願景或個人表態。',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 2, m.region
  FROM m
  WHERE m.n_all > 0                 -- 總數 0 筆的由 raw 臂派，不重複
    AND m.n2026 + m.queued < 5
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_cec_gap()
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

CREATE OR REPLACE FUNCTION contribution_auto_tasks_owner_mismatch()
RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT g.politician_election_id AS id,
           jsonb_agg(jsonb_build_object('kind', g.signal, 'detail', g.detail) ORDER BY g.signal) AS signals,
           string_agg(g.detail, '；' ORDER BY g.signal) AS text
      FROM candidacy_owner_mismatch_signals() g
     GROUP BY g.politician_election_id
  ),
  -- 同名比對用的姓名鍵：全部人物算一次放著；原本每一筆缺口都掃全部人物、每人重算兩次姓名鍵（約 1.6 萬次正規式 × 每筆）
  pk AS MATERIALIZED (
    SELECT q.id, q.name, q.birth_year, q.party, q.region, cec_name_key(q.name) AS nk FROM politicians q WHERE q.merged_into IS NULL
  )
  SELECT 'auto:candidacy_owner_mismatch:' || pe.id,
         'candidacy_owner_mismatch',
         jsonb_build_object(
           'politician_election_id', pe.id, 'politician_id', p.id, 'name', p.name, 'birth_year', p.birth_year, 'party', p.party,
           'election_id', pe.election_id, 'election_type', pe.election_type,
           'region', replace(COALESCE(r.region, p.region), '臺', '台'), 'district', r.sub_region, 'village', r.village,
           'signals', s.signals,
           -- 這個人名下其他參選紀錄（判斷是不是同一人要一起看）
           'other_records', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('politician_election_id', o.id, 'election_id', o.election_id, 'election_type', o.election_type,
                                                 'region', ro.region, 'district', ro.sub_region, 'village', ro.village, 'candidacy_status', o.candidacy_status)
                              ORDER BY o.election_id)
               FROM politician_elections o LEFT JOIN regions ro ON ro.id = o.region_id
              WHERE o.politician_id = p.id AND o.id <> pe.id), '[]'::jsonb),
           -- 資料庫裡同名的其他人（改掛的候選對象）
           'same_name', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('politician_id', q.id, 'name', q.name, 'birth_year', q.birth_year, 'party', q.party, 'region', q.region))
               FROM (SELECT q.* FROM pk q
                      WHERE q.id <> p.id AND q.nk = (SELECT cec_name_key(p.name))
                      ORDER BY q.birth_year NULLS LAST LIMIT 10) q), '[]'::jsonb),
           -- 中選會名冊上這一屆同選舉同名的人（已投票的屆別才有；出生年是分辨同名最有力的根據）
           'cec_same_name', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('region', cc.region, 'sub_region', cc.sub_region, 'village', cc.village,
                                                 'birth_year', cc.birth_year, 'elected', cc.elected) ORDER BY cc.region, cc.sub_region)
               FROM cec_candidates cc
              WHERE cc.election_id = pe.election_id AND cc.election_type = pe.election_type AND cc.name_norm = cec_name_key(p.name)), '[]'::jsonb)),
         p.name || '（' || COALESCE(replace(COALESCE(r.region, p.region), '臺', '台'), '') || ' ' || pe.election_id || ' ' || COALESCE(pe.election_type, '')
           || '）這筆參選紀錄可能掛錯人：' || s.text || '。'
           || '請查中選會名冊（已投票的屆別看選舉資料庫的出生年；2026 看登記彙總表的推薦政黨與選舉區）與報導，判斷這筆是不是掛著的這個人。'
           || '**不是**：交 reassign_candidacy（from_politician_id 填 target.politician_id）——改掛到 target.same_name 裡的另一位（to_politician_id），或都不是就新建（new_politician：姓名、出生年、政黨）；'
           || 'evidence 寫出處上這一筆的出生年、推薦政黨或選舉區，reason 寫你憑什麼分辨。'
           || '掛錯的也可能是 target.other_records 裡的另一筆（換縣市那種兩筆都要看）：改掛時 politician_election_id 填真正掛錯的那一筆。'
           || '只是縣市或選區寫錯、人沒掛錯的，用 candidacy 重交同一人同一屆把地區改對，這一件回 no_change（outcome=confirmed）說明。'
           || '**是同一個人**（例如真的換了縣市參選）：交 no_change、outcome=confirmed，finding 寫你怎麼確認的——確認過的不會再派。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || p.name || ' ← 中選會歷屆參選（出生年、選區、政黨）',
               'https://web.cec.gov.tw/central/article/64709 ← 2026 候選人登記彙總表（選舉區、推薦政黨）',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || p.name || '","electionId":' || pe.election_id || '}'],
         1, replace(COALESCE(r.region, p.region), '臺', '台')
    FROM s
    JOIN politician_elections pe ON pe.id = s.id
    JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
    LEFT JOIN regions r ON r.id = pe.region_id
   WHERE NOT EXISTS (SELECT 1 FROM contributions c
                      WHERE c.contribution_type = 'reassign_candidacy' AND c.status IN ('pending', 'verified')
                        AND c.payload->>'politician_election_id' = pe.id::TEXT)
     -- 確認過是同一人的（no_change confirmed 通過）不再派
     AND NOT EXISTS (SELECT 1 FROM task_checks tc
                      WHERE tc.task_id = 'auto:candidacy_owner_mismatch:' || pe.id AND tc.outcome = 'confirmed')
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_elements()
 RETURNS TABLE(task_id text, task_type text, target jsonb, what_we_need text, hint_sources text[], reward integer, region text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH inflight AS (
    -- 已經有人交了、還在等票或自動重試中：先不派，免得兩個代理拆同一條；被退件就會回來
    SELECT DISTINCT c.payload->>'policy_id' AS policy_id
      FROM contributions c
     WHERE c.contribution_type = 'policy_elements' AND c.status IN ('pending', 'verified', 'apply_failed')
  ),
  cand AS MATERIALIZED (
    SELECT pl.id AS policy_id, pl.title, pl.status::TEXT AS status, pl.election_id, policy_primary_url(pl.id) AS source_url,
           p.id AS politician_id, p.name, p.party, COALESCE(r.region, p.region) AS region,
           x.election_type, e.election_date, e.bulletin_hint, e.bulletin_published_on,
           -- 屆別年份從投票日取，不從 id 推（#344：之後新增的選舉 id 不保證是年份）
           EXTRACT(YEAR FROM e.election_date)::INTEGER AS election_year,
           office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, x.election_type) AS term_end,
           ARRAY(SELECT k FROM unnest(ARRAY['target', 'deadline', 'funding']) WITH ORDINALITY AS u(k, n)
                  WHERE NOT EXISTS (SELECT 1 FROM policy_elements pe WHERE pe.policy_id = pl.id AND pe.element = u.k)
                  ORDER BY u.n) AS missing
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      -- 這個人那一屆的參選紀錄（同一屆有兩筆時取當選的、在選的那一筆）
      JOIN LATERAL (
        SELECT q.election_type, q.candidacy_status, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.candidacy_status = 'elected') DESC NULLS LAST,
                  (q.candidacy_status IS DISTINCT FROM 'withdrawn') DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL
       AND (
         -- 還沒投票：在選的人（選前要能並排比較）
         (e.election_date >= CURRENT_DATE AND x.candidacy_status IS DISTINCT FROM 'withdrawn')
         -- 已投票：當選者、而且還沒達成也沒跳票（期限要接得上追蹤）
         OR (e.election_date < CURRENT_DATE AND x.candidacy_status = 'elected' AND pl.status::TEXT NOT IN ('Achieved', 'Failed'))
       )
  )
  SELECT 'auto:policy_elements_missing:' || c.policy_id, 'policy_elements_missing',
         jsonb_build_object('policy_id', c.policy_id, 'policy_title', c.title, 'status', c.status, 'source_url', c.source_url,
                            'politician_id', c.politician_id, 'name', c.name, 'party', c.party, 'region', c.region,
                            'election_id', c.election_id, 'election_type', c.election_type, 'term_end', c.term_end,
                            'missing', to_jsonb(c.missing)),
         '「' || c.title || '」（' || c.name || '，' || c.election_year || ' ' || COALESCE(c.election_type, '') || '）還沒拆成政見三要素，還缺：'
           || array_to_string(ARRAY(SELECT CASE k WHEN 'target' THEN '數值目標' WHEN 'deadline' THEN '達成期限' ELSE '財源' END
                                      FROM unnest(c.missing) WITH ORDINALITY AS u(k, n) ORDER BY u.n), '、') || '。'
           || '請打開這條政見的**原文**（選舉公報、政見發表會、候選人官網或競選文宣的政見頁；政見上的 source_url 若只是轉述的新聞，先找到原文），'
           || '逐一看原文有沒有寫：數值目標（做到多少、做到什麼程度）、達成期限（什麼時候之前）、財源（錢從哪裡來）。'
           || '有寫的照原文寫進 text（120 字內，不補數字、不換算、不評價）；查過原文沒寫的 stated 填 false——那也是答案，畫面會顯示「未說明」。'
           || '每個要素都要附原句位置（source_locator），沒寫的也要寫你查的是原文哪一段。'
           || '期限換得成日期就填 deadline_date：會計年度是曆年，「2028 年前」填 2028-12-31，「任內」填這一任的卸任日 ' || COALESCE(c.term_end::TEXT, '（target.term_end）') || '。'
           || '用 policy_elements 型別交一筆；找不到原文就用 no_change 回報你查了哪裡，不要拿我們的政見摘要當原文。',
         ARRAY_REMOVE(ARRAY[
           CASE WHEN c.source_url IS NOT NULL THEN c.source_url || ' ← 這條政見現在掛的出處（先看它是不是原文）' END,
           -- 公報入口讀 elections.bulletin_hint（公報上架日 bulletin_published_on 之後才給；沒填或還沒上架就給下面那句）
           CASE WHEN c.bulletin_hint IS NOT NULL AND (c.bulletin_published_on IS NULL OR c.bulletin_published_on <= CURRENT_DATE)
                THEN c.bulletin_hint
                ELSE '中選會選舉公報（投票前約兩週才出版；出版前看候選人官網、競選臉書的政見頁）'
           END,
           '政見發表會影片（各縣市選委會的 YouTube 頻道）',
           'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見）'
         ], NULL),
         1, c.region
    FROM cand c
   WHERE cardinality(c.missing) > 0
     AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.policy_id = c.policy_id::TEXT)
$function$
;
