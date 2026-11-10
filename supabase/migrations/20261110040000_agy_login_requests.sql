-- agy 加帳號流程（公開網頁登入驗證 VM 上的 agy；Yooliang/policy-console 的 agy-login 函式）
-- ============================================================
-- agy 的登入提示 60 秒就逾時，授權碼不能靠人轉傳。流程：維護者產一張票（只存 sha256；可指定帳號格 slot，或不指定＝邀請連結、可多次使用）
-- → 開網頁按「產生連結」（每按一次在票底下建一筆登入請求）→ VM 上的 helper 領單、啟動 agy、回報授權網址 → 網頁貼授權碼 → helper 把碼送進 agy
-- → 成功後 token 寫進 Secret Manager，帳號格（cid）在這一步由後端決定。
-- 不公開：兩張表都 RLS 開且 FORCE、不建任何 policy；只有 service_role（Edge Function）能讀寫。code 取走即清空，token 不進這兩張表。

CREATE TABLE IF NOT EXISTS agy_login_tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_hash TEXT NOT NULL UNIQUE,
  slot        TEXT CHECK (slot IS NULL OR slot ~ '^[a-z][a-z0-9]{0,7}$'),  -- NULL＝邀請連結，登入成功時才決定
  max_uses    INT NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 50),
  use_count   INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
COMMENT ON TABLE agy_login_tickets IS 'agy 加帳號的票（只存雜湊；slot 為空＝邀請連結）；不公開，只有 service_role';

CREATE TABLE IF NOT EXISTS agy_login_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    UUID NOT NULL REFERENCES agy_login_tickets(id) ON DELETE CASCADE,
  slot         TEXT,  -- 後端在 token 步驟決定的帳號格（a1、a2…）
  status       TEXT NOT NULL DEFAULT 'starting' CHECK (status IN ('new','starting','claimed','url_ready','code_submitted','done','error','expired')),
  auth_url     TEXT,
  code         TEXT,
  vm           TEXT,
  result_email TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE agy_login_requests IS 'agy 加帳號的每一次登入嘗試；不公開，只有 service_role';
CREATE INDEX IF NOT EXISTS agy_login_requests_status_idx ON agy_login_requests (status, updated_at);
CREATE INDEX IF NOT EXISTS agy_login_requests_ticket_idx ON agy_login_requests (ticket_id);

ALTER TABLE agy_login_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE agy_login_tickets FORCE ROW LEVEL SECURITY;
ALTER TABLE agy_login_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agy_login_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON agy_login_tickets, agy_login_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON agy_login_tickets, agy_login_requests TO service_role;

-- 原子開始：鎖票，檢查未過期、未用完、同一張票沒有 p_stale_secs 秒內的進行中請求，然後建一筆 starting。
-- 回傳 jsonb：{"id": "..."} 或 {"reason": "expired"|"used_up"|"busy"}
CREATE OR REPLACE FUNCTION agy_login_start(p_ticket UUID, p_stale_secs INT DEFAULT 120) RETURNS JSONB
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE t agy_login_tickets; v_id UUID;
BEGIN
  SELECT * INTO t FROM agy_login_tickets WHERE id = p_ticket FOR UPDATE;
  IF NOT FOUND OR t.expires_at <= now() THEN RETURN jsonb_build_object('reason', 'expired'); END IF;
  IF t.use_count >= t.max_uses THEN RETURN jsonb_build_object('reason', 'used_up'); END IF;
  IF EXISTS (SELECT 1 FROM agy_login_requests r
              WHERE r.ticket_id = p_ticket AND r.status IN ('starting','claimed','url_ready','code_submitted')
                AND r.updated_at > now() - make_interval(secs => p_stale_secs)) THEN
    RETURN jsonb_build_object('reason', 'busy');
  END IF;
  INSERT INTO agy_login_requests (ticket_id) VALUES (p_ticket) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END $$;

-- 原子領單：把最舊的 starting（票未過期）改成 claimed，回傳 id；沒有就回 NULL。FOR UPDATE SKIP LOCKED 讓多台 VM 同時輪詢不會領到同一筆。
CREATE OR REPLACE FUNCTION agy_login_claim(p_vm TEXT) RETURNS UUID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE agy_login_requests r
     SET status = 'claimed', vm = left(p_vm, 100), updated_at = now()
   WHERE r.id = (
     SELECT q.id FROM agy_login_requests q
       JOIN agy_login_tickets t ON t.id = q.ticket_id
      WHERE q.status = 'starting' AND t.expires_at > now()
      ORDER BY q.updated_at
      LIMIT 1
      FOR UPDATE OF q SKIP LOCKED)
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

-- 原子完成：進行中的請求改 done、記帳號格與信箱、票的使用次數加一。回傳是否有更新到。
CREATE OR REPLACE FUNCTION agy_login_done(p_id UUID, p_slot TEXT, p_email TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ticket UUID;
BEGIN
  UPDATE agy_login_requests
     SET status = 'done', slot = p_slot, result_email = p_email, auth_url = NULL, code = NULL, error = NULL, updated_at = now()
   WHERE id = p_id AND status IN ('claimed','url_ready','code_submitted')
  RETURNING ticket_id INTO v_ticket;
  IF v_ticket IS NULL THEN RETURN FALSE; END IF;
  UPDATE agy_login_tickets SET use_count = use_count + 1 WHERE id = v_ticket;
  RETURN TRUE;
END $$;

REVOKE ALL ON FUNCTION agy_login_start(UUID, INT), agy_login_claim(TEXT), agy_login_take_code(UUID), agy_login_done(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION agy_login_start(UUID, INT), agy_login_claim(TEXT), agy_login_take_code(UUID), agy_login_done(UUID, TEXT, TEXT) TO service_role;

-- 備援：不經函式手動建票（把 <ticket> 換成自己產的隨機字串，例如 openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n'；
-- 網頁網址 https://policy-console.web.app/#/add-account?t=<ticket>；slot 填 NULL＝邀請連結）。
--   INSERT INTO agy_login_tickets (ticket_hash, slot, max_uses, expires_at)
--   VALUES (encode(sha256('<ticket>'::bytea), 'hex'), 'a2', 1, now() + interval '2 hours');
