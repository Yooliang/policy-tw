-- 日本站（policy_jp）主控台手動調整派工開關與選舉日期（#518 第二步，2026-10-10）
-- ============================================================
--
-- 台灣站版本是 20261009260000_console_admin.sql（public schema）。那支的檔頭把日本站留成 TODO 第二步，這支就是第二步：
-- 同一套唯讀 RPC／視圖、同一組三個 service_role 專用寫入 RPC，搬到 policy_jp。Edge Function console-admin 多一個 body 欄位 site
-- （白名單 tw／jp，jp 走 jpClient），主控台前端 policy-console 的派工頁跟著頂端站台切換。
--
-- 跟台灣版的差異（都是 policy_jp 本來就跟正見不同的地方）：
--   * 沒有 activity_open_now 視圖：console_arm_status() 把同樣的「臂 × 選舉 × 職位」展開寫在函式裡（targets CTE，呼叫 policy_jp.activity_open）。
--   * election_id 是 TEXT（election_key 字串），不是 integer。
--   * election_milestones.kind 沒有 qualification_review（日本站的 CHECK 只有八種），寫入 RPC 的白名單照日本站的 CHECK。
--   * 臂名單來自 policy_jp.activity_arm_names()（日本站自己的臂）。
--   * 全部帶 policy_jp. 前綴，函式釘 SET search_path = policy_jp, pg_temp；不碰 public 與 ditrust。
--
-- 權限（日本站慣例：內部表一律不給 anon，公開數字經 SECURITY DEFINER 函式或「擁有者權限的視圖」讀）：
--   * 讀：console_arm_status() 是 SECURITY DEFINER，GRANT EXECUTE 給 anon／authenticated／service_role；
--     兩個視圖不設 security_invoker（以擁有者身分讀內部表），REVOKE ALL 之後明確 GRANT SELECT 給 anon／authenticated／service_role。
--     底下的 activity_overrides／election_milestones／elections 等表照舊不給 anon 任何權限。
--   * 寫：三支 SECURITY DEFINER、REVOKE ALL FROM PUBLIC／anon／authenticated、只 GRANT EXECUTE 給 service_role。reason 必填。
--     Firebase ID token 驗證在 Edge Function。
--
-- 覆寫撤銷與里程碑 reason 的處理方式跟台灣版完全相同（見 20261009260000 檔頭）：撤銷＝UPDATE expires_at 為今天 -1 並把原因併進 reason；
-- election_milestones 沒有 reason 欄，併進 note。
--
-- 守門：supabase/functions/_shared/policy-jp-console-admin.test.ts（PGlite）、console-admin-handler.test.ts（site 路由與白名單）、
--   policy-jp-dispatch-drift.test.ts 的 JP_ONLY 登記。

-- ------------------------------------------------------------
-- 1. 唯讀：每支派工臂今天開／關、靠規則還是覆寫、佇列件數
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.console_arm_status()
RETURNS TABLE (arm TEXT, is_open BOOLEAN, via TEXT, queue_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH arms AS (SELECT a AS arm FROM unnest(policy_jp.activity_arm_names()) AS a),
  -- 「不屬於任何選舉」＋每場選舉整場＋每場選舉的職位（日本站一場選舉只有一個職位）
  targets AS (
    SELECT NULL::TEXT AS election_id, NULL::TEXT AS election_type
    UNION ALL SELECT e.id, NULL::TEXT FROM policy_jp.elections e
    UNION ALL SELECT e.id, e.election_type FROM policy_jp.elections e WHERE e.election_type IS NOT NULL
  ),
  opened AS (
    SELECT a.arm, t.election_id, x.is_open, x.via_override, x.via_rule
      FROM arms a
      CROSS JOIN targets t
      CROSS JOIN LATERAL (
        SELECT count(*) > 0 AS is_open,
               bool_or(o.override_id IS NOT NULL) AS via_override,
               bool_or(o.rule_id IS NOT NULL) AS via_rule
          FROM policy_jp.activity_open(a.arm, t.election_id, t.election_type) o
      ) x
  ),
  agg AS (
    SELECT o.arm, bool_or(o.is_open) AS is_open, bool_or(o.via_override) AS via_override, bool_or(o.via_rule) AS via_rule
      FROM opened o
     GROUP BY o.arm
  ),
  -- 全關的覆寫（force='closed'）在 activity_open() 裡回 0 列，這裡額外查：現在有生效中的 closed 覆寫蓋到這支臂就算 via=override
  closed_ov AS (
    SELECT DISTINCT o.activity FROM policy_jp.activity_overrides o
     WHERE o."force" = 'closed' AND (o.expires_at IS NULL OR o.expires_at >= policy_jp.activity_today())
  ),
  auto_counts AS (
    SELECT d.opened_by->>'arm' AS arm, count(*) AS n
      FROM policy_jp.task_dispatches d
     WHERE d.task_id LIKE 'auto:%'
     GROUP BY d.opened_by->>'arm'
  ),
  manual_counts AS (
    SELECT 'manual_visitor'::TEXT AS arm, count(*) AS n
      FROM policy_jp.task_dispatches d
     WHERE d.task_id IN (SELECT m.task_id FROM policy_jp.contribution_auto_tasks_manual(true) m)
    UNION ALL
    SELECT 'manual_open'::TEXT, count(*)
      FROM policy_jp.task_dispatches d
     WHERE d.task_id IN (SELECT m.task_id FROM policy_jp.contribution_auto_tasks_manual(false) m)
  )
  SELECT ar.arm,
         COALESCE(ag.is_open, false) AS is_open,
         CASE WHEN COALESCE(ag.via_override, false) THEN 'override'
              WHEN COALESCE(ag.via_rule, false) THEN 'rule'
              WHEN co.activity IS NOT NULL THEN 'override'
              ELSE 'closed' END AS via,
         COALESCE(ac.n, mc.n) AS queue_count
    FROM arms ar
    LEFT JOIN agg ag ON ag.arm = ar.arm
    LEFT JOIN closed_ov co ON co.activity = ar.arm
    LEFT JOIN auto_counts ac ON ac.arm = ar.arm
    LEFT JOIN manual_counts mc ON mc.arm = ar.arm
   ORDER BY ar.arm
$$;
COMMENT ON FUNCTION policy_jp.console_arm_status IS
  '主控台用（日本站）：每支派工臂（policy_jp.activity_arm_names()）今天開不開、靠規則還是覆寫（override／rule／closed）、佇列裡有幾件。'
  '台灣版 console_arm_status() 的日本站版（沒有 activity_open_now 視圖，targets 展開寫在函式裡）。SECURITY DEFINER，公開唯讀。2026-10-10（#518 第二步）';

-- ------------------------------------------------------------
-- 2. 唯讀：目前有效的覆寫清單、各選舉里程碑日期（擁有者權限的視圖，明確 GRANT SELECT）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW policy_jp.console_active_overrides AS
  SELECT o.id, o.activity, o.election_id, e.election_date, e.election_reason, o.election_type,
         o."force", o.open_from, o.open_until, o.reason, o.created_by, o.created_at, o.expires_at
    FROM policy_jp.activity_overrides o
    LEFT JOIN policy_jp.elections e ON e.id = o.election_id
   WHERE (o.expires_at IS NULL OR o.expires_at >= policy_jp.activity_today())
     AND (o."force" <> 'window' OR o.open_until IS NULL OR o.open_until >= policy_jp.activity_today())
   ORDER BY o.created_at DESC;
COMMENT ON VIEW policy_jp.console_active_overrides IS
  '目前有效（沒撤銷、沒過期、force=window 的沒有過了 open_until）的覆寫（日本站），給主控台顯示。擁有者權限的視圖（底下的表不對 anon 開），明確 GRANT SELECT。2026-10-10（#518 第二步）';

CREATE OR REPLACE VIEW policy_jp.console_election_milestones AS
  SELECT m.id, m.election_id, e.election_date, e.election_reason, m.kind, m.election_type,
         m.on_date, m.basis, m.status, m.note, m.created_at, m.updated_at
    FROM policy_jp.election_milestones m
    JOIN policy_jp.elections e ON e.id = m.election_id
   ORDER BY e.election_date, m.kind, m.election_type;
COMMENT ON VIEW policy_jp.console_election_milestones IS
  '每場選舉×里程碑一列（日本站），給主控台改日期用。投票日在 elections，不在這張。擁有者權限的視圖，明確 GRANT SELECT。2026-10-10（#518 第二步）';

-- ------------------------------------------------------------
-- 3. 寫入：覆寫新增／撤銷、里程碑設定（service_role 專用，Edge Function console-admin site=jp 呼叫）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION policy_jp.console_admin_override_create(
  p_activity TEXT, p_election_id TEXT, p_election_type TEXT, p_force TEXT,
  p_open_from DATE, p_open_until DATE, p_reason TEXT, p_expires_at DATE, p_created_by TEXT
) RETURNS policy_jp.activity_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = policy_jp, pg_temp
AS $$
DECLARE v_row policy_jp.activity_overrides;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  INSERT INTO policy_jp.activity_overrides (activity, election_id, election_type, "force", open_from, open_until, reason, created_by, expires_at)
  VALUES (p_activity, NULLIF(btrim(COALESCE(p_election_id, '')), ''), NULLIF(btrim(COALESCE(p_election_type, '')), ''), p_force,
          p_open_from, p_open_until, btrim(p_reason), p_created_by, p_expires_at)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION policy_jp.console_admin_override_create IS
  '主控台新增覆寫（日本站；force：open／closed／window）。reason 必填。只授權 service_role。2026-10-10（#518 第二步）';

CREATE OR REPLACE FUNCTION policy_jp.console_admin_override_revoke(
  p_id BIGINT, p_reason TEXT, p_revoked_by TEXT
) RETURNS policy_jp.activity_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = policy_jp, pg_temp
AS $$
DECLARE v_row policy_jp.activity_overrides;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  UPDATE policy_jp.activity_overrides
     SET expires_at = policy_jp.activity_today() - 1,
         reason = reason || '；撤銷（' || COALESCE(p_revoked_by, '主控台') || '）：' || btrim(p_reason)
   WHERE id = p_id
     AND (expires_at IS NULL OR expires_at >= policy_jp.activity_today())
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION '覆寫 % 不存在，或已經撤銷／過期', p_id;
  END IF;
  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION policy_jp.console_admin_override_revoke IS
  '主控台撤銷覆寫（日本站）：不刪列，expires_at 設成今天 -1、撤銷原因併進 reason（原 reason 保留）。只授權 service_role。2026-10-10（#518 第二步）';

CREATE OR REPLACE FUNCTION policy_jp.console_admin_milestone_set(
  p_election_id TEXT, p_kind TEXT, p_election_type TEXT, p_on_date DATE, p_status TEXT, p_reason TEXT, p_set_by TEXT
) RETURNS policy_jp.election_milestones
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = policy_jp, pg_temp
AS $$
DECLARE v_row policy_jp.election_milestones;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  -- 日本站 election_milestones.kind 的 CHECK 只有這八種（沒有 qualification_review；投票日在 elections，不能在這裡改）
  IF p_kind NOT IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                     'bulletin_published', 'result_announced', 'certified') THEN
    RAISE EXCEPTION '% 不是 election_milestones 可以改的里程碑（投票日的單一真相在 elections，不能在這裡改）', p_kind;
  END IF;
  INSERT INTO policy_jp.election_milestones (election_id, kind, election_type, on_date, basis, status, note)
  VALUES (NULLIF(btrim(COALESCE(p_election_id, '')), ''), p_kind, NULLIF(btrim(COALESCE(p_election_type, '')), ''), p_on_date, 'override', p_status,
          '主控台（' || COALESCE(p_set_by, '未知') || '）：' || btrim(p_reason))
  ON CONFLICT (election_id, kind, (COALESCE(election_type, '')))
  DO UPDATE SET on_date = EXCLUDED.on_date, status = EXCLUDED.status, basis = 'override', note = EXCLUDED.note
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION policy_jp.console_admin_milestone_set IS
  '主控台改里程碑日期／狀態（日本站；新增或覆蓋既有列，ON CONFLICT 用 election_milestones_uniq）：basis 固定 override，reason 必填、併進 note。只授權 service_role。2026-10-10（#518 第二步）';

-- ------------------------------------------------------------
-- 權限
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION policy_jp.console_arm_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION policy_jp.console_arm_status() TO anon, authenticated, service_role;

-- 視圖裡呼叫的函式，EXECUTE 權限是查詢的呼叫者（anon）要有，不是視圖擁有者（PostgreSQL 的規則，PGlite 實測：
-- permission denied for function activity_today）。activity_today() 只回一個日期（含測試用的 app.activity_today 假時鐘），沒有敏感資料。
GRANT EXECUTE ON FUNCTION policy_jp.activity_today(TEXT) TO anon, authenticated;
REVOKE ALL ON policy_jp.console_active_overrides, policy_jp.console_election_milestones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON policy_jp.console_active_overrides, policy_jp.console_election_milestones TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION policy_jp.console_admin_override_create(TEXT, TEXT, TEXT, TEXT, DATE, DATE, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.console_admin_override_create(TEXT, TEXT, TEXT, TEXT, DATE, DATE, TEXT, DATE, TEXT) TO service_role;
REVOKE ALL ON FUNCTION policy_jp.console_admin_override_revoke(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.console_admin_override_revoke(BIGINT, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION policy_jp.console_admin_milestone_set(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.console_admin_milestone_set(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) TO service_role;
