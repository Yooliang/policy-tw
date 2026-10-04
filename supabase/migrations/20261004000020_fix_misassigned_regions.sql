-- 參選紀錄的地區錯置與空白：桃園市復興區被存成台南市（20 筆）、2026 已登記的 102 筆沒有地區
-- （2026-10-04，維護者點頭修）
--
-- 兩個問題都是「查得到資料、但地區欄位把人放錯地方或根本沒放」，網站不會報錯，只是撈不到人：
-- get_politicians_by_filters 是 politician_elections LEFT JOIN regions 再比 r.region = 選的縣市，
-- region_id 空的那一筆，用任何縣市篩選都不會出現、也不會有任何訊息（20260130000023）。
--
-- A. 2022 年「直轄市山地原住民區民代表」有 20 筆掛在「台南市 復興區第0X選舉區」。
--    復興區是桃園市的山地原住民區，台南市沒有山地原住民區——全國只有 6 個：
--    桃園市復興區、台中市和平區、新北市烏來區、高雄市那瑪夏區／桃源區／茂林區。
--    另外 5 個區在我們庫裡的縣市都是對的，只有復興區這 3 列選舉區整組掛到台南市。
--    依據是庫內的中選會名單快照 cec_candidates（2026-09-26 起每週同步）：這 20 位在
--    `election_id=2022 / 直轄市山地原住民區民代表 / region=桃園市 / sub_region=復興區第0X選舉區`
--    全部逐位對得上，選舉區分組也跟我們一致（第01區 8 人、第02區 7 人、第03區 5 人）。
--    這支 migration 不靠人工對照，直接在交易裡拿 cec_candidates 再核一次，核不到 20 位就整支退回去。
--    中選會原始出處：https://db.cec.gov.tw/ （111 年直轄市山地原住民區民代表選舉；快照由 cec-sync 抓）
--    來源：寫錯的是 2026-01-31 的早期批次匯入（20 筆的 source_note 都是「中選會官方資料」、
--    verified_at 同一天），那條匯入路徑現在已經不在版控裡（AdminScraper.vue 於 #223 下架，
--    而且它的選舉類型清單裡根本沒有原住民區民代表）。cec_candidates 當初就是為了「系統自己發現
--    這類錯」而建的，它的檔頭註解甚至已經寫明「20 筆縣市存錯（復興區被存成台南市）」——
--    發現了，但沒有東西會去改它。這支就是去改它。
--
-- B. 2026 年有 102 筆已登記（candidate_status='registered'）的參選紀錄 region_id 是 NULL：
--    縣市議員 100 筆、縣市長 2 筆。根因在 apply-contribution.ts：applyCandidacy 只有在
--    ①選舉別是縣市議員、②payload 有 electoral_district、③regions 表剛好有那一列
--    三個條件同時成立時才寫 region_id（districtRegionPatch），任何一個不成立就回 {}，
--    於是落庫成 NULL，而且不報錯、代理那邊也看不到任何異常。縣市長更是一律走不到那條路。
--    這些紀錄的縣市其實是知道的：payload 的 region 已經寫進 politicians.region，
--    而 60 筆的 position 字串本身就帶縣市（「高雄市第10選舉區」），兩邊 0 衝突；
--    另外 14 筆由 current_position 或來源網址佐證。對照表與逐筆佐證見
--    docs/REGION-MISASSIGN-2026-10-04.md。
--    只補到「縣市層級」的 regions 列，不猜選舉區：
--      - 縣市長的選區就是那個縣市，縣市層級本來就是對的形狀（2026 已經有 95 筆這樣指）。
--      - 縣市議員的選舉區沒有可信依據可推：position 裡出現過「高雄市第12～第15選舉區」，
--        但中選會 2022 高雄市議員只有第01～第11 選舉區（electoral_district_areas 與
--        cec_candidates 兩邊都是），2026 高雄市又在中選會「維持本屆選舉區劃分」名單內。
--        猜選舉區會把錯的地區寫成「已查證」，所以這裡只寫縣市，選舉區留給代理流程補。
--      - 畫面不會因此變差：politicians_with_elections 的 subRegion 是
--        COALESCE(per.sub_region, r.sub_region, p.sub_region)，縣市層級列的 sub_region 是 NULL，
--        會自動落回原本那一層，選舉區顯示與篩選行為不變（20260918000006）。
--    沒改的例外：2026 還有 74 筆 region_id 空的 `not_running`（表態不參選的縣市長），
--    以及 cand_no／選舉區等欄位的缺漏，都不在這次範圍，見 PR 說明。
--
-- 可重跑：兩段都先確認「這次有沒有東西要改」，改完的狀態再跑一次會是 no-op；
-- 每一步都比對預期筆數，對不上就 RAISE EXCEPTION 讓整個交易回滾。

-- ============================================================
-- A. 桃園市復興區：3 列選舉區 regions、20 位人物的縣市
-- ============================================================

CREATE TEMP TABLE fuxing_fix (
  pe_id         INTEGER PRIMARY KEY,
  politician_id UUID NOT NULL,
  name          TEXT NOT NULL,
  sub_region    TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO fuxing_fix (pe_id, politician_id, name, sub_region) VALUES
  (34310, '003c5c58-e498-44d4-9a5e-37ea101138ec'::UUID, '韓敬富', '復興區第02選舉區'),
  (34312, '033bc9ca-ada6-444e-9ac2-3c6ab4fc6a50'::UUID, '楊懷玉', '復興區第01選舉區'),
  (34316, '08e911d0-0c49-4fdd-9b65-641aa1fd8009'::UUID, '黃恆貴', '復興區第03選舉區'),
  (34327, '269a5fa5-897d-4ebf-862d-e5ccab2fbfef'::UUID, '簡明仁', '復興區第02選舉區'),
  (34331, '30c40000-73e7-4683-8ec1-5e65d03ec324'::UUID, '回瀾‧誒宥', '復興區第03選舉區'),
  (34344, '53994782-7594-4b1d-af53-48989f887323'::UUID, '余遠山', '復興區第02選舉區'),
  (34350, '623d09e2-1606-4e39-900c-ffc84863eb8b'::UUID, '柯玉明', '復興區第02選舉區'),
  (34352, '7bfc259c-c64f-4a88-8d57-558cda7c1088'::UUID, '劉光榮', '復興區第03選舉區'),
  (34355, '815a0e31-940d-4c9a-b991-f9389198cb0c'::UUID, '張倉豪', '復興區第01選舉區'),
  (34363, '86e049e6-c692-4ea5-9a06-2ba700cd92d3'::UUID, '姜清國', '復興區第03選舉區'),
  (34365, '8c3b40ac-4a2b-436d-a477-5abfb603ec68'::UUID, '楊夢萍', '復興區第01選舉區'),
  (34366, '8d4d3a91-b3d6-443e-ae87-ae044b4ffe6d'::UUID, '李學益', '復興區第02選舉區'),
  (34370, 'a0d27ce2-5778-4916-b3cd-2a751dbde166'::UUID, '江衍恒', '復興區第01選舉區'),
  (34372, 'a61cc64d-f344-4fe8-ae5a-1d1ed04299ce'::UUID, '黃再福', '復興區第02選舉區'),
  (34374, 'af12e894-34db-44b6-9586-f8fae60589e4'::UUID, '余文源', '復興區第01選舉區'),
  (34383, 'c73a1e01-b54d-4b77-8393-75e818504bcc'::UUID, '森長雄', '復興區第01選舉區'),
  (34388, 'cce42551-094d-4e54-b2bb-0cecd097f304'::UUID, '黃義文', '復興區第02選舉區'),
  (34393, 'e0f0c9ca-3d14-4779-8244-5f7d3be0a14f'::UUID, '陳榮光', '復興區第03選舉區'),
  (34398, 'f3ee8f19-0a33-47ab-aa02-6b0ba39ea621'::UUID, '林玉花', '復興區第01選舉區'),
  (34399, 'f706af80-a2e8-47d4-894d-5537a83b0d6f'::UUID, '黃盛', '復興區第01選舉區');

DO $$
DECLARE
  v_todo INTEGER; v_cec INTEGER; v_n INTEGER;
  v_tainan_id INTEGER; v_tainan_rep INTEGER; v_tainan_total INTEGER;
  v_taoyuan_id INTEGER; v_taoyuan_rep INTEGER; v_taoyuan_total INTEGER;
BEGIN
  SELECT count(*) INTO v_todo
    FROM politicians p JOIN fuxing_fix f ON f.politician_id = p.id
   WHERE p.region = '台南市';

  IF v_todo = 0 THEN
    RAISE NOTICE '復興區那 20 位已經掛在桃園市，A 段跳過';
  ELSIF v_todo <> 20 THEN
    -- 一半一半代表資料在這之間被動過；寧可停下來讓人看，不要只改半套
    RAISE EXCEPTION 'A 段預期 20 位人物要從台南市搬到桃園市，實際只有 % 位符合，不繼續', v_todo;
  ELSE
    -- 依據：庫內中選會名單快照。對不滿 20 位就不要改（空集合也算對不上）
    SELECT count(*) INTO v_cec
      FROM fuxing_fix f
      JOIN cec_candidates c
        ON c.election_id = 2022
       AND c.election_type = '直轄市山地原住民區民代表'
       AND c.region = '桃園市'
       AND c.sub_region = f.sub_region
       AND c.name_norm = cec_name_norm(f.name);
    IF v_cec <> 20 THEN
      RAISE EXCEPTION '中選會快照只核對到 % / 20 位桃園市復興區區民代表，不改', v_cec;
    END IF;

    -- 縣市層級統計先存現值。統計是 trg_region_politician_stats 逐筆增減維護的，
    -- 而下面第 2 步會讓它對「選舉區層級」算錯（那 3 列剛被改名，OLD 查不到、NEW 查到的是同一列），
    -- 所以兩層都在第 3 步明確寫回，不靠 trigger 的增減。
    SELECT id, representative_count, total_politicians
      INTO v_tainan_id, v_tainan_rep, v_tainan_total
      FROM regions WHERE region = '台南市' AND sub_region IS NULL AND village IS NULL;
    SELECT id, representative_count, total_politicians
      INTO v_taoyuan_id, v_taoyuan_rep, v_taoyuan_total
      FROM regions WHERE region = '桃園市' AND sub_region IS NULL AND village IS NULL;
    IF v_tainan_id IS NULL OR v_taoyuan_id IS NULL THEN
      RAISE EXCEPTION '找不到台南市／桃園市的縣市層級 regions 列，不改';
    END IF;

    -- 1) 三列選舉區直接改縣市。regions 有 UNIQUE (region, sub_region, village)，
    --    「桃園市＋復興區第0X選舉區」原本不存在，所以不會撞唯一鍵；
    --    參選紀錄與人物的 region_id 指的就是這三列，列搬了就一起跟著對。
    UPDATE regions
       SET region = '桃園市', updated_at = NOW()
     WHERE village IS NULL
       AND region = '台南市'
       AND sub_region IN ('復興區第01選舉區', '復興區第02選舉區', '復興區第03選舉區');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 3 THEN RAISE EXCEPTION 'A 段預期改 3 列選舉區 regions，實際 % 列', v_n; END IF;

    -- 2) 人物表的縣市（region_id 不動）
    UPDATE politicians p
       SET region = '桃園市'
      FROM fuxing_fix f
     WHERE p.id = f.politician_id AND p.region = '台南市';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 20 THEN RAISE EXCEPTION 'A 段預期改 20 位人物的縣市，實際 % 位', v_n; END IF;

    -- 3) 統計：這次的異動就是 20 位「區民代表」從台南市搬到桃園市，照這個差額明確寫回。
    --    不做整個縣市重算——台南市現在的 total_politicians（1258）本來就跟五個分項之和（1239）
    --    差 19（立法委員進了總數、沒進任何分項），重算會順手把那 19 位洗掉，那是另一件事。
    UPDATE regions SET representative_count = v_tainan_rep - 20,
                       total_politicians    = v_tainan_total - 20,
                       updated_at = NOW()
     WHERE id = v_tainan_id;
    UPDATE regions SET representative_count = v_taoyuan_rep + 20,
                       total_politicians    = v_taoyuan_total + 20,
                       updated_at = NOW()
     WHERE id = v_taoyuan_id;
    UPDATE regions r
       SET representative_count = s.n, total_politicians = s.n, updated_at = NOW()
      FROM (SELECT sub_region, count(*) AS n FROM fuxing_fix GROUP BY sub_region) s
     WHERE r.region = '桃園市' AND r.village IS NULL AND r.sub_region = s.sub_region;

    -- 4) trigger 在第 2 步找不到「台南市＋復興區第0X選舉區」時會補建空殼列，清掉。
    --    只刪統計全 0、而且沒有任何人物或參選紀錄指著它的列。
    DELETE FROM regions r
     WHERE r.region = '台南市' AND r.village IS NULL
       AND r.sub_region IN ('復興區第01選舉區', '復興區第02選舉區', '復興區第03選舉區')
       AND COALESCE(r.total_politicians, 0) = 0
       AND COALESCE(r.policy_count, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM politicians p WHERE p.region_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM politician_elections pe WHERE pe.region_id = r.id);
  END IF;
END $$;

-- A 段收尾自檢（不管這次有沒有改，跑完都要成立）
DO $$
DECLARE v_bad INTEGER;
BEGIN
  SELECT count(*) INTO v_bad FROM regions
   WHERE village IS NULL AND sub_region LIKE '復興區%' AND region <> '桃園市';
  IF v_bad > 0 THEN RAISE EXCEPTION '還有 % 列復興區掛在桃園市以外的縣市', v_bad; END IF;

  SELECT count(*) INTO v_bad
    FROM politician_elections pe JOIN regions r ON r.id = pe.region_id
   WHERE pe.election_type = '直轄市山地原住民區民代表' AND r.region = '台南市';
  IF v_bad > 0 THEN RAISE EXCEPTION '台南市還有 % 筆山地原住民區民代表參選紀錄（台南市沒有山地原住民區）', v_bad; END IF;

  SELECT count(*) INTO v_bad FROM politicians
   WHERE region = '台南市' AND election_type::TEXT = '直轄市山地原住民區民代表';
  IF v_bad > 0 THEN RAISE EXCEPTION '人物表台南市還有 % 位山地原住民區民代表', v_bad; END IF;

  SELECT count(*) INTO v_bad
    FROM politician_elections pe JOIN regions r ON r.id = pe.region_id
   WHERE pe.election_type = '直轄市山地原住民區民代表' AND r.sub_region LIKE '復興區%' AND r.region = '桃園市';
  -- 用「至少 20」而不是「剛好 20」：名單清查臂（20261004000003）可能之後又補進
  -- 中選會名單上我們還缺的那幾位（例如第03選舉區的林振德），那是補齊、不是這支的錯
  IF v_bad < 20 THEN RAISE EXCEPTION '桃園市復興區應該至少有 20 筆區民代表參選紀錄，實際 % 筆', v_bad; END IF;
END $$;

-- ============================================================
-- B. 2026 已登記、region_id 空白的 102 筆：補到縣市層級
-- ============================================================

CREATE TEMP TABLE candidacy_county_fix (
  pe_id  INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  region TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO candidacy_county_fix (pe_id, name, region) VALUES
  (34993, '羅貴星', '苗栗縣'),
  (35371, '陳見賢', '新竹縣'),
  (35909, '武清山', '嘉義縣'),
  (36188, '朱元宏', '台中市'),
  (36221, '呂秀惠', '台中市'),
  (36222, '柯靜志', '台中市'),
  (36277, '楊寶楨', '台中市'),
  (36319, '鍾炳光', '高雄市'),
  (36320, '黃明太', '高雄市'),
  (36321, '黃韻涵', '高雄市'),
  (36322, '蔣黃女', '高雄市'),
  (36323, '薛兆基', '高雄市'),
  (36324, '白喬茵', '高雄市'),
  (36325, '江瑞鴻', '高雄市'),
  (36326, '李喬如', '高雄市'),
  (36327, '康裕成', '高雄市'),
  (36328, '林彥', '高雄市'),
  (36329, '童燕珍', '高雄市'),
  (36330, '黃香菽', '高雄市'),
  (36331, '陳慧文', '高雄市'),
  (36332, '李政憲', '高雄市'),
  (36333, '劉仙娥', '高雄市'),
  (36334, '王耀裕', '高雄市'),
  (36335, '黃天煌', '高雄市'),
  (36336, '洪村銘', '高雄市'),
  (36337, '邱于軒', '高雄市'),
  (36338, '宋紹銘', '高雄市'),
  (36339, '陳幸富', '高雄市'),
  (36340, '王義雄', '高雄市'),
  (36341, '葛姵瑩', '高雄市'),
  (36342, '林錫閔', '高雄市'),
  (36343, '金禾雅', '高雄市'),
  (36344, '鄭光峰', '高雄市'),
  (36345, '吳銘賜', '高雄市'),
  (36346, '蔡武宏', '高雄市'),
  (36347, '張藝璉', '高雄市'),
  (36348, '黃敬雅', '高雄市'),
  (36349, '鄧巧佩', '高雄市'),
  (36350, '張耀中', '高雄市'),
  (36351, '吳昱鋒', '高雄市'),
  (36352, '何權峰', '高雄市'),
  (36353, '許采蓁', '高雄市'),
  (36354, '余聖明', '高雄市'),
  (36355, '黃淑美', '高雄市'),
  (36356, '陳玫娟', '高雄市'),
  (36357, '鄭孟洳', '高雄市'),
  (36358, '蔡金晏', '高雄市'),
  (36359, '曾俊傑', '高雄市'),
  (36360, '張勝富', '高雄市'),
  (36361, '張以理', '高雄市'),
  (36362, '柳淑芳', '高雄市'),
  (36363, '吳利成', '高雄市'),
  (36364, '簡煥宗', '高雄市'),
  (36365, '陳惠君', '高雄市'),
  (36366, '陳琳潔', '高雄市'),
  (36367, '李振豪', '高雄市'),
  (36368, '鄭東元', '高雄市'),
  (36369, '陳麗珍', '高雄市'),
  (36370, '李亞築', '高雄市'),
  (36371, '黃秋媖', '高雄市'),
  (36372, '林富寶', '高雄市'),
  (36373, '尹立', '高雄市'),
  (36374, '李柏融', '高雄市'),
  (36375, '陳膺涵', '新北市'),
  (36376, '孫湯玉惠', '宜蘭縣'),
  (36377, '張烱春', '台中市'),
  (36378, '謝家宜', '台中市'),
  (36379, '簡嘉佑', '桃園市'),
  (36380, '巫召清', '苗栗縣'),
  (36381, '宋昀芝', '澎湖縣'),
  (36382, '何文海', '台中市'),
  (36383, '洪英雄Salizan.binkinuan', '高雄市'),
  (36384, '林志豪', '苗栗縣'),
  (36385, '陳薈茗', '苗栗縣'),
  (36386, '吳仁祥', '澎湖縣'),
  (36387, '廖璟華', '澎湖縣'),
  (36388, '于仙玲', '高雄市'),
  (36426, '高惠芬', '屏東縣'),
  (36427, '何長成', '屏東縣'),
  (36428, '周陳曉玟', '屏東縣'),
  (36429, '洪亞男', '屏東縣'),
  (36430, '劉忠義', '屏東縣'),
  (36431, '杜玉慧', '屏東縣'),
  (36437, '孫素娥', '苗栗縣'),
  (36438, '黎尚安', '苗栗縣'),
  (36439, '翁杰', '苗栗縣'),
  (36440, '杜文卿', '苗栗縣'),
  (36441, '吳亭亭', '苗栗縣'),
  (36442, '鄭聚然', '苗栗縣'),
  (36443, '温俊勇', '苗栗縣'),
  (36444, '連佳振', '台中市'),
  (36445, '陳映辰', '台中市'),
  (36446, '陳瑩', '台東縣'),
  (36447, '高忠德Takiludun.Anu', '高雄市'),
  (36471, '潘翠雲', '屏東縣'),
  (36473, '江金妹', '屏東縣'),
  (36474, '張利惠', '屏東縣'),
  (36475, '越秋女', '屏東縣'),
  (36476, '鄭鴻耀', '屏東縣'),
  (36477, '鄭志偉', '屏東縣'),
  (36478, '許金吉', '屏東縣'),
  (36479, '杜仁勇', '屏東縣');

DO $$
DECLARE v_bad INTEGER; v_n INTEGER;
BEGIN
  -- 對照表是從 politicians.region 推出來的（見檔頭）。人物的縣市如果在這之間被改過，
  -- 對照表就不再有依據，停手讓人看，不要照舊值寫下去。「臺」「台」兩種寫法都當同一個。
  SELECT count(*) INTO v_bad
    FROM candidacy_county_fix f
    JOIN politician_elections pe ON pe.id = f.pe_id
    JOIN politicians p ON p.id = pe.politician_id
   WHERE translate(COALESCE(p.region, ''), '臺', '台') IS DISTINCT FROM f.region;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'B 段有 % 筆的人物縣市跟對照表不一致（資料被動過），不改', v_bad;
  END IF;

  -- 對照表裡的參選紀錄必須都還在，而且還是 2026 那一屆。
  -- 不要求 candidate_status 還是 registered——中間有人退選（registered→not_running）是正常的，
  -- 退選的人一樣屬於那個縣市，地區照補。
  SELECT count(*) INTO v_bad
    FROM candidacy_county_fix f
    LEFT JOIN politician_elections pe ON pe.id = f.pe_id AND pe.election_id = 2026
   WHERE pe.id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'B 段有 % 筆參選紀錄不見了或已經不是 2026 那一屆，不改', v_bad;
  END IF;

  -- 每個縣市都要有「縣市層級」的 regions 列可以指（這裡不新建 regions 列）
  SELECT count(*) INTO v_bad
    FROM (SELECT DISTINCT region FROM candidacy_county_fix) f
   WHERE NOT EXISTS (
     SELECT 1 FROM regions r
      WHERE r.region = f.region AND r.sub_region IS NULL AND r.village IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'B 段有 % 個縣市在 regions 沒有縣市層級的列，不改', v_bad;
  END IF;

  -- politician_elections 上掛著 trg_sync_politician_latest：改 pe.region_id 會被它
  -- COALESCE 同步寫進 politicians.region_id，把人物原本指到選舉區的那一列蓋成縣市層級
  -- （102 筆裡有 53 筆的人物 region_id 現在指著選舉區）。這支只修參選紀錄的地區，
  -- 不打算順手降級人物表，所以先存著、改完還原。
  CREATE TEMP TABLE pol_region_id_before ON COMMIT DROP AS
    SELECT DISTINCT p.id, p.region_id
      FROM politicians p
      JOIN politician_elections pe ON pe.politician_id = p.id
      JOIN candidacy_county_fix f ON f.pe_id = pe.id;

  UPDATE politician_elections pe
     SET region_id = r.id
    FROM candidacy_county_fix f
    JOIN regions r
      ON r.region = f.region AND r.sub_region IS NULL AND r.village IS NULL
   WHERE pe.id = f.pe_id AND pe.region_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'B 段這次補了 % 筆參選紀錄的 region_id', v_n;

  UPDATE politicians p
     SET region_id = b.region_id
    FROM pol_region_id_before b
   WHERE p.id = b.id AND p.region_id IS DISTINCT FROM b.region_id;
END $$;

-- B 段收尾自檢：對照表上的每一筆，region_id 指到的縣市都要跟對照表一致
-- （NULL 也會被這一條抓到，因為 LEFT JOIN 之後 r.region 是 NULL）
DO $$
DECLARE v_bad INTEGER;
BEGIN
  SELECT count(*) INTO v_bad
    FROM candidacy_county_fix f
    JOIN politician_elections pe ON pe.id = f.pe_id
    LEFT JOIN regions r ON r.id = pe.region_id
   WHERE r.region IS DISTINCT FROM f.region;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'B 段修完還有 % 筆的地區對不上對照表（含仍然是空的）', v_bad;
  END IF;

  -- 全域的殘量只報不擋：代理是持續在交件的，從盤點到這支上線之間還會有新的進來，
  -- 而那是 apply-contribution.ts 的縣市退路（同一個 PR）要接住的事，不該讓這支把部署擋死。
  -- 這支的保證在上面那一條：對照表上的 102 筆，每一筆都要指到對的縣市。
  SELECT count(*) INTO v_bad
    FROM politician_elections pe
   WHERE pe.election_id = 2026
     AND pe.candidate_status = 'registered'
     AND pe.region_id IS NULL;
  IF v_bad > 0 THEN
    RAISE NOTICE '2026 已登記的參選紀錄還有 % 筆沒有地區（對照表之外新進來的）', v_bad;
  END IF;
END $$;
