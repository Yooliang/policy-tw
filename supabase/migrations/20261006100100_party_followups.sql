-- #346 後續兩項（主線 10-06 裁定）：參選紀錄的政黨照中選會名冊派工讓代理補；政黨資訊交件型別 party_info
-- ============================================================
--
-- 照 10-05 常設裁決「資料一律走流程」：這支加欄位、派工臂、交件型別與出處觸發器，**不改任何人物、參選紀錄或政黨資料**。
--
-- 1. 參選紀錄政黨缺口（#381 未決 1）：politician_elections.party_basis 空的（同一人有好幾屆、又沒有交件寫政黨）10-06 有 979 筆，
--    其中已投票屆別 820 筆。中選會名冊每一筆都有推薦政黨，cec_candidates 原本沒存：
--    a. cec_candidates.party（快照欄位）：cec-sync 每週同步時把名冊上的推薦政黨原字一起存（Edge Function 那邊；這裡只加欄位）。
--       同步是「整個單位先刪後寫」，所以下一次排程跑完（週六 19:00／19:30 UTC）整份名單就都有政黨；在那之前這一欄是空的、新臂派 0 件。
--    b. 新臂 contribution_auto_tasks_party_gap：已投票屆別、我們缺政黨（party_basis 空的）、中選會名單上同屆同選舉別同縣市同名只有一位、
--       而且名冊的寫法對得到政黨（party_aliases）的，一筆一件；沿用 candidacy_source_missing（「這筆參選紀錄缺東西，用 candidacy 重交同一人同一屆」
--       本來就是它），task_id 另加 party 段（auto:candidacy_source_missing:party:<參選紀錄 id>），不跟補縣市／補選區撞號。
--       任務附中選會那一筆（號次、當選與否、推薦政黨）；代理照名冊重交，落庫時既有的觸發器（contribution_applied_candidacy_party）
--       把交件的 party 寫成那一筆的 party_id（party_basis＝contribution）——**不拿人物現在的政黨去填過去的參選**。
--       驗證沿用既有的中選會自動核對（cec-verify）：這次把推薦政黨加進它比的欄位（_shared/cec-verify.ts，跟選舉結果同一套：
--       對得上算一個可查欄位、對不上退件），同名只有一位、當選與否與政黨都對得上就直接上線。**不新增計分規則**。
--       上線後估計（10-06 照同一套規則實抓中選會 2022、2024 名單算）：819 件。
--    c. 視圖 party_alias_gaps 多看 cec_candidates.party：名冊上出現、對照表對不到的寫法也列出來（10-06 實抓的名單 0 個對不到）。
-- 2. 政黨資訊交件型別 party_info（#381 未決 3）：代理附出處補政黨的改名（前身 predecessor_id、名稱起訖 valid_from／valid_to）、
--    解散日（valid_to）、名冊外政黨的對應（改名前身）。payload.parties 每個政黨一項，一筆最多 5 項（改名要同時改新舊兩筆）。
--    落庫在 apply-contribution.ts（每一欄記 edit_history、可還原）；出處由這裡的觸發器掛到 source_refs（target_table＝parties），
--    臉書、IG、Threads 讀不到不算（同學經歷、政策脈絡那一份清單），還原的話一起拿掉。門檻一般（3），不動計分。
--
-- 引用到的既有欄位（10-06 唯讀查詢確認存在）：
--   politician_elections(id, politician_id, election_id, election_type, candidate_status, party_basis, region_id)、
--   politicians(id, name, party, region, merged_into)、regions(id, region)、elections(id, election_date)、
--   cec_candidates(election_id, election_type, region, sub_region, village, name, name_norm, cand_no, elected, cec_cand_id, cec_theme_id)、
--   party_aliases(alias_key, party_id, kind)、parties(id, name)、contributions(id, contribution_type, status, payload, source_urls, applied_at)、
--   source_refs(source_id, target_table, target_id, role, origin)；函式 cec_name_key、party_alias_key、source_upsert、career_source_readable

-- ── 1a. 中選會名冊的推薦政黨 ───────────────────────────────────────────
ALTER TABLE cec_candidates ADD COLUMN IF NOT EXISTS party TEXT;
COMMENT ON COLUMN cec_candidates.party IS
  '中選會名冊上這一筆的推薦政黨，原字照存（「無黨籍及未經政黨推薦」也照存）；cec-sync 每週同步時一起寫（2026-10-06 起）。'
  '對到哪個政黨照 party_aliases（party_id_of），對不到的寫法列在 party_alias_gaps';

-- ── 1c. 對不到的寫法也看中選會名冊 ─────────────────────────────────────
CREATE OR REPLACE VIEW party_alias_gaps AS
SELECT t.party_text, sum(t.n)::INTEGER AS n, array_agg(DISTINCT t.where_from) AS where_from
  FROM (
    SELECT p.party AS party_text, count(*) AS n, 'politicians' AS where_from
      FROM politicians p WHERE p.merged_into IS NULL GROUP BY p.party
    UNION ALL
    SELECT c.payload ->> 'party', count(*), 'candidacy'
      FROM contributions c
     WHERE c.contribution_type = 'candidacy' AND c.status = 'applied' AND party_alias_key(c.payload ->> 'party') IS NOT NULL
     GROUP BY 1
    UNION ALL
    SELECT c.party, count(*), 'cec_candidates'
      FROM cec_candidates c
     WHERE party_alias_key(c.party) IS NOT NULL
     GROUP BY 1
  ) t
 WHERE NOT EXISTS (SELECT 1 FROM party_aliases a WHERE a.alias_key = party_alias_key(t.party_text))
 GROUP BY t.party_text;
COMMENT ON VIEW party_alias_gaps IS '人物表、已落庫的 candidacy 交件或中選會名冊（cec_candidates.party）裡出現、party_aliases 對不到的政黨寫法（正常是空的，#346）';
ALTER VIEW party_alias_gaps SET (security_invoker = on);
GRANT SELECT ON party_alias_gaps TO anon, authenticated;

-- ── 1b. 派工臂：參選紀錄缺政黨、中選會名冊有 ─────────────────────────────
CREATE OR REPLACE FUNCTION contribution_auto_tasks_party_gap()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH g AS (
    SELECT pe.id AS pe_id, pe.election_id, pe.election_type, pe.candidate_status,
           p.id AS politician_id, p.name, p.party AS person_party,
           replace(COALESCE(r.region, p.region), '臺', '台') AS county
      FROM politician_elections pe
      JOIN politicians p ON p.id = pe.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pe.election_id AND e.election_date < CURRENT_DATE
      LEFT JOIN regions r ON r.id = pe.region_id
     WHERE pe.party_basis IS NULL
  ),
  m AS (
    -- 中選會名單上同屆、同選舉別、同縣市、同名只有一位（同名多位不派，免得指錯人）；名冊的政黨寫法要對得到（對不到的看 party_alias_gaps）
    SELECT g.*, c.name AS cec_name, c.region AS cec_region, c.sub_region AS cec_sub_region, c.village AS cec_village,
           c.party AS cec_party, c.cand_no, c.elected, c.cec_cand_id, c.cec_theme_id,
           a.party_id AS cec_party_id, a.kind = 'independent' AS cec_independent, pt.name AS cec_party_name
      FROM g
      JOIN LATERAL (
        SELECT x.*, count(*) OVER () AS n
          FROM cec_candidates x
         WHERE x.election_id = g.election_id AND x.election_type = g.election_type
           AND replace(x.region, '臺', '台') = g.county AND x.name_norm = cec_name_key(g.name)
      ) c ON c.n = 1
      JOIN party_aliases a ON a.alias_key = party_alias_key(c.party)
      LEFT JOIN parties pt ON pt.id = a.party_id
  ),
  x AS (
    SELECT m.*,
           -- candidacy 的地區欄位：照中選會那一筆填（跟 roster_cec_gap 同一套；縣市議員沒帶選舉區交件會被退回）
           CASE
             WHEN m.election_type = '村里長'
               THEN jsonb_build_object('region', m.county, 'sub_region', m.cec_sub_region, 'village', m.cec_village)
             WHEN m.election_type IN ('鄉鎮市民代表', '直轄市山地原住民區民代表')
               THEN jsonb_build_object('region', m.county, 'sub_region', NULLIF(regexp_replace(COALESCE(m.cec_sub_region, ''), '(第[0-9]+)?選舉區$', ''), ''))
             WHEN m.election_type IN ('鄉鎮市長', '直轄市山地原住民區長')
               THEN jsonb_build_object('region', m.county, 'sub_region', m.cec_sub_region)
             WHEN m.election_type IN ('縣市議員', '立法委員')
               THEN jsonb_build_object('region', m.county, 'electoral_district', m.cec_sub_region)
             ELSE jsonb_build_object('region', m.county)
           END AS fill,
           CASE WHEN m.elected THEN 'elected' ELSE 'not_elected' END AS cec_result
      FROM m
     -- 已經有人交了這一人這一屆的 candidacy 還在等票的先不派（落庫時就會寫政黨；退件了就會再派）
     WHERE NOT EXISTS (SELECT 1 FROM contributions c
                        WHERE c.contribution_type = 'candidacy' AND c.status IN ('pending', 'verified')
                          AND c.payload->>'politician_id' = m.politician_id::TEXT AND c.payload->>'election_id' = m.election_id::TEXT)
  )
  SELECT 'auto:candidacy_source_missing:party:' || x.pe_id,
         'candidacy_source_missing',
         jsonb_build_object('kind', 'party', 'politician_election_id', x.pe_id,
                            'politician_id', x.politician_id, 'name', x.name, 'region', x.county,
                            'election_id', x.election_id, 'election_type', x.election_type, 'candidate_status', x.candidate_status,
                            'missing', jsonb_build_array('party'),
                            'person_party', x.person_party,
                            'fill', x.fill,
                            'cec', jsonb_build_object('name', x.cec_name, 'region', x.cec_region, 'sub_region', x.cec_sub_region, 'village', x.cec_village,
                                                      'party', x.cec_party, 'cand_no', x.cand_no, 'elected', x.elected, 'election_result', x.cec_result,
                                                      'cec_cand_id', x.cec_cand_id, 'cec_theme_id', x.cec_theme_id),
                            'cec_party', jsonb_build_object('text', x.cec_party, 'party_id', x.cec_party_id, 'party_name', x.cec_party_name,
                                                            'independent', x.cec_independent)),
         x.name || '（' || COALESCE(x.county, '縣市未知') || ' ' || x.election_id || ' ' || x.election_type || '）這一次參選的政黨我們不知道——'
           || '網站只看得到他現在登記的政黨（「' || COALESCE(x.person_party, '空的') || '」），過去的參選要記當時的政黨，人會換黨。'
           || '中選會名冊上這一屆的他（' || COALESCE(x.cec_region || COALESCE(' ' || x.cec_sub_region, '') || COALESCE(' ' || x.cec_village, ''), '')
           || COALESCE('，號次 ' || x.cand_no, '') || '，' || CASE WHEN x.elected THEN '當選' ELSE '落選' END
           || '）推薦政黨記的是「' || x.cec_party || '」'
           || CASE WHEN x.cec_independent THEN '（無黨籍）' WHEN x.cec_party_name IS NOT NULL AND x.cec_party_name <> x.cec_party THEN '（＝' || x.cec_party_name || '）' ELSE '' END || '。'
           || '請打開中選會選舉資料庫核對是同一個人後，用 candidacy 型別重交同一人同一屆：politician_id 填「' || x.politician_id || '」、name 填「' || x.name
           || '」、election_id 填 ' || x.election_id || '、election_type 填「' || x.election_type || '」、地區照 target.fill 填'
           || '、party 照名冊填「' || x.cec_party || '」（不要填他現在的政黨）、candidate_status 照現況填「' || COALESCE(x.candidate_status, '') || '」'
           || '、election_result 照中選會填 ' || x.cec_result || '；source_urls 附你核對的中選會頁面。'
           || '系統會拿中選會的資料自動核對：我們只有一位同名、當選與否與推薦政黨都對得上就直接上線。'
           || '名冊上的不是同一個人（同名同姓）就不要交 candidacy，改用 no_change 回報、finding 寫「掛錯人」；查不到就用 no_change 說明你查了哪些網址。',
         ARRAY['https://db.cec.gov.tw/query/api/v1/elections/candidates/query?cand_name=' || x.name || ' ← 中選會歷屆參選（含推薦政黨、當選與否）',
               'POST /functions/v1/fetch-cec-data {"queryName":"' || x.name || '","electionId":' || x.election_id || '}',
               'https://db.cec.gov.tw/ElecTable/Election ← 中選會選舉資料庫'],
         1, x.county
    FROM x
$$;
COMMENT ON FUNCTION contribution_auto_tasks_party_gap IS
  '已投票屆別參選紀錄缺政黨（party_basis 空的）、中選會名冊（cec_candidates.party）同名唯一而且寫法對得到的，一筆一件；'
  '沿用 candidacy_source_missing（target.kind＝party），代理照名冊用 candidacy 重交（#346 第二階段，2026-10-06）';

-- ── 2. 政黨資訊交件型別 party_info ─────────────────────────────────────
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info'));

-- 落庫後把交件的出處掛到它改的每一個政黨（第一個網址是主要出處；已經有主要出處的都記成佐證）；
-- 讀不到的社群不算（career_source_readable，同學經歷那一份）。origin 帶交件 id：那筆被還原時一起拿掉
CREATE OR REPLACE FUNCTION party_info_attach_sources(p_contribution_id UUID, p_payload JSONB, p_urls TEXT[], p_fetched_at TIMESTAMPTZ DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_origin TEXT := 'contribution:' || p_contribution_id;
  v_urls TEXT[];
  v_src BIGINT;
  v_first BOOLEAN;
  v_count INTEGER := 0;
  r RECORD;
  i INTEGER;
BEGIN
  SELECT array_agg(u ORDER BY n) INTO v_urls
    FROM (SELECT DISTINCT ON (btrim(x.u)) btrim(x.u) AS u, x.n
            FROM unnest(coalesce(p_urls, '{}'::TEXT[])) WITH ORDINALITY AS x(u, n)
           WHERE career_source_readable(x.u)
           ORDER BY btrim(x.u), x.n) s;
  IF v_urls IS NULL THEN RETURN 0; END IF;
  FOR r IN
    SELECT DISTINCT pt.id,
           EXISTS (SELECT 1 FROM source_refs sr WHERE sr.target_table = 'parties' AND sr.target_id = pt.id::TEXT AND sr.role = 'primary') AS has_primary
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload -> 'parties') = 'array' THEN p_payload -> 'parties' ELSE '[]'::JSONB END) it
      JOIN parties pt ON pt.id::TEXT = it ->> 'party_id'
  LOOP
    v_first := NOT r.has_primary;
    FOR i IN 1 .. array_length(v_urls, 1) LOOP
      v_src := source_upsert(v_urls[i], v_origin, NULL, NULL, NULL, p_fetched_at);
      CONTINUE WHEN v_src IS NULL;
      INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
      VALUES (v_src, 'parties', r.id::TEXT, CASE WHEN v_first THEN 'primary' ELSE 'supporting' END, v_origin)
      ON CONFLICT (target_table, target_id, source_id) DO NOTHING;
      v_first := false;
    END LOOP;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION party_info_attach_sources(UUID, JSONB, TEXT[], TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION party_info_attach_sources IS 'party_info 交件落庫：出處掛到它改的每一個政黨（source_refs，target_table＝parties；origin＝contribution:<交件 id>）（#346）';

CREATE OR REPLACE FUNCTION contribution_party_info_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NEW.status = 'applied' THEN
      PERFORM party_info_attach_sources(NEW.id, NEW.payload, NEW.source_urls, coalesce(NEW.applied_at, now()));
    ELSIF NEW.status = 'reverted' THEN
      DELETE FROM source_refs WHERE target_table = 'parties' AND origin = 'contribution:' || NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- 不擋落庫與還原；漏掉的出處看 source_refs 有沒有這筆交件的 origin
    RAISE WARNING 'party_info 出處（交件 %）沒掛成：%', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_contribution_party_info_sources ON contributions;
CREATE TRIGGER trg_contribution_party_info_sources
  AFTER UPDATE OF status ON contributions
  FOR EACH ROW WHEN (NEW.contribution_type = 'party_info' AND NEW.status IN ('applied', 'reverted') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION contribution_party_info_sources();

-- 票數預算影子模式的候選清單多 party_info（兩個維度在 vote-budget.ts；其餘照抄 20261006034900）
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link',
                                'party_info')
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

-- ── 3. 接進派工（其餘照抄 20261006100000） ─────────────────────────────
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
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-06 加學經歷補出處（contribution_auto_tasks_career_sources，沿用 profile_detail_gap，#346）。'
  '2026-10-06 加退選前有沒有登記（contribution_auto_tasks_withdrawn_filing，沿用 not_running_recheck，#345）。'
  '2026-10-06 加參選紀錄缺政黨（contribution_auto_tasks_party_gap，沿用 candidacy_source_missing，#346）。';

-- ── 4. 上線當下的數字（只印，不改資料） ───────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '參選紀錄缺政黨：派 % 件（中選會名冊的政黨要等下一次 cec-sync 才有；有政黨的名冊列 % 筆）',
    (SELECT count(*) FROM contribution_auto_tasks_party_gap()),
    (SELECT count(*) FROM cec_candidates WHERE party IS NOT NULL);
END $$;

NOTIFY pgrst, 'reload schema';
