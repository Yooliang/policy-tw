-- ============================================================
-- 2026 縣市長登記參選名單匯入（由 scripts/2026-registered-dryrun.mjs 於 2026-09-11T08:46:42.164Z 產生）
-- 來源：中央社 2026-09-04 https://www.cna.com.tw/news/aipl/202609045002.aspx
-- 計畫：matched 40（更新／補 2026 PE 為 registered）、new 27（建人物＋PE）、ambiguous 14（進待審不建）、not_running 90
-- 前提：migration 20260912000001（candidate_status 加 registered/qualified/not_running）與 20260911000001~3 已套
-- 先原樣跑（結尾 ROLLBACK）看 NOTICE 全 ok，再改 COMMIT 跑第二次；跑完另開連線查：
--   SELECT candidate_status, COUNT(*) FROM politician_elections WHERE election_id = 2026 AND election_type = '縣市長' GROUP BY 1;
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_count(label TEXT, actual BIGINT, expected BIGINT) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF actual <> expected THEN RAISE EXCEPTION 'ASSERT FAILED [%]: expected %, got %', label, expected, actual; END IF;
  RAISE NOTICE 'ok [%] = %', label, actual;
  RETURN 'ok';
END; $$;

SELECT pg_temp.assert_count('2026 縣市長 PE before', (SELECT COUNT(*) FROM politician_elections WHERE election_id = 2026 AND election_type = '縣市長'), 134);
SELECT pg_temp.assert_count('同名人物 before', (SELECT COUNT(*) FROM politicians WHERE name IN ('郭璽', '沈伯洋', '蕭文乾', '唐新民', '蔣萬安', '林志成', '蘇巧慧', '李四川', '蘇輝湟', '張善政', '黃世杰', '何欣純', '江啟臣', '洪麗華', '蕭燐洪', '謝龍介', '葉人文', '陳亭妃', '張靜', '賴瑞隆', '王肇民', '柯志恩', '洪方隆', '謝國樑', '魏造文', '童子瑋', '高虹安', '莊競程', '何志勇', '鄭朝方', '朱定瑀', '徐欣瑩', '陳品安', '鍾東錦', '温世政', '許淑華', '陳重嘉', '陳素月', '邱建富', '魏平政', '吳炳輝', '張嘉郡', '劉建國', '林佳瑜', '黃宏成台灣阿成世界偉人財神總統', '陳愷璜', '張啓楷', '王美惠', '王義成', '吳品叡', '蔡易餘', '蘇清泉', '周春米', '陳宏毅', '吳宗憲', '劉燦輝', '林國漳', '楊鉯婷', '陳瑩', '吳秀華', '李吳穎智', '王志偉', '游淑貞', '張峻', '魏嘉賢', '羅佩秦', '吳淑瑾', '陳振中', '周倪安', '許智富', '陳盡川', '葉竹林', '洪和成', '陳玉珍', '李文良', '黃世團', '張國威', '梁文韜', '張火木', '王忠銘', '曹爾元')), 63);

-- ---------- matched：更新／補 2026 參選紀錄 ----------
-- 台北市 民主進步黨 沈伯洋（現任立法委員）→ a0823a44-f0dd-4086-88ad-fcc8f0a1a831  [沈伯洋|立法委員, 沈伯洋|民主進步黨, 沈伯洋|台北市|縣市長, 沈伯洋|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3533), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35042 AND politician_id = 'a0823a44-f0dd-4086-88ad-fcc8f0a1a831';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = 'a0823a44-f0dd-4086-88ad-fcc8f0a1a831';
-- 台北市 三勢團結促進聯盟 唐新民（）→ 33ea63ad-5f9d-4d19-a5b3-c117481f4c68  [唐新民|台北市|縣市長, 唐新民|縣市長]
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('33ea63ad-5f9d-4d19-a5b3-c117481f4c68', 2026, '縣市長候選人', '縣市長', 3533, 'registered', false, '中央社 2026-09-04 登記參選名單');
UPDATE politicians SET current_position = COALESCE(current_position, NULL), party = '三勢團結促進聯盟' WHERE id = '33ea63ad-5f9d-4d19-a5b3-c117481f4c68';
-- 台北市 中國國民黨 蔣萬安（現任台北市長）→ 1ff15d21-9de4-4af0-8e1d-98965a82da3b  [蔣萬安|台北市|縣市長, 蔣萬安|縣市長, 蔣萬安|中國國民黨]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3533), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34939 AND politician_id = '1ff15d21-9de4-4af0-8e1d-98965a82da3b';
UPDATE politicians SET current_position = COALESCE(current_position, '現任台北市長'), party = '中國國民黨' WHERE id = '1ff15d21-9de4-4af0-8e1d-98965a82da3b';
-- 新北市 民主進步黨 蘇巧慧（現任立法委員）→ b8d91049-ee19-462a-9fd9-a8ecb7043265  [蘇巧慧|縣市長, 蘇巧慧|新北市|縣市長, 蘇巧慧|立法委員, 蘇巧慧|民主進步黨]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 7393), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34723 AND politician_id = 'b8d91049-ee19-462a-9fd9-a8ecb7043265';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = 'b8d91049-ee19-462a-9fd9-a8ecb7043265';
-- 新北市 中國國民黨 李四川（前台北市副市長）→ 98b8b1ff-d085-4597-8384-a02461f773f6  [李四川|中國國民黨, 李四川|新北市|縣市長, 李四川|副縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 7393), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 4 AND politician_id = '98b8b1ff-d085-4597-8384-a02461f773f6';
UPDATE politicians SET current_position = COALESCE(current_position, '前台北市副市長'), party = '中國國民黨' WHERE id = '98b8b1ff-d085-4597-8384-a02461f773f6';
-- 桃園市 中國國民黨 張善政（現任桃園市長）→ 84fc02ce-a897-448a-86fd-3cd36d271819  [張善政|中國國民黨, 張善政|縣市長, 張善政|桃園市|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 6668), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34943 AND politician_id = '84fc02ce-a897-448a-86fd-3cd36d271819';
UPDATE politicians SET current_position = COALESCE(current_position, '現任桃園市長'), party = '中國國民黨' WHERE id = '84fc02ce-a897-448a-86fd-3cd36d271819';
-- 桃園市 民主進步黨 黃世杰（前法務部政務次長）→ a3b8cf85-bb29-48c5-9e8c-72f53a7626d9  [黃世杰|桃園市|縣市長, 黃世杰|民主進步黨, 黃世杰|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 6668), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34964 AND politician_id = 'a3b8cf85-bb29-48c5-9e8c-72f53a7626d9';
UPDATE politicians SET current_position = COALESCE(current_position, '前法務部政務次長'), party = '民主進步黨' WHERE id = 'a3b8cf85-bb29-48c5-9e8c-72f53a7626d9';
-- 台中市 民主進步黨 何欣純（現任立法委員）→ 2ec01de6-2588-4fcf-9429-014c4b71bce4  [何欣純|縣市長, 何欣純|立法委員, 何欣純|民主進步黨, 何欣純|台中市|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 6038), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34724 AND politician_id = '2ec01de6-2588-4fcf-9429-014c4b71bce4';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = '2ec01de6-2588-4fcf-9429-014c4b71bce4';
-- 台中市 中國國民黨 江啟臣（立法院副院長）→ 4329acf0-b3bf-4dac-9aa1-5434217946fc  [江啟臣|台中市|縣市長, 江啟臣|中國國民黨, 江啟臣|立法委員]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 6038), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 7 AND politician_id = '4329acf0-b3bf-4dac-9aa1-5434217946fc';
UPDATE politicians SET current_position = COALESCE(current_position, '立法院副院長'), party = '中國國民黨' WHERE id = '4329acf0-b3bf-4dac-9aa1-5434217946fc';
-- 台南市 中國國民黨 謝龍介（現任立法委員）→ 31e3ce58-568b-4e57-a15f-03f1a21acbaa  [謝龍介|中國國民黨, 謝龍介|立法委員, 謝龍介|台南市|縣市長, 謝龍介|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 4175), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34946 AND politician_id = '31e3ce58-568b-4e57-a15f-03f1a21acbaa';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '中國國民黨' WHERE id = '31e3ce58-568b-4e57-a15f-03f1a21acbaa';
-- 台南市 民主進步黨 陳亭妃（現任立法委員）→ 41ca213e-995e-4caf-a231-876ff9872a71  [陳亭妃|台南市|縣市長, 陳亭妃|民主進步黨, 陳亭妃|縣市長, 陳亭妃|立法委員]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 4175), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34725 AND politician_id = '41ca213e-995e-4caf-a231-876ff9872a71';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = '41ca213e-995e-4caf-a231-876ff9872a71';
-- 高雄市 民主進步黨 賴瑞隆（現任立法委員）→ b6d90c2a-723a-496c-9900-0d12a7677c90  [賴瑞隆|民主進步黨, 賴瑞隆|立法委員, 賴瑞隆|高雄市|縣市長, 賴瑞隆|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 930), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34726 AND politician_id = 'b6d90c2a-723a-496c-9900-0d12a7677c90';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = 'b6d90c2a-723a-496c-9900-0d12a7677c90';
-- 高雄市 中國國民黨 柯志恩（現任立法委員）→ d14801ae-e972-4538-b81e-15025878a739  [柯志恩|中國國民黨, 柯志恩|縣市長, 柯志恩|高雄市|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 930), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34948 AND politician_id = 'd14801ae-e972-4538-b81e-15025878a739';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '中國國民黨' WHERE id = 'd14801ae-e972-4538-b81e-15025878a739';
-- 基隆市 中國國民黨 謝國樑（現任基隆市長）→ 6a477da7-2bb4-4c36-91b0-0008b2c22f1c  [謝國樑|基隆市|縣市長, 謝國樑|中國國民黨, 謝國樑|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3402), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34952 AND politician_id = '6a477da7-2bb4-4c36-91b0-0008b2c22f1c';
UPDATE politicians SET current_position = COALESCE(current_position, '現任基隆市長'), party = '中國國民黨' WHERE id = '6a477da7-2bb4-4c36-91b0-0008b2c22f1c';
-- 基隆市 民主進步黨 童子瑋（現任基隆市議會議長）→ fab097b2-2c5d-46e3-80f0-d469b84c6d33  [童子瑋|縣市議員, 童子瑋|民主進步黨, 童子瑋|基隆市|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3402), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 12 AND politician_id = 'fab097b2-2c5d-46e3-80f0-d469b84c6d33';
UPDATE politicians SET current_position = COALESCE(current_position, '現任基隆市議會議長'), party = '民主進步黨' WHERE id = 'fab097b2-2c5d-46e3-80f0-d469b84c6d33';
-- 新竹市 無黨籍 高虹安（現任新竹市長）→ 66ecf11c-037e-43d0-8c96-ba0b94de4b11  [高虹安|縣市長, 高虹安|新竹市|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 5094), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34972 AND politician_id = '66ecf11c-037e-43d0-8c96-ba0b94de4b11';
UPDATE politicians SET current_position = COALESCE(current_position, '現任新竹市長'), party = '無黨籍' WHERE id = '66ecf11c-037e-43d0-8c96-ba0b94de4b11';
-- 新竹市 民主進步黨 莊競程（台灣智庫執行長、前立法委員）→ 3b746ce2-cf1e-49b5-8919-5226cab12cea  [莊競程|立法委員, 莊競程|民主進步黨]
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('3b746ce2-cf1e-49b5-8919-5226cab12cea', 2026, '縣市長候選人', '縣市長', 5094, 'registered', false, '中央社 2026-09-04 登記參選名單');
UPDATE politicians SET current_position = COALESCE(current_position, '台灣智庫執行長、前立法委員'), party = '民主進步黨' WHERE id = '3b746ce2-cf1e-49b5-8919-5226cab12cea';
-- 新竹縣 中國國民黨 徐欣瑩（現任立法委員）→ 5640579c-b8c9-4690-ad56-abe467eedb71  [徐欣瑩|立法委員, 徐欣瑩|新竹縣|縣市長, 徐欣瑩|中國國民黨, 徐欣瑩|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3398), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34978 AND politician_id = '5640579c-b8c9-4690-ad56-abe467eedb71';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '中國國民黨' WHERE id = '5640579c-b8c9-4690-ad56-abe467eedb71';
-- 苗栗縣 民主進步黨 陳品安（現任苗栗縣議員）→ 63025801-48c3-4ba3-92e7-f0250246d9e4  [陳品安|苗栗縣|縣市長, 陳品安|縣市議員, 陳品安|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 2431), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35396 AND politician_id = '63025801-48c3-4ba3-92e7-f0250246d9e4';
UPDATE politicians SET current_position = COALESCE(current_position, '現任苗栗縣議員'), party = '民主進步黨' WHERE id = '63025801-48c3-4ba3-92e7-f0250246d9e4';
-- 苗栗縣 中國國民黨 鍾東錦（現任苗栗縣長）→ 8abab15c-9bdb-4aaf-9ff4-46f5fcd640b1  [鍾東錦|縣市長, 鍾東錦|苗栗縣|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 2431), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34989 AND politician_id = '8abab15c-9bdb-4aaf-9ff4-46f5fcd640b1';
UPDATE politicians SET current_position = COALESCE(current_position, '現任苗栗縣長'), party = '中國國民黨' WHERE id = '8abab15c-9bdb-4aaf-9ff4-46f5fcd640b1';
-- 南投縣 中國國民黨 許淑華（現任南投縣長）→ 46b9a63f-e5ec-4a7b-b9dc-3624235780e0  [許淑華|縣市長, 許淑華|中國國民黨, 許淑華|南投縣|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 4834), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34999 AND politician_id = '46b9a63f-e5ec-4a7b-b9dc-3624235780e0';
UPDATE politicians SET current_position = COALESCE(current_position, '現任南投縣長'), party = '中國國民黨' WHERE id = '46b9a63f-e5ec-4a7b-b9dc-3624235780e0';
-- 彰化縣 民主進步黨 陳素月（現任立法委員）→ bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9  [陳素月|彰化縣|縣市長, 陳素月|民主進步黨, 陳素月|立法委員, 陳素月|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 5231), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34727 AND politician_id = 'bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = 'bcdfd014-6bf3-49e6-aa7b-d2f42dce10e9';
-- 彰化縣 無黨籍 邱建富（前彰化市長）→ d83efd2c-416e-44af-9a79-5d1d9f4df9ec  [邱建富|縣市長, 邱建富|彰化縣|縣市長, 邱建富|無黨籍]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 5231), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35399 AND politician_id = 'd83efd2c-416e-44af-9a79-5d1d9f4df9ec';
UPDATE politicians SET current_position = COALESCE(current_position, '前彰化市長'), party = '無黨籍' WHERE id = 'd83efd2c-416e-44af-9a79-5d1d9f4df9ec';
-- 雲林縣 無黨籍 吳炳輝（律師）→ 4f5ef190-21bb-4bf6-8c1c-234239982ed3  [吳炳輝|縣市長, 吳炳輝|無黨籍]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3197), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35070 AND politician_id = '4f5ef190-21bb-4bf6-8c1c-234239982ed3';
UPDATE politicians SET current_position = COALESCE(current_position, '律師'), party = '無黨籍' WHERE id = '4f5ef190-21bb-4bf6-8c1c-234239982ed3';
-- 雲林縣 中國國民黨 張嘉郡（現任立法委員）→ 37fc6d18-12fe-48d2-b083-be12ee680c1e  [張嘉郡|縣市長, 張嘉郡|立法委員, 張嘉郡|雲林縣|縣市長, 張嘉郡|中國國民黨]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3197), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34729 AND politician_id = '37fc6d18-12fe-48d2-b083-be12ee680c1e';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '中國國民黨' WHERE id = '37fc6d18-12fe-48d2-b083-be12ee680c1e';
-- 雲林縣 民主進步黨 劉建國（現任立法委員）→ eb9c1d61-7906-4a9d-a523-b75d636c585f  [劉建國|民主進步黨, 劉建國|縣市長, 劉建國|雲林縣|縣市長, 劉建國|立法委員]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3197), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 10048 AND politician_id = 'eb9c1d61-7906-4a9d-a523-b75d636c585f';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = 'eb9c1d61-7906-4a9d-a523-b75d636c585f';
-- 雲林縣 無黨籍 林佳瑜（）→ 2b1cdf33-b2e0-4f6d-8b11-3e3bd2e53e0f  [林佳瑜|雲林縣|縣市長, 林佳瑜|縣市長, 林佳瑜|無黨籍]
INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('2b1cdf33-b2e0-4f6d-8b11-3e3bd2e53e0f', 2026, '縣市長候選人', '縣市長', 3197, 'registered', false, '中央社 2026-09-04 登記參選名單');
UPDATE politicians SET current_position = COALESCE(current_position, NULL), party = '無黨籍' WHERE id = '2b1cdf33-b2e0-4f6d-8b11-3e3bd2e53e0f';
-- 嘉義市 台灣民眾黨 張啓楷（前立法委員）→ 25f582a0-384e-4b30-a429-efc5f0886d00  [張啓楷|縣市長, 張啓楷|台灣民眾黨, 張啓楷|嘉義市|縣市長, 張啓楷|立法委員]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3003), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35365 AND politician_id = '25f582a0-384e-4b30-a429-efc5f0886d00';
UPDATE politicians SET current_position = COALESCE(current_position, '前立法委員'), party = '台灣民眾黨' WHERE id = '25f582a0-384e-4b30-a429-efc5f0886d00';
-- 嘉義市 民主進步黨 王美惠（現任立法委員）→ 3bd74ec3-9aab-444e-abea-43bf217839ef  [王美惠|民主進步黨, 王美惠|立法委員, 王美惠|縣市長, 王美惠|嘉義市|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 3003), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34730 AND politician_id = '3bd74ec3-9aab-444e-abea-43bf217839ef';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = '3bd74ec3-9aab-444e-abea-43bf217839ef';
-- 嘉義縣 民主進步黨 蔡易餘（現任立法委員）→ 4c35a2a2-cd38-42a0-b574-3eabd102456f  [蔡易餘|立法委員, 蔡易餘|民主進步黨, 蔡易餘|縣市長, 蔡易餘|嘉義縣|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 850), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 34731 AND politician_id = '4c35a2a2-cd38-42a0-b574-3eabd102456f';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = '4c35a2a2-cd38-42a0-b574-3eabd102456f';
-- 屏東縣 中國國民黨 蘇清泉（現任立法委員、國民黨屏東縣黨部主委）→ b6e1fec9-c02a-49c8-8290-b9d9ecda7a68  [蘇清泉|屏東縣|縣市長, 蘇清泉|立法委員, 蘇清泉|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 5712), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 24 AND politician_id = 'b6e1fec9-c02a-49c8-8290-b9d9ecda7a68';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員、國民黨屏東縣黨部主委'), party = '中國國民黨' WHERE id = 'b6e1fec9-c02a-49c8-8290-b9d9ecda7a68';
-- 屏東縣 民主進步黨 周春米（現任屏東縣長）→ 9cbb34da-3531-4d37-8db5-468ca8ce372d  [周春米|民主進步黨, 周春米|縣市長, 周春米|屏東縣|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 5712), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35008 AND politician_id = '9cbb34da-3531-4d37-8db5-468ca8ce372d';
UPDATE politicians SET current_position = COALESCE(current_position, '現任屏東縣長'), party = '民主進步黨' WHERE id = '9cbb34da-3531-4d37-8db5-468ca8ce372d';
-- 宜蘭縣 中國國民黨 吳宗憲（現任立法委員）→ 5534465f-6c68-4d03-ad0b-223b2b97a31e  [吳宗憲|縣市長, 吳宗憲|立法委員, 吳宗憲|宜蘭縣|縣市長, 吳宗憲|中國國民黨]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 5103), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35376 AND politician_id = '5534465f-6c68-4d03-ad0b-223b2b97a31e';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '中國國民黨' WHERE id = '5534465f-6c68-4d03-ad0b-223b2b97a31e';
-- 宜蘭縣 民主進步黨 林國漳（律師）→ d7ae719a-08ac-4152-a71e-f8256c5561a8  [林國漳|縣市長, 林國漳|民主進步黨, 林國漳|宜蘭縣|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 5103), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 25 AND politician_id = 'd7ae719a-08ac-4152-a71e-f8256c5561a8';
UPDATE politicians SET current_position = COALESCE(current_position, '律師'), party = '民主進步黨' WHERE id = 'd7ae719a-08ac-4152-a71e-f8256c5561a8';
-- 台東縣 民主進步黨 陳瑩（現任立法委員）→ 8aa6ee40-231a-447a-a967-99bcf8b35d3f  [陳瑩|縣市長, 陳瑩|立法委員, 陳瑩|台東縣|縣市長, 陳瑩|民主進步黨]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 6904), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35367 AND politician_id = '8aa6ee40-231a-447a-a967-99bcf8b35d3f';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員'), party = '民主進步黨' WHERE id = '8aa6ee40-231a-447a-a967-99bcf8b35d3f';
-- 台東縣 中國國民黨 吳秀華（現任台東縣議會議長）→ 9f81d161-51ad-43ad-bd4b-d1c5747257ea  [吳秀華|縣市議員, 吳秀華|台東縣|縣市長, 吳秀華|中國國民黨]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 6904), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 27 AND politician_id = '9f81d161-51ad-43ad-bd4b-d1c5747257ea';
UPDATE politicians SET current_position = COALESCE(current_position, '現任台東縣議會議長'), party = '中國國民黨' WHERE id = '9f81d161-51ad-43ad-bd4b-d1c5747257ea';
-- 澎湖縣 無黨籍 葉竹林（前馬公市長）→ 27e27e39-31ac-4232-8416-e7e628b22aeb  [葉竹林|澎湖縣|縣市長, 葉竹林|縣市長, 葉竹林|無黨籍]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 6917), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35381 AND politician_id = '27e27e39-31ac-4232-8416-e7e628b22aeb';
UPDATE politicians SET current_position = COALESCE(current_position, '前馬公市長'), party = '無黨籍' WHERE id = '27e27e39-31ac-4232-8416-e7e628b22aeb';
-- 金門縣 中國國民黨 陳玉珍（現任立法委員、國民黨金門縣黨部主委）→ 7da40d2d-9e0e-4bd1-aded-26269be0a9bd  [陳玉珍|中國國民黨, 陳玉珍|縣市長, 陳玉珍|立法委員]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 7892), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35033 AND politician_id = '7da40d2d-9e0e-4bd1-aded-26269be0a9bd';
UPDATE politicians SET current_position = COALESCE(current_position, '現任立法委員、國民黨金門縣黨部主委'), party = '中國國民黨' WHERE id = '7da40d2d-9e0e-4bd1-aded-26269be0a9bd';
-- 連江縣 中國國民黨 王忠銘（現任連江縣長）→ 82915043-9e5e-43df-8429-d25802579432  [王忠銘|縣市長, 王忠銘|連江縣|縣市長, 王忠銘|中國國民黨]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 461), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35036 AND politician_id = '82915043-9e5e-43df-8429-d25802579432';
UPDATE politicians SET current_position = COALESCE(current_position, '現任連江縣長'), party = '中國國民黨' WHERE id = '82915043-9e5e-43df-8429-d25802579432';
-- 連江縣 無黨籍 曹爾元（前連江縣地政局長）→ baae6950-6718-42bd-9a7e-69ab37f53d19  [曹爾元|連江縣|縣市長, 曹爾元|縣市長]
UPDATE politician_elections SET candidate_status = 'registered', position = '縣市長候選人', election_type = '縣市長', region_id = COALESCE(region_id, 461), source_note = '中央社 2026-09-04 登記參選名單' WHERE id = 35037 AND politician_id = 'baae6950-6718-42bd-9a7e-69ab37f53d19';
UPDATE politicians SET current_position = COALESCE(current_position, '前連江縣地政局長'), party = '無黨籍' WHERE id = 'baae6950-6718-42bd-9a7e-69ab37f53d19';

-- ---------- new：建人物＋參選紀錄（觸發器會自動產 politician_keys） ----------
-- 台北市 台灣SoR無法黨 蕭文乾（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('蕭文乾', '台灣SoR無法黨', 'politician', '縣市長', '縣市長候選人', NULL, '台北市', 3533)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 3533, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 台南市 台灣SoR無法黨 蕭燐洪（） ⚠ same_name_exists
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('蕭燐洪', '台灣SoR無法黨', 'politician', '縣市長', '縣市長候選人', NULL, '台南市', 4175)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 4175, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 台南市 無黨籍 葉人文（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('葉人文', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '台南市', 4175)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 4175, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 高雄市 司法改革黨 張靜（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('張靜', '司法改革黨', 'politician', '縣市長', '縣市長候選人', NULL, '高雄市', 930)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 930, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 高雄市 無黨籍 王肇民（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('王肇民', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '高雄市', 930)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 930, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 高雄市 無黨籍 洪方隆（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('洪方隆', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '高雄市', 930)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 930, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 基隆市 無黨籍 魏造文（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('魏造文', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '基隆市', 3402)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 3402, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 新竹市 無黨籍 何志勇（國民黨前發言人） ⚠ same_name_exists
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('何志勇', '無黨籍', 'politician', '縣市長', '縣市長候選人', '國民黨前發言人', '新竹市', 5094)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 5094, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 新竹縣 無黨籍 朱定瑀（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('朱定瑀', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '新竹縣', 3398)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 3398, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 南投縣 民主進步黨 温世政（新北市牙醫師公會理事長）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('温世政', '民主進步黨', 'politician', '縣市長', '縣市長候選人', '新北市牙醫師公會理事長', '南投縣', 4834)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 4834, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 彰化縣 中國國民黨 魏平政（律師、前國民黨考紀會主委）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('魏平政', '中國國民黨', 'politician', '縣市長', '縣市長候選人', '律師、前國民黨考紀會主委', '彰化縣', 5231)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 5231, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 嘉義市 無黨籍 黃宏成台灣阿成世界偉人財神總統（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('黃宏成台灣阿成世界偉人財神總統', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '嘉義市', 3003)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 3003, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 嘉義市 無黨籍 陳愷璜（前國立台北藝術大學校長）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('陳愷璜', '無黨籍', 'politician', '縣市長', '縣市長候選人', '前國立台北藝術大學校長', '嘉義市', 3003)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 3003, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 嘉義市 無黨籍 王義成（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('王義成', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '嘉義市', 3003)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 3003, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 宜蘭縣 無黨籍 陳宏毅（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('陳宏毅', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '宜蘭縣', 5103)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 5103, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 宜蘭縣 無黨籍 楊鉯婷（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('楊鉯婷', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '宜蘭縣', 5103)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 5103, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 台東縣 無黨籍 李吳穎智（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('李吳穎智', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '台東縣', 6904)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 6904, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 台東縣 無黨籍 王志偉（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('王志偉', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '台東縣', 6904)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 6904, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 花蓮縣 台灣工黨 羅佩秦（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('羅佩秦', '台灣工黨', 'politician', '縣市長', '縣市長候選人', NULL, '花蓮縣', 2576)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 2576, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 澎湖縣 民主進步黨 吳淑瑾（現任澎湖縣長陳光復之妻）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('吳淑瑾', '民主進步黨', 'politician', '縣市長', '縣市長候選人', '現任澎湖縣長陳光復之妻', '澎湖縣', 6917)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 6917, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 澎湖縣 台灣團結聯盟 周倪安（台灣團結聯盟黨主席）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('周倪安', '台灣團結聯盟', 'politician', '縣市長', '縣市長候選人', '台灣團結聯盟黨主席', '澎湖縣', 6917)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 6917, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 澎湖縣 無黨籍 許智富（前澎湖縣副縣長） ⚠ same_name_exists
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('許智富', '無黨籍', 'politician', '縣市長', '縣市長候選人', '前澎湖縣副縣長', '澎湖縣', 6917)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 6917, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 澎湖縣 無黨籍 陳盡川（海洋志工）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('陳盡川', '無黨籍', 'politician', '縣市長', '縣市長候選人', '海洋志工', '澎湖縣', 6917)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 6917, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 金門縣 無黨籍 黃世團（藝術家）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('黃世團', '無黨籍', 'politician', '縣市長', '縣市長候選人', '藝術家', '金門縣', 7892)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 7892, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 金門縣 無黨籍 張國威（企業家）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('張國威', '無黨籍', 'politician', '縣市長', '縣市長候選人', '企業家', '金門縣', 7892)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 7892, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 金門縣 無黨籍 梁文韜（國立成功大學政治學系教授）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('梁文韜', '無黨籍', 'politician', '縣市長', '縣市長候選人', '國立成功大學政治學系教授', '金門縣', 7892)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 7892, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;
-- 金門縣 無黨籍 張火木（）
WITH ins AS (
  INSERT INTO politicians (name, party, status, election_type, position, current_position, region, region_id)
  VALUES ('張火木', '無黨籍', 'politician', '縣市長', '縣市長候選人', NULL, '金門縣', 7892)
  RETURNING id
) INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note)
  SELECT id, 2026, '縣市長候選人', '縣市長', 7892, 'registered', false, '中央社 2026-09-04 登記參選名單' FROM ins;

-- ---------- ambiguous：不建，進待審 ----------
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"郭璽","party":"台灣麻將最大黨","party_as_written":"台灣麻將最大黨","region":"台北市","position":"縣市長候選人","election_type":"縣市長","current_position":"海軍退役上校、前海軍司令部顧問","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"dc6244b8-8c40-4577-b7e0-bded8fd16343","name":"郭璽","score":1,"matched_keys":[{"key_type":"party","key_value":"郭璽|台灣麻將最大黨","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"林志成","party":"無黨籍","party_as_written":"無黨籍","region":"台北市","position":"縣市長候選人","election_type":"縣市長","current_position":null,"source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"169a0f08-8ddd-490d-9dbd-7ad4d7b57a74","name":"林志成","score":1,"matched_keys":[{"key_type":"party","key_value":"林志成|無黨籍","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"蘇輝湟","party":"無黨籍","party_as_written":"無黨籍","region":"新北市","position":"縣市長候選人","election_type":"縣市長","current_position":null,"source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"8dfe6283-a487-4e48-98bf-24b954a7afb8","name":"蘇輝湟","score":1,"matched_keys":[{"key_type":"party","key_value":"蘇輝湟|無黨籍","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"洪麗華","party":"司法正義黨","party_as_written":"司法正義黨","region":"台中市","position":"縣市長候選人","election_type":"縣市長","current_position":null,"source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"424f32c0-0432-4952-a069-06b74802995a","name":"洪麗華","score":1,"matched_keys":[{"key_type":"party","key_value":"洪麗華|司法正義黨","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"鄭朝方","party":"民主進步黨","party_as_written":"民進黨","region":"新竹縣","position":"縣市長候選人","election_type":"縣市長","current_position":"現任竹北市長","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"5c8a393d-e9aa-4191-8589-b20363b647d1","name":"鄭朝方","score":1,"matched_keys":[{"key_type":"party","key_value":"鄭朝方|民主進步黨","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"陳重嘉","party":"無黨籍","party_as_written":"無黨籍","region":"彰化縣","position":"縣市長候選人","election_type":"縣市長","current_position":"現任彰化縣議員","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"f4375108-b04f-493f-8061-3af9e1846b2c","name":"陳重嘉","score":1,"matched_keys":[{"key_type":"position","key_value":"陳重嘉|縣市議員","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"吳品叡","party":"無黨籍","party_as_written":"無黨籍","region":"嘉義縣","position":"縣市長候選人","election_type":"縣市長","current_position":"現任朴子市長","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"732cbaa2-e596-4609-980c-a7800f946e65","name":"吳品叡","score":1,"matched_keys":[{"key_type":"party","key_value":"吳品叡|無黨籍","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"劉燦輝","party":"無黨籍","party_as_written":"無黨籍","region":"宜蘭縣","position":"縣市長候選人","election_type":"縣市長","current_position":null,"source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"f306fb07-6552-465e-acbe-861bf5c36f91","name":"劉燦輝","score":1,"matched_keys":[{"key_type":"party","key_value":"劉燦輝|無黨籍","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"游淑貞","party":"中國國民黨","party_as_written":"國民黨","region":"花蓮縣","position":"縣市長候選人","election_type":"縣市長","current_position":"現任花蓮縣吉安鄉長","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"6fbcdc48-8d20-46f4-94e0-93ddb964c85a","name":"游淑貞","score":2,"matched_keys":[{"key_type":"position","key_value":"游淑貞|鄉鎮市長","strength":1},{"key_type":"party","key_value":"游淑貞|中國國民黨","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 2）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"張峻","party":"無黨籍","party_as_written":"無黨籍","region":"花蓮縣","position":"縣市長候選人","election_type":"縣市長","current_position":"現任花蓮縣議會議長","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"6dbcd6c6-8a4a-4a78-b4b2-f5b848f8f439","name":"張峻","score":2,"matched_keys":[{"key_type":"party","key_value":"張峻|無黨籍","strength":1},{"key_type":"position","key_value":"張峻|縣市議員","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 2）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"魏嘉賢","party":"無黨籍","party_as_written":"無黨籍","region":"花蓮縣","position":"縣市長候選人","election_type":"縣市長","current_position":"現任花蓮縣議員、前花蓮市長","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"ad627063-38e6-4bfb-ac84-8d1468d64ce3","name":"魏嘉賢","score":2,"matched_keys":[{"key_type":"position","key_value":"魏嘉賢|縣市議員","strength":1},{"key_type":"party","key_value":"魏嘉賢|無黨籍","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 2）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"陳振中","party":"中國國民黨","party_as_written":"國民黨","region":"澎湖縣","position":"縣市長候選人","election_type":"縣市長","current_position":"前湖西鄉長","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"f5f0aef0-2a8d-48ca-a4b2-39a9e142a8a5","name":"陳振中","score":2,"matched_keys":[{"key_type":"position","key_value":"陳振中|鄉鎮市長","strength":1},{"key_type":"party","key_value":"陳振中|中國國民黨","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 2）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"洪和成","party":"無黨籍","party_as_written":"無黨籍","region":"金門縣","position":"縣市長候選人","election_type":"縣市長","current_position":null,"source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"7f997bff-1359-47d9-8486-efb8d788e0f6","name":"洪和成","score":1,"matched_keys":[{"key_type":"party","key_value":"洪和成|無黨籍","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');
INSERT INTO politician_identity_reviews (candidate, candidates, reason, source) VALUES ('{"name":"李文良","party":"無黨籍","party_as_written":"無黨籍","region":"金門縣","position":"縣市長候選人","election_type":"縣市長","current_position":"前金門縣副縣長","source":"中央社 2026-09-04","source_url":"https://www.cna.com.tw/news/aipl/202609045002.aspx"}'::jsonb, '[{"politician_id":"2222473c-9c91-4482-a752-1b1667427125","name":"李文良","score":1,"matched_keys":[{"key_type":"party","key_value":"李文良|無黨籍","strength":1}]}]'::jsonb, '唯一候選但只有弱面向命中（分數 1）', 'cna-2026-registered');

-- ---------- 收尾：AI 猜的、但沒登記 → not_running（90 筆） ----------
UPDATE politician_elections SET candidate_status = 'not_running' WHERE id IN (1, 3, 9897, 9914, 9925, 10024, 10040, 10072, 34732, 34940, 34941, 34942, 34944, 34945, 34947, 34949, 34950, 34951, 34953, 34954, 34955, 34956, 34957, 34960, 34961, 34962, 34963, 34965, 34966, 34967, 34968, 34969, 34970, 34971, 34973, 34974, 34975, 34977, 34979, 34980, 34981, 34982, 34983, 34985, 34986, 34987, 34988, 34990, 34991, 34992, 34993, 34994, 34995, 34997, 34998, 35000, 35001, 35002, 35003, 35004, 35005, 35006, 35010, 35011, 35012, 35013, 35014, 35015, 35016, 35017, 35019, 35020, 35021, 35022, 35023, 35024, 35026, 35027, 35028, 35029, 35030, 35031, 35032, 35034, 35038, 35043, 35371, 35375, 35379, 35398) AND election_id = 2026 AND candidate_status <> 'registered';

-- ---------- 事後檢查 ----------
SELECT pg_temp.assert_count('registered', (SELECT COUNT(*) FROM politician_elections WHERE election_id = 2026 AND election_type = '縣市長' AND candidate_status = 'registered'), 67);
SELECT pg_temp.assert_count('not_running', (SELECT COUNT(*) FROM politician_elections WHERE election_id = 2026 AND election_type = '縣市長' AND candidate_status = 'not_running'), 90);
SELECT pg_temp.assert_count('new politicians', (SELECT COUNT(*) FROM politicians WHERE name IN ('郭璽', '沈伯洋', '蕭文乾', '唐新民', '蔣萬安', '林志成', '蘇巧慧', '李四川', '蘇輝湟', '張善政', '黃世杰', '何欣純', '江啟臣', '洪麗華', '蕭燐洪', '謝龍介', '葉人文', '陳亭妃', '張靜', '賴瑞隆', '王肇民', '柯志恩', '洪方隆', '謝國樑', '魏造文', '童子瑋', '高虹安', '莊競程', '何志勇', '鄭朝方', '朱定瑀', '徐欣瑩', '陳品安', '鍾東錦', '温世政', '許淑華', '陳重嘉', '陳素月', '邱建富', '魏平政', '吳炳輝', '張嘉郡', '劉建國', '林佳瑜', '黃宏成台灣阿成世界偉人財神總統', '陳愷璜', '張啓楷', '王美惠', '王義成', '吳品叡', '蔡易餘', '蘇清泉', '周春米', '陳宏毅', '吳宗憲', '劉燦輝', '林國漳', '楊鉯婷', '陳瑩', '吳秀華', '李吳穎智', '王志偉', '游淑貞', '張峻', '魏嘉賢', '羅佩秦', '吳淑瑾', '陳振中', '周倪安', '許智富', '陳盡川', '葉竹林', '洪和成', '陳玉珍', '李文良', '黃世團', '張國威', '梁文韜', '張火木', '王忠銘', '曹爾元')), 90);
SELECT pg_temp.assert_count('reviews', (SELECT COUNT(*) FROM politician_identity_reviews WHERE source = 'cna-2026-registered'), 14);

-- ---------- 人工確認「ambiguous 其實就是那個人」時，逐條解除註解（會取代上面對應的 reviews 插入，請一併刪掉那列）----------
-- 台北市 台灣麻將最大黨 郭璽（海軍退役上校、前海軍司令部顧問）↔ dc6244b8-8c40-4577-b7e0-bded8fd16343（高雄市／立法委員／台灣麻將最大黨／立委候選人／1958年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('dc6244b8-8c40-4577-b7e0-bded8fd16343', 2026, '縣市長候選人', '縣市長', 3533, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '海軍退役上校、前海軍司令部顧問'), party = '台灣麻將最大黨' WHERE id = 'dc6244b8-8c40-4577-b7e0-bded8fd16343';
-- 台北市 無黨籍 林志成（）↔ 169a0f08-8ddd-490d-9dbd-7ad4d7b57a74（新北市／村里長／無黨籍及未經政黨推薦／村里長候選人／1956年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('169a0f08-8ddd-490d-9dbd-7ad4d7b57a74', 2026, '縣市長候選人', '縣市長', 3533, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, NULL), party = '無黨籍' WHERE id = '169a0f08-8ddd-490d-9dbd-7ad4d7b57a74';
-- 新北市 無黨籍 蘇輝湟（）↔ 8dfe6283-a487-4e48-98bf-24b954a7afb8（新北市／立法委員／無黨籍及未經政黨推薦／立委候選人／1976年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('8dfe6283-a487-4e48-98bf-24b954a7afb8', 2026, '縣市長候選人', '縣市長', 7393, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, NULL), party = '無黨籍' WHERE id = '8dfe6283-a487-4e48-98bf-24b954a7afb8';
-- 台中市 司法正義黨 洪麗華（）↔ 424f32c0-0432-4952-a069-06b74802995a（台中市／立法委員／司法正義黨／立委候選人／1961年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('424f32c0-0432-4952-a069-06b74802995a', 2026, '縣市長候選人', '縣市長', 6038, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, NULL), party = '司法正義黨' WHERE id = '424f32c0-0432-4952-a069-06b74802995a';
-- 新竹縣 民主進步黨 鄭朝方（現任竹北市長）↔ 5c8a393d-e9aa-4191-8589-b20363b647d1（新竹縣／鄉鎮市長／民主進步黨／鄉鎮市長候選人／1980年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('5c8a393d-e9aa-4191-8589-b20363b647d1', 2026, '縣市長候選人', '縣市長', 3398, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '現任竹北市長'), party = '民主進步黨' WHERE id = '5c8a393d-e9aa-4191-8589-b20363b647d1';
-- 彰化縣 無黨籍 陳重嘉（現任彰化縣議員）↔ f4375108-b04f-493f-8061-3af9e1846b2c（彰化縣／縣市議員／台灣民眾黨／縣市議員候選人／1981年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('f4375108-b04f-493f-8061-3af9e1846b2c', 2026, '縣市長候選人', '縣市長', 5231, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '現任彰化縣議員'), party = '無黨籍' WHERE id = 'f4375108-b04f-493f-8061-3af9e1846b2c';
-- 嘉義縣 無黨籍 吳品叡（現任朴子市長）↔ 732cbaa2-e596-4609-980c-a7800f946e65（嘉義縣／鄉鎮市長／無黨籍及未經政黨推薦／鄉鎮市長候選人／1986年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('732cbaa2-e596-4609-980c-a7800f946e65', 2026, '縣市長候選人', '縣市長', 850, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '現任朴子市長'), party = '無黨籍' WHERE id = '732cbaa2-e596-4609-980c-a7800f946e65';
-- 宜蘭縣 無黨籍 劉燦輝（）↔ f306fb07-6552-465e-acbe-861bf5c36f91（宜蘭縣／鄉鎮市長／無黨籍及未經政黨推薦／鄉鎮市長候選人／1963年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('f306fb07-6552-465e-acbe-861bf5c36f91', 2026, '縣市長候選人', '縣市長', 5103, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, NULL), party = '無黨籍' WHERE id = 'f306fb07-6552-465e-acbe-861bf5c36f91';
-- 花蓮縣 中國國民黨 游淑貞（現任花蓮縣吉安鄉長）↔ 6fbcdc48-8d20-46f4-94e0-93ddb964c85a（花蓮縣／鄉鎮市長／中國國民黨／鄉鎮市長候選人／1967年生，分數 2）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('6fbcdc48-8d20-46f4-94e0-93ddb964c85a', 2026, '縣市長候選人', '縣市長', 2576, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '現任花蓮縣吉安鄉長'), party = '中國國民黨' WHERE id = '6fbcdc48-8d20-46f4-94e0-93ddb964c85a';
-- 花蓮縣 無黨籍 張峻（現任花蓮縣議會議長）↔ 6dbcd6c6-8a4a-4a78-b4b2-f5b848f8f439（花蓮縣／縣市議員／無黨籍及未經政黨推薦／縣市議員候選人／1974年生，分數 2）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('6dbcd6c6-8a4a-4a78-b4b2-f5b848f8f439', 2026, '縣市長候選人', '縣市長', 2576, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '現任花蓮縣議會議長'), party = '無黨籍' WHERE id = '6dbcd6c6-8a4a-4a78-b4b2-f5b848f8f439';
-- 花蓮縣 無黨籍 魏嘉賢（現任花蓮縣議員、前花蓮市長）↔ ad627063-38e6-4bfb-ac84-8d1468d64ce3（花蓮縣／縣市議員／無黨籍及未經政黨推薦／縣市議員候選人／1978年生，分數 2）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('ad627063-38e6-4bfb-ac84-8d1468d64ce3', 2026, '縣市長候選人', '縣市長', 2576, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '現任花蓮縣議員、前花蓮市長'), party = '無黨籍' WHERE id = 'ad627063-38e6-4bfb-ac84-8d1468d64ce3';
-- 澎湖縣 中國國民黨 陳振中（前湖西鄉長）↔ f5f0aef0-2a8d-48ca-a4b2-39a9e142a8a5（澎湖縣／鄉鎮市長／中國國民黨／鄉鎮市長候選人／1963年生，分數 2）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('f5f0aef0-2a8d-48ca-a4b2-39a9e142a8a5', 2026, '縣市長候選人', '縣市長', 6917, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '前湖西鄉長'), party = '中國國民黨' WHERE id = 'f5f0aef0-2a8d-48ca-a4b2-39a9e142a8a5';
-- 金門縣 無黨籍 洪和成（）↔ 7f997bff-1359-47d9-8486-efb8d788e0f6（連江縣／立法委員／無黨籍及未經政黨推薦／立委候選人／1961年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('7f997bff-1359-47d9-8486-efb8d788e0f6', 2026, '縣市長候選人', '縣市長', 7892, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, NULL), party = '無黨籍' WHERE id = '7f997bff-1359-47d9-8486-efb8d788e0f6';
-- 金門縣 無黨籍 李文良（前金門縣副縣長）↔ 2222473c-9c91-4482-a752-1b1667427125（台南市／村里長／無黨籍及未經政黨推薦／村里長候選人／1961年生，分數 1）
-- INSERT INTO politician_elections (politician_id, election_id, position, election_type, region_id, candidate_status, verified, source_note) VALUES ('2222473c-9c91-4482-a752-1b1667427125', 2026, '縣市長候選人', '縣市長', 7892, 'registered', false, '中央社 2026-09-04 登記參選名單');
-- UPDATE politicians SET current_position = COALESCE(current_position, '前金門縣副縣長'), party = '無黨籍' WHERE id = '2222473c-9c91-4482-a752-1b1667427125';

-- ---------- 異體字：人工確認同一人後，先補 alias_name 再重跑 dry-run，就會 matched ----------
-- INSERT INTO politician_keys (politician_id, key_type, key_value, strength, source) VALUES ('cc11e79b-ca51-44bd-b8fe-6ca9854ca65a', 'alias_name', '張啓楷', 3, 'manual:variant') ON CONFLICT DO NOTHING;  -- DB「張啟楷」← 名單「張啓楷」

ROLLBACK; -- 主線審過後改成 COMMIT
