-- 參選紀錄縣市對不上（2026-10-31）：既有的差異一次開成 region_mismatch 任務
--
-- 起因：吳炳輝 2026 縣市長的參選紀錄 35070 掛在台南市（region_id 4175），代理交件 candidacy 寫的是雲林縣、號次 1。
-- 落庫對「已經有縣市層級地區」的紀錄保留原本的 region_id、只寫號次，台南市多一個 1 號、雲林縣少一號，沒人被通知。
-- 新的交件由落庫程式（_shared/region-mismatch.ts 的 openRegionMismatch）開任務；這支只補既有的，不改任何參選紀錄或地區，
-- 任務走一般派工（contribution_tasks 的 INSERT 觸發器排進佇列尾），代理查公告後經 correction（region_id）改正，要走驗證票。
-- 2026-10-31 唯讀查：2026 縣市長已落庫的 candidacy 交件中，交件縣市與紀錄縣市不同的只有這一筆（吳炳輝，4 筆交件同一差異）。
--
-- 條件跟落庫程式同一套：縣市長、現在的地區是縣市層級、交件的縣市（臺／台視為相同）對得到另一個縣市層級的 regions 列；
-- 同一筆參選紀錄、同一個提議縣市只開一件（已有同一對的任務就不開，可重跑）。

INSERT INTO contribution_tasks (title, description, task_type, target, region, priority, reward, status, source, created_by, hint_sources)
SELECT '「' || x.name || '」的縣市長縣市：' || x.cur_region || ' 還是 ' || x.new_region,
       '「' || x.name || '」這一屆縣市長的參選紀錄現在記在「' || x.cur_region || '」，但有交件寫的是「' || x.new_region
         || '」（號次已照交件記下）。請查中選會或選委會的候選人名單／抽籤公告，確認他實際在哪個縣市登記參選。',
       'region_mismatch',
       jsonb_build_object('politician_election_id', x.pe_id, 'politician_id', x.politician_id, 'name', x.name,
                          'election_id', x.election_id, 'election_type', '縣市長', 'cand_no', x.cand_no,
                          'current_region_id', x.cur_region_id, 'current_region', x.cur_region,
                          'proposed_region_id', x.new_region_id, 'proposed_region', x.new_region, 'contribution_id', x.contribution_id),
       x.new_region, 0, 1, 'open', 'auto_dispute', 'region-mismatch', ARRAY[]::TEXT[]
FROM (
  SELECT DISTINCT ON (pe.id, nr.id)
         pe.id AS pe_id, pe.politician_id, p.name, pe.election_id, pe.cand_no,
         cr.id AS cur_region_id, cr.region AS cur_region, nr.id AS new_region_id, nr.region AS new_region, c.id AS contribution_id
  FROM contributions c
  JOIN politician_elections pe ON pe.politician_id = c.applied_politician_id AND pe.election_id = (c.payload->>'election_id')::INTEGER
  JOIN politicians p ON p.id = pe.politician_id
  JOIN regions cr ON cr.id = pe.region_id AND cr.sub_region IS NULL AND cr.village IS NULL
  JOIN regions nr ON nr.region = replace(c.payload->>'region', '臺', '台') AND nr.sub_region IS NULL AND nr.village IS NULL
  WHERE c.contribution_type = 'candidacy'
    AND c.status = 'applied'
    AND pe.election_type = '縣市長'
    AND c.payload->>'election_id' ~ '^[0-9]+$'
    AND nr.id <> cr.id
    AND NOT EXISTS (
      SELECT 1 FROM contribution_tasks t
       WHERE t.task_type = 'region_mismatch'
         AND t.target->>'politician_election_id' = pe.id::TEXT
         AND t.target->>'proposed_region_id' = nr.id::TEXT)
  ORDER BY pe.id, nr.id, c.created_at DESC
) x;
