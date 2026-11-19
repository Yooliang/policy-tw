-- 收緊預設權限（維護者 2026-11-20 同意）：PostgREST／Edge Function／前端的路徑用不到 TRUNCATE、TRIGGER、REFERENCES，
-- 比照最小權限原則，public 的表與檢視不再把這三種權限給 anon／authenticated。
-- SELECT／INSERT／UPDATE／DELETE 與 RLS policy 不動；service_role、postgres 不動。
--
-- 盤點（唯讀查正式庫）：public 的表 owner 全是 postgres；函式內唯一的 TRUNCATE 是各函式自己建的暫存表（owner 即呼叫者，不需要這項授權）。
--
-- 第二句改的是「之後新建的表」的預設權限（owner postgres）。migration 建的表 owner 都是 postgres，所以這句夠用；
-- owner 為 supabase_admin 的那組預設權限以 postgres 身分改不到，不在這支範圍。
--
-- 可重跑：REVOKE 本來就冪等。
--
-- 回滾（要手動寫一支新的 migration，不是退這支）：
--   GRANT TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE, TRIGGER, REFERENCES ON TABLES TO anon, authenticated;

REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM anon, authenticated;
