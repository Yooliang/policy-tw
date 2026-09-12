-- 定時掃媒體 RSS：讓「有新政見被報導」這件事自己長成任務。
--
-- 背景：目前所有任務都是「已知的人缺什麼」。沒有任何機制會發現「有人講了新政見」。
-- FB 那條路走不通（robots.txt 對非 Googlebot 全禁、搜尋頁 404、粉專首頁抓不到貼文
-- 連結；Google Custom Search JSON API 已不對新客戶開放）。媒體自己的 RSS 是唯一
-- 不需要金鑰、可自動、而且來源等級是媒體（2 票）而非社群（8 票）的入口。
--
-- 刻意不新增 contribution_type。這樣就不用同步 CONTRIBUTION_TYPES／DB CHECK／
-- 風險分級／SQL 門檻／applyXxx／摘要六個地方——今天已經在這件事上漏過三次
-- （removal 的 CHECK、roster_check 的 CONTRIBUTION_TYPES、roster_check 的門檻）。
-- 改用既有的手動任務池：排程建一筆 contribution_tasks，代理照現有規則交 policy／
-- policy_progress，沒東西可交就用 no_change（對非 auto: 任務會直接關掉那筆任務）。
--
-- 一次只開一個來源。發到社群後待驗證已經 70 筆消化不掉，一次開滿會把佇列灌爆；
-- 要加來源把 enabled 打開就好。

CREATE TABLE IF NOT EXISTS news_sweep_feeds (
  id            BIGSERIAL PRIMARY KEY,
  label         TEXT NOT NULL,
  feed_url      TEXT NOT NULL UNIQUE,
  recheck_hours INTEGER NOT NULL DEFAULT 6 CHECK (recheck_hours BETWEEN 1 AND 168),
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE news_sweep_feeds IS '要定時掃的媒體 RSS；每個來源每 recheck_hours 長一筆任務。enabled=false 就不派。';

ALTER TABLE news_sweep_feeds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON news_sweep_feeds;
CREATE POLICY "Public read" ON news_sweep_feeds FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON news_sweep_feeds;
CREATE POLICY "Service role write" ON news_sweep_feeds FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 實測過可用（2026-09-12，回 200 且 <link> 直接是媒體本身的文章網址）：
--   中央社 政治    20 筆   https://www.cna.com.tw/news/aipl/…
--   自由時報 政治  40 筆   https://news.ltn.com.tw/news/politics/breakingnews/…
-- 公視那支（about.pts.org.tw/rss/nnews.xml）回 404，網址要另外找，先不放。
-- 聯合報那支標題是空的 CDATA，要多剖一層，先不放。
INSERT INTO news_sweep_feeds (label, feed_url, recheck_hours, enabled) VALUES
  ('中央社 政治', 'https://feeds.feedburner.com/rsscna/politics', 6, TRUE),
  ('自由時報 政治', 'https://news.ltn.com.tw/rss/politics.xml', 6, FALSE)
ON CONFLICT (feed_url) DO NOTHING;

-- ------------------------------------------------------------
-- 每個來源同時只會有一筆 open 任務。逾期就關掉再開新的一筆，
-- 這樣「掃過了」不需要另一張表記錄——任務本身就是紀錄。
--
-- 為什麼要主動關：代理交了 policy 之後任務不會自己關（只有 no_change 會關）。
-- 不關的話那筆任務會一直在，下一輪就不會建新的，這個來源從此不再被掃。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION news_sweep_refresh_tasks() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  f RECORD;
  v_open_id UUID;
  v_created INTEGER := 0;
BEGIN
  FOR f IN SELECT * FROM news_sweep_feeds WHERE enabled ORDER BY id LOOP
    SELECT id INTO v_open_id
    FROM contribution_tasks
    WHERE task_type = 'news_sweep' AND status = 'open' AND target->>'feed_url' = f.feed_url
    ORDER BY created_at DESC LIMIT 1;

    IF v_open_id IS NOT NULL THEN
      -- 還在冷卻期內就什麼都不做
      IF EXISTS (
        SELECT 1 FROM contribution_tasks
        WHERE id = v_open_id AND created_at > now() - (f.recheck_hours || ' hours')::INTERVAL
      ) THEN
        CONTINUE;
      END IF;
      -- 逾期了：關掉舊的
      UPDATE contribution_tasks SET status = 'closed' WHERE id = v_open_id;
    END IF;

    INSERT INTO contribution_tasks (title, description, task_type, target, region, priority, reward, source, created_by)
    VALUES (
      '掃 ' || f.label || ' 找新政見',
      '打開 ' || f.feed_url || '（RSS，最新 20～40 筆），挑出提到 2026 候選人「具體政見」或既有政見「新進度」的報導。'
        || '每一筆分開提交：新政見用 policy，既有政見的新進度用 policy_progress。'
        || 'source_urls 一律放新聞原文網址（RSS 裡 <link> 的值，不是這個 RSS 網址、不是搜尋結果、不是轉貼）。'
        || '只收具體承諾與可查證的進度；民調、評論、行程、站台花絮不要收。一則報導提到多個人就分成多筆。'
        || '提交前先用 lookup 看那個人現有的政見，同一個承諾換句話說不要再送一次。'
        || '看完沒有可提交的就用 no_change 回報，note 寫你看了幾筆、為什麼都不符合——那也是成果，會關掉這筆任務。',
      'news_sweep',
      jsonb_build_object('feed_url', f.feed_url, 'label', f.label, 'recheck_hours', f.recheck_hours),
      NULL,
      1,
      2,
      'manual',
      'news_sweep_refresh_tasks'
    );
    v_created := v_created + 1;
  END LOOP;
  RETURN v_created;
END;
$$;
COMMENT ON FUNCTION news_sweep_refresh_tasks IS '每個啟用的 RSS 來源維持一筆 open 的 news_sweep 任務；逾 recheck_hours 就關舊的、開新的。回傳新建幾筆。';

-- 每小時檢查一次。不是每小時都會建任務——建不建看各來源自己的 recheck_hours。
SELECT cron.schedule('news-sweep-refresh', '15 * * * *', 'SELECT news_sweep_refresh_tasks();');

-- 立刻跑一次，不必等下一個整點
SELECT news_sweep_refresh_tasks();
