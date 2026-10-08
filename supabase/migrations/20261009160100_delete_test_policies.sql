-- 刪除 8 筆標題 TEST、已軟移除的政見（維護者 2026-10-08 同意；#466 B）
--
-- 這 8 筆是 2026-06-09 匯入的測試資料（內容 test、來源 example.com），2026-09-16 已軟移除（removed_at 有值），
-- 但資料列一直留著。正式庫唯讀查過所有引用（pg_constraint 的外鍵＋沒有外鍵的軟引用）：
--   外鍵（tracking_logs、policy_stances、discussions、citizen_questions、policy_elements、related_policies、user_checkpoints
--   皆 ON DELETE CASCADE；ai_usage_logs、contributions.applied_policy_id 為 SET NULL）——這 8 筆底下全是 0 列；
--   軟引用：source_refs（target_table='policies'）8 列＝每筆 1 列，沒有外鍵，要自己清；
--   edit_history、contributions.payload、task_dispatches、contribution_tasks、gap_events、task_checks、
--   contribution_task_leases、contribution_task_skips 都是 0 列。
-- 所以只需要先清 source_refs 再刪政見。
--
-- 防呆：id 都寫完整 uuid；任何一筆標題不是 TEST 或還沒軟移除就整支 RAISE（不刪任何東西）。
-- 資料列已經不在的（重跑）安靜略過。

DO $$
DECLARE
  v_ids UUID[] := ARRAY[
    '3b2c244f-a35f-4a53-9f28-f5a006b1eda6',
    'a8ea2375-dea9-4925-b020-9b27e7fe15f0',
    'ba088f6c-f95a-411a-9d98-75dc3c679a72',
    'c9ba038b-ee1d-4f4e-80a5-b0724e825337',
    'c9d8d858-dfa2-42d1-844f-1a620cf7e6e2',
    'cc49aa4a-0dc0-461b-8f72-3c56d11aef52',
    'd7f134f9-719f-4d68-96c1-69de118e4094',
    'e0015bb4-e82d-4db1-8817-595e13d283b0'
  ]::UUID[];
  r RECORD;
  v_refs INTEGER; v_pols INTEGER;
BEGIN
  FOR r IN SELECT id, title, removed_at FROM policies WHERE id = ANY (v_ids) LOOP
    IF r.title IS DISTINCT FROM 'TEST' THEN
      RAISE EXCEPTION '政見 % 的標題是「%」不是 TEST，不刪', r.id, r.title;
    END IF;
    IF r.removed_at IS NULL THEN
      RAISE EXCEPTION '政見 % 還沒軟移除，不刪', r.id;
    END IF;
  END LOOP;

  DELETE FROM source_refs WHERE target_table = 'policies' AND target_id = ANY (SELECT unnest(v_ids)::TEXT);
  GET DIAGNOSTICS v_refs = ROW_COUNT;

  DELETE FROM policies WHERE id = ANY (v_ids) AND title = 'TEST' AND removed_at IS NOT NULL;
  GET DIAGNOSTICS v_pols = ROW_COUNT;

  RAISE NOTICE '刪除測試政見：source_refs % 列、policies % 列', v_refs, v_pols;
END;
$$;
