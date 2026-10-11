-- 應選名額任務：我們漏掉的選舉區也要派（以中選會登記名冊上有人登記的選舉區數當下限）
-- ============================================================
-- 工作單：Yooliang/policy-ops#23（2026 縣市議員選區名額人工核一次；核對報告 policy-ops docs/handoff/2026-10-09-縣市議員選區名額核對.md）
--
-- 症狀：人工核對（10-09，唯讀）官方 22 縣市 221 區、919 席；正式庫 2026 縣市議員只有 150 區（名額全空），
--   漏了新竹縣整縣 14 區（含原住民 3 區）與其他 17 縣市的原住民選舉區，共 71 區。
-- 為什麼流程補不進來：派工臂 contribution_auto_tasks_district_seats 只看「我們已有的選舉區裡還有沒有缺名額」
--   （h.districts IS NULL OR h.with_seats < h.districts）。代理照提示交了一個縣市的部分選舉區（10-07 屏東縣交 7 區、
--   公告 16 區），通過後那 7 區都有名額，臂就不再派——缺的 9 區永遠不會出現（20261005004900 的「錯了的代價」寫過這件事，
--   當時寄望 cec-sync 從候選人名單補出選舉區，但 2026 的名單要 11 月才公告）。
-- 修法：中選會登記彙總表已經在 cec_registrations（20261008130000），議員與代表每一列有選舉區。
--   以「登記名冊上有人登記的選舉區數」當下限：我們的選舉區比它少就照派，what_we_need 多一句說差幾區。
--   正式庫 migration 裡的資料（不含舊版 729644ff）算出來：2026 縣市議員 221 區、22 縣市逐縣市等於公告；
--   鄉鎮市民代表 656 區、直轄市山地原住民區民代表 16 區（代表的選舉區編號每個鄉鎮各自從第01起，所以連鄉鎮一起算）。
--   2022 年沒有登記名冊資料，2022 的任務一件不變。
--
-- 只改這支臂：照 20261009090000 的現行定義做四處機械替換（加 reg CTE、加一句說明、FROM 加 LEFT JOIN、WHERE 多一個 OR）。
--   task_id、task_type、target、hint_sources、reward、region 一字不動；輸出只會多不會少；
--   名額照舊只能由代理照公告交 district_seats＋同儕驗證（applyDistrictSeats 會把庫內沒有的選舉區連 district_kind 一起建），
--   這支不寫任何名額、不建任何選舉區列、不改協議與計分。
-- 不是這支的事：已經有人交了在等票的縣市照舊不派（queued 不動）。
--
-- 引用到的既有欄位：cec_registrations(election_id, election_type, region, sub_region, district, source_url)、
--   cec_registration_sources(source_url, superseded_by)（20261008130000 建表；部署前由主線唯讀確認）
-- 守門：supabase/functions/_shared/district-seats-registered.test.ts

CREATE OR REPLACE FUNCTION contribution_auto_tasks_district_seats()
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
$$;
COMMENT ON FUNCTION contribution_auto_tasks_district_seats IS
  '應選名額缺口：議員、代表各選舉區的名額（#344，2026-10-06）。一個縣市一種選舉一件，代理照選舉公告交 district_seats。'
  '2026-10-08：提示改成指向 current.verification_sources（各屆各縣市的選舉公告 PDF），並要求公告上有幾區交幾區；條件與輸出欄位不變。'
  '2026-10-11：我們的選舉區比中選會登記名冊上有人登記的選舉區少，名額都補齊了也照派（policy-ops#23）。';
