-- 號次任務中縣市長、縣市議員比其他號次任務更優先派出（2026-10-29，維護者：「號次任務中，縣市長、縣市議員要比其他號次任務更優先」）。
--   原本（20261029050000）cand_no_front_pull() 把所有號次缺口列與等票號次驗證列拉到同一個 2 × visitor_front_seconds（20 年），
--   縣市長（22 件）、縣市議員（44 件）與村里長（400 件）、鄉鎮市長、鄉鎮市民代表一樣，只照等待時間排，會被量大的村里長稀釋。
-- 做法：以 20261029050000 的函式為底，只改秒數：縣市長、縣市議員拉到 3 × visitor_front_seconds（30 年），其他號次維持 2 ×（20 年）。
--   ① 缺口列看 target.election_type；② 號次驗證列看交件 payload.election_type（同一個中文選舉別）。
--   仍取 GREATEST 語意（只更新秒數還不夠的列）、被派出歸零、每小時第 3 分重拉、2026-11-28 停；排程不動。
--   30 年只比號次一般插隊（20 年）多一段，仍是同一種插隊，不改網站請求（10 年）／公民提問與其他既有項目的相對順序。
CREATE OR REPLACE FUNCTION cand_no_front_pull() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE v_n INTEGER; v_boost BIGINT; v_top BIGINT;
BEGIN
  IF activity_today() > DATE '2026-11-28' THEN RETURN 0; END IF;
  SELECT 2 * q.visitor_front_seconds, 3 * q.visitor_front_seconds INTO v_boost, v_top FROM queue_settings q WHERE q.id = 1;
  IF v_boost IS NULL OR v_boost <= 0 THEN RETURN 0; END IF;
  UPDATE task_dispatches d
     SET boost_seconds = x.want, cooling = false
    FROM (
      SELECT d2.task_id,
             CASE WHEN d2.target->>'kind' = 'cand_no' THEN
                    CASE WHEN d2.target->>'election_type' IN ('縣市長', '縣市議員') THEN v_top ELSE v_boost END
                  ELSE
                    (SELECT CASE WHEN c.payload->>'election_type' IN ('縣市長', '縣市議員') THEN v_top ELSE v_boost END
                       FROM contributions c
                      WHERE d2.task_id = 'verify:' || c.id::text
                        AND c.status = 'pending'
                        AND c.contribution_type = 'candidacy'
                        AND c.payload ? 'cand_no')
             END AS want
        FROM task_dispatches d2
    ) x
   WHERE d.task_id = x.task_id
     AND x.want IS NOT NULL
     AND d.boost_seconds < x.want;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
COMMENT ON FUNCTION cand_no_front_pull IS '號次的缺口列與等票的驗證列，插隊秒數至少拉到 2 × visitor_front_seconds（比網站請求前面）；縣市長、縣市議員拉到 3 ×（比其他號次更前）；pg_cron 每小時第 3 分；2026-11-28 之後不做事（2026-10-29，維護者）';
-- 上線當下先跑一次，不用等到下個整點
SELECT cand_no_front_pull();
