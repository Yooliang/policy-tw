-- 「中選會名單有、本站沒有」的人：名單清查結案後仍缺，各開一張單人「補參選紀錄」任務（policy-ops#175 補充）
-- ============================================================
--
-- 起因（小良哥 2026-11-02）：官方名冊鏡像（cec_roster_2026，20261031160000）的 cec_roster_diff() 有兩個方向：
--   extra＝我們有、官方沒有（20261101030000 已每人開一張查參選狀態）；missing＝官方有、我們缺（本檔）。
--   缺人原本靠名單清查（roster_check，一地區一張）補，但清查交過新增被退件、清查任務結案後，這個人就沒有任何任務會再補他。
--   例：花蓮縣花蓮市國盛里 周玉梅（村里長 1 號，新生黨，出生 民國 65 年），清查兩次新增都被退件。
--
-- 做法（照 extra 那支的寫法）：
--   1. cec_missing_person_tasks_create(p_created_by)：對 cec_roster_diff() 的 missing（2026），所屬單位的 roster_check
--      「已結案」才開一張 contribution_tasks（source=manual，進 manual_open 臂，下一輪 seed 進佇列）。
--      「已結案」＝task_dispatches 沒有 auto:roster_check:2026:<縣市><鄉鎮>:<選舉別> 這一列，或有但在冷卻中（cooling）；
--      清查還開著的單位不開（缺人已在那張的 items 裡，避免同一個人兩張單）。
--      冪等：同一位（target.diff_key）已有 open、或 7 天內關閉的同型任務就不再開。
--   2. 任務型別沿用 candidacy_source_missing（收尾是 candidacy 交件），target.kind＝roster_missing、target.origin＝cec_roster_missing；
--      說明自帶做法：官方名單網址、姓名、村里（村里長用 li_code 對 regions.admin_code 末三碼）、號次、政黨、出生年，
--      人物已存在（target.same_name_politicians 列出同名者）依出生年判斷掛既有人物，同時交號次。
--   3. 只開任務，不寫任何參選資料；之後資料仍走代理交件＋同儕驗證。
--   4. 排程：沿用同一檔 20261031160000 的 pg_cron 直呼 SQL 的做法（cec-roster-reconcile-daily 那種），
--      每天 22:40 UTC（鏡像與 22:25 備援對帳之後）跑一次。本檔結尾也跑一次。

CREATE OR REPLACE FUNCTION cec_missing_person_tasks_create(p_created_by TEXT DEFAULT 'cec-missing-sweep')
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH q AS MATERIALIZED (
    -- 還在佇列、也不在冷卻的名單清查（開著的）
    SELECT replace(t.task_id, '臺', '台') AS tid
      FROM task_dispatches t
     WHERE t.task_id LIKE 'auto:roster_check:2026:%' AND NOT t.cooling
  ), x AS MATERIALIZED (
    SELECT d.diff_key, d.election_type, d.county, d.town, d.unit, d.cand_no, d.roster_name AS name, d.roster_party AS party,
           d.roster_birth AS birth, d.roster_url, d.roster_li_code AS li_code,
           CASE WHEN length(COALESCE(d.roster_birth, '')) >= 7 THEN 1911 + NULLIF(substr(d.roster_birth, 1, 3), '')::INTEGER
                WHEN length(COALESCE(d.roster_birth, '')) = 6 THEN 1911 + NULLIF(substr(d.roster_birth, 1, 2), '')::INTEGER END AS birth_year
      FROM cec_roster_diff() d
     WHERE d.kind = 'missing' AND d.roster_name IS NOT NULL AND btrim(d.roster_name) <> ''
       AND NOT EXISTS (SELECT 1 FROM q WHERE q.tid = 'auto:roster_check:2026:' || d.county || d.town || ':' || d.election_type)
  ), y AS MATERIALIZED (
    SELECT x.*,
           (SELECT v.village FROM regions v
             WHERE x.election_type = '村里長' AND x.li_code ~ '^[0-9]{3}$' AND v.village IS NOT NULL
               AND replace(v.region, '臺', '台') = x.county AND replace(v.sub_region, '臺', '台') = x.town
               AND right(v.admin_code, 3) = x.li_code
             ORDER BY v.id LIMIT 1) AS village,
           (SELECT COALESCE(jsonb_agg(jsonb_build_object('politician_id', s.id, 'party', s.party, 'region', s.region, 'sub_region', s.sub_region, 'birth_year', s.birth_year)), '[]'::jsonb)
              FROM (SELECT p.id, p.party, p.region, p.sub_region, p.birth_year FROM politicians p
                     WHERE p.merged_into IS NULL AND p.name = x.name ORDER BY p.id LIMIT 5) s) AS same_name
      FROM x
  ), ins AS (
    INSERT INTO contribution_tasks (title, description, task_type, target, region, priority, reward, status, source, created_by, hint_sources)
    SELECT left('補「' || y.name || '」2026 參選紀錄（中選會名單有、本站沒有）', 120),
           '中選會 2026 候選人名單（' || y.election_type || '，' || y.county || COALESCE(NULLIF(y.town, ''), '')
             || COALESCE('，' || y.village, '') || '）有「' || y.name || '」，本站沒有他的參選紀錄，而這個地區的名單清查已經結案、沒有別的任務會補他。'
             || '名單資料：姓名 ' || y.name || '；單位 ' || COALESCE(y.unit, '') || COALESCE('；村里 ' || y.village, '')
             || COALESCE('；號次 ' || y.cand_no, '') || COALESCE('；政黨 ' || y.party, '')
             || COALESCE('；出生 ' || y.birth || '（民國年月日' || COALESCE('，西元 ' || y.birth_year || ' 年', '') || '）', '') || '。'
             || CASE WHEN y.roster_url IS NOT NULL THEN '官方名單網址 ' || y.roster_url || '。' ELSE '' END
             || '怎麼交：先查人物是否已存在（target.same_name_politicians 列出同名者；依出生年與縣市、經歷判斷是不是同一人）。'
             || '已存在→用 candidacy 帶 politician_id 掛上既有人物；不存在→用 candidacy 新增（附人物基本資料）。'
             || '兩種都要：election_id 2026、election_type 與 region 照 target（村里長另填 sub_region 鄉鎮、village 村里）、candidate_status 填 registered、'
             || 'cand_no 填名單上的號次（同時交號次，不用另開單）、party 照名單原字，source_urls 第一個放上面的官方名單網址。'
             || '名單的姓名其實是本站某位已有的人（寫法不同）→ 用 no_change 說明，不要重複新增；查不到明確結果也用 no_change 寫你看了哪些地方。',
           'candidacy_source_missing',
           jsonb_strip_nulls(jsonb_build_object(
             'kind', 'roster_missing', 'origin', 'cec_roster_missing', 'diff_key', y.diff_key, 'election_id', 2026,
             'election_type', y.election_type, 'region', y.county, 'sub_region', NULLIF(y.town, ''), 'village', y.village,
             'unit', y.unit, 'name', y.name, 'party', y.party, 'cand_no', y.cand_no, 'birth_roc', y.birth, 'birth_year', y.birth_year,
             'candidate_status', 'registered', 'source_url', y.roster_url, 'same_name_politicians', y.same_name)),
           y.county, 0, 1, 'open', 'manual', p_created_by,
           ARRAY_REMOVE(ARRAY[y.roster_url, 'https://web.cec.gov.tw/central/article/64709', 'https://info.cec.gov.tw/vote2026/'], NULL)
      FROM y
     WHERE NOT EXISTS (
       SELECT 1 FROM contribution_tasks t
        WHERE t.task_type = 'candidacy_source_missing'
          AND t.target->>'kind' = 'roster_missing'
          AND t.target->>'diff_key' = y.diff_key
          AND (t.status = 'open' OR t.closed_at > now() - INTERVAL '7 days'))
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM ins;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION cec_missing_person_tasks_create IS
  '把官方名冊鏡像對帳的 missing（中選會名單有、本站沒有）在該單位名單清查（roster_check）已結案時各開一張 candidacy_source_missing（kind=roster_missing）手動任務；清查還開著的單位不開；同一位（diff_key）已有 open 或 7 天內關閉的同型任務就跳過。只開任務、不寫參選資料。回傳新開張數。2026-11-02';
REVOKE ALL ON FUNCTION cec_missing_person_tasks_create(TEXT) FROM PUBLIC, anon, authenticated;

-- 排程（UTC）：每天 22:40，鏡像（18～21 時）與 22:25 備援對帳之後
DO $do$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'cec-missing-person-tasks-daily';
    PERFORM cron.schedule('cec-missing-person-tasks-daily', '40 22 * * *', $q$SELECT cec_missing_person_tasks_create('cec-missing-sweep');$q$);
  END IF;
END
$do$;

SELECT cec_missing_person_tasks_create('cec-missing-sweep');
