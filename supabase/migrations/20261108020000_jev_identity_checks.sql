-- Jev 身份檢查兩道（2026-11-08，維護者小良核准；程式 _shared/jev-identity.ts，裁決 docs/decisions/2026-11-08-Jev身份檢查只擋不放.md）
-- ============================================================
--   1. 合併身份核對：merge_politician 重新進系統票的型別（部分更正 2026-09-20「不拿系統票」）。TS 只寫「擋」的一邊
--      （Jev 與宣稱相反且 >=0.95 → not_supported，目標 +1）；同意宣稱寫 cannot_tell（棄權），所以 supported -1 的折扣對合併永遠不會發生。
--   2. 新人物相似度：candidacy／politician 沒指 politician_id 會建新人物時，問 Jev 是不是同場同單位的既有人物或另一筆等票交件。
--      判定記 jev_decisions(contribution, new_person)；指到某位且 >=0.95 時另寫 source_support／not_supported（目標 +1，同號次重複檢查的做法）。
-- 本 migration：
--   a. jev_decisions_question_check 加 new_person（只擴 CHECK，不動資料）。
--   b. system_vote_eligible 加 merge_politician（contribution_system_vote 靠它認型別；candidacy／politician 本來就在裡面）。
--   c. system_one_precheck_candidates：merge_politician 沒有來源網址也要進來（它的「來源」是那兩筆資料本身）。
--   d. pg_cron system-one-identity-10min：每 10 分鐘 system-one?action=identity_check，補問預判沒問到的新人物檢查（抓不到來源的、沒附來源的）。
-- 不寫任何人物或貢獻資料。冪等。

ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget', 'followup', 'news_relevance', 'bio_education', 'bio_experience', 'ask_screen', 'new_person'));

CREATE OR REPLACE FUNCTION system_vote_eligible(p_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type IN ('policy', 'candidacy', 'politician', 'correction', 'policy_progress', 'election_results', 'reassign_candidacy', 'merge_politician')
$$;

CREATE OR REPLACE FUNCTION system_one_precheck_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (contribution_id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND system_vote_eligible(c.contribution_type)
    AND NOT system_vote_cec_only(c.contribution_type)
    AND (c.contribution_type = 'merge_politician' OR (c.source_urls IS NOT NULL AND array_length(c.source_urls, 1) >= 1))
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
    (EXISTS (SELECT 1 FROM jev_decisions j WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'source_support')) ASC,
    c.created_at ASC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 200));
$$;
COMMENT ON FUNCTION system_one_precheck_candidates IS
  '預判候選：pending、有來源（merge_politician 例外：來源是兩筆人物資料本身，2026-11-08）、型別合格、不是名單核對專屬的型別；Jev 真的判過的不再問；只有 fetch-only 棄權的滿 24 小時可重抓（最多三次，排在沒判過的後面）';

SELECT cron.unschedule('system-one-identity-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-identity-10min');
SELECT cron.schedule(
  'system-one-identity-10min',
  '8,18,28,38,48,58 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=identity_check&limit=50',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
