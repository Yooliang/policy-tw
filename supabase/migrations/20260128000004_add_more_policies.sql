-- ============================================================
-- 2026 九合一選舉候選人政見（續）
-- 資料來源：中央社、聯合新聞網、自由時報、ETtoday、風傳媒 (2026/01)
-- ============================================================

-- 台南市 - 謝龍介 (id=9)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(9, '優質選戰 展現百分百市長格局', '以百分之百市長格局投入選戰，以優質、正面的選舉方式，讓市民看到不一樣的藍營風格。', 'Political', 'Campaign Pledge', '2025-12-30', '2025-12-30', 0, ARRAY['選戰策略', '正向選舉'], 7200),
(9, '65歲以上老人健保費全免', '承諾當選後推動台南市 65 歲以上長者健保費由市府全額補助，減輕長輩經濟負擔。', 'Welfare', 'Campaign Pledge', '2026-01-10', '2026-01-10', 0, ARRAY['長者福利', '健保', '社會福利'], 18500),
(9, '只做一任 把機會留給年輕人', '自我承諾只做一任市長，四年後不尋求連任，將舞台留給年輕世代，打破政壇老人政治。', 'Political', 'Campaign Pledge', '2026-01-15', '2026-01-15', 0, ARRAY['世代交替', '自我承諾'], 12000);

-- 台中市 - 江啟臣 (id=7)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(7, '台中國際會展產業發展', '發展台中成為中台灣會展產業重鎮，爭取國際會議與展覽活動，帶動觀光與商業發展。', 'Economy', 'Campaign Pledge', '2025-10-20', '2025-10-20', 0, ARRAY['會展產業', '國際化', '經濟發展'], 9800),
(7, '運動場館升級計畫', '推動台中巨蛋與各區運動中心建設，打造完善的運動休閒場館網絡，提升市民運動品質。', 'Administration', 'Campaign Pledge', '2025-11-15', '2025-11-15', 0, ARRAY['運動場館', '巨蛋', '市政建設'], 11200),
(7, '翻轉中台灣 拿回執政權', '以副院長高度整合藍營資源，翻轉中台灣，為國民黨在 2028 大選前站穩中部灘頭堡。', 'Political', 'Campaign Pledge', '2026-01-08', '2026-01-08', 0, ARRAY['選戰策略', '政黨競爭'], 8500);

-- 桃園市 - 張善政 (id=5) 現任施政
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(5, '設立婦幼發展局', '全國首創婦幼發展局，整合婦幼相關業務，提供從懷孕到育兒的一站式服務，打造友善育兒城市。', 'Welfare', 'In Progress', '2023-06-01', '2025-12-20', 75, ARRAY['婦幼政策', '組織創新', '育兒支持'], 22000),
(5, '幸福里程 30K 交通補助', '推動桃園幸福里程計畫，提供市民每月 30 公里免費大眾運輸里程，減輕通勤負擔。', 'Traffic', 'Achieved', '2023-03-01', '2024-06-30', 100, ARRAY['交通補助', '大眾運輸', '市民福利'], 35000),
(5, 'AI 科技廊道計畫', '串聯航空城、青埔與南桃園科技園區，打造北台灣 AI 產業廊道，吸引科技大廠進駐。', 'Economy', 'In Progress', '2023-09-01', '2025-11-30', 60, ARRAY['AI產業', '科技園區', '產業發展'], 18500);

-- 基隆市 - 童子瑋 (id=12)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(12, '台鐵換捷運交通升級', '推動台鐵通勤區間升級為捷運化服務，縮短班距、增設站點，改善基隆聯外交通。', 'Traffic', 'Campaign Pledge', '2025-11-20', '2025-11-20', 0, ARRAY['交通建設', '捷運化', '台鐵升級'], 8900),
(12, '長照 2.0 在地深耕', '擴大基隆市長照服務據點，推動社區式日間照顧中心，讓長輩在地安老。', 'Welfare', 'Campaign Pledge', '2025-12-05', '2025-12-05', 0, ARRAY['長照', '社區照顧', '老人福利'], 7500),
(12, '青年創業扶植計畫', '設立基隆青年創業基金，提供創業諮詢、低利貸款與共享空間，協助青年在地創業。', 'Economy', 'Campaign Pledge', '2025-12-15', '2025-12-15', 0, ARRAY['青年創業', '創業扶植', '青年政策'], 6200);

-- 基隆市 - 謝國樑 (id=13) 現任施政
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(13, '親子身障長者服務一站到位', '整合親子館、身障服務與長者照顧，建立一站式便民服務，提升市府服務效率。', 'Welfare', 'In Progress', '2023-04-01', '2025-12-01', 70, ARRAY['親子服務', '身障福利', '長者照顧'], 12500),
(13, '基隆港灣再造計畫', '推動基隆港周邊都市更新，結合郵輪觀光與在地文化，打造北台灣觀光門戶。', 'Economy', 'In Progress', '2023-06-01', '2025-11-15', 45, ARRAY['港灣再造', '觀光發展', '都市更新'], 15800),
(13, '學童營養午餐升級', '提升基隆市學童營養午餐品質，增加有機蔬菜比例，保障孩子健康成長。', 'Education', 'Achieved', '2023-03-01', '2024-09-01', 100, ARRAY['營養午餐', '學童福利', '食安'], 9200);

-- 彰化縣 - 陳素月 (id=15)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(15, '彰化產業轉型升級', '推動彰化傳統產業結合智慧製造，協助中小企業數位轉型，維持彰化製造業競爭力。', 'Economy', 'Campaign Pledge', '2025-10-15', '2025-10-15', 0, ARRAY['產業轉型', '智慧製造', '中小企業'], 7800),
(15, '交通瓶頸全面突破', '爭取彰化市區鐵路高架化、員林大道延伸等重大交通建設，解決彰化交通瓶頸。', 'Traffic', 'Campaign Pledge', '2025-11-08', '2025-11-08', 0, ARRAY['鐵路高架', '交通建設', '道路延伸'], 9500);

-- 雲林縣 - 劉建國 (id=18)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(18, '農業首都產銷升級', '建立雲林農產品產銷平台，推動契作制度與冷鏈物流，穩定農民收入。', 'Economy', 'Campaign Pledge', '2025-09-20', '2025-09-20', 0, ARRAY['農業', '產銷', '農民收入'], 11200),
(18, '雲林高鐵特定區開發', '加速雲林高鐵特定區開發，引進產業與商業設施，帶動地方發展。', 'Economy', 'Campaign Pledge', '2025-10-30', '2025-10-30', 0, ARRAY['高鐵特區', '產業引進', '地方發展'], 8900);

-- 嘉義市 - 王美惠 (id=20)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(20, '嘉義文化觀光城市', '結合嘉義檜意森活村、阿里山森林鐵路等文化資產，打造嘉義成為文化觀光城市。', 'Economy', 'Campaign Pledge', '2025-11-12', '2025-11-12', 0, ARRAY['文化觀光', '阿里山', '檜意森活'], 7600),
(20, '青銀共居社區營造', '推動青銀共居計畫，讓青年與長者互助共居，解決青年租屋與長者獨居問題。', 'Welfare', 'Campaign Pledge', '2025-12-01', '2025-12-01', 0, ARRAY['青銀共居', '社區營造', '居住政策'], 6800);

-- 嘉義市 - 張啟楷 (id=21)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(21, '嘉義科技新城計畫', '爭取中央科技園區設置，引進科技產業，為嘉義市創造高薪就業機會。', 'Economy', 'Campaign Pledge', '2025-10-25', '2025-10-25', 0, ARRAY['科技產業', '就業機會', '產業引進'], 8200),
(21, '第三勢力 翻轉嘉義', '以第三勢力身分突破藍綠對決，為嘉義帶來新氣象與新選擇。', 'Political', 'Campaign Pledge', '2025-11-20', '2025-11-20', 0, ARRAY['第三勢力', '突破藍綠', '政治創新'], 5900);

-- 嘉義縣 - 蔡易餘 (id=22)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(22, '故宮南院帶動觀光經濟', '以故宮南院為核心，串聯周邊景點，打造嘉義縣成為南台灣文化觀光重鎮。', 'Economy', 'Campaign Pledge', '2025-11-05', '2025-11-05', 0, ARRAY['故宮南院', '觀光經濟', '文化產業'], 9200),
(22, '農村再生 宜居嘉義', '推動農村再生計畫，改善鄉村基礎建設，讓嘉義成為宜居的農業大縣。', 'Administration', 'Campaign Pledge', '2025-12-10', '2025-12-10', 0, ARRAY['農村再生', '宜居城市', '基礎建設'], 7500);

-- 屏東縣 - 蘇清泉 (id=24)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(24, '屏東醫療資源提升', '以醫療專業背景，爭取醫學中心設置，改善屏東偏鄉醫療資源不足問題。', 'Welfare', 'Campaign Pledge', '2025-10-08', '2025-10-08', 0, ARRAY['醫療資源', '偏鄉醫療', '醫學中心'], 12500),
(24, '恆春觀光產業升級', '推動恆春半島觀光產業升級，引進國際級度假村，創造在地就業機會。', 'Economy', 'Campaign Pledge', '2025-11-18', '2025-11-18', 0, ARRAY['恆春觀光', '度假村', '觀光產業'], 8900);

-- 南投縣 - 許淑華 (id=17) 現任施政
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(17, '觀光首都 暢遊南投', '強化日月潭、清境、溪頭等景點聯繫，推動觀光產業升級，鞏固南投觀光首都地位。', 'Economy', 'In Progress', '2023-03-01', '2025-12-15', 65, ARRAY['觀光首都', '日月潭', '清境'], 18500),
(17, '南投國際風箏節', '持續舉辦南投國際風箏節，打造城市品牌活動，吸引國內外觀光客。', 'Economy', 'Achieved', '2023-06-01', '2024-10-15', 100, ARRAY['風箏節', '城市行銷', '國際活動'], 15200);

-- 花蓮縣 - 傅崐萁 (id=26)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(26, '花蓮災後重建加速', '加速 0403 地震災後重建，爭取中央資源，協助受災戶盡速重建家園。', 'Administration', 'Campaign Pledge', '2025-09-15', '2025-09-15', 0, ARRAY['災後重建', '地震', '居住重建'], 22000),
(26, '東部觀光復甦計畫', '推動花蓮觀光產業復甦，修復觀光景點、行銷花蓮之美，重振觀光經濟。', 'Economy', 'Campaign Pledge', '2025-10-01', '2025-10-01', 0, ARRAY['觀光復甦', '花蓮觀光', '經濟振興'], 16800);

-- 新增 tracking_logs
INSERT INTO tracking_logs (policy_id, date, event, description) VALUES
((SELECT id FROM policies WHERE politician_id = 9 AND title LIKE '65歲以上老人健保%'), '2026-01-10', '政見宣布', '謝龍介於造勢活動宣布老人健保全免政策'),
((SELECT id FROM policies WHERE politician_id = 5 AND title LIKE '幸福里程%'), '2024-06-30', '政策達標', '桃園幸福里程 30K 方案正式上路'),
((SELECT id FROM policies WHERE politician_id = 13 AND title LIKE '學童營養午餐%'), '2024-09-01', '政策完成', '基隆營養午餐升級計畫全面實施'),
((SELECT id FROM policies WHERE politician_id = 17 AND title LIKE '南投國際風箏節%'), '2024-10-15', '活動圓滿', '2024 南投國際風箏節成功舉辦'),
((SELECT id FROM policies WHERE politician_id = 26 AND title LIKE '花蓮災後重建%'), '2025-09-15', '政見提出', '傅崐萁宣布參選並提出災後重建優先政見');
