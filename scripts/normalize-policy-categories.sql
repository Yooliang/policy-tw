-- ============================================================
-- 統一 policies.category 的舊寫法（對照表同 supabase/functions/_shared/category-map.ts）
-- 2026-09-11 以 anon 只讀掃 prod：293 筆、17 種寫法
--   社會 70 → 社會福利｜經濟 53 → 經濟發展｜交通 39 → 交通建設｜環境 19 → 環境保護｜教育 9 → 教育文化｜社福 2 → 社會福利
--   不動：其他 26、經濟補助 1、能源 1，以及已是正規值的 交通建設 5／社會福利 14／經濟發展 23／教育文化 3／環境保護 3／行政革新 12／政治議題 12／公平正義 1
-- 預期更新 192 筆；跑完 11 種寫法（8 正規值 + 其他／經濟補助／能源）
-- 先原樣跑（結尾 ROLLBACK）看 NOTICE 全 ok，主線審過再改 COMMIT。
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.assert_count(label TEXT, actual BIGINT, expected BIGINT) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  IF actual <> expected THEN RAISE EXCEPTION 'ASSERT FAILED [%]: expected %, got %', label, expected, actual; END IF;
  RAISE NOTICE 'ok [%] = %', label, actual;
  RETURN 'ok';
END; $$;

-- 事前
SELECT pg_temp.assert_count('policies total', (SELECT COUNT(*) FROM policies), 293);
SELECT pg_temp.assert_count('舊寫法筆數', (SELECT COUNT(*) FROM policies WHERE category IN ('社會', '經濟', '交通', '環境', '教育', '社福')), 192);

UPDATE policies SET category = CASE category
  WHEN '交通' THEN '交通建設'
  WHEN '社會' THEN '社會福利'
  WHEN '社福' THEN '社會福利'
  WHEN '經濟' THEN '經濟發展'
  WHEN '環境' THEN '環境保護'
  WHEN '教育' THEN '教育文化'
  ELSE category END
WHERE category IN ('社會', '經濟', '交通', '環境', '教育', '社福');

-- 事後
SELECT pg_temp.assert_count('舊寫法剩餘', (SELECT COUNT(*) FROM policies WHERE category IN ('社會', '經濟', '交通', '環境', '教育', '社福')), 0);
SELECT pg_temp.assert_count('交通建設', (SELECT COUNT(*) FROM policies WHERE category = '交通建設'), 44);
SELECT pg_temp.assert_count('社會福利', (SELECT COUNT(*) FROM policies WHERE category = '社會福利'), 86);
SELECT pg_temp.assert_count('經濟發展', (SELECT COUNT(*) FROM policies WHERE category = '經濟發展'), 76);
SELECT pg_temp.assert_count('教育文化', (SELECT COUNT(*) FROM policies WHERE category = '教育文化'), 12);
SELECT pg_temp.assert_count('環境保護', (SELECT COUNT(*) FROM policies WHERE category = '環境保護'), 22);
SELECT pg_temp.assert_count('其他 不動', (SELECT COUNT(*) FROM policies WHERE category = '其他'), 26);
SELECT pg_temp.assert_count('經濟補助＋能源 不動', (SELECT COUNT(*) FROM policies WHERE category IN ('經濟補助', '能源')), 2);
SELECT pg_temp.assert_count('寫法種數', (SELECT COUNT(DISTINCT category) FROM policies), 11);
SELECT pg_temp.assert_count('policies total after', (SELECT COUNT(*) FROM policies), 293);

ROLLBACK; -- 主線審過後改成 COMMIT
