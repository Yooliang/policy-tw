-- 主控台規則總表：日本的規則也有優先秒數（2026-10-13，接在 20261011360000_policy_jp_queue_priority_seconds.sql 後面；
-- 那一支給 policy_jp.activity_rules 加了 priority_seconds，這支讓 shared.dispatch_plan 帶出來、寫入不再擋）
-- 只動 shared.dispatch_plan 與它的寫入觸發器；console_admin_rule_save 本來就把 priority_seconds 當可改欄位，不用改。
-- 跟 20261011360000 分開，是因為日本站的測試環境只載 policy_jp 的 migration，而這個視圖讀 public.activity_rules。

-- ------------------------------------------------------------
-- 主控台：日本的規則也有 priority_seconds（以正見 20261011320000 的定義為底：日本那一支給 r.priority_seconds、寫入不再擋、INSERT／UPDATE 帶這欄）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW shared.dispatch_plan AS
  SELECT 'tw'::TEXT AS site, r.id, r.activity, r.window_kind, r.from_kind, r.from_offset, r.until_kind, r.until_offset, r.min_status,
         r.recur_months, r.reasons, r.levels, r.election_types, r.except_election_types, r.jurisdictions, r.priority,
         r.requires_traffic, NULL::TEXT AS after_step, r.params, r.enabled, r.note, r.created_at, r.updated_at, r.priority_seconds
    FROM public.activity_rules r
  UNION ALL
  SELECT 'jp'::TEXT, r.id, r.activity, r.window_kind, r.from_kind, r.from_offset, r.until_kind, r.until_offset, r.min_status,
         r.recur_months, r.reasons, r.levels, r.election_types, NULL::TEXT[], r.jurisdictions, r.priority,
         false, r.after_step, r.params, r.enabled, r.note, r.created_at, r.updated_at, r.priority_seconds
    FROM policy_jp.activity_rules r;

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
                                         params, enabled, note, priority_seconds)
      VALUES (COALESCE(NEW.id, nextval(pg_get_serial_sequence('public.activity_rules', 'id'))), NEW.activity, NEW.window_kind, NEW.from_kind,
              COALESCE(NEW.from_offset, 0), NEW.until_kind, COALESCE(NEW.until_offset, 0), COALESCE(NEW.min_status, 'announced'), NEW.recur_months,
              NEW.reasons, NEW.levels, NEW.election_types, NEW.except_election_types, NEW.jurisdictions, NEW.priority,
              COALESCE(NEW.requires_traffic, false), COALESCE(NEW.params, '{}'::JSONB), COALESCE(NEW.enabled, true), NEW.note, NEW.priority_seconds)
      RETURNING id INTO new_id;
    ELSIF TG_OP = 'UPDATE' THEN
      UPDATE public.activity_rules SET activity = NEW.activity, window_kind = NEW.window_kind, from_kind = NEW.from_kind, from_offset = NEW.from_offset,
             until_kind = NEW.until_kind, until_offset = NEW.until_offset, min_status = NEW.min_status, recur_months = NEW.recur_months,
             reasons = NEW.reasons, levels = NEW.levels, election_types = NEW.election_types, except_election_types = NEW.except_election_types,
             jurisdictions = NEW.jurisdictions, priority = NEW.priority, requires_traffic = NEW.requires_traffic, params = NEW.params,
             enabled = NEW.enabled, note = NEW.note, priority_seconds = NEW.priority_seconds
       WHERE id = OLD.id;
    ELSE
      DELETE FROM public.activity_rules WHERE id = OLD.id;
    END IF;
  ELSE
    IF TG_OP = 'INSERT' THEN
      INSERT INTO policy_jp.activity_rules (id, activity, window_kind, from_kind, from_offset, until_kind, until_offset, min_status, recur_months,
                                            reasons, levels, election_types, jurisdictions, priority, after_step, params, enabled, note, priority_seconds)
      VALUES (COALESCE(NEW.id, nextval(pg_get_serial_sequence('policy_jp.activity_rules', 'id'))), NEW.activity, NEW.window_kind, NEW.from_kind,
              COALESCE(NEW.from_offset, 0), NEW.until_kind, COALESCE(NEW.until_offset, 0), COALESCE(NEW.min_status, 'announced'), NEW.recur_months,
              NEW.reasons, NEW.levels, NEW.election_types, NEW.jurisdictions, NEW.priority, NEW.after_step,
              COALESCE(NEW.params, '{}'::JSONB), COALESCE(NEW.enabled, true), NEW.note, NEW.priority_seconds)
      RETURNING id INTO new_id;
    ELSIF TG_OP = 'UPDATE' THEN
      UPDATE policy_jp.activity_rules SET activity = NEW.activity, window_kind = NEW.window_kind, from_kind = NEW.from_kind, from_offset = NEW.from_offset,
             until_kind = NEW.until_kind, until_offset = NEW.until_offset, min_status = NEW.min_status, recur_months = NEW.recur_months,
             reasons = NEW.reasons, levels = NEW.levels, election_types = NEW.election_types, jurisdictions = NEW.jurisdictions,
             priority = NEW.priority, after_step = NEW.after_step, params = NEW.params, enabled = NEW.enabled, note = NEW.note,
             priority_seconds = NEW.priority_seconds
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

NOTIFY pgrst, 'reload schema';
