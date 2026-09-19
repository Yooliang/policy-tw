-- 用 Jev（System One）的高信心判斷把某些自動任務排到前面。只動順序，不動內容。
--
-- 為什麼是排順序而不是直接寫答案：
--   skill.md §2 的 policy_election_missing 明文規定「來源沒寫清楚、或那個人同時參選過多屆
--   分不出來，就不要猜」。Jev 是從政見文字推的，按那條規則就是猜，所以它的答案不能直接落庫。
--   但「先做哪一筆」本來就是系統決定的，跟代理的判斷無關——調順序不牴觸任何裁決。
--
-- 為什麼這樣做反而讓答案更可信：
--   代理不會知道 Jev 說了什麼（任務文字一個字都沒改），所以他查證後回報的屆別是獨立的。
--   而 jev_decisions 裡的預測帶著時間戳、早於代理作答——這是前瞻性測試，
--   比事後比對「一致率」有力得多。等這批做完，我們才第一次有真正的準確率。
--
-- 背景數字（2026-09-19）：189 筆政見沒有屆別，歷來只有 1 筆 election_id 的 correction 還在
-- pending——代理幾乎沒在做這型任務，時間都被 3:1 的驗證比例吃掉。Jev 對其中 31 筆給出
-- ≥0.95 的答案。把這 31 筆排前面，等於先把最可能有結論的做掉。

-- 一鍵全關：改成 RETURN FALSE 再跑一次就回到純隨機，不必動 contribution_auto_tasks。
CREATE OR REPLACE FUNCTION system_one_priority_enabled() RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
COMMENT ON FUNCTION system_one_priority_enabled IS
  'Jev 高信心任務是否排前面。要關掉就改成 SELECT FALSE 再跑一次。';

/** 門檻 0.95：實測同一題重問，機率 ≤0.55 才會換答案，而兩次都 ≥0.95 的 155 題答案全數一致 */
CREATE OR REPLACE FUNCTION system_one_min_probability() RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$ SELECT 0.95::NUMERIC $$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT ''
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER)
LANGUAGE sql STABLE AS $$
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward
  FROM contribution_auto_tasks_raw() t
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    -- 冷卻過濾必須在 LIMIT 之前，否則會吃掉配額
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id
        AND tc.checked_at > now() - (task_check_cooldown_days() || ' days')::INTERVAL
    )
  ORDER BY
    -- 第一層：Jev 有高信心答案的排前面。只認 policy_election_missing，
    -- 而且只認「它給得出年份」的（unknown 不算——那種排前面沒有意義）。
    CASE WHEN system_one_priority_enabled() AND EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'policy'
        AND j.question = 'election'
        AND j.choice <> 'unknown'
        AND j.probability >= system_one_min_probability()
        AND t.task_id = 'auto:policy_election_missing:' || j.subject_id
    ) THEN 0 ELSE 1 END,
    -- 第二層：層內照舊隨機。少了這一層，所有代理會同時盯著同一筆。
    md5(t.task_id || COALESCE(p_seed, ''))
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;

COMMENT ON FUNCTION contribution_auto_tasks IS
  '自動缺口任務：套冷卻過濾 → Jev 高信心的排前面 → 層內隨機 → 限筆數。任務文字不受影響。';
