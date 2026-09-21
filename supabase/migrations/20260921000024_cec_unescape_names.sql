-- 姓名裡的中選會逸出碼 @HEX@ 還原（使用者 2026-09-21 裁示 #12b）。
--
-- 中選會對罕用字用「@十六進位碼位@」表示（江@2F97F@淵＝江聰淵），匯入時整串當字面值存進去，32 筆。
-- 後果不只難看：identity-normalize 讓逸出字串原封穿過，那 32 人對去重系統是隱形的——任何代理提交他們
-- 其中一位都會比對落空、指認成 new、多一筆重複人物（leatherback 2026-09-21）。江聰淵那頁還在 sitemap 裡。
--
-- 解碼要做 NFKC：@2F97F@ 解出來是 U+2F97F（相容表意字），不是「聰」(U+8070)；NFKC 之後才是。
-- 私用區（U+E000–F8FF、U+F0000–FFFFD、U+100000–10FFFD）不解：沒有標準對應字，解了變豆腐字，
-- 比現在的 @FCFBF@ 更糟——至少現在看得出「這裡有個未知字」。那 3 筆維持原狀，等別的來源。
-- 14 筆有中選會 API 佐證的，代理已走流程提 correction；這支一併解掉，那些更正落庫時會是空操作，無害。

CREATE OR REPLACE FUNCTION cec_unescape_name(p TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE hex TEXT; code INTEGER; result TEXT := p;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  FOR hex IN SELECT (regexp_matches(p, '@([0-9A-Fa-f]{4,5})@', 'g'))[1] LOOP
    code := ('x' || lpad(hex, 8, '0'))::bit(32)::int;
    IF (code BETWEEN 57344 AND 63743) OR (code BETWEEN 983040 AND 1048573) OR (code BETWEEN 1048576 AND 1114109) THEN
      CONTINUE; -- 私用區
    END IF;
    result := replace(result, '@' || hex || '@', normalize(chr(code), NFKC));
  END LOOP;
  RETURN result;
END;
$$;
COMMENT ON FUNCTION cec_unescape_name IS '中選會 @HEX@ 逸出碼 → 字元（NFKC）；私用區碼位不解。匯入端與身分正規化都可用。';

CREATE TEMP TABLE renamed AS
  SELECT id, name AS old_name, cec_unescape_name(name) AS new_name
    FROM politicians
   WHERE name ~ '@[0-9A-Fa-f]{4,5}@' AND cec_unescape_name(name) <> name;

UPDATE politicians p SET name = r.new_name FROM renamed r WHERE p.id = r.id;

-- 身分鍵是從姓名算的，改名後重建（identity_build_keys 是 20260911000002 backfill 用的同一支）
DELETE FROM politician_keys k USING renamed r WHERE k.politician_id = r.id;
INSERT INTO politician_keys (politician_id, key_type, key_value, strength, source)
  SELECT r.id, k.key_type, k.key_value, k.strength, 'cec_unescape'
    FROM renamed r CROSS JOIN LATERAL identity_build_keys(r.id) k
  ON CONFLICT (politician_id, key_type, key_value) DO NOTHING;

-- 自我檢查：非私用區的逸出碼要清乾淨；改了幾筆印出來
DO $$
DECLARE left_over INTEGER; n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM renamed;
  SELECT count(*) INTO left_over FROM politicians
   WHERE name ~ '@[0-9A-Fa-f]{4,5}@' AND cec_unescape_name(name) <> name;
  IF left_over > 0 THEN RAISE EXCEPTION '還有 % 筆非私用區逸出碼沒解', left_over; END IF;
  RAISE NOTICE 'cec_unescape_names：改了 % 筆姓名', n;
END $$;
