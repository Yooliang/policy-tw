-- ============================================================
-- 2026 九合一選舉候選人政見
-- 資料來源：中央社、聯合新聞網、自由時報、風傳媒 (2026/01)
-- ============================================================

-- 台北市 - 吳怡農 (id=1)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(1, '陽光政治 - 拒絕企業捐款', '宣布不接受任何企業捐款，只收電子捐款並留下完整金流紀錄，讓每位市民成為「股東」，提升政治透明度與公信力。', 'Political', 'Campaign Pledge', '2025-11-20', '2025-11-20', 0, ARRAY['陽光政治', '政治獻金', '透明治理'], 8500),
(1, 'AI 時代教育轉型', '面對 AI 帶來的失業潮與就業不確定性，推動台北市教育體系轉型，培養下一代適應數位時代的核心能力。', 'Education', 'Campaign Pledge', '2025-11-20', '2025-11-20', 0, ARRAY['AI教育', '數位轉型', '青年就業'], 6200),
(1, '重現小英成績', '以理性論述與國際視野重新凝聚社會支持，延續蔡英文總統在台北兩次過半得票的成績。', 'Political', 'Campaign Pledge', '2025-11-20', '2025-11-20', 0, ARRAY['選戰策略', '社會共識'], 4800);

-- 新北市 - 蘇巧慧 (id=2)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(2, '學童營養午餐全面免費', '若當選將立即推動新北市公立國中小學童營養午餐全面免費，減輕家長經濟負擔。', 'Education', 'Campaign Pledge', '2025-11-05', '2025-11-05', 0, ARRAY['營養午餐', '教育福利', '家庭支持'], 15800),
(2, '溫暖創新的新北', '以「溫暖、創新、會做事」為施政願景，用對新北的深厚感情，讓城市邁向更璀璨的未來。', 'Administration', 'Campaign Pledge', '2025-11-05', '2025-11-05', 0, ARRAY['施政願景', '城市發展'], 9200),
(2, '母雞帶小雞 - 最強新北隊', '組建最強團隊，帶領新北市議員候選人一起打贏 2026 選戰，實現議會過半目標。', 'Political', 'Campaign Pledge', '2025-11-05', '2025-11-05', 0, ARRAY['選戰策略', '團隊整合'], 7500);

-- 新北市 - 黃國昌 (id=3)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(3, 'Do The Best 說到做到', '以「說到做到」為競選主軸，展現實踐承諾的決心，新北市 29 區每區都要跑透透、深耕地方。', 'Political', 'Campaign Pledge', '2025-12-27', '2025-12-27', 0, ARRAY['選戰策略', '實踐承諾'], 12500),
(3, '在野合作共推最強', '保持與國民黨合作善意，不排斥在野共推最強候選人，以 2028 拉下執政黨為最重要目標。', 'Political', 'Campaign Pledge', '2025-08-11', '2025-08-11', 0, ARRAY['藍白合', '在野合作'], 8900);

-- 台中市 - 何欣純 (id=6)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(6, '友善年輕人的台中', '打造年輕人能夠安居樂業的城市願景，提出有利年輕族群的政策，讓台中成為更友善的年輕城市。', 'Welfare', 'Campaign Pledge', '2025-10-14', '2025-10-14', 0, ARRAY['青年政策', '居住正義', '就業'], 11200),
(6, '中台灣穩健接棒', '以女性中生代形象凸顯改革氣象，延續民進黨在台中的基層動員與地方服務實力。', 'Administration', 'Campaign Pledge', '2025-10-14', '2025-10-14', 0, ARRAY['施政願景', '改革'], 8600);

-- 台南市 - 陳亭妃 (id=8)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(8, '大台南串聯溪北溪南', '以「點線面」架構串聯溪北溪南，讓台南各區均衡發展，成為更緊密的大台南生活圈。', 'Traffic', 'Campaign Pledge', '2025-12-27', '2025-12-27', 0, ARRAY['區域發展', '交通串聯', '均衡發展'], 9800),
(8, '三大科技軸線', '串聯花卉產業園區、台南科學園區與沙崙綠能園區三大科技軸線，並推動南科園區第 4 期落腳沙崙，發展 AI 運算中心。', 'Economy', 'Campaign Pledge', '2025-12-27', '2025-12-27', 0, ARRAY['科技產業', 'AI', '綠能', '南科'], 14500),
(8, '台南 400 首位女市長', '以「顧台南這個家」為使命，爭取成為台南 400 年來第一位女性市長，為這塊土地打拚用心。', 'Political', 'Campaign Pledge', '2026-01-15', '2026-01-15', 0, ARRAY['歷史意義', '性別突破'], 7200);

-- 高雄市 - 賴瑞隆 (id=10)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(10, '團結優先 守住高雄', '以「團結優先」凝聚黨內外力量，2026 全力守住執政權，延續城市光榮感。', 'Political', 'Campaign Pledge', '2026-01-13', '2026-01-13', 0, ARRAY['選戰策略', '團結', '執政延續'], 10500),
(10, '高雄黃金十年', '接棒謝長廷、陳菊與陳其邁三位市長的遠見，帶領高雄邁向嶄新的「黃金十年」，成為百業齊發、區域均衡的國際級幸福城市。', 'Economy', 'Campaign Pledge', '2026-01-13', '2026-01-13', 0, ARRAY['城市願景', '經濟發展', '國際化'], 13200);

-- 高雄市 - 柯志恩 (id=11)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(11, '以小博大 逆勢突圍', '以智慧與格局治理城市，打一場「以小博大、以寡擊眾、逆勢突圍」的選戰，證明城市治理不是比資源多寡。', 'Administration', 'Campaign Pledge', '2026-01-13', '2026-01-13', 0, ARRAY['選戰策略', '治理能力'], 8900),
(11, '改善空氣品質與工業污染', '優先處理市民最關心的空氣品質與工業污染問題，提升高雄環境品質與市民健康。', 'Environment', 'Campaign Pledge', '2026-01-13', '2026-01-13', 0, ARRAY['空污', '環保', '健康'], 11500);

-- 新增 tracking_logs
INSERT INTO tracking_logs (policy_id, date, event, description) VALUES
((SELECT id FROM policies WHERE politician_id = 1 AND title LIKE '陽光政治%'), '2025-11-20', '競選承諾發布', '吳怡農宣布拒絕企業捐款的陽光政治主張'),
((SELECT id FROM policies WHERE politician_id = 2 AND title LIKE '學童營養午餐%'), '2025-11-05', '競選承諾發布', '蘇巧慧提出營養午餐免費政策'),
((SELECT id FROM policies WHERE politician_id = 3 AND title LIKE 'Do The Best%'), '2025-12-27', '造勢活動宣布', '黃國昌於新莊舉辦「為新北應援」造勢活動'),
((SELECT id FROM policies WHERE politician_id = 8 AND title LIKE '三大科技軸線%'), '2025-12-27', '政見發表會', '陳亭妃於民進黨台南市長提名政見會發布'),
((SELECT id FROM policies WHERE politician_id = 10 AND title LIKE '團結優先%'), '2026-01-13', '初選勝出', '賴瑞隆以0.6%勝出民進黨高雄市長初選');
