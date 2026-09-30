-- 查證來源清單（維護者 2026-09-28 核准）。
--
-- 起因：代理常常只查中央社、自由時報首頁就回「查無」，不知道政黨官網、議會官網
-- 上其實有候選人照片、學經歷、選區、政見。把這些來源存成資料表：
--   1. /sources 端點與網頁把清單攤給人看、也給代理讀（GET /functions/v1/sources?format=md）
--   2. /next 依任務對象（政黨、縣市、選舉別、要查什麼）自動把對的網址附進 current.verification_sources
-- 以後加來源只改這張表，不動協議、不動端點程式碼。

CREATE TABLE IF NOT EXISTS verification_sources (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL CHECK (kind IN ('party', 'council', 'government', 'cec', 'media')),
  party              TEXT,               -- 政黨全名；null＝不分政黨
  regions            TEXT[],             -- 縣市清單；null＝全國
  election_types     TEXT[],             -- 我們的九種選舉別字串；null＝全部
  provides           TEXT[] NOT NULL,    -- photo/education/experience/district/policy/birth_year/candidacy/roster
  list_url           TEXT,
  detail_url_pattern TEXT,               -- 個人頁網址格式，含 <佔位符>
  access             TEXT NOT NULL CHECK (access IN ('html', 'js', 'json', 'pdf')),
  quality_note       TEXT,               -- 給人看的品質說明（例：照片尺寸、政見格式）
  how_to             TEXT,               -- 給代理看的一兩句「怎麼查」
  last_checked       DATE,
  status             TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'down')),
  sort               INTEGER NOT NULL DEFAULT 100,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE verification_sources IS '查證來源清單（政黨／議會／政府／中選會／媒體官網），依任務對象自動附上，見 docs/DECISIONS.md 2026-09-28';
CREATE INDEX IF NOT EXISTS verification_sources_kind_idx ON verification_sources (kind);
CREATE INDEX IF NOT EXISTS verification_sources_party_idx ON verification_sources (party);

ALTER TABLE verification_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON verification_sources;
CREATE POLICY "Public read" ON verification_sources FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON verification_sources;
CREATE POLICY "Service role write" ON verification_sources FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 種子資料：以下網址與欄位皆已於 2026-09-28 人工驗證過。
INSERT INTO verification_sources
  (name, kind, party, regions, election_types, provides, list_url, detail_url_pattern, access, quality_note, how_to, last_checked, status, sort)
VALUES
  (
    '台灣民眾黨 2026 候選人頁', 'party', '台灣民眾黨', NULL,
    ARRAY['縣市長', '縣市議員', '鄉鎮市長', '鄉鎮市民代表'],
    ARRAY['photo', 'education', 'experience', 'district', 'policy'],
    'https://www.tpp.org.tw/election2026/candidates.php?tab=councilor',
    'https://www.tpp.org.tw/election2026/candidatedetail.php?cid=<數字>',
    'html',
    '列表頁另有 tab=mayor（僅嘉義市有候選人）、tab=town；照片為 640×874 直式 PNG（https://www.tpp.org.tw/aimg/a/26/<3碼>/<雜湊>.png）；個人政見多為標題＋說明段落；無出生年欄位',
    '從列表頁（依 tab 切換縣市長／議員／鄉鎮市長代表）找到人物的 cid，打開 candidatedetail.php?cid=<數字> 看學經歷、選區（含鄉鎮）、政見',
    '2026-09-28', 'ok', 10
  ),
  (
    '台灣民眾黨共同政見', 'party', '台灣民眾黨', NULL, NULL,
    ARRAY['policy'],
    'https://www.tpp.org.tw/election2026/policy.php', NULL, 'html',
    '全黨共同政見，不是個別候選人專屬承諾，引用時要註明是黨版共同政見，不能當成該候選人的個人政見',
    '候選人個人頁找不到政見時可參考，但引用要標明「共同政見」',
    '2026-09-28', 'ok', 11
  ),
  (
    '民主進步黨縣市長候選人頁', 'party', '民主進步黨', NULL,
    ARRAY['縣市長'],
    ARRAY['photo', 'education', 'experience', 'policy'],
    'https://teamtaiwan.dpp.org.tw/', NULL, 'js',
    '資料在 https://teamtaiwan.dpp.org.tw/asset/types/election/js/script_mayor.js 的 mayor_data 陣列（是 JS 不是 HTML 正文，網頁本身抓不到）；照片路徑 img/mayor/aXX.jpg 相對於 asset/types/election/',
    '直接抓 script_mayor.js，從 mayor_data 陣列找該候選人的學歷、經歷、自介、社群、個人網站',
    '2026-09-28', 'ok', 20
  ),
  (
    '民主進步黨直轄市議員候選人頁', 'party', '民主進步黨',
    ARRAY['台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市'],
    ARRAY['縣市議員'],
    ARRAY['district'],
    'https://teamtaiwan.dpp.org.tw/councilor', NULL, 'html',
    '伺服器產生 HTML，用縣市篩選；每人只有姓名＋選區＋選區含哪些行政區（例「台北市 第02選區（內湖區、南港區）高嘉瑜」）；沒有個人頁、沒有照片學經歷；只涵蓋六都',
    '用縣市篩選找候選人姓名對應的選區',
    '2026-09-28', 'ok', 21
  ),
  (
    '民主進步黨縣市好政見', 'party', '民主進步黨', NULL,
    ARRAY['縣市長'],
    ARRAY['policy'],
    'https://teamtaiwan.dpp.org.tw/localpolicy', NULL, 'html',
    '縣市層級的政見主張',
    NULL,
    '2026-09-28', 'ok', 22
  ),
  (
    '台灣前進陣線候選人頁（時代力量）', 'party', '時代力量', NULL, NULL,
    ARRAY['photo', 'education', 'experience', 'district'],
    'https://newpowerparty.tw/vote2026',
    'https://newpowerparty.tw/vote2026/candidate-<數字>',
    'html',
    '台灣前進陣線（時代力量＋台灣基進＋綠黨＋歐巴桑聯盟）共用同一份候選人頁；純 HTML；300×300 方形照（wp-content/uploads/...-300x300.jpg）；無條列政見，只有口號＋相關新聞',
    '從列表頁找到候選人對應的 candidate-<數字> 個人頁',
    '2026-09-28', 'ok', 30
  ),
  (
    '台灣前進陣線候選人頁（台灣基進）', 'party', '台灣基進', NULL, NULL,
    ARRAY['photo', 'education', 'experience', 'district'],
    'https://newpowerparty.tw/vote2026',
    'https://newpowerparty.tw/vote2026/candidate-<數字>',
    'html',
    '與時代力量同一份候選人頁（台灣前進陣線共用名單）；純 HTML；300×300 方形照；無條列政見，只有口號＋相關新聞',
    '從列表頁找到候選人對應的 candidate-<數字> 個人頁',
    '2026-09-28', 'ok', 31
  ),
  (
    '台灣綠黨 2026 候選人介紹', 'party', '台灣綠黨', NULL, NULL,
    ARRAY['photo', 'education', 'experience', 'policy'],
    'https://greenparty.org.tw/posts/news/2026candidate', NULL, 'html',
    '單頁列出 5 位候選人，用 h2 錨點分段；有完整段落政見與宣傳照',
    '在頁面內用候選人姓名找到對應的 h2 段落',
    '2026-09-28', 'ok', 40
  ),
  (
    '中選會候選人登記名冊（各縣市選委會公告附件）', 'cec', NULL, NULL, NULL,
    ARRAY['candidacy', 'district', 'roster'],
    NULL,
    'https://web.cec.gov.tw/api/file/<uuid>.pdf',
    'pdf',
    '各縣市選委會登記公告的附件 PDF，名冊逐欄印，姓名不在公告頁面本身',
    '照 skill.md 9a 讀名冊：逐欄各抓成清單再核對長度相等，不要用 pdftotext -layout（會錯配）',
    '2026-09-28', 'ok', 50
  ),
  (
    '中選會候選人資料庫 API', 'cec', NULL, NULL, NULL,
    ARRAY['birth_year', 'candidacy'],
    NULL,
    'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=<姓名>',
    'json',
    '只有已投票的選舉；查得到歷屆參選、出生年、政黨；查不到不代表本屆沒登記（登記期資料不在裡面）',
    '用姓名查詢，先以出生年收斂同名者，再看是否與這次提交相容',
    '2026-09-28', 'ok', 51
  ),
  (
    '內政部地方公職人員資訊', 'government', NULL, NULL, NULL,
    ARRAY['photo', 'education', 'experience', 'birth_year'],
    'https://www.moi.gov.tw/LocalOfficial_Content.aspx', NULL, 'html',
    '僅現任地方公職；我們的 moi_officials 表已從這裡每天同步',
    '優先查 moi_officials（moi_official_for RPC），需要看原始頁面再打開這個網址核對',
    '2026-09-28', 'ok', 60
  ),
  -- 22 個縣市議會官網（2026-09-28 逐一實際驗證；取代原本的議會通則，通則留在最後當 fallback）
  (
    '台北市議會議員介紹', 'council', NULL, ARRAY['台北市'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'birth_year', 'policy', 'photo'],
    'https://www.tcc.gov.tw/cp.aspx?n=13898',
    'https://www.tcc.gov.tw/Councilor_Content.aspx?n=13898&s=<id>',
    'html',
    '選區含行政區、學歷、經歷、出生年（到日）、政見條列具體、黨籍；照片約 178×198，畫質偏低',
    '從列表頁找到議員的 s 參數，打開個人頁核對',
    '2026-09-28', 'ok', 71
  ),
  (
    '新北市議會議員介紹', 'council', NULL, ARRAY['新北市'], ARRAY['縣市議員'],
    ARRAY['district', 'experience', 'policy', 'photo'],
    'https://www.ntp.gov.tw/councilor-all?program=37',
    'https://www.ntp.gov.tw/councilor-detail?program=37&A=<選區>&C=<id>',
    'html',
    '選區、經歷、政見具體、黨籍；學歷多缺；照片為直式原圖',
    '從列表頁依選區找到議員的 C 參數',
    '2026-09-28', 'ok', 72
  ),
  (
    '桃園市議會議員介紹', 'council', NULL, ARRAY['桃園市'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'policy', 'photo'],
    'https://www.tycc.gov.tw/tc/councilor-info.aspx?mid=39',
    'https://www.tycc.gov.tw/tc/councilor-detail.aspx?mid=39&num=<id>',
    'html',
    '選區含行政區、學經歷、政見極具體；照片 459×606，畫質佳',
    NULL,
    '2026-09-28', 'ok', 73
  ),
  (
    '台中市議會議員介紹', 'council', NULL, ARRAY['台中市'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'policy', 'photo'],
    'https://www.tccc.gov.tw/main.asp?uno=14',
    'https://www.tccc.gov.tw/main.asp?uno=14&cno=<id>',
    'html',
    '首頁議員一覽是 frameset，多層 iframe；個人頁實際內容在 iframe wb_introduction02.asp?cno=<id>（https://www.tccc.gov.tw/wb_introduction02.asp?cno=<id>），抓內容要抓這支不是外層 main.asp；選區、學經歷、政見詳細；照片（ConnThumb）200×259',
    '打不到內容時改抓 iframe 那支網址',
    '2026-09-28', 'ok', 74
  ),
  (
    '台南市議會議員介紹', 'council', NULL, ARRAY['台南市'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'policy', 'photo'],
    'https://www.tncc.gov.tw/subhome.asp',
    'https://www.tncc.gov.tw/councilorpage.asp?mainid=<guid>',
    'html',
    '列表頁依選區分頁；選區、學經歷、政見非常詳細；照片 995×1200，各議會中最佳',
    NULL,
    '2026-09-28', 'ok', 75
  ),
  (
    '高雄市議會議員介紹', 'council', NULL, ARRAY['高雄市'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'policy', 'photo'],
    'https://www.kcc.gov.tw/Member_List1.aspx?n=39&sms=9028',
    'https://www.kcc.gov.tw/MemberInfo_New.aspx?n=39&sms=9028&msn=<id>',
    'html',
    '列表頁分 1～3 頁；學經歷、服務政見、政黨；個人頁本身沒有選區，要看列表分區歸屬；照片 501×636，畫質佳',
    NULL,
    '2026-09-28', 'ok', 76
  ),
  (
    '基隆市議會議員介紹', 'council', NULL, ARRAY['基隆市'], ARRAY['縣市議員'],
    ARRAY['district', 'experience', 'policy', 'photo'],
    'https://www.kmc.gov.tw/index.php/mac/mi',
    'https://www.kmc.gov.tw/index.php/mac/mi/<區碼>/<id>-<碼>-<序>',
    'html',
    '選區、經歷、政見——政見品質是各議會中最好之一；無學歷；照片約 200×280',
    NULL,
    '2026-09-28', 'ok', 77
  ),
  (
    '新竹市議會議員介紹', 'council', NULL, ARRAY['新竹市'], ARRAY['縣市議員'],
    ARRAY['district', 'policy', 'photo'],
    'https://www.hsinchu-cc.gov.tw/tc/councilors.aspx?mid=39',
    'https://www.hsinchu-cc.gov.tw/tc/councilor.aspx?mid=39&c=<id>',
    'html',
    '選區、政見具體；無學經歷、無出生年；照片 961×1080，高畫質',
    NULL,
    '2026-09-28', 'ok', 78
  ),
  (
    '新竹縣議會議員介紹', 'council', NULL, ARRAY['新竹縣'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'policy'],
    'https://www.hcc.gov.tw/member?program=190',
    'https://www.hcc.gov.tw/member-detail?program=190&S=<選區>&C=<id>',
    'html',
    '選區含鄉鎮、學經歷、政見',
    NULL,
    '2026-09-28', 'ok', 79
  ),
  (
    '苗栗縣議會議員介紹', 'council', NULL, ARRAY['苗栗縣'], ARRAY['縣市議員'],
    ARRAY['photo'],
    'https://www.mcc.gov.tw/iframimgtxt_list.php?typeid=2580&typeid2=<選區碼>',
    NULL,
    'html',
    '幾乎無資料：沒有個人頁，只有姓名、服務處、小張照片；頁面 Big5 編碼',
    '這個來源查不到學經歷政見是正常的，不要因為這頁沒有就判斷「查無」，改查其他來源',
    '2026-09-28', 'ok', 80
  ),
  (
    '嘉義市議會議員介紹', 'council', NULL, ARRAY['嘉義市'], ARRAY['縣市議員'],
    ARRAY['education', 'experience', 'photo'],
    'https://www.cycc.gov.tw/listUnitStaff.aspx?c0=3716',
    'https://www.cycc.gov.tw/Default2.aspx?c0=3716&p0=<id>',
    'html',
    '學經歷；無政見、無黨籍欄位；照片偏小',
    NULL,
    '2026-09-28', 'ok', 81
  ),
  (
    '彰化縣議會議員介紹', 'council', NULL, ARRAY['彰化縣'], ARRAY['縣市議員'],
    ARRAY['district', 'birth_year', 'experience', 'policy', 'photo'],
    'https://www.chcc.gov.tw/member/index.aspx?Parser=99,6,40',
    'https://www.chcc.gov.tw/member/details.aspx?Parser=99,6,40,,,,<id>',
    'html',
    '選區、出生年（精確到日）、經歷、政見另有子頁、黨籍；照片偏小',
    NULL,
    '2026-09-28', 'ok', 82
  ),
  (
    '南投縣議會議員介紹', 'council', NULL, ARRAY['南投縣'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'photo'],
    'https://www.ntcc.gov.tw/tw/rep/index.aspx',
    'https://www.ntcc.gov.tw/tw/rep/p02.aspx?district=<N>&period=20',
    'html',
    '同一選區多人共用一頁，要在頁面內找姓名；選區含鄉鎮、學經歷、黨籍；無政見；照片 140×170',
    NULL,
    '2026-09-28', 'ok', 83
  ),
  (
    '雲林縣議會議員介紹', 'council', NULL, ARRAY['雲林縣'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'photo'],
    'https://www.ylcc.gov.tw/cp.aspx?n=22126',
    'https://www.ylcc.gov.tw/Congress_Detail.aspx?n=22127&sms=21659&s=<id>',
    'html',
    '缺 s= 參數會顯示空白頁；選區、學經歷、黨籍；無政見；照片 349×463',
    NULL,
    '2026-09-28', 'ok', 84
  ),
  (
    '嘉義縣議會議員介紹', 'council', NULL, ARRAY['嘉義縣'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience'],
    'https://www.cyscc.gov.tw/Parliamentary_index/315',
    'https://www.cyscc.gov.tw/Parliamentary_Content/315/<id>',
    'html',
    '讀法待覆核：調查結果矛盾，一說內容是 JS 渲染、一說資料內嵌在 script 的 JSON 裡，實際能不能純抓 HTML 拿到內容還不確定',
    '先當一般 HTML 試抓；抓不到正文再試著找頁面內嵌的 script JSON',
    '2026-09-28', 'ok', 85
  ),
  (
    '屏東縣議會議員介紹', 'council', NULL, ARRAY['屏東縣'], ARRAY['縣市議員'],
    ARRAY['birth_year', 'policy'],
    'https://www.ptcc.gov.tw/',
    'https://www.ptcc.gov.tw/?Page=PersionalDetail&Guid=<guid>',
    'html',
    '個人頁定位方式待覆核（如何從列表找到每人的 Guid 還沒確認）；舊式網頁；出生年只到年、問政目標寫得具體',
    NULL,
    '2026-09-28', 'ok', 86
  ),
  (
    '宜蘭縣議會議員介紹', 'council', NULL, ARRAY['宜蘭縣'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'policy', 'photo'],
    'https://www.ilcc.gov.tw/',
    'https://www.ilcc.gov.tw/Html/H_05/H_0501.asp?pic=<id>&User_id=<code>',
    'html',
    'Big5 編碼＋frameset，沒有單一清單入口；選區、學經歷、政見；照片舊、解析度低',
    NULL,
    '2026-09-28', 'ok', 87
  ),
  (
    '花蓮縣議會議員介紹', 'council', NULL, ARRAY['花蓮縣'], ARRAY['縣市議員'],
    ARRAY['education', 'experience', 'photo'],
    'https://www.hlcc.gov.tw/councillor.php',
    'https://www.hlcc.gov.tw/councillor-data.php?index_no=<id>',
    'html',
    '學經歷、黨籍；無選區、無文字政見；照片 246×300',
    NULL,
    '2026-09-28', 'ok', 88
  ),
  (
    '台東縣議會議員介紹', 'council', NULL, ARRAY['台東縣'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'policy', 'photo'],
    'https://www.taitungcc.gov.tw/1/member',
    'https://www.taitungcc.gov.tw/api/member/<id>',
    'json',
    'JSON API：列表 GET /api/member?kind=<選區碼>、個人 GET /api/member/<id>；選區、學歷、經歷、政見極具體；黨籍代碼 1國民黨/2民進黨/3無黨籍/4親民黨/5民眾黨；照片約 250×314',
    '黨籍是數字代碼，對照 quality_note 換算成政黨名稱',
    '2026-09-28', 'ok', 89
  ),
  (
    '澎湖縣議會議員介紹', 'council', NULL, ARRAY['澎湖縣'], ARRAY['縣市議員'],
    ARRAY[]::TEXT[],
    'https://www.phcouncil.gov.tw/', NULL, 'html',
    '官網沒有議員簡介頁，幾乎無資料——這種情況改查中選會選舉公報，不要判定成「查無」就結案',
    '改查中選會選舉公報',
    '2026-09-28', 'ok', 90
  ),
  (
    '金門縣議會議員介紹', 'council', NULL, ARRAY['金門縣'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'experience', 'policy', 'photo'],
    'https://www.kmcc.gov.tw/8844/54357/55476/',
    'https://www.kmcc.gov.tw/8844/54357/55476/<id>/',
    'html',
    '選區含鄉鎮、學經歷、政見、黨籍；照片 496×595，畫質佳',
    NULL,
    '2026-09-28', 'ok', 91
  ),
  (
    '連江縣議會議員介紹', 'council', NULL, ARRAY['連江縣'], ARRAY['縣市議員'],
    ARRAY['district', 'education', 'birth_year', 'policy', 'photo'],
    'https://www.mtcc.gov.tw/ch/counciler_intro/7190',
    'https://www.mtcc.gov.tw/ch/counciler_intro/7190?clid=<id>',
    'html',
    '選區含鄉、學經歷、出生年（民國年）、政見、黨籍；照片是原圖，3744×5616',
    NULL,
    '2026-09-28', 'ok', 92
  ),
  (
    '各縣市議會官網議員介紹（通則，找不到對應縣市時用）', 'council', NULL, NULL, NULL,
    ARRAY['photo', 'education', 'experience', 'district', 'policy'],
    NULL, NULL, 'html',
    '上面 22 個縣市議會已經逐一列出；這筆是沒對到縣市時的備援說法',
    '現任議員多半是連任參選人，議會官網議員頁常有照片、學經歷、選區、政見',
    '2026-09-28', 'ok', 999
  )
ON CONFLICT (name) DO NOTHING;
