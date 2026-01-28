-- ============================================================
-- Seed Data: 2026 九合一選舉
-- 資料來源：維基百科、聯合新聞網、今周刊、遠見雜誌 (2026/01)
-- ============================================================

-- Reference Data
INSERT INTO categories (name) VALUES
('Traffic'), ('Welfare'), ('Economy'), ('Education'),
('Environment'), ('Justice'), ('Administration'), ('Political');

INSERT INTO locations (name) VALUES
('台北市'), ('新北市'), ('桃園市'), ('台中市'), ('台南市'), ('高雄市'),
('基隆市'), ('新竹市'), ('新竹縣'), ('苗栗縣'), ('彰化縣'), ('南投縣'),
('雲林縣'), ('嘉義市'), ('嘉義縣'), ('屏東縣'), ('宜蘭縣'), ('花蓮縣'),
('台東縣'), ('澎湖縣'), ('金門縣'), ('連江縣');

-- ============================================================
-- 選舉資料
-- ============================================================

INSERT INTO elections (name, short_name, start_date, end_date, election_date) VALUES
('2026 九合一地方公職人員選舉', '2026 九合一', '2026-01-01', '2026-11-28', '2026-11-28');

-- 選舉類型 (election_id = 1 for 2026 九合一)
INSERT INTO election_types (election_id, type) VALUES
(1, '縣市長'),
(1, '縣市議員'),
(1, '鄉鎮市長'),
(1, '直轄市山地原住民區長'),
(1, '鄉鎮市民代表'),
(1, '直轄市山地原住民區民代表'),
(1, '村里長');

-- ============================================================
-- 政治人物：2026 縣市長參選人（真實資料）
-- ============================================================

-- 六都

-- 台北市
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('吳怡農', '民進黨', 'politician', '縣市長', '前台北市黨部主委', '台北市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Wu_Yi-nong_%282020%29.jpg/220px-Wu_Yi-nong_%282020%29.jpg');

-- 新北市
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('蘇巧慧', '民進黨', 'politician', '縣市長', '立法委員', '新北市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a0/Su_Chiao-hui_2020_%28cropped%29.jpg/220px-Su_Chiao-hui_2020_%28cropped%29.jpg'),
('黃國昌', '民眾黨', 'politician', '縣市長', '民眾黨主席', '新北市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Huang_Kuo-chang_2016.jpg/220px-Huang_Kuo-chang_2016.jpg'),
('李四川', '國民黨', 'potential', '縣市長', '台北市副市長', '新北市', NULL);

-- 桃園市
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('張善政', '國民黨', 'incumbent', '縣市長', '桃園市長', '桃園市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7d/Premier_Chang_San-cheng_%28cropped%29.jpg/220px-Premier_Chang_San-cheng_%28cropped%29.jpg');

-- 台中市
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('何欣純', '民進黨', 'politician', '縣市長', '立法委員', '台中市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9d/Ho_Hsin-chun_2020_%28cropped%29.jpg/220px-Ho_Hsin-chun_2020_%28cropped%29.jpg'),
('江啟臣', '國民黨', 'potential', '縣市長', '立法院副院長', '台中市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Johnny_Chiang_2020.jpg/220px-Johnny_Chiang_2020.jpg');

-- 台南市
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('陳亭妃', '民進黨', 'politician', '縣市長', '立法委員', '台南市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Chen_Ting-fei_2020_%28cropped%29.jpg/220px-Chen_Ting-fei_2020_%28cropped%29.jpg'),
('謝龍介', '國民黨', 'politician', '縣市長', '立法委員', '台南市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6d/Hsieh_Lung-chieh_2022.png/220px-Hsieh_Lung-chieh_2022.png');

-- 高雄市
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('賴瑞隆', '民進黨', 'politician', '縣市長', '立法委員', '高雄市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b5/Lai_Jui-lung_%28cropped%29.jpg/220px-Lai_Jui-lung_%28cropped%29.jpg'),
('柯志恩', '國民黨', 'politician', '縣市長', '立法委員', '高雄市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/Ko_Chih-en_20190409_%28cropped%29.jpg/220px-Ko_Chih-en_20190409_%28cropped%29.jpg');

-- 其他縣市

-- 基隆市
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('童子瑋', '民進黨', 'politician', '縣市長', '基隆市議長', '基隆市', NULL),
('謝國樑', '國民黨', 'incumbent', '縣市長', '基隆市長', '基隆市', 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/27/Hsieh_Kuo-liang_2022.png/220px-Hsieh_Kuo-liang_2022.png');

-- 新竹縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('林思銘', '國民黨', 'potential', '縣市長', '立法委員', '新竹縣', NULL);

-- 彰化縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('陳素月', '民進黨', 'politician', '縣市長', '立法委員', '彰化縣', NULL),
('謝衣鳯', '國民黨', 'potential', '縣市長', '立法委員', '彰化縣', NULL);

-- 南投縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('許淑華', '國民黨', 'incumbent', '縣市長', '南投縣長', '南投縣', 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9a/Hsu_Shu-hua_2022.png/220px-Hsu_Shu-hua_2022.png');

-- 雲林縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('劉建國', '民進黨', 'politician', '縣市長', '立法委員', '雲林縣', NULL),
('張嘉郡', '國民黨', 'potential', '縣市長', '立法委員', '雲林縣', NULL);

-- 嘉義市
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('王美惠', '民進黨', 'politician', '縣市長', '立法委員', '嘉義市', NULL),
('張啟楷', '民眾黨', 'politician', '縣市長', '前主播', '嘉義市', NULL);

-- 嘉義縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('蔡易餘', '民進黨', 'politician', '縣市長', '立法委員', '嘉義縣', NULL),
('王育敏', '國民黨', 'politician', '縣市長', '立法委員', '嘉義縣', NULL);

-- 屏東縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('蘇清泉', '國民黨', 'politician', '縣市長', '立法委員', '屏東縣', NULL);

-- 宜蘭縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('林國漳', '民進黨', 'politician', '縣市長', '素人參選', '宜蘭縣', NULL);

-- 花蓮縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('傅崐萁', '國民黨', 'potential', '縣市長', '立法委員', '花蓮縣', 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/Fu_Kun-chi_2020.jpg/220px-Fu_Kun-chi_2020.jpg');

-- 台東縣
INSERT INTO politicians (name, party, status, election_type, position, region, avatar_url) VALUES
('吳秀華', '國民黨', 'potential', '縣市長', '台東縣議長', '台東縣', NULL);

-- ============================================================
-- 關聯選舉 (所有候選人關聯到 2026 九合一選舉)
-- ============================================================

INSERT INTO politician_elections (politician_id, election_id)
SELECT id, 1 FROM politicians;
