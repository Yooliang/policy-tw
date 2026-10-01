-- 補任期政見（term_policy_missing，協議 1.41.0；維護者 2026-10-02 同意）
--
-- 人物頁「過往政績」顯示「該候選人無過往追蹤紀錄」＝這個人沒有過去選舉的政見。線上量（2026-10-02）：
-- 2022 當選的縣市議員 813 人有 742 人沒有 election_id=2022 的政見；2022 縣市長 20 缺 12；2022 鄉鎮市長 6 缺 4；
-- 2024 立委 73 缺 59。policy_missing 只對 2026 候選人、而且整個人零政見才派——已有 2026 政見的現任者、
-- 不選 2026 的現任者（約 380 位議員）永遠不會被派去補任期政見。現任者的任期政見是追蹤「說到做到」的基礎：
-- 沒有那一屆的承諾，progress_stale 就沒有東西可以問「兌現了沒」。
--
-- 對象：現任者——politician_elections.election_result='elected'，而且
--   2022 縣市長／縣市議員／鄉鎮市長，或 2024 立法委員。不含村里長、總統。
-- 缺口：policies 裡沒有該人、該屆、未移除的政見。補上一筆就從 _gaps 消失，seed_auto_task_queue 收回號碼牌。
-- task_id：auto:term_policy_missing:<人物>:<屆別>——同一人可能 2022 選上議員、2024 選上立委，兩屆各一件。
--
-- 去重：2026 候選人而且整個人零政見的，只走 policy_missing（條件跟 raw 臂的 c2026 一致）。
--   2026 選舉的政見是網站目前的首要內容，policy_missing 本來就允許交過去選舉的政見；
--   它一交上任何一筆（不論哪一屆），policy_missing 的缺口消失，這裡就自動接手問那一屆。
--   兩件同時開的話，兩個代理會為同一個人各查一次、交出重複的政見。
--
-- 只「加」：新增一支臂，contribution_auto_tasks_arms() 以同簽名 CREATE OR REPLACE（原七支臂照抄，線上 pg_get_functiondef 核過）。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_term_policies()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH i AS (
    SELECT DISTINCT ON (pe.politician_id, pe.election_id)
           pe.politician_id, pe.election_id, pe.election_type, p.name, p.party,
           COALESCE(r.region, p.region) AS region
    FROM politician_elections pe
    JOIN politicians p ON p.id = pe.politician_id
    LEFT JOIN regions r ON r.id = pe.region_id
    WHERE p.merged_into IS NULL
      AND pe.election_result = 'elected'
      AND ((pe.election_id = 2022 AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長'))
           OR (pe.election_id = 2024 AND pe.election_type = '立法委員'))
    ORDER BY pe.politician_id, pe.election_id, pe.election_type
  )
  SELECT 'auto:term_policy_missing:' || i.politician_id || ':' || i.election_id, 'term_policy_missing',
         jsonb_build_object('politician_id', i.politician_id, 'name', i.name, 'party', i.party, 'region', i.region,
                            'election_id', i.election_id, 'election_type', i.election_type, 'election_result', 'elected'),
         i.name || '（' || COALESCE(i.region, '') || ' ' || i.election_id || ' ' || i.election_type || '當選，現任）'
           || '沒有任何 ' || i.election_id || ' 這一屆的政見，人物頁的「過往政績」是空的。'
           || '請找他**那一屆當選時的競選政見**：最多 5 筆、每筆一個 policy 型別、各附自己的出處；'
           || 'election_id 填 ' || i.election_id || '，status 填 Campaign Pledge（競選承諾，之後會有任務追「兌現了沒」）。'
           || '**首選中選會選舉公報**——每位候選人登記的政見原文都印在公報上（見 hint_sources 的入口，依縣市、選舉別、選舉區找 PDF）；'
           || '其次本人官網／臉書的競選政見頁、當年的新聞。'
           || '找到幾筆交幾筆，不要為了湊數交標語、口號、願景或個人表態——那些不是政見。'
           || '先看 current.queued_policies 與既有政見，別人交了還在等票的不要再交；任內才宣布的施政、2026 的新政見不是這一屆的競選政見。',
         CASE WHEN i.election_id = 2022 THEN
           ARRAY['https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）地方選舉公報：點縣市 → 市長／縣長、議員、鄉鎮市長 → 選舉區 PDF，候選人登記的政見原文在上面',
                 '候選人當年的官網／臉書競選政見頁',
                 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）',
                 'cna.com.tw']
         ELSE
           ARRAY['https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86 ← 中選會 2024（113 年）第 11 屆立委選舉公報：區域／平地原住民／山地原住民各一個資料夾，依選舉區找 PDF（不分區的公報只有政黨政見）',
                 '候選人當年的官網／臉書競選政見頁',
                 'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見，用搜尋引擎找「姓名 READr」）',
                 'cna.com.tw']
         END,
         1, i.region
  FROM i
  WHERE NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i.politician_id AND pl.election_id = i.election_id AND pl.removed_at IS NULL)
    -- 去重：零政見的 2026 候選人留給 policy_missing（跟 raw 臂 c2026 同條件）
    AND (NOT EXISTS (SELECT 1 FROM politician_elections c WHERE c.politician_id = i.politician_id AND c.election_id = 2026 AND c.candidate_status NOT IN ('not_running'))
         OR EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = i.politician_id AND pl.removed_at IS NULL))
$$;
COMMENT ON FUNCTION contribution_auto_tasks_term_policies IS
  '現任者（2022 縣市長／縣市議員／鄉鎮市長、2024 立委當選）沒有那一屆的政見 → term_policy_missing（補任期政見）；零政見的 2026 候選人留給 policy_missing。2026-10-02 維護者同意。';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT * FROM contribution_auto_tasks_raw()
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫';
