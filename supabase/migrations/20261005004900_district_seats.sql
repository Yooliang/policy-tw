-- 應選名額走流程：議員、代表各選舉區的名額由代理照選舉公告補（#344，2026-10-06）
-- ============================================================
--
-- 主線 10-06 裁示（#344 第一階段的未決 1）：議員與代表的名額用新任務型別，每縣市一件，由代理依選舉公告填、
-- 驗證上線；投票率與代表、村里選區名稱加進 cec-sync（那部分在 Edge Function，不在這支）。
--
-- 為什麼不能同步：中選會選舉資料庫的投票概況只有「當選人數」，沒有應選名額——同額不足、無人登記的選舉區
-- 當選人數比名額少，拿它推會把分母算小（election_districts 的表說明與 #362 都寫了不准推）。名額只在選委會的
-- 選舉公告（應選名額表）與選舉公報上，要人去讀。
--
-- 做了什麼（只加不刪）：
--   1. 貢獻型別 district_seats：一個縣市、一種選舉，districts 每區一項 {district, seats[, kind]}；
--      同儕驗證通過後由 apply-contribution.ts 寫進 election_districts（seats_basis=cec_notice、seats_source=公告網址），
--      公告上有、我們沒有的選舉區（多半是原住民選舉區、2026 新竹縣議員）新增一列。
--   2. 任務型別 district_seats_missing（contribution_auto_tasks_district_seats）：該有名額的
--      （屆別、縣市議員／鄉鎮市民代表／原住民區民代表、縣市）裡，我們一個選舉區都沒有、或有選舉區還沒名額的，
--      一個縣市派一件。哪些縣市該有：議員＝全部縣市；代表＝這一屆有鄉鎮市長選舉區的縣；原住民區民代表＝有原住民區長
--      選舉區的直轄市。已經有人交了還在等票（pending／verified）的縣市不再派，免得同一份公告被抄好幾次。
--   3. contribution_auto_tasks_arms 接上這支臂（其餘 13 支原樣保留）。
--   4. 票數預算影子模式的候選清單加 district_seats（system_one_vote_budget_candidates；兩個維度在 vote-budget.ts）。
--
-- 上線當下（10-06 唯讀資料估）：2022、2026 縣市議員各 22 件、鄉鎮市民代表各 13 件、原住民區民代表各 4 件，共 78 件。
--
-- 錯了的代價：代理只交了公告的一部分選舉區（漏了原住民選舉區）而我們本來也沒有那幾區，交完那個縣市就不再派——
-- 驗證提示要驗證者對著公告看有沒有漏列；漏掉的要等之後有人回報或 cec-sync 從名單補出那幾區（補出來的沒有名額，又會派）。

-- 引用到的既有欄位（10-06 唯讀查詢確認存在）：
--   elections(id, election_date, election_types)、admin_divisions(level, county)、
--   election_districts(election_id, election_type, region, sub_region, village, district_kind, seats)、
--   contributions(contribution_type, status, payload)、jev_decisions(subject_type, subject_id, question, state)

-- ── 1. 貢獻型別 ──────────────────────────────────────────────────
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats'));

-- ── 2. 派工臂 ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_district_seats()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH want AS (
    -- 縣市議員：每個縣市都有（內政部縣市清單，「臺」寫成「台」）
    SELECT e.id AS election_id, e.election_date, '縣市議員'::TEXT AS election_type, replace(a.county, '臺', '台') AS county
      FROM elections e
      JOIN admin_divisions a ON a.level = 'county'
     WHERE '縣市議員' = ANY (e.election_types)
    UNION
    -- 鄉鎮市民代表：這一屆有鄉鎮市長選舉區的縣（縣轄鄉鎮市）
    SELECT DISTINCT e.id, e.election_date, '鄉鎮市民代表'::TEXT, d.region
      FROM elections e
      JOIN election_districts d ON d.election_id = e.id AND d.election_type = '鄉鎮市長'
     WHERE '鄉鎮市民代表' = ANY (e.election_types)
    UNION
    -- 原住民區民代表：這一屆有原住民區長選舉區的直轄市
    SELECT DISTINCT e.id, e.election_date, '直轄市山地原住民區民代表'::TEXT, d.region
      FROM elections e
      JOIN election_districts d ON d.election_id = e.id AND d.election_type = '直轄市山地原住民區長'
     WHERE '直轄市山地原住民區民代表' = ANY (e.election_types)
  ),
  have AS (
    SELECT d.election_id, d.election_type, d.region,
           count(*) AS districts,
           count(d.seats) AS with_seats,
           jsonb_agg(jsonb_build_object('district', d.sub_region, 'kind', d.district_kind, 'seats', d.seats)
                     ORDER BY d.sub_region) AS known
      FROM election_districts d
     WHERE d.election_type IN ('縣市議員', '鄉鎮市民代表', '直轄市山地原住民區民代表')
     GROUP BY d.election_id, d.election_type, d.region
  ),
  -- 已經有人交了、還在等票的縣市不再派（同一份公告抄一次就夠；退件了就會再派）
  queued AS (
    SELECT DISTINCT c.payload->>'election_id' AS election_id, c.payload->>'election_type' AS election_type, c.payload->>'region' AS region
      FROM contributions c
     WHERE c.contribution_type = 'district_seats' AND c.status IN ('pending', 'verified')
  )
  SELECT 'auto:district_seats_missing:' || w.election_id || ':' || w.county || ':' || w.election_type,
         'district_seats_missing',
         jsonb_build_object('election_id', w.election_id, 'election_type', w.election_type, 'region', w.county,
                            'election_date', w.election_date,
                            'known_count', COALESCE(h.districts, 0), 'missing_seats_count', COALESCE(h.districts - h.with_seats, 0),
                            'known_districts', COALESCE(h.known, '[]'::jsonb)),
         w.county || ' ' || w.election_id || ' ' || w.election_type || '各選舉區的應選名額：'
           || CASE WHEN h.districts IS NULL THEN '我們一個選舉區都還沒有。'
                   ELSE '我們知道 ' || h.districts || ' 個選舉區、其中 ' || (h.districts - h.with_seats) || ' 個還沒有名額（target.known_districts）。' END
           || '請找這一屆的選舉公告（應選名額表；已投票的屆別，選舉公報每個選舉區的開頭也寫著應選名額），'
           || '把公告上這個縣市每一個選舉區的名額交成一筆 district_seats：election_id 填 ' || w.election_id
           || '、election_type 填「' || w.election_type || '」、region 填「' || w.county || '」，districts 每區一項 {district, seats}，'
           || '原住民選舉區加 kind（indigenous_plain 或 indigenous_mountain）。名額只能照公告抄，不要用候選人數或當選人數推。'
           || 'source_urls 第一個放公告本身。',
         CASE WHEN w.election_date < CURRENT_DATE
              THEN ARRAY['https://eebulletin.cec.gov.tw/ ← 中選會選舉公報：依屆別、縣市、選舉別點到每個選舉區的公報，開頭寫著應選名額',
                         '該縣市選舉委員會官網的「選舉公告」（附各選舉區應選名額表）',
                         'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫：看得到有哪些選舉區（含原住民選舉區），但當選人數不是名額']
              ELSE ARRAY['該縣市選舉委員會官網的「選舉公告」（發布選舉公告那一份，附各選舉區應選名額表）',
                         'https://web.cec.gov.tw/ ← 中選會：議員選舉區劃分與應選名額的公告、登記彙總表']
         END,
         2, w.county
    FROM want w
    LEFT JOIN have h ON h.election_id = w.election_id AND h.election_type = w.election_type AND h.region = w.county
   WHERE (h.districts IS NULL OR h.with_seats < h.districts)
     AND NOT EXISTS (SELECT 1 FROM queued q
                      WHERE q.election_id = w.election_id::TEXT AND q.election_type = w.election_type AND q.region = w.county)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_district_seats IS
  '應選名額缺口：議員、代表各選舉區的名額（#344，2026-10-06）。一個縣市一種選舉一件，代理照選舉公告交 district_seats';

-- ── 3. 接進派工（其餘 13 支照抄 20261005004010） ─────────────────
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
  UNION ALL SELECT * FROM contribution_auto_tasks_district_seats()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。'
  '2026-10-03 名單清查依 roster_check_scope.regions 濾掉沒有這種選舉的縣市。'
  '2026-10-04 加村里長（鄉鎮市區層級）的清查臂；鄉鎮市長／代表類的清查說明補「要填 sub_region」。'
  '2026-10-04 加 township_gap：region_id 空的鄉鎮／村里層級參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing 型別。'
  '2026-10-05 加 region_gap（縣市長／議員／立委缺縣市或缺選區）與 elected_missing（中選會當選、我們沒有參選紀錄）。'
  '2026-10-05 加 roster_cec_gap（已投票屆別：中選會名單有、我們沒有的人，依鄉鎮或縣市聚成名單清查）。'
  '2026-10-06 加 district_seats（議員、代表各選舉區的應選名額，#344）。';

-- ── 4. 票數預算影子模式的候選清單（其餘照抄 20260925000001） ──────
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats')
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

NOTIFY pgrst, 'reload schema';
