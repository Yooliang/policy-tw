-- 網站請求／公民提問的固定時段插隊，從每 6 小時（台北 00:00、06:00、12:00、18:00）改成每小時（維護者 2026-10-27）
-- 原因：網站請求一天新進約 1,200 件、關掉的遠少於新進（10/27 開著 773 件），每天只拉回最前四次，來不及消化。
-- 只改常數 visitor_front_slot_hours() 6 → 1：時段判斷（visitor_front_slot_start）與每 10 分鐘的 seed 都讀它，每個整點的前 20 分鐘各拉一次。
-- 不動日本站（policy_jp 自己有一份常數）。
CREATE OR REPLACE FUNCTION visitor_front_slot_hours() RETURNS INTEGER LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;
COMMENT ON FUNCTION visitor_front_slot_hours IS '網站請求／公民提問固定時段插隊：每幾小時一個時段（台北每個整點起）。2026-10-27 由 6 改 1';
COMMENT ON FUNCTION visitor_front_slot_start IS '現在若在固定插隊時段內（台北每小時的前 20 分鐘）回本時段開始時間，否則 NULL。2026-10-27';
