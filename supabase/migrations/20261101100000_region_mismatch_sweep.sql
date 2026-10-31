-- 參選紀錄縣市對不上：落庫之外的來源也要抓得到（2026-11-01）
--
-- 背景：吳炳輝 2026 縣市長（politician_elections 35070）的 region_id 掛在台南市（4175），從 9/26 起三份通過驗證的 candidacy 交件寫的都是雲林縣；
-- 落庫對「已經有縣市層級地區」的紀錄一律保留原本的 region_id（地區要經驗證流程改，落庫不直接動——這是 #795 的設計，沿用），
-- #795（10/31）之前沒人被通知，之後落庫端才會在交件當下開 region_mismatch 任務。
-- 這支補的是「不經過落庫」的來源：匯入腳本（2026-registered 的 COALESCE(region_id, …) 就是把舊地區原樣留下）、合併人物、手動 SQL、
-- 以及 #795 上線前已經落庫的交件。20261031120000 是一次性的回填；這裡把同一套條件做成可重跑的函式，每小時對一次帳。
--
-- 條件（跟落庫程式、回填同一套）：縣市長；參選紀錄現在的地區是縣市層級；同一人同一屆「最新一筆已落庫的 candidacy 交件」的縣市
-- （臺／台視為相同，「全國」不算）對得到另一個縣市層級的 regions 列；同一筆參選紀錄、同一個提議縣市已有任務（開著或關了）就不再開。
-- 只開任務，不改任何參選紀錄或地區；任務走一般派工（source = auto_dispute＝插隊到最前），代理查公告後經 correction（region_id）改正，要走驗證票。
-- 2026-11-01 唯讀查：符合條件的只有吳炳輝這一筆（已有任務）。
CREATE OR REPLACE FUNCTION region_mismatch_sweep() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
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
    SELECT DISTINCT ON (pe.id)
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
      AND coalesce(c.payload->>'region', '') <> ''
      -- 只看最新一筆交件的縣市：同一人先後交了不同縣市時，以最後那筆為準，不來回開
      AND c.id = (SELECT c2.id FROM contributions c2
                   WHERE c2.contribution_type = 'candidacy' AND c2.status = 'applied'
                     AND c2.applied_politician_id = c.applied_politician_id
                     AND c2.payload->>'election_id' = c.payload->>'election_id'
                     AND coalesce(c2.payload->>'region', '') <> ''
                   ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1)
      AND nr.id <> cr.id
      AND nr.region <> '全國' AND cr.region <> '全國'  -- 「全國」那一列對縣市長不是縣市（regionFitFor）
      AND NOT EXISTS (
        SELECT 1 FROM contribution_tasks t
         WHERE t.task_type = 'region_mismatch'
           AND t.target->>'politician_election_id' = pe.id::TEXT
           AND t.target->>'proposed_region_id' = nr.id::TEXT)
    ORDER BY pe.id
  ) x;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION region_mismatch_sweep IS '縣市長參選紀錄的縣市（縣市層級）跟最新一筆已落庫 candidacy 交件的縣市不同時開 region_mismatch 任務（只開任務、不改地區）；落庫之外來源的對帳，pg_cron 每小時第 33 分；2026-11-01';

DO $do$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'region-mismatch-sweep-hourly';
    PERFORM cron.schedule('region-mismatch-sweep-hourly', '33 * * * *', 'SELECT region_mismatch_sweep();');
  END IF;
END
$do$;
