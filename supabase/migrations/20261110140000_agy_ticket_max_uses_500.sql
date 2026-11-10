-- 加帳號連結（agy_login_tickets）可用次數上限 50 → 500（2026-11-10 小良：家人邀請連結要 200 次）
ALTER TABLE agy_login_tickets DROP CONSTRAINT IF EXISTS agy_login_tickets_max_uses_check;
ALTER TABLE agy_login_tickets ADD CONSTRAINT agy_login_tickets_max_uses_check CHECK (max_uses BETWEEN 1 AND 500);
