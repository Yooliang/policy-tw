-- 內政部官方照片直接匯入，只限一對一對得上的（小良哥 2026-09-24 選 B：「官方照片直接匯入」）
--
-- 這是「資料問題走貢獻流程、不手修」的例外（docs/DECISIONS.md 09-24）：網站上 6,666 位現職人物沒照片、內政部都有，
-- 走貢獻流程要 6,666 筆交件、一萬多張票。只匯入最沒有歧義的那種：
--   人物沒照片、有縣市；內政部名單上同名同縣市且有照片的恰好 1 位；而那 1 位在我們這邊也只對得到這 1 個人物。
-- 同名多人、縣市空白、對不上的，照舊走補基本資料任務（任務內容已附官方紀錄）。
-- 每一筆寫 edit_history（agent_name='moi-import'），可整批還原：
--   UPDATE politicians p SET avatar_url = NULL FROM edit_history e
--    WHERE e.agent_name = 'moi-import' AND e.field = 'avatar_url' AND e.record_id = p.id::TEXT AND e.reverted_at IS NULL;

CREATE OR REPLACE FUNCTION import_moi_avatars() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INTEGER;
BEGIN
  WITH cand AS (
    SELECT p.id AS pid, m.id AS mid, m.photo_url
      FROM politicians p
      JOIN moi_officials m ON m.name_norm = moi_norm(p.name) AND m.region_norm = moi_norm(p.region)
     WHERE p.merged_into IS NULL
       AND (p.avatar_url IS NULL OR p.avatar_url = '')
       AND moi_norm(p.region) IS NOT NULL
       AND m.photo_url IS NOT NULL
  ),
  one_to_one AS (
    SELECT c.pid, c.mid, c.photo_url FROM cand c
     WHERE (SELECT COUNT(*) FROM moi_officials m2
             WHERE m2.name_norm = (SELECT moi_norm(name) FROM politicians WHERE id = c.pid)
               AND m2.region_norm = (SELECT moi_norm(region) FROM politicians WHERE id = c.pid)
               AND m2.photo_url IS NOT NULL) = 1
       AND (SELECT COUNT(*) FROM politicians p2, moi_officials m3
             WHERE m3.id = c.mid AND p2.merged_into IS NULL
               AND moi_norm(p2.name) = m3.name_norm AND moi_norm(p2.region) = m3.region_norm) = 1
  ),
  hist AS (
    INSERT INTO edit_history (table_name, record_id, field, old_value, new_value, agent_name, applied_at)
    -- new_value 跟其他照片更正同格式（網址字串）；來源是內政部名單，代號 moi-import 就是出處
    SELECT 'politicians', o.pid::TEXT, 'avatar_url', 'null'::jsonb, to_jsonb(o.photo_url), 'moi-import', now()
      FROM one_to_one o
    RETURNING record_id
  )
  UPDATE politicians p SET avatar_url = o.photo_url
    FROM one_to_one o
   WHERE p.id = o.pid AND p.id::TEXT IN (SELECT record_id FROM hist);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION import_moi_avatars IS '內政部官方照片直接寫進沒照片的人物，只限同名同縣市一對一；每筆記 edit_history（agent_name=moi-import）可整批還原';

-- 每天同步完內政部名單之後補新的（台灣時間 04:50）
SELECT cron.unschedule('moi-avatar-import-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'moi-avatar-import-daily');
SELECT cron.schedule('moi-avatar-import-daily', '50 20 * * *', $$SELECT import_moi_avatars();$$);
