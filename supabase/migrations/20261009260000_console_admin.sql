-- 主控台手動調整派工開關與選舉日期（#518，2026-10-09）
-- ============================================================
--
-- 做法沿用 P0／P1 既有設計（docs/PLAN-task-activation.md、20261008001000／20261008060000）：
--   * 開關：寫 activity_overrides（已存在、已有 RLS 與審計觸發器，這支只加三個 service_role 專用的寫入 RPC，給 Edge Function console-admin 呼叫）。
--   * 日期：改 election_milestones 那一列（已存在；衍生快取 roster_check_scope 五個日期欄、elections.bulletin_published_on 由既有觸發器
--     roster_scope_sync_from_milestones／bulletin 相關觸發器自動同步，這支不碰那些觸發器，只是照既有「寫里程碑表」路徑走）。
--   * 規則本身（activity_rules）仍只走 migration，這支不碰。
--
-- 查證（2026-10-09，唯讀）：
--   * activity_overrides／election_milestones 已有 BEFORE/AFTER 審計觸發器 trg_activity_overrides_audit／trg_election_milestones_audit
--     （函式 activity_audit()，寫 edit_history，agent_name 固定 'activity-audit'）；INSERT／UPDATE／DELETE 都會記，這支不改這個觸發器。
--   * election_milestones 沒有 reason 欄位，reason 併進既有的 note 欄（人看得到、edit_history 的 new_value 整列 jsonb 也存得到）。
--   * roster_check_scope 的五個日期欄＝衍生快取，已有觸發器 roster_scope_derive_dates／roster_scope_sync_from_milestones 同步，
--     這支只寫 election_milestones，不直接碰 roster_check_scope。elections.bulletin_published_on 同理，不直接碰 elections。
--   * policy_jp 有同形的 activity_overrides／election_milestones（20261009130000 起，policy_jp schema）；這支先只做台灣站，
--     日本站留 TODO（第二步）：console-admin 要再開一個動作或參數指到 policy_jp schema，寫法照抄即可（同一套表結構）。
--   * 覆寫撤銷：改用 UPDATE 把 expires_at 設成「今天 -1」並把撤銷原因併進 reason（而不是 DELETE）——
--     DELETE 的話 edit_history 只留得住「原始 reason」（舊值），撤銷這個動作本身的原因反而沒有獨立的新值可記；
--     UPDATE 則會多一筆 AFTER UPDATE 的審計（OLD＝原覆寫、NEW＝撤銷後的列），兩個原因都留得住，且沿用 activity_open() 已經在檢查的
--     「o.expires_at IS NULL OR p_today <= o.expires_at」那一行，不用改判斷邏輯、撤銷立刻生效（即使是當天新增的覆寫）。
--
-- 權限：寫入三支 RPC 一律 SECURITY DEFINER、SET search_path = public、REVOKE ALL FROM PUBLIC/anon/authenticated、
--   只 GRANT EXECUTE TO service_role（照 bulletin_watch_targets／bulletin_watch_mark_published 的既有樣式，20261008113000）。
--   Firebase ID token 的驗證在 Edge Function 端（console-admin），這支只管「進來的是 service_role 就讓它寫，reason 必填就擋」。
--
-- 讀取：新函式 console_arm_status()、新視圖 console_active_overrides／console_election_milestones 一律公開唯讀
--   （沒有 REVOKE，照 activity_open_now／contribution_feed_summary 等既有公開 RPC 的預設權限），不露敏感欄位
--   （override／milestone 本身的欄位都不是敏感資料；佇列件數只是數字）。
--
-- 守門：supabase/functions/_shared/console-admin.test.ts（RPC 驗證、ON CONFLICT upsert、撤銷保留雙重原因、reason 空擋下）。

-- ------------------------------------------------------------
-- 1. 唯讀：每支派工臂今天開／關、靠規則還是覆寫、佇列件數
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION console_arm_status()
RETURNS TABLE (arm TEXT, is_open BOOLEAN, via TEXT, queue_count BIGINT)
LANGUAGE sql STABLE AS $$
  WITH arms AS (SELECT a AS arm FROM unnest(activity_arm_names()) AS a),
  agg AS (
    SELECT o.activity,
           bool_or(o.is_open) AS is_open,
           bool_or(o.is_open AND o.override_ids IS NOT NULL) AS via_override,
           bool_or(o.is_open AND o.rule_ids IS NOT NULL) AS via_rule
      FROM activity_open_now o
     GROUP BY o.activity
  ),
  -- 全關的覆寫（force='closed'）在 activity_open() 裡回 0 列（跟「沒有規則」一樣看不出來），這裡額外查一次：
  -- 現在有沒有一筆生效中的 closed 覆寫蓋到這支臂，有就算 via=override（即使因此整支臂是關的）
  closed_ov AS (
    SELECT DISTINCT o.activity FROM activity_overrides o
     WHERE o."force" = 'closed' AND (o.expires_at IS NULL OR o.expires_at >= activity_today())
  )
  SELECT ar.arm,
         COALESCE(ag.is_open, false) AS is_open,
         CASE WHEN COALESCE(ag.via_override, false) THEN 'override'
              WHEN COALESCE(ag.via_rule, false) THEN 'rule'
              WHEN co.activity IS NOT NULL THEN 'override'
              ELSE 'closed' END AS via,
         qc.queue_count
    FROM arms ar
    LEFT JOIN agg ag ON ag.activity = ar.arm
    LEFT JOIN closed_ov co ON co.activity = ar.arm
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN ar.arm IN ('manual_visitor', 'manual_open') THEN
          (SELECT count(*) FROM task_dispatches d
            WHERE d.task_id IN (SELECT m.task_id FROM contribution_auto_tasks_manual(ar.arm = 'manual_visitor') m))
        ELSE
          (SELECT count(*) FROM task_dispatches d WHERE d.task_id LIKE 'auto:%' AND d.opened_by->>'arm' = ar.arm)
      END AS queue_count
    ) qc ON true
   ORDER BY ar.arm
$$;
COMMENT ON FUNCTION console_arm_status IS
  '主控台用：每支派工臂（activity_arm_names()）今天開不開（is_open）、靠規則還是覆寫（via：override／rule／closed，彙總 activity_open_now 所有選舉×職位的列）、'
  '佇列裡目前有幾件（queue_count：manual_visitor／manual_open 兩支手動臂查 contribution_auto_tasks_manual()，其餘查 task_dispatches.opened_by->>''arm''，'
  '只有 P1 起新增的派工列才會有這個鍵，舊列回填時沒有，count 會偏低——不是 bug，是歷史資料的已知落差）。公開唯讀。2026-10-09（#518）';

-- ------------------------------------------------------------
-- 2. 唯讀：目前有效的覆寫清單、各選舉里程碑日期
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW console_active_overrides AS
  SELECT o.id, o.activity, o.election_id, e.election_date, e.election_reason, o.election_type,
         o."force", o.open_from, o.open_until, o.reason, o.created_by, o.created_at, o.expires_at
    FROM activity_overrides o
    LEFT JOIN elections e ON e.id = o.election_id
   WHERE o.expires_at IS NULL OR o.expires_at >= activity_today()
   ORDER BY o.created_at DESC;
ALTER VIEW console_active_overrides SET (security_invoker = on);
COMMENT ON VIEW console_active_overrides IS
  '目前有效（沒撤銷、沒過期）的覆寫，給主控台顯示「目前有哪些覆寫」（維護者 10-09：覆寫反覆出現代表規則寫錯，要定期回頭看這張）。公開唯讀。2026-10-09（#518）';

CREATE OR REPLACE VIEW console_election_milestones AS
  SELECT m.id, m.election_id, e.election_date, e.election_reason, m.kind, m.election_type,
         m.on_date, m.basis, m.status, m.note, m.created_at, m.updated_at
    FROM election_milestones m
    JOIN elections e ON e.id = m.election_id
   ORDER BY e.election_date, m.kind, m.election_type;
ALTER VIEW console_election_milestones SET (security_invoker = on);
COMMENT ON VIEW console_election_milestones IS
  '每場選舉×里程碑一列，給主控台改日期用（投票日、就任日／屆滿日不在這張——單一真相在 elections／election_term_*，這張只收可編輯的里程碑）。公開唯讀。2026-10-09（#518）';

-- ------------------------------------------------------------
-- 3. 寫入：覆寫新增／撤銷、里程碑設定（service_role 專用，Edge Function console-admin 呼叫）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION console_admin_override_create(
  p_activity TEXT, p_election_id INTEGER, p_election_type TEXT, p_force TEXT,
  p_open_from DATE, p_open_until DATE, p_reason TEXT, p_expires_at DATE, p_created_by TEXT
) RETURNS activity_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row activity_overrides;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  INSERT INTO activity_overrides (activity, election_id, election_type, "force", open_from, open_until, reason, created_by, expires_at)
  VALUES (p_activity, p_election_id, p_election_type, p_force, p_open_from, p_open_until, btrim(p_reason), p_created_by, p_expires_at)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION console_admin_override_create IS
  '主控台新增覆寫（force：open／closed／window）。reason 必填（表已有 CHECK，這裡先擋給更好的錯誤訊息）。只授權 service_role。2026-10-09（#518）';

CREATE OR REPLACE FUNCTION console_admin_override_revoke(
  p_id BIGINT, p_reason TEXT, p_revoked_by TEXT
) RETURNS activity_overrides
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row activity_overrides;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  UPDATE activity_overrides
     SET expires_at = activity_today() - 1,
         reason = reason || '；撤銷（' || COALESCE(p_revoked_by, '主控台') || '）：' || btrim(p_reason)
   WHERE id = p_id
     AND (expires_at IS NULL OR expires_at >= activity_today())
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION '覆寫 % 不存在，或已經撤銷／過期', p_id;
  END IF;
  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION console_admin_override_revoke IS
  '主控台撤銷覆寫：不刪列，把 expires_at 設成今天 -1（立刻生效，activity_open() 原有的 expires_at 判斷就會把它當過期）、'
  '把撤銷原因併進 reason（原 reason 保留）。這樣 edit_history 的 UPDATE 審計同時留得住「當初為什麼開」與「現在為什麼撤」兩筆原因。只授權 service_role。2026-10-09（#518）';

CREATE OR REPLACE FUNCTION console_admin_milestone_set(
  p_election_id INTEGER, p_kind TEXT, p_election_type TEXT, p_on_date DATE, p_status TEXT, p_reason TEXT, p_set_by TEXT
) RETURNS election_milestones
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row election_milestones;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'reason 必填';
  END IF;
  IF p_kind NOT IN ('announced', 'registration_open', 'registration_close', 'list_published', 'draw',
                     'bulletin_published', 'result_announced', 'certified') THEN
    RAISE EXCEPTION '% 不是 election_milestones 可以改的里程碑（投票日與就任日／屆滿日的單一真相在 elections／election_term_*，不能在這裡改）', p_kind;
  END IF;
  INSERT INTO election_milestones (election_id, kind, election_type, on_date, basis, status, note)
  VALUES (p_election_id, p_kind, p_election_type, p_on_date, 'override', p_status,
          '主控台（' || COALESCE(p_set_by, '未知') || '）：' || btrim(p_reason))
  ON CONFLICT (election_id, kind, (COALESCE(election_type, '')))
  DO UPDATE SET on_date = EXCLUDED.on_date, status = EXCLUDED.status, basis = 'override', note = EXCLUDED.note
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;
COMMENT ON FUNCTION console_admin_milestone_set IS
  '主控台改里程碑日期／狀態（新增或覆蓋既有列，ON CONFLICT 用既有的 election_milestones_uniq 索引）：basis 固定寫 override，reason 必填、併進 note。'
  '衍生快取（roster_check_scope 五個欄位、elections.bulletin_published_on）由既有觸發器同步，這支不直接碰它們。只授權 service_role。2026-10-09（#518）';

REVOKE ALL ON FUNCTION console_admin_override_create(TEXT, INTEGER, TEXT, TEXT, DATE, DATE, TEXT, DATE, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_admin_override_create(TEXT, INTEGER, TEXT, TEXT, DATE, DATE, TEXT, DATE, TEXT) FROM anon;
REVOKE ALL ON FUNCTION console_admin_override_create(TEXT, INTEGER, TEXT, TEXT, DATE, DATE, TEXT, DATE, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION console_admin_override_create(TEXT, INTEGER, TEXT, TEXT, DATE, DATE, TEXT, DATE, TEXT) TO service_role;

REVOKE ALL ON FUNCTION console_admin_override_revoke(BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_admin_override_revoke(BIGINT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION console_admin_override_revoke(BIGINT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION console_admin_override_revoke(BIGINT, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION console_admin_milestone_set(INTEGER, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_admin_milestone_set(INTEGER, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION console_admin_milestone_set(INTEGER, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION console_admin_milestone_set(INTEGER, TEXT, TEXT, DATE, TEXT, TEXT, TEXT) TO service_role;
