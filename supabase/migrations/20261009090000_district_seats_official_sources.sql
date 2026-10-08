-- 應選名額任務補不上的原因與修法：附上各屆各縣市的選舉公告來源、提示改正、驗證者也看得到來源（#344，2026-10-08 對帳後）
-- ============================================================
--
-- 症狀（2026-10-08 唯讀查正式庫）：議員 2022 年 160 區、2026 年 150 區的 election_districts.seats 全空；
-- 鄉鎮市民代表、區民代表一個選舉區列都還沒有。#372 的派工臂 district_seats_missing 10-06 派 78 件，
-- 10-07 05:49–06:42 三個代理領走一輪：34 件交了 district_seats（至今 0 票，驗證項排在驗證佇列約第 2,450 位）、12 筆回 not_found
-- （等票中，擋住 11 個任務；另一筆的任務同時有交件）、其餘 33 件沒有任何回報。這 33 件還在隊裡等第二輪：
-- 2026 年的約在第 1,100 位（約 9 小時後輪到）、2022 年的約在第 5,900 位（約 2 天後）——所以提示要在第二輪之前改好。
--
-- 原因（查完交件內容與官方檔案）：
--   1. 來源沒附：任務的 SQL 提示只有「該縣市選委會官網」「中選會首頁」這種到不了公告的線索，
--      /next 的 current.verification_sources 對 district_seats_missing 一律不附（不在 SOURCE_TASK_TYPES，也沒登錄「應選名額」這種來源），
--      驗證者看到的 district_seats 驗證項更是什麼來源都沒有（verifySourceQuery 對它回 null）。12 件 not_found 全是「找不到公告」，
--      但公告都在 web.cec.gov.tw：議員的選舉公告是中選會 115/08/20 發布的（文字 PDF，article 63626）、登記彙總表 2-2、4-2 兩份最後一欄就是應選名額
--      （64709）；鄉鎮市民代表與區民代表的公告是各縣市選委會同一天發的，中選會 article 63645 有索引。選委會自己網站的列表頁常回 500，
--      代理走列表頁就找不到——這就是 not_found 的主因。
--   2. 提示誤導：任務提示說「選舉公報每個選舉區的開頭也寫著應選名額」，鄉鎮市民代表的公報大多沒印，代理在公報裡找半天。
--   3. 提示鼓勵交不完整：交件骨架只預填我們已知的選舉區，代理照著填，2026 年屏東縣交 7 區（公告 16 區）、台中市交 14 區（公告 17 區）；
--      我們記的 2026 年議員只有 150 區、中選會登記彙總表 221 區（合計 919 名，等於中選會 07/17 新聞稿的 919 名）。
--      「交了還在等票的縣市不再派」的條件會讓缺的那幾區在這一件通過前沒有人補。
--   不是原因：冷卻（task_checks 對這個任務型別 0 筆；被擋的 11 件是 pending 的 no_change，不是冷卻）。
--
-- 做了什麼（不寫任何名額；只加來源與提示，名額照舊要代理交件＋同儕驗證）：
--   1. verification_sources 加 election_ids（INTEGER[]，NULL＝每一屆）：選舉公告每屆不同，不能把 2026 的公告附給 2022 的任務。
--   2. 登錄 2026 年的官方來源（provides＝seats，只有應選名額任務與 district_seats 驗證項會附，名冊類任務的 roster 條件不受影響）：
--      議員選舉公告、直轄市議員與縣市議員登記彙總表（應選名額欄，供交叉核對）、鄉鎮市民代表與區民代表的索引頁，
--      以及十三縣與四個直轄市原住民區各自的公告 PDF（註明文字可抽或掃描影像）；2022 年登錄中選會 111/08/18 的議員選舉公告、
--      十三縣的鄉鎮市民代表公告與新北、桃園、高雄三個直轄市的區民代表公告（2022 年台中市和平區的公告找不到，沒登錄——該任務由臂的 EXISTS 判斷，提示不說「已附」）。
--   3. contribution_auto_tasks_district_seats 照 20261005004900 的現行定義做四處機械替換：①去掉「公報也寫著應選名額」，有登錄來源的任務指向 current.verification_sources、
--      沒登錄的（目前只有 2022 年台中市和平區）老實說「還沒登錄、要自己找」並保留公報線索；②加一句「公告上有幾區就交幾區、別只填 known_districts、名額加總對公告總額」；
--      ③hint_sources 換成可到達的網址與說明（同樣依有沒有登錄來源分岔）；④FROM 多一個 LATERAL EXISTS 判斷這個（屆別、選舉別、縣市）有沒有登錄來源，條件跟 TS 的 sourceMatches 同一組。
--      want／have／queued 條件、task_id、target、reward、region 一個字沒動（正式庫唯讀 10-08 parity：44 件任務逐件相同，只有 what_we_need 與 hint_sources 兩欄換字，scripts/district-seats-parity.ts）。
--   4. TS 端同一個 PR：SOURCE_TASK_TYPES 加 district_seats_missing、district_seats 驗證項附來源、交件骨架提醒補齊選舉區、skill.md 1.83.0。
--
-- 沒做（要維護者或另一個 PR）：由系統核對公告與交件的名額（09-24 名冊例外的精神）——評估見 docs/DECISIONS.md 同日條目；
-- 這一支 migration 不新增任何投票路徑、不改計分。

ALTER TABLE verification_sources ADD COLUMN IF NOT EXISTS election_ids INTEGER[];
COMMENT ON COLUMN verification_sources.election_ids IS '只適用哪幾屆（elections.id）；NULL＝每一屆都適用。選舉公告、登記彙總表這類每屆不同的來源要填（2026-10-08，#344）';

INSERT INTO verification_sources
  (name, kind, party, regions, election_types, election_ids, provides, list_url, detail_url_pattern, access, quality_note, how_to, last_checked, status, sort)
VALUES
  (
    '中選會 2026 直轄市議員、縣市議員選舉公告（應選名額表）', 'cec', NULL,
    ARRAY['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市', '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'],
    ARRAY['縣市議員'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/45d8e965-f63a-46d5-b636-7d81e47cf4d1.pdf', NULL, 'pdf',
    '中央選舉委員會 115/08/20 發布的選舉公告（中選務字第1153150253號，16 頁、文字可抽）。第 3 頁起是直轄市議員、縣（市）議員逐選舉區的表：選舉區、範圍（含平地原住民、山地原住民選舉區）、名額、應選出名額中應有婦女、競選經費最高金額。全國議員總額 919 名。公告頁：https://web.cec.gov.tw/central/article/63626',
    '打開 PDF 找這個縣市（直轄市議員與縣市議員是兩張表）的每一個選舉區，把「名額」欄逐區抄成 districts；範圍欄寫「平地原住民」「山地原住民」的是原住民選舉區，要加 kind（indigenous_plain、indigenous_mountain）。交件前把名額加總，要等於這個縣市的議員總額',
    '2026-10-08', 'ok', 2
  ),
  (
    '中選會 2026 直轄市議員政黨推薦候選人登記情形彙總表（應選名額欄）', 'cec', NULL,
    ARRAY['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市'],
    ARRAY['縣市議員'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/7a8eb38b-76c3-41c1-9d54-0dd55951a182.pdf', NULL, 'pdf',
    '中選會 115/09/07 製表，2 頁，六都每個選舉區一列，最後一欄「應選名額」（六都合計 61、68、65、65、57、65 席）。只印選舉區編號（例：臺北市第7選舉區），看不出是不是原住民選舉區——要對照選舉公告。拿來核對公告抄的名額與選舉區數量，不是名額的第一來源。頁面：https://web.cec.gov.tw/central/article/64709（檔案 2-2）',
    '抽字：pdftotext 要加 -enc UTF-8（不加中文會變空白），表是逐欄印的，用 PyMuPDF 一列一列抽比較好讀。每列：選舉區、各政黨推薦人數、小計、未經政黨推薦、合計、應選名額（最後一欄）。跟公告逐區對一次，不一致就以公告為準並在 note 寫出來',
    '2026-10-08', 'ok', 3
  ),
  (
    '中選會 2026 縣市議員政黨推薦候選人登記情形彙總表（應選名額欄）', 'cec', NULL,
    ARRAY['基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'],
    ARRAY['縣市議員'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/ee74ed96-d621-4ee2-b95f-32b6ff6a3d62.pdf', NULL, 'pdf',
    '中選會 115/09/07 製表，2 頁，其餘 16 縣市每個選舉區一列，最後一欄「應選名額」。只印選舉區編號，看不出是不是原住民選舉區——要對照選舉公告。拿來核對公告抄的名額與選舉區數量，不是名額的第一來源。六都加這 16 縣市共 221 個選舉區、應選名額合計 919 名，等於中選會 07/17 新聞稿的 919 名。頁面：https://web.cec.gov.tw/central/article/64709（檔案 4-2）',
    '抽字：pdftotext 要加 -enc UTF-8（不加中文會變空白），表是逐欄印的，用 PyMuPDF 一列一列抽比較好讀。每列：選舉區、各政黨推薦人數、小計、未經政黨推薦、合計、應選名額（最後一欄）。跟公告逐區對一次，不一致就以公告為準並在 note 寫出來',
    '2026-10-08', 'ok', 3
  ),
  (
    '中選會 2026 鄉鎮市長、鄉鎮市民代表、村里長選舉公告索引', 'cec', NULL,
    ARRAY['新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/central/article/63645', NULL, 'html',
    '鄉鎮市民代表、區民代表的選舉公告（附各選舉區應選名額）是各縣市選舉委員會在 115/08/20 發布的，不是中選會。中選會這一則把 22 縣市各自那則的連結列在一起（也有六都里長的公告）。縣市選委會自己網站的公告列表頁常回 500，從這一則點進去比較穩',
    '點你的縣市，進到該縣選委會那則公告，附件 PDF 就是選舉公告（網址 web.cec.gov.tw/api/file/<編號>.pdf）。抽出來是文字的直接讀；掃描影像（新竹縣、苗栗縣、彰化縣、雲林縣、金門縣、連江縣的公告是影像）要看圖讀。也可以用 JSON：https://web.cec.gov.tw/api/<縣市代碼>/article/<文章編號> 回標題與附件 fileId',
    '2026-10-08', 'ok', 4
  ),
  (
    '中選會 2026 山地原住民區長、區民代表選舉公告索引', 'cec', NULL,
    ARRAY['新北市', '桃園市', '台中市', '高雄市'],
    ARRAY['直轄市山地原住民區民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/central/article/63645', NULL, 'html',
    '山地原住民區（新北市烏來、桃園市復興、台中市和平、高雄市桃源與那瑪夏與茂林）的區民代表選舉公告是各直轄市選委會在 115/08/20 發布的。中選會這一則把各縣市那則的連結列在一起',
    '點你的直轄市，進到那則公告，附件 PDF 就是選舉公告（附各選舉區應選名額）。台中市的連結指到列表頁，和平區那則是「公告臺中市和平區第4屆區長、區民代表選舉之選舉種類、名額、選舉區之劃分…」（https://web.cec.gov.tw/tcec/article/63665）',
    '2026-10-08', 'ok', 4
  ),
  (
    '新竹縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['新竹縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/95e4447d-91f2-4ce3-bfeb-b3e14ece1702.pdf', NULL, 'pdf',
    '新竹縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/hccec/article/64330）。掃描影像（11 頁），抽不出文字，要看圖讀。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '苗栗縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['苗栗縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/51eff624-907d-45ff-888b-543bb4b48f4b.pdf', NULL, 'pdf',
    '苗栗縣選舉委員會 115/08/20 發布的選舉公告。掃描影像（6 頁），抽不出文字，要看圖讀。這一份是鄉鎮市民代表專屬的公告（鄉鎮市長、村里長各有自己的）。列表頁 https://web.cec.gov.tw/mlec/article/list/11597。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '彰化縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['彰化縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/7e626607-abf6-42dc-9e38-1053d1c88f30.pdf', NULL, 'pdf',
    '彰化縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/chec/article/63474）。掃描影像（14 頁），抽不出文字，要看圖讀。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '南投縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['南投縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/da447c27-5c8b-462f-9956-6ec54111ebae.pdf', NULL, 'pdf',
    '南投縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/ntec/article/63600）。文字可抽（3 頁），標題「115年鄉(鎮、市)代表選舉應選名額及競選經費最高金額」，逐鄉鎮市列選舉區、範圍、名額。同一則公告頁還有鄉鎮市長、村里長的名額表與公告本文。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '雲林縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['雲林縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/9b57bb77-196b-4d3e-a391-b35b88b760cb.pdf', NULL, 'pdf',
    '雲林縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/ylec/article/63592）。掃描影像（20 頁），抽不出文字，要看圖讀。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '嘉義縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['嘉義縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/c6324790-b459-4705-8e26-629268312bac.pdf', NULL, 'pdf',
    '嘉義縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/cycec/article/63454）。文字可抽（附件 10 頁）：「嘉縣選一字第1153150091號公告附件」逐鄉鎮市列選舉區與名額；同則另有公告本文 16d0bccc-1a40-40dc-b98b-29f0a26b6197（1 頁）。列表頁 https://web.cec.gov.tw/cycec/article/list/11278。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '屏東縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['屏東縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/e0db1834-e57d-4d53-ac7d-48fc0a1b48ab.pdf', NULL, 'pdf',
    '屏東縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/ptec/article/63494）。文字可抽（29 頁，另有蓋印信的掃描版）。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '宜蘭縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['宜蘭縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/67a7d49e-f572-4301-9c2b-3168c8101437.pdf', NULL, 'pdf',
    '宜蘭縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/ilec/article/63595）。文字可抽（8 頁）。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '花蓮縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['花蓮縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/aefaf420-c08a-47c8-a0d4-7dda529b168b.pdf', NULL, 'pdf',
    '花蓮縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/hlec/article/63588）。文字可抽（10 頁，檔名「1150820選舉公告(選舉種類名額經費等)」；另有蓋關防的掃描版）。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '台東縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['台東縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/715772a7-6820-4bdb-8a57-36e5e6fd13a3.pdf', NULL, 'pdf',
    '台東縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/ttec/article/63667）。文字可抽（10 頁）。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '澎湖縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['澎湖縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/62db7bd0-2057-449a-ac2c-a20d7707fd31.pdf', NULL, 'pdf',
    '澎湖縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/phec/article/63659）。文字可抽（6 頁，「澎選一字第1153150048號公告」；另有蓋印的掃描版）。涵蓋鄉市長、鄉市民代表、村里長，找鄉市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '金門縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['金門縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/0f970ac6-9b3e-41d2-b454-ff75c5d4051b.pdf', NULL, 'pdf',
    '金門縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/kmec/article/63578）。掃描影像（3 頁），抽不出文字，要看圖讀。涵蓋鄉鎮長、鄉鎮民代表、村里長，找鄉鎮民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '連江縣選委會 2026 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['連江縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/817b1365-7cda-4a7a-bf8b-327208996220.pdf', NULL, 'pdf',
    '連江縣選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/lcec/article/63623）。掃描影像（3 頁），抽不出文字，要看圖讀。涵蓋鄉長、鄉民代表、村長，找鄉民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額',
    '2026-10-08', 'ok', 4
  ),
  (
    '新北市選委會 2026 山地原住民區民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['新北市'],
    ARRAY['直轄市山地原住民區民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/c4b572bd-102f-4e02-8870-407aa22ba63d.pdf', NULL, 'pdf',
    '新北市選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/tpcec/article/63525）：烏來區第4屆區長、區民代表及新北市第5屆里長選舉的公告。文字可抽（13 頁，「各選舉區候選人競選經費最高金額一覽表(公告版)」，第 1 頁就是烏來區民代表各選舉區的範圍與應選名額；同則的公告本文 c886f25e-b021-4c98-8f9a-527e053e4549 只有 1 頁、名額在這份附件）。逐選舉區列名額',
    '找區民代表的部分，把每個選舉區的「名額」欄抄成 districts（{district: "<區>第01選舉區", seats: N}）；區長一席、不用交',
    '2026-10-08', 'ok', 4
  ),
  (
    '桃園市選委會 2026 山地原住民區民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['桃園市'],
    ARRAY['直轄市山地原住民區民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/d112386a-2394-40e9-86e3-03c6b814d5ad.pdf', NULL, 'pdf',
    '桃園市選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/tyec/article/63516）：復興區第4屆區長、區民代表及桃園市第4屆里長選舉的公告。文字可抽（8 頁，標「網站」版；另有蓋關防的掃描版）。逐選舉區列名額',
    '找區民代表的部分，把每個選舉區的「名額」欄抄成 districts（{district: "<區>第01選舉區", seats: N}）；區長一席、不用交',
    '2026-10-08', 'ok', 4
  ),
  (
    '台中市選委會 2026 山地原住民區民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['台中市'],
    ARRAY['直轄市山地原住民區民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/85cdcbba-7dd8-4e65-8e74-cd2dadb40101.pdf', NULL, 'pdf',
    '台中市選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/tcec/article/63665）：和平區第4屆區長、區民代表選舉的公告。文字可抽（1 頁，區民代表三個選舉區的名額寫在公告事項二）。逐選舉區列名額',
    '找區民代表的部分，把每個選舉區的「名額」欄抄成 districts（{district: "<區>第01選舉區", seats: N}）；區長一席、不用交',
    '2026-10-08', 'ok', 4
  ),
  (
    '高雄市選委會 2026 山地原住民區民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['高雄市'],
    ARRAY['直轄市山地原住民區民代表'],
    ARRAY[2026],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/2b74648e-c9a7-4094-99c2-712a610dbb78.pdf', NULL, 'pdf',
    '高雄市選舉委員會 115/08/20 發布的選舉公告（公告頁 https://web.cec.gov.tw/khec/article/63599）：桃源區、那瑪夏區、茂林區第4屆區長、區民代表及高雄市第5屆里長選舉的公告。掃描影像（12 頁），抽不出文字，要看圖讀。逐選舉區列名額',
    '找區民代表的部分，把每個選舉區的「名額」欄抄成 districts（{district: "<區>第01選舉區", seats: N}）；區長一席、不用交',
    '2026-10-08', 'ok', 4
  ),
  (
    '中選會 2022 直轄市議員、縣市議員選舉公告（應選名額表）', 'cec', NULL,
    ARRAY['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市', '基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'],
    ARRAY['縣市議員'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/72529fa8-25c6-4260-bcbc-7de268017766.pdf', NULL, 'pdf',
    '中央選舉委員會 111/08/18 發布的選舉公告（中選務字第1113150255號，15 頁、文字可抽）。第 3 頁起是直轄市議員、縣（市）議員逐選舉區的表：選舉區、範圍（含「臺北市之平地原住民」「臺北市之山地原住民」這類原住民選舉區）、名額、應選出名額中應有婦女、競選經費最高金額。公告頁：https://web.cec.gov.tw/central/article/45849',
    '打開 PDF 找這個縣市的每一個選舉區，把「名額」欄逐區抄成 districts；範圍欄寫平地原住民、山地原住民的要加 kind（indigenous_plain、indigenous_mountain）。我們目前記的 2022 議員選舉區只有一般選舉區，原住民選舉區要照公告補上。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 3
  ),
  (
    '新竹縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['新竹縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/15e9d416-4b30-493b-9358-d38ad76e6414.pdf', NULL, 'pdf',
    '新竹縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/hccec/article/35685）。掃描影像（11 頁），抽不出文字，要看圖讀。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '苗栗縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['苗栗縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/91e344e1-caa9-4d09-803f-d8167d5f8f4a.pdf', NULL, 'pdf',
    '苗栗縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/mlec/article/35688）。掃描影像（5 頁），抽不出文字，要看圖讀。這一份是第22屆鄉鎮市民代表專屬的公告（同則還有鄉鎮市長、村里長各一份）。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '彰化縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['彰化縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/a3fa65a4-add5-4afa-a55a-9b4273fdbe57.pdf', NULL, 'pdf',
    '彰化縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/chec/article/35620）。文字可抽（16 頁；另有蓋印的掃描版）。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '南投縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['南投縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/113c26cc-3f49-41c6-ae64-98bc2b31fd7c.pdf', NULL, 'pdf',
    '南投縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/ntec/article/39724）。文字可抽（3 頁，「111年鄉(鎮、市)民代表選舉應選名額及競選經費最高金額」）。同一則公告頁還有鄉鎮市長、村里長的名額表與公告本文。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '雲林縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['雲林縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/0a7e6a6a-e3c9-4e8d-92fe-1b642ed7325e.pdf', NULL, 'pdf',
    '雲林縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/ylec/article/35704）。掃描影像（20 頁），抽不出文字，要看圖讀。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '嘉義縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['嘉義縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/f8dfafe3-6dcc-4fd9-9ac8-fd968d1b88a6.pdf', NULL, 'pdf',
    '嘉義縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/cycec/article/35567）。10 頁，大多是影像、文字很少，要看圖讀。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '屏東縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['屏東縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/6c7a1bcd-11d0-43a9-ba04-3885638cd284.pdf', NULL, 'pdf',
    '屏東縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/ptec/article/35657）。文字可抽（22 頁，檔名「3.111年屏東縣鄉鎮市長代表村(里)長選舉公告」，含各鄉鎮市民代表選舉區與名額；同則的公告本文 12ef0065-02ae-4c29-92cb-284fbdebd621 只有 1 頁）。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '宜蘭縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['宜蘭縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/2513f5b4-2b1a-483e-bcd6-076835299b38.pdf', NULL, 'pdf',
    '宜蘭縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/ilec/article/35654）。文字可抽（3 頁，「111年第22屆鄉鎮市民代表選舉其選舉區劃分、應選名額及競選經費最高金額一覽表」）。同一則公告頁還有鄉鎮市長、村里長的一覽表與公告本文。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '花蓮縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['花蓮縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/b394a6f1-fb66-42a5-ba4d-4ecd4589b414.pdf', NULL, 'pdf',
    '花蓮縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/hlec/article/35659）。文字可抽（10 頁；另有蓋關防的掃描版）。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '台東縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['台東縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/70438e6f-b66a-4fa2-a649-c2573ca37f3c.pdf', NULL, 'pdf',
    '台東縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/ttec/article/35626）。文字可抽（10 頁）。涵蓋鄉鎮市長、鄉鎮市民代表、村里長，找鄉鎮市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '澎湖縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['澎湖縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/51e2b8a4-bef8-42d6-b6e1-7c1beb007cb3.pdf', NULL, 'pdf',
    '澎湖縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/phec/article/63020）。文字可抽（6 頁；另有蓋印的掃描版）。涵蓋鄉市長、鄉市民代表、村里長，找鄉市民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '金門縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['金門縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/b1193843-d37d-4077-9631-88a6bffd4fca.pdf', NULL, 'pdf',
    '金門縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/kmec/article/35650）。文字可抽（3 頁）。涵蓋鄉鎮長、鄉鎮民代表、村里長，找鄉鎮民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '連江縣選委會 2022 鄉鎮市民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['連江縣'],
    ARRAY['鄉鎮市民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/7bbd070f-a572-408e-8741-362802d2a1af.pdf', NULL, 'pdf',
    '連江縣選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/lcec/article/35723）。掃描影像（4 頁），抽不出文字，要看圖讀。涵蓋鄉長、鄉民代表、村長，找鄉民代表的部分。只有一個選舉區的鄉鎮市，選舉區寫「<鄉鎮市>選舉區」',
    '找「鄉（鎮、市）民代表」的部分，逐鄉鎮市把每個選舉區的「名額」欄抄成 districts（{district: "<鄉鎮市>第01選舉區", seats: N}）；公告的候選人登記須知等其他附件沒有名額。名額加總要對得上公告的鄉鎮市民代表總額。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '新北市選委會 2022 山地原住民區民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['新北市'],
    ARRAY['直轄市山地原住民區民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/4191f811-24af-4ccd-837e-12317a96de9f.pdf', NULL, 'pdf',
    '新北市選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/tpcec/article/35560）：烏來區第3屆區長、區民代表及新北市第4屆里長選舉的公告。文字可抽（14 頁），烏來區區長、區民代表與新北市里長各選舉區的名額與經費。逐選舉區列名額',
    '找區民代表的部分，把每個選舉區的「名額」欄抄成 districts（{district: "<區>第01選舉區", seats: N}）；區長一席、不用交。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '桃園市選委會 2022 山地原住民區民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['桃園市'],
    ARRAY['直轄市山地原住民區民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/b3f41902-9a46-40f0-b04c-6597f722b42a.pdf', NULL, 'pdf',
    '桃園市選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/tyec/article/35666）：復興區第3屆區長、區民代表及桃園市第3屆里長選舉的公告。文字可抽（8 頁，標「網站」版）。逐選舉區列名額',
    '找區民代表的部分，把每個選舉區的「名額」欄抄成 districts（{district: "<區>第01選舉區", seats: N}）；區長一席、不用交。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  ),
  (
    '高雄市選委會 2022 山地原住民區民代表選舉公告（應選名額）', 'cec', NULL,
    ARRAY['高雄市'],
    ARRAY['直轄市山地原住民區民代表'],
    ARRAY[2022],
    ARRAY['seats'],
    'https://web.cec.gov.tw/api/file/54ac4da6-4647-4f9c-b6ed-d8121411cd34.pdf', NULL, 'pdf',
    '高雄市選舉委員會 111 年發布的選舉公告（公告頁 https://web.cec.gov.tw/khec/article/35662）：桃源區、那瑪夏區、茂林區第3屆區長、區民代表及高雄市第4屆里長選舉的公告。文字可抽（11 頁，高市選一字第1113150116號）。逐選舉區列名額',
    '找區民代表的部分，把每個選舉區的「名額」欄抄成 districts（{district: "<區>第01選舉區", seats: N}）；區長一席、不用交。web.cec.gov.tw 回網頁而不是 PDF 時，改用 www.cec.gov.tw 的同一路徑（2026-10-09 實測 web 主機對 2022 年的檔案曾回網頁）',
    '2026-10-08', 'ok', 4
  )
ON CONFLICT (name) DO NOTHING;

-- ── 派工臂：20261005004900 的現行定義＋三處機械替換（說明在檔頭） ──────────────────
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
   WHERE (h.districts IS NULL OR h.with_seats < h.districts)
     AND NOT EXISTS (SELECT 1 FROM queued q
                      WHERE q.election_id = w.election_id::TEXT AND q.election_type = w.election_type AND q.region = w.county)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_district_seats IS
  '應選名額缺口：議員、代表各選舉區的名額（#344，2026-10-06）。一個縣市一種選舉一件，代理照選舉公告交 district_seats。'
  '2026-10-08：提示改成指向 current.verification_sources（各屆各縣市的選舉公告 PDF），並要求公告上有幾區交幾區；條件與輸出欄位不變。';

NOTIFY pgrst, 'reload schema';
