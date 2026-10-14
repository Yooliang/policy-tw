-- 政見主題標註走流程（docs/PLAN-markdown-views.md 第 3.4 節，第二期；維護者 2026-10-07 同意：新貢獻型別 policy_topic＋新表 policy_topics）
--
-- 主題是固定詞彙（lib/topics.ts 的 16 個 key，**單一份**；supabase/functions/_shared/topics.ts 是它的一字不差的複本，守門測試盯）。
-- 一條政見可有 0～2 個主題；語意照政見三要素（#364，policy_elements）：
--   **沒有列＝還沒調查（未調查）**——「我們還沒查」跟「查過、不屬於任何主題」不能混在一起。
--   topic_key 有值＝查過、屬於這個主題，evidence 是政見文字裡的依據句；
--   topic_key 是 NULL（一條政見至多一列）＝查過、不屬於任何已定義主題（evidence 一律 NULL）。
--   一條政見的列要嘛是「1～2 個主題」、要嘛是「一列無主題」，不會兩種並存（由 policy_topics_apply() 守；
--   資料表不用觸發器擋，因為查核履歷整筆還原是逐列放回去，擋在中間會讓還原失敗；違反的看視圖 policy_topics_drift，正常是空的）。
-- 主題上線前 .md 與 HTML 都不顯示主題：這支 migration 不動 policies_with_logs，讀取端另案。
--
-- 資料一律走流程（10-05 常設裁決）：這支 migration **不寫任何一筆主題**，只加表、加貢獻型別、加派工臂。
--   - 新任務型別 policy_topic_missing：一位人物名下還沒標主題的政見打包成一個任務（每件最多 30 筆），
--     附系統算的候選主題（task-context 用 lib/topics.ts 的同義詞算）與政見原文，代理回「這筆屬於哪 0～2 個主題、依據哪一句」，
--     交 policy_topic 貢獻、同儕驗證後上線。門檻照一般資料（SQL contribution_required_agree 的 ELSE＝normal，3 分），**不動計分**。
--   - 範圍（2026 屆優先）：在選（有尚未投票的那一屆的參選紀錄、不是退選）的人的所有政見（含他過去屆別的政見）。
--     已有人交了還在等票的那位先不派（被退件就會回來）。已投票屆別、本屆沒有參選的人這一期不派（之後放寬只要改這一支臂）。
--   10-07 唯讀實查：258 位、共 1,023 筆政見（每位平均 4.0 筆、最多 29 筆）。

-- ------------------------------------------------------------
-- 資料表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_topics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id       UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  topic_key       TEXT,
  evidence        TEXT,
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 16 個主題 key，與 lib/topics.ts 的 TOPICS 一致（policy-topics.test.ts 盯 CHECK 與 TOPICS 相同；加主題要同時改這裡）
  CONSTRAINT policy_topics_topic_key_check CHECK (topic_key IS NULL OR topic_key IN (
    'childcare', 'elderly', 'school', 'housing', 'transit', 'roads', 'health', 'welfare',
    'youthwork', 'industry', 'environment', 'parks', 'safety', 'agri', 'admin', 'rights')),
  -- 有主題就要有依據句；「查過、無主題」那一列沒有依據句（不可以塞「無」這種字進來冒充）。
  -- 150 字（char_length 算字元，跟 _shared/policy-topics.ts 的 POLICY_TOPIC_EVIDENCE_MAX 同一個數字）
  CONSTRAINT policy_topics_evidence_iff_topic CHECK (
    (topic_key IS NOT NULL AND evidence IS NOT NULL AND btrim(evidence) <> '' AND char_length(evidence) <= 150)
    OR (topic_key IS NULL AND evidence IS NULL)
  ),
  -- 同一條政見同一個主題只有一列
  CONSTRAINT policy_topics_one_per_topic UNIQUE (policy_id, topic_key)
);
-- 「查過、無主題」一條政見至多一列（UNIQUE 對 NULL 不起作用，另用部分索引）
CREATE UNIQUE INDEX IF NOT EXISTS policy_topics_one_none ON policy_topics (policy_id) WHERE topic_key IS NULL;
-- 縣市×主題的 .md 要「某主題有哪些政見」
CREATE INDEX IF NOT EXISTS idx_policy_topics_topic ON policy_topics (topic_key) WHERE topic_key IS NOT NULL;

COMMENT ON TABLE policy_topics IS
  '政見主題（第二期，2026-10-07）：一條政見至多 2 個主題，一個主題一列。沒有列＝未調查；topic_key 為 NULL 的那一列＝查過、不屬於任何已定義主題。詞彙見 lib/topics.ts';
COMMENT ON COLUMN policy_topics.topic_key IS '主題 key（lib/topics.ts 的 TOPICS，ASCII，不改名）；NULL＝查過、不屬於任何主題';
COMMENT ON COLUMN policy_topics.evidence IS '依據句：政見標題或說明裡支持這個主題的那一句（150 字內）；topic_key 為 NULL 時一律 NULL';
COMMENT ON COLUMN policy_topics.contribution_id IS '最後一次寫這一列的貢獻';

ALTER TABLE policy_topics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON policy_topics;
CREATE POLICY "Public read" ON policy_topics FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON policy_topics;
CREATE POLICY "Service role write" ON policy_topics FOR ALL USING (auth.role() = 'service_role');

-- 違反「一條政見要嘛 1～2 個主題、要嘛一列無主題」的政見（正常是空的）
CREATE OR REPLACE VIEW policy_topics_drift AS
SELECT t.policy_id,
       count(*) FILTER (WHERE t.topic_key IS NOT NULL) AS topic_rows,
       count(*) FILTER (WHERE t.topic_key IS NULL)     AS none_rows
  FROM policy_topics t
 GROUP BY t.policy_id
HAVING count(*) FILTER (WHERE t.topic_key IS NOT NULL) > 2
    OR (count(*) FILTER (WHERE t.topic_key IS NULL) > 0 AND count(*) FILTER (WHERE t.topic_key IS NOT NULL) > 0);
ALTER VIEW policy_topics_drift SET (security_invoker = on);
COMMENT ON VIEW policy_topics_drift IS '政見主題的列違反「0～2 個主題；無主題不與主題並存」的政見，正常是空的';

-- ------------------------------------------------------------
-- 落庫函式：把一條政見的主題整組換成新的（一個交易，不會留下半套）
--   p_keys／p_evidence 是平行陣列（同序）；p_keys 空陣列＝查過、不屬於任何主題（寫一列 topic_key=NULL）。
--   已經有的主題保留（只在依據句不同時更新）、不在新清單裡的刪掉、新的加上。
--   回傳 {inserted: [整列], deleted: [整列], updated: [{id, topic_key, old_evidence, new_evidence}]}，由呼叫端（apply-contribution.ts）寫查核履歷；
--   全部一樣就三個陣列都是空的（呼叫端判為 superseded，別人先交了）。
--   檢查：至多 2 個主題、key 不重複、兩個陣列等長——違反就丟例外（交件驗證已擋過，這是最後一道）。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_topics_apply(p_policy_id UUID, p_keys TEXT[], p_evidence TEXT[], p_contribution_id UUID)
RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_n         INTEGER := COALESCE(cardinality(p_keys), 0);
  v_inserted  JSONB := '[]'::jsonb;
  v_deleted   JSONB := '[]'::jsonb;
  v_updated   JSONB := '[]'::jsonb;
  r           policy_topics%ROWTYPE;
  i           INTEGER;
  v_row       policy_topics%ROWTYPE;
BEGIN
  IF v_n > 2 THEN RAISE EXCEPTION 'policy_topics_apply: 一條政見至多 2 個主題（收到 %）', v_n; END IF;
  IF v_n <> COALESCE(cardinality(p_evidence), 0) THEN RAISE EXCEPTION 'policy_topics_apply: p_keys 與 p_evidence 要等長'; END IF;
  IF v_n = 2 AND p_keys[1] = p_keys[2] THEN RAISE EXCEPTION 'policy_topics_apply: 主題重複 %', p_keys[1]; END IF;

  -- 先刪：不在新清單裡的列（新清單為空＝要的是「無主題」那一列，所有主題列都要刪；無主題列自己留著）
  FOR r IN SELECT * FROM policy_topics WHERE policy_id = p_policy_id ORDER BY created_at, id LOOP
    IF (v_n = 0 AND r.topic_key IS NULL) OR (r.topic_key IS NOT NULL AND r.topic_key = ANY (p_keys)) THEN CONTINUE; END IF;
    DELETE FROM policy_topics WHERE id = r.id;
    v_deleted := v_deleted || to_jsonb(r);
  END LOOP;

  IF v_n = 0 THEN
    IF NOT EXISTS (SELECT 1 FROM policy_topics WHERE policy_id = p_policy_id AND topic_key IS NULL) THEN
      INSERT INTO policy_topics (policy_id, topic_key, evidence, contribution_id) VALUES (p_policy_id, NULL, NULL, p_contribution_id)
      RETURNING * INTO v_row;
      v_inserted := v_inserted || to_jsonb(v_row);
    END IF;
  ELSE
    FOR i IN 1..v_n LOOP
      SELECT * INTO r FROM policy_topics WHERE policy_id = p_policy_id AND topic_key = p_keys[i];
      IF NOT FOUND THEN
        INSERT INTO policy_topics (policy_id, topic_key, evidence, contribution_id) VALUES (p_policy_id, p_keys[i], p_evidence[i], p_contribution_id)
        RETURNING * INTO v_row;
        v_inserted := v_inserted || to_jsonb(v_row);
      ELSIF r.evidence IS DISTINCT FROM p_evidence[i] THEN
        UPDATE policy_topics SET evidence = p_evidence[i], contribution_id = p_contribution_id WHERE id = r.id;
        v_updated := v_updated || jsonb_build_object('id', r.id, 'topic_key', r.topic_key, 'old_evidence', r.evidence, 'new_evidence', p_evidence[i]);
      END IF;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('inserted', v_inserted, 'deleted', v_deleted, 'updated', v_updated);
END;
$$;
COMMENT ON FUNCTION policy_topics_apply IS
  '把一條政見的主題整組換成新的（policy_topic 貢獻落庫，一個交易）。空陣列＝查過、不屬於任何主題。回傳 inserted／deleted／updated 供呼叫端寫查核履歷（第二期，2026-10-07）';

-- ------------------------------------------------------------
-- 貢獻型別：policy_topic（DB CHECK、TS CONTRIBUTION_TYPES／TASK_TYPES／SUGGESTED_TYPE、skill.md、標籤四處一起改；thresholds.test 盯 CHECK 與 TS 一致）
-- 其餘照抄 20261006141600（reassign_candidacy）那一版
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'election_results', 'reassign_candidacy', 'policy_topic'));

-- ------------------------------------------------------------
-- 派工臂：policy_topic_missing（一位人物名下還沒標主題的政見打包成一件）
-- 候選主題與政見原文不在 target（佇列每 10 分鐘重寫 target，政見文字很長）：task-context 派工當下才查、才算
-- （lib/topics.ts 的 topicCandidates）。target 只放人物、政見 id 清單（最多 30 筆）與總數。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_topics()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH inflight AS (
    -- 已經有人交了、還在等票或自動重試中：先不派，免得兩個代理標同一批；被退件就會回來
    SELECT DISTINCT c.payload->>'politician_id' AS politician_id
      FROM contributions c
     WHERE c.contribution_type = 'policy_topic' AND c.status IN ('pending', 'verified', 'apply_failed')
  ),
  ppl AS (
    -- 在選的人：有尚未投票的那一屆的參選紀錄、不是退選（2026 屆優先）
    SELECT p.id AS politician_id, p.name, p.party, COALESCE(r.region, p.region) AS region, x.election_id, x.election_type
      FROM (
        SELECT DISTINCT ON (q.politician_id) q.politician_id, q.election_id, q.election_type, q.region_id
          FROM politician_elections q JOIN elections e ON e.id = q.election_id
         WHERE e.election_date >= CURRENT_DATE AND q.candidacy_status IS DISTINCT FROM 'withdrawn'
         ORDER BY q.politician_id, e.election_date, q.id
      ) x
      JOIN politicians p ON p.id = x.politician_id AND p.merged_into IS NULL
      LEFT JOIN regions r ON r.id = x.region_id
  ),
  todo AS (
    SELECT ppl.politician_id, ppl.name, ppl.party, ppl.region, ppl.election_id, ppl.election_type,
           array_agg(pl.id ORDER BY pl.id) AS policy_ids
      FROM ppl
      JOIN policies pl ON pl.politician_id = ppl.politician_id AND pl.removed_at IS NULL
     WHERE NOT EXISTS (SELECT 1 FROM policy_topics t WHERE t.policy_id = pl.id)
     GROUP BY ppl.politician_id, ppl.name, ppl.party, ppl.region, ppl.election_id, ppl.election_type
  )
  SELECT 'auto:policy_topic_missing:' || t.politician_id, 'policy_topic_missing',
         jsonb_build_object('politician_id', t.politician_id, 'name', t.name, 'party', t.party, 'region', t.region,
                            'election_id', t.election_id, 'election_type', t.election_type,
                            'policy_ids', to_jsonb(t.policy_ids[1:30]), 'policies_total', cardinality(t.policy_ids)),
         t.name || '（' || COALESCE(t.election_type, '') || '）名下有 ' || cardinality(t.policy_ids) || ' 筆政見還沒標主題'
           || CASE WHEN cardinality(t.policy_ids) > 30 THEN '（這一件先給前 30 筆，標完會再派剩下的）' ELSE '' END || '。'
           || '請對 current.policies 裡的**每一筆**判斷：它屬於 current.topics 詞彙表裡的哪 0～2 個主題，並寫出依據的那一句（政見標題或說明裡的原句，150 字內）。'
           || 'current.policies[].candidates 是系統用關鍵字算的**候選**，只是起點、不是答案——關鍵字會撈到不相干的（例：說明裡順口提到的字），要看這條政見**主要在講什麼**；候選是空的不代表沒有主題。'
           || '真的不屬於任何一個主題的，topics 填空陣列 []——那也是答案，網站會標「查過、不屬於任何主題」，跟「還沒標」分開；不確定就不要交那一筆，留給別人。'
           || '不要為了湊主題而硬套：一筆政見最多 2 個主題，只標它主要在講的。用 policy_topic 型別交一筆（可以只交其中幾筆，沒交的會留在任務裡）。',
         ARRAY['每筆政見的 current.policies[].source_url（政見出處）', 'cec.gov.tw 選舉公報（候選人登記的政見原文）', '候選人官網政見頁'],
         1, t.region
    FROM todo t
   WHERE NOT EXISTS (SELECT 1 FROM inflight i WHERE i.politician_id = t.politician_id::TEXT)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_policy_topics IS
  '一位人物名下還沒標主題的政見（沒有 policy_topics 列＝未調查）→ policy_topic_missing（一件最多 30 筆；在選者優先：有尚未投票那一屆的參選紀錄、非退選）。已有人交了在等票的先不派（第二期，2026-10-07）';

-- ------------------------------------------------------------
-- 所有自動缺口：原樣保留 20261006141600（reassign_candidacy）那一版的每一支臂，最後加 policy_topics
-- ------------------------------------------------------------
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
  UNION ALL SELECT * FROM contribution_auto_tasks_owner_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_topics()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-06 加學經歷補出處（contribution_auto_tasks_career_sources，沿用 profile_detail_gap，#346）。'
  '2026-10-06 加退選前有沒有登記（contribution_auto_tasks_withdrawn_filing，沿用 not_running_recheck，#345）。'
  '2026-10-06 加參選紀錄缺政黨（contribution_auto_tasks_party_gap，沿用 candidacy_source_missing，#346）。'
  '2026-10-06 加 2026 參選紀錄缺政黨（登記彙總表）、政黨資訊缺口（party_info_missing）、疑似測試資料的人物（placeholder_politician）。'
  '2026-10-06 加補選舉結果（contribution_auto_tasks_election_results：批次 election_results_missing＋對不上的 election_result_missing，#377）。'
  '2026-10-06 加參選紀錄疑似掛錯人（contribution_auto_tasks_owner_mismatch：candidacy_owner_mismatch，#370 未決 1）。'
  '2026-10-07 加政見主題（contribution_auto_tasks_policy_topics：policy_topic_missing，第二期）。';

-- 票數預算影子模式（只記錄、不套用門檻，見 _shared/vote-budget.ts）的候選加上 policy_topic：
-- vote-budget.test 規定每一種貢獻型別都要有風險維度，vote-budget-cron.test 規定候選清單＝有維度的型別。
-- 本體照抄 20261006141600，只在清單尾端加 'policy_topic'。影子模式不影響計分。
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link',
                                'party_info', 'election_results', 'reassign_candidacy', 'policy_topic')
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
