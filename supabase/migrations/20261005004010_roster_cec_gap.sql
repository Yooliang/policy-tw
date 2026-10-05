-- 已投票屆別的名單缺口：中選會名單有、我們沒有的人，聚成名單清查任務（2026-10-05，#348 後續）
--
-- 小良哥 2026-10-05 常設裁決：資料一律走流程，主線只補流程缺口。這支**只新增派工臂，不碰任何人物或參選紀錄**。
--
-- 缺口：台北市中山、中正、信義、大安四區 2022 里長我們 0 位（中選會 331 位）。掃全國（10-05 唯讀）：
--   2022 鄉鎮市民代表 3,225 位一位都沒有（13 縣、198 個鄉鎮市）、直轄市山地原住民區長 20 位都沒有、
--   村里長另有 5 個原住民鄉各少 5 位上下、原住民區民代表茂林區少 3 位。
-- 為什麼沒有任何流程帶進來：
--   ① 2022 這一屆的村里長、議員、鄉鎮市長是早期整批匯入的（不是走任務），那批就缺這四區、也沒有代表與原住民區長；
--   ② 名單清查（roster_check_scope）只有 2026 的列，村里長那支臂（contribution_auto_tasks_roster_villages）把 2026 寫死；
--   ③ 中選會名單同步（cec-sync）每週把 2022 名單抓進 cec_candidates，但拿它來比對的兩支只看一個方向或一小部分：
--      cec_reconcile_findings 只找「我們有、中選會沒有」與縣市不符；contribution_auto_tasks_elected_missing（#357）
--      只派「當選」而且只限五種有任期政見的選舉（村里長、代表當選人上萬，刻意不放）。
--      「中選會有、我們沒有」的落選者，以及村里長、代表，沒有任何一支臂會派。
--
-- 做法：已投票的屆別，名單已經在 cec_candidates 裡，系統自己就算得出哪裡缺人，不必像 2026 那樣請代理去找名冊。
-- 依「鄉鎮市區」（村里長、鄉鎮市民代表、原住民區民代表：一個鄉鎮動輒幾十人）或「縣市」（其他選舉別）分單位，
-- 中選會名單上的人用姓名鍵（cec_name_key，#357）對我們同屆、同選舉別、同縣市的參選紀錄，
-- **我們 0 筆，或少了 3 位以上而且少兩成以上**的單位，派一件 roster_check（沿用既有型別，不新增任務型別），
-- 缺的人直接列在 target.missing（姓名、選區或村里、當選與否、號次），代理逐位到中選會選舉資料庫核對後用 candidacy 補。
--   - 已經派出去的單位（task_dispatches 有這個 task_id）補到一半、缺口掉到門檻以下也繼續派，直到補完或有人交 roster_check；
--   - 當選、而且是 elected_missing 那五種的人不列（那支臂逐位派，免得兩件任務搶同一個人）；
--   - 不分區立委是政黨名單、不是個人參選，不列（當選的由 elected_missing 派）；
--   - 代理交了 roster_check（附 cec_count）之後 30 天不再派同一個單位——剩下對不上的多半是姓名寫法不同，
--     不要每 10 分鐘派一次；只是試過沒查到（cec_count 空）照舊壓 roster_attempt_cooldown_days()。
--   - 補上之後缺口自己消失（seed_auto_task_queue 收回號碼牌），不必等 roster_check。
-- task_id 跟 2026 村里長清查同一種形狀（auto:roster_check:<屆別>:<縣市＋鄉鎮>:<選舉別>），屆別不同不會撞號。
--
-- 10-05 唯讀資料估計：上線當下約 211 件（村里長 9、鄉鎮市民代表 198、原住民區民代表 1、原住民區長 3），
-- 列出約 3,600 位；cec-sync 補抓原住民選區（同日另一個 PR）之後，代表再多約 134 位（落在既有的鄉鎮單位裡）、
-- 議員視各縣市缺的比例而定。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_roster_cec_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT c.election_id, c.election_type, c.name, c.name_norm, c.sub_region, c.village, c.elected, c.cand_no, c.cec_cand_id,
           replace(c.region, '臺', '台') AS county,
           -- 一個鄉鎮動輒幾十人的三種，以鄉鎮市區為單位；代表的 sub_region 是「南投市第01選舉區」「蘭嶼鄉選舉區」，去掉選舉區
           CASE WHEN c.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表')
                THEN COALESCE(NULLIF(regexp_replace(COALESCE(c.sub_region, ''), '(第[0-9]+)?選舉區$', ''), ''), '')
                ELSE '' END AS town
      FROM cec_candidates c
     -- 不分區立委是政黨名單，不是個人參選；當選的由 contribution_auto_tasks_elected_missing 派
     WHERE NOT (c.region = '全國' AND c.sub_region = '不分區')
  ),
  ours AS (
    SELECT DISTINCT pe.election_id, pe.election_type, replace(COALESCE(r.region, p.region), '臺', '台') AS county, cec_name_key(p.name) AS nn
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.election_id IN (SELECT DISTINCT x.election_id FROM cec_candidates x)
  ),
  marked AS (
    SELECT c.*,
           EXISTS (SELECT 1 FROM ours o
                    WHERE o.election_id = c.election_id AND o.election_type = c.election_type
                      AND o.county = c.county AND o.nn = c.name_norm) AS matched,
           -- 當選而且是 elected_missing 那五種：那支臂逐位派任務，這裡不重複列
           COALESCE(c.elected, false) AND c.election_type IN ('立法委員', '縣市長', '縣市議員', '鄉鎮市長', '直轄市山地原住民區長') AS covered_elsewhere
      FROM c
  ),
  units AS (
    SELECT m.election_id, m.election_type, m.county, m.town,
           count(*) AS cec_n,
           count(*) FILTER (WHERE m.elected) AS cec_elected,
           count(*) FILTER (WHERE m.matched) AS ours_n,
           count(*) FILTER (WHERE NOT m.matched) AS missing_n,
           count(*) FILTER (WHERE NOT m.matched AND NOT m.covered_elsewhere) AS list_n,
           jsonb_agg(jsonb_build_object('name', m.name, 'sub_region', m.sub_region, 'village', m.village,
                                        'elected', m.elected, 'cand_no', m.cand_no, 'cec_cand_id', m.cec_cand_id)
                     ORDER BY m.sub_region, m.village, m.cand_no, m.name)
             FILTER (WHERE NOT m.matched AND NOT m.covered_elsewhere) AS missing
      FROM marked m
     GROUP BY m.election_id, m.election_type, m.county, m.town
  ),
  picked AS (
    SELECT u.*, u.county || u.town AS unit,
           -- 這一種選舉，candidacy 的地區欄怎麼填
           CASE
             WHEN u.election_type = '村里長'
               THEN 'region 填「' || u.county || '」、sub_region 填「' || u.town || '」、village 填每位的村里（target.missing 的 village）'
             WHEN u.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
               THEN 'region 填「' || u.county || '」、sub_region 填「' || u.town || '」（鄉鎮市區名，不要寫選舉區）'
             WHEN u.election_type IN ('鄉鎮市長', '直轄市山地原住民區長')
               THEN 'region 填「' || u.county || '」、sub_region 填每位的鄉鎮市區（target.missing 的 sub_region）'
             WHEN u.election_type = '縣市議員'
               THEN 'region 填「' || u.county || '」、electoral_district 填每位的選舉區（target.missing 的 sub_region，例：第07選舉區）'
             WHEN u.election_type = '立法委員' AND u.county = '全國'
               THEN 'region 填「全國」、electoral_district 填每位的 sub_region（平地原住民或山地原住民）'
             WHEN u.election_type = '立法委員'
               THEN 'region 填「' || u.county || '」、electoral_district 填每位的選區（target.missing 的 sub_region）'
             ELSE 'region 填「' || u.county || '」'
           END AS fields_how
      FROM units u
     WHERE u.list_n > 0
       -- 我們 0 筆，或明顯偏少（少 3 位以上而且少兩成以上）；零星一兩位多半是姓名寫法不同，交給 cec_reconcile 那條路
       AND (u.ours_n = 0 OR (u.missing_n >= 3 AND u.missing_n * 5 >= u.cec_n)
            -- 已經派出去的單位：補到一半缺口變小（中山區 87 位補了 70 位，剩 17 位不到兩成）也要繼續派，
            -- 直到補完、或有人交 roster_check 收尾——不然門檻會在補到一半時把任務收回，剩下的人永遠沒人補（PGlite 實跑抓到的）
            OR EXISTS (SELECT 1 FROM task_dispatches d
                        WHERE d.task_id = 'auto:roster_check:' || u.election_id || ':' || u.county || u.town || ':' || u.election_type))
  )
  SELECT 'auto:roster_check:' || x.election_id || ':' || x.unit || ':' || x.election_type,
         'roster_check',
         jsonb_build_object('election_id', x.election_id, 'region', x.unit, 'county', x.county, 'township', NULLIF(x.town, ''),
                            'election_type', x.election_type, 'list_source', 'cec',
                            'cec_count', x.cec_n, 'cec_elected', x.cec_elected, 'ours_count', x.ours_n,
                            'missing_count', x.list_n,
                            -- 一件最多列 120 位（大安區 98 位是目前最多的）；多的補完一批，下一輪會列出剩下的
                            'missing', jsonb_path_query_array(x.missing, '$[0 to 119]'),
                            'missing_truncated', x.list_n > 120,
                            'last_checked', rc.last_checked, 'last_failed_attempt', rc.last_attempt_without_count),
         x.unit || ' ' || x.election_id || ' ' || x.election_type || '名單缺人：中選會選舉資料庫上有 ' || x.cec_n || ' 位候選人（當選 '
           || x.cec_elected || ' 位），我們只對得上 ' || x.ours_n || ' 位；要補的 ' || x.list_n || ' 位列在 target.missing'
           || CASE WHEN x.list_n > 120 THEN '（只列前 120 位，補完下一輪會列出剩下的）' ELSE '' END || '。'
           || '這一屆已經投票，名單就在中選會選舉資料庫（db.cec.gov.tw），不用去找登記公告。'
           || '請逐位核對後，每位用 candidacy 型別補一筆：election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、'
           || x.fields_how
           || '、candidate_status 填 confirmed、election_result 照中選會填 elected 或 not_elected（查得到號次 cand_no 與得票數就一起附），'
           || 'source_urls 附你核對的中選會頁面；系統會拿中選會的資料自動核對，我們資料庫裡已有這個人（同名只有一位）而且姓名、縣市、當選與否都對得上的，直接上線。'
           || '名字相同不代表同一人：先用第 7 節的唯讀查詢看我們有沒有同名的人、他的參選紀錄與出生年，確定是同一人才填他的 politician_id，不是就只填 name。'
           || '一次最多 20 筆，可分多次交。全部補完才用 roster_check 收尾（election_id、region、election_type 照 target 原樣帶回，region 就是「'
           || x.unit || '」這一串；cec_count 填中選會名單上的人數）；只補了一部分就不要交 roster_check，剩下的人系統下一輪會再派。',
         ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：選該屆、該選舉、該縣市（鄉鎮）看完整名單與得票',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 逐位核對歷屆參選與當選',
               'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":' || x.election_id || '}'],
         2, x.county
    FROM picked x
    LEFT JOIN LATERAL (
      -- 兩個時鐘（同 2026 的清查）：真的清查完的（cec_count 有值）壓 30 天；只是試過沒查到的壓 roster_attempt_cooldown_days
      SELECT MAX(checked_at) FILTER (WHERE cec_count IS NOT NULL) AS last_checked,
             MAX(checked_at) FILTER (WHERE cec_count IS NULL)     AS last_attempt_without_count
        FROM roster_checks k
       WHERE k.election_id = x.election_id AND k.region = x.unit AND k.election_type = x.election_type
    ) rc ON TRUE
   WHERE (rc.last_checked IS NULL OR rc.last_checked < now() - INTERVAL '30 days')
     AND (rc.last_attempt_without_count IS NULL
          OR rc.last_attempt_without_count < now() - (roster_attempt_cooldown_days() || ' days')::INTERVAL)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_roster_cec_gap IS
  '已投票屆別的名單缺口：中選會名單（cec_candidates）有、我們沒有的人，依鄉鎮市區或縣市聚成 roster_check，缺的人列在 target.missing（2026-10-05）';

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END,
         r.hint_sources, r.reward, r.region
    FROM contribution_auto_tasks_raw() r
   WHERE r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region)
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_villages()
  UNION ALL SELECT * FROM contribution_auto_tasks_township_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_region_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_elected_missing()
  UNION ALL SELECT * FROM contribution_auto_tasks_roster_cec_gap()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。'
  '2026-10-03 名單清查依 roster_check_scope.regions 濾掉沒有這種選舉的縣市。'
  '2026-10-04 加村里長（鄉鎮市區層級）的清查臂；鄉鎮市長／代表類的清查說明補「要填 sub_region」。'
  '2026-10-04 加 township_gap：region_id 空的鄉鎮／村里層級參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing 型別。'
  '2026-10-05 加 region_gap（縣市長／議員／立委缺縣市或缺選區）與 elected_missing（中選會當選、我們沒有參選紀錄）。'
  '2026-10-05 加 roster_cec_gap（已投票屆別：中選會名單有、我們沒有的人，依鄉鎮或縣市聚成名單清查）。';
