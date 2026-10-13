-- 日本站の新聞線：NHK の RSS を NHK ONE の新しい URL に換える（工作単 Yooliang/policy-ops#95）
--
-- 10-13 の初回 cron で、20261011250000 の NHK 3 本（www3.nhk.or.jp/rss/news/catN.xml）は 200 を返すが最新が 2026-08-08、
-- 全部 max_age_days を超えて 0 件だった（#619 の診断、主線が news_sources.last_error で確認）。NHK ONE への移行で旧 RSS は更新停止。
-- 新しい URL は https://news.web.nhk/n-data/conf/na/rss/catN.xml（番号は同じ）。10-13 08:30 UTC に本機工作串が実測：
--   cat0 主要 RSS 2.0・7 則・最新 2026-10-13 16:55 +0900／cat1 社会 122 則／cat4 政治 75 則、いずれも当日の記事。
--   各則の link は記事ページ https://news.web.nhk/newsweb/na/nd-…（一般の UA で 200・本文あり）＝ RSS で記事を見つけ、出典は記事ページ。
--   robots.txt は AI クローラ（GPTBot、ClaudeBot など）だけを Disallow。jp-news-fetch の UA（policy-jp-news/1.0）はその名簿に入らない。
--   news.web.nhk/rss/news/catN.xml（n-data なし）は 401 missing_token なので使わない。
-- 旧 3 本は止めて残す（取り込んだ記事・線索の証拠が参照する可能性）。Yahoo は robots.txt の理由で止めたまま。

UPDATE policy_jp.news_sources SET enabled = FALSE
 WHERE feed_url IN ('https://www3.nhk.or.jp/rss/news/cat0.xml', 'https://www3.nhk.or.jp/rss/news/cat1.xml', 'https://www3.nhk.or.jp/rss/news/cat4.xml');

INSERT INTO policy_jp.news_sources (label, kind, feed_url, format, enabled) VALUES
  ('NHK 主要ニュース', 'media', 'https://news.web.nhk/n-data/conf/na/rss/cat0.xml', 'rss', TRUE),
  ('NHK 社会', 'media', 'https://news.web.nhk/n-data/conf/na/rss/cat1.xml', 'rss', TRUE),
  ('NHK 政治', 'media', 'https://news.web.nhk/n-data/conf/na/rss/cat4.xml', 'rss', TRUE)
ON CONFLICT (feed_url) DO UPDATE SET enabled = TRUE, label = EXCLUDED.label;

-- 自我檢查
DO $$
BEGIN
  IF (SELECT count(*) FROM policy_jp.news_sources WHERE enabled AND feed_url LIKE 'https://news.web.nhk/n-data/conf/na/rss/%') <> 3 THEN
    RAISE EXCEPTION 'news_sources: NHK ONE の 3 本が enabled になっていない';
  END IF;
  IF EXISTS (SELECT 1 FROM policy_jp.news_sources WHERE enabled AND feed_url LIKE 'https://www3.nhk.or.jp/rss/%') THEN
    RAISE EXCEPTION 'news_sources: 更新停止した旧 NHK RSS が enabled のまま';
  END IF;
END $$;
