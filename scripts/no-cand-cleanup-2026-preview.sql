-- no-cand-cleanup-2026.sql 的唯讀預覽（policy-ops#182；2026-11-03）
-- 用法：npx -y supabase@2 db query --linked -f scripts/no-cand-cleanup-2026-preview.sql
-- 一列一項：section / item / value。條件欄 value 結尾的 PASS／FAIL 就是腳本會不會中止。
SET default_transaction_read_only = on;
CREATE TEMP TABLE _d AS SELECT * FROM cec_roster_diff();
CREATE TEMP TABLE _t AS
  SELECT pe.id, pe.politician_id, pe.election_type FROM politician_elections pe
   WHERE pe.election_id = 2026 AND pe.candidacy_status = 'filed' AND pe.cand_no IS NULL;
CREATE TEMP TABLE _x AS SELECT t.* FROM _t t WHERE EXISTS (SELECT 1 FROM _d d WHERE d.kind = 'extra' AND d.pe_id = t.id);
CREATE TEMP TABLE _n AS
  SELECT count(*) AS numbered FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
   WHERE pe.election_id = 2026
     AND pe.election_type IN ('縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長', '鄉鎮市民代表', '直轄市山地原住民區民代表', '村里長')
     AND pe.candidacy_status IS DISTINCT FROM 'withdrawn' AND pe.cand_no IS NOT NULL;

SELECT * FROM (
  SELECT 1 AS o, '條件' AS section, '① missing=0' AS item, (SELECT count(*) FROM _d WHERE kind='missing')::text || CASE WHEN (SELECT count(*) FROM _d WHERE kind='missing') = 0 THEN ' PASS' ELSE ' FAIL' END AS value
  UNION ALL SELECT 2, '條件', '② dup=0', (SELECT count(*) FROM _d WHERE kind='dup')::text || CASE WHEN (SELECT count(*) FROM _d WHERE kind='dup') = 0 THEN ' PASS' ELSE ' FAIL' END
  UNION ALL SELECT 3, '條件', '③ 帶號次的 extra=0', (SELECT count(*) FROM _d WHERE kind='extra' AND our_cand_no IS NOT NULL)::text || CASE WHEN (SELECT count(*) FROM _d WHERE kind='extra' AND our_cand_no IS NOT NULL) = 0 THEN ' PASS' ELSE ' FAIL' END
  UNION ALL SELECT 4, '條件', '④ 帶號次人數＝名單人數', (SELECT numbered FROM _n)::text || ' vs ' || (SELECT count(*) FROM cec_roster_2026)::text || CASE WHEN (SELECT numbered FROM _n) = (SELECT count(*) FROM cec_roster_2026) THEN ' PASS' ELSE ' FAIL' END
  UNION ALL SELECT 5, '條件', '⑤a 已登記沒號次共', (SELECT count(*) FROM _t)::text
  UNION ALL SELECT 6, '條件', '⑤b 其中是 extra（＝對象）', (SELECT count(*) FROM _x)::text
  UNION ALL SELECT 7, '條件', '⑤c 已登記沒號次卻不是 extra（要先補號次）', (SELECT count(*) FROM _t)::text || ' - ' || (SELECT count(*) FROM _x)::text || ' = ' || ((SELECT count(*) FROM _t) - (SELECT count(*) FROM _x))::text || CASE WHEN (SELECT count(*) FROM _t) = (SELECT count(*) FROM _x) THEN ' PASS' ELSE ' FAIL' END
  UNION ALL SELECT 8, '條件', '⑤d 沒號次的 extra 且狀態不是 filed', (SELECT count(*) FROM _d WHERE kind='extra' AND our_cand_no IS NULL AND our_status IS DISTINCT FROM 'filed')::text || CASE WHEN (SELECT count(*) FROM _d WHERE kind='extra' AND our_cand_no IS NULL AND our_status IS DISTINCT FROM 'filed') = 0 THEN ' PASS' ELSE ' FAIL' END
  UNION ALL SELECT 9, '資訊', '名冊單位狀態', (SELECT string_agg(s || ':' || c, ' ' ORDER BY s) FROM (SELECT status s, count(*) c FROM cec_roster_units GROUP BY 1) q)
  UNION ALL SELECT 10, '資訊', 'ok 單位超過 3 天沒抓', (SELECT count(*) FROM cec_roster_units WHERE status='ok' AND fetched_at <= now() - INTERVAL '3 days')::text
  UNION ALL SELECT 20, '影響', '會被改狀態的人數', (SELECT count(*) FROM _x)::text
  UNION ALL SELECT 21, '影響', '其中同一人另有其他參選紀錄（人物最新一屆欄位可能重算）', (SELECT count(DISTINCT x.id) FROM _x x JOIN politician_elections b ON b.politician_id = x.politician_id AND b.id <> x.id)::text
  UNION ALL SELECT 22, '影響', '掛著任期表的', (SELECT count(*) FROM politician_offices o JOIN _x ON o.politician_election_id = _x.id)::text
  UNION ALL SELECT 23, '影響', '開著的「查參選狀態」手動任務（會被收掉）', (SELECT count(*) FROM contribution_tasks t WHERE t.task_type='candidate_status_stale' AND t.source='manual' AND t.status='open' AND t.target->>'origin'='cec_roster_extra' AND t.target->>'politician_election_id' IN (SELECT id::text FROM _x))::text
  UNION ALL SELECT 24, '影響', '待驗證交件（不動，之後落庫會判 superseded）', (SELECT count(*) FROM contributions c WHERE c.status IN ('pending','verified','disputed','approved') AND (c.payload->>'target_id' IN (SELECT id::text FROM _x) OR c.payload->>'politician_election_id' IN (SELECT id::text FROM _x)))::text
  UNION ALL SELECT 30 + row_number() OVER (ORDER BY election_type), '依選舉類別', x.election_type, count(*)::text FROM _x x GROUP BY x.election_type
  UNION ALL
  (SELECT 100 + row_number() OVER (ORDER BY e.id), '樣本（前 10 筆）', e.id::text,
          p.name || '｜' || e.election_type || '｜' || COALESCE(r.region, p.region, '') || COALESCE(' ' || r.sub_region, '') || COALESCE(' ' || r.village, '')
     FROM _x x JOIN politician_elections e ON e.id = x.id JOIN politicians p ON p.id = e.politician_id LEFT JOIN regions r ON r.id = e.region_id
    ORDER BY e.id LIMIT 10)
) q ORDER BY o;
