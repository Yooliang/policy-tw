-- 2026 縣市長的「補政見」缺口改看**這一屆**的政見（2026-09-23 小良哥：六都人員政見要做成可分享的比較圖）
--
-- 原本 contribution_auto_tasks_mayor_policies 數的是這個人全部的政見，而且只在 1～2 筆時派。
-- 現任者的上屆政見會算進去：蔣萬安 3 筆（2022）、張善政 6 筆、江啟臣 5 筆——2026 這屆是 0 或 1 筆，
-- 系統卻當作「有政見了」，從來不派任務去補。實查六都 13 位主要候選人：8 位 2026 政見不到 5 筆，
-- 其中 2 位現任者是 0 筆；佇列裡的補政見任務卻只有小黨候選人的。
--
-- 改成：只數 election_id = 2026 的政見，加上還在等票的 2026 政見提交；合計不到 5 筆就派。
-- 總數 0 筆的仍由 raw 臂處理（task_id 相同），這裡排掉避免重複。
-- 任務文字告訴代理：這屆已有幾筆、已有哪些類別、另有幾筆是別屆的不算，優先補還沒有的類別。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_mayor_policies()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT p.id, p.name, p.party, p.region,
           (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = p.id AND pl.removed_at IS NULL) AS n_all,
           (SELECT COUNT(*) FROM policies pl WHERE pl.politician_id = p.id AND pl.removed_at IS NULL AND pl.election_id = 2026) AS n2026,
           (SELECT COUNT(*) FROM contributions c
             WHERE c.contribution_type = 'policy' AND c.status IN ('pending', 'verified')
               AND c.payload->>'politician_id' = p.id::TEXT
               AND COALESCE(NULLIF(c.payload->>'election_id', ''), '2026') = '2026') AS queued,
           (SELECT string_agg(DISTINCT pl.category, '、') FROM policies pl
             WHERE pl.politician_id = p.id AND pl.removed_at IS NULL AND pl.election_id = 2026 AND pl.category IS NOT NULL) AS cats
    FROM politicians p
    WHERE p.merged_into IS NULL AND is_2026_mayor_candidate(p.id)
  )
  SELECT 'auto:policy_missing:' || m.id, 'policy_missing',
         jsonb_build_object('politician_id', m.id, 'name', m.name, 'party', m.party, 'region', m.region,
                            'election_id', 2026, 'election_type', '縣市長',
                            'policies_now', m.n2026, 'policies_other_terms', m.n_all - m.n2026, 'queued', m.queued,
                            'categories_now', m.cats),
         m.name || '（' || COALESCE(m.region, '') || ' 2026 縣市長候選人）**2026 這一屆**的政見只有 ' || m.n2026 || ' 筆' ||
           CASE WHEN m.queued > 0 THEN '（另有 ' || m.queued || ' 筆還在等票）' ELSE '' END ||
           CASE WHEN m.n_all - m.n2026 > 0 THEN '；另外 ' || (m.n_all - m.n2026) || ' 筆是過去任期或上屆的，不算這屆' ELSE '' END ||
           CASE WHEN m.cats IS NOT NULL THEN '。這屆已有的類別：' || m.cats ELSE '' END ||
           '。縣市長是網站的主要內容，請補這一屆的政見：找有出處的具體 2026 競選政見，最多 5 筆、每筆一個 policy 型別、各附自己的出處，election_id 填 2026，優先補還沒有的類別。' ||
           '先看 current.queued_policies 與既有政見，已經有的不要重複交；現任者任內的施政、上屆的承諾不是這屆的政見，不要當 2026 交。' ||
           '找到幾筆交幾筆，不要為了湊數交口號、願景或個人表態。',
         ARRAY['候選人官網／官方社群的政見頁', 'cec.gov.tw 選舉公報', 'cna.com.tw', 'pts.org.tw'], 2, m.region
  FROM m
  WHERE m.n_all > 0                 -- 總數 0 筆的由 raw 臂派，不重複
    AND m.n2026 + m.queued < 5
$$;
COMMENT ON FUNCTION contribution_auto_tasks_mayor_policies IS
  '2026 縣市長這一屆的政見（含等票中的）不到 5 筆就派補政見任務。2026-09-23 前數的是全部政見，現任者的上屆政見被當成這屆的，蔣萬安／張善政 2026 是 0 筆卻從來沒被派過。';
