-- 查證來源加一列：READr 政見總覽（whoareyou.readr.tw）（維護者 2026-10-01 核准）
--
-- 抽 8 筆政見缺漏的「查無」，代理多半只看中選會、議會官網、中央社、自由時報；另一隻代理用搜尋引擎找到 READr 政見總覽。
-- 2026-10-01 實測：首頁導到 /2024（2024 總統立委）；/2022 是 2022 地方選舉總覽；/2026 回 404（還沒有 2026 總覽）。
-- 個人頁 /politics/<數字> 依選舉列出此人歷次政見（2014～2024，含縣市長、縣市議員、村里長等），每條政見另有
-- /politics/detail/<數字> 頁；政見文字在伺服器回的 HTML（__NEXT_DATA__）裡，不用跑 JS。站內沒有可用的搜尋網址，
-- 要用搜尋引擎找個人頁。

INSERT INTO verification_sources
  (name, kind, party, regions, election_types, provides, list_url, detail_url_pattern, access, quality_note, how_to, last_checked, status, sort)
VALUES
  (
    'READr 政見總覽（政見不失憶）', 'media', NULL, NULL,
    ARRAY['縣市長', '縣市議員', '立法委員', '總統副總統', '鄉鎮市長', '村里長'],
    ARRAY['policy'],
    'https://whoareyou.readr.tw/2022',
    'https://whoareyou.readr.tw/politics/<數字>',
    'html',
    'READr 與多家媒體協作整理的政見資料庫，2014～2024 各級選舉；2026-10-01 時還沒有 2026 總覽頁（/2026 回 404）。現任者上一屆（2022）的承諾查得到，可以照政見缺漏任務的規則交（election_id 填 2022、note 說明）。政見多附原始出處，引用時優先附原始出處，READr 頁可當第二來源',
    '用搜尋引擎搜「site:whoareyou.readr.tw 姓名」或「姓名 政見總覽 READr」，打開個人頁 whoareyou.readr.tw/politics/<數字>，頁面依選舉列出此人歷次政見；單條政見在 /politics/detail/<數字>。站內沒有搜尋網址，不要自己拼',
    '2026-10-01', 'ok', 30
  )
ON CONFLICT (name) DO NOTHING;
