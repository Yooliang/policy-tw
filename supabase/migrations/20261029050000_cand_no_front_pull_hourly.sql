-- 號次的任務與驗證票每小時插隊，比網站請求還前面（2026-10-29，維護者：「號次的任務、驗證，每小時作插隊，比網站請求還優先」）。
--   原因：補號次（candidacy_source_missing 的 cand_no）是一次性的整批補資料，要趕在選舉前補完；
--   先前的一次性插隊（20261029010000、20261029040000，各 5 年）派出就歸零，而且比網站請求的 10 年（visitor_front_seconds）弱。
-- 做法：函式 cand_no_front_pull() 把兩種列的插隊秒數「至少」拉到 2 × queue_settings.visitor_front_seconds（20 年，比網站請求的 10 年前面）：
--   ① 號次缺口列（task_dispatches.target.kind = 'cand_no'）；② 還在等票的號次交件（candidacy、payload 帶 cand_no）的驗證列。
--   取 GREATEST，不累加；只更新秒數還不夠的列，沒變的不重寫（觸發器照新秒數重算 queue_at）。被派出後秒數歸零，下一個整點又拉回來——就是「每小時插隊」。
--   pg_cron 每小時第 3 分。到 2026-11-28（投票日）自動停：之後呼叫不做事；沒有符合的列時本來就是空操作。
-- 要停掉：SELECT cron.unschedule('cand-no-front-pull-hourly');（或等投票日）。
CREATE OR REPLACE FUNCTION cand_no_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER; v_boost BIGINT;
BEGIN
  IF activity_today() > DATE '2026-11-28' THEN RETURN 0; END IF;
  SELECT 2 * q.visitor_front_seconds INTO v_boost FROM queue_settings q WHERE q.id = 1;
  IF v_boost IS NULL OR v_boost <= 0 THEN RETURN 0; END IF;
  UPDATE task_dispatches d
     SET boost_seconds = v_boost, cooling = false
   WHERE d.boost_seconds < v_boost
     AND (
       d.target->>'kind' = 'cand_no'
       OR EXISTS (
         SELECT 1 FROM contributions c
          WHERE d.task_id = 'verify:' || c.id::text
            AND c.status = 'pending'
            AND c.contribution_type = 'candidacy'
            AND c.payload ? 'cand_no'
       )
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION cand_no_front_pull IS '號次的缺口列與等票的驗證列，插隊秒數至少拉到 2 × visitor_front_seconds（比網站請求前面）；pg_cron 每小時第 3 分；2026-11-28 之後不做事（2026-10-29，維護者）';

DO $do$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL AND to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'cand-no-front-pull-hourly';
    PERFORM cron.schedule('cand-no-front-pull-hourly', '3 * * * *', 'SELECT cand_no_front_pull();');
  END IF;
END
$do$;
-- 上線當下先跑一次，不用等到下個整點
SELECT cand_no_front_pull();
