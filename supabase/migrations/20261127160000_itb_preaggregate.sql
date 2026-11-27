-- issue_too_broad 整表函式：承諾清單改成「先依縣市×議題聚合一次」，不再每個輸出列各掃一次 sc
-- ============================================================
--
-- 起因（正式庫 EXPLAIN ANALYZE，整句 7.35 秒）：
--   contribution_auto_tasks_issue_too_broad()（20261102010000）把「還沒有細項的 縣市×議題×承諾」物化成 CTE sc（約 4.6 萬列），
--   但輸出列的 target.policies 是寫在 SELECT 清單裡的相關子查詢：每個輸出列（87 個縣市×議題）都對 sc 做一次
--   「Filter county/issue → DISTINCT ON → 排序 → LIMIT 200」，每次掃 4.6 萬列丟掉 45,618 列、物化結果還落到暫存檔（temp read=76,821）。
--   這就是計畫裡 SubPlan 4 的 loops=87（每次約 15 毫秒，合計約 1.3 秒）。
--
-- 做法：
--   新增 CTE pol：sc 只掃一遍，依 (縣市, 議題) 去重（一筆承諾一列）、組出前 200 筆的 jsonb 陣列；
--   最後輸出時用 (縣市, 議題) 接上 pol，不再有相關子查詢碰 sc。
--   sc 現在只被兩個聚合各讀一次（grp、pol），都是 loops=1。
--
-- 結果集與舊版相同：欄位、task_id、每一列的值（target 內 policies 的內容與排序、total、threshold、list_cap、source_url、
--   existing_subtopics）、what_we_need、hint_sources、reward、region 都不變；函式簽名不變。
--   唯一的細節：舊版 DISTINCT ON (policy_id) 只照 policy_id 排序，同一筆承諾在同縣市有兩個層級時（同一人兩筆參選紀錄）
--   取哪一列是未定義的；新版補上 level_rank、日期、標題當決勝條件，取較高層級那列，讓結果可重現。
--   正式庫有沒有這種承諾尚未實查；行為上只是把「未定義」變成「定義好」，沒有這種承諾時結果逐列相同。
--   整表沒有 ORDER BY（舊版也沒有），呼叫端（總表）自己排序。
--
-- 本檔只 CREATE OR REPLACE 這一支函式；不動簽名、不動呼叫它的 dispatch_gap_*、不改任何資料。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_issue_too_broad()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH p AS (SELECT issue_too_broad_threshold() AS threshold, issue_too_broad_election() AS eid),
  -- 預篩縣市：一個議題底下的承諾必然是該縣市的承諾，縣市的承諾總數沒超過門檻，底下任何議題都不可能超過，
  -- 所以只對超過的縣市呼叫 issues_scoped（避免每次 seed 把 22 個縣市都算一遍）
  big AS (
    SELECT replace(r.region, '臺', '台') AS county
      FROM p
      JOIN policies po ON po.election_id = p.eid AND po.status = 'Campaign Pledge' AND po.removed_at IS NULL
      JOIN politician_elections pe ON pe.politician_id = po.politician_id AND pe.election_id = p.eid
      JOIN regions r ON r.id = pe.region_id
     WHERE issue_level_of(pe.election_type) IS NOT NULL
     GROUP BY replace(r.region, '臺', '台'), p.threshold
    HAVING count(DISTINCT po.id) > p.threshold
  ),
  -- 還沒有細項的 縣市×議題×承諾（拆分通過的承諾不再算）
  sc AS MATERIALIZED (
    SELECT b.county, s.*
      FROM p CROSS JOIN big b
      CROSS JOIN LATERAL issues_scoped(p.eid, b.county) s
     WHERE NOT EXISTS (SELECT 1 FROM policy_subtopics t WHERE t.policy_id = s.policy_id AND t.issue = s.issue)
  ),
  grp AS (
    SELECT sc.county, sc.issue, count(DISTINCT sc.policy_id) AS n
      FROM sc CROSS JOIN p
     GROUP BY sc.county, sc.issue, p.threshold
    HAVING count(DISTINCT sc.policy_id) > p.threshold
  ),
  -- 每個縣市×議題的承諾清單：sc 掃一遍就聚合完（舊版是每個輸出列各掃一次）。
  -- 先依承諾去重（一筆承諾在同縣市同議題只算一列），再依層級→日期（新到舊、空的排最後）→policy_id 取前 200 筆。
  pol AS (
    SELECT x.county, x.issue,
           jsonb_agg(jsonb_build_object('policy_id', x.policy_id, 'title', x.title, 'level', x.level)
                     ORDER BY x.level_rank, x.proposed_date DESC NULLS LAST, x.policy_id) AS policies
      FROM (
        SELECT d.*,
               row_number() OVER (PARTITION BY d.county, d.issue
                                  ORDER BY d.level_rank, d.proposed_date DESC NULLS LAST, d.policy_id) AS rn
          FROM (
            SELECT DISTINCT ON (s.county, s.issue, s.policy_id)
                   s.county, s.issue, s.policy_id, s.title, s.level, s.level_rank, s.proposed_date
              FROM sc s
             ORDER BY s.county, s.issue, s.policy_id, s.level_rank, s.proposed_date DESC NULLS LAST, s.title
          ) d
      ) x
     WHERE x.rn <= 200
     GROUP BY x.county, x.issue
  ),
  -- 已經有人交了這個縣市×議題的拆分、還在等票的先不派
  queued AS (
    SELECT DISTINCT c.payload ->> 'region' AS region, c.payload ->> 'issue' AS issue
      FROM contributions c WHERE c.contribution_type = 'policy_subtopics' AND c.status IN ('pending', 'verified')
  )
  SELECT 'auto:issue_too_broad:' || p.eid || ':' || g.county || ':' || regexp_replace(g.issue, '\s+', '_', 'g'),
         'issue_too_broad',
         jsonb_build_object(
           'election_id', p.eid, 'region', g.county, 'issue', g.issue, 'total', g.n, 'threshold', p.threshold, 'list_cap', 200,
           'policies', COALESCE(pl.policies, '[]'::JSONB),
           'existing_subtopics', (SELECT COALESCE(jsonb_agg(q.subtopic ORDER BY q.cnt DESC, q.subtopic), '[]'::JSONB)
                                    FROM (SELECT t.subtopic, count(*) AS cnt FROM policy_subtopics t WHERE t.issue = g.issue GROUP BY t.subtopic) q),
           'source_url', 'https://policy-tw.web.app/election/' || p.eid || '/' || g.county || '?view=issues'),
         g.county || '的「' || g.issue || '」議題在 ' || p.eid || ' 年有 ' || g.n || ' 筆承諾還沒有細項，超過 ' || p.threshold
           || ' 筆，一個大類太寬、各級承諾很難比到同一件事。請讀 target.policies 的承諾，提出 2～6 個細項標籤（每個 2～12 字，例如「托育」「敬老津貼」），'
           || '並逐筆歸類：**優先沿用 target.existing_subtopics 已存在的細項名**，真的沒有合適的才新取名；一筆承諾歸進最貼切的一個細項，'
           || '實在歸不進去的就不要放進 assignments（不要硬塞）。用 policy_subtopics 交一份：election_id、region、issue 照 target 原樣帶回，'
           || 'subtopics 是你用到的細項名（每個都要有承諾歸進去），assignments 是 [{policy_id, subtopic}]（subtopic 必須在 subtopics 裡）；'
           || '大類議題不會被改掉，細項只是在大類底下再分一層。source_urls 放 target.source_url。',
         ARRAY['https://policy-tw.web.app/election/' || p.eid || '/' || g.county || '?view=issues'],
         1, g.county
    FROM grp g CROSS JOIN p
    LEFT JOIN pol pl ON pl.county = g.county AND pl.issue = g.issue
   WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.region = g.county AND q.issue = g.issue)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_issue_too_broad IS
  '2026 縣市×議題的承諾數（還沒有細項的，範圍同 issues_scoped）超過門檻（activity_rules.params.threshold，預設 150）→ issue_too_broad 任務，一個縣市×議題一張，列出該批承諾與全站該議題已存在的細項名（policy-ops#173 P1）。條件不再成立時 seed 自動收回。承諾清單先依縣市×議題聚合一次（20261127160000，舊版每個輸出列各掃 sc 一次）。';
