-- 主控台直接改派工規則：console_admin_rule_save（2026-10-13，維護者裁決）
--
-- 維護者 10-13：派工規則的開關、日期偏移、職位、上限等可以從主控台（policy-console）直接改，不必每次寫 migration；
-- 新增任務種類（新的派工臂）仍走 migration。更正 2026-10-08「規則只走 migration」，見 docs/decisions/2026-10-13-派工規則可從主控台改.md。
--
-- 寫入路徑：主控台 → Edge Function console-admin（驗 Firebase ID token、只收擁有者）→ 這支 RPC（service_role 專用）
-- → shared.dispatch_plan（20261011270000）→ 觸發器轉寫到該站的 activity_rules。所以兩站的 CHECK（窗口形狀、職位清單、
-- 優先層命名、選舉鏈欄位…）照舊擋不合法的值，updated_at 與 activity_audit 的 edit_history 稽核照舊；
-- 這支另外在同一站的 edit_history 記一筆「誰、為什麼」（field＝reason，agent_name＝console:<信箱>）。
--
-- 能改的欄位是白名單；site、id、created_at、updated_at 不能改，activity 只在新增時給。
-- 新增時 activity 必須是那一站認得的名字（派工臂、既有規則用過的活動名，或 priority: 加上它們／priority:*），
-- 拼錯就擋，免得新增一條永遠對不到任何臂的規則。

CREATE OR REPLACE FUNCTION console_admin_rule_save(
  p_site TEXT, p_id BIGINT, p_rule JSONB, p_reason TEXT, p_set_by TEXT
) RETURNS shared.dispatch_plan
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  allowed CONSTANT TEXT[] := ARRAY['activity', 'window_kind', 'from_kind', 'from_offset', 'until_kind', 'until_offset', 'min_status',
                                   'election_types', 'except_election_types', 'jurisdictions', 'levels', 'reasons', 'priority',
                                   'requires_traffic', 'after_step', 'params', 'enabled', 'note'];
  bad TEXT[];
  cur shared.dispatch_plan;
  v_row shared.dispatch_plan;
  v_id BIGINT;
  v_activity TEXT;
  base_name TEXT;
  known BOOLEAN;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  IF p_site IS NULL OR p_site NOT IN ('tw', 'jp') THEN
    RAISE EXCEPTION 'site 只能是 tw 或 jp';
  END IF;
  IF p_rule IS NULL OR jsonb_typeof(p_rule) <> 'object' THEN
    RAISE EXCEPTION 'rule 要是一個物件（要改的欄位：值）';
  END IF;
  SELECT array_agg(k ORDER BY k) INTO bad FROM jsonb_object_keys(p_rule) AS k WHERE k <> ALL (allowed);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '這些欄位不能從主控台改：%（能改的：%）', array_to_string(bad, '、'), array_to_string(allowed, '、');
  END IF;

  IF p_id IS NULL THEN
    -- 新增
    v_activity := btrim(COALESCE(p_rule->>'activity', ''));
    IF v_activity = '' THEN
      RAISE EXCEPTION '新增規則要給 activity';
    END IF;
    IF NOT (p_rule ? 'window_kind') THEN
      RAISE EXCEPTION '新增規則要給 window_kind（always／event／term／recurring）';
    END IF;
    base_name := CASE WHEN v_activity LIKE 'priority:%' THEN substr(v_activity, 10) ELSE v_activity END;
    IF p_site = 'tw' THEN
      known := base_name = '*' AND v_activity LIKE 'priority:%'
            OR base_name = ANY (public.activity_arm_names())
            OR EXISTS (SELECT 1 FROM public.activity_rules r WHERE r.activity IN (base_name, v_activity));
    ELSE
      known := base_name = '*' AND v_activity LIKE 'priority:%'
            OR base_name = ANY (policy_jp.activity_arm_names())
            OR EXISTS (SELECT 1 FROM policy_jp.activity_rules r WHERE r.activity IN (base_name, v_activity));
    END IF;
    IF NOT known THEN
      RAISE EXCEPTION '「%」不是%站認得的任務名（要新增一種任務，得先寫派工臂，走 migration）', v_activity, CASE p_site WHEN 'tw' THEN '台灣' ELSE '日本' END;
    END IF;

    INSERT INTO shared.dispatch_plan
      SELECT * FROM jsonb_populate_record(NULL::shared.dispatch_plan, p_rule || jsonb_build_object('site', p_site, 'activity', v_activity))
    RETURNING id INTO v_id;
  ELSE
    -- 修改：只動有給的欄位
    IF p_rule ? 'activity' THEN
      RAISE EXCEPTION '既有規則的 activity 不能改（要換任務就停用這條、另外新增）';
    END IF;
    SELECT * INTO cur FROM shared.dispatch_plan WHERE site = p_site AND id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '找不到%站的規則 %', CASE p_site WHEN 'tw' THEN '台灣' ELSE '日本' END, p_id;
    END IF;
    SELECT * INTO v_row FROM jsonb_populate_record(cur, p_rule);
    UPDATE shared.dispatch_plan
       SET window_kind = v_row.window_kind, from_kind = v_row.from_kind, from_offset = v_row.from_offset,
           until_kind = v_row.until_kind, until_offset = v_row.until_offset, min_status = v_row.min_status,
           election_types = v_row.election_types, except_election_types = v_row.except_election_types,
           jurisdictions = v_row.jurisdictions, levels = v_row.levels, reasons = v_row.reasons, priority = v_row.priority,
           requires_traffic = v_row.requires_traffic, after_step = v_row.after_step, params = v_row.params,
           enabled = v_row.enabled, note = v_row.note
     WHERE site = p_site AND id = p_id;
    v_id := p_id;
  END IF;

  -- 誰、為什麼（activity_audit 已經記了改前改後，這一筆補上理由）
  IF p_site = 'tw' THEN
    INSERT INTO public.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES ('activity_rules', v_id::TEXT, 'reason', NULL, to_jsonb(btrim(p_reason)), 'console:' || COALESCE(p_set_by, '未知'));
  ELSE
    INSERT INTO policy_jp.edit_history (table_name, record_id, field, old_value, new_value, agent_name)
    VALUES ('activity_rules', v_id::TEXT, 'reason', NULL, to_jsonb(btrim(p_reason)), 'console:' || COALESCE(p_set_by, '未知'));
  END IF;

  SELECT * INTO v_row FROM shared.dispatch_plan WHERE site = p_site AND id = v_id;
  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION console_admin_rule_save(TEXT, BIGINT, JSONB, TEXT, TEXT) IS
  '主控台新增（p_id 為 NULL）或修改一條派工規則（2026-10-13 維護者裁決：規則的值可從主控台改，新任務種類仍走 migration）。'
  '經 shared.dispatch_plan 寫回該站 activity_rules，CHECK 與稽核照舊；另記一筆理由進該站 edit_history。只給 service_role（console-admin 驗過擁有者才呼叫）。';

REVOKE ALL ON FUNCTION console_admin_rule_save(TEXT, BIGINT, JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_admin_rule_save(TEXT, BIGINT, JSONB, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION console_admin_rule_save(TEXT, BIGINT, JSONB, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION console_admin_rule_save(TEXT, BIGINT, JSONB, TEXT, TEXT) TO service_role;
