-- Jev 掃簡介：提到、但學歷／經歷欄沒列的，開任務（2026-10-04，維護者：「跑」）
-- 判定記在 jev_decisions（subject_type=politician、question=bio_education／bio_experience），一人一次。
-- 排程每小時一輪、一輪最多 60 人：有簡介的 175 人約三輪掃完，之後只掃新進的簡介。

ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_subject_type_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_subject_type_check
  CHECK (subject_type IN ('policy', 'identity_review', 'politician_pair', 'contribution', 'vote', 'politician_election', 'news_item', 'politician'));
ALTER TABLE jev_decisions DROP CONSTRAINT IF EXISTS jev_decisions_question_check;
ALTER TABLE jev_decisions ADD CONSTRAINT jev_decisions_question_check
  CHECK (question IN ('is_policy', 'duplicate_of', 'election', 'identity', 'same_person', 'source_support', 'second_source', 'extract', 'vote_budget', 'followup', 'news_relevance', 'bio_education', 'bio_experience'));

SELECT cron.unschedule('system-one-bio-gaps-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-bio-gaps-hourly');
SELECT cron.schedule(
  'system-one-bio-gaps-hourly',
  '40 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=bio_gaps&limit=60',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
