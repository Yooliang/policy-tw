-- ============================================================
-- 政治人物姓名含簡體字（舊匯入殘留）：掃描 + 對照繁體 + 更新計畫。結尾 ROLLBACK，主線審過才改 COMMIT。
-- 2026-09-11 以 anon 只讀掃 prod：命中 19 筆，全部是「黄」→「黃」（黄玉芬、黄靖翔、黄永欽、黄芥銓、黄翠華、黄璿銘、
--   黄淑玲、黄福林、黄荀武、黄錫聰、黄師鵬、黄國基、黄石君、黄建昌、黄肇輝、黄雅珊、黄淑美、黄明隆、黄鈺琪）。
-- 注意：「台」不在對照表裡（台北／台南是正常寫法）；「于」「云」等本身也是繁體常用字，不動。
-- politician_keys 由觸發器在 name 改變時自動補新 key 並留 alias_name（舊寫法），身份比對不會斷。
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_count(label TEXT, actual BIGINT, expected BIGINT) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF actual <> expected THEN RAISE EXCEPTION 'ASSERT FAILED [%]: expected %, got %', label, expected, actual; END IF;
  RAISE NOTICE 'ok [%] = %', label, actual;
  RETURN 'ok';
END; $$;

-- 對照（簡 → 繁），只放姓名常見字
CREATE TEMP TABLE simp_map(simp TEXT PRIMARY KEY, trad TEXT NOT NULL);
INSERT INTO simp_map VALUES
  ('黄','黃'),('国','國'),('湾','灣'),('卫','衛'),('业','業'),('华','華'),('陈','陳'),('张','張'),('刘','劉'),('杨','楊'),
  ('吴','吳'),('赵','趙'),('罗','羅'),('郑','鄭'),('谢','謝'),('叶','葉'),('苏','蘇'),('邓','鄧'),('冯','馮'),('钟','鍾'),
  ('万','萬'),('东','東'),('龙','龍'),('军','軍'),('丽','麗'),('乐','樂'),('凤','鳳'),('荣','榮'),('兴','興'),('义','義'),
  ('庆','慶'),('广','廣'),('汉','漢'),('贤','賢'),('庄','莊'),('严','嚴'),('赖','賴'),('凯','凱'),('钦','欽');

-- 1. 掃描：哪些人名含對照表裡的簡體字
CREATE TEMP TABLE hits AS
SELECT p.id, p.name,
       translate(p.name, (SELECT string_agg(simp, '' ORDER BY simp) FROM simp_map), (SELECT string_agg(trad, '' ORDER BY simp) FROM simp_map)) AS fixed,
       p.region, p.election_type
FROM politicians p
WHERE p.name ~ ('[' || (SELECT string_agg(simp, '' ORDER BY simp) FROM simp_map) || ']');

DO $$
DECLARE r RECORD; n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n FROM hits;
  RAISE NOTICE '含簡體字的姓名：% 筆（2026-09-11 只讀掃到 19）', n;
  FOR r IN SELECT * FROM hits ORDER BY name LOOP
    RAISE NOTICE '  % → %  (%／%／%)', r.name, r.fixed, r.id, r.region, r.election_type;
  END LOOP;
END $$;

-- 2. 改名前確認不會撞到既有同名（同一縣市已有繁體寫法的同一人 → 那是重複人物，要走合併不是改名）
DO $$
DECLARE r RECORD; n INTEGER := 0;
BEGIN
  FOR r IN SELECT h.*, q.id AS dup_id FROM hits h JOIN politicians q ON q.name = h.fixed AND q.region = h.region LOOP
    n := n + 1;
    RAISE NOTICE '  ⚠ 改名後會與既有人物同名同縣市：% → % 撞 %（請人工看是否同一人，若是要用合併流程）', r.name, r.fixed, r.dup_id;
  END LOOP;
  IF n > 0 THEN RAISE EXCEPTION '有 % 筆改名會撞既有人物，先人工處理再跑', n; END IF;
END $$;

-- 3. 更新（觸發器會補 politician_keys 並留 alias_name＝舊寫法）
UPDATE politicians p SET name = h.fixed FROM hits h WHERE p.id = h.id AND h.fixed <> p.name;

SELECT pg_temp.assert_count('改名後仍含簡體字', (SELECT COUNT(*) FROM politicians WHERE name ~ ('[' || (SELECT string_agg(simp, '') FROM simp_map) || ']')), 0);

ROLLBACK; -- 主線審過後改成 COMMIT
