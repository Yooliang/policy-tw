-- 政見三要素（數值目標・達成期限・財源）＋期限到了接追蹤（issue #364；維護者 2026-10-05 點頭）
--
-- 日本站（keifu #28，SCHEMA v0.7 的 policy_elements）已經做好同一套，欄位名稱與語意兩站一致：
--   一條政見拆成數值目標（target）、達成期限（deadline）、財源（funding），一個要素一列，同一條政見同一個要素只有一列。
--   stated=true  原文有寫，text 只寫原文的事實（120 字內）
--   stated=false 查過原文、沒寫（畫面顯示「未說明」），text 是 NULL
--   **沒有列＝還沒拆（畫面顯示「未調查」）**——「我們還沒查」跟「他沒說」不能混在一起，畫面與 API 都一樣。
--   正見是第三方：不幫候選人補數字、不換算、不評價。
-- 兩站只差兩處：
--   1. 會計年度：台灣是曆年，「2028 年前」→ 2028-12-31、「任內」→ 那一任的卸任日（office_term_end）；日本是 4 月起。
--   2. 出處：日本站在列上放 source_ids；正見走 #354 的 sources／source_refs（target_table='policy_elements'），
--      stated=false 也要附（表示查的是哪份原文）。列上的 source_url 只是「這一列的主要出處」的指標，
--      由觸發器同步成 source_refs——跟 policies.source_url 同一個做法，為的是查核履歷的整筆還原：
--      edit_history 還原的是欄位，把 source_url 這一欄倒回去，觸發器就把出處表跟著換回去。
--      原句位置另外放 source_locator（公報第幾頁哪一段、影片幾分幾秒），stated=false 也要填查的是哪一段。
--
-- 資料一律走流程（10-05 常設裁決）：這支 migration 不寫任何一筆三要素，只加表、加派工臂。
--   - 新任務型別 policy_elements_missing：政見還沒拆完三要素 → 派代理從原文拆，交 policy_elements 貢獻、
--     同儕驗證後上線。門檻照一般資料（SQL contribution_required_agree 的 ELSE＝normal，3 分），**不動計分**。
--   - 新任務型別 deadline_due：達成期限的日期已過、政見還沒達成也沒跳票、期限之後沒有任何進度紀錄 →
--     派「查進度」，交 policy_progress。跟 progress_stale 撞到同一條政見時只派 deadline_due（期限是更具體的理由，
--     同一條不派兩件；progress_stale 的條件本身不動，期限的那件消失後它照舊）。
-- 範圍（policy_elements_missing）：
--   - 還沒投票的屆別：在選的人（不含表態不參選、退選）的政見——選前要能並排比較
--   - 已投票的屆別：當選者、而且還沒達成也沒跳票的政見——期限要接得上追蹤
--   落選者的政見、屆別空著的、找不到那一屆參選紀錄的不派（progress_stale 同一個理由：問不出結果）；
--   已經有人交了還在等票的先不派（被退件就會回來）。
--   10-05 唯讀實查：約 940 件（2026 在選者 622、已投票屆別的當選者 320），deadline_due 上線當下 0 件（還沒有任何三要素）。

-- ------------------------------------------------------------
-- 資料表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_elements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id       UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  element         TEXT NOT NULL CHECK (element IN ('target', 'deadline', 'funding')),
  stated          BOOLEAN NOT NULL,
  text            TEXT,
  deadline_date   DATE,
  source_url      TEXT NOT NULL,
  source_locator  TEXT NOT NULL,
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一條政見同一個要素只有一列（兩站一致）
  CONSTRAINT policy_elements_one_per_element UNIQUE (policy_id, element),
  -- 有寫才有文字；沒寫就是 NULL，不可以塞「未說明」「無」這種字進來冒充
  CONSTRAINT policy_elements_text_iff_stated CHECK (
    (stated AND text IS NOT NULL AND btrim(text) <> '') OR (NOT stated AND text IS NULL)
  ),
  -- 120 字以內（char_length 算的是字元，跟 _shared/policy-elements.ts 的 POLICY_ELEMENT_TEXT_MAX 同一個數字）
  CONSTRAINT policy_elements_text_len CHECK (text IS NULL OR char_length(text) <= 120),
  -- 期限日期只放在「原文寫了的達成期限」那一列
  CONSTRAINT policy_elements_deadline_date_only_deadline CHECK (deadline_date IS NULL OR (element = 'deadline' AND stated)),
  CONSTRAINT policy_elements_source_url_http CHECK (source_url ~* '^https?://[^/\s]+'),
  CONSTRAINT policy_elements_locator CHECK (char_length(btrim(source_locator)) BETWEEN 1 AND 200)
);

COMMENT ON TABLE policy_elements IS
  '政見三要素（#364，與日本站 keifu policy_elements 同一套）：一條政見一個要素一列。沒有列＝未調查；stated=false＝查過原文、沒寫（未說明）。不補數字、不換算、不評價';
COMMENT ON COLUMN policy_elements.element IS 'target 數值目標／deadline 達成期限／funding 財源';
COMMENT ON COLUMN policy_elements.stated IS 'true＝原文有寫；false＝查過原文、沒寫（畫面「未說明」）。沒有這一列才是「未調查」';
COMMENT ON COLUMN policy_elements.text IS '要素本身，只寫原文的事實，120 字內；stated=false 時為 NULL';
COMMENT ON COLUMN policy_elements.deadline_date IS 'element=deadline、原文有寫、而且換得成日期時才填。會計年度＝曆年：「2028 年前」→ 2028-12-31；「任內」→ 卸任日（office_term_end）';
COMMENT ON COLUMN policy_elements.source_url IS '這一列的主要出處（查的是哪份原文；stated=false 也要有）。觸發器同步成 source_refs，讀出處請讀 source_refs＋sources';
COMMENT ON COLUMN policy_elements.source_locator IS '原句在原文的位置（公報第幾頁哪一段、影片時間點、網頁哪一節）；stated=false 也要填查的是哪一段';
COMMENT ON COLUMN policy_elements.contribution_id IS '最後一次寫這一列的貢獻';

-- deadline_due 只掃「有日期的達成期限」那幾列
CREATE INDEX IF NOT EXISTS idx_policy_elements_deadline_due ON policy_elements (deadline_date)
  WHERE element = 'deadline' AND deadline_date IS NOT NULL;

ALTER TABLE policy_elements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON policy_elements;
CREATE POLICY "Public read" ON policy_elements FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON policy_elements;
CREATE POLICY "Service role write" ON policy_elements FOR ALL USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION policy_elements_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_policy_elements_touch ON policy_elements;
CREATE TRIGGER trg_policy_elements_touch BEFORE UPDATE ON policy_elements
  FOR EACH ROW EXECUTE FUNCTION policy_elements_touch_updated_at();

-- ------------------------------------------------------------
-- 出處：source_refs 收這張表（只加不刪：原本的 policies、tracking_logs 照舊）
-- ------------------------------------------------------------
ALTER TABLE source_refs DROP CONSTRAINT IF EXISTS source_refs_target_table_check;
ALTER TABLE source_refs ADD CONSTRAINT source_refs_target_table_check
  CHECK (target_table IN ('policies', 'tracking_logs', 'policy_elements'));

-- policy_elements.source_url → 主要出處。跟 sources_sync_policy 不同的是**出錯就擋**：
-- 三要素的出處是這筆資料的一部分（「未說明」也要講得出查的是哪份原文），寫不進出處表寧可這次落庫失敗、自動重試，
-- 也不要留下一列沒有出處的要素。網址格式已經由 CHECK 擋過，source_upsert 只剩資料庫本身出錯會失敗。
CREATE OR REPLACE FUNCTION policy_elements_sync_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_sid BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.source_url IS NOT DISTINCT FROM OLD.source_url THEN RETURN NEW; END IF;
  v_sid := source_upsert(NEW.source_url, 'policy_elements.source_url', NULL, NULL, NULL, now());
  IF v_sid IS NULL THEN
    RAISE EXCEPTION 'policy_elements_sync_source(%): 出處網址寫不進 sources：%', NEW.id, NEW.source_url;
  END IF;
  DELETE FROM source_refs
   WHERE target_table = 'policy_elements' AND target_id = NEW.id::text AND role = 'primary' AND source_id <> v_sid;
  INSERT INTO source_refs (source_id, target_table, target_id, role, origin)
  VALUES (v_sid, 'policy_elements', NEW.id::text, 'primary', 'policy_elements.source_url')
  ON CONFLICT (target_table, target_id, source_id) DO UPDATE SET role = 'primary';
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_policy_elements_sync_source ON policy_elements;
CREATE TRIGGER trg_policy_elements_sync_source AFTER INSERT OR UPDATE OF source_url ON policy_elements
  FOR EACH ROW EXECUTE FUNCTION policy_elements_sync_source();

-- 列被刪掉（查核履歷整筆還原一筆新增）時，它的引用一起清掉；sources 那一列留著（別的資料可能也引用它）
CREATE OR REPLACE FUNCTION policy_elements_drop_refs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM source_refs WHERE target_table = 'policy_elements' AND target_id = OLD.id::text;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS trg_policy_elements_drop_refs ON policy_elements;
CREATE TRIGGER trg_policy_elements_drop_refs AFTER DELETE ON policy_elements
  FOR EACH ROW EXECUTE FUNCTION policy_elements_drop_refs();

-- ------------------------------------------------------------
-- 貢獻型別：policy_elements（DB CHECK、TS CONTRIBUTION_TYPES、skill.md、標籤四處一起改；thresholds.test 盯 CHECK 與 TS 一致）
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements'));

-- 票數預算影子模式（只記錄、不套用門檻，見 _shared/vote-budget.ts）的候選加上這種型別：
-- vote-budget.test 規定每一種貢獻型別都要有風險維度，vote-budget-cron.test 規定候選清單＝有維度的型別。
-- 本體照抄 20261005004900（#344 應選名額加了 district_seats），只在清單尾端加 'policy_elements'。影子模式不影響計分。
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements')
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

-- ------------------------------------------------------------
-- 讀取：policies_with_logs 多一欄 elements（只加在最後一欄；前面的欄位與 20260921000028 一字不差）
-- 政見頁、縣市頁的並排比較、預渲染與邊緣渲染讀的都是這個視圖，加一欄就全站都拿得到，不必另開一條讀取路徑。
-- 每個要素帶自己的出處（source_refs → sources：網址、標題、等級、存檔網址）。陣列裡沒有的要素＝未調查。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object('id', tl.id, 'date', tl.date, 'event', tl.event, 'description', tl.description)
      ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'element', e.element, 'stated', e.stated, 'text', e.text, 'deadline_date', e.deadline_date,
        'source_locator', e.source_locator, 'source_url', e.source_url, 'updated_at', e.updated_at,
        'source', (SELECT json_build_object('url', s.url, 'title', s.title, 'publisher', s.publisher,
                                            'kind', s.source_kind, 'archive_url', s.archive_url)
                     FROM source_refs r JOIN sources s ON s.id = r.source_id
                    WHERE r.target_table = 'policy_elements' AND r.target_id = e.id::text AND r.role = 'primary'
                    LIMIT 1)
      )
      ORDER BY array_position(ARRAY['target', 'deadline', 'funding'], e.element)
    )
    FROM policy_elements e
    WHERE e.policy_id = p.id),
    '[]'::json
  ) AS elements
FROM policies p;

-- CREATE OR REPLACE VIEW 會把 reloptions 換成這次給的（沒給＝清空），security_invoker 要再設一次，
-- 不然視圖會以擁有者身分讀、繞過底層表的 RLS（見 20260912000016）
ALTER VIEW policies_with_logs SET (security_invoker = on);

-- ------------------------------------------------------------
-- 派工臂一：policy_elements_missing（政見還沒拆完三要素）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_policy_elements()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH inflight AS (
    -- 已經有人交了、還在等票或自動重試中：先不派，免得兩個代理拆同一條；被退件就會回來
    SELECT DISTINCT c.payload->>'policy_id' AS policy_id
      FROM contributions c
     WHERE c.contribution_type = 'policy_elements' AND c.status IN ('pending', 'verified', 'apply_failed')
  ),
  cand AS (
    SELECT pl.id AS policy_id, pl.title, pl.status::TEXT AS status, pl.election_id, pl.source_url,
           p.id AS politician_id, p.name, p.party, COALESCE(r.region, p.region) AS region,
           x.election_type, e.election_date,
           -- 屆別年份從投票日取，不從 id 推（#344：之後新增的選舉 id 不保證是年份）
           EXTRACT(YEAR FROM e.election_date)::INTEGER AS election_year,
           office_term_end(EXTRACT(YEAR FROM e.election_date)::INTEGER, x.election_type) AS term_end,
           ARRAY(SELECT k FROM unnest(ARRAY['target', 'deadline', 'funding']) WITH ORDINALITY AS u(k, n)
                  WHERE NOT EXISTS (SELECT 1 FROM policy_elements pe WHERE pe.policy_id = pl.id AND pe.element = u.k)
                  ORDER BY u.n) AS missing
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      -- 這個人那一屆的參選紀錄（同一屆有兩筆時取當選的、在選的那一筆）
      JOIN LATERAL (
        SELECT q.election_type, q.candidate_status, q.election_result, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.election_result = 'elected') DESC NULLS LAST,
                  (q.candidate_status NOT IN ('not_running', 'withdrawn')) DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL
       AND (
         -- 還沒投票：在選的人（選前要能並排比較）
         (e.election_date >= CURRENT_DATE AND x.candidate_status NOT IN ('not_running', 'withdrawn'))
         -- 已投票：當選者、而且還沒達成也沒跳票（期限要接得上追蹤）
         OR (e.election_date < CURRENT_DATE AND x.election_result = 'elected' AND pl.status::TEXT NOT IN ('Achieved', 'Failed'))
       )
  )
  SELECT 'auto:policy_elements_missing:' || c.policy_id, 'policy_elements_missing',
         jsonb_build_object('policy_id', c.policy_id, 'policy_title', c.title, 'status', c.status, 'source_url', c.source_url,
                            'politician_id', c.politician_id, 'name', c.name, 'party', c.party, 'region', c.region,
                            'election_id', c.election_id, 'election_type', c.election_type, 'term_end', c.term_end,
                            'missing', to_jsonb(c.missing)),
         '「' || c.title || '」（' || c.name || '，' || c.election_year || ' ' || COALESCE(c.election_type, '') || '）還沒拆成政見三要素，還缺：'
           || array_to_string(ARRAY(SELECT CASE k WHEN 'target' THEN '數值目標' WHEN 'deadline' THEN '達成期限' ELSE '財源' END
                                      FROM unnest(c.missing) WITH ORDINALITY AS u(k, n) ORDER BY u.n), '、') || '。'
           || '請打開這條政見的**原文**（選舉公報、政見發表會、候選人官網或競選文宣的政見頁；政見上的 source_url 若只是轉述的新聞，先找到原文），'
           || '逐一看原文有沒有寫：數值目標（做到多少、做到什麼程度）、達成期限（什麼時候之前）、財源（錢從哪裡來）。'
           || '有寫的照原文寫進 text（120 字內，不補數字、不換算、不評價）；查過原文沒寫的 stated 填 false——那也是答案，畫面會顯示「未說明」。'
           || '每個要素都要附原句位置（source_locator），沒寫的也要寫你查的是原文哪一段。'
           || '期限換得成日期就填 deadline_date：會計年度是曆年，「2028 年前」填 2028-12-31，「任內」填這一任的卸任日 ' || COALESCE(c.term_end::TEXT, '（target.term_end）') || '。'
           || '用 policy_elements 型別交一筆；找不到原文就用 no_change 回報你查了哪裡，不要拿我們的政見摘要當原文。',
         ARRAY_REMOVE(ARRAY[
           CASE WHEN c.source_url IS NOT NULL THEN c.source_url || ' ← 這條政見現在掛的出處（先看它是不是原文）' END,
           CASE c.election_year
             WHEN 2022 THEN 'https://eebulletin.cec.gov.tw/?dir=111 ← 中選會 2022（111 年）地方選舉公報：點縣市 → 選舉別 → 選舉區 PDF，候選人登記的政見原文在上面'
             WHEN 2024 THEN 'https://bulletin.cec.gov.tw/?dir=01%E9%81%B8%E8%88%89%E5%85%AC%E5%A0%B1%2F02%E7%AB%8B%E6%B3%95%E5%A7%94%E5%93%A1%2F113%E5%B9%B4%E7%AC%AC11%E5%B1%86 ← 中選會 2024（113 年）第 11 屆立委選舉公報'
             ELSE '中選會選舉公報（投票前約兩週才出版；出版前看候選人官網、競選臉書的政見頁）'
           END,
           '政見發表會影片（各縣市選委會的 YouTube 頻道）',
           'whoareyou.readr.tw READr 政見總覽（個人頁有歷次政見）'
         ], NULL),
         1, c.region
    FROM cand c
   WHERE cardinality(c.missing) > 0
     AND NOT EXISTS (SELECT 1 FROM inflight i WHERE i.policy_id = c.policy_id::TEXT)
$$;
COMMENT ON FUNCTION contribution_auto_tasks_policy_elements IS
  '政見還沒拆完三要素 → policy_elements_missing（還沒投票的屆別：在選者；已投票的屆別：當選者、未達成也未跳票）。已有人交了在等票的先不派（#364，2026-10-05）';

-- ------------------------------------------------------------
-- 派工臂二：deadline_due（期限到了、沒有後續 → 查進度）
-- 條件跟日本站「期限を迎えた公約」一致：達成期限的日期早於今天、政見還沒達成也沒跳票、期限之後沒有任何追蹤紀錄。
-- 另外兩條照 progress_stale：競選承諾要等那場選舉投完票；落選、退選者的承諾不問。
-- 前端「期限已到的政見」用同一套條件（lib/policy-elements.ts 的 isDeadlineDue），改一邊要改另一邊。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION contribution_auto_tasks_deadline_due()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT 'auto:deadline_due:' || pl.id, 'deadline_due',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'status', pl.status::TEXT, 'progress', pl.progress,
                            'politician_id', p.id, 'name', p.name, 'region', p.region, 'election_id', pl.election_id,
                            'deadline_date', d.deadline_date, 'deadline_text', d.text, 'deadline_source_url', d.source_url,
                            'deadline_source_locator', d.source_locator,
                            'last_log_date', (SELECT max(tl.date) FROM tracking_logs tl WHERE tl.policy_id = pl.id)),
         '「' || pl.title || '」（' || p.name || '）原文寫的達成期限是「' || d.text || '」（換算 ' || d.deadline_date::TEXT || '），已經過了；'
           || '這條政見現在標的是「' || CASE pl.status::TEXT WHEN 'Campaign Pledge' THEN '競選承諾' WHEN 'Proposed' THEN '提出'
                                          WHEN 'In Progress' THEN '進行中' WHEN 'Stalled' THEN '滯後' ELSE pl.status::TEXT END
           || '」，期限之後沒有任何進度紀錄。請查期限到了做到沒有（施政報告、議會或立法院紀錄、預算書、新聞），'
           || '有結果就用 policy_progress 交：date 填事件日期，note 寫清楚跟期限比的結果（例：「原訂 2025 年底完工，2026-03 才通車」）；'
           || '查證後確定期限之後真的沒有任何消息，就用 no_change 回報你查了哪些來源。不要自己判定跳票——要有來源寫出結果。',
         ARRAY['縣市政府或中央機關的施政報告（*.gov.tw）', '議會、立法院的議事錄與質詢紀錄', '預算書與決算書', 'cna.com.tw'],
         1, p.region
    FROM policy_elements d
    JOIN policies pl ON pl.id = d.policy_id AND pl.removed_at IS NULL
    JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
    LEFT JOIN elections e ON e.id = pl.election_id
   WHERE d.element = 'deadline' AND d.stated AND d.deadline_date IS NOT NULL
     AND d.deadline_date < CURRENT_DATE
     AND pl.status::TEXT NOT IN ('Achieved', 'Failed')
     AND NOT EXISTS (SELECT 1 FROM tracking_logs tl WHERE tl.policy_id = pl.id AND tl.date > d.deadline_date)
     -- 競選承諾要等那場選舉投完票才問得出「做到沒有」（同 progress_stale）
     AND (pl.status::TEXT <> 'Campaign Pledge' OR (e.election_date IS NOT NULL AND e.election_date < CURRENT_DATE))
     -- 落選／退選者的承諾不會有進度（同 progress_stale）
     AND NOT EXISTS (
       SELECT 1 FROM politician_elections pe
        WHERE pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id
          AND pe.election_result IN ('not_elected', 'withdrawn')
     )
$$;
COMMENT ON FUNCTION contribution_auto_tasks_deadline_due IS
  '達成期限的日期已過、政見未達成也未跳票、期限之後沒有追蹤紀錄 → deadline_due（查進度，交 policy_progress）。跟日本站「期限を迎えた公約」同條件（#364，2026-10-05）';

-- ------------------------------------------------------------
-- 所有自動缺口：原樣保留 20261005004900（#344 district_seats）那一版的每一支臂，加這兩支。
-- 期限到了的政見只派 deadline_due：同一條政見同時符合 progress_stale（90 天沒進度）時，progress_stale 那件不派。
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
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。'
  '2026-10-03 名單清查依 roster_check_scope.regions 濾掉沒有這種選舉的縣市。'
  '2026-10-04 加村里長（鄉鎮市區層級）的清查臂；鄉鎮市長／代表類的清查說明補「要填 sub_region」。'
  '2026-10-04 加 township_gap：region_id 空的鄉鎮／村里層級參選紀錄缺鄉鎮（村里長缺村里），沿用 candidacy_source_missing 型別。'
  '2026-10-05 加 region_gap（縣市長／議員／立委缺縣市或缺選區）與 elected_missing（中選會當選、我們沒有參選紀錄）。'
  '2026-10-05 加 roster_cec_gap（已投票屆別：中選會名單有、我們沒有的人，依鄉鎮或縣市聚成名單清查）。'
  '2026-10-06 加 district_seats（議員、代表各選舉區的應選名額，#344）。'
  '2026-10-05 加 policy_elements（政見三要素）與 deadline_due（期限到了查進度，同一條政見不再另派 progress_stale）（#364）。';
