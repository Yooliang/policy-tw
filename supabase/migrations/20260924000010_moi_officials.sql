-- 內政部「地方公職人員」現職名單當官方對照表（小良哥 2026-09-24：「這裡有一大堆現職的可以抓取」「jev 也該幫忙 -1 票」）
--
-- 起因：陳雅倫（桃園市龜山區議員）的補照片任務，代理只查了議會網站（打不開）和維基（沒圖）就回報 not_found，
-- 兩票通過、冷卻 14 天——內政部 LocalOfficial 頁就有她的官方照片。
-- 1. moi-sync 每天把 10 種職務的現職名單（姓名、縣市、機關、職稱、黨籍、照片網址）抓進 moi_officials
-- 2. 補基本資料任務的內容附上內政部的對應紀錄（task-context），代理核對後交件
-- 3. 有人回報「補基本資料查無」、但這個人沒照片而內政部同縣市同名的人有照片 → 系統判 not_supported（目標 +1），
--    不需要 Jev：直接比對官方資料。資料照舊走貢獻流程，系統不直接改人物。

CREATE TABLE IF NOT EXISTS moi_officials (
  id           TEXT PRIMARY KEY,            -- 內政部的 _PARENT_ID
  kind         TEXT NOT NULL,               -- KND0001～KND0010
  name         TEXT NOT NULL,
  name_norm    TEXT NOT NULL,
  region       TEXT,
  region_norm  TEXT,
  org          TEXT,
  title        TEXT,
  party        TEXT,
  photo_url    TEXT,
  detail_url   TEXT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moi_officials_name_idx ON moi_officials (name_norm, region_norm);
COMMENT ON TABLE moi_officials IS '內政部地方公職人員現職名單（moi-sync 每天更新）；補照片／基本資料的官方對照';
ALTER TABLE moi_officials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS moi_officials_public_read ON moi_officials;
CREATE POLICY moi_officials_public_read ON moi_officials FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION moi_norm(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$ SELECT NULLIF(replace(regexp_replace(COALESCE(p, ''), '\s|　', '', 'g'), '臺', '台'), '') $$;

-- 某位人物在內政部名單上的對應（同名；有縣市就要同縣市）
CREATE OR REPLACE FUNCTION moi_official_for(p_politician_id UUID)
RETURNS SETOF moi_officials
LANGUAGE sql STABLE AS $$
  SELECT m.* FROM moi_officials m JOIN politicians p ON p.id = p_politician_id
   WHERE m.name_norm = moi_norm(p.name)
     AND (moi_norm(p.region) IS NULL OR m.region_norm = moi_norm(p.region))
   ORDER BY (m.photo_url IS NOT NULL) DESC, m.fetched_at DESC
   LIMIT 3
$$;

-- 系統票：「補基本資料查無」但內政部有照片 → not_supported
CREATE OR REPLACE FUNCTION moi_check_no_change() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r RECORD; v_n INTEGER := 0;
BEGIN
  FOR r IN
    SELECT c.id, p.id AS pid, p.name, p.region, m.photo_url, m.org, m.title, m.id AS moi_id
      FROM contributions c
      JOIN politicians p ON p.id::TEXT = split_part(c.task_id, ':', 3)
      JOIN LATERAL (SELECT * FROM moi_official_for(p.id) LIMIT 1) m ON TRUE
     WHERE c.status = 'pending' AND c.contribution_type = 'no_change'
       AND c.task_id LIKE 'auto:profile_gap:%'
       AND COALESCE(c.payload->>'outcome', '') IN ('not_found', 'unreachable', '')
       AND (p.avatar_url IS NULL OR p.avatar_url = '')
       AND m.photo_url IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM jev_decisions j WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT
                         AND j.question = 'source_support' AND j.model LIKE 'policy-tw/moi-check%')
     LIMIT 200
  LOOP
    INSERT INTO jev_decisions (subject_type, subject_id, question, choice, probability, confidence, probabilities, model, state, cost_usd)
    VALUES ('contribution', r.id::TEXT, 'source_support', 'not_supported', 1, NULL, NULL, 'policy-tw/moi-check-20260924',
            jsonb_build_object('reason', '回報查無，但內政部地方公職人員名單有此人官方照片',
                               'politician', jsonb_build_object('id', r.pid, 'name', r.name, 'region', r.region),
                               'moi', jsonb_build_object('id', r.moi_id, 'org', r.org, 'title', r.title, 'photo_url', r.photo_url)), 0)
    ON CONFLICT DO NOTHING;
    PERFORM contribution_apply_consensus(r.id);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION moi_check_no_change IS '補基本資料回報查無、但內政部有官方照片 → 系統票 not_supported（目標 +1）';

-- 系統票的合格判斷：原本的型別，或內政部比對（no_change 本來沒有系統票）
CREATE OR REPLACE FUNCTION contribution_system_vote(p_contribution_id UUID) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT j.choice
  FROM jev_decisions j
  JOIN contributions c ON c.id = p_contribution_id
  WHERE j.subject_type = 'contribution' AND j.subject_id = p_contribution_id::TEXT
    AND j.question = 'source_support'
    AND j.choice IN ('supported', 'not_supported')
    AND j.probability >= system_one_min_probability()
    AND (system_vote_eligible(c.contribution_type) OR j.model LIKE 'policy-tw/moi-check%')
  ORDER BY j.asked_at DESC
  LIMIT 1
$$;

SELECT cron.unschedule('moi-check-10min') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'moi-check-10min');
SELECT cron.schedule('moi-check-10min', '4,14,24,34,44,54 * * * *', $$SELECT moi_check_no_change();$$);

-- 每天台灣時間 04:20 起，10 種職務分開抓（村里長最多，約 7,700 人）
SELECT cron.unschedule('moi-sync-daily') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'moi-sync-daily');
SELECT cron.schedule('moi-sync-daily', '20 20 * * *', $$
  SELECT net.http_post(url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/moi-sync?kinds=' || k,
                       headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 150000)
    FROM unnest(ARRAY['KND0001,KND0002,KND0004,KND0005', 'KND0003', 'KND0006,KND0009,KND0010', 'KND0007', 'KND0008']) AS k;
$$);
