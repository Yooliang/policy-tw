-- 派工紀錄定時清理（#485，維護者 2026-10-08 同意）。
--
-- 現況（2026-10-08 唯讀查正式庫）：
--   verify_dispatches        35,942 筆（9/21 起），沒有任何清理；每天約 2,000 筆
--   contribution_task_skips   3,961 筆（9/15 起），沒有任何清理
--   contribution_task_leases 已有清理（交件刪除＋過期清理），不動
--
-- 誰讀這兩張表、往回看多久（資料庫端 pg_proc／視圖／觸發器全查過；程式端 grep 全 repo）：
--   verify_dispatches
--     1. /next 的每台機器 2:1（next/index.ts）：最近 MACHINE_LOOKBACK_HOURS＝3 小時、最多 3 筆
--     2. contribution_verify_pool（最後一版 20261009060000）：「剛派給這台機器的不要再派」，interval '15 minutes'
--     3. dispatch_recent（/queue 頁，20260924000007）：p_minutes 上限 240 分鐘（4 小時）
--     4. 派工綁定（verify-handler 的 POST /verify、POST /report{kind:"verify"} 沒帶憑證時）：以前沒有時限；
--        這支 PR 明寫成 VERIFY_BINDING_DAYS＝7 天（正式庫實測投票距派出 p99 約 4 分鐘、最久 51 小時，25,547 筆），
--        讀不到就 409 not_dispatched，代理重領一筆
--   contribution_task_skips
--     沒有任何讀者：/next 只 upsert 紀錄；2026-09-20 起 skip 改成「跟派過一樣排到後面」（20260920000006），
--     20260920000004／5 裡讀它的 24 小時判斷已被後面的版本取代（正式庫上只有 verify_dispatches 被兩支函式引用，skips 零支）。
--     TS 端留著一個 @deprecated 的 SKIP_MEMORY_HOURS＝24，保留天數仍要大於它。
--
-- 保留天數 = 最長回看期 + 安全邊際（兩張表各自算）：
--   verify_dispatches：最長回看期 7 天（派工綁定）＋ 7 天邊際 ＝ 14 天。邊際這麼大是因為綁定那一條被拿掉紀錄的代價是
--     「已經領了題目的代理投票被 409」，而整張表在 14 天的穩態只有約 3 萬筆（兩個索引，幾 MB），多留沒有成本。
--   contribution_task_skips：最長回看期 0（沒有讀者）；曾經的 24 小時加 6 天 ＝ 7 天。純留紀錄給人查「哪些題目常被跳過」，
--     一週夠看趨勢，不留更久。
--
-- 為什麼是設定表而不是寫死在函式裡：repo 慣例（traffic_boost_settings、task_cooldown_settings）— 參數是資料、改值一行 UPDATE
--   走 migration、每次修改由 activity_audit 寫進 edit_history。函式裡沒有任何天數、批量的數字。
--   下限放在欄位的 CHECK（verify_dispatches_days ≥ 8，必須大於派工綁定的 7 天；task_skips_days ≥ 2，必須大於 24 小時），
--   所以就算有人手滑 UPDATE 成 1 天，資料庫也拒絕。程式端的回看期若調大，守門測試會紅（見下面）。
--
-- 刪除方式：排程每天一次，每張表分批刪（batch_size 筆一批、最多 max_batches 批，預設 5,000 × 20 ＝ 一次最多 10 萬筆）。
--   每批用主鍵配對、FOR UPDATE SKIP LOCKED：碰到正被 /next 更新的列就跳過（舊列本來就不該被碰），不排隊等鎖，不會擋住派工。
--   第一次上線：保留 14 天／7 天時，要刪的量是 verify_dispatches 約 4,300 筆（超過 14 天的：9/21～9/24 那幾天）、
--   skips 約 840 筆（超過 7 天的）；一批就刪完。就算改成 1 天（約 3.4 萬筆）也只是 7 批，沒有分批以外的風險，
--   所以第一次不需要特別手動分段。超過上限沒刪完的，隔天的排程接著刪。
--
-- 守門：supabase/functions/_shared/dispatch-records-purge.test.ts
--   文字層：程式與 SQL 裡每一處讀這兩張表的地方（最後一版的函式本體）抽出回看期，保留天數 ≥ 每一處 + 1 天邊際；
--           有新的讀者出現但沒有時限、或找不出回看期，也紅。
--   行為層（PGlite，真的 contribution_verify_pool／dispatch_recent／這支函式）：清理前後，驗證池、/queue、每台機器 2:1 的查詢、
--           派工綁定查詢，結果逐筆相同；只有超過保留期的列被刪；批量上限、停用、設定改值。每條都有還原驗證。
--
-- 引用到的既有物件（2026-10-08 唯讀查正式庫確認存在）：verify_dispatches(contribution_id, ip_hash, agent_name, dispatched_at)、
-- contribution_task_skips(task_id, ip_hash, agent_name, skipped_at)、activity_audit()、activity_touch_updated_at()、edit_history、
-- auth.role()、擴充 pg_cron（cron.schedule／cron.unschedule；既有 gate-rejections-purge 同寫法）。
-- 正式庫沒有 dispatch_records_settings、dispatch_records_purge、dispatch-records-purge 排程。

-- ------------------------------------------------------------
-- 1. 設定（單列）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_records_settings (
  id                     SMALLINT PRIMARY KEY CHECK (id = 1),
  enabled                BOOLEAN NOT NULL DEFAULT true,
  verify_dispatches_days INTEGER NOT NULL DEFAULT 14 CHECK (verify_dispatches_days BETWEEN 8 AND 365),
  task_skips_days        INTEGER NOT NULL DEFAULT 7  CHECK (task_skips_days BETWEEN 2 AND 365),
  batch_size             INTEGER NOT NULL DEFAULT 5000 CHECK (batch_size BETWEEN 100 AND 50000),
  max_batches            INTEGER NOT NULL DEFAULT 20 CHECK (max_batches BETWEEN 1 AND 200),
  note                   TEXT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE dispatch_records_settings IS
  '派工紀錄清理的參數（單列 id=1）。改值一行 UPDATE，例：UPDATE dispatch_records_settings SET verify_dispatches_days = 21, note = ''…'' WHERE id = 1;（每次修改進 edit_history，agent_name=activity-audit）。保留天數必須大於程式最長回看期，守門 dispatch-records-purge.test.ts 讀最終值比對。2026-10-09（#485）';
COMMENT ON COLUMN dispatch_records_settings.enabled IS 'false＝排程照跑但什麼都不刪';
COMMENT ON COLUMN dispatch_records_settings.verify_dispatches_days IS 'verify_dispatches 保留幾天（dispatched_at 超過就刪）。下限 8＝必須大於派工綁定的 VERIFY_BINDING_DAYS（7）；程式端有更長的回看期時守門測試會要求調大';
COMMENT ON COLUMN dispatch_records_settings.task_skips_days IS 'contribution_task_skips 保留幾天（skipped_at 超過就刪）。目前沒有任何程式讀它，只留紀錄；下限 2＝大於曾經的 24 小時';
COMMENT ON COLUMN dispatch_records_settings.batch_size IS '每一批最多刪幾筆（每張表各自分批）';
COMMENT ON COLUMN dispatch_records_settings.max_batches IS '每次排程每張表最多刪幾批；沒刪完的隔天接著刪';
INSERT INTO dispatch_records_settings (id, note) VALUES (1, '初值：派工紀錄 14 天、跳過紀錄 7 天；每批 5,000 筆、最多 20 批（維護者 2026-10-08 同意、#485）') ON CONFLICT (id) DO NOTHING;

ALTER TABLE dispatch_records_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON dispatch_records_settings;
CREATE POLICY "Public read" ON dispatch_records_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON dispatch_records_settings;
CREATE POLICY "Service role write" ON dispatch_records_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP TRIGGER IF EXISTS trg_dispatch_records_settings_touch ON dispatch_records_settings;
CREATE TRIGGER trg_dispatch_records_settings_touch BEFORE UPDATE ON dispatch_records_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_dispatch_records_settings_audit ON dispatch_records_settings;
CREATE TRIGGER trg_dispatch_records_settings_audit AFTER INSERT OR UPDATE OR DELETE ON dispatch_records_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ------------------------------------------------------------
-- 2. 清理函式：分批、跳過被鎖住的列，回傳這次各刪了幾筆
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION dispatch_records_purge() RETURNS JSONB
LANGUAGE plpgsql
SET lock_timeout = '3s'
SET statement_timeout = '120s'
AS $$
DECLARE
  s dispatch_records_settings%ROWTYPE;
  v_vd BIGINT := 0;
  v_sk BIGINT := 0;
  n BIGINT;
  i INTEGER;
BEGIN
  SELECT * INTO s FROM dispatch_records_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.enabled THEN
    RETURN jsonb_build_object('enabled', false, 'verify_dispatches', 0, 'contribution_task_skips', 0);
  END IF;

  FOR i IN 1..s.max_batches LOOP
    DELETE FROM verify_dispatches d
    USING (
      SELECT contribution_id, ip_hash FROM verify_dispatches
      WHERE dispatched_at < now() - make_interval(days => s.verify_dispatches_days)
      LIMIT s.batch_size
      FOR UPDATE SKIP LOCKED
    ) o
    WHERE d.contribution_id = o.contribution_id AND d.ip_hash = o.ip_hash;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_vd := v_vd + n;
    EXIT WHEN n < s.batch_size;
  END LOOP;

  FOR i IN 1..s.max_batches LOOP
    DELETE FROM contribution_task_skips d
    USING (
      SELECT task_id, ip_hash FROM contribution_task_skips
      WHERE skipped_at < now() - make_interval(days => s.task_skips_days)
      LIMIT s.batch_size
      FOR UPDATE SKIP LOCKED
    ) o
    WHERE d.task_id = o.task_id AND d.ip_hash = o.ip_hash;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_sk := v_sk + n;
    EXIT WHEN n < s.batch_size;
  END LOOP;

  RETURN jsonb_build_object('enabled', true, 'verify_dispatches', v_vd, 'contribution_task_skips', v_sk);
END;
$$;
COMMENT ON FUNCTION dispatch_records_purge IS
  '刪掉超過保留天數的 verify_dispatches、contribution_task_skips（天數與批量在 dispatch_records_settings）。每張表分批刪、跳過被鎖住的列；回傳各刪幾筆。pg_cron dispatch-records-purge 每天跑一次。2026-10-09（#485）';
REVOKE ALL ON FUNCTION dispatch_records_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION dispatch_records_purge() TO service_role;

-- ------------------------------------------------------------
-- 3. 排程：台北 03:50 每天一次（UTC 19:50；跟 gate-rejections-purge 19:40 錯開）
-- ------------------------------------------------------------
SELECT cron.unschedule('dispatch-records-purge') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'dispatch-records-purge');
SELECT cron.schedule('dispatch-records-purge', '50 19 * * *', $$SELECT dispatch_records_purge();$$);
