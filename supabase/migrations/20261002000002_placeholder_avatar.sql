-- 佔位圖不是照片（2026-10-02 維護者裁示）
--
-- 內政部名冊的通用佔位圖
--   https://ws.moi.gov.tw/001/Upload/400/relpic/8999/2352/a923fbd9-30da-44ba-90c4-ae26fc10d863.png
-- 被 398 位人物當成 avatar_url 存著。於是：
--   * profile_gap 自動缺口判「缺照片」用 avatar_url IS NULL（20260918000002）
--   * boost 的 missing_avatar 用 COALESCE(avatar_url,'') = ''（20260921000030）
--   * 派給代理的 current.politician.has_avatar 也是從 avatar_url 推的
-- 三處都認為他們「有照片」，所以永遠不會派補照片任務，代理也以為不用補。
-- 實測：把這 398 人用 politician_ids 插隊，只命中 10 筆任務 —— 因為任務根本沒被建出來。
--
-- 這一支做三件事：①把已知佔位圖列成資料（之後要加新的就 INSERT 一列，不用改程式）
-- ②加 trigger，寫入時就把佔位圖正規化成 NULL，免得下次匯入中選會資料又長回來
-- ③清掉既有的，並把清掉前的值存進 avatar_placeholder_cleared 留紀錄／可還原。

-- ① 佔位圖清單 ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avatar_placeholders (
  url      TEXT PRIMARY KEY,
  note     TEXT NOT NULL DEFAULT '',
  added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE avatar_placeholders IS
  '不算照片的佔位圖網址。politicians.avatar_url 寫入時命中這裡就正規化成 NULL，讓補照片任務正常派出。要加新的佔位圖就 INSERT 一列。';

ALTER TABLE avatar_placeholders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avatar_placeholders_public_read ON avatar_placeholders;
CREATE POLICY avatar_placeholders_public_read ON avatar_placeholders FOR SELECT USING (true);

INSERT INTO avatar_placeholders (url, note) VALUES
  ('https://ws.moi.gov.tw/001/Upload/400/relpic/8999/2352/a923fbd9-30da-44ba-90c4-ae26fc10d863.png',
   '內政部名冊通用佔位圖（2026-10-02 發現 398 人共用）')
ON CONFLICT (url) DO NOTHING;

-- ② 寫入時正規化 ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_placeholder_avatar(p_url TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT p_url IS NOT NULL
     AND EXISTS (SELECT 1 FROM avatar_placeholders a WHERE a.url = p_url);
$$;
COMMENT ON FUNCTION is_placeholder_avatar IS '這個網址是不是佔位圖（見 avatar_placeholders）。';

CREATE OR REPLACE FUNCTION politicians_strip_placeholder_avatar()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF is_placeholder_avatar(NEW.avatar_url) THEN
    NEW.avatar_url := NULL;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION politicians_strip_placeholder_avatar IS
  '寫入 politicians.avatar_url 時，佔位圖一律存成 NULL —— 不然匯入端補一次佔位圖，補照片任務就又消失。';

DROP TRIGGER IF EXISTS trg_politicians_strip_placeholder_avatar ON politicians;
CREATE TRIGGER trg_politicians_strip_placeholder_avatar
  BEFORE INSERT OR UPDATE OF avatar_url ON politicians
  FOR EACH ROW EXECUTE FUNCTION politicians_strip_placeholder_avatar();

-- ③ 清既有的，留紀錄 ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS avatar_placeholder_cleared (
  politician_id UUID PRIMARY KEY REFERENCES politicians(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  cleared_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE avatar_placeholder_cleared IS
  '被清成 NULL 的佔位圖原值，留著當紀錄與還原依據（要還原就從這裡 UPDATE 回去）。';

ALTER TABLE avatar_placeholder_cleared ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS avatar_placeholder_cleared_public_read ON avatar_placeholder_cleared;
CREATE POLICY avatar_placeholder_cleared_public_read ON avatar_placeholder_cleared FOR SELECT USING (true);

INSERT INTO avatar_placeholder_cleared (politician_id, url)
SELECT p.id, p.avatar_url FROM politicians p
WHERE is_placeholder_avatar(p.avatar_url)
ON CONFLICT (politician_id) DO NOTHING;

DO $$
DECLARE n INTEGER;
BEGIN
  UPDATE politicians SET avatar_url = NULL WHERE is_placeholder_avatar(avatar_url);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '清掉佔位圖 avatar_url：% 筆', n;
END $$;
