/**
 * shared.dispatch_plan 的 PGlite 測試環境：兩站 activity_rules 的精簡版（跟正式庫同欄位，只放測試要驗的 CHECK、稽核觸發器、RLS）。
 * 給 shared-dispatch-plan.test.ts 與 console-admin-rule-save.test.ts 共用。不是測試檔，deno test 不會單獨跑它。
 */
export const BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA policy_jp;
  GRANT USAGE ON SCHEMA policy_jp TO service_role;

  CREATE TABLE edit_history (table_name TEXT, record_id TEXT, old_value JSONB, new_value JSONB, field TEXT, agent_name TEXT);
  CREATE TABLE policy_jp.edit_history (table_name TEXT, record_id TEXT, old_value JSONB, new_value JSONB, field TEXT, agent_name TEXT);
  GRANT ALL ON edit_history, policy_jp.edit_history TO service_role;
  CREATE FUNCTION activity_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO public.edit_history VALUES (TG_TABLE_NAME, COALESCE(to_jsonb(NEW), to_jsonb(OLD))->>'id',
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
    RETURN COALESCE(NEW, OLD);
  END $$;
  CREATE FUNCTION policy_jp.activity_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    INSERT INTO policy_jp.edit_history VALUES (TG_TABLE_NAME, COALESCE(to_jsonb(NEW), to_jsonb(OLD))->>'id',
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END, CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
    RETURN COALESCE(NEW, OLD);
  END $$;

  CREATE TABLE activity_rules (
    id BIGSERIAL PRIMARY KEY, activity TEXT NOT NULL,
    window_kind TEXT NOT NULL CHECK (window_kind IN ('event', 'term', 'recurring', 'always')),
    from_kind TEXT, from_offset INTEGER NOT NULL DEFAULT 0, until_kind TEXT, until_offset INTEGER NOT NULL DEFAULT 0,
    min_status TEXT NOT NULL DEFAULT 'announced', recur_months INT4RANGE, reasons TEXT[], levels TEXT[],
    election_types TEXT[] CHECK (election_types IS NULL OR election_types <@ ARRAY['縣市長', '村里長']::TEXT[]),
    jurisdictions TEXT[], params JSONB NOT NULL DEFAULT '{}'::JSONB, enabled BOOLEAN NOT NULL DEFAULT true, note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    priority SMALLINT, except_election_types TEXT[], requires_traffic BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT activity_rules_priority_namespace CHECK ((activity LIKE 'priority:%') = (priority IS NOT NULL))
  );
  ALTER TABLE activity_rules ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Public read" ON activity_rules FOR SELECT USING (true);
  GRANT ALL ON activity_rules TO anon, authenticated, service_role;
  GRANT USAGE ON SEQUENCE activity_rules_id_seq TO anon, authenticated, service_role;
  CREATE TRIGGER trg_activity_rules_audit AFTER INSERT OR UPDATE OR DELETE ON activity_rules FOR EACH ROW EXECUTE FUNCTION activity_audit();

  CREATE TABLE policy_jp.activity_rules (
    id BIGSERIAL PRIMARY KEY, activity TEXT NOT NULL,
    window_kind TEXT NOT NULL CHECK (window_kind IN ('event', 'always')),
    from_kind TEXT, from_offset INTEGER NOT NULL DEFAULT 0, until_kind TEXT, until_offset INTEGER NOT NULL DEFAULT 0,
    min_status TEXT NOT NULL DEFAULT 'announced', recur_months INT4RANGE, reasons TEXT[], levels TEXT[],
    election_types TEXT[] CHECK (election_types IS NULL OR election_types <@ ARRAY['mayor', 'governor']::TEXT[]),
    jurisdictions TEXT[], params JSONB NOT NULL DEFAULT '{}'::JSONB, enabled BOOLEAN NOT NULL DEFAULT true, note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    priority SMALLINT, after_step TEXT
  );
  ALTER TABLE policy_jp.activity_rules ENABLE ROW LEVEL SECURITY;
  GRANT ALL ON policy_jp.activity_rules TO service_role;
  GRANT USAGE ON SEQUENCE policy_jp.activity_rules_id_seq TO service_role;
  CREATE TRIGGER trg_activity_rules_audit AFTER INSERT OR UPDATE OR DELETE ON policy_jp.activity_rules FOR EACH ROW EXECUTE FUNCTION policy_jp.activity_audit();

  INSERT INTO activity_rules (activity, window_kind, until_kind, election_types) VALUES ('raw:policy_missing', 'event', 'polling', NULL);
  INSERT INTO activity_rules (activity, window_kind, priority) VALUES ('priority:*', 'always', 1);
  INSERT INTO activity_rules (activity, window_kind, except_election_types, requires_traffic) VALUES ('deadline_due', 'always', ARRAY['村里長'], false);
  INSERT INTO policy_jp.activity_rules (activity, window_kind, after_step, params) VALUES ('roster_check', 'always', 'region', '{"cap": 200}');
`;
