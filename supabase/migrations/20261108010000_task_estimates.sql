-- 派工前先請 Jev 估任務（階段 1：只分類與曝露，不改派工順序；維護者 2026-11-08 核准）
-- Jev 一次呼叫問四題：難度、預估時間、需要的模型強度、主要難點。結果存在側表 task_estimates（每個任務一列，
-- 現行答案）；每次問也照慣例寫 jev_decisions（subject_type=task、subject_id=task_id、四個 task_* 題目），歷史與成本留在那裡。
-- 「目標變了才重問」：target_hash = md5(task_type || '|' || target)，候選函式 task_estimate_candidates 比對它與題目版本。
-- 不排程（沒有 cron）：階段 1 由手動叫 system-one?action=task_estimate；排程與依預估排序留給階段 2。
-- 孤列（派工列已收回、估計還在）無害：/next 只按派出的 task_id 讀；不加觸發器，避免動到 task_dispatches 的熱路徑。

CREATE TABLE IF NOT EXISTS task_estimates (
  task_id          TEXT PRIMARY KEY,                 -- task_dispatches.task_id（auto:… 或手動任務 uuid；不含 verify:）
  target_hash      TEXT NOT NULL,                    -- md5(task_type || '|' || target)，目標變了才重問
  question_version TEXT NOT NULL,                    -- 題目版本（TS 的 TASK_ESTIMATE_VERSION），改題目就整批重問
  difficulty       TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  time_bucket      TEXT NOT NULL CHECK (time_bucket IN ('le10', 'm10_30', 'm30_60', 'gt60')),
  model_need       TEXT NOT NULL CHECK (model_need IN ('cheap', 'strong')),
  hardness         TEXT NOT NULL CHECK (hardness IN ('ocr', 'cross_identity', 'news_search', 'single_official_page', 'other')),
  probabilities    JSONB,                            -- 四題各自被選中那項的機率 {difficulty, time_bucket, model_need, hardness}
  model            TEXT NOT NULL,                    -- Jev 回應裡的完整版本
  cost_usd         NUMERIC(12, 8),
  estimated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE task_estimates IS 'Jev 對派工列的難度／時間／模型強度／難點估計（現行答案，每任務一列）；歷史在 jev_decisions（subject_type=task）。階段 1 只曝露在 /next 的 item.estimate，不影響派工順序';

ALTER TABLE task_estimates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "task_estimates public read" ON task_estimates;
CREATE POLICY "task_estimates public read" ON task_estimates FOR SELECT USING (true);
GRANT SELECT ON task_estimates TO anon, authenticated;
GRANT ALL ON task_estimates TO service_role;

-- jev_decisions 擴 CHECK：新主體 task、四個新題目
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_subject_type_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_subject_type_check
  CHECK (subject_type IN ('policy', 'identity_review', 'politician_pair', 'contribution', 'vote', 'politician_election', 'news_item', 'politician', 'citizen_question', 'task'));
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget', 'followup', 'news_relevance', 'bio_education', 'bio_experience', 'ask_screen',
                      'task_difficulty', 'task_time', 'task_model', 'task_hardness'));

-- 候選：還沒估過、目標變了、或題目版本不同的派工列（不含驗證票），照 queue_at（快派到的先估）。只有 service_role 能叫。
CREATE OR REPLACE FUNCTION task_estimate_candidates(p_limit INT DEFAULT 20, p_version TEXT DEFAULT '')
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], target_hash TEXT, is_manual BOOLEAN)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT d.task_id, d.task_type, d.target, d.what_we_need, d.hint_sources,
         md5(COALESCE(d.task_type, '') || '|' || COALESCE(d.target::text, '')) AS target_hash,
         d.task_id NOT LIKE 'auto:%' AS is_manual
    FROM task_dispatches d
    LEFT JOIN task_estimates e ON e.task_id = d.task_id
   WHERE d.task_id NOT LIKE 'verify:%'
     AND d.task_type IS NOT NULL
     AND (e.task_id IS NULL
          OR e.question_version <> p_version
          OR e.target_hash <> md5(COALESCE(d.task_type, '') || '|' || COALESCE(d.target::text, '')))
   ORDER BY d.queue_at ASC, d.task_id ASC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 300));
$$;
REVOKE ALL ON FUNCTION task_estimate_candidates(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION task_estimate_candidates(INT, TEXT) TO service_role;
