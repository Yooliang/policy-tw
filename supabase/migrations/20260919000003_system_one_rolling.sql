-- System One 滾動機制：state 指紋、補漏候選、準確率對帳、排程。設計理由見 docs/BLUEPRINT-jev-decisions.md §6–§9。
--
-- 1. state 指紋進 unique key
--    原本 unique(subject_type, subject_id, question, model) 把兩件事混在一起：
--    「不能重骰到滿意為止」與「資料變了該重問」。加上 state_hash 之後：
--      同樣 state + 同樣模型 → 擋住（不能重骰）
--      state 真的變了（多了參考資料） → 新增一列，舊的留著當歷史
--    指紋用 GENERATED 欄位在資料庫算，不讓呼叫端算——jsonb::text 會把 key 排序、去空白，
--    所以同一份 state 不管誰送、key 順序怎樣，指紋都一樣。單一真相。

ALTER TABLE jev_decisions
  ADD COLUMN IF NOT EXISTS state_hash TEXT GENERATED ALWAYS AS (md5(state::text)) STORED;

ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_subject_type_subject_id_question_model_key;
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_once_per_state;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_once_per_state
  UNIQUE (subject_type, subject_id, question, model, state_hash);

COMMENT ON COLUMN jev_decisions.state_hash IS
  'md5(state::text)，資料庫自己算。同 state 同模型只會有一列；state 變了才會多一列';

-- 2. 補漏候選：給 system-one 的 backfill 動作用。兩種來源，先「從沒問過的」再「答不出來但參考資料變多的」。
--    只回 id，問的動作在 Edge Function（那裡才有 OpenRouter 金鑰）。
CREATE OR REPLACE FUNCTION system_one_backfill_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (policy_id UUID, reason TEXT)
LANGUAGE sql STABLE AS $$
  WITH never_asked AS (
    SELECT p.id, 'never_asked'::TEXT AS reason, 0 AS tier
    FROM policies p
    WHERE p.removed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.subject_id = p.id::TEXT AND j.question = 'is_policy'
      )
  ),
  -- 斷年度上次答不出來（<門檻或 unknown），而且同一個人之後多了已標屆別的政見：
  -- 這是實測會從 5/8 變 8/8 的那種情況（藍圖 §2-3）。state 變了所以 unique 不會擋。
  retry_election AS (
    SELECT p.id, 'election_retry'::TEXT, 1
    FROM policies p
    JOIN LATERAL (
      SELECT j.asked_at, j.probability, j.choice FROM jev_decisions j
      WHERE j.subject_type = 'policy' AND j.subject_id = p.id::TEXT AND j.question = 'election'
      ORDER BY j.asked_at DESC LIMIT 1
    ) last ON TRUE
    WHERE p.removed_at IS NULL AND p.election_id IS NULL
      AND (last.choice = 'unknown' OR last.probability < system_one_min_probability())
      AND EXISTS (
        SELECT 1 FROM policies s
        JOIN edit_history h ON h.table_name = 'policies' AND h.record_id = s.id::TEXT
        WHERE s.politician_id = p.politician_id AND s.id <> p.id AND s.election_id IS NOT NULL
          AND h.applied_at > last.asked_at
      )
  )
  SELECT id, reason FROM (
    SELECT * FROM never_asked UNION ALL SELECT * FROM retry_election
  ) u
  ORDER BY tier, md5(id::TEXT)
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;
COMMENT ON FUNCTION system_one_backfill_candidates IS
  '還沒問過 Jev、或答不出來但參考資料變多了的政見。只回 id，問的動作在 system-one Edge Function。';

-- 3. 準確率對帳：Jev 的預測 vs 代理查證後的結果。
--    黃金答案只認「發生在 asked_at 之後」的裁決——預測要早於答案才算前瞻性測試。
--    代理看不到 Jev 的判斷（任務文字沒改），所以這些答案是獨立的。
CREATE OR REPLACE VIEW system_one_truth AS
  -- 斷年度：election_id 的 correction 落庫
  SELECT j.id AS decision_id, j.subject_id, j.question, j.choice, j.probability, j.asked_at,
         ch->>'correct_value' AS truth, c.applied_at AS truth_at, 'correction'::TEXT AS truth_source
  FROM jev_decisions j
  JOIN contributions c
    ON c.contribution_type = 'correction' AND c.status = 'applied'
   AND c.payload->>'target_table' = 'policies' AND c.payload->>'target_id' = j.subject_id
   AND c.applied_at > j.asked_at
  -- 舊格式 {field,...} 與新格式 {changes:[...]} 都收（correction.ts 的正規化同一套）
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c.payload->'changes', jsonb_build_array(c.payload))) ch
  WHERE j.subject_type = 'policy' AND j.question = 'election' AND ch->>'field' = 'election_id'
  UNION ALL
  -- 斷年度：代理查了說分不出來（no_change 帶那筆自動任務的 task_id）
  SELECT j.id, j.subject_id, j.question, j.choice, j.probability, j.asked_at,
         'unknown', c.created_at, 'no_change'
  FROM jev_decisions j
  JOIN contributions c
    ON c.contribution_type = 'no_change' AND c.status IN ('verified', 'applied')
   AND c.payload->>'task_id' = 'auto:policy_election_missing:' || j.subject_id
   AND c.created_at > j.asked_at
  WHERE j.subject_type = 'policy' AND j.question = 'election'
  UNION ALL
  -- 非政見：被 removal 移除＝不是政見
  SELECT j.id, j.subject_id, j.question, j.choice, j.probability, j.asked_at,
         'not_policy', p.removed_at, 'removal'
  FROM jev_decisions j
  JOIN policies p ON p.id::TEXT = j.subject_id AND p.removed_by IS NOT NULL AND p.removed_at > j.asked_at
  WHERE j.subject_type = 'policy' AND j.question = 'is_policy'
  UNION ALL
  -- 非政見：代理查過回 no_change＝它是政見。policy_election_missing 的任務文字第一步就是
  -- 「先判斷它是不是政見，不是的用 removal」，所以那型任務的 no_change 也算「是政見」。
  SELECT j.id, j.subject_id, j.question, j.choice, j.probability, j.asked_at,
         'policy', c.created_at, 'no_change'
  FROM jev_decisions j
  JOIN contributions c
    ON c.contribution_type = 'no_change' AND c.status IN ('verified', 'applied') AND c.created_at > j.asked_at
   AND (
     c.payload->>'task_id' = 'auto:policy_election_missing:' || j.subject_id
     OR EXISTS (
       SELECT 1 FROM contribution_tasks t
       WHERE t.task_type = 'policy_validity' AND t.target->>'policy_id' = j.subject_id
         AND c.payload->>'task_id' = t.id::TEXT
     )
   )
  WHERE j.subject_type = 'policy' AND j.question = 'is_policy';

COMMENT ON VIEW system_one_truth IS
  'Jev 每一筆預測對到之後代理查證的結果。只收 asked_at 之後的裁決，所以是前瞻性的。';

CREATE OR REPLACE VIEW system_one_accuracy AS
  SELECT question,
         COUNT(*) AS n,
         COUNT(*) FILTER (WHERE choice = truth) AS agree,
         ROUND(COUNT(*) FILTER (WHERE choice = truth)::NUMERIC / NULLIF(COUNT(*), 0), 3) AS agree_rate,
         COUNT(*) FILTER (WHERE probability >= system_one_min_probability()) AS n_hi,
         COUNT(*) FILTER (WHERE probability >= system_one_min_probability() AND choice = truth) AS agree_hi,
         ROUND(COUNT(*) FILTER (WHERE probability >= system_one_min_probability() AND choice = truth)::NUMERIC
               / NULLIF(COUNT(*) FILTER (WHERE probability >= system_one_min_probability()), 0), 3) AS agree_rate_hi
  FROM system_one_truth
  GROUP BY question;
COMMENT ON VIEW system_one_accuracy IS
  '每種判定的準確率，分全部與 ≥門檻兩組。agree_rate_hi 是決定要不要放大的唯一依據。';

GRANT SELECT ON system_one_truth, system_one_accuracy TO anon, authenticated;

-- 4. 排程：每 15 分鐘叫一次 backfill。事件觸發（落庫時問）是加速，這條才是保證。
--    不帶金鑰——這是開源倉庫，任何金鑰寫在這裡就是公開的。端點自己有成本上限：
--    10 分鐘內已問滿 limit 就不再問，所以就算被外人狂打，花費上限也是固定的。
--    要停：SELECT cron.unschedule('system-one-backfill-15min');
SELECT cron.unschedule('system-one-backfill-15min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-backfill-15min');
SELECT cron.schedule(
  'system-one-backfill-15min',
  '*/15 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=backfill&limit=20',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
