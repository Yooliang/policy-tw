-- ============================================================
-- Seed Data: Categories & Locations
-- ============================================================

INSERT INTO categories (name) VALUES
  ('Urban Planning'),
  ('Welfare'),
  ('Traffic'),
  ('Economy'),
  ('Education'),
  ('Environment')
ON CONFLICT (name) DO NOTHING;

INSERT INTO locations (name) VALUES
  ('台北市'),
  ('新北市'),
  ('高雄市'),
  ('新竹市'),
  ('台中市'),
  ('台南市'),
  ('新竹縣')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- Elections
-- ============================================================

INSERT INTO elections (id, name, short_name, start_date, end_date, election_date) VALUES
  ('election-2026', '2026 九合一選舉', '2026 選舉專區', '2025-06-01', '2027-01-31', '2026-11-28');

INSERT INTO election_types (election_id, type) VALUES
  ('election-2026', '縣市長'),
  ('election-2026', '縣市議員'),
  ('election-2026', '鄉鎮市長'),
  ('election-2026', '直轄市山地原住民區長'),
  ('election-2026', '鄉鎮市民代表'),
  ('election-2026', '直轄市山地原住民區民代表'),
  ('election-2026', '村里長');

-- ============================================================
-- Politicians
-- ============================================================

INSERT INTO politicians (id, name, party, status, election_type, position, region, sub_region, avatar_url, slogan, bio, education, experience) VALUES
  ('c0',  '前任高雄市長', '國民黨', 'former',     '縣市長', '前高雄市長',             '高雄市', NULL,         'https://ui-avatars.com/api/?name=Han&background=0D8ABC&color=fff', NULL, '曾任高雄市長，推動路平專案與初期產業園區規劃。', NULL, NULL),
  ('c1',  '蔣萬安',       '國民黨', 'incumbent',  '縣市長', '台北市長',               '台北市', NULL,         'https://picsum.photos/200/200?random=1', '台北隊，出發！讓世界看見台北', '現任台北市長，致力於打造服務型政府，推動都更、交通與智慧城市建設。', ARRAY['美國賓州大學法學博士','國立政治大學外交學系'], ARRAY['第10屆立法委員','萬澤外國法事務律師事務所律師']),
  ('c2',  '侯友宜',       '國民黨', 'incumbent',  '縣市長', '新北市長',               '新北市', NULL,         'https://picsum.photos/200/200?random=2', '好好做事，團結共好', '警察出身，強調執行力與行政中立，推動新北 2030 願景工程。', ARRAY['中央警察大學犯罪防治研究所博士'], ARRAY['新北市副市長','內政部警政署署長','中央警察大學校長']),
  ('c3',  '陳其邁',       '民進黨', 'incumbent',  '縣市長', '高雄市長',               '高雄市', NULL,         'https://picsum.photos/200/200?random=3', '緊緊緊，兩年拚四年', '棄醫從政，致力於高雄產業轉型，引進半導體產業鏈與推動亞灣區發展。', ARRAY['國立台灣大學公共衛生碩士','中山醫學院醫學系'], ARRAY['行政院副院長','立法委員','總統府副秘書長']),
  ('c4',  '高虹安',       '民眾黨', 'incumbent',  '縣市長', '新竹市長',               '新竹市', NULL,         'https://picsum.photos/200/200?random=4', '新竹 UPGRADE，科技新未來', '科技背景出身，強調數據治理與科學決策，致力解決新竹交通與教育問題。', ARRAY['美國辛辛那提大學機械工程博士','國立台灣大學資訊工程碩士'], ARRAY['立法委員','鴻海集團工業大數據辦公室主任']),
  ('c5',  '王小明',       '民進黨', 'politician', '縣市長', '台北市長參選人',          '台北市', NULL,         'https://picsum.photos/200/200?random=5', '翻轉台北，居住正義', '長期關注居住正義與都市規劃的學者，主張大膽改革社宅政策與都市更新。', ARRAY['國立台灣大學建築與城鄉研究所博士'], ARRAY['居住正義聯盟 理事長','台北市都市計畫委員']),
  ('c6',  '林大華',       '無黨籍', 'politician', '縣市長', '新竹市長參選人',          '新竹市', NULL,         'https://picsum.photos/200/200?random=6', '超越藍綠，交通先行', '交通工程專家，無黨派包袱，承諾用專業解決竹科塞車問題。', ARRAY['國立交通大學交通運輸研究所碩士'], ARRAY['新竹科學園區 交通顧問','民間交通改革協會 發起人']),
  ('c7',  '張熱血',       '民眾黨', 'politician', '縣市議員', '台北市議員參選人',      '台北市', '中山大同區', 'https://ui-avatars.com/api/?name=Chang&background=0ea5e9&color=fff', '監督市政，絕不放水', '專注於交通改善與舊城區再生，強力監督市府預算執行。', ARRAY['國立政治大學公共行政碩士'], ARRAY['國會助理','社區發展協會 理事']),
  ('c8',  '陳在地',       '無黨籍', 'politician', '縣市議員', '新竹市議員參選人',      '新竹市', '東區',       'https://ui-avatars.com/api/?name=Chen&background=64748b&color=fff', '為了孩子，守護新竹', '全職媽媽參政，最懂親子需求，主打公園改造與教育資源分配。', ARRAY['國立清華大學社會學碩士'], ARRAY['家長會長','親子共學團 團長']),
  ('c9',  '李里長',       '無黨籍', 'politician', '村里長', '新竹市東區龍山里長參選人','新竹市', '東區龍山里', 'https://ui-avatars.com/api/?name=Li&background=f59e0b&color=fff', '路平燈亮水溝通，服務最貼心', '在地服務 20 年，最了解里民需求，隨叫隨到。', NULL, NULL),
  ('c10', '楊文科',       '國民黨', 'incumbent',  '縣市長', '新竹縣長',               '新竹縣', NULL,         'https://ui-avatars.com/api/?name=Yang&background=000095&color=fff', '科技首都，幸福竹縣', '現任新竹縣長，致力於AI智慧園區與交通建設。', NULL, NULL),
  ('c11', '鄭朝方',       '民進黨', 'incumbent',  '鄉鎮市長', '竹北市長',             '新竹縣', '竹北市',     'https://ui-avatars.com/api/?name=Cheng&background=1B9431&color=fff', '竹北進化，年輕活力', '現任竹北市長，推動公園改造與藝文活動。', NULL, NULL),
  ('c12', '林小市民',     '民眾黨', 'politician', '鄉鎮市民代表', '竹北市民代表參選人','新竹縣', '竹北市',     'https://ui-avatars.com/api/?name=Lin&background=28C7C7&color=fff', '監督公所，看緊荷包', NULL, NULL, NULL),
  ('c13', '張里長',       '無黨籍', 'politician', '村里長', '竹北市中興里長',          '新竹縣', '中興里',     'https://ui-avatars.com/api/?name=Chang&background=777&color=fff', '熱心服務，全年無休', NULL, NULL, NULL),
  ('c14', '林山水',       '無黨籍', 'politician', '直轄市山地原住民區長', '烏來區長參選人','新北市', '烏來區',  'https://ui-avatars.com/api/?name=Lin&background=059669&color=fff', '守護泰雅文化，發展生態觀光', '在地泰雅族人，致力於推動烏來溫泉與原民文化深度旅遊。', NULL, NULL),
  ('c15', '高勇士',       '無黨籍', 'politician', '直轄市山地原住民區民代表', '烏來區民代表參選人','新北市', '烏來區', 'https://ui-avatars.com/api/?name=Kao&background=0d9488&color=fff', '監督區政，為族人發聲', NULL, NULL, NULL),
  ('c16', '林議員',       '民進黨', 'incumbent',  '縣市議員', '高雄市議員',            '高雄市', '楠梓區',     'https://ui-avatars.com/api/?name=Lin&background=1B9431&color=fff', '嚴審預算，為民把關', '連任兩屆高雄市議員，長期關注產業發展與勞工權益。', NULL, NULL),
  ('c17', '陳區長',       '民進黨', 'incumbent',  '鄉鎮市長', '楠梓區長',             '高雄市', '楠梓區',     'https://ui-avatars.com/api/?name=Chen&background=0ea5e9&color=fff', '楠梓起飛，產業共榮', '現任楠梓區長，負責協調台積電設廠周邊基礎建設。', NULL, NULL),
  ('c18', '王里長',       '無黨籍', 'incumbent',  '村里長', '楠梓區援中里長',          '高雄市', '楠梓區援中里','https://ui-avatars.com/api/?name=Wang&background=f59e0b&color=fff', '守護家園，迎接發展', '在地里長，協助居民因應台積電設廠帶來的生活變化。', NULL, NULL);

-- ============================================================
-- Politician-Election relationships
-- ============================================================

INSERT INTO politician_elections (politician_id, election_id) VALUES
  ('c1',  'election-2026'),
  ('c4',  'election-2026'),
  ('c5',  'election-2026'),
  ('c6',  'election-2026'),
  ('c7',  'election-2026'),
  ('c8',  'election-2026'),
  ('c9',  'election-2026'),
  ('c10', 'election-2026'),
  ('c11', 'election-2026'),
  ('c12', 'election-2026'),
  ('c13', 'election-2026'),
  ('c14', 'election-2026'),
  ('c15', 'election-2026'),
  ('c16', 'election-2026'),
  ('c17', 'election-2026'),
  ('c18', 'election-2026');

-- ============================================================
-- Policies
-- ============================================================

INSERT INTO policies (id, politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, ai_analysis, support_count) VALUES
  ('p0',  'c0',  '和發產業園區規劃', '規劃南部產業用地，為製造業回流做準備。', 'Economy', 'Achieved', '2019-05-01', '2020-06-01', 100, ARRAY['產業','園區'], NULL, 0),
  ('p1',  'c1',  '台北大建設 - 都更加速', '推動公辦都更降門檻，加速台北市老舊公寓改建速度，落實居住正義。', 'Urban Planning', 'In Progress', '2022-11-01', '2024-05-15', 45, ARRAY['都更','居住正義'], 'AI 分析：目前法規修訂已通過一讀，但民眾整合意願仍是主要挑戰。預計 2024 下半年會有首批示範案動工。', 0),
  ('p2',  'c1',  '長照補助加碼', '台北市長照補助提高至每年 5 萬元，減輕家庭照顧者負擔。', 'Welfare', 'Achieved', '2022-10-15', '2023-12-01', 100, ARRAY['社福','老人照護'], 'AI 分析：預算已於 2023 年底全數通過並開始發放，民眾滿意度高，執行率達 98%。', 0),
  ('p3',  'c2',  '2030 新北願景', '以三軸心、三曲線為核心，串聯北北基桃生活圈，打造國際化大都會。', 'Urban Planning', 'In Progress', '2018-08-01', '2024-04-10', 60, ARRAY['區域發展','國際化'], NULL, 0),
  ('p4',  'c2',  '三環六線捷運路網', '持續推動捷運建設，包含萬大線、三鶯線等，完善新北交通路網。', 'Traffic', 'In Progress', '2018-06-01', '2024-06-01', 75, ARRAY['交通','捷運'], 'AI 分析：三鶯線進度超前，預計 2025 年完工。萬大線因缺工缺料問題稍微延後，目前正積極趕工中。', 0),
  ('p5',  'c3',  '半導體 S 廊帶', '串聯南科、路竹、橋頭至楠梓，打造全球最完整的半導體產業聚落。', 'Economy', 'In Progress', '2020-08-15', '2024-06-15', 80, ARRAY['產業','台積電'], 'AI 分析：台積電高雄廠進度順利，本案延續前任市府產業園區基礎，並成功招商台積電，帶動周邊供應鏈。', 0),
  ('p6',  'c4',  '0 到 6 歲市府養', '加碼托育補助，凍卵補助，打造友善生育城市。', 'Welfare', 'Proposed', '2022-09-01', '2024-03-01', 30, ARRAY['生育','補助'], 'AI 分析：凍卵補助已於 2023 年試辦，但全面性的「市府養」預算龐大，目前採分階段實施，財源籌措是關鍵。', 0),
  ('p7',  'c4',  '智慧交通改善園區塞車', '利用 AI 號誌控制與大數據分析，紓解新竹科學園區周邊交通壅塞。', 'Traffic', 'Stalled', '2022-09-10', '2024-05-20', 20, ARRAY['交通','智慧城市'], 'AI 分析：雖然導入智慧號誌，但因園區上班車流量過大，硬體道路拓寬困難，民眾感受改善有限，目前計畫重新評估中。', 0),
  ('p8',  'c16', '半導體 S 廊帶預算審查', '嚴格審查台積電設廠相關市府配套預算，確保公帑用在刀口上，杜絕浮編與虛報。', 'Economy', 'In Progress', '2022-03-10', '2024-08-01', 65, ARRAY['產業','台積電','預算監督'], 'AI 分析：議員質詢紀錄顯示已針對道路拓寬、汙水處理等配套預算提出 12 次專案報告要求，有效提升預算透明度。', 0),
  ('p9',  'c17', '楠梓園區周邊基礎建設', '執行台積電設廠周邊道路拓寬、排水系統升級、公共運輸接駁規劃等基礎建設。', 'Economy', 'In Progress', '2022-06-01', '2024-10-15', 55, ARRAY['產業','台積電','基礎建設'], 'AI 分析：楠梓區公所已完成 3 條聯外道路拓寬，汙水處理廠擴建中，但居民反映施工噪音與交通管制影響生活。', 0),
  ('p10', 'c18', '援中里居民安置與生活品質維護', '協助因台積電設廠受影響的援中里居民處理噪音、交通與環境問題，爭取合理補償。', 'Economy', 'Proposed', '2023-01-15', '2024-11-01', 40, ARRAY['產業','台積電','居民權益'], 'AI 分析：里長已召開 8 次里民說明會，成功爭取施工時段限制與臨時停車空間，但長期環境影響評估仍待追蹤。', 0),
  ('cp1', 'c1',  '2026 願景：台北元宇宙園區', '運用區塊鏈與 VR 技術，打造虛擬台北，促進數位經濟發展。', 'Economy', 'Campaign Pledge', '2025-06-01', '2025-06-01', 0, ARRAY['元宇宙','數位經濟'], 'AI 預測：此政見極具前瞻性，但需評估硬體普及率與法規適用性。年輕選民支持度較高。', 12500),
  ('cp5', 'c1',  '台北科技走廊計畫', '串聯內科、南軟至北士科，打造首都科技金三角，吸引國際大廠研發中心進駐。', 'Economy', 'Campaign Pledge', '2025-07-10', '2025-07-10', 0, ARRAY['科技','產業發展'], 'AI 預測：延續性政策的擴大版，對產業界有正面激勵效果，需注意交通配套。', 15600),
  ('cp2', 'c5',  '社宅租金全面八折', '重新檢視社宅定價公式，承諾當選後全面調降市有社宅租金至市價八折以下。', 'Welfare', 'Campaign Pledge', '2025-05-20', '2025-05-20', 0, ARRAY['居住正義','租屋補貼'], 'AI 預測：高房價議題下的強力吸票機，但需詳細說明財源替代方案，否則易流於民粹。', 34200),
  ('cp4', 'c5',  '國中小營養午餐免費', '全額補助公立國中小營養午餐費用，減輕家長負擔，確保學童營養均衡。', 'Education', 'Campaign Pledge', '2025-06-15', '2025-06-15', 0, ARRAY['教育','營養午餐'], 'AI 預測：家長族群支持度極高，但需考量長期財政負擔與排擠效應。', 21000),
  ('cp3', 'c6',  '新竹輕軌立即動工', '解決多年延宕問題，承諾上任半年內完成土地徵收，一年內動工。', 'Traffic', 'Campaign Pledge', '2025-07-01', '2025-07-01', 0, ARRAY['交通','輕軌'], 'AI 預測：針對性極強的政見，直接挑戰現任者的執行力痛點。', 8900),
  ('cp_c7_1', 'c7', '捷運大同線增設出口', '爭取捷運站體增設無障礙出口，方便長者與輪椅族進出。', 'Traffic', 'Campaign Pledge', '2025-08-01', '2025-08-01', 0, ARRAY['交通','無障礙'], NULL, 1200),
  ('cp_c8_1', 'c8', '東區公園全面遊具更新', '淘汰罐頭遊具，打造共融式遊戲場，讓孩子玩得開心又安全。', 'Welfare', 'Campaign Pledge', '2025-08-10', '2025-08-10', 0, ARRAY['親子','公園'], NULL, 2500),
  ('stack_mayor_1', 'c4', '大新竹智慧交通網 2.0', '升級全市交通號誌控制系統，導入 AI 預判車流，並建立大新竹交通行控中心。', 'Traffic', 'Campaign Pledge', '2025-06-20', '2025-06-20', 0, ARRAY['交通','智慧城市','新竹交通'], NULL, 4500),
  ('stack_counc_1', 'c8', '嚴審智慧交通預算，杜絕無效號誌', '強力監督市府智慧交通標案，要求廠商提出具體車流改善數據，拒絕裝飾性工程。', 'Traffic', 'Campaign Pledge', '2025-07-05', '2025-07-05', 0, ARRAY['交通','財政紀律','新竹交通'], NULL, 1800),
  ('stack_chief_1', 'c9', '爭取龍山路口增設智慧感應號誌', '本里龍山路口車禍頻傳，將依據市府智慧交通計畫，爭取優先安裝感應式紅綠燈。', 'Traffic', 'Campaign Pledge', '2025-07-15', '2025-07-15', 0, ARRAY['交通','社區安全','新竹交通'], NULL, 650),
  ('p_hc_mayor_1', 'c10', '大新竹輕軌藍線延伸竹北', '爭取輕軌跨越頭前溪，串聯竹科與竹北生活圈。', 'Traffic', 'Campaign Pledge', '2025-06-01', '2025-06-01', 0, ARRAY['交通','輕軌','竹北生活圈'], NULL, 8000),
  ('p_hc_tm_1', 'c11', '配合輕軌規劃站點接駁車', '於市區規劃 YouBike 與免費接駁巴士，串聯輕軌預定站點。', 'Traffic', 'Campaign Pledge', '2025-06-15', '2025-06-15', 0, ARRAY['交通','接駁','竹北生活圈'], NULL, 4200),
  ('p_hc_rep_1', 'c12', '要求接駁車路線繞經舊市區', '監督公所接駁計畫，確保舊市區長者也能享受大眾運輸便利。', 'Traffic', 'Campaign Pledge', '2025-07-01', '2025-07-01', 0, ARRAY['交通','公平正義','竹北生活圈'], NULL, 1500),
  ('p_hc_chief_1', 'c13', '爭取中興里設 YouBike 站', '本里人口密集，爭取於活動中心前設置 YouBike 2.0 站點。', 'Traffic', 'Campaign Pledge', '2025-07-10', '2025-07-10', 0, ARRAY['交通','便民','竹北生活圈'], NULL, 600),
  ('p_wulai_chief_1', 'c14', '烏來溫泉觀光升級計畫', '結合泰雅文化與生態導覽，打造國際級溫泉觀光品牌。', 'Economy', 'Campaign Pledge', '2025-06-25', '2025-06-25', 0, ARRAY['觀光','原民文化','烏來觀光'], NULL, 3000),
  ('p_wulai_rep_1', 'c15', '爭取溫泉區收益回饋族人', '要求觀光收益應有固定比例回饋部落建設與長者照護。', 'Welfare', 'Campaign Pledge', '2025-07-01', '2025-07-01', 0, ARRAY['權益','社福','烏來觀光'], NULL, 1200);

-- ============================================================
-- Tracking Logs
-- ============================================================

INSERT INTO tracking_logs (id, policy_id, date, event) VALUES
  ('l0-1',   'p0',  '2019-05-01', '提出規劃'),
  ('l0-2',   'p0',  '2020-01-15', '土地徵收完成'),
  ('l1-1',   'p1',  '2022-11-01', '政見提出'),
  ('l1-2',   'p1',  '2023-06-01', '成立都更專案辦公室'),
  ('l1-3',   'p1',  '2024-03-15', '修法草案送交議會'),
  ('l2-1',   'p2',  '2022-10-15', '政見提出'),
  ('l2-2',   'p2',  '2023-01-20', '預算編列完成'),
  ('l2-3',   'p2',  '2023-12-01', '正式開放申請'),
  ('l3-1',   'p3',  '2018-08-01', '願景發布'),
  ('l3-2',   'p3',  '2022-12-25', '第二任期續推'),
  ('l4-1',   'p4',  '2023-01-15', '安坑輕軌通車'),
  ('l4-2',   'p4',  '2024-02-20', '三鶯線列車測試'),
  ('l5-1',   'p5',  '2021-08-01', '台積電宣布設廠'),
  ('l5-2',   'p5',  '2024-01-18', '2奈米廠動土'),
  ('l6-1',   'p6',  '2023-05-11', '凍卵補助計畫啟動'),
  ('l7-1',   'p7',  '2023-03-01', '慈雲路智慧號誌測試'),
  ('l7-2',   'p7',  '2024-05-01', '議會質詢成效不彰'),
  ('l5c-1',  'p8',  '2022-03-10', '提案要求 S 廊帶預算專案報告'),
  ('l5c-2',  'p8',  '2023-06-15', '質詢道路拓寬經費流向'),
  ('l5c-3',  'p8',  '2024-08-01', '要求公開台積電周邊建設決算'),
  ('l5t-1',  'p9',  '2022-06-01', '啟動楠梓園區周邊道路評估'),
  ('l5t-2',  'p9',  '2023-04-20', '後勁路拓寬工程動工'),
  ('l5t-3',  'p9',  '2024-02-10', '汙水處理廠擴建案核定'),
  ('l5t-4',  'p9',  '2024-10-15', '接駁公車路線試營運'),
  ('l5ch-1', 'p10', '2023-01-15', '召開第一次里民說明會'),
  ('l5ch-2', 'p10', '2023-09-01', '爭取施工噪音時段限制'),
  ('l5ch-3', 'p10', '2024-05-20', '協調臨時停車空間'),
  ('l5ch-4', 'p10', '2024-11-01', '提出長期環境監測訴求'),
  ('lcp1',           'cp1', '2025-06-01', '競選承諾發布'),
  ('lcp5',           'cp5', '2025-07-10', '競選承諾發布'),
  ('lcp2',           'cp2', '2025-05-20', '競選承諾發布'),
  ('lcp4',           'cp4', '2025-06-15', '競選承諾發布'),
  ('lcp3',           'cp3', '2025-07-01', '競選承諾發布'),
  ('l_cp_c7_1',      'cp_c7_1', '2025-08-01', '競選承諾發布'),
  ('l_cp_c8_1',      'cp_c8_1', '2025-08-10', '競選承諾發布'),
  ('l_stack_m1',     'stack_mayor_1', '2025-06-20', '發布 2.0 計畫'),
  ('l_stack_c1',     'stack_counc_1', '2025-07-05', '發布質詢重點'),
  ('l_stack_ch1',    'stack_chief_1', '2025-07-15', '里民大會提案'),
  ('l_hc_m1',        'p_hc_mayor_1', '2025-06-01', '提出規劃'),
  ('l_hc_tm1',       'p_hc_tm_1', '2025-06-15', '發布接駁計畫'),
  ('l_hc_rep1',      'p_hc_rep_1', '2025-07-01', '代表會質詢'),
  ('l_hc_chief1',    'p_hc_chief_1', '2025-07-10', '連署提案'),
  ('l_wulai_chief_1','p_wulai_chief_1', '2025-06-25', '政見發表'),
  ('l_wulai_rep_1',  'p_wulai_rep_1', '2025-07-01', '代表會質詢');

-- ============================================================
-- Related Policies
-- ============================================================

INSERT INTO related_policies (policy_id, related_policy_id) VALUES
  ('p0', 'p5'),
  ('p5', 'p0'),
  ('p5', 'p8'),
  ('p5', 'p9'),
  ('p5', 'p10'),
  ('p8', 'p5'),
  ('p9', 'p5'),
  ('p10', 'p5');

-- ============================================================
-- Discussions
-- ============================================================

INSERT INTO discussions (id, policy_id, policy_title, author_id, author_name, author_avatar_url, title, content, likes, tags, created_at, created_at_ts, view_count) VALUES
  ('disc-1', 'cp2', '社宅租金全面八折', 'u1', 'Citizen_Taiwan', 'https://ui-avatars.com/api/?name=CT&background=3b82f6&color=fff',
   '關於社宅租金八折的財源疑問',
   E'雖然這項政見聽起來很吸引人，但我很擔心市府的財政負擔。目前的社宅維護成本已經很高了，如果收入減少，會不會影響未來的社宅興建速度？有無具體的替代財源方案？\n\n根據主計處資料，台北市社宅每年維護成本約 12 億，若租金打八折，預計損失 3 億收入。這筆缺口要從哪裡補？\n\n希望候選人能提出詳細的財務規劃，而不只是喊口號。',
   342, ARRAY['居住正義','經濟'], '2小時前', 1738050000000, 2150),

  ('disc-2', 'p1', '台北大建設 - 都更加速', 'u6', 'UrbanWatcher', 'https://ui-avatars.com/api/?name=UW&background=06b6d4&color=fff',
   '台北大建設都更速度真的有變快嗎？',
   E'我家住在信義區的老公寓，雖然看到政策說要降門檻，但實際整合的時候建商態度還是很保守。有沒有人有實際參與公辦都更的經驗可以分享？\n\n我們社區已經開了三次說明會，但整合率只有 60%，離法定門檻還差很遠。到底是政策還沒落實，還是我們社區的條件不夠好？',
   128, ARRAY['居住正義','交通'], '5小時前', 1738039200000, 1580),

  ('disc-3', 'cp3', '新竹輕軌立即動工', 'u9', 'TrafficGeek', 'https://ui-avatars.com/api/?name=TG&background=0891b2&color=fff',
   '新竹輕軌路線規劃建議',
   E'目前的路線規劃似乎沒有經過人口最密集的住宅區，主要是服務園區上班族。建議可以考慮支線延伸到竹北舊市區，這樣才能真正解決週末的交通問題。\n\n附上我自己畫的建議路線圖（僅供參考）：\n- 主線：高鐵新竹站 → 竹科 → 清大 → 新竹火車站\n- 支線 A：竹北舊市區 → 高鐵站\n- 支線 B：關埔重劃區 → 竹科\n\n這樣可以同時服務通勤族和一般市民。',
   89, ARRAY['交通','教育'], '1天前', 1737963600000, 980),

  ('disc-4', 'cp4', '國中小營養午餐免費', 'u13', 'Teacher_Wang', 'https://ui-avatars.com/api/?name=TW&background=f97316&color=fff',
   '營養午餐免費政策的排擠效應',
   E'身為一線教師，我支持減輕家長負擔。但更希望經費能用在提升食材品質，而不是全額免費但吃得很差。\n\n目前學校營養午餐一餐大約 55 元，其中食材成本佔 35 元。如果要全面免費，又要維持品質，每年至少需要額外 8 億的預算。\n\n建議改為「弱勢家庭全額補助 + 一般家庭補助一半」，這樣更符合公平正義的精神。',
   210, ARRAY['教育','經濟'], '1天前', 1737956400000, 3200),

  ('disc-5', 'p5', '半導體 S 廊帶', 'u18', '楠梓在地人', 'https://ui-avatars.com/api/?name=NZ&background=16a34a&color=fff',
   '台積電設廠後楠梓的房價與生活品質變化',
   E'台積電宣布在楠梓設廠後，周邊房價已經飆漲了 30% 以上。身為在地居民，一方面期待就業機會增加，另一方面擔心生活環境惡化。\n\n最近施工噪音很大，上下班時間交通也變得更塞了。不知道市府有沒有具體的因應措施？\n\n也想問問其他楠梓的朋友，你們覺得台積電設廠對在地是利大於弊還是弊大於利？',
   178, ARRAY['經濟','環保'], '3小時前', 1738046400000, 2800);

-- ============================================================
-- Discussion Comments
-- ============================================================

-- disc-1 comments
INSERT INTO discussion_comments (id, discussion_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('c1-1', 'disc-1', 'u2', 'HousingExpert', 'https://ui-avatars.com/api/?name=HE&background=10b981&color=fff', '好問題！其實可以參考新加坡的 HDB 模式，政府透過土地增值回收成本。但台灣的土地制度完全不同，直接套用有困難。', 89, '1小時前'),
  ('c1-2', 'disc-1', 'u4', '台北租屋族', 'https://ui-avatars.com/api/?name=TR&background=f59e0b&color=fff', '身為一個月薪 35K 的上班族，我真的很需要社宅。目前租一間套房就要 12000，如果能打八折省下的錢可以改善生活品質。支持這個政策！', 156, '1.5小時前'),
  ('c1-3', 'disc-1', 'u5', 'FinanceWatch', 'https://ui-avatars.com/api/?name=FW&background=ef4444&color=fff', '財源問題確實是硬傷。候選人應該公布完整的財務模型，不然就只是選舉支票。', 72, '50分鐘前');

-- disc-2 comments
INSERT INTO discussion_comments (id, discussion_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('c2-1', 'disc-2', 'u7', '建築師阿明', 'https://ui-avatars.com/api/?name=AM&background=059669&color=fff', '整合率 60% 其實已經不錯了。根據我的經驗，最後 10% 通常是最難的。建議找專業的都更顧問公司，他們比較知道如何處理釘子戶的問題。', 45, '4小時前'),
  ('c2-2', 'disc-2', 'u8', '萬華居民', 'https://ui-avatars.com/api/?name=WH&background=d946ef&color=fff', '我們萬華這邊的都更案已經談了五年了，到現在連建照都還沒申請。所謂的「加速」根本感受不到。', 67, '3小時前');

-- disc-3 comments
INSERT INTO discussion_comments (id, discussion_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('c3-1', 'disc-3', 'u10', '竹科工程師', 'https://ui-avatars.com/api/?name=ZK&background=7c3aed&color=fff', '身為每天塞光復路的工程師，我舉雙手贊成。但重點是「立即動工」的承諾能兌現嗎？之前的輕軌計畫已經喊了十幾年。', 38, '20小時前'),
  ('c3-2', 'disc-3', 'u11', '新竹媽媽', 'https://ui-avatars.com/api/?name=MO&background=ec4899&color=fff', '支線 A 如果能延伸到竹北文化中心附近就更好了，很多親子活動都在那邊舉辦，每次開車停車都很崩潰。', 29, '16小時前'),
  ('c3-3', 'disc-3', 'u12', 'BudgetHawk', 'https://ui-avatars.com/api/?name=BH&background=64748b&color=fff', '支線越多，預算越膨脹。建議先做好主線再說，不要一開始就畫大餅。', 15, '12小時前');

-- disc-4 comments
INSERT INTO discussion_comments (id, discussion_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('c4-1', 'disc-4', 'u14', '家長會長老陳', 'https://ui-avatars.com/api/?name=LC&background=0d9488&color=fff', '老師說得很中肯。全面免費聽起來很棒，但如果品質下降，反而會讓家長更不放心。不如把錢花在有機食材和營養師上。', 98, '22小時前'),
  ('c4-2', 'disc-4', 'u16', '雙寶媽', 'https://ui-avatars.com/api/?name=SM&background=e11d48&color=fff', '兩個小孩一個月午餐費要 2400，真的是不小的負擔。如果能免費當然最好，但前提是品質不能變差。', 76, '18小時前'),
  ('c4-3', 'disc-4', 'u17', 'DataDriven', 'https://ui-avatars.com/api/?name=DD&background=1e40af&color=fff', '參考日本的「給食」制度，每餐只要 250 日圓（約台幣 55 元），但營養品質非常高。關鍵在於集中採購降低成本。', 112, '14小時前');

-- disc-5 comments
INSERT INTO discussion_comments (id, discussion_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('c5-1', 'disc-5', 'u19', '高雄產業觀察', 'https://ui-avatars.com/api/?name=KS&background=ea580c&color=fff', '從產業面來看，台積電帶動的供應鏈效應非常可觀。但政府必須做好配套，否則就是讓居民承擔發展的代價。', 67, '2.5小時前'),
  ('c5-2', 'disc-5', 'u20', '房產分析師', 'https://ui-avatars.com/api/?name=FA&background=4f46e5&color=fff', '楠梓房價從均價 18 萬漲到 25 萬，漲幅確實驚人。但要注意，很多是預售屋的價格，實際成交可能沒有那麼誇張。', 53, '1.5小時前');

-- ============================================================
-- Comment Replies
-- ============================================================

-- disc-1 replies
INSERT INTO comment_replies (id, comment_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('r1-1-1', 'c1-1', 'u3', 'PolicyNerd', 'https://ui-avatars.com/api/?name=PN&background=8b5cf6&color=fff', '同意。台灣的社宅問題不只是租金，還有地點和品質。很多社宅蓋在偏遠的地方，就算免費也沒人要住。', 34, '45分鐘前'),
  ('r1-1-2', 'c1-1', 'u1', 'Citizen_Taiwan', 'https://ui-avatars.com/api/?name=CT&background=3b82f6&color=fff', '沒錯，選址才是關鍵。如果能在捷運站附近蓋社宅，即使租金只打九折也會搶破頭。', 56, '30分鐘前');

-- disc-2 replies
INSERT INTO comment_replies (id, comment_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('r2-1-1', 'c2-1', 'u6', 'UrbanWatcher', 'https://ui-avatars.com/api/?name=UW&background=06b6d4&color=fff', '謝謝建議！請問有推薦的都更顧問公司嗎？', 12, '3.5小時前');

-- disc-3 replies
INSERT INTO comment_replies (id, comment_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('r3-1-1', 'c3-1', 'u9', 'TrafficGeek', 'https://ui-avatars.com/api/?name=TG&background=0891b2&color=fff', '這就是為什麼我們需要一個有執行力的市長。光是喊口號沒有用，要有具體的時程表和預算規劃。', 21, '18小時前');

-- disc-4 replies
INSERT INTO comment_replies (id, comment_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('r4-1-1', 'c4-1', 'u15', '營養師小美', 'https://ui-avatars.com/api/?name=XM&background=a855f7&color=fff', '完全同意！很多學校的營養午餐根本沒有經過專業營養師把關，先解決品質問題比較實在。', 45, '20小時前'),
  ('r4-3-1', 'c4-3', 'u13', 'Teacher_Wang', 'https://ui-avatars.com/api/?name=TW&background=f97316&color=fff', '日本的模式確實值得參考，但他們的學校營養師配置密度比台灣高很多。制度面的改革才是根本。', 33, '10小時前');

-- disc-5 replies
INSERT INTO comment_replies (id, comment_id, author_id, author_name, author_avatar_url, content, likes, created_at) VALUES
  ('r5-1-1', 'c5-1', 'u18', '楠梓在地人', 'https://ui-avatars.com/api/?name=NZ&background=16a34a&color=fff', '對啊，我們不反對發展，但至少施工期間的噪音管制和交通疏導要做好。目前完全感受不到。', 42, '2小時前');
