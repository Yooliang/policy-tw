-- 「站上有、中選會名單沒有」的 2026 已登記者：各開一張「查參選狀態」任務
-- ============================================================
--
-- 起因（小良哥 2026-11-01）：官方名冊鏡像（cec_roster_2026，20261031160000）對帳後，站上標已登記（filed）、
--   中選會選舉專區候選人名單查無此人的有 200 多位。可能是退選、資格不符、也可能只是姓名寫法不同——系統不能自己判斷，
--   更不能直接改參選資料。常設原則不變：資料一律走代理交件＋同儕驗證；這裡只開任務，不改任何參選欄位。
--
-- 做法：
--   1. cec_extra_status_tasks_create(p_created_by)：用 cec_roster_diff() 的 extra（近 3 天內抓成功的單位、名單查無此人）
--      取 2026、狀態 filed 的人，每人一張 contribution_tasks（source=manual，進 manual_open 臂，下一輪 seed 進佇列）。
--      名單會變，所以不寫死名單；函式冪等：同一筆參選紀錄已有 open、或 7 天內關閉的同型任務就不再開。
--   2. 任務型別用 candidate_status_stale：代理交件指引明確（correction 改 politician_elections.candidate_status，或 no_change），
--      payload 骨架的 target_id 會從 target.politician_election_id 帶出；任務說明講清楚三種結果怎麼交。
--   3. 本檔結尾跑一次；之後要再掃一輪可以手動呼叫同一個函式（7 天內不會重複開）。
--
-- 與 roster_check（20261101020000 名單清查收斂）的關係：它的 items 只列「官方有、我們缺」與欄位差異，
--   不含「我們有、官方沒有」的人，所以沒有重複；本檔也不碰 roster_check 的任何東西。

CREATE OR REPLACE FUNCTION cec_extra_status_tasks_create(p_created_by TEXT DEFAULT 'cec-extra-sweep')
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH x AS MATERIALIZED (
    SELECT d.pe_id, d.politician_id, d.our_name AS name, d.election_type, d.county, d.town, d.our_cand_no,
           (SELECT u.url FROM cec_roster_units u
             WHERE u.status = 'ok' AND u.election_type = d.election_type AND replace(u.county, '臺', '台') = d.county
               AND (d.election_type <> '村里長' OR replace(u.town, '臺', '台') = d.town)
             ORDER BY u.url LIMIT 1) AS roster_url
      FROM cec_roster_diff() d
     WHERE d.kind = 'extra' AND d.our_status = 'filed' AND d.pe_id IS NOT NULL
  ), ins AS (
    INSERT INTO contribution_tasks (title, description, task_type, target, region, priority, reward, status, source, created_by, hint_sources)
    SELECT left('查「' || x.name || '」2026 參選狀態（中選會名單查無此人）', 120),
           '中選會 2026 候選人名單（' || x.election_type || '，' || x.county || COALESCE(NULLIF(x.town, ''), '')
             || '）查無「' || x.name || '」，但本站有他的參選紀錄（狀態：已登記）。請查他的參選狀態：退選、資格不符、或只是姓名寫法不同（異體字、同音字）。'
             || CASE WHEN x.roster_url IS NOT NULL THEN '名單網址 ' || x.roster_url || '。' ELSE '' END
             || '怎麼交：確定退選或根本沒登記→correction，target_table＝politician_elections、target_id＝target.politician_election_id，把 candidate_status 改成 not_running，附得出出處（選委會公告、選舉公報、地方新聞）；'
             || '名單上其實有他、只是姓名寫法不同→correction 改 politicians.name 為官方寫法，或用 no_change 說明；'
             || '查不到明確結果就 no_change 並寫你看了哪些地方，不要用猜的改成退選。',
           'candidate_status_stale',
           jsonb_strip_nulls(jsonb_build_object(
             'politician_id', x.politician_id, 'politician_election_id', x.pe_id, 'name', x.name, 'election_id', 2026,
             'election_type', x.election_type, 'region', x.county, 'sub_region', NULLIF(x.town, ''), 'cand_no', x.our_cand_no,
             'candidacy_status', 'filed', 'source_url', x.roster_url, 'origin', 'cec_roster_extra')),
           x.county, 0, 1, 'open', 'manual', p_created_by,
           ARRAY_REMOVE(ARRAY[x.roster_url, 'https://web.cec.gov.tw/central/article/64709', 'https://info.cec.gov.tw/vote2026/'], NULL)
      FROM x
     WHERE NOT EXISTS (
       SELECT 1 FROM contribution_tasks t
        WHERE t.task_type = 'candidate_status_stale'
          AND t.target->>'politician_election_id' = x.pe_id::TEXT
          AND (t.status = 'open' OR t.closed_at > now() - INTERVAL '7 days'))
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION cec_extra_status_tasks_create IS
  '把官方名冊鏡像對帳的 extra（站上已登記、中選會名單查無此人）各開一張 candidate_status_stale 手動任務；同一筆參選紀錄已有 open 或 7 天內關閉的同型任務就跳過。只開任務、不改參選資料。回傳新開張數。2026-11-01';
REVOKE ALL ON FUNCTION cec_extra_status_tasks_create(TEXT) FROM PUBLIC, anon, authenticated;

SELECT cec_extra_status_tasks_create('cec-extra-sweep');
