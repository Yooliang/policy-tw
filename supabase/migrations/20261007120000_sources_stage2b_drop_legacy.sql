-- #347 第二階段 B-2：刪舊的出處欄位、舊表與同步觸發器（policies.source_url、tracking_logs.source_url、policy_sources、
-- 四支 sources_sync_* 觸發器與函式）。**刪欄位不可復原**——前置條件沒達到不要合（見 PR 描述與 docs/DECISIONS.md 2026-10-07）：
--   (1) B-1（20261007110000，程式與派工函式都不再讀寫這些欄位）已合併、三段部署都綠、**上線跑過一輪**；
--   (2) 新的直接寫入路徑（落庫 source_write()、correction 的 source_set_primary()）在正式環境真的跑過——
--       10-07 唯讀查證：第二階段 A 上線後正式環境還沒有任何一筆政見／進度／參選紀錄落庫走過它；
--   (3) source_refs_drift 是空的、policy_sources 仍是 0 列（這支自己也會擋：不是就整支退回，不是警告）。
--
-- 做了什麼：
--   ① 切之前的核對（硬擋）：新舊兩邊逐條一致、policy_sources 是空的、B-1 的登記觸發器在
--   ② 刪四支同步觸發器與函式（sources_sync_policy／tracking_log／policy_source／contribution）。
--      sources_sync_contribution 兼做的「交件當下登記選舉公報、選委會公告網址」已由 B-1 的 sources_register_contribution 接手
--   ③ 重建 trg_policies_updated_at：更新觸發的欄位清單拿掉 source_url（不重建 DROP COLUMN 會被依賴擋住）
--   ④ 視圖：policies_with_logs DROP＋CREATE（p.* 少一欄 source_url、logs[] 拿掉舊鍵 source_url；補回 security_invoker 與授權）；
--      source_refs_drift 改成不依賴舊欄位的版本（只留「一條政見／進度有兩個以上的主要出處」與「引用指到已不存在的資料」）
--   ⑤ 刪舊表 policy_sources（0 列）、刪兩個欄位
--   ⑥ 結尾自檢：欄位與表都不在、觸發器都不在、視圖欄位與列數、主要出處引用筆數、派工臂還能跑、授權在，對不上整支退回
--
-- 不動的：source_refs／sources 與它們的觸發器（policy_elements、lineage_* 各自的 source_url 同步，那是別張表自己的欄位）。

BEGIN;

-- ── ① 切之前的核對（硬擋）──────────────────────────────────
CREATE TEMP TABLE _b347 AS
SELECT
  (SELECT count(*) FROM policies_with_logs) AS n_pwl,
  (SELECT count(*) FROM source_refs WHERE target_table = 'policies' AND role = 'primary') AS n_pol_primary,
  (SELECT count(*) FROM source_refs WHERE target_table = 'tracking_logs' AND role = 'primary') AS n_log_primary,
  (SELECT count(*) FROM sources) AS n_sources,
  (SELECT count(*) FROM source_refs) AS n_refs;

DO $$
DECLARE
  v_drift INTEGER;
  v_ps INTEGER;
BEGIN
  SELECT count(*) INTO v_drift FROM source_refs_drift;
  IF v_drift > 0 THEN
    RAISE EXCEPTION '#347-B2 出處新舊兩邊還有 % 項對不上（看 source_refs_drift），不刪欄位', v_drift;
  END IF;
  SELECT count(*) INTO v_ps FROM policy_sources;
  IF v_ps > 0 THEN
    RAISE EXCEPTION '#347-B2 policy_sources 還有 % 列資料，不刪（先確認它們都在出處表裡）', v_ps;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.contributions'::regclass AND tgname = 'trg_sources_register_contribution') THEN
    RAISE EXCEPTION '#347-B2 B-1 的 trg_sources_register_contribution 不在——交件當下登記公報網址的功能刪了就沒人接，先上 B-1';
  END IF;
  IF to_regprocedure('source_set_primary(text,text,text,text)') IS NULL OR to_regprocedure('policy_primary_url(uuid)') IS NULL THEN
    RAISE EXCEPTION '#347-B2 B-1 的 source_set_primary／policy_primary_url 不在，先上 B-1';
  END IF;
END $$;

-- ── ② 同步觸發器與函式 ──────────────────────────────────────
DROP TRIGGER IF EXISTS trg_sources_sync_policy ON policies;
DROP TRIGGER IF EXISTS trg_sources_sync_tracking_log ON tracking_logs;
DROP TRIGGER IF EXISTS trg_sources_sync_policy_source ON policy_sources;
DROP TRIGGER IF EXISTS trg_sources_sync_contribution ON contributions;
DROP FUNCTION IF EXISTS sources_sync_policy();
DROP FUNCTION IF EXISTS sources_sync_tracking_log();
DROP FUNCTION IF EXISTS sources_sync_policy_source();
DROP FUNCTION IF EXISTS sources_sync_contribution();

-- ── ③ 更新時間觸發器：欄位清單拿掉 source_url ────────────────
DROP TRIGGER IF EXISTS trg_policies_updated_at ON policies;
CREATE TRIGGER trg_policies_updated_at
  BEFORE UPDATE OF title, description, category, status, proposed_date, last_updated, progress, tags, election_id, politician_id, removed_at ON policies
  FOR EACH ROW EXECUTE FUNCTION policies_touch_updated_at();

-- ── ④ 視圖 ──────────────────────────────────────────────────
-- 核對視圖：不再依賴舊欄位。舊兩邊的比對（policy_url_not_in_refs 等）隨舊欄位結束；留下兩項與舊欄位無關的完整性檢查
CREATE OR REPLACE VIEW source_refs_drift AS
WITH pol AS (
  SELECT r.target_id, count(*) AS n, min(s.url) AS url
    FROM source_refs r JOIN sources s ON s.id = r.source_id
   WHERE r.target_table = 'policies' AND r.role = 'primary' GROUP BY r.target_id
), lg AS (
  SELECT r.target_id, count(*) AS n, min(s.url) AS url
    FROM source_refs r JOIN sources s ON s.id = r.source_id
   WHERE r.target_table = 'tracking_logs' AND r.role = 'primary' GROUP BY r.target_id
)
SELECT 'policy_multi_primary'::TEXT AS problem, 'policies'::TEXT AS target_table, pol.target_id AS target_id, pol.url AS url FROM pol WHERE pol.n > 1
UNION ALL
SELECT 'log_multi_primary', 'tracking_logs', lg.target_id, lg.url FROM lg WHERE lg.n > 1
UNION ALL
SELECT 'dangling_ref', r.target_table, r.target_id, NULL
  FROM source_refs r
 WHERE (r.target_table = 'policies' AND NOT EXISTS (SELECT 1 FROM policies p WHERE p.id::TEXT = r.target_id))
    OR (r.target_table = 'tracking_logs' AND NOT EXISTS (SELECT 1 FROM tracking_logs t WHERE t.id::TEXT = r.target_id));
ALTER VIEW source_refs_drift SET (security_invoker = on);
COMMENT ON VIEW source_refs_drift IS
  '出處引用的完整性檢查，正常是空的：一條政見或進度有兩個以上的主要出處（policy_multi_primary／log_multi_primary）、引用指到已經不存在的政見或進度（dangling_ref）。舊欄位 policies.source_url／tracking_logs.source_url 與 policy_sources 已在 #347 第二階段 B-2 刪除，新舊對照的項目隨之結束';

-- policies_with_logs：先 DROP（它的 p.* 展開了 source_url，不拿掉會擋住 DROP COLUMN），欄位刪掉之後在 ⑤b 重建。沒有別的視圖依賴它（2026-10-07 pg_depend 查過）
DROP VIEW IF EXISTS policies_with_logs;

-- ── ⑤ 刪舊表與欄位 ──────────────────────────────────────────
DROP TABLE policy_sources;
ALTER TABLE policies DROP COLUMN source_url;
ALTER TABLE tracking_logs DROP COLUMN source_url;

-- ── ⑤b 重建 policies_with_logs：p.* 少一欄 source_url、logs[] 拿掉舊鍵 source_url；其餘一字不差（20261006210000）──
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
    (SELECT json_agg(rp.related_policy_id)
     FROM related_policies rp
     WHERE rp.policy_id = p.id),
    '[]'::json
  ) AS related_policy_ids,
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
  source_brief_list('policies', p.id::text) AS sources
FROM policies p;
ALTER VIEW policies_with_logs SET (security_invoker = on);
GRANT SELECT ON policies_with_logs TO anon, authenticated;
COMMENT ON VIEW policies_with_logs IS
  '政見＋進度紀錄＋相關政見＋三要素＋脈絡＋出處。新欄位一律接在最後（目前最後是 sources，#347 第二階段 A）；policies 加欄位時 p.* 會插在中間，要 DROP＋CREATE。#347 第二階段 B-2 起 policies 沒有 source_url 欄、logs[] 沒有舊鍵 source_url：出處一律讀 sources';

-- ── ⑥ 結尾自檢（對不上整支退回）─────────────────────────────
DO $$
DECLARE
  b _b347%ROWTYPE;
  v_n INTEGER;
  v_bad TEXT;
BEGIN
  SELECT * INTO b FROM _b347;

  SELECT string_agg(table_name || '.' || column_name, '、') INTO v_bad FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('policies', 'tracking_logs', 'policies_with_logs') AND column_name = 'source_url';
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '#347-B2 這些欄位還在：%', v_bad; END IF;
  IF to_regclass('public.policy_sources') IS NOT NULL THEN RAISE EXCEPTION '#347-B2 policy_sources 還在'; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
             ('trg_sources_sync_policy', 'trg_sources_sync_tracking_log', 'trg_sources_sync_policy_source', 'trg_sources_sync_contribution')) THEN
    RAISE EXCEPTION '#347-B2 舊的同步觸發器還在';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('sources_sync_policy', 'sources_sync_tracking_log', 'sources_sync_policy_source', 'sources_sync_contribution')) THEN
    RAISE EXCEPTION '#347-B2 舊的同步函式還在';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.policies'::regclass AND tgname = 'trg_policies_updated_at'
                    AND pg_get_triggerdef(oid) NOT LIKE '%source_url%') THEN
    RAISE EXCEPTION '#347-B2 trg_policies_updated_at 不在或還提到 source_url';
  END IF;

  -- 內容沒變：視圖列數、出處與引用筆數
  SELECT count(*) INTO v_n FROM policies_with_logs;
  IF v_n <> b.n_pwl THEN RAISE EXCEPTION '#347-B2 policies_with_logs 筆數變了：% → %', b.n_pwl, v_n; END IF;
  SELECT count(*) INTO v_n FROM source_refs WHERE target_table = 'policies' AND role = 'primary';
  IF v_n <> b.n_pol_primary THEN RAISE EXCEPTION '#347-B2 政見的主要出處引用變了：% → %', b.n_pol_primary, v_n; END IF;
  SELECT count(*) INTO v_n FROM source_refs WHERE target_table = 'tracking_logs' AND role = 'primary';
  IF v_n <> b.n_log_primary THEN RAISE EXCEPTION '#347-B2 進度的主要出處引用變了：% → %', b.n_log_primary, v_n; END IF;
  IF (SELECT count(*) FROM sources) <> b.n_sources OR (SELECT count(*) FROM source_refs) <> b.n_refs THEN
    RAISE EXCEPTION '#347-B2 sources／source_refs 的筆數變了（這支不該動它們）';
  END IF;
  SELECT count(*) INTO v_n FROM source_refs_drift;
  IF v_n > 0 THEN RAISE EXCEPTION '#347-B2 source_refs_drift 不是空的（% 項）', v_n; END IF;

  -- 視圖欄位：最後一欄是 sources、logs 的鍵沒有 source_url
  IF (SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'policies_with_logs'
       ORDER BY ordinal_position DESC LIMIT 1) <> 'sources' THEN
    RAISE EXCEPTION '#347-B2 policies_with_logs 的最後一欄不是 sources';
  END IF;
  IF EXISTS (SELECT 1 FROM policies_with_logs w, json_array_elements(w.logs) l WHERE l::jsonb ? 'source_url') THEN
    RAISE EXCEPTION '#347-B2 policies_with_logs.logs 還帶舊鍵 source_url';
  END IF;

  -- 派工臂（B-1 改讀 policy_primary_url）刪欄位之後還能跑
  SELECT count(*) INTO v_n FROM contribution_auto_tasks_raw();
  SELECT count(*) INTO v_n FROM contribution_auto_tasks_legacy();
  SELECT count(*) INTO v_n FROM contribution_auto_tasks_mismatch();
  SELECT count(*) INTO v_n FROM contribution_auto_tasks_policy_elements();

  -- 授權
  IF NOT has_table_privilege('anon', 'public.policies_with_logs', 'SELECT') OR NOT has_table_privilege('authenticated', 'public.policies_with_logs', 'SELECT')
     OR NOT has_table_privilege('anon', 'public.source_refs_drift', 'SELECT') THEN
    RAISE EXCEPTION '#347-B2 視圖授權沒補回來';
  END IF;
  IF (SELECT c.reloptions::text FROM pg_class c WHERE c.oid = 'public.policies_with_logs'::regclass) IS DISTINCT FROM '{security_invoker=on}'
     OR (SELECT c.reloptions::text FROM pg_class c WHERE c.oid = 'public.source_refs_drift'::regclass) IS DISTINCT FROM '{security_invoker=on}' THEN
    RAISE EXCEPTION '#347-B2 視圖的 security_invoker 沒補回來';
  END IF;

  RAISE NOTICE '#347-B2 完成：舊欄位、舊表、同步觸發器已刪；政見 % 條（主要出處 % 個）、進度主要出處 % 個、sources % 筆、引用 % 筆，內容與刪之前一致',
    b.n_pwl, b.n_pol_primary, b.n_log_primary, b.n_sources, b.n_refs;
END $$;

DROP TABLE _b347;

COMMIT;
