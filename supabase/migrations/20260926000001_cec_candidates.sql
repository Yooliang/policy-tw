-- 中選會候選人名單快照（2026-09-26，小良哥同意：之後系統自己發現這類問題）
--
-- 09-25 補 2022 號次時逐筆對中選會，意外抓到 46 筆查無此人、20 筆縣市存錯（復興區被存成台南市）、
-- 疑似重複人物——這些都是早期匯入留下的，平常沒有任何東西會發現。
-- 做法跟內政部名單（moi_officials）一樣：排程把已投票選舉的中選會名單抓進來，SQL 比對，對不上就開任務給代理修。
-- 系統不自己改資料（小良哥 09-25：改流程、不直接動資料）。
--
-- 同步由 Edge Function cec-sync 做（每週一次；只抓 election_id 已投票的屆別）。

CREATE TABLE IF NOT EXISTS cec_candidates (
  id             BIGSERIAL PRIMARY KEY,
  election_id    INTEGER NOT NULL,
  election_type  TEXT NOT NULL,          -- 跟 politician_elections.election_type 同一套（縣市長、縣市議員…）
  region         TEXT NOT NULL,          -- 縣市（台北市，不用「臺」）
  sub_region     TEXT,                   -- 選區或鄉鎮（「第06選舉區」「彰化市」「復興區第01選舉區」）
  village        TEXT,                   -- 村里長才有
  name           TEXT NOT NULL,          -- 中選會原字（罕見字已從 @碼位@ 解回）
  name_norm      TEXT NOT NULL,          -- 比對用：NFKC、黄→黃、去間隔號與附註拼音
  birth_year     INTEGER,
  cand_no        INTEGER,
  elected        BOOLEAN,
  cec_theme_id   TEXT,
  cec_cand_id    INTEGER,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 同步是「整個範圍（屆別×選舉別×縣市）先刪再寫」，不靠 upsert
CREATE INDEX IF NOT EXISTS cec_candidates_name_idx ON cec_candidates (election_id, name_norm);
CREATE INDEX IF NOT EXISTS cec_candidates_scope_idx ON cec_candidates (election_id, election_type, region);
COMMENT ON TABLE cec_candidates IS '中選會已投票選舉的候選人名單快照（cec-sync 每週同步），拿來比對我們的參選紀錄';
ALTER TABLE cec_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cec_candidates_read ON cec_candidates;
CREATE POLICY cec_candidates_read ON cec_candidates FOR SELECT USING (true);

-- 我們這邊的姓名正規化，跟 cec-sync 的 name_norm 同一套規則（臺→台、黄→黃、去空白與間隔號）
CREATE OR REPLACE FUNCTION cec_name_norm(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(translate(normalize(COALESCE(p, ''), NFKC), '臺黄', '台黃'), '[\s·．・‧•]', '', 'g')
$$;
