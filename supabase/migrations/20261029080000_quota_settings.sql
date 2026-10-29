-- 額度的四個數字做成可在主控台調整的設定（2026-10-29 維護者同意的第一批「可調參數」，issue #769）
-- ============================================================
--
-- 單列設定表 quota_settings：正見（site='tw'）與日本站（site='jp'）各一列，主鍵 site。
--   per_ip_submit／per_ip_verify：每個來源網段每時段最多提交／驗證幾筆（匿名）
--   per_ditrust_submit／per_ditrust_verify：每個 DiTrust 帳號每時段最多提交／驗證幾筆
-- 初值＝現行常數（80／200／500／1000，與 contribute-handler／verify-handler 的常數由測試比對）。
-- CHECK 上下限：網段提交 10～2000、網段驗證 10～5000、DiTrust 提交 10～5000、DiTrust 驗證 10～10000。
--
-- 慣例與 queue_settings／traffic_boost_settings 相同：RLS 開、公開唯讀、service_role 寫、觸發器 touch updated_at，
-- 每次修改進 edit_history（這張表主鍵是 site 不是 id，所以審計函式另寫，record_id＝site）。
--
-- 寫入：console_admin_quota_settings_save——授權做法抄 console_admin_rule_save：函式內不驗人，
-- 只給 service_role（REVOKE 其他全部），由 Edge Function console-admin 驗 Firebase ID token、只收擁有者後才呼叫；
-- 理由必填（空白 RAISE），另在 edit_history 記一筆 field='reason'（agent_name＝console:<信箱>）。
-- 讀取：console_quota_settings()，anon 可執行，只回四個數字、updated_at、updated_by。
-- console_quota_now() 的上限欄位來自 quota_limits()；這支改成讀本表的 'tw' 那一列（讀不到列退回初值），
-- console_quota_now 本體與其他欄位不動。
--
-- 引用到的既有物件：edit_history(table_name, record_id, field, old_value, new_value, agent_name)、activity_touch_updated_at()、
-- auth.role()、quota_limits()／console_quota_now()（20261029060000、20261029070000）。

CREATE TABLE IF NOT EXISTS quota_settings (
  site               TEXT PRIMARY KEY CHECK (site IN ('tw', 'jp')),
  per_ip_submit      INTEGER NOT NULL DEFAULT 80   CHECK (per_ip_submit      BETWEEN 10 AND 2000),
  per_ip_verify      INTEGER NOT NULL DEFAULT 200  CHECK (per_ip_verify      BETWEEN 10 AND 5000),
  per_ditrust_submit INTEGER NOT NULL DEFAULT 500  CHECK (per_ditrust_submit BETWEEN 10 AND 5000),
  per_ditrust_verify INTEGER NOT NULL DEFAULT 1000 CHECK (per_ditrust_verify BETWEEN 10 AND 10000),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         TEXT
);
COMMENT ON TABLE quota_settings IS
  '每時段額度上限（正見 tw、日本站 jp 各一列，2026-10-29，#769）。主控台經 console_admin_quota_settings_save 改；Edge Function 讀這張表、模組級快取 60 秒，讀不到退回常數。';
INSERT INTO quota_settings (site, updated_by) VALUES ('tw', '初值'), ('jp', '初值') ON CONFLICT (site) DO NOTHING;

ALTER TABLE quota_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON quota_settings;
CREATE POLICY "Public read" ON quota_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON quota_settings;
CREATE POLICY "Service role write" ON quota_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP TRIGGER IF EXISTS trg_quota_settings_touch ON quota_settings;
CREATE TRIGGER trg_quota_settings_touch BEFORE UPDATE ON quota_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();

CREATE OR REPLACE FUNCTION quota_settings_audit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES (TG_TABLE_NAME, OLD.site, '*', to_jsonb(OLD), NULL, 'activity-audit');
    RETURN OLD;
  END IF;
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  VALUES (TG_TABLE_NAME, NEW.site, '*', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW), 'activity-audit');
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION quota_settings_audit IS '額度設定表的審計：新增／修改／刪除各記一列 edit_history（record_id＝site、field=*、整列 jsonb、agent_name=activity-audit）';
DROP TRIGGER IF EXISTS trg_quota_settings_audit ON quota_settings;
CREATE TRIGGER trg_quota_settings_audit AFTER INSERT OR UPDATE OR DELETE ON quota_settings FOR EACH ROW EXECUTE FUNCTION quota_settings_audit();

-- ------------------------------------------------------------
-- 寫入 RPC（授權照 console_admin_rule_save：只給 service_role，擁有者由 console-admin 驗過才呼叫）
-- p_set_by 是第 7 個、有預設值的參數（誰改的，記進 updated_by 與 edit_history）；前六個參數與需求簽名一致。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION console_admin_quota_settings_save(
  p_site TEXT, p_per_ip_submit INT, p_per_ip_verify INT, p_per_ditrust_submit INT, p_per_ditrust_verify INT,
  p_reason TEXT, p_set_by TEXT DEFAULT NULL
) RETURNS quota_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row quota_settings;
  v_who TEXT := 'console:' || COALESCE(NULLIF(btrim(p_set_by), ''), '未知');
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason, E' \t\r\n')) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  IF p_site IS NULL OR p_site NOT IN ('tw', 'jp') THEN
    RAISE EXCEPTION 'site 只能是 tw 或 jp';
  END IF;
  IF p_per_ip_submit IS NULL OR p_per_ip_verify IS NULL OR p_per_ditrust_submit IS NULL OR p_per_ditrust_verify IS NULL THEN
    RAISE EXCEPTION '四個額度都要給';
  END IF;

  UPDATE quota_settings
     SET per_ip_submit = p_per_ip_submit, per_ip_verify = p_per_ip_verify,
         per_ditrust_submit = p_per_ditrust_submit, per_ditrust_verify = p_per_ditrust_verify,
         updated_by = v_who
   WHERE site = p_site
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION '找不到 % 站的額度設定', p_site;
  END IF;

  -- 改前改後由觸發器 quota_settings_audit 記；這裡補上「誰、為什麼」
  INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name)
  VALUES ('quota_settings', p_site, 'reason', NULL, to_jsonb(btrim(p_reason, E' \t\r\n')), v_who);

  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION console_admin_quota_settings_save(TEXT, INT, INT, INT, INT, TEXT, TEXT) IS
  '主控台改額度（2026-10-29，#769）：四個數字一起給、理由必填；CHECK 擋超出上下限；改前改後進 edit_history。只給 service_role（console-admin 驗過擁有者才呼叫）。';
REVOKE ALL ON FUNCTION console_admin_quota_settings_save(TEXT, INT, INT, INT, INT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_admin_quota_settings_save(TEXT, INT, INT, INT, INT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION console_admin_quota_settings_save(TEXT, INT, INT, INT, INT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION console_admin_quota_settings_save(TEXT, INT, INT, INT, INT, TEXT, TEXT) TO service_role;

-- ------------------------------------------------------------
-- 讀取 RPC：只回聚合設定值＋updated_at／updated_by 顯示名
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION console_quota_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(site, jsonb_build_object(
           'per_ip_submit', per_ip_submit, 'per_ip_verify', per_ip_verify,
           'per_ditrust_submit', per_ditrust_submit, 'per_ditrust_verify', per_ditrust_verify,
           'updated_at', updated_at, 'updated_by', updated_by)), '{}'::jsonb)
    FROM quota_settings
$$;
COMMENT ON FUNCTION console_quota_settings IS '主控台讀額度設定：{tw:{…}, jp:{…}}，只有四個數字與 updated_at／updated_by。2026-10-29';
REVOKE ALL ON FUNCTION console_quota_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_quota_settings() TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- console_quota_now() 的上限欄位：quota_limits() 改讀本表（正見那一列），讀不到列退回初值；鍵名與型別不變
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION quota_limits() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'per_ip_submit_limit',      COALESCE((SELECT per_ip_submit      FROM quota_settings WHERE site = 'tw'), 80),
    'per_ip_verify_limit',      COALESCE((SELECT per_ip_verify      FROM quota_settings WHERE site = 'tw'), 200),
    'per_ditrust_submit_limit', COALESCE((SELECT per_ditrust_submit FROM quota_settings WHERE site = 'tw'), 500),
    'per_ditrust_verify_limit', COALESCE((SELECT per_ditrust_verify FROM quota_settings WHERE site = 'tw'), 1000))
$$;
COMMENT ON FUNCTION quota_limits IS '每時段額度上限（正見）：讀 quota_settings 的 tw 列，沒有列退回初值 80／200／500／1000。2026-10-29';
