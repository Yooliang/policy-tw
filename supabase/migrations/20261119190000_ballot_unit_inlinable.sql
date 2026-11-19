-- 補號次臂效能（#981）：ballot_number_unit 改成可被規劃器展開的純運算式（2026-11-19）
-- ============================================================
--
-- 一、量到的（正式庫唯讀 EXPLAIN ANALYZE，把 contribution_auto_tasks_ballot_numbers() 的全部輸出欄位加總）：整支約 4～6 秒，
--   其中兩處「Hash Left Join politician_elections × politicians × regions」各約 2.7～3.0 秒——兩處都是約 1.95 萬列逐列呼叫 ballot_number_unit()
--   （一次在臂本體的 g_all，一次在視圖 ballot_number_units 供重複／跳號重查用），其餘節點（名冊、排序、反連接）全部加起來不到 0.3 秒。
-- 二、根因：ballot_number_unit 的鄉鎮市民代表分支用 FROM (SELECT …) 子查詢；SQL 純量函式含子查詢就不會被展開，
--   每次呼叫都走完整的函式執行器（約 140 微秒），跟那一列是不是代表無關。
-- 三、改法：同一個函式簽名，代表分支改成不用子查詢的運算式（中間值重複寫），整支函式 IMMUTABLE＋單一 CASE＋無子查詢，可被展開。
--   回傳值逐列不變（正式庫全部輸入組合新舊對比＋合成邊界字串，PR 說明附結果）。臂本體、視圖、其他呼叫處（cand_no_dup_conflicts 等）一字不動。
-- 回滾：把 ballot_number_unit 還原成 20261009070000 的定義（CREATE OR REPLACE，簽名不變、無相依物件要重建）。

CREATE OR REPLACE FUNCTION ballot_number_unit(p_election_type TEXT, p_county TEXT, p_district TEXT, p_town TEXT, p_village TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_county), '') IS NULL THEN NULL
    WHEN p_election_type = '縣市長' THEN replace(btrim(p_county), '臺', '台')
    WHEN p_election_type = '縣市議員' AND btrim(COALESCE(p_district, '')) LIKE '%選舉區' THEN replace(btrim(p_county), '臺', '台') || '|' || replace(replace(btrim(p_district), ' ', ''), '臺', '台')
    WHEN p_election_type IN ('鄉鎮市長', '直轄市山地原住民區長') AND NULLIF(btrim(p_town), '') IS NOT NULL THEN replace(btrim(p_county), '臺', '台') || '|' || replace(btrim(p_town), '臺', '台')
    WHEN p_election_type = '村里長' AND NULLIF(btrim(p_town), '') IS NOT NULL AND NULLIF(btrim(p_village), '') IS NOT NULL THEN replace(btrim(p_county), '臺', '台') || '|' || replace(btrim(p_town), '臺', '台') || '|' || replace(btrim(p_village), '臺', '台')
    -- 鄉鎮市民代表、直轄市山地原住民區民代表（#464）：號次單位＝縣市|鄉鎮第NN選舉區（regions 存代表選舉區的寫法）。規則同 20261009070000：
    -- 選舉區的數字補成兩位；沒有選舉區、沒有鄉鎮、看不出第幾區、或選舉區前的鄉鎮與鄉鎮欄矛盾的回 NULL＝不檢查。
    -- 效能（#981）：原寫法用子查詢（FROM (SELECT …) rd）算中間值，SQL 函式有子查詢就不能被規劃器展開、每一列都要啟動一次執行器（約 140 微秒，兩萬列 2.7 秒）；
    -- 這裡把中間值（選舉區字串 s、數字 num、鄉鎮 town）直接寫成運算式，函式整支可被展開成一般運算式。回傳值逐列不變。
    WHEN p_election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表') THEN
      CASE WHEN (regexp_match(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第0*([0-9]+)選舉區$'))[1] IS NOT NULL AND (regexp_match(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第0*([0-9]+)選舉區$'))[1] <> '0' AND (CASE WHEN regexp_replace(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第[0-9]+選舉區$', '') <> '' AND regexp_replace(replace(btrim(COALESCE(p_town, '')), ' ', ''), '(第[0-9]+)?選舉區$', '') <> '' AND replace(regexp_replace(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第[0-9]+選舉區$', ''), '臺', '台') <> replace(regexp_replace(replace(btrim(COALESCE(p_town, '')), ' ', ''), '(第[0-9]+)?選舉區$', ''), '臺', '台') THEN '' ELSE COALESCE(NULLIF(regexp_replace(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第[0-9]+選舉區$', ''), ''), regexp_replace(replace(btrim(COALESCE(p_town, '')), ' ', ''), '(第[0-9]+)?選舉區$', '')) END) <> ''
           THEN replace(btrim(p_county), '臺', '台') || '|' || replace((CASE WHEN regexp_replace(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第[0-9]+選舉區$', '') <> '' AND regexp_replace(replace(btrim(COALESCE(p_town, '')), ' ', ''), '(第[0-9]+)?選舉區$', '') <> '' AND replace(regexp_replace(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第[0-9]+選舉區$', ''), '臺', '台') <> replace(regexp_replace(replace(btrim(COALESCE(p_town, '')), ' ', ''), '(第[0-9]+)?選舉區$', ''), '臺', '台') THEN '' ELSE COALESCE(NULLIF(regexp_replace(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第[0-9]+選舉區$', ''), ''), regexp_replace(replace(btrim(COALESCE(p_town, '')), ' ', ''), '(第[0-9]+)?選舉區$', '')) END), '臺', '台') || '第' || lpad((regexp_match(replace(btrim(COALESCE(p_district, '')), ' ', ''), '第0*([0-9]+)選舉區$'))[1], 2, '0') || '選舉區' END
    ELSE NULL
  END
$$;
