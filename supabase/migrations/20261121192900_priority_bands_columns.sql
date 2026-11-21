-- 層級×種類帶狀優先的前置：只加欄位（2026-11-21，主 migration 20261121193000_priority_bands.sql 用）
-- ============================================================
-- 為什麼獨立一支：ADD COLUMN 會持 ACCESS EXCLUSIVE 鎖到交易結束；主 migration 有一次性重算約 3.1 萬列、在同一個交易裡，
-- /next 的觸發器讀 queue_settings、seed 最長 54 秒都會被它卡住。欄位先在這支用短交易加好（只加欄位＋預設值、沒有重算），主 migration 不再 ALTER。
-- 兩個欄位這支沒有任何函式讀；回滾不需要動它們。
SET LOCAL lock_timeout = '5s';

ALTER TABLE traffic_boost_settings ADD COLUMN IF NOT EXISTS per_user_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (per_user_seconds >= 0);
ALTER TABLE queue_settings ADD COLUMN IF NOT EXISTS priority_bands_applied_at TIMESTAMPTZ;
