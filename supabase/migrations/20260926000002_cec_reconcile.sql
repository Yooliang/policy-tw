-- 參選紀錄對中選會名單，對不上就開任務（2026-09-26，小良哥：「之後系統如何發現此類問題」→ 好）
--
-- 只看已投票、而且 cec_candidates 已經同步到的屆別×選舉別（沒同步到的範圍不判，免得把「還沒抓」當成「查無此人」）。
-- 兩種對不上：
--   not_in_cec     我們說他在這一屆參選了（正式狀態或有選舉結果），中選會同屆同選舉別查無同名者
--   region_mismatch 中選會有這個人，但在別的縣市（09-25 的桃園市復興區被存成台南市）
-- 系統不改資料，只開任務：一個縣市×選舉別×種類一個任務，一次最多 20 筆（代理一次交件上限），
-- 已經在任何 open 任務裡的那一筆不重開。
-- 疑似重複人物不另外開一種：同名兩筆若有一筆是錯的，它會在這裡以 not_in_cec 或 region_mismatch 出現；
-- 放寬 duplicate_politician 條件（同屆同選舉別）實測多 72 對，多半是不同縣市的同名村里長，誤報太多。

CREATE OR REPLACE FUNCTION cec_reconcile_findings()
RETURNS TABLE (kind TEXT, election_id INTEGER, election_type TEXT, region TEXT, pe_id INTEGER, politician_id UUID, name TEXT, detail TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH synced AS (
    SELECT DISTINCT c.election_id, c.election_type FROM cec_candidates c
  ),
  ours AS (
    SELECT pe.id AS pe_id, pe.politician_id, pe.election_id, pe.election_type,
           COALESCE(r.region, p.region) AS region, r.sub_region, p.name, cec_name_norm(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
      JOIN synced s ON s.election_id = pe.election_id AND s.election_type = pe.election_type
     WHERE pe.candidate_status IN ('confirmed', 'registered', 'qualified', 'elected', 'defeated') OR pe.election_result IS NOT NULL
  )
  SELECT 'not_in_cec', o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name,
         '中選會 ' || o.election_id || ' ' || o.election_type || ' 全國名單查無同名者'
    FROM ours o
   WHERE NOT EXISTS (SELECT 1 FROM cec_candidates c
                      WHERE c.election_id = o.election_id AND c.election_type = o.election_type AND c.name_norm = o.nn)
  UNION ALL
  SELECT 'region_mismatch', o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name,
         '中選會名單上在 ' || string_agg(DISTINCT c.region || COALESCE(' ' || c.sub_region, ''), '、') || '，我們存的是 ' || COALESCE(o.region, '（空）')
    FROM ours o
    JOIN cec_candidates c ON c.election_id = o.election_id AND c.election_type = o.election_type AND c.name_norm = o.nn
   WHERE NOT EXISTS (SELECT 1 FROM cec_candidates c2
                      WHERE c2.election_id = o.election_id AND c2.election_type = o.election_type AND c2.name_norm = o.nn
                        AND c2.region = o.region)
   GROUP BY o.election_id, o.election_type, o.region, o.pe_id, o.politician_id, o.name
$$;
COMMENT ON FUNCTION cec_reconcile_findings IS '我們的參選紀錄 vs 中選會名單（只看已同步的屆別×選舉別）：查無此人、縣市不符';
GRANT EXECUTE ON FUNCTION cec_reconcile_findings() TO anon, authenticated;

-- 把新發現開成任務（排程每週跑，在 cec-sync 之後）。回傳開了幾個任務。
CREATE OR REPLACE FUNCTION cec_reconcile_open_tasks() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER := 0; g RECORD;
BEGIN
  FOR g IN
    WITH f AS (
      SELECT * FROM cec_reconcile_findings() x
       WHERE NOT EXISTS (
         SELECT 1 FROM contribution_tasks t
          WHERE t.status = 'open' AND t.target ? 'politician_election_ids'
            AND t.target->'politician_election_ids' @> to_jsonb(x.pe_id))
    ),
    numbered AS (
      SELECT f.*, (row_number() OVER (PARTITION BY kind, election_id, election_type, region ORDER BY name) - 1) / 20 AS chunk FROM f
    )
    SELECT kind, election_id, election_type, region, chunk,
           jsonb_agg(pe_id ORDER BY name) AS ids,
           string_agg('- ' || name || '（politician_id=' || politician_id || '，參選紀錄 id=' || pe_id || '）：' || detail, E'\n' ORDER BY name) AS lines,
           count(*) AS n
      FROM numbered GROUP BY kind, election_id, election_type, region, chunk
  LOOP
    INSERT INTO contribution_tasks (title, description, task_type, target, region, priority, reward, created_by, source, hint_sources)
    VALUES (
      CASE g.kind
        WHEN 'not_in_cec' THEN '核對 ' || g.election_id || ' ' || COALESCE(g.region, '') || g.election_type || '：' || g.n || ' 位在中選會查無此人'
        ELSE '核對 ' || g.election_id || ' ' || g.election_type || '：' || g.n || ' 位的縣市跟中選會不符（我們存的是 ' || COALESCE(g.region, '空白') || '）'
      END,
      '系統每週拿我們的參選紀錄對中選會名單，這幾筆對不上：' || E'\n' || g.lines || E'\n\n'
      || CASE g.kind
           WHEN 'not_in_cec' THEN '請逐位到中選會選舉資料庫（db.cec.gov.tw）核對：名單上確實沒有 → correction 把該筆參選紀錄（target_table=politician_elections）的 candidate_status 改成 not_running；其實有參選、只是名字寫錯 → correction 改 politicians.name；是另一筆人物的重複 → merge_politician。'
           ELSE '請到中選會選舉資料庫核對後，一位一筆 correction：target_table=politicians、changes 把 region 改成中選會名單上的縣市（sub_region 也不對就一起改），附中選會頁面。'
         END
      || ' 一位一筆，一次最多 20 筆。查不到名單就回 no_change（outcome=unreachable）。',
      'other',
      jsonb_build_object('kind', 'cec_reconcile_' || g.kind, 'election_id', g.election_id, 'election_type', g.election_type, 'region', g.region, 'politician_election_ids', g.ids),
      g.region, 1, 2, 'cec-reconcile', 'manual', ARRAY['https://db.cec.gov.tw/']
    );
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION cec_reconcile_open_tasks IS '把 cec_reconcile_findings 的新發現開成任務（縣市×選舉別×種類一個、每個最多 20 筆），已在 open 任務裡的不重開';
