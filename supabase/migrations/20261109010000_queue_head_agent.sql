-- 主控台派工隊列「隊頭前 60 名」多一欄 agent：這張任務現在被哪個代理認領中（2026-11-09，小良要求；唯讀、不動派工與資料）。
--
-- 「現在被誰認領」＝ contribution_task_leases（/next 派出時寫、LEASE_MINUTES＝30 分鐘到期、/report 提交或 skip 時釋放）
-- 裡 task_id 相同且 leased_until > now() 的那一列的 agent_name；沒有（沒人領、已過期、已交件、已 skip）就是 NULL。
-- 驗證票（task_id＝verify:…）派出時不寫認領，所以一律 NULL。
--
-- 做法同 20261107030000：對 console_queue_state() 的現行定義機械式替換（head 物件尾端多一個鍵），斷言只出現一次；
-- 簽名、權限（SECURITY DEFINER，所以讀得到只開給 service_role 的認領表）與其他欄位一字不動。
DO $do$
DECLARE
  v_old CONSTANT TEXT := $s$'dispatch_count', o.dispatch_count, 'last_dispatched_at', o.last_dispatched_at) ORDER BY o.pos)$s$;
  v_new CONSTANT TEXT := $s$'dispatch_count', o.dispatch_count, 'last_dispatched_at', o.last_dispatched_at,
                 'agent', (SELECT l.agent_name FROM contribution_task_leases l WHERE l.task_id = o.task_id AND l.leased_until > now() LIMIT 1)) ORDER BY o.pos)$s$;
  v_def TEXT; v_n INTEGER;
BEGIN
  v_def := pg_get_functiondef('console_queue_state()'::REGPROCEDURE);
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n = 0 AND strpos(v_def, 'contribution_task_leases') > 0 THEN RETURN; END IF;  -- 已替換過（重跑）
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'console_queue_state() 的 head 尾端出現 % 次，預期 1 次——現行定義變了，這個替換要重寫', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$do$;
