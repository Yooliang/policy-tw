-- agy 加帳號流程（公開網頁登入驗證 VM 上的 agy；Yooliang/policy-console 的 agy-login 函式）
-- ============================================================
-- agy 的登入提示 60 秒就逾時，授權碼不能靠人轉傳。流程：維護者產一張票（ticket，只存 sha256）→ 開網頁按「產生連結」→
-- VM 上的 helper 領單、啟動 agy、回報授權網址 → 網頁貼授權碼 → helper 把碼送進 agy → 成功後 token 寫進 Secret Manager。
-- 不公開：RLS 開且 FORCE、不建任何 policy；只有 service_role（Edge Function）能讀寫。code 取走即清空，token 不進這張表。
CREATE TABLE IF NOT EXISTS agy_login_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_hash  TEXT NOT NULL UNIQUE,
  slot         TEXT NOT NULL CHECK (slot ~ '^[a-z][a-z0-9]{0,7}$'),
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','starting','claimed','url_ready','code_submitted','done','error','expired')),
  auth_url     TEXT,
  code         TEXT,
  vm           TEXT,
  result_email TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
COMMENT ON TABLE agy_login_requests IS 'agy 加帳號登入請求（票只存雜湊）；不公開，只有 service_role';
CREATE INDEX IF NOT EXISTS agy_login_requests_status_idx ON agy_login_requests (status, updated_at);

ALTER TABLE agy_login_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agy_login_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON agy_login_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON agy_login_requests TO service_role;

-- 原子領單：把最舊的 starting（未過期）改成 claimed，回傳 id；沒有就回 NULL。FOR UPDATE SKIP LOCKED 讓多台 VM 同時輪詢不會領到同一筆。
CREATE OR REPLACE FUNCTION agy_login_claim(p_vm TEXT) RETURNS UUID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE agy_login_requests r
     SET status = 'claimed', vm = left(p_vm, 100), updated_at = now()
   WHERE r.id = (
     SELECT q.id FROM agy_login_requests q
      WHERE q.status = 'starting' AND q.expires_at > now()
      ORDER BY q.updated_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
  RETURNING r.id INTO v_id;
  RETURN v_id;
END $$;

-- 原子取碼：只在 code_submitted 時回傳授權碼並同時清空（只能取一次）；否則回 NULL。
CREATE OR REPLACE FUNCTION agy_login_take_code(p_id UUID) RETURNS TEXT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_code TEXT;
BEGIN
  SELECT code INTO v_code FROM agy_login_requests
   WHERE id = p_id AND status = 'code_submitted' AND code IS NOT NULL
   FOR UPDATE;
  IF v_code IS NULL THEN RETURN NULL; END IF;
  UPDATE agy_login_requests SET code = NULL, updated_at = now() WHERE id = p_id;
  RETURN v_code;
END $$;

REVOKE ALL ON FUNCTION agy_login_claim(TEXT), agy_login_take_code(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION agy_login_claim(TEXT), agy_login_take_code(UUID) TO service_role;

-- 備援：不經函式手動建票（把 <ticket> 換成自己產的隨機字串，例如 openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n'；
-- 網頁網址 https://policy-console.web.app/#/add-account?t=<ticket>）。
--   INSERT INTO agy_login_requests (ticket_hash, slot, expires_at)
--   VALUES (encode(sha256('<ticket>'::bytea), 'hex'), 'a2', now() + interval '2 hours');
