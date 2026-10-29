-- 日本站的額度設定 policy_jp.quota_settings（2026-10-29，#769；維護者裁：日本站不碰 public）
-- ============================================================
--
-- 同 public.quota_settings 的欄位與上下限（網段提交 10～2000、網段驗證 10～5000、DiTrust 提交 10～5000、DiTrust 驗證 10～10000），
-- 單列（site='jp'），初值 80／200／500／1000。RLS 開、比照 policy_jp.queue_settings：REVOKE 給 PUBLIC／anon／authenticated，只 GRANT 給 service_role
-- （日本站的 Edge Function 用 service_role 的日本站 client 讀；主控台經 public 的 console_quota_settings() 讀、
-- console_admin_quota_settings_save 寫，兩支都是 SECURITY DEFINER）。
-- 審計寫 policy_jp.edit_history（record_id＝site），updated_at 用 policy_jp.activity_touch_updated_at()。
-- 檔名時間戳刻意早於 20261029080000：public 的 RPC 建立時要解析這張表的型別。

CREATE TABLE IF NOT EXISTS policy_jp.quota_settings (
  site               TEXT PRIMARY KEY CHECK (site = 'jp'),
  per_ip_submit      INTEGER NOT NULL DEFAULT 80   CHECK (per_ip_submit      BETWEEN 10 AND 2000),
  per_ip_verify      INTEGER NOT NULL DEFAULT 200  CHECK (per_ip_verify      BETWEEN 10 AND 5000),
  per_ditrust_submit INTEGER NOT NULL DEFAULT 500  CHECK (per_ditrust_submit BETWEEN 10 AND 5000),
  per_ditrust_verify INTEGER NOT NULL DEFAULT 1000 CHECK (per_ditrust_verify BETWEEN 10 AND 10000),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         TEXT
);
COMMENT ON TABLE policy_jp.quota_settings IS
  '日本站每時段額度上限（單列 site=jp，同 public.quota_settings，2026-10-29，#769）。主控台經 public.console_admin_quota_settings_save 改；日本站 Edge Function 讀、模組級快取 60 秒，讀不到退回常數。';
INSERT INTO policy_jp.quota_settings (site, updated_by) VALUES ('jp', '初值') ON CONFLICT (site) DO NOTHING;

ALTER TABLE policy_jp.quota_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON policy_jp.quota_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON policy_jp.quota_settings TO service_role;

DROP TRIGGER IF EXISTS trg_quota_settings_touch ON policy_jp.quota_settings;
CREATE TRIGGER trg_quota_settings_touch BEFORE UPDATE ON policy_jp.quota_settings FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_touch_updated_at();

CREATE OR REPLACE FUNCTION policy_jp.quota_settings_audit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES (TG_TABLE_NAME, OLD.site, '*', to_jsonb(OLD), NULL, 'activity-audit');
    RETURN OLD;
  END IF;
  INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  VALUES (TG_TABLE_NAME, NEW.site, '*', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW), 'activity-audit');
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION policy_jp.quota_settings_audit IS '日本站額度設定表的審計：新增／修改／刪除各記一列 policy_jp.edit_history（record_id＝site、field=*、整列 jsonb）';
DROP TRIGGER IF EXISTS trg_quota_settings_audit ON policy_jp.quota_settings;
CREATE TRIGGER trg_quota_settings_audit AFTER INSERT OR UPDATE OR DELETE ON policy_jp.quota_settings FOR EACH ROW EXECUTE FUNCTION policy_jp.quota_settings_audit();
