-- 補選舉結果改批次：一個單位（一屆、一種選舉、一個縣市，村里長與代表再細到鄉鎮市區）一件任務、一筆交件；
-- 目標分數 2，Jev 照中選會名單逐筆核對、整批對得上就投一張系統票，再一張代理同意就上線（小良哥 2026-10-06：
-- 「改批次，票數 2 票，讓 jev 扣下來」）。設計照 #377 第 4 節。
-- ============================================================
--
-- 缺口（10-06 唯讀）：已投票屆別、election_result 空白、不是表態不參選的參選紀錄 13,954 筆
-- （2022 村里長 13,335、鄉鎮市長 456、原住民區民代表 82、縣市議員 65、縣市長 12；2024 立委 4）。
-- 既有的 election_result_missing 只派「名下有政見的人」（約 54 件），其餘一萬三千多筆沒有任何一支臂會派；
-- 逐人派會塞爆佇列、每一件都要好幾張票。
--
-- 做了什麼（只加不刪）：
--   1. 貢獻型別 election_results：一個單位交一筆，items 每位一項 {politician_election_id, election_result}；
--      落庫逐筆寫 politician_elections.election_result（只補空白、不覆蓋），逐筆記 edit_history、整筆可還原；
--      #376 的觸發器跟著更新 candidacy_status，#377 的觸發器建任期。
--   2. 比對規則一份：election_result_cec_matches(ids)——同一屆、同一種選舉、同縣市、cec_name_key 同名的中選會名單列，
--      參選紀錄有鄉鎮（代表看去掉「第NN選舉區」的鄉鎮）、村里的再一起對；剛好一列＝唯一對上。派工、系統票、驗證項都用它。
--   3. 任務型別 election_results_missing（contribution_auto_tasks_election_results）：唯一對上的依單位聚成一件，
--      一件最多 120 位、超過拆成幾件（task_id 加 :p2…）；target 只放參選紀錄 id，名單細節派工當下才查（任務佇列
--      每 10 分鐘整批重寫 target，放一萬多筆細節進去等於每 10 分鐘重寫幾 MB）。已經有人交了在等票的不再派。
--      對不上的（同縣市同名多位、名單查無；10-06 約 20 筆）照 #377 第 5 點各自派既有的 election_result_missing，
--      名下有政見的那幾筆原本就有那支臂在派，這裡不重複。
--   4. 計分：風險等級 batch_result，目標分數一律 2（contribution_required_agree；TS 鏡像 AGREE_THRESHOLDS.batch_result）。
--      系統票：election_results_system_check 逐筆核對，全部對得上（唯一對上而且當選與否一致）→ supported
--      （照 3+1 機制折進目標：2−1＝1，再一張代理同意就過）；任何一筆對不上 → 不投票（記 cannot_tell 與對不上的那幾筆，
--      驗證項照這份列出來），目標照 2。退件門檻照舊 −3、不要求兩台機器。
--   5. 系統票由 system-one?action=results_batch 每 10 分鐘撿（排程 results-batch-10min），呼叫上面那支 SQL；
--      這一型不交給一般 Jev 預判（system_vote_cec_only），免得讀網頁的判定蓋掉名單核對。
--
-- 錯了的代價：中選會名單同縣市同名而我們的鄉鎮、村里又沒填的，系統會把唯一那一列當成同一人——但那一列就是同縣市
-- 唯一同名的候選人，誤認的前提是我們的參選紀錄本身掛錯人（那是 #370 的另一個問題，另有改掛的流程）。
-- 一張草率的代理同意就會讓整批上線；代理同意要寫出核對了哪一頁，驗證項逐筆列出系統比對的結果。

-- 引用到的既有欄位與函式（10-06 唯讀查詢確認存在）：
--   politician_elections(id, politician_id, election_id, election_type, region_id, election_result, candidate_status)、
--   politicians(id, name, region, sub_region, village, merged_into)、regions(id, region, sub_region, village)、
--   elections(id, election_date)、cec_candidates(id, election_id, election_type, region, sub_region, village, name, name_norm,
--   birth_year, elected, cec_theme_id, cec_cand_id)、policies(politician_id, removed_at)、contributions(contribution_type, status, payload)、
--   jev_decisions(subject_type, subject_id, question, choice, probability, confidence, probabilities, model, state, cost_usd)、
--   cec_name_key(text)、contribution_apply_consensus(uuid)、cron.schedule、net.http_post

-- ── 1. 貢獻型別 ──────────────────────────────────────────────────
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'election_results'));

-- ── 2. 比對規則（唯一一份） ───────────────────────────────────────
CREATE OR REPLACE FUNCTION election_result_cec_matches(p_ids INTEGER[])
RETURNS TABLE (
  politician_election_id INTEGER, politician_id UUID, name TEXT, election_id INTEGER, election_type TEXT,
  county TEXT, town TEXT, village TEXT, district TEXT, current_result TEXT,
  cec_hits INTEGER, cec_elected BOOLEAN, cec_cand_id INTEGER, cec_theme_id TEXT,
  cec_sub_region TEXT, cec_village TEXT, cec_birth_year INTEGER
)
LANGUAGE sql STABLE AS $$
  WITH pe AS (
    SELECT pe.id, pe.politician_id, p.name, pe.election_id, pe.election_type, pe.election_result,
           cec_name_key(p.name) AS nn,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county,
           -- 鄉鎮層級的選舉：參選紀錄自己那一列的鄉鎮，沒有才看人物的；代表的「麥寮鄉第01選舉區」去掉選舉區只留鄉鎮
           CASE WHEN pe.election_type IN ('鄉鎮市長', '鄉鎮市民代表', '村里長', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                THEN NULLIF(regexp_replace(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.sub_region END, p.sub_region, ''), '(第[0-9]+)?選舉區$', ''), '')
           END AS town,
           CASE WHEN pe.election_type = '村里長'
                THEN NULLIF(COALESCE(CASE WHEN r.id IS NOT NULL THEN r.village END, p.village, ''), '')
           END AS village,
           CASE WHEN r.id IS NOT NULL THEN r.sub_region END AS district
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.id = ANY (p_ids)
  )
  SELECT x.id, x.politician_id, x.name, x.election_id, x.election_type,
         x.county, x.town, x.village, x.district, x.election_result,
         m.n, c.elected, c.cec_cand_id, c.cec_theme_id, c.sub_region, c.village, c.birth_year
    FROM pe x
    LEFT JOIN LATERAL (
      SELECT count(*)::INTEGER AS n, min(cc.id) AS cec_id
        FROM cec_candidates cc
       WHERE cc.election_id = x.election_id AND cc.election_type = x.election_type
         AND cc.region = x.county AND cc.name_norm = x.nn
         AND (x.town IS NULL OR regexp_replace(COALESCE(cc.sub_region, ''), '(第[0-9]+)?選舉區$', '') = x.town)
         AND (x.village IS NULL OR cc.village = x.village)
    ) m ON true
    LEFT JOIN cec_candidates c ON m.n = 1 AND c.id = m.cec_id
$$;
COMMENT ON FUNCTION election_result_cec_matches IS
  '參選紀錄 → 中選會名單（同屆、同選舉、同縣市、cec_name_key 同名；鄉鎮、村里有就一起對）。cec_hits＝對上幾列，1＝唯一對上（#377，2026-10-06）。派工、系統票、驗證項共用這一支';

-- ── 3. 派工臂 ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_election_results()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH gap AS (
    SELECT pe.id
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE
     WHERE pe.election_result IS NULL
       AND pe.candidate_status <> 'not_running'
  ),
  -- 已經有人交了、還在等票的不再派（同一份名單抄一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT (it->>'politician_election_id')::INTEGER AS id
      FROM contributions c
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'items') = 'array' THEN c.payload->'items' ELSE '[]'::jsonb END) it
     WHERE c.contribution_type = 'election_results' AND c.status IN ('pending', 'verified')
       AND (it->>'politician_election_id') ~ '^[0-9]{1,9}$'
  ),
  m AS (
    SELECT * FROM election_result_cec_matches(ARRAY(SELECT g.id FROM gap g WHERE NOT EXISTS (SELECT 1 FROM queued q WHERE q.id = g.id)))
  ),
  units AS (
    SELECT m.*,
           CASE WHEN m.election_type IN ('村里長', '鄉鎮市民代表', '直轄市山地原住民區民代表') THEN m.town END AS unit_town
      FROM m WHERE m.cec_hits = 1
  ),
  numbered AS (
    SELECT u.*,
           (row_number() OVER w - 1) / 120 + 1 AS part,
           (count(*) OVER (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town) - 1) / 120 + 1 AS parts
      FROM units u
    WINDOW w AS (PARTITION BY u.election_id, u.election_type, u.county, u.unit_town
                 ORDER BY u.town NULLS LAST, u.village NULLS LAST, u.name, u.politician_election_id)
  ),
  grouped AS (
    SELECT n.election_id, n.election_type, n.county, n.unit_town, n.part, max(n.parts) AS parts,
           count(*) AS items_count,
           jsonb_agg(n.politician_election_id ORDER BY n.town NULLS LAST, n.village NULLS LAST, n.name, n.politician_election_id) AS ids
      FROM numbered n
     GROUP BY n.election_id, n.election_type, n.county, n.unit_town, n.part
  )
  -- 批次：一個單位一件（超過 120 位拆成幾件）
  SELECT 'auto:election_results_missing:' || g.election_id || ':' || g.election_type || ':' || g.county
           || COALESCE(':' || g.unit_town, '') || CASE WHEN g.parts > 1 THEN ':p' || g.part ELSE '' END,
         'election_results_missing',
         jsonb_build_object('election_id', g.election_id, 'election_type', g.election_type, 'region', g.county,
                            'sub_region', g.unit_town, 'election_date', e.election_date,
                            'part', g.part, 'parts', g.parts, 'items_count', g.items_count,
                            'politician_election_ids', g.ids),
         g.county || COALESCE(g.unit_town, '') || ' ' || g.election_id || ' ' || g.election_type || '：'
           || '我們有 ' || g.items_count || ' 位參選人的選舉結果還空著'
           || CASE WHEN g.parts > 1 THEN '（這個單位太大，拆成 ' || g.parts || ' 件，這是第 ' || g.part || ' 件）' ELSE '' END
           || '，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。名單在 current.items：每一位附系統比對到的中選會那一列（cec），那是線索不是答案。'
           || '請打開中選會選舉資料庫這個單位的結果逐位核對（同名不同人要看選區、村里、出生年），交一筆 election_results：'
           || 'election_id 填 ' || g.election_id || '、election_type 填「' || g.election_type || '」、region 填「' || g.county || '」'
           || CASE WHEN g.unit_town IS NOT NULL THEN '、sub_region 填「' || g.unit_town || '」' ELSE '' END
           || '，items 每位一項 {politician_election_id, election_result：elected 或 not_elected}。核對不了或不是同一個人的不要放進 items，在 note 寫是哪幾位。'
           || 'source_urls 第一個放你核對的中選會那一頁。',
         ARRAY['https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：依屆別、選舉、縣市（鄉鎮）點到結果表，當選者有標記',
               'https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=姓名 ← 個別查一位的歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"姓名","electionId":年份} ← 直接回中選會的當選與否'],
         1, g.county
    FROM grouped g
    JOIN elections e ON e.id = g.election_id
  UNION ALL
  -- 對不上的（同縣市同名多位、名單查無）：各自派 election_result_missing，附名單上同縣市同名的人請代理指認。
  -- 名下有政見的那幾筆 contribution_auto_tasks_raw 原本就在派同一個 task_id，這裡不重複
  SELECT 'auto:election_result_missing:' || m.politician_election_id,
         'election_result_missing',
         jsonb_build_object('politician_id', m.politician_id, 'name', m.name, 'region', m.county,
                            'sub_region', m.town, 'village', m.village,
                            'election_id', m.election_id, 'election_type', m.election_type, 'election_date', e.election_date,
                            'cec_hits', m.cec_hits,
                            'cec_same_name', COALESCE((
                              SELECT jsonb_agg(jsonb_build_object('sub_region', cc.sub_region, 'village', cc.village, 'birth_year', cc.birth_year,
                                                                  'elected', cc.elected, 'cec_cand_id', cc.cec_cand_id, 'cec_theme_id', cc.cec_theme_id)
                                               ORDER BY cc.sub_region, cc.village)
                                FROM cec_candidates cc
                               WHERE cc.election_id = m.election_id AND cc.election_type = m.election_type
                                 AND cc.region = m.county AND cc.name_norm = cec_name_key(m.name)), '[]'::jsonb)),
         m.name || '（' || COALESCE(m.county, '') || COALESCE(' ' || m.town, '') || COALESCE(' ' || m.village, '') || ' '
           || m.election_id || ' ' || m.election_type || '）的選舉結果還空著，那場選舉 ' || e.election_date::TEXT || ' 就投票完了。'
           || CASE WHEN m.cec_hits = 0 THEN '系統在中選會名單上找不到同縣市同名、地區也對得上的人（多半是地區或姓名寫錯）。'
                   ELSE '中選會名單上同縣市同名、地區也對得上的有 ' || m.cec_hits || ' 位，系統分不出是哪一位（target.cec_same_name）。' END
           || '請到中選會選舉資料庫核對他是哪一位，用 candidacy 補 election_result（elected 或 not_elected），帶 politician_id；'
           || '名單上真的沒有他、或確定不是同一個人，用 no_change 回報你查了哪些網址，不要猜。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || m.name || ' ← 中選會歷屆參選、出生年與當選與否',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || m.name || '","electionId":' || m.election_id || '}'],
         1, m.county
    FROM m
    JOIN elections e ON e.id = m.election_id
   WHERE m.cec_hits <> 1
     AND NOT EXISTS (SELECT 1 FROM policies pl WHERE pl.politician_id = m.politician_id AND pl.removed_at IS NULL)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_election_results IS
  '補選舉結果（#377 第 4 節，2026-10-06）：已投票屆別結果空白的參選紀錄，中選會名單唯一對上的依單位（屆別×選舉×縣市，村里長與代表到鄉鎮）聚成 election_results_missing，'
  '一件最多 120 位；對不上的各自派 election_result_missing（名下有政見的由 contribution_auto_tasks_raw 派）';

-- ── 4. 接進派工（其餘每一支照抄 20261006140000） ──────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due())
  SELECT r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
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
  UNION ALL SELECT * FROM contribution_auto_tasks_district_seats()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_elements()
  UNION ALL SELECT * FROM due
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_candidates()
  UNION ALL SELECT * FROM contribution_auto_tasks_handover_missing()
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_roles()
  UNION ALL SELECT * FROM contribution_auto_tasks_lineage_links()
  UNION ALL SELECT * FROM contribution_auto_tasks_career_sources()
  UNION ALL SELECT * FROM contribution_auto_tasks_withdrawn_filing()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_gap()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_roster()
  UNION ALL SELECT * FROM contribution_auto_tasks_party_info()
  UNION ALL SELECT * FROM contribution_auto_tasks_placeholder_politicians()
  UNION ALL SELECT * FROM contribution_auto_tasks_election_results()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-06 加學經歷補出處（contribution_auto_tasks_career_sources，沿用 profile_detail_gap，#346）。'
  '2026-10-06 加退選前有沒有登記（contribution_auto_tasks_withdrawn_filing，沿用 not_running_recheck，#345）。'
  '2026-10-06 加參選紀錄缺政黨（contribution_auto_tasks_party_gap，沿用 candidacy_source_missing，#346）。'
  '2026-10-06 加 2026 參選紀錄缺政黨（登記彙總表）、政黨資訊缺口（party_info_missing）、疑似測試資料的人物（placeholder_politician）。'
  '2026-10-06 加補選舉結果（contribution_auto_tasks_election_results：批次 election_results_missing＋對不上的 election_result_missing，#377）。';

-- 票數預算影子模式的候選清單加 election_results（兩個維度在 vote-budget.ts；其餘照抄 20261006100100）
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link',
                                'party_info', 'election_results')
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget'
        AND (c.contribution_type <> 'no_change' OR j.state->'target' ? 'outcome')
    )
    AND (c.contribution_type <> 'no_change' OR (
      SELECT COUNT(*) FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget') < 2)
  -- 新的先：新件的影子結果之後才對得到它的實際結果；舊件一天內也會輪到
  ORDER BY c.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 60));
$$;

-- ── 5. 計分：batch_result 目標 2 ─────────────────────────────────
-- 守門測試從函式名最後一次出現處往後解析，所以註解不放在函式後面。
-- 目標分數：一律 3，不動正式資料的型別 2（2026-09-21 裁示）；整批補已投票選舉結果（election_results）2（2026-10-06 小良哥）。
-- 系統票調整見 contribution_effective_agree（supported −1、最少 1）。
CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'merge_politician' THEN 'high'
    WHEN p_type = 'election_results' THEN 'batch_result'
    WHEN p_type = 'candidacy'
         AND p_payload->>'election_result' IN ('elected', 'not_elected')
         AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'past_result'
    WHEN p_type = 'correction' AND correction_only_from_rumor(p_payload) THEN 'normal'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'past_result' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'batch_result' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 3
  END;
END;
$$;

-- ── 6. 系統票：election_results 有系統票，但只由名單核對投（不交給讀網頁的一般預判） ──
CREATE OR REPLACE FUNCTION system_vote_eligible(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('policy', 'candidacy', 'politician', 'correction', 'policy_progress', 'election_results')
$$;

-- 系統票只由中選會名單核對來投的型別：一般預判（system-one?action=precheck，抓網頁問 Jev）不撿。
-- TS 鏡像：_shared/consensus.ts 的 CEC_CHECK_ONLY_TYPES
CREATE OR REPLACE FUNCTION system_vote_cec_only(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('election_results')
$$;
COMMENT ON FUNCTION system_vote_cec_only IS
  '系統票只由中選會名單逐筆核對投的型別（election_results，2026-10-06）：一般預判不撿，免得讀網頁的判定蓋掉名單核對';

-- 同 20260920000002，只多一個條件：名單核對專屬的型別不撿
CREATE OR REPLACE FUNCTION system_one_precheck_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (contribution_id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND system_vote_eligible(c.contribution_type)
    AND NOT system_vote_cec_only(c.contribution_type)
    AND c.source_urls IS NOT NULL AND array_length(c.source_urls, 1) >= 1
    -- 真的判過（Jev 有回答）就不再問；只有「抓不到」的紀錄時，滿 24 小時可重抓，最多三次
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
        AND j.model NOT LIKE 'policy-tw/fetch-only%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
        AND j.model LIKE 'policy-tw/fetch-only%' AND j.asked_at > now() - INTERVAL '24 hours'
    )
    AND (SELECT COUNT(*) FROM jev_decisions j
         WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support'
           AND j.model LIKE 'policy-tw/fetch-only%') < 3
  ORDER BY
    -- 沒判過的優先，重抓的排後面（跟新貢獻搶同一個 40 秒預算）
    (EXISTS (SELECT 1 FROM jev_decisions j WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support')) ASC,
    c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;
COMMENT ON FUNCTION system_one_precheck_candidates IS
  '預判候選：pending、有來源、型別合格、不是名單核對專屬的型別；Jev 真的判過的不再問；只有 fetch-only 棄權的滿 24 小時可重抓（最多三次，排在沒判過的後面）';

-- 交件逐筆跟中選會名單比：每一位的狀態（match 對得上／differs 當選與否不同／ambiguous 同名多位／not_found 名單查無／
-- unknown 名單沒寫當選與否／wrong_unit 不是這一屆這種選舉這個縣市／no_record 參選紀錄不存在）。系統票與驗證項都讀這一支
CREATE OR REPLACE FUNCTION election_results_compare(p_contribution_id UUID)
RETURNS TABLE (
  politician_election_id INTEGER, name TEXT, county TEXT, town TEXT, village TEXT, district TEXT,
  claimed TEXT, current_result TEXT, status TEXT, cec_hits INTEGER, cec_elected BOOLEAN,
  cec_sub_region TEXT, cec_village TEXT, cec_birth_year INTEGER, cec_cand_id INTEGER, cec_theme_id TEXT
)
LANGUAGE sql STABLE AS $$
  WITH c AS (
    SELECT payload FROM contributions WHERE id = p_contribution_id AND contribution_type = 'election_results'
  ),
  items AS (
    SELECT CASE WHEN (t.it->>'politician_election_id') ~ '^[0-9]{1,9}$' THEN (t.it->>'politician_election_id')::INTEGER END AS pe_id,
           t.it->>'election_result' AS claimed, t.ord
      FROM c
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'items') = 'array' THEN c.payload->'items' ELSE '[]'::jsonb END)
           WITH ORDINALITY AS t(it, ord)
  ),
  m AS (
    SELECT * FROM election_result_cec_matches(ARRAY(SELECT i.pe_id FROM items i WHERE i.pe_id IS NOT NULL))
  )
  SELECT i.pe_id, m.name, m.county, m.town, m.village, m.district, i.claimed, m.current_result,
         CASE WHEN m.politician_election_id IS NULL THEN 'no_record'
              WHEN m.election_id::TEXT IS DISTINCT FROM (SELECT c.payload->>'election_id' FROM c)
                OR m.election_type IS DISTINCT FROM (SELECT c.payload->>'election_type' FROM c)
                OR m.county IS DISTINCT FROM replace((SELECT c.payload->>'region' FROM c), '臺', '台') THEN 'wrong_unit'
              WHEN m.cec_hits = 0 THEN 'not_found'
              WHEN m.cec_hits > 1 THEN 'ambiguous'
              WHEN m.cec_elected IS NULL THEN 'unknown'
              WHEN (m.cec_elected AND i.claimed = 'elected') OR (NOT m.cec_elected AND i.claimed = 'not_elected') THEN 'match'
              ELSE 'differs' END,
         m.cec_hits, m.cec_elected, m.cec_sub_region, m.cec_village, m.cec_birth_year, m.cec_cand_id, m.cec_theme_id
    FROM items i
    LEFT JOIN m ON m.politician_election_id = i.pe_id
   ORDER BY i.ord
$$;
COMMENT ON FUNCTION election_results_compare IS
  '一筆 election_results 交件逐位跟中選會名單比（status：match／differs／ambiguous／not_found／unknown／wrong_unit／no_record）。系統票與驗證項共用（2026-10-06）';

-- 系統票：全部 match → supported（目標 2−1＝1）；任何一位不是 match → 不投票（cannot_tell，記下是哪幾位），目標照 2。
-- 不投 not_supported：名單對不上多半是我們的地區或姓名寫法，不是交件錯——那幾位交給代理看，不替它加門檻。
CREATE OR REPLACE FUNCTION election_results_system_check(p_contribution_id UUID) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_total INTEGER; v_match INTEGER; v_bad JSONB; v_choice TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM contributions WHERE id = p_contribution_id AND contribution_type = 'election_results' AND status = 'pending') THEN
    RETURN NULL;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE x.status = 'match'),
         COALESCE(jsonb_agg(jsonb_build_object('politician_election_id', x.politician_election_id, 'name', x.name, 'claimed', x.claimed,
                                               'status', x.status, 'cec_hits', x.cec_hits, 'cec_elected', x.cec_elected)
                            ORDER BY x.politician_election_id) FILTER (WHERE x.status <> 'match'), '[]'::jsonb)
    INTO v_total, v_match, v_bad
    FROM election_results_compare(p_contribution_id) x;
  v_choice := CASE WHEN v_total > 0 AND v_match = v_total THEN 'supported' ELSE 'cannot_tell' END;
  INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability, confidence, probabilities, model, state, cost_usd)
  VALUES ('contribution', p_contribution_id::TEXT, 'source_support', v_choice,
          CASE WHEN v_choice = 'supported' THEN 1 ELSE 0 END, NULL, NULL,
          'policy-tw/cec-results-batch-20261006',
          jsonb_build_object('checked', v_total, 'matched', v_match, 'mismatches', v_bad,
                             'rule', '每一位都要在中選會名單上唯一對上（同屆、同選舉、同縣市同名，鄉鎮村里有就一起對），而且當選與否一致，才投 supported；任何一位不是就不投票'),
          0);
  PERFORM contribution_apply_consensus(p_contribution_id);
  RETURN v_choice;
END;
$$;
COMMENT ON FUNCTION election_results_system_check IS
  '整批補選舉結果的系統票（2026-10-06）：逐位核對中選會名單，全部對得上投 supported（目標 −1），任何一位對不上不投票；寫完重算共識';

-- 還沒核過的 election_results 撿起來核（system-one?action=results_batch 每 10 分鐘叫）
CREATE OR REPLACE FUNCTION election_results_check_pending(p_limit INTEGER DEFAULT 50) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_n INTEGER := 0; v_supported INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.id FROM contributions c
     WHERE c.contribution_type = 'election_results' AND c.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM jev_decisions j
                        WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT
                          AND j.question = 'source_support' AND j.model LIKE 'policy-tw/cec-results-batch%')
     ORDER BY c.created_at
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
  LOOP
    v_n := v_n + 1;
    IF election_results_system_check(r.id) = 'supported' THEN v_supported := v_supported + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_n, 'supported', v_supported);
END;
$$;
COMMENT ON FUNCTION election_results_check_pending IS '撿還沒核過的 election_results 跑系統票（results-batch-10min）';

-- 寫系統票的兩支只給服務角色（排程與 system-one）；比對本身是唯讀的，照預設公開
REVOKE EXECUTE ON FUNCTION election_results_system_check(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION election_results_check_pending(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION election_results_system_check(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION election_results_check_pending(INTEGER) TO service_role;

-- ── 7. 排程（跟 roster-batch 錯開） ───────────────────────────────
SELECT cron.unschedule('results-batch-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'results-batch-10min');
SELECT cron.schedule('results-batch-10min', '6,16,26,36,46,56 * * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=results_batch',
                       headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);

-- ── 8. 自我檢查 ──────────────────────────────────────────────────
DO $$
DECLARE v_batch INTEGER; v_single INTEGER; v_items INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE t.task_type = 'election_results_missing'),
         count(*) FILTER (WHERE t.task_type = 'election_result_missing'),
         COALESCE(sum((t.target->>'items_count')::INTEGER) FILTER (WHERE t.task_type = 'election_results_missing'), 0)
    INTO v_batch, v_single, v_items
    FROM contribution_auto_tasks_election_results() t;
  RAISE NOTICE '補選舉結果派工：批次 % 件（% 位）、對不上各自派 % 件', v_batch, v_items, v_single;
END $$;

NOTIFY pgrst, 'reload schema';
