-- 新聞追蹤改成逐則收錄（小良哥 2026-09-29 核准；第一步：來源表＋逐則收錄＋每日統計）
--
-- 原本的 news_sweep（20260912000030）：每 6 小時一件任務叫代理讀整份中央社 RSS。兩週 59 件，交出的全是「新政見」、
-- 政見進度 0 筆；一半的輪次什麼都沒交也沒留紀錄——看過哪些新聞、漏了哪些，都答不出來。
-- 改成：每則新聞存一列（news_items），知道看過哪些、覆蓋率量得到；下一步由 Jev 逐則初篩，
-- 只把「跟某人某條政見的進度有關」或「某人提出新承諾」的派給代理，任務直接附新聞網址與對應政見。
--
-- 這一支只做收錄與統計，不派工：初篩與派工在下一支 migration（system-one?action=news_screen）。
-- 舊的 news_sweep_feeds／news_sweep_refresh_tasks 先不動，新流程上線後再停。

CREATE TABLE IF NOT EXISTS news_sources (
  id              BIGSERIAL PRIMARY KEY,
  label           TEXT NOT NULL,
  -- media：媒體；government：中央與縣市政府新聞稿；party：政黨新聞稿（這次不收，見種子資料下方）
  kind            TEXT NOT NULL CHECK (kind IN ('media', 'government', 'party')),
  feed_url        TEXT NOT NULL UNIQUE,
  format          TEXT NOT NULL CHECK (format IN ('rss', 'atom', 'sitemap_news')),
  -- 全類別的來源（sitemap、公視）網址要包含這段才收，例如 TVBS 的 '/politics/'；NULL＝全收、交給初篩
  path_filter     TEXT,
  -- 縣市政府填縣市（初篩時可當線索）；中央與媒體 NULL
  region          TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_fetched_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE news_sources IS '新聞來源（RSS／Atom／Google 新聞 sitemap）；news-fetch 每小時抓 enabled 的，逐則寫進 news_items。同一來源 30 分鐘內抓過就跳過。';
COMMENT ON COLUMN news_sources.last_error IS '上一次抓取的錯誤（逾時、HTTP 狀態、格式認不得）；成功就清成 NULL';

CREATE TABLE IF NOT EXISTS news_items (
  id           BIGSERIAL PRIMARY KEY,
  source_id    BIGINT NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  url          TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT,
  -- 來源給的發布時間；讀不懂就 NULL（不猜）
  published_at TIMESTAMPTZ,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 初篩（下一步）：screened_at 有值＝判過了；screen 存判定（result：progress／new_pledge／unrelated／no_name…）
  screened_at  TIMESTAMPTZ,
  screen       JSONB,
  -- 初篩判定有關時開的任務（contribution_tasks.id）
  task_id      UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE news_items IS '逐則收錄的新聞；url 唯一，重複抓到同一則不會多一列。screened_at／screen／task_id 由 Jev 初篩填。';
-- 初篩撿「還沒判過」的，依發布時間
CREATE INDEX IF NOT EXISTS idx_news_items_unscreened ON news_items (published_at) WHERE screened_at IS NULL;
-- 每日統計依收錄時間分天
CREATE INDEX IF NOT EXISTS idx_news_items_fetched ON news_items (fetched_at);
CREATE INDEX IF NOT EXISTS idx_news_items_task ON news_items (task_id) WHERE task_id IS NOT NULL;

-- 照 news_sweep_feeds：公開讀、只有 service role 寫
ALTER TABLE news_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON news_sources;
CREATE POLICY "Public read" ON news_sources FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON news_sources;
CREATE POLICY "Service role write" ON news_sources FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

ALTER TABLE news_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON news_items;
CREATE POLICY "Public read" ON news_items FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON news_items;
CREATE POLICY "Service role write" ON news_items FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 種子資料：2026-09-29 逐一實測過（curl 與 Deno fetch 各一次，Edge Function 跑的是 Deno 那套 TLS）。
-- 全部回 200、格式對得上；只有金門縣抓不到（見最後一列）。
--
-- 實測時順手記下的特性（parser 的測試照這些寫，見 _shared/news-feed.test.ts）：
--   - TVBS sitemap 全類別 600 多則，/politics/ 開頭的約 70 則 → path_filter '/politics/'
--   - 三立 sitemap 500 則全是 /news/<編號>，網址看不出類別、genres 欄一律是 PressRelease → 不設 path_filter，靠初篩
--   - 風傳媒 sitemap 有 /article/（新聞）與 /lifestyle/（生活）兩種 → path_filter '/article/'
--   - 公視是 Atom、全類別 → 不設 path_filter，靠初篩
--   - 高雄市政府那支要 19～25 秒才回，news-fetch 給 30 秒
--   - 新竹縣最新一則是 2026-08-07、基隆市 09-23、澎湖縣 09-24：格式都對，只是更新慢，照樣開著
--   - 南投縣是民國日期（115-09-28）、彰化縣是中文月份（「28 九月 2026」），parser 都認得
-- ------------------------------------------------------------
INSERT INTO news_sources (label, kind, feed_url, format, path_filter, region, enabled) VALUES
  ('中央社 政治',    'media', 'https://feeds.feedburner.com/rsscna/politics',          'rss',          NULL,          NULL, TRUE),
  ('自由時報 政治',  'media', 'https://news.ltn.com.tw/rss/politics.xml',              'rss',          NULL,          NULL, TRUE),
  ('Yahoo新聞 政治', 'media', 'https://tw.news.yahoo.com/rss/politics',                'rss',          NULL,          NULL, TRUE),
  ('公視新聞網',     'media', 'https://news.pts.org.tw/xml/newsfeed.xml',              'atom',         NULL,          NULL, TRUE),
  ('TVBS 政治',      'media', 'https://news.tvbs.com.tw/sitemap/news-sitemap',         'sitemap_news', '/politics/',  NULL, TRUE),
  ('三立新聞網',     'media', 'https://www.setn.com/sitemapGoogleNews.xml',            'sitemap_news', NULL,          NULL, TRUE),
  ('風傳媒',         'media', 'https://www.storm.mg/sitemaps/1/article-news-1.xml',    'sitemap_news', '/article/',   NULL, TRUE),
  ('行政院 部會新聞', 'government', 'https://www.ey.gov.tw/RSS_Content.aspx?ModuleType=4', 'rss', NULL, NULL, TRUE),
  ('總統府 新聞',    'government', 'https://www.president.gov.tw/RSSNEWS.aspx',         'rss', NULL, NULL, TRUE),
  ('臺北市政府',     'government', 'https://www.gov.taipei/OpenData.aspx?SN=7DEC7150E6BAD606',  'rss', NULL, '台北市', TRUE),
  ('臺中市政府',     'government', 'https://www.taichung.gov.tw/10179/564770/rss?nodeId=9962',  'rss', NULL, '台中市', TRUE),
  ('臺南市政府',     'government', 'https://www.tainan.gov.tw/OpenData.aspx?SN=24474215983F6554', 'rss', NULL, '台南市', TRUE),
  ('高雄市政府',     'government', 'https://www.kcg.gov.tw/OpenData.aspx?SN=FB01D469347C76A7',  'rss', NULL, '高雄市', TRUE),
  ('基隆市政府',     'government', 'https://www.klcg.gov.tw/tw/klcg1/3168-RSS.html',            'rss', NULL, '基隆市', TRUE),
  ('新竹市政府',     'government', 'https://www.hccg.gov.tw/hccg/app/rss/News',                 'rss', NULL, '新竹市', TRUE),
  ('新竹縣政府',     'government', 'https://www.hsinchu.gov.tw/OpenData.aspx?SN=60478A9754AF2385', 'rss', NULL, '新竹縣', TRUE),
  ('彰化縣政府',     'government', 'https://www.chcg.gov.tw/ch2/rssnews2b.aspx',                'rss', NULL, '彰化縣', TRUE),
  ('南投縣政府',     'government', 'https://www.nantou.gov.tw/big5/news2rss.php',               'rss', NULL, '南投縣', TRUE),
  ('嘉義縣政府',     'government', 'https://www.cyhg.gov.tw/OpenData.aspx?SN=B2A19E946103A4B9', 'rss', NULL, '嘉義縣', TRUE),
  ('屏東縣政府',     'government', 'https://www.pthg.gov.tw/Rss_News.aspx?n=EC690F93E81FF22D',  'rss', NULL, '屏東縣', TRUE),
  ('臺東縣政府',     'government', 'https://www.taitung.gov.tw/OpenData.aspx?SN=942D31CF1EDFE67D', 'rss', NULL, '台東縣', TRUE),
  ('澎湖縣政府',     'government', 'https://www.penghu.gov.tw/NwsRss?websiteid=ch&menuid=10088', 'rss', NULL, '澎湖縣', TRUE),
  -- 金門縣：curl 回憑證錯誤（exit 60，憑證鏈不完整）、Deno fetch 回 "fetch failed"，Edge Function 抓不到。
  -- 先關著；對方修好憑證後把 enabled 打開就好，不用改程式
  ('金門縣政府',     'government', 'https://www.kinmen.gov.tw/OpenData.aspx?SN=20C1A3DAF6A74FCE', 'rss', NULL, '金門縣', FALSE)
ON CONFLICT (feed_url) DO NOTHING;

-- 政黨新聞稿這次不收：實測只有國民黨抓得到，單獨收一個政黨的新聞稿會讓初篩與派工偏向那一黨的人。
-- 民進黨、民眾黨的來源找到之後三黨一起開（kind='party'）。

-- ------------------------------------------------------------
-- 每日統計（統計頁「新聞追蹤」）：近 p_days 天，每天（台北時間，依收錄時間分天）一列。
--   fetched          收了幾則
--   screened         初篩判過幾則
--   related_progress 判定跟某條既有政見的進度有關
--   related_new      判定是某人的新承諾
--   tasks            派出幾件任務
--   submissions      那些任務收到幾筆交件（含 no_change）
--   applied          其中上線幾筆（不含 no_change：它沒有新資料可以上線）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION news_daily_stats(p_days INTEGER DEFAULT 7)
RETURNS TABLE (day DATE, fetched BIGINT, screened BIGINT, related_progress BIGINT, related_new BIGINT, tasks BIGINT, submissions BIGINT, applied BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH p AS (SELECT LEAST(GREATEST(COALESCE(p_days, 7), 1), 90) AS d),
  days AS (
    SELECT generate_series((now() AT TIME ZONE 'Asia/Taipei')::DATE - ((SELECT d FROM p) - 1), (now() AT TIME ZONE 'Asia/Taipei')::DATE, INTERVAL '1 day')::DATE AS day
  ),
  items AS (
    SELECT (n.fetched_at AT TIME ZONE 'Asia/Taipei')::DATE AS day, n.screened_at, n.screen, n.task_id
      FROM news_items n
     WHERE n.fetched_at >= ((now() AT TIME ZONE 'Asia/Taipei')::DATE - ((SELECT d FROM p) - 1))::TIMESTAMP AT TIME ZONE 'Asia/Taipei'
  ),
  per_day AS (
    SELECT i.day,
           COUNT(*) AS fetched,
           COUNT(i.screened_at) AS screened,
           COUNT(*) FILTER (WHERE i.screen->>'result' = 'progress') AS related_progress,
           COUNT(*) FILTER (WHERE i.screen->>'result' = 'new_pledge') AS related_new,
           COUNT(i.task_id) AS tasks
      FROM items i GROUP BY i.day
  ),
  subs AS (
    SELECT i.day,
           COUNT(c.id) AS submissions,
           COUNT(c.id) FILTER (WHERE c.status = 'applied' AND c.contribution_type <> 'no_change') AS applied
      FROM items i JOIN contributions c ON c.task_id = i.task_id::TEXT
     WHERE i.task_id IS NOT NULL
     GROUP BY i.day
  )
  SELECT days.day,
         COALESCE(per_day.fetched, 0), COALESCE(per_day.screened, 0),
         COALESCE(per_day.related_progress, 0), COALESCE(per_day.related_new, 0),
         COALESCE(per_day.tasks, 0), COALESCE(subs.submissions, 0), COALESCE(subs.applied, 0)
    FROM days LEFT JOIN per_day ON per_day.day = days.day LEFT JOIN subs ON subs.day = days.day
   ORDER BY days.day DESC
$$;
GRANT EXECUTE ON FUNCTION news_daily_stats(INTEGER) TO anon, authenticated;
COMMENT ON FUNCTION news_daily_stats IS '統計頁「新聞追蹤」：近 p_days 天（台北日期，依收錄時間），每天收錄／初篩／有關（進度、新政見）／派出任務／交件／上線';

-- ------------------------------------------------------------
-- 排程：每小時第 5 分收一次（RSS 只留最新 20～50 則，12 小時看一次會漏）。
-- news-fetch 不驗 JWT，同一來源 30 分鐘內抓過就跳過，外人重複打也只會空轉。
-- ------------------------------------------------------------
SELECT cron.unschedule('news-fetch-hourly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'news-fetch-hourly');
SELECT cron.schedule('news-fetch-hourly', '5 * * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/news-fetch',
                       headers := '{"Content-Type": "application/json"}'::jsonb,
                       body := '{}'::jsonb, timeout_milliseconds := 150000);
$$);
