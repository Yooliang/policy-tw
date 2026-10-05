-- ============================================================
-- 選舉頁分層：鄉鎮市區層只撈那個鄉鎮的參選人（2026-10-04）
-- ============================================================
--
-- 現有的 get_politicians_by_filters 只篩得到縣市，所以鄉鎮市區頁一直是
-- 「撈全縣市該層級、再在前端濾」：
--   台南市北區    要撈全台南市 1,132 位（兩頁）才濾出北區的 58 位
--   高雄市那瑪夏區 要撈全高雄市 1,641 位（兩頁）才濾出那一區
-- 縣市層加上型別篩選之後已經降到一頁以內（高雄市 1,769 → 128），鄉鎮層卻只降 7%，
-- 因為村里長全部都在同一個縣市底下。要再降就得篩到 sub_region。
--
-- 這裡新增一支函式，而不是給 get_politicians_by_filters 加參數：
-- 加一個有預設值的參數會讓新舊簽名在 PostgREST 變成 ambiguous overload
-- （兩支都滿足 {p_election_id, p_region, p_election_types} 這組參數），
-- 所以得先 DROP 再 CREATE——而 DROP 會連著把現有的 EXECUTE 權限一起洗掉。
-- 舊函式還有 lib/ssr/loaders.ts 在用，不值得為了一個參數冒那個風險。
--
-- 權限：照 get_politicians_by_filters 一樣，不寫 SECURITY DEFINER（＝SECURITY INVOKER，
-- RLS 照使用者的身分判定），也不寫任何 GRANT，靠 PostgreSQL 建立函式時的預設權限。
-- 跟現狀一致，沒有放寬。
--
-- 排序：函式內刻意不加 ORDER BY。分頁是 PostgREST 在外層套的
-- （SELECT * FROM fn(...) ORDER BY id LIMIT .. OFFSET ..），外層的 order 會覆蓋函式內的，
-- 所以寫在這裡沒有作用。呼叫端一律帶 .order('id')，見 lib/fetch-all-pages.ts。

CREATE OR REPLACE FUNCTION get_politicians_by_level(
  p_election_id integer,
  p_region text DEFAULT NULL,
  p_sub_region text DEFAULT NULL,
  p_election_types text[] DEFAULT NULL
)
RETURNS SETOF politicians_with_elections
LANGUAGE sql
STABLE
AS $$
  SELECT pwe.*
  FROM politicians_with_elections pwe
  WHERE EXISTS (
    -- 用 EXISTS 而不是 INNER JOIN：這樣一個人就是一列，不會因為參選紀錄的筆數
    -- 影響結果列數。politician_elections 有 (politician_id, election_id) 的唯一索引
    -- （20260911000003），所以現在兩種寫法等價；EXISTS 讓「id 在結果裡唯一」
    -- 這件事不依賴那個索引還在——而分頁的穩定排序正是靠它。
    SELECT 1
    FROM politician_elections pe
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE pe.politician_id = pwe.id
      AND pe.election_id = p_election_id
      -- 「臺」與「台」在這張表裡是混用的：regions.region 全寫「台」（台北市），
      -- 但 2024 立委的 regions.sub_region 寫「臺」（臺北市第01選區）。兩邊都正規化成「台」
      -- 再比，否則就是靜靜地回 0 筆——而 0 筆在畫面上跟「這一區沒人參選」長得一樣。
      -- 前端的對應處理在 lib/region-name.ts，兩邊規則要一致。
      AND (p_region IS NULL OR replace(r.region, '臺', '台') = replace(p_region, '臺', '台'))
      AND (p_election_types IS NULL OR pe.election_type = ANY(p_election_types))
      AND (
        p_sub_region IS NULL
        OR replace(r.sub_region, '臺', '台') = replace(p_sub_region, '臺', '台')
        -- 同一個區的兩種職位在 sub_region 上長得不一樣：
        --   里長             那瑪夏區
        --   原住民區民代表    那瑪夏區第01選舉區
        -- 只用等值比對會把區代表整個漏掉（那一區的「這一層」就空了，而畫面上
        -- 空區塊看起來跟「這一屆沒人參選」一模一樣）。
        -- 鄉鎮市區名都是中文，不含 LIKE 的通用字元 % 與 _，所以不需要 escape。
        OR replace(r.sub_region, '臺', '台') LIKE replace(p_sub_region, '臺', '台') || '第%選舉區'
      )
  );
$$;

COMMENT ON FUNCTION get_politicians_by_level(integer, text, text, text[]) IS
  '選舉頁分層用：依屆別、縣市、鄉鎮市區、職位撈參選人。鄉鎮市區會一併比對「XX區第NN選舉區」格式（原住民區代表）。呼叫端要自己帶 order=id 分頁，見 lib/fetch-all-pages.ts。';
