-- 新聞追蹤的可調設定（小良哥 2026-09-29：「支持 AI 的資源不多…讓頻率可以調整」）
--
-- 收新聞（news-fetch）維持每小時：不用 AI，而且 RSS 只留最近 20～50 則，抓慢了會漏。
-- 會吃代理資源的是「初篩→開任務」這一段，所以只有這一段可調：
--   screen_every_hours  幾小時初篩一次（1＝收完當場篩）。沒到時間的新聞留著，到時間一次篩
--   daily_task_cap      台灣時間每天最多開幾件新聞任務。超過的記成 deferred，隔天有額度時先補開（新的優先）
--   enabled             整個初篩暫停（收錄照常）
-- 改的時候直接改這一列，不用重新部署：
--   UPDATE news_settings SET screen_every_hours = 3, daily_task_cap = 10, note = '代理少，放慢' WHERE id = 1;
-- 實測量體（2026-09-29 的 24 小時）：收約 1,000 則、判有關 24 則、開 10 件任務、交件 14 筆（全站 923 筆的 1.5%）。

CREATE TABLE IF NOT EXISTS news_settings (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  screen_every_hours  INTEGER NOT NULL DEFAULT 1 CHECK (screen_every_hours BETWEEN 1 AND 24),
  daily_task_cap      INTEGER NOT NULL DEFAULT 30 CHECK (daily_task_cap BETWEEN 0 AND 500),
  last_screen_at      TIMESTAMPTZ,
  note                TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE news_settings IS '新聞初篩的可調設定（單列 id=1）：幾小時篩一次、每天最多開幾件任務、暫停開關。收錄不受影響。';
INSERT INTO news_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE news_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON news_settings;
CREATE POLICY "Public read" ON news_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON news_settings;
CREATE POLICY "Service role write" ON news_settings FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION news_settings_touch() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- 只有 last_screen_at 變了（排程自己寫的）不算「有人改設定」
  IF (NEW.enabled, NEW.screen_every_hours, NEW.daily_task_cap, NEW.note) IS DISTINCT FROM (OLD.enabled, OLD.screen_every_hours, OLD.daily_task_cap, OLD.note) THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS news_settings_touch ON news_settings;
CREATE TRIGGER news_settings_touch BEFORE UPDATE ON news_settings FOR EACH ROW EXECUTE FUNCTION news_settings_touch();
