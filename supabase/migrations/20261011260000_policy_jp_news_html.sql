-- 日本站の新聞線：来源は網頁だけ、RSS は一律受け付けない（維護者 2026-10-13「Rss 一律不收 只收網頁」）。工作単 Yooliang/policy-ops#95
--
-- 20261011250000 で入れた来源（NHK 3 本・Yahoo 2 本）は全部 RSS だった。この支で：
--   1. rss／atom の来源を全部止める（行は残す：取り込んだ記事 news_items と線索の証拠が参照している）
--   2. format に 'html'（ニュースの一覧ページ）を足し、「enabled なのは html だけ」を CHECK で固定する。今後 RSS を入れても動かせない
--   3. link_pattern（記事 URL が合うべき正規表現）を足す。html の来源は必須。jp-news-fetch は一覧ページの <a href> のうち
--      これに合うものだけを記事として拾う（_shared/jp/news-html.ts）
-- 網頁の来源の種子はこの支では入れない：雲端からは外の網站に繋がらず、一覧ページの URL・HTML の形・robots.txt を確かめられないため。
-- 確かめた来源は別の migration で INSERT（format='html'、link_pattern 付き）。
-- 正式寫入なし（UPDATE は policy_jp.news_sources の enabled だけ）。public／ditrust に触れない。

UPDATE policy_jp.news_sources SET enabled = FALSE WHERE format <> 'html' AND enabled;

ALTER TABLE policy_jp.news_sources DROP CONSTRAINT IF EXISTS news_sources_format_check;
ALTER TABLE policy_jp.news_sources ADD CONSTRAINT news_sources_format_check CHECK (format IN ('html', 'rss', 'atom'));
ALTER TABLE policy_jp.news_sources ADD COLUMN IF NOT EXISTS link_pattern TEXT;
ALTER TABLE policy_jp.news_sources DROP CONSTRAINT IF EXISTS news_sources_html_only;
ALTER TABLE policy_jp.news_sources ADD CONSTRAINT news_sources_html_only CHECK (format = 'html' OR NOT enabled);
ALTER TABLE policy_jp.news_sources DROP CONSTRAINT IF EXISTS news_sources_html_pattern;
ALTER TABLE policy_jp.news_sources ADD CONSTRAINT news_sources_html_pattern CHECK (format <> 'html' OR (link_pattern IS NOT NULL AND btrim(link_pattern) <> ''));

COMMENT ON TABLE policy_jp.news_sources IS '日本のニュースの一覧ページ（網頁、新聞線の来源）。jp-news-fetch が毎時 enabled のものを取る；同じ来源は 30 分以内に取っていたら飛ばす。RSS／Atom は受け付けない（維護者 2026-10-13；rss／atom の行は止めたまま残る、CHECK news_sources_html_only）。追加・停止は migration。正見 news_sources の日本版';
COMMENT ON COLUMN policy_jp.news_sources.feed_url IS '一覧ページの URL（https）。列名は正見に合わせて feed_url のまま';
COMMENT ON COLUMN policy_jp.news_sources.link_pattern IS '記事の URL が合うべき正規表現（JavaScript の RegExp、絶対 URL に対して test）。format=html では必須';

-- 自我檢查
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM policy_jp.news_sources WHERE enabled AND format <> 'html') THEN
    RAISE EXCEPTION 'news_sources: RSS／Atom の来源が enabled のまま';
  END IF;
END $$;
