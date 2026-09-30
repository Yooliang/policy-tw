-- 新聞追蹤第二步：Jev 逐則初篩＋派工（維護者 2026-09-29 核准；同日規格變更：每小時收完當場篩，不另排每天兩次）
--
-- news-fetch（每小時第 5 分）收完就呼叫 system-one?action=news_screen，只篩 screened_at IS NULL 的：
--   1. 便宜篩：標題＋摘要裡沒有任何「在職或 2026 參選中」的人名 → 直接記 screen={result:'no_name'}，不問 Jev；
--   2. 有人名的問 Jev：把那些人的現行政見（每人最多 30 條）連同新聞給它，選「哪一條政見的進度／某人的新承諾／無關」；
--   3. 有關的開一件 news_sweep 任務（沿用既有任務型別，target.kind='news_item'，附新聞網址與對應政見），
--      無關的也記下來（screen.result = unrelated／low_confidence）。
-- 成本上限跟其他不帶金鑰的動作一樣：10 分鐘內 Jev 最多問 300 則、一輪最多撿 400 則。

-- 1. Jev 判決表認得新的主體與題目（清單照最新一版全列，vote-budget.test.ts 盯著 TS 的 QUESTIONS 與這裡一致）
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_subject_type_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_subject_type_check
  CHECK (subject_type IN ('policy', 'identity_review', 'politician_pair', 'contribution', 'vote', 'politician_election', 'news_item'));
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget', 'followup', 'news_relevance'));

-- 2. 初篩的人名池：「在職或 2026 參選中」＝2022／2024 當選（現在這一任），或 2026 有參選紀錄且不是不參選／退選。
--    2026-09-29 實查 1,891 列、1,438 個名字。不收全部 16,000 人：早期匯入的村里長、落選人名字大量撞到一般新聞。
--    姓名不到兩個字的不收；被合併的不收（名字留在保留的那筆身上）。
CREATE OR REPLACE FUNCTION news_screen_people()
RETURNS TABLE (politician_id UUID, name TEXT, region TEXT, role TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.name, p.region,
         string_agg(DISTINCT pe.election_id::TEXT || ' ' || pe.election_type::TEXT
                    || CASE WHEN pe.election_result = 'elected' THEN '當選' ELSE '參選' END, '、')
    FROM politicians p
    JOIN politician_elections pe ON pe.politician_id = p.id
   WHERE p.merged_into IS NULL
     AND char_length(btrim(p.name)) >= 2
     AND ((pe.election_id IN (2022, 2024) AND pe.election_result = 'elected')
       OR (pe.election_id = 2026 AND COALESCE(pe.candidate_status, '') NOT IN ('not_running', 'withdrawn')))
   GROUP BY p.id, p.name, p.region
$$;
GRANT EXECUTE ON FUNCTION news_screen_people() TO anon, authenticated;
COMMENT ON FUNCTION news_screen_people IS '新聞初篩的人名池：2022／2024 當選或 2026 參選中（排除不參選、退選、已合併、姓名不到兩字）';

-- 3. 舊的「整份 RSS 一件任務」停用：兩週 59 件、交出的全是新政見、進度 0 筆，一半的輪次什麼都沒交也沒留紀錄。
--    中央社改由 news_sources 逐則收。排程 news-sweep-refresh 留著（沒有啟用的來源就什麼都不做），要回頭打開 enabled 就好。
UPDATE news_sweep_feeds SET enabled = FALSE WHERE enabled;
-- 還開著的整份 RSS 任務一併關掉：排程只會關「啟用中來源」的舊任務，來源關了它就永遠開著、一直被派
UPDATE contribution_tasks SET status = 'closed', closed_at = now()
 WHERE task_type = 'news_sweep' AND status = 'open' AND target ? 'feed_url';
