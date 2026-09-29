-- 查證來源補上 2026 中選會候選人登記彙總表的實際網址（2026-09-29）
--
-- 苗栗縣議員那批 candidacy 一小時收到 28 張「無法判斷」：驗證者打不開 UDN（JS 動態載入），
-- 又以為「官方名冊 11/17 才公布」——其實 09/07 製表的登記彙總表早就在中選會網站上，
-- 原本那列「中選會候選人登記名冊」只有網址樣式、沒有網址，驗證者找不到。
-- 這兩份涵蓋全部 22 縣市議員（六都一份、其餘 16 縣市一份），名冊為準；11/17 公告的是號次。
INSERT INTO verification_sources
  (name, kind, party, regions, election_types, provides, list_url, detail_url_pattern, access, quality_note, how_to, last_checked, status, sort)
VALUES
  (
    '中選會 2026 直轄市議員候選人登記彙總表（六都）', 'cec', NULL,
    ARRAY['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市'],
    ARRAY['縣市議員'],
    ARRAY['candidacy', 'district', 'roster'],
    'https://web.cec.gov.tw/api/file/ccd7e51a-5fd0-4ea0-a81b-a120cd550c9c.pdf', NULL, 'pdf',
    '中選會 115/09/07 製表，六都全部登記候選人：選舉區、登記日期、姓名、推薦之政黨。登記期間已結束，這份就是登記名單；11/17 公告的是號次',
    '下載 PDF 找本人那一列，核對選舉區與推薦之政黨（「無」＝未經政黨推薦）。逐欄抓成清單再對，不要用 pdftotext -layout（會錯配）',
    '2026-09-29', 'ok', 5
  ),
  (
    '中選會 2026 縣市議員候選人登記彙總表（其餘 16 縣市）', 'cec', NULL,
    ARRAY['基隆市', '新竹市', '嘉義市', '新竹縣', '苗栗縣', '彰化縣', '南投縣', '雲林縣', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣'],
    ARRAY['縣市議員'],
    ARRAY['candidacy', 'district', 'roster'],
    'https://web.cec.gov.tw/api/file/729644ff-cb01-42bb-a052-c9b3c55a1289.pdf', NULL, 'pdf',
    '中選會 115/09/07 製表，六都以外 16 縣市全部登記候選人：選舉區、登記日期、姓名、推薦之政黨。登記期間已結束，這份就是登記名單；11/17 公告的是號次',
    '下載 PDF 找本人那一列，核對選舉區與推薦之政黨（「無」＝未經政黨推薦）。逐欄抓成清單再對，不要用 pdftotext -layout（會錯配）',
    '2026-09-29', 'ok', 5
  );
