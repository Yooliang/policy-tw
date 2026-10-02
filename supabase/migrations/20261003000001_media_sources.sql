-- 查證來源加五列：四家媒體／一個中選會（維護者 2026-10-03 要求「媒體怎麼只有一間，找一下其他的」）
--
-- 全部於 2026-10-03 實際打開驗證（子代理逐一 WebFetch／curl）。沒驗證到的在 how_to 裡照實寫。
-- 查過但不收：自由時報 2026 專站（空頁）、中時 2026 專站（403）、TVBS 與中選會 vote2026（要跑 JS、伺服器 HTML 是空殼）、
-- 中央社／公視 2026 專區（只有新聞列表，沒有候選人結構）、聯合新聞網姓名 tag 頁（新聞聚合）、沃草／報導者／Yahoo（找不到候選人專區）。
--
-- 🔴 2026 的「政見」目前沒有任何來源：公辦政見發表會 11/13 起、選舉公報投票前 10 日才寄送（約 11 月中上架）。
--    現階段 2026 只拿得到名單、政黨、照片、年齡／出生日期、學經歷。別讓代理去空等或硬湊 2026 政見。

INSERT INTO verification_sources
  (name, kind, party, regions, election_types, provides, list_url, detail_url_pattern, access, quality_note, how_to, last_checked, status, sort)
VALUES
  (
    '聯合新聞網 2026 縣市長「選將點名」', 'media', NULL, NULL,
    ARRAY['縣市長'],
    ARRAY['photo', 'education', 'experience', 'candidacy'],
    'https://udn.com/vote2026/local_chiefs',
    'https://udn.com/vote2026/local_chiefs?city=<縣市英文代碼>',
    'html',
    '2026 縣市長參選人：姓名、政黨、年齡（歲，不是出生年，不能直接當 birth_year）、學經歷各約 2 條、照片（p.udn.com.tw/upf/news/2026/candidatephoto/…）。資料在伺服器回的 HTML 裡，不用跑 JS。一頁含該縣市全部參選人。沒有政見。',
    '縣市英文代碼（從該頁 HTML 原樣抄下）：taipei newtaipei taoyuan taichung tainan kaohsiung keelung hsinchucity hsinchucounty miaoli changhua nantou yunlin chiayicity chiayicounty pingtung yilan hualien taitung penghu kinmen lienchiang。2026-10-03 只實測過 taipei，其餘 21 個代碼是頁面連結裡的、未逐一打開。照片可當 photo 來源；學經歷交成 education[]／experience[] 一條一項。注意：這頁的代碼跟同站議員 JSON 的代碼不一樣，不能混用',
    '2026-10-03', 'ok', 31
  ),
  (
    '聯合新聞網 2026 縣市議員候選人（JSON）', 'media', NULL, NULL,
    ARRAY['縣市議員'],
    ARRAY['district', 'candidacy'],
    'https://udn.com/vote2026/ajax/candidate_member?city=tpc',
    'https://udn.com/vote2026/ajax/candidate_member?city=<縣市縮寫>',
    'json',
    '2026 縣市議員：選區名稱、選區包含哪些行政區、應選名額、該選區全部候選人姓名＋政黨（配套 https://udn.com/vote2026/ajax/district?city=<縮寫>）。沒有照片、學經歷、政見。同站的議員 HTML 頁（/vote2026/local_councilors）要跑 JS 才有內容，請直接打這支 JSON。',
    '🔴 帶錯代碼會回 HTTP 200 的空資料 {"city":"","area_list":[]}，不是錯誤——一定要檢查回應的 city 非空、area_list 不是空陣列才算查到，否則不要當成「這縣市沒有候選人」。縣市縮寫（2026-10-03 全部 22 個實測過、都有資料）：klc 基隆市、tpc 台北市、ntpc 新北市、tyh 桃園市、hct 新竹市、hch 新竹縣、mlh 苗栗縣、tcc 台中市、chh 彰化縣、ylh 雲林縣、ntc 南投縣、cic 嘉義市、cih 嘉義縣、tnh 台南市、khc 高雄市、pth 屏東縣、ilh 宜蘭縣、hlh 花蓮縣、tth 台東縣、phc 澎湖縣、kmc 金門縣、lcc 連江縣。容易錯的：桃園是 tyh、新竹市 hct／新竹縣 hch、嘉義市 cic／嘉義縣 cih。數字代碼（63、65、10017）一律回空',
    '2026-10-03', 'ok', 32
  ),
  (
    '中央社「22 縣市長登記參選名單一次看」（2026）', 'media', NULL, NULL,
    ARRAY['縣市長'],
    ARRAY['birth_year', 'education', 'experience', 'candidacy'],
    'https://www.cna.com.tw/news/aipl/202609045002.aspx',
    NULL,
    'html',
    '2026 縣市長登記截止後的單篇整理，22 縣市共 81 人：姓名、政黨、出生日期、學歷、主要經歷、現職。沒有號次、沒有政見、沒有照片。伺服器 HTML 直接讀得到全文。',
    '單篇文章，打開後在全文裡找姓名即可。出生日期可當 birth_year 的來源；學歷與經歷交成 education[]／experience[] 一條一項。這是登記截止（09-04）當時的名單，之後若有人退選或被撤銷登記，以中選會為準',
    '2026-10-03', 'ok', 33
  ),
  (
    '公視《政見說出來，其實我也有選！》（2022 縣市長）', 'media', NULL, NULL,
    ARRAY['縣市長'],
    ARRAY['policy'],
    'https://news.pts.org.tw/video-list/10',
    'https://news.pts.org.tw/video/<數字>',
    'html',
    '2022 年 22 縣市長每位候選人（含小黨、無黨籍）自錄約 2 分鐘的政見影片，附姓名與選區。是 2022 的，沒有 2026 版。內容是影片，要交政見時引用原始出處（候選人官網、選舉公報）較好，這裡可當第二來源。',
    '列表頁可讀到姓名與影片連結，沒有站內搜尋，要從列表頁找人。實測可開的影片頁例：/video/1655、/video/1567、/video/1210。現任縣市長補任期政見（term_policy_missing，election_id 2022）時可用',
    '2026-10-03', 'ok', 34
  ),
  (
    '中選會選舉公報（歷屆）', 'cec', NULL, NULL,
    ARRAY['總統副總統', '立法委員', '縣市長', '縣市議員'],
    ARRAY['policy', 'photo', 'education', 'experience'],
    'https://bulletin.cec.gov.tw/?dir=01選舉公報',
    NULL,
    'pdf',
    '每位候選人登記的政見原文、學歷、經歷、號次、照片都印在公報 PDF 上，是政見最完整的原始出處。年度最新到 111 年（2022）；2026（115 年）尚未上架，約投票前 10 日（11 月中）才會有。',
    '目錄式瀏覽：?dir= 參數要 URL 編碼，路徑含中文與民國年（111年＝2022、107年＝2018）。檔名用「臺」不是「台」（臺北市市長.pdf）。直轄市長的 PDF 直接在年度目錄下（01選舉公報/03直轄市長/111年/臺北市市長.pdf，2026-10-03 實測 200、3.4MB）；但縣市長與議員在年度下還有一層逐縣子目錄（例：04縣市長/111年/01宜蘭縣縣長），子目錄底下的 PDF 檔名沒驗證過——請先列目錄再取檔，不要猜檔名。PDF 網址本身就是 source_urls',
    '2026-10-03', 'ok', 6
  )
ON CONFLICT (name) DO NOTHING;
