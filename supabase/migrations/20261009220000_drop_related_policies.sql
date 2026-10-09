-- #349 第二階段 B：刪掉 related_policies 表、related_policies_uncovered 視圖，視圖 policies_with_logs 拿掉 related_policy_ids 欄
--
-- 這是「刪東西」的第二次上線：第一次（20261006234000，#408）已把讀取端切到政策脈絡（policies.lineage_id），
-- 前端、預渲染、邊緣渲染、Edge Function、協議都不再讀 related_policies，並在表上掛了擋寫入的觸發器。
-- 2026-10-09 唯讀查正式庫：related_policies 0 列、related_policies_uncovered 0 列、沒有 publication 收錄、
-- 外鍵只有它自己指向 policies（刪表不影響 policies）；依賴它的只有 policies_with_logs（related_policy_ids 欄）和 related_policies_uncovered；
-- policies_with_logs 本身沒有被別的視圖或函式引用。
--
-- 順序（依賴由外往內）：
--   ① 擋寫入的觸發器 related_policies_no_write
--   ② 視圖 related_policies_uncovered
--   ③ 視圖 policies_with_logs（CREATE OR REPLACE VIEW 拿不掉欄位，只能 DROP＋CREATE；其餘欄位與 20261009010000 那一版一字不差）
--   ④ 表 related_policies
--   ⑤ 觸發器函式 related_policies_retired()
--   ⑥ 重建 policies_with_logs（少 related_policy_ids，no_public_progress 仍是最後一欄）
-- 不動 edit_history 等歷史紀錄裡出現的表名。

-- ------------------------------------------------------------
-- 0. 前置檢查：有東西就整支退回，不刪
-- ------------------------------------------------------------
BEGIN;

CREATE TEMP TABLE _drop_rp_before AS
SELECT (SELECT count(*) FROM policies_with_logs) AS n_pwl;

DO $$
BEGIN
  IF to_regclass('public.related_policies') IS NOT NULL THEN
    IF (SELECT count(*) FROM related_policies) <> 0 THEN
      RAISE EXCEPTION '#349-B related_policies 不是空的，不刪；先讓互指進脈絡';
    END IF;
  END IF;
  IF to_regclass('public.related_policies_uncovered') IS NOT NULL THEN
    IF (SELECT count(*) FROM related_policies_uncovered) <> 0 THEN
      RAISE EXCEPTION '#349-B related_policies_uncovered 不是空的，不刪';
    END IF;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. 刪觸發器、視圖、表、函式
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS related_policies_no_write ON related_policies;
DROP VIEW IF EXISTS related_policies_uncovered;
DROP VIEW IF EXISTS policies_with_logs;
DROP TABLE IF EXISTS related_policies;
DROP FUNCTION IF EXISTS related_policies_retired();

-- ------------------------------------------------------------
-- 2. 重建 policies_with_logs：20261009010000 的現行定義，只少 related_policy_ids
-- ------------------------------------------------------------
CREATE VIEW policies_with_logs AS
SELECT
  p.*,
  COALESCE(
    (SELECT json_agg(
      json_build_object('id', tl.id, 'date', tl.date, 'event', tl.event, 'description', tl.description,
                        'sources', source_brief_list('tracking_logs', tl.id::text))
      ORDER BY tl.date
    )
    FROM tracking_logs tl
    WHERE tl.policy_id = p.id),
    '[]'::json
  ) AS logs,
  COALESCE(
    (SELECT json_agg(
      json_build_object(
        'element', e.element, 'stated', e.stated, 'text', e.text, 'deadline_date', e.deadline_date,
        'source_locator', e.source_locator, 'source_url', e.source_url, 'updated_at', e.updated_at,
        'source', (SELECT json_build_object('url', s.url, 'title', s.title, 'publisher', s.publisher,
                                            'kind', s.source_kind, 'archive_url', s.archive_url)
                     FROM source_refs r JOIN sources s ON s.id = r.source_id
                    WHERE r.target_table = 'policy_elements' AND r.target_id = e.id::text AND r.role = 'primary'
                    LIMIT 1)
      )
      ORDER BY array_position(ARRAY['target', 'deadline', 'funding'], e.element)
    )
    FROM policy_elements e
    WHERE e.policy_id = p.id),
    '[]'::json
  ) AS elements,
  (SELECT json_build_object('id', l.id, 'title', l.title, 'level', l.level, 'region', l.region, 'sub_region', l.sub_region,
                            'category', l.category, 'summary', l.summary)
     FROM lineages l WHERE l.id = p.lineage_id) AS lineage,
  source_brief_list('policies', p.id::text) AS sources,
  policy_no_public_progress(p.id) AS no_public_progress
FROM policies p;
ALTER VIEW policies_with_logs SET (security_invoker = on);
GRANT SELECT ON policies_with_logs TO anon, authenticated;
COMMENT ON VIEW policies_with_logs IS
  '政見＋進度紀錄＋三要素＋脈絡＋出處＋查無公開進度標記。新欄位一律接在最後（目前最後是 no_public_progress，#470；之前是 sources，#347 第二階段 A）；policies 加欄位時 p.* 會插在中間，要 DROP＋CREATE。'
  '#349 第二階段 B（2026-10-09）起沒有 related_policy_ids：政見之間的「相關」一律讀 lineage（政策脈絡）。'
  '#347 第二階段 B-2 起 policies 沒有 source_url 欄、logs[] 沒有舊鍵 source_url：出處一律讀 sources。no_public_progress＝這條政見的進度追蹤正處於「查無」的冷卻中（task_cooldown_settings），前端只標「查無公開進度」';

-- ------------------------------------------------------------
-- 3. 結尾自檢（對不上整支退回）
-- ------------------------------------------------------------
DO $$
DECLARE
  b RECORD;
BEGIN
  SELECT * INTO b FROM _drop_rp_before;
  IF to_regclass('public.related_policies') IS NOT NULL OR to_regclass('public.related_policies_uncovered') IS NOT NULL THEN
    RAISE EXCEPTION '#349-B related_policies 或 related_policies_uncovered 還在';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'related_policies_retired') THEN
    RAISE EXCEPTION '#349-B related_policies_retired 還在';
  END IF;
  IF (SELECT count(*) FROM policies_with_logs) <> b.n_pwl THEN
    RAISE EXCEPTION '#349-B policies_with_logs 列數變了';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'policies_with_logs' AND column_name = 'related_policy_ids') THEN
    RAISE EXCEPTION '#349-B policies_with_logs 還有 related_policy_ids';
  END IF;
  IF (SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'policies_with_logs' ORDER BY ordinal_position DESC LIMIT 1) <> 'no_public_progress' THEN
    RAISE EXCEPTION '#349-B policies_with_logs 的最後一欄不是 no_public_progress';
  END IF;
  IF NOT has_table_privilege('anon', 'public.policies_with_logs', 'SELECT') THEN
    RAISE EXCEPTION '#349-B policies_with_logs 沒給 anon 讀';
  END IF;
  IF NOT coalesce((SELECT 'security_invoker=on' = ANY (c.reloptions) FROM pg_class c WHERE c.oid = 'public.policies_with_logs'::regclass), false) THEN
    RAISE EXCEPTION '#349-B policies_with_logs 不是 security_invoker';
  END IF;
END $$;

DROP TABLE _drop_rp_before;

COMMIT;
