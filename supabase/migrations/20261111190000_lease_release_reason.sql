-- 認領紀錄：強模型專線交件記 reported，不再誤算 expired（接 20261111120000_lease_events.sql）
--
-- 查到的對不上點（2026-11-11 opus_judge40 十件裁決）：
--   adjudication 交件的 contributions.task_id 與 payload.task_id 都是 NULL（裁決只帶 payload.contribution_id，
--   對應的 adjudicate 任務在 contribution_tasks.target->>'contribution_id'）。
--   contribute-handler 交件後只釋放「item.task_id」的租約，裁決沒有 item.task_id ＝ 租約根本沒被釋放，
--   30 分鐘後被 contribution_task_leases_purge() 清掉並明講 expired（meta.by=setting）。
-- 修法：
--   1. 新增 lease_release(task_ids, reason)：service_role RPC，同一交易內 set_config 再刪租約，TS 明講原因（reported）。
--   2. 觸發器的推斷補上 adjudication：任務是 adjudicate 型別，且租約建立後有人對 target.contribution_id 交了裁決 ＝ reported。
-- 不回填歷史（歷史紀錄不回頭改）：這次修之前的 expired 數字偏高，之後的才準。

CREATE OR REPLACE FUNCTION lease_release(p_task_ids TEXT[], p_reason TEXT DEFAULT 'reported') RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE n INTEGER;
BEGIN
  IF p_reason NOT IN ('reported', 'released', 'expired') THEN
    RAISE EXCEPTION 'lease_release: reason 只能是 reported／released／expired，收到 %', p_reason;
  END IF;
  PERFORM set_config('app.lease_release_reason', p_reason, true);
  DELETE FROM contribution_task_leases WHERE task_id = ANY (p_task_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.lease_release_reason', '', true);
  RETURN n;
END;
$$;
COMMENT ON FUNCTION lease_release IS '釋放租約並明講原因（寫進 lease_events）。/report 交件後帶 reported。只有 service_role 可呼叫。2026-11-11';
REVOKE ALL ON FUNCTION lease_release(TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION lease_release(TEXT[], TEXT) TO service_role;

CREATE OR REPLACE FUNCTION lease_events_on_delete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_forced TEXT := nullif(current_setting('app.lease_release_reason', true), '');
  v_event  TEXT;
  v_by     TEXT;
  -- 租約 task_id 不一定是 uuid（auto:／verify: 開頭的也有）：先守住格式再轉型，讓 contribution_tasks 主鍵索引用得到
  v_tid    UUID := CASE WHEN OLD.task_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN OLD.task_id::uuid END;
BEGIN
  IF v_forced IN ('reported', 'released', 'expired') THEN
    v_event := v_forced; v_by := 'setting';
  ELSIF EXISTS (SELECT 1 FROM contributions c WHERE c.task_id = OLD.task_id AND c.created_at >= OLD.created_at)
     -- 交件也可能只帶 payload.task_id（contribute-handler：item.task_id ?? payload.task_id）；只有 no_change 有 payload->>'task_id' 的部分索引，所以條件帶 contribution_type 才走得到它
     OR EXISTS (SELECT 1 FROM contributions c WHERE c.contribution_type = 'no_change' AND c.payload->>'task_id' = OLD.task_id AND c.created_at >= OLD.created_at)
     -- 裁決（adjudication）：task_id 與 payload.task_id 都沒有，只帶 payload.contribution_id，要從 adjudicate 任務的 target 對回去
     OR EXISTS (SELECT 1 FROM contribution_tasks t
                  JOIN contributions c ON c.contribution_type = 'adjudication' AND c.payload->>'contribution_id' = t.target->>'contribution_id'
                 WHERE t.id = v_tid AND t.task_type = 'adjudicate' AND c.created_at >= OLD.created_at) THEN
    v_event := 'reported'; v_by := 'contribution_after_lease';
  ELSIF OLD.leased_until < now() THEN
    v_event := 'expired'; v_by := 'leased_until_passed';
  ELSE
    v_event := 'released'; v_by := 'default';
  END IF;
  INSERT INTO lease_events (task_id, agent_name, ip_hash, event, at, meta)
  VALUES (OLD.task_id, OLD.agent_name, OLD.ip_hash, v_event, now(),
          jsonb_build_object('target_key', OLD.target_key, 'leased_at', OLD.created_at, 'leased_until', OLD.leased_until, 'by', v_by));
  RETURN OLD;
END;
$$;
