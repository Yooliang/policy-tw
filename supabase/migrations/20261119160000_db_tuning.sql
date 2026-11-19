-- 資料庫減負（維護者 2026-11-19 同意；正式庫當天因負載連續重啟、已升級 Medium）。四件事放進這支 migration，第五件做不了：
--   1. cron.job_run_details 定期清理（函式 cron_run_details_purge()＋設定表 cron_run_details_settings＋pg_cron cron-run-details-purge）
--   2. pg_cron 同一分鐘同時啟動的群錯開（cron.alter_job，以 jobname 查 jobid、不寫死 id）
--   3. seed_auto_task_queue()／contribution_auto_tasks_arms() 加 work_mem = 16MB（seed 的 statement_timeout 280s 一併版本化）
--   4. 四張大表的 autovacuum／autoanalyze 門檻調勤
--   5. autovacuum_work_mem 是 sighup 級 GUC，migration（交易內）做不了：做法與限制見 docs/dispatch-arms.md「資料庫減負」段
--
-- ============================================================
-- 1. job_run_details 清理（2026-11-19 唯讀查正式庫）
-- ============================================================
--   現況：cron.job_run_details 203,682 列（最舊 2026-09-11）、含索引 104 MB；超過 7 天的 168,009 列。
--   誰讀它：資料庫端 pg_proc／pg_views 零處、repo 的 TS／Vue／Edge Function／腳本零處（只有 migration 註解與 docs 裡
--     「要看排程有沒有在跑看 cron.job_run_details」的人工查法）。所以程式端最長回看期 ＝ 0，保留 7 天（人工追查一週夠）。
--   欄位 CHECK 下限 retention_days >= 3：就算有人手滑 UPDATE 成 0，資料庫也拒絕，週末的事故現場一定留得住。
--   刪法比照 dispatch_records_purge（20261009080000）：設定單列表（參數是資料、改值一行 UPDATE、進 edit_history）、
--     分批（預設 5,000 筆一批）、有批數上限；按 runid 由小到大刪（舊列 runid 最小，免掃整張表）；end_time 為 NULL（還在跑）的不刪。
--   第一次上線要刪約 17 萬列：預設 max_batches = 50（一次最多 25 萬列）一晚刪完；之後每天只刪約 2.5 萬列。
--   排程：UTC 19:55 每天（台北 03:55），跟 policy-jp-dispatch-records-purge 同一分鐘（那一分鐘共 2 支）。
--   刪完表本身不會變小（死列留在原頁、新紀錄會重用），不需要 VACUUM FULL；autovacuum 會接手。
--   cron.job_run_details 屬 postgres；pg_cron 以排程建立者（postgres）身分執行 job，所以函式不需要 SECURITY DEFINER。
--
-- ============================================================
-- 2. pg_cron 錯開
-- ============================================================
--   原本同一分鐘最多同時啟動 10 支（:00 一分鐘就有 */10 的 6 支＋整點快照 2 支＋15 分鐘一支＋UTC 18–21 的 cec-roster-mirror-5min），
--   每 10 分鐘整個資料庫被同時打一下。全部週期性 job 一小時的啟動次數合計約 233 次、只有 60 個分鐘，平均每分鐘 3.9 支，
--   所以「每分鐘最多 3 支」數學上做不到（上限 60×3＝180）；這一版做到「每分鐘最多 4 支」（含 cec-roster-mirror-5min 的 */5）。
--   不動的（有時段語意、文件明寫分鐘、或原本就沒撞）：
--     seed-auto-task-queue-10min（維持 */10；manual_front_pull 靠它在台北每小時 :00、:10 兩輪）、
--     cand-no-front-pull-hourly（:03，docs/dispatch-arms.md 明寫）、roster-reconcile-10min（每 10 分鐘第 7 分，CLAUDE.md 明寫）、
--     console-fetch-hourly（第 17 分）、bulletin-watch-daily、bulletin-watch-hot、cec-roster-mirror-5min（UTC 18–21 區間）、
--     system-one-evidence-5min、pipeline-snapshot-hourly 與 policy-jp-pipeline-snapshot-hourly（整點快照，改分鐘會讓「每小時」的歸屬漂掉）、
--     所有每日／每週 job、以及其餘原本就沒撞的 10 分鐘級 job。
--   變更前後（共 16 支；其餘 job 的排程一個字都沒動）：
--     job                                    變更前                     變更後
--     apply-verified-10min                   0,10,20,30,40,50 * * * *   9,19,29,39,49,59 * * * *
--     cec-sync-live-10min                    0,10,20,30,40,50 * * * *   4,14,24,34,44,54 * * * *
--     cec-verify-10min                       0,10,20,30,40,50 * * * *   7,17,27,37,47,57 * * * *
--     policy-jp-seed-10min                   0,10,20,30,40,50 * * * *   9,19,29,39,49,59 * * * *
--     quota-snapshots-10min                  0,10,20,30,40,50 * * * *   1,11,21,31,41,51 * * * *
--     regions-elected-policy-count-10min     1,11,21,31,41,51 * * * *   9,19,29,39,49,59 * * * *
--     roster-reconcile-units-10min           3,13,23,33,43,53 * * * *   2,12,22,32,42,52 * * * *
--     system-one-followup-clarify-10min      3,13,23,33,43,53 * * * *   1,11,21,31,41,51 * * * *
--     system-one-precheck-10min              3,13,23,33,43,53 * * * *   4,14,24,34,44,54 * * * *
--     source-archive-10min                   7,17,27,37,47,57 * * * *   3,13,23,33,43,53 * * * *
--     policy-jp-system-one-precheck-10min    7,17,27,37,47,57 * * * *   6,16,26,36,46,56 * * * *
--     system-one-backfill-15min              0,15,30,45 * * * *         6,21,36,51 * * * *
--     agent-usage-15min                      11,26,41,56 * * * *        1,16,31,46 * * * *
--     system-one-legacy-30min                11,41 * * * *              20,50 * * * *
--     policy-jp-vote-baseline-hourly         17 * * * *                 30 * * * *
--     news-fetch-hourly                      5 * * * *                  10 * * * *
--   （變更前的 */10 與 5-59/10 等寫法與列出的逗號清單等價。）
--   寫法：只在 job 存在時才 alter（PGlite／本機沒有 pg_cron 或沒有該 job 就略過）；已經是新排程的不重複 alter（冪等）。
--   回滾＝再寫一支 migration 把上表「變更後」改回「變更前」。
--
-- ============================================================
-- 3. work_mem
-- ============================================================
--   public.seed_auto_task_queue() 現況 proconfig ＝ {statement_timeout=280s}（11-19 手動加的），這支把它寫成版本化設定並加 work_mem；
--   public.contribution_auto_tasks_arms()（只有這一個簽名；policy_jp 的同名函式是另一個 schema、不在範圍）。
--   ALTER FUNCTION … SET 只加／改指定的那一項、不動其他既有項（statement_timeout 不會被覆蓋）。
--   注意：之後若有 migration 對這兩支函式 CREATE OR REPLACE，新定義沒帶 SET 就會把 proconfig 洗掉（11-19 的 280s 就是這樣會被洗掉）；
--   守門 db-tuning.test.ts 會擋「本檔之後的 migration 重定義這兩支卻沒帶 work_mem」。
--
-- ============================================================
-- 4. autovacuum／autoanalyze 門檻
-- ============================================================
--   contribution_votes、contributions、task_dispatches（public）：預設 analyze 0.1／vacuum 0.2 對大表太鬆
--   （整張表要變動 10%／20% 才動），改成 0.02／0.05，統計與死列清得更勤。
--   jev_decisions（public，約 913 MB）另外處理：#996 會對它做大量 UPDATE，0.05 會過勤（每次全表掃），所以改 analyze 0.05／vacuum 0.1。
--   這四張目前 reloptions 皆為 NULL。
--
-- 引用到的既有物件（2026-11-19 唯讀查正式庫確認存在）：cron.job（jobid、jobname、schedule）、cron.alter_job、cron.job_run_details、
-- activity_audit()、activity_touch_updated_at()、auth.role()、public.seed_auto_task_queue()、public.contribution_auto_tasks_arms()、上述四張表。

-- ------------------------------------------------------------
-- 1a. 設定（單列）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cron_run_details_settings (
  id             SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled        BOOLEAN NOT NULL DEFAULT true,
  retention_days INTEGER NOT NULL DEFAULT 7 CHECK (retention_days BETWEEN 3 AND 365),
  batch_size     INTEGER NOT NULL DEFAULT 5000 CHECK (batch_size BETWEEN 100 AND 50000),
  max_batches    INTEGER NOT NULL DEFAULT 50 CHECK (max_batches BETWEEN 1 AND 200),
  note           TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE cron_run_details_settings IS
  'cron.job_run_details 清理的參數（單列 id=1）。改值一行 UPDATE，例：UPDATE cron_run_details_settings SET retention_days = 14, note = ''…'' WHERE id = 1;（每次修改進 edit_history）。目前沒有任何程式讀 job_run_details（只有人工查排程），所以保留天數只受 CHECK 下限 3 約束；之後有程式去讀它，保留天數要大於它的回看期。2026-11-19';
COMMENT ON COLUMN cron_run_details_settings.enabled IS 'false＝排程照跑但什麼都不刪';
COMMENT ON COLUMN cron_run_details_settings.retention_days IS 'job_run_details 保留幾天（end_time 超過就刪）。下限 3＝留得住一個週末的事故現場';
COMMENT ON COLUMN cron_run_details_settings.batch_size IS '每一批最多刪幾筆';
COMMENT ON COLUMN cron_run_details_settings.max_batches IS '每次排程最多刪幾批；沒刪完的隔天接著刪';
INSERT INTO cron_run_details_settings (id, note) VALUES (1, '初值：保留 7 天；每批 5,000 筆、最多 50 批（維護者 2026-11-19 同意）') ON CONFLICT (id) DO NOTHING;

ALTER TABLE cron_run_details_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON cron_run_details_settings;
CREATE POLICY "Public read" ON cron_run_details_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON cron_run_details_settings;
CREATE POLICY "Service role write" ON cron_run_details_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_cron_run_details_settings_touch ON cron_run_details_settings;
CREATE TRIGGER trg_cron_run_details_settings_touch BEFORE UPDATE ON cron_run_details_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_cron_run_details_settings_audit ON cron_run_details_settings;
CREATE TRIGGER trg_cron_run_details_settings_audit AFTER INSERT OR UPDATE OR DELETE ON cron_run_details_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ------------------------------------------------------------
-- 1b. 清理函式：分批，回傳這次刪了幾筆
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION cron_run_details_purge() RETURNS JSONB
LANGUAGE plpgsql
SET lock_timeout = '3s'
SET statement_timeout = '120s'
AS $$
DECLARE
  s cron_run_details_settings%ROWTYPE;
  v_n BIGINT := 0;
  n BIGINT;
  i INTEGER;
BEGIN
  SELECT * INTO s FROM cron_run_details_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.enabled THEN
    RETURN jsonb_build_object('enabled', false, 'job_run_details', 0);
  END IF;

  FOR i IN 1..s.max_batches LOOP
    DELETE FROM cron.job_run_details
    WHERE runid IN (
      SELECT runid FROM cron.job_run_details
      WHERE end_time IS NOT NULL
        AND end_time < now() - make_interval(days => s.retention_days)
      ORDER BY runid
      LIMIT s.batch_size
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    v_n := v_n + n;
    EXIT WHEN n < s.batch_size;
  END LOOP;

  RETURN jsonb_build_object('enabled', true, 'job_run_details', v_n);
END;
$$;
COMMENT ON FUNCTION cron_run_details_purge IS
  '刪掉 end_time 超過保留天數的 cron.job_run_details（天數與批量在 cron_run_details_settings）。分批刪、還在跑的（end_time 為 NULL）不刪；回傳刪了幾筆。pg_cron cron-run-details-purge 每天跑一次。2026-11-19';
REVOKE ALL ON FUNCTION cron_run_details_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION cron_run_details_purge() TO service_role;

-- ------------------------------------------------------------
-- 1c. 排程：UTC 19:55 每天
-- ------------------------------------------------------------
SELECT cron.unschedule('cron-run-details-purge') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cron-run-details-purge');
SELECT cron.schedule('cron-run-details-purge', '55 19 * * *', $$SELECT cron_run_details_purge();$$);

-- ------------------------------------------------------------
-- 2. pg_cron 錯開（變更前後對照見檔頭）
-- ------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT j.jobid, j.jobname, m.new_schedule
    FROM (VALUES
      ('apply-verified-10min', '9,19,29,39,49,59 * * * *'),
      ('cec-sync-live-10min', '4,14,24,34,44,54 * * * *'),
      ('cec-verify-10min', '7,17,27,37,47,57 * * * *'),
      ('policy-jp-seed-10min', '9,19,29,39,49,59 * * * *'),
      ('quota-snapshots-10min', '1,11,21,31,41,51 * * * *'),
      ('regions-elected-policy-count-10min', '9,19,29,39,49,59 * * * *'),
      ('roster-reconcile-units-10min', '2,12,22,32,42,52 * * * *'),
      ('system-one-followup-clarify-10min', '1,11,21,31,41,51 * * * *'),
      ('system-one-precheck-10min', '4,14,24,34,44,54 * * * *'),
      ('source-archive-10min', '3,13,23,33,43,53 * * * *'),
      ('policy-jp-system-one-precheck-10min', '6,16,26,36,46,56 * * * *'),
      ('system-one-backfill-15min', '6,21,36,51 * * * *'),
      ('agent-usage-15min', '1,16,31,46 * * * *'),
      ('system-one-legacy-30min', '20,50 * * * *'),
      ('policy-jp-vote-baseline-hourly', '30 * * * *'),
      ('news-fetch-hourly', '10 * * * *')
    ) AS m(jobname, new_schedule)
    JOIN cron.job j ON j.jobname = m.jobname
    WHERE j.schedule IS DISTINCT FROM m.new_schedule
  LOOP
    PERFORM cron.alter_job(r.jobid, schedule := r.new_schedule);
  END LOOP;
END;
$$;

-- ------------------------------------------------------------
-- 3. work_mem（statement_timeout 與現況一致，版本化；ALTER FUNCTION … SET 不動其他既有項）
-- ------------------------------------------------------------
ALTER FUNCTION public.seed_auto_task_queue() SET statement_timeout = '280s';
ALTER FUNCTION public.seed_auto_task_queue() SET work_mem = '16MB';
ALTER FUNCTION public.contribution_auto_tasks_arms() SET work_mem = '16MB';

-- ------------------------------------------------------------
-- 4. 大表 autoanalyze／autovacuum 門檻
-- ------------------------------------------------------------
ALTER TABLE public.contribution_votes SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.contributions      SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.task_dispatches    SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.jev_decisions      SET (autovacuum_analyze_scale_factor = 0.05, autovacuum_vacuum_scale_factor = 0.1);
