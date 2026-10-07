-- Markdown 摘要的預產快取（維護者 2026-10-07：摘要定時預產、快取起來，不要每次被讀才算；docs/PLAN-markdown-views.md）
--
-- 內容：縣市（某屆）、分類、縣市×分類的 Markdown 內容、機器可讀索引（/data/<屆>/index.json），加上矩陣頁（/election/<屆>/matrix）
-- 要的縣市×分類筆數（path = '_matrix'）。
-- 誰寫：排程 workflow（.github/workflows/data-md.yml）每小時跑 scripts/build-data-md.ts，用 supabase CLI 的管理權杖套 SQL——
--       不是 anon、不是 service_role key；所以這張表只開 SELECT 給 anon，沒有任何寫入政策，應用端沒有寫入口。
--       一批的全部檔案一次換新：先把有變的列放進暫存表 data_md_staging（可以分好幾次送，量大也不怕單次請求太大），
--       最後用一個 SQL（隱含單一交易）把暫存表併進來、更新所有列的 generated_at、刪掉已不存在的列——Worker 不會撈到一半新舊混雜。
-- 誰讀：正見.tw 的 Worker（cloudflare/markdown.js）與矩陣頁（瀏覽器），都用 anon。
-- 人物的 Markdown 不在這裡（一萬六千位，Worker 讀時產生＋Cache API 快取）。
--
-- 欄位：
--   path          快取鍵：解碼後的站內路徑，例 /data/2026/台南市/交通建設.md、/election/2026/台南市.md、/data/2026/index.json；_matrix＝矩陣
--   body          本文（不含固定中繼資料與標題——那些由 Worker 讀出時依請求的網址與 generated_at 組）；index.json 與 _matrix 是 JSON 字串
--   meta          這份的標題、對應網頁、資料截至、範圍、前言（lib/md/format.ts 的 MdPage 去掉 body）
--   row_count     這份有幾筆政見（矩陣格子的數字就是它）
--   content_sha   內容雜湊（排程比對有沒有變；Worker 拿它組 ETag）
--   generated_at  這一批的產生時間，全部列同一個值（.md 的 generated_at 與 X-Data-Generated-At 用它）
--   changed_at    這份內容最後一次變動（Last-Modified 用它；內容沒變的列只換 generated_at）

CREATE TABLE IF NOT EXISTS data_md_cache (
  path         TEXT PRIMARY KEY,
  body         TEXT NOT NULL,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count    INTEGER NOT NULL DEFAULT 0,
  content_sha  TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE data_md_cache IS 'Markdown 摘要預產快取（scripts/build-data-md.ts 每小時重產，一批全部換新；Worker 與矩陣頁只讀）。公開可讀；沒有寫入政策，寫入只經排程 workflow 的管理權杖。';

ALTER TABLE data_md_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_md_cache_public_read ON data_md_cache;
CREATE POLICY data_md_cache_public_read ON data_md_cache FOR SELECT USING (true);

-- Supabase 的預設權限會把新表的全部權限給 anon／authenticated（靠 RLS 擋）：先收回，只留 SELECT，雙重保險
REVOKE ALL ON data_md_cache FROM anon, authenticated;
GRANT SELECT ON data_md_cache TO anon, authenticated;

-- 暫存表：排程把「有變的列」先分批放進來，最後一個 SQL 併進 data_md_cache。開 RLS 又不給任何政策＝anon 完全碰不到；
-- 寫入者是 CLI 管理權杖（postgres，繞過 RLS）。
CREATE TABLE IF NOT EXISTS data_md_staging (
  path         TEXT PRIMARY KEY,
  body         TEXT NOT NULL,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count    INTEGER NOT NULL DEFAULT 0,
  content_sha  TEXT NOT NULL
);

COMMENT ON TABLE data_md_staging IS 'data_md_cache 的暫存表（排程分批放入、一個交易併入後清空）。anon 不可讀寫。';
ALTER TABLE data_md_staging ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON data_md_staging FROM anon, authenticated;
