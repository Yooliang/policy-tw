-- ============================================================
-- 2026 九合一選舉六都候選人政見（補充）
-- 資料來源：中央社、聯合新聞網、自由時報、ETtoday、TVBS (2026/01)
-- ============================================================

-- 新北市 - 李四川 (id=4)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(4, '承擔責任 不排斥參選', '表態若黨有需要願意承擔，以「選舉一定要勝利」為原則，交由黨中央協調拍板。', 'Political', 'Campaign Pledge', '2025-08-19', '2025-08-19', 0, ARRAY['選戰策略', '承擔責任'], 15800),
(4, '民生優先於選舉', '強調人民希望政治人物多對民生著墨，而非老是談選舉，將以務實態度服務市民。', 'Administration', 'Campaign Pledge', '2025-10-13', '2025-10-13', 0, ARRAY['民生優先', '務實施政'], 12500),
(4, '豐富行政經驗帶領新北', '曾任行政院秘書長、國民黨秘書長、新北副市長、高雄副市長，將以豐富行政歷練服務新北市民。', 'Administration', 'Campaign Pledge', '2026-01-20', '2026-01-20', 0, ARRAY['行政經驗', '治理能力'], 18200);

-- 台中市 - 何欣純 (id=6) 補充政見（已有：友善年輕人的台中、中台灣穩健接棒）
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(6, '翻轉慶記之都形象', '提高見警率、強化治安，翻轉民眾對台中「慶記（子彈）之都」的負面印象。', 'Justice', 'Campaign Pledge', '2026-01-22', '2026-01-22', 0, ARRAY['治安', '見警率', '城市形象'], 14500),
(6, '解決垃圾問題', '推動外埔二期實質建設，降低廚餘清運負擔，改善台中「垃圾之都」形象。', 'Environment', 'Campaign Pledge', '2026-01-22', '2026-01-22', 0, ARRAY['垃圾處理', '環保', '外埔二期'], 11800),
(6, '市長換欣 台中普發現金', '主張台中這家公司賺錢，城市紅利需與市民股東共享，推動現金發放政策。', 'Welfare', 'Campaign Pledge', '2026-01-15', '2026-01-15', 0, ARRAY['現金發放', '市民福利', '城市紅利'], 22000),
(6, '延續長者福利政策', '面對台中進入超高齡社會，延續並加碼老人健保、敬老愛心卡補助等好政策。', 'Welfare', 'Campaign Pledge', '2026-01-15', '2026-01-15', 0, ARRAY['長者福利', '健保', '敬老卡'], 16500);

-- 台中市 - 江啟臣 (id=7)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(7, '幸福城邁向旗艦城', '延續盧秀燕打造的「幸福城」基礎，朝「旗艦城」目標前進，完成大台中願景。', 'Administration', 'Campaign Pledge', '2025-12-14', '2025-12-14', 0, ARRAY['城市願景', '旗艦城', '施政延續'], 13500),
(7, '台中 Way 軟實力輸出', '發揚台中道地特色：音樂、人文、美食、文創、手搖飲產業，提升至國際競爭水準。', 'Economy', 'Campaign Pledge', '2025-12-14', '2025-12-14', 0, ARRAY['軟實力', '文創產業', '國際化'], 11200),
(7, '會展產業在地化', '推動腳踏車展、機械展等直接在台中舉辦，帶動會展產業，減少北上參展成本。', 'Economy', 'Campaign Pledge', '2025-12-14', '2025-12-14', 0, ARRAY['會展產業', '在地化', '機械展'], 9800),
(7, '2030 巨蛋場館建設', '因應棒球經典賽效應，補足台中場館建設，包括 2030 年的巨蛋及大巨蛋規劃。', 'Administration', 'Campaign Pledge', '2025-12-14', '2025-12-14', 0, ARRAY['巨蛋', '場館建設', '運動產業'], 15600);

-- 高雄市 - 柯志恩 (id=11) 補充政見（已有：以小博大逆勢突圍、改善空氣品質）
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(11, '高薪高技術產業發展', '發展高薪、高技術、高附加價值及低汙染產業，讓年輕人不再北漂。', 'Economy', 'Campaign Pledge', '2022-10-15', '2026-01-20', 0, ARRAY['產業升級', '青年就業', '低汙染'], 14200),
(11, '高鐵南延進入市區', '爭取高鐵南延進入高雄市區，強化南台灣交通樞紐地位。', 'Traffic', 'Campaign Pledge', '2022-10-15', '2026-01-20', 0, ARRAY['高鐵南延', '交通建設', '南台灣'], 18500),
(11, '百座全齡共融公園', '任內打造 100 座全齡共融公園，讓高雄變成涼感城市。', 'Environment', 'Campaign Pledge', '2022-10-15', '2026-01-20', 0, ARRAY['共融公園', '涼感城市', '公共建設'], 12800);

-- 基隆市 - 童子瑋 (id=12)
INSERT INTO policies (politician_id, title, description, category, status, proposed_date, last_updated, progress, tags, support_count) VALUES
(12, '重陽敬老金加倍發放', '65-99 歲長者敬老金從 1000 元加倍至 2000 元，100 歲以上從 6000 元加倍至 12000 元。', 'Welfare', 'Campaign Pledge', '2026-01-22', '2026-01-22', 0, ARRAY['敬老金', '長者福利', '加倍發放'], 16800),
(12, '成立長照處專責單位', '成立專責長照處，整合社福、醫療與老人政策，讓長輩在地安養。', 'Welfare', 'Campaign Pledge', '2026-01-22', '2026-01-22', 0, ARRAY['長照', '在地安養', '組織改造'], 12500),
(12, '做生活市長', '市政回歸市民生活日常，不追逐一時亮點，追求長治久安的穩定，照顧通勤族、青年、孩童與長輩。', 'Administration', 'Campaign Pledge', '2026-01-22', '2026-01-22', 0, ARRAY['生活市長', '民生優先', '穩定發展'], 14200),
(12, '海港山城發展願景', '利用基隆海港、山城等城市資產，把握老文化與新商業特色，發展與生活並進。', 'Economy', 'Campaign Pledge', '2025-12-25', '2025-12-25', 0, ARRAY['海港城市', '山城特色', '文化商業'], 9800),
(12, '提升生育率與托幼支持', '針對全國倒數的出生率，減輕青年父母托幼負擔，提升基隆生育友善環境。', 'Welfare', 'Campaign Pledge', '2025-12-25', '2025-12-25', 0, ARRAY['生育率', '托幼', '青年支持'], 11500);

-- 新增 tracking_logs（使用更精確的查詢避免重複）
INSERT INTO tracking_logs (policy_id, date, event, description) VALUES
((SELECT id FROM policies WHERE politician_id = 4 AND title = '承擔責任 不排斥參選'), '2025-08-19', '表態參選意願', '李四川於中央社專訪表示不排斥承擔'),
((SELECT id FROM policies WHERE politician_id = 6 AND title = '市長換欣 台中普發現金'), '2026-01-15', '政見宣布', '何欣純提出台中普發現金主張'),
((SELECT id FROM policies WHERE politician_id = 7 AND title = '幸福城邁向旗艦城'), '2025-12-14', '參選宣布', '江啟臣於豐原聖誕音樂節宣布爭取提名'),
((SELECT id FROM policies WHERE politician_id = 11 AND title = '高鐵南延進入市區'), '2022-10-15', '2022政見延續', '柯志恩延續2022年高鐵南延政見'),
((SELECT id FROM policies WHERE politician_id = 12 AND title = '重陽敬老金加倍發放'), '2026-01-22', '首場見面會', '童子瑋於「進步基隆市民見面會」提出敬老金加倍政見');
