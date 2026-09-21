-- 頭像的 Wikimedia 縮圖寬度換成對外供應的尺寸（2026-09-22）
--
-- Wikimedia 對外只供應固定幾種縮圖寬度（實測 250／330／500 回 200；200／220／240／300／320／400／440／640／800 回 400），
-- 維基百科資訊框預設給的是 220px，/find-avatar 與 update-avatar 照收 → 24 位政治人物頭像整批空白（2026 縣市長 11 位：
-- 李四川、蘇巧慧、陳素月、蔡易餘、童子瑋、張啟楷、張嘉郡、林國漳、江啟臣、王美惠、賴瑞隆）。這是工具端產出的缺陷，
-- 不是資料本身錯，所以直接改寫：取 ≥ 原寬度的最小允許值，超過 500 就 500（跟 _shared/avatar-url.ts 同一套）。

UPDATE politicians
   SET avatar_url = regexp_replace(
         avatar_url,
         '/(\d+)px-([^/]+)$',
         '/' || (CASE WHEN w <= 250 THEN 250 WHEN w <= 330 THEN 330 ELSE 500 END)::text || 'px-\2'
       )
  FROM (
    SELECT id, substring(avatar_url from '/(\d+)px-[^/]+$')::int AS w
      FROM politicians
     WHERE avatar_url ~ '^https://(upload|thumb)\.wikimedia\.org/wikipedia/[^/]+/thumb/.+/\d+px-[^/]+$'
  ) t
 WHERE politicians.id = t.id
   AND t.w NOT IN (250, 330, 500);

DO $$
DECLARE bad int; total int;
BEGIN
  SELECT count(*) INTO bad FROM politicians
   WHERE avatar_url ~ '^https://(upload|thumb)\.wikimedia\.org/wikipedia/[^/]+/thumb/.+/\d+px-[^/]+$'
     AND substring(avatar_url from '/(\d+)px-[^/]+$')::int NOT IN (250, 330, 500);
  SELECT count(*) INTO total FROM politicians WHERE avatar_url ~ '^https://(upload|thumb)\.wikimedia\.org/wikipedia/[^/]+/thumb/';
  IF bad <> 0 THEN RAISE EXCEPTION 'wikimedia 縮圖還有 % 筆不是允許寬度', bad; END IF;
  RAISE NOTICE 'wikimedia 縮圖 % 筆全部是允許寬度', total;
END $$;
