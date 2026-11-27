-- agy 加帳號：工作單寫入時由資料庫用 realtime.send 廣播，VM 端 helper 改訂閱、不再高頻輪詢 claim
-- ============================================================
-- 背景：VM 端 helper 原本靠輪詢 agy_login_claim 領單（一天十幾萬次呼叫）。改成事件式：
--   agy_login_start 建立一筆 starting 的登入請求（INSERT）→ 觸發器廣播到 Realtime 公開頻道 agy-login、事件 job、
--   payload {"id": "<請求 id>"} → helper 收到才呼叫 claim。helper 仍保留低頻保底輪詢，所以廣播只是加速，失敗不能擋寫入。
-- 工作單只在 agy_login_start 的 INSERT 建立（status 預設 starting＝可被領），所以只掛 AFTER INSERT、且 WHEN status='starting'；
-- claim／取碼／完成等 UPDATE 路徑不廣播。agy_login_start／agy_login_claim 本體一字不動。
--
-- 新增物件：函式 agy_login_broadcast_job()、觸發器 trg_agy_login_requests_broadcast（在 agy_login_requests）。
-- 回滾：
--   DROP TRIGGER IF EXISTS trg_agy_login_requests_broadcast ON agy_login_requests;
--   DROP FUNCTION IF EXISTS agy_login_broadcast_job();

CREATE OR REPLACE FUNCTION agy_login_broadcast_job() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  BEGIN
    PERFORM realtime.send(jsonb_build_object('id', NEW.id::text), 'job', 'agy-login', false);
  EXCEPTION WHEN OTHERS THEN
    -- 廣播失敗絕不能擋寫入（helper 還有保底輪詢）
    RAISE WARNING 'agy-login broadcast 失敗：%', SQLERRM;
  END;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION agy_login_broadcast_job() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_agy_login_requests_broadcast ON agy_login_requests;
CREATE TRIGGER trg_agy_login_requests_broadcast
  AFTER INSERT ON agy_login_requests
  FOR EACH ROW WHEN (NEW.status = 'starting')
  EXECUTE FUNCTION agy_login_broadcast_job();
