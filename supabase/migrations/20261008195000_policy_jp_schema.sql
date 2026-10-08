-- 日本站（政策の系譜）的資料放在同一個 Supabase、獨立 schema policy_jp（維護者 2026-10-08 裁示）。
-- 這支只建空的 schema 與基本權限，讓之後的 PostgREST「Exposed schemas」加上 policy_jp 時不會因 schema 不存在而載入失敗。
-- 表、函式、RLS 由日本站（P-日本）之後的 PR 建立；每張表要自己開 RLS 並明確 GRANT，這裡不給 anon／authenticated 任何表的預設權限。
-- ditrust schema 不受影響、也絕不能被開放。
CREATE SCHEMA IF NOT EXISTS policy_jp;
COMMENT ON SCHEMA policy_jp IS '日本站（政策の系譜）資料。與正見 public 分開；migration 放在 policy-tw repo，檔名帶 _jp_。';

GRANT USAGE ON SCHEMA policy_jp TO anon, authenticated, service_role;

-- service_role 對之後建立的物件有完整權限（Edge Function 用）；anon／authenticated 一律逐表、逐函式明確授權
ALTER DEFAULT PRIVILEGES IN SCHEMA policy_jp GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA policy_jp GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA policy_jp GRANT EXECUTE ON FUNCTIONS TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA policy_jp REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
