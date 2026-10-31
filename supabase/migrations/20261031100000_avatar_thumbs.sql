-- 頭像縮圖（2026-10-31，維護者核准方案 B；決策紀錄見 policy-ops docs/decisions/2026-10-31-頭像縮圖走縮圖表與公開儲存桶.md）
-- 背景：參選人頭像大多直接熱連結外部原圖（ws.moi.gov.tw 單張最大 8.8 MB），手機首屏 3.6–4.2 MB。
-- 做法：aegis 上的定時工作把原圖縮成 160／330／660 寬 WebP，傳到公開儲存桶 avatar-thumbs（路徑用原圖網址的 sha256），
--       並把結果寫進這張對照表；前端查得到（status='ok'）就用縮圖，查不到或載入失敗退回原圖。
-- 本 migration 不寫任何人物資料、不動 politicians.avatar_url。

-- ① 對照表 ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avatar_thumbs (
  src_url     TEXT PRIMARY KEY,                              -- 原圖網址（= politicians.avatar_url 的值）
  sha256      TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), -- 原圖網址的 sha256，儲存桶裡的資料夾名
  w160        TEXT,                                          -- 各尺寸在儲存桶裡的路徑（<sha256>/160.webp）；沒做（原圖比它小）就是 NULL
  w330        TEXT,
  w660        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'ok', 'failed', 'skipped')),  -- skipped＝縮完沒比原圖小，不存、永遠用原圖
  last_error  TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at TIMESTAMPTZ NOT NULL DEFAULT now(),            -- failed 的下次重試時間（退避）
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE avatar_thumbs IS
  '頭像縮圖對照：原圖網址 → 儲存桶 avatar-thumbs 裡的 160／330／660 寬 WebP。匿名只能讀 status=ok 的列，寫入只限 service role（aegis 的定時工作）。';

CREATE INDEX IF NOT EXISTS avatar_thumbs_retry_idx ON avatar_thumbs (next_try_at) WHERE status IN ('pending', 'failed');

ALTER TABLE avatar_thumbs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avatar_thumbs_public_read_ok ON avatar_thumbs;
CREATE POLICY avatar_thumbs_public_read_ok ON avatar_thumbs FOR SELECT TO anon, authenticated USING (status = 'ok');
-- 不建任何 INSERT／UPDATE／DELETE policy：只有 service role（繞過 RLS）能寫。
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON avatar_thumbs FROM anon, authenticated;

-- ② 前端批次查詢：一次帶一批網址，回有縮圖的那幾列（請求數 = 頁面上的頭像數 / 300） ---------------
CREATE OR REPLACE FUNCTION avatar_thumbs_lookup(p_urls TEXT[])
RETURNS TABLE (src_url TEXT, w160 TEXT, w330 TEXT, w660 TEXT)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT t.src_url, t.w160, t.w330, t.w660
    FROM avatar_thumbs t
   WHERE t.status = 'ok'
     AND t.src_url = ANY (p_urls[1:500]);
$$;
COMMENT ON FUNCTION avatar_thumbs_lookup IS '前端批次查頭像縮圖（security invoker，受 RLS 限制只回 status=ok；最多 500 個網址）。';
GRANT EXECUTE ON FUNCTION avatar_thumbs_lookup(TEXT[]) TO anon, authenticated;

-- ③ 縮圖工作的待辦清單：politicians.avatar_url 裡還沒縮好、或失敗到了重試時間的網址 -----------------
CREATE OR REPLACE FUNCTION avatar_thumbs_pending(p_limit INTEGER DEFAULT 200)
RETURNS TABLE (src_url TEXT, attempts INTEGER)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT u.url, COALESCE(t.attempts, 0)
    FROM (SELECT DISTINCT p.avatar_url AS url FROM politicians p
           WHERE p.avatar_url ~ '^https?://' AND NOT is_placeholder_avatar(p.avatar_url)) u
    LEFT JOIN avatar_thumbs t ON t.src_url = u.url
   WHERE t.src_url IS NULL
      OR (t.status IN ('pending', 'failed') AND t.next_try_at <= now())
   ORDER BY (t.src_url IS NULL) DESC, t.next_try_at NULLS FIRST, u.url
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
$$;
COMMENT ON FUNCTION avatar_thumbs_pending IS '縮圖定時工作用：還沒縮好的頭像網址（沒有列的先、失敗退避到期的後）。只給 service role。';
REVOKE ALL ON FUNCTION avatar_thumbs_pending(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION avatar_thumbs_pending(INTEGER) TO service_role;

-- ④ 公開儲存桶（只讀公開；寫入只有 service role，不建 storage.objects 的寫入 policy） ---------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatar-thumbs', 'avatar-thumbs', true, 2097152, ARRAY['image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = true, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
