-- 統一派工總表第一步：shared.dispatch_plan（2026-10-13，維護者裁決「兩站共用的放 shared」）
--
-- 設計草稿：project-files notes/統一派工總表-設計草稿.md。目標是之後新增一條派工規則、一場選舉、一個地區，
-- 都只要加資料列。這一步只做「一個地方看到、改到兩站全部的派工規則」，派工引擎一行不動：
--
--   1. 新 schema shared：兩站共用的東西放這裡（台灣留在 public 不搬，日本留在 policy_jp）。
--   2. 視圖 shared.dispatch_plan：public.activity_rules（site＝tw）與 policy_jp.activity_rules（site＝jp）一列一條規則，
--      欄位取兩邊的聯集（台灣專用的 except_election_types、requires_traffic，日本專用的 after_step；另一站填 NULL／false）。
--   3. 透過視圖寫入：INSTEAD OF 觸發器依 site 轉寫到那一站的 activity_rules，所以兩站原本的 CHECK、外鍵、
--      updated_at、edit_history 稽核（activity_audit）全部照舊生效；site 不能改、另一站專用的欄位不能填。
--
-- 為什麼是視圖、不是把兩張表搬成一張實體表：兩站的 activity_rules 被 activity_open()、activity_priority()、
-- 健康檢查視圖、選舉鏈視圖、46 個測試與日本站的走樣守門直接讀寫，規則 id 也寫在 gap_events／opened_by 裡。
-- 搬成實體表要重建依賴它的視圖、改兩站的稽核與外鍵，風險大、換來的只是實體上少一張表。視圖做法讓「總表」
-- 立刻統一，引擎與所有既有行為不變；之後要不要實體合併，等第二步（臂改讀總表）做完再看。
--
-- 權限：anon／authenticated 只能讀（主控台要看兩國的規則；規則本身不含個資，台灣那張本來就公開讀）。
-- 寫入只給 service_role（照「規則只走 migration」，主控台直接改要等維護者另外裁決）。
-- 視圖不用 security_invoker：日本那張沒有開給 anon，用呼叫者權限讀會整個視圖失敗；寫入走觸發器、用呼叫者權限，
-- 所以 service_role 以外的角色寫不進去（沒有視圖的寫入權限，也沒有底下兩張表的權限）。
--
-- ⚠️ PostgREST 要讀到它，Supabase 的 Exposed schemas 要加上 shared（儀表板設定，不在 migration 裡）。

CREATE SCHEMA IF NOT EXISTS shared;
COMMENT ON SCHEMA shared IS '兩站（正見 public、日本站 policy_jp）共用的設定與規則。2026-10-13 維護者裁決：台灣留在 public 不搬，兩站共用的東西一律放這裡。';
GRANT USAGE ON SCHEMA shared TO anon, authenticated, service_role;

CREATE OR REPLACE VIEW shared.dispatch_plan AS
  SELECT 'tw'::TEXT AS site, r.id, r.activity, r.window_kind, r.from_kind, r.from_offset, r.until_kind, r.until_offset, r.min_status,
         r.recur_months, r.reasons, r.levels, r.election_types, r.except_election_types, r.jurisdictions, r.priority,
         r.requires_traffic, NULL::TEXT AS after_step, r.params, r.enabled, r.note, r.created_at, r.updated_at
    FROM public.activity_rules r
  UNION ALL
  SELECT 'jp'::TEXT, r.id, r.activity, r.window_kind, r.from_kind, r.from_offset, r.until_kind, r.until_offset, r.min_status,
         r.recur_months, r.reasons, r.levels, r.election_types, NULL::TEXT[], r.jurisdictions, r.priority,
         false, r.after_step, r.params, r.enabled, r.note, r.created_at, r.updated_at
    FROM policy_jp.activity_rules r;

COMMENT ON VIEW shared.dispatch_plan IS
  '兩站的派工規則總表（一列一條規則，site＝tw／jp，id 是那一站 activity_rules 的 id）。讀：一個地方看兩國全部規則。'
  '寫：INSERT／UPDATE／DELETE 由觸發器轉寫到該站的 activity_rules（CHECK、稽核照舊），site 不能改。'
  '派工引擎仍讀各站的 activity_rules；這是統一派工總表的第一步（2026-10-13）。';

-- ------------------------------------------------------------
-- 寫入：依 site 轉寫到那一站的 activity_rules
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION shared.dispatch_plan_write() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  s TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD.site ELSE NEW.site END;
  new_id BIGINT;
BEGIN
  IF s IS NULL OR s NOT IN ('tw', 'jp') THEN
    RAISE EXCEPTION 'dispatch_plan：site 只能是 tw 或 jp（收到 %）', COALESCE(s, 'NULL');
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.site IS DISTINCT FROM OLD.site THEN
    RAISE EXCEPTION 'dispatch_plan：規則不能換站（% → %），要搬就刪掉再新增', OLD.site, NEW.site;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'dispatch_plan：規則 id 不能改（gap_events 與 opened_by 記著它）';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF s = 'jp' AND (NEW.except_election_types IS NOT NULL OR COALESCE(NEW.requires_traffic, false)) THEN
      RAISE EXCEPTION 'dispatch_plan：except_election_types、requires_traffic 是台灣專用的欄位，日本的規則不能填';
    END IF;
    IF s = 'tw' AND NEW.after_step IS NOT NULL THEN
      RAISE EXCEPTION 'dispatch_plan：after_step（選舉鏈）是日本專用的欄位，台灣的規則不能填';
    END IF;
  END IF;

  IF s = 'tw' THEN
    IF TG_OP = 'INSERT' THEN
      INSERT INTO public.activity_rules (id, activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, recur_months,
                                         reasons, levels, election_types, except_election_types, jurisdictions, priority, requires_traffic,
                                         params, enabled, note)
      VALUES (COALESCE(NEW.id, nextval(pg_get_serial_sequence('public.activity_rules', 'id'))), NEW.activity, NEW.window_kind, NEW.from_kind,
              COALESCE(NEW.from_offset, 0), NEW.until_kind, COALESCE(NEW.until_offset, 0), COALESCE(NEW.min_status, 'announced'), NEW.recur_months,
              NEW.reasons, NEW.levels, NEW.election_types, NEW.except_election_types, NEW.jurisdictions, NEW.priority,
              COALESCE(NEW.requires_traffic, false), COALESCE(NEW.params, '{}'::JSONB), COALESCE(NEW.enabled, true), NEW.note)
      RETURNING id INTO new_id;
    ELSIF TG_OP = 'UPDATE' THEN
      UPDATE public.activity_rules SET activity = NEW.activity, window_kind = NEW.window_kind, from_kind = NEW.from_kind, from_offset = NEW.from_offset,
             until_kind = NEW.until_kind, until_offset = NEW.until_offset, min_status = NEW.min_status, recur_months = NEW.recur_months,
             reasons = NEW.reasons, levels = NEW.levels, election_types = NEW.election_types, except_election_types = NEW.except_election_types,
             jurisdictions = NEW.jurisdictions, priority = NEW.priority, requires_traffic = NEW.requires_traffic, params = NEW.params,
             enabled = NEW.enabled, note = NEW.note
       WHERE id = OLD.id;
    ELSE
      DELETE FROM public.activity_rules WHERE id = OLD.id;
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      INSERT INTO policy_jp.activity_rules (id, activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, recur_months,
                                            reasons, levels, election_types, jurisdictions, priority, after_step, params, enabled, note)
      VALUES (COALESCE(NEW.id, nextval(pg_get_serial_sequence('policy_jp.activity_rules', 'id'))), NEW.activity, NEW.window_kind, NEW.from_kind,
              COALESCE(NEW.from_offset, 0), NEW.until_kind, COALESCE(NEW.until_offset, 0), COALESCE(NEW.min_status, 'announced'), NEW.recur_months,
              NEW.reasons, NEW.levels, NEW.election_types, NEW.jurisdictions, NEW.priority, NEW.after_step,
              COALESCE(NEW.params, '{}'::JSONB), COALESCE(NEW.enabled, true), NEW.note)
      RETURNING id INTO new_id;
    ELSIF TG_OP = 'UPDATE' THEN
      UPDATE policy_jp.activity_rules SET activity = NEW.activity, window_kind = NEW.window_kind, from_kind = NEW.from_kind, from_offset = NEW.from_offset,
             until_kind = NEW.until_kind, until_offset = NEW.until_offset, min_status = NEW.min_status, recur_months = NEW.recur_months,
             reasons = NEW.reasons, levels = NEW.levels, election_types = NEW.election_types, jurisdictions = NEW.jurisdictions,
             priority = NEW.priority, after_step = NEW.after_step, params = NEW.params, enabled = NEW.enabled, note = NEW.note
       WHERE id = OLD.id;
    ELSE
      DELETE FROM policy_jp.activity_rules WHERE id = OLD.id;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.id := new_id;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION shared.dispatch_plan_write() IS
  'shared.dispatch_plan 的 INSTEAD OF 觸發器：依 site 轉寫到 public／policy_jp 的 activity_rules。用呼叫者權限（SECURITY INVOKER），所以只有寫得進底下那張表的角色寫得進來。';

DROP TRIGGER IF EXISTS trg_dispatch_plan_write ON shared.dispatch_plan;
CREATE TRIGGER trg_dispatch_plan_write INSTEAD OF INSERT OR UPDATE OR DELETE ON shared.dispatch_plan
  FOR EACH ROW EXECUTE FUNCTION shared.dispatch_plan_write();

REVOKE ALL ON shared.dispatch_plan FROM PUBLIC, anon, authenticated;
GRANT SELECT ON shared.dispatch_plan TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON shared.dispatch_plan TO service_role;
REVOKE ALL ON FUNCTION shared.dispatch_plan_write() FROM PUBLIC, anon, authenticated;

-- 自我檢查：兩站每一條規則在總表裡剛好一列、內容一致
DO $$
DECLARE
  n_tw BIGINT; n_jp BIGINT; n_plan BIGINT; n_bad BIGINT;
BEGIN
  SELECT count(*) INTO n_tw FROM public.activity_rules;
  SELECT count(*) INTO n_jp FROM policy_jp.activity_rules;
  SELECT count(*) INTO n_plan FROM shared.dispatch_plan;
  IF n_plan <> n_tw + n_jp THEN
    RAISE EXCEPTION 'dispatch_plan 自我檢查：總表 % 列，兩站合計 % 列', n_plan, n_tw + n_jp;
  END IF;
  SELECT count(*) INTO n_bad
    FROM shared.dispatch_plan p
    LEFT JOIN public.activity_rules t ON p.site = 'tw' AND t.id = p.id
    LEFT JOIN policy_jp.activity_rules j ON p.site = 'jp' AND j.id = p.id
   WHERE COALESCE(t.activity, j.activity) IS DISTINCT FROM p.activity
      OR COALESCE(t.params, j.params) IS DISTINCT FROM p.params
      OR COALESCE(t.enabled, j.enabled) IS DISTINCT FROM p.enabled;
  IF n_bad > 0 THEN
    RAISE EXCEPTION 'dispatch_plan 自我檢查：% 列跟來源對不上', n_bad;
  END IF;
END;
$$;
