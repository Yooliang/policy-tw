-- 認領事件表 lease_events：量「領了不交」（派工 0.5）。不升協議版、不改 TS。
--
-- 以前：contribution_task_leases 交件就刪、過期就清，沒有歷史，所以不知道哪些代理領了任務卻沒交。
-- 現在：租約被建立／刪除時，由觸發器各寫一筆事件。
--   issued    租約建立（AFTER INSERT；同一代理重領＝UPDATE 延長，不算新的 issued）
--   reported  租約被刪，且這個 task_id 在租約建立之後有人交了貢獻（/report 交件後釋放；contribution_task_leases 的刪除發生在貢獻寫入之後）
--   released  租約被刪、沒有交件、也沒過期（/next 帶 skip 的主動釋放，或其他 DELETE）
--   expired   租約被刪且 leased_until 已過（contribution_task_leases_purge()，/next 每次都叫）
-- 分辨原因：先看 session 設定 app.lease_release_reason（有帶就照它，清理函式帶 'expired'；不必改 TS），
-- 沒帶就推斷：建立後有貢獻 ＝ reported、已過期 ＝ expired、其餘 ＝ released。meta.by 記是哪種依據。
-- ip_hash 是 /next 本來就存的來源網段雜湊，不是原始 IP。
--
-- 引用到的既有物件：contribution_task_leases(task_id, target_key, agent_name, ip_hash, leased_until, created_at)、
-- contributions(task_id, created_at)、dispatch_records_settings、dispatch_records_purge()（最後一版 20261009080000）、auth.role()。

CREATE TABLE IF NOT EXISTS lease_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id    TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  event      TEXT NOT NULL CHECK (event IN ('issued', 'reported', 'released', 'expired')),
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE lease_events IS '派工認領事件：issued／reported／released／expired（觸發器寫，不改 TS）。只有 service_role 可讀寫；保留天數看 dispatch_records_settings.lease_events_days。2026-11-11';
CREATE INDEX IF NOT EXISTS idx_lease_events_task_at ON lease_events (task_id, at);
CREATE INDEX IF NOT EXISTS idx_lease_events_at ON lease_events (at);
ALTER TABLE lease_events ENABLE ROW LEVEL SECURITY; -- 刻意不建任何 policy：anon／authenticated 讀不到，service_role 繞過 RLS

-- ------------------------------------------------------------
-- 觸發器
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION lease_events_on_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lease_events (task_id, agent_name, ip_hash, event, at, meta)
  VALUES (NEW.task_id, NEW.agent_name, NEW.ip_hash, 'issued', now(),
          jsonb_build_object('target_key', NEW.target_key, 'leased_until', NEW.leased_until));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION lease_events_on_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_forced TEXT := nullif(current_setting('app.lease_release_reason', true), '');
  v_event  TEXT;
  v_by     TEXT;
BEGIN
  IF v_forced IN ('reported', 'released', 'expired') THEN
    v_event := v_forced; v_by := 'setting';
  ELSIF EXISTS (SELECT 1 FROM contributions c WHERE c.task_id = OLD.task_id AND c.created_at >= OLD.created_at) THEN
    v_event := 'reported'; v_by := 'contribution_after_lease';
  ELSIF OLD.leased_until < now() THEN
    v_event := 'expired'; v_by := 'leased_until_passed';
  ELSE
    v_event := 'released'; v_by := 'default';
  END IF;
  INSERT INTO lease_events (task_id, agent_name, ip_hash, event, at, meta)
  VALUES (OLD.task_id, OLD.agent_name, OLD.ip_hash, v_event, now(),
          jsonb_build_object('target_key', OLD.target_key, 'leased_at', OLD.created_at, 'leased_until', OLD.leased_until, 'by', v_by));
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_lease_events_insert ON contribution_task_leases;
CREATE TRIGGER trg_lease_events_insert AFTER INSERT ON contribution_task_leases FOR EACH ROW EXECUTE FUNCTION lease_events_on_insert();
DROP TRIGGER IF EXISTS trg_lease_events_delete ON contribution_task_leases;
CREATE TRIGGER trg_lease_events_delete AFTER DELETE ON contribution_task_leases FOR EACH ROW EXECUTE FUNCTION lease_events_on_delete();

-- 過期清理：明講原因（不靠推斷）。/next 每次都叫這支。
CREATE OR REPLACE FUNCTION contribution_task_leases_purge() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE n INTEGER;
BEGIN
  PERFORM set_config('app.lease_release_reason', 'expired', true);
  DELETE FROM contribution_task_leases WHERE leased_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.lease_release_reason', '', true);
  RETURN n;
END;
$$;

-- ------------------------------------------------------------
-- 保留天數（進 dispatch_records_settings）：統計視圖回看 7 天，下限 8 ＝ 7 天 ＋ 1 天邊際
-- （CHECK 另外加，守門 dispatch-records-purge.test.ts 才解析得到）
-- ------------------------------------------------------------
ALTER TABLE dispatch_records_settings ADD COLUMN IF NOT EXISTS lease_events_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE dispatch_records_settings ADD CONSTRAINT dispatch_records_settings_lease_events_days_check CHECK (lease_events_days BETWEEN 8 AND 365);
COMMENT ON COLUMN dispatch_records_settings.lease_events_days IS 'lease_events 保留幾天（at 超過就刪）。下限 8＝必須大於 lease_outcomes_7d 的 7 天回看期';

-- 清理函式：多清 lease_events（其餘照 20261009080000，分批、SKIP LOCKED）
CREATE OR REPLACE FUNCTION dispatch_records_purge() RETURNS JSONB
LANGUAGE plpgsql
SET lock_timeout = '3s'
SET statement_timeout = '120s'
AS $$
DECLARE
  s dispatch_records_settings%ROWTYPE;
  v_vd BIGINT := 0;
  v_sk BIGINT := 0;
  v_le BIGINT := 0;
  n BIGINT;
  i INTEGER;
BEGIN
  SELECT * INTO s FROM dispatch_records_settings WHERE id = 1;
  IF NOT FOUND OR NOT s.enabled THEN
    RETURN jsonb_build_object('enabled', false, 'verify_dispatches', 0, 'contribution_task_skips', 0, 'lease_events', 0);
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

  FOR i IN 1..s.max_batches LOOP
    DELETE FROM lease_events d
    USING (
      SELECT id FROM lease_events
      WHERE at < now() - make_interval(days => s.lease_events_days)
      LIMIT s.batch_size
      FOR UPDATE SKIP LOCKED
    ) o
    WHERE d.id = o.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_le := v_le + n;
    EXIT WHEN n < s.batch_size;
  END LOOP;

  RETURN jsonb_build_object('enabled', true, 'verify_dispatches', v_vd, 'contribution_task_skips', v_sk, 'lease_events', v_le);
END;
$$;
COMMENT ON FUNCTION dispatch_records_purge IS
  '刪掉超過保留天數的 verify_dispatches、contribution_task_skips、lease_events（天數與批量在 dispatch_records_settings）。每張表分批刪、跳過被鎖住的列；回傳各刪幾筆。pg_cron dispatch-records-purge 每天跑一次。2026-11-11 加 lease_events';
REVOKE ALL ON FUNCTION dispatch_records_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION dispatch_records_purge() TO service_role;

-- ------------------------------------------------------------
-- 統計視圖：近 7 天每個代理領了幾次、交了幾次、過期幾次。
-- 不交率 ＝ expired ／ (reported ＋ expired)；released（主動放掉、skip）不算不交。
-- 只給 service_role（唯讀查詢用 db query --linked）；回看期 7 天，保留天數下限 8。
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW lease_outcomes_7d WITH (security_invoker = true) AS
SELECT agent_name,
       count(*) FILTER (WHERE event = 'issued')   AS issued,
       count(*) FILTER (WHERE event = 'reported') AS reported,
       count(*) FILTER (WHERE event = 'released') AS released,
       count(*) FILTER (WHERE event = 'expired')  AS expired,
       round(count(*) FILTER (WHERE event = 'expired')::numeric
             / nullif(count(*) FILTER (WHERE event IN ('reported', 'expired')), 0), 3) AS no_show_rate
  FROM lease_events
 WHERE at >= now() - interval '7 days'
 GROUP BY agent_name;
COMMENT ON VIEW lease_outcomes_7d IS '近 7 天依 agent_name：issued／reported／released／expired 與不交率（expired／(reported＋expired)）。2026-11-11';
REVOKE ALL ON lease_outcomes_7d FROM PUBLIC, anon, authenticated;
GRANT SELECT ON lease_outcomes_7d TO service_role;
