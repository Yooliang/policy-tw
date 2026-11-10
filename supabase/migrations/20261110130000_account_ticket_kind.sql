-- 加帳號連結的票多一個「帳號種類」（Yooliang/policy-console 的 agy-login 函式；第 1 步：agy＋Claude 訂閱）
-- ============================================================
-- kind：agy（Google Antigravity，網頁登入）／claude_sub（Claude 訂閱 setup token，貼上即可）；api_* 之後的 PR 才會開放建票，CHECK 先放進來。
-- RLS 與權限不變（兩張表 RLS FORCE、無 policy，只有 service_role）。

ALTER TABLE agy_login_tickets
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'agy'
  CHECK (kind IN ('agy','claude_sub','api_anthropic','api_minimax','api_deepseek','api_xai'));

-- 原子占一個使用名額：票未過期且 use_count < max_uses 才加一，回傳是否占到（claude_sub 一次送出就完成，不走 agy 的請求子列）
CREATE OR REPLACE FUNCTION account_ticket_take(p_ticket UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE agy_login_tickets SET use_count = use_count + 1
   WHERE id = p_ticket AND expires_at > now() AND use_count < max_uses
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END $$;

-- 還一個名額（占了名額但寫 Secret Manager 失敗時）
CREATE OR REPLACE FUNCTION account_ticket_release(p_ticket UUID) RETURNS VOID
LANGUAGE sql SET search_path = public AS $$
  UPDATE agy_login_tickets SET use_count = greatest(use_count - 1, 0) WHERE id = p_ticket;
$$;

-- 同一張票的「忙碌」只算還活著的請求：claimed／url_ready／code_submitted 在 p_stale_secs 秒內有動靜，
-- 或 starting 才 20 秒內（沒有機器在線時死掉的請求不會卡住這張票）。
CREATE OR REPLACE FUNCTION agy_login_start(p_ticket UUID, p_stale_secs INT DEFAULT 120) RETURNS JSONB
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE t agy_login_tickets; v_id UUID;
BEGIN
  SELECT * INTO t FROM agy_login_tickets WHERE id = p_ticket FOR UPDATE;
  IF NOT FOUND OR t.expires_at <= now() THEN RETURN jsonb_build_object('reason', 'expired'); END IF;
  IF t.use_count >= t.max_uses THEN RETURN jsonb_build_object('reason', 'used_up'); END IF;
  IF EXISTS (SELECT 1 FROM agy_login_requests r
              WHERE r.ticket_id = p_ticket
                AND ((r.status IN ('claimed','url_ready','code_submitted') AND r.updated_at > now() - make_interval(secs => p_stale_secs))
                  OR (r.status = 'starting' AND r.updated_at > now() - interval '20 seconds'))) THEN
    RETURN jsonb_build_object('reason', 'busy');
  END IF;
  INSERT INTO agy_login_requests (ticket_id) VALUES (p_ticket) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END $$;

-- 領單只領 60 秒內建立的 starting（太舊的使用者早已看到「沒有機器在線」，領了也來不及登入）
CREATE OR REPLACE FUNCTION agy_login_claim(p_vm TEXT) RETURNS UUID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id UUID;
BEGIN
  UPDATE agy_login_requests r
     SET status = 'claimed', vm = left(p_vm, 100), updated_at = now()
   WHERE r.id = (
     SELECT q.id FROM agy_login_requests q
       JOIN agy_login_tickets t ON t.id = q.ticket_id
      WHERE q.status = 'starting' AND t.expires_at > now() AND q.created_at > now() - interval '60 seconds'
      ORDER BY q.updated_at
      LIMIT 1
      FOR UPDATE OF q SKIP LOCKED)
  RETURNING r.id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION account_ticket_take(UUID), account_ticket_release(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION account_ticket_take(UUID), account_ticket_release(UUID) TO service_role;
-- agy_login_start／claim 是 CREATE OR REPLACE，原有的 REVOKE／GRANT 保留
