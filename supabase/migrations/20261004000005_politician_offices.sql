-- 職稱與參選狀況分開（2026-10-04 維護者：「職稱可能有多種，把他跟參選狀況分開來」）
--
-- 現狀的錯：人物頁上方那顆標籤（以及網頁標題、SEO 摘要、卡片）寫的是
-- `lib/participation-label.ts` 從「最近一筆非 not_running 的參選紀錄」組出來的字，不分當選落選——
-- 2024 落選的立委候選人也掛著「台南市立委」，看起來跟現任立委一模一樣。
--
-- 這裡建「現任公職」的單一真相 `politician_offices`：一筆當選、任期內的席次一列。
-- 前端的職稱只讀它，參選狀況另外由 politician_elections 的 candidate_status 顯示。
-- 系統不寫任何人的資料，純查詢。
--
-- 一位人物可能有多列：2022 選上議員、2024 又選上立委的人兩列都在（兩個席次的任期都還沒到期）。
-- 我國不得同時擔任兩個民選公職，所以顯示層只取最近一屆那幾列（lib/politician-office.ts 的 officeTitles）；
-- 這裡不先篩掉，是因為「任期未到期的席次」是個講得清楚的定義，而「他現在到底坐哪一個」是顯示層的判斷。
--
-- 判定（兩條來源，都要在任期內）：
--   1. 我們自己的參選紀錄 `election_result = 'elected'`
--   2. 參選紀錄在中選會名單（`cec_candidates`）**唯一**對上、而且那一列 `elected = true`
--      為什麼要第 2 條：`election_result` 線上只有 918 筆有值、15,109 筆是 NULL（2026-10-04 實查），
--      光靠自己的紀錄會把絕大多數現任者漏掉（2022 縣市議員只標了 815／約 910、鄉鎮市長只標了 7／約 198）。
--      「唯一對上」＝同屆別、同選舉別、同正規化姓名、同縣市在中選會名單上只有一列。
--      對不上的就不算現任——寧可少標，不要把別人的當選算到這個人頭上。2026-10-04 本機實測線上資料：
--        同縣市同名多人 27 筆、中選會名單查無同名者 36 筆（這 63 筆沒有職稱，另案交給 Jev 判）。
--      已經寫成 'not_elected' 的不讓中選會翻盤：那是人工／代理核過的，有衝突要走 correction 改資料，
--      不是在顯示層偷偷覆蓋。
--
-- 實測輸出（2026-10-04，本機 postgres 灌線上資料）：8,550 列／8,534 位人物——
--   2022 村里長 7,377、縣市議員 852、鄉鎮市長 190、原住民區民代表 35、縣市長 21；2024 立委 73、總統副總統 2。
--   2024 立委只認得 73 位（不是 113）：不分區與原住民立委不在中選會的候選人名單裡，我們也沒標 election_result，
--   那些人頁面上就不會有職稱——那是資料缺口，不是這裡的判定邏輯錯。
--
-- ⚠️ 任期結束日不能用 `elections.end_date`：那一欄存的是**投票日**（2022 那列是 2022-11-26），不是任期結束日。
--    所以任期由「屆別年份＋選舉別」算（下面兩個函式），線上三屆的實際值：
--      2022 地方公職 2022-12-25 ～ 2026-12-24｜2024 立委 2024-02-01 ～ 2028-01-31｜2024 總統 2024-05-20 ～ 2028-05-19
--    就任日也要擋：2026-11-28 投完票到 12-25 就任之間，新當選者還不是現任（那段期間現任仍是 2022 選出來的那批）。
--    卸任日是下一任就任日的前一天，所以 2026-12-25 那天只會算 2026 選出來的那批，不會新舊兩個職稱並列。

-- 就任日：地方公職 12/25、立委 2/1、總統副總統 5/20（都在投票的同一個年份）
CREATE OR REPLACE FUNCTION office_term_start(p_election_id INTEGER, p_election_type TEXT)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_election_type
           WHEN '總統副總統' THEN make_date(p_election_id, 5, 20)
           WHEN '立法委員'   THEN make_date(p_election_id, 2, 1)
           ELSE make_date(p_election_id, 12, 25)
         END
$$;
COMMENT ON FUNCTION office_term_start IS '任期開始日（屆別年份＋選舉別算出來；elections.start_date 不是這個意思）';

-- 卸任日：任期四年，最後一天＝四年後那一屆就任日的前一天（地方 12/24、立委 1/31、總統 5/19）
CREATE OR REPLACE FUNCTION office_term_end(p_election_id INTEGER, p_election_type TEXT)
RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT office_term_start(p_election_id + 4, p_election_type) - 1
$$;
COMMENT ON FUNCTION office_term_end IS '卸任日（任期最後一天＝下一屆就任日前一天；elections.end_date 存的是投票日，不能拿來當這個）';

GRANT EXECUTE ON FUNCTION office_term_start(INTEGER, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION office_term_end(INTEGER, TEXT) TO anon, authenticated;

-- 不加新索引：比對鍵是屆別＋選舉別＋正規化姓名＋縣市，既有的 cec_candidates_name_idx
-- (election_id, name_norm) 已經夠選擇性（同屆同名幾乎就一列），實測加一條整鍵索引後 planner 還是選既有那條、
-- 全視圖耗時不變（本機灌線上資料量實測 46ms vs 43ms）。不留沒人用的索引。

-- 現任公職：一位人物一個職位一列。
-- 刻意寫成單層 SELECT（沒有 CTE／窗函式），外層 `WHERE politician_id = …` 才推得進去——
-- 人物頁一次只查一個人，不能讓它整張表算完再篩。
CREATE OR REPLACE VIEW politician_offices AS
SELECT
  pe.politician_id,
  pe.id                                                 AS politician_election_id,
  pe.election_id,
  pe.election_type,
  COALESCE(r.region, p.region)                          AS region,
  COALESCE(r.sub_region, p.sub_region)                  AS sub_region,
  COALESCE(r.village, p.village)                        AS village,
  office_term_start(pe.election_id, pe.election_type)   AS term_start,
  office_term_end(pe.election_id, pe.election_type)     AS term_end,
  -- 這一列是怎麼認定的，給查資料的人看（也給之後 Jev 判同名多人時對照）
  CASE WHEN pe.election_result = 'elected' THEN 'election_result' ELSE 'cec_candidates' END AS verified_by
FROM politician_elections pe
JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
LEFT JOIN regions r ON r.id = pe.region_id
WHERE office_term_start(pe.election_id, pe.election_type) <= CURRENT_DATE
  AND office_term_end(pe.election_id, pe.election_type) >= CURRENT_DATE
  AND (
    pe.election_result = 'elected'
    OR (
      pe.election_result IS NULL
      -- count(*) = 1 AND bool_and(...)：空集合時 count 就不是 1，整句 false；
      -- 唯一那列的 elected 是 NULL 時整句是 NULL，WHERE 也當 false。都是「不算現任」。
      AND (
        SELECT count(*) = 1 AND bool_and(c.elected)
          FROM cec_candidates c
         WHERE c.election_id = pe.election_id
           AND c.election_type = pe.election_type
           AND c.name_norm = cec_name_norm(p.name)
           AND c.region = COALESCE(r.region, p.region)
      )
    )
  );

COMMENT ON VIEW politician_offices IS '現任公職（任期內＋我們標了當選或在中選會名單唯一對上且當選）；人物頁的「職稱」只讀它，跟參選狀況是兩件事';
-- 跟其他 view 一樣以呼叫者身分執行，底層表的 RLS 才會生效（見 20260912000016）
ALTER VIEW politician_offices SET (security_invoker = on);
GRANT SELECT ON politician_offices TO anon, authenticated;

-- 人物視圖帶出 offices：前端載人物時一起拿到，不必再多一趟查詢。
-- 只在最後「加」一欄（CREATE OR REPLACE VIEW 不能改既有欄位的名稱與順序）；
-- 原本的欄位與子查詢照抄 20260925000004，線上 pg_get_viewdef 核過。
-- 沒被 select 到的時候 Postgres 會把這個子查詢整個剪掉（視圖會被攤平），
-- 所以只選幾欄的熱路徑（全站搜尋；/next 那些 Edge Function 根本不走這個視圖）不會因為多這一欄變慢。
-- 本機灌線上資料量（politicians 16,216、politician_elections 17,011、cec_candidates 19,775）實測：
--   politician_offices 全表 46ms／8,550 列；單人查詢 0.6ms（politician_id 推得進去，沒有全表算完再篩）
--   只選幾欄＋ILIKE（搜尋那種）：EXPLAIN 裡完全沒有 offices 的子計畫
--   SELECT * ORDER BY id LIMIT 1000 OFFSET 15000（預渲染抓最後一頁）：171ms → 929ms
--   ＝每列約 30µs；整份預渲染（17 頁）多約 4 秒，單一請求最久約 1 秒，離 15 秒 timeout 還很遠。
CREATE OR REPLACE VIEW politicians_with_elections AS
 SELECT p.id,
    p.name,
    p.party,
    p.status,
    p.election_type,
    p."position",
    p.current_position,
    COALESCE(r.region, p.region) AS region,
    COALESCE(r.sub_region, p.sub_region) AS sub_region,
    COALESCE(r.village, p.village) AS village,
    p.avatar_url,
    p.slogan,
    p.bio,
    p.education,
    p.experience,
    p.birth_year,
    p.education_level,
    COALESCE(( SELECT json_agg(pe.election_id) AS json_agg
           FROM politician_elections pe
          WHERE pe.politician_id = p.id), '[]'::json) AS election_ids,
    COALESCE(( SELECT json_agg(json_build_object('electionId', pe.election_id, 'position', COALESCE(pe."position", p."position"), 'slogan', COALESCE(pe.slogan, p.slogan), 'electionType', COALESCE(pe.election_type, p.election_type), 'regionId', pe.region_id, 'region', COALESCE(per.region, r.region, p.region), 'subRegion', COALESCE(per.sub_region, r.sub_region, p.sub_region), 'village', COALESCE(per.village, r.village, p.village), 'candidateStatus', pe.candidate_status, 'electionResult', pe.election_result, 'sourceNote', pe.source_note, 'candNo', pe.cand_no)) AS json_agg
           FROM politician_elections pe
             LEFT JOIN regions per ON pe.region_id = per.id
          WHERE pe.politician_id = p.id), '[]'::json) AS elections,
    p.merged_into,
    COALESCE(( SELECT json_agg(json_build_object('electionId', o.election_id, 'electionType', o.election_type, 'region', o.region, 'subRegion', o.sub_region, 'village', o.village, 'termEnd', o.term_end) ORDER BY o.election_id DESC) AS json_agg
           FROM politician_offices o
          WHERE o.politician_id = p.id), '[]'::json) AS offices
   FROM politicians p
     LEFT JOIN regions r ON p.region_id = r.id;

-- ⚠️ CREATE OR REPLACE VIEW 會把視圖的 reloptions 清掉，security_invoker 跟著不見（本機實測）。
-- 不補回來的話，這個視圖會變回以建立者身分執行、底層表的 RLS 不套到呼叫者——就是 20260912000016 收斂掉的那個問題。
-- 順手把 20260925000004（cand_no）那次換掉這個視圖、沒補 security_invoker 留下的缺口一起補上。
ALTER VIEW politicians_with_elections SET (security_invoker = on);

-- politicians_with_policies 是 `SELECT p.*`，星號在建視圖時就展開了，要重跑才會多出 offices
CREATE OR REPLACE VIEW politicians_with_policies AS
SELECT p.*
FROM politicians_with_elections p
WHERE EXISTS (
  SELECT 1 FROM policies pl
  WHERE pl.politician_id = p.id AND pl.removed_at IS NULL
);
ALTER VIEW politicians_with_policies SET (security_invoker = on);
