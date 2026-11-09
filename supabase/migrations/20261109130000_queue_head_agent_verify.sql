-- 隊頭 agent 欄補驗證票（2026-11-09，接 20261109010000）：驗證票派出不寫認領，改看 verify_dispatches。
--
-- verify:<contribution_id> 這列的 agent＝30 分鐘內（同 LEASE_MINUTES）被派到這筆、且還沒對它投票的代理，
-- 最近派的在前，多個用「、」連起來；「投過票」＝contribution_votes 有同 contribution_id、同 agent_name（不分大小寫；
-- 投票按代號一人一票，IP 不再當依據，見 20261104130000）。任務列照舊看 contribution_task_leases。
-- 唯讀；做法同 20261109010000：對現行定義機械式替換，斷言一次、可重跑，簽名與權限不動。
DO $do$
DECLARE
  v_old CONSTANT TEXT := $s$'agent', (SELECT l.agent_name FROM contribution_task_leases l WHERE l.task_id = o.task_id AND l.leased_until > now() LIMIT 1))$s$;
  v_new CONSTANT TEXT := $s$'agent', CASE WHEN o.kind = 'verify'
                   THEN (SELECT string_agg(x.agent_name, '、' ORDER BY x.last_at DESC)
                           FROM (SELECT vd.agent_name, max(vd.dispatched_at) AS last_at
                                   FROM verify_dispatches vd
                                  WHERE vd.contribution_id::TEXT = substr(o.task_id, 8)
                                    AND vd.dispatched_at > now() - INTERVAL '30 minutes'
                                    AND vd.agent_name IS NOT NULL
                                    AND NOT EXISTS (SELECT 1 FROM contribution_votes cv
                                                     WHERE cv.contribution_id = vd.contribution_id AND lower(cv.agent_name) = lower(vd.agent_name))
                                  GROUP BY vd.agent_name) x)
                   ELSE (SELECT l.agent_name FROM contribution_task_leases l WHERE l.task_id = o.task_id AND l.leased_until > now() LIMIT 1) END)$s$;
  v_def TEXT; v_n INTEGER;
BEGIN
  v_def := pg_get_functiondef('console_queue_state()'::REGPROCEDURE);
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n = 0 AND strpos(v_def, 'verify_dispatches') > 0 THEN RETURN; END IF;  -- 已替換過（重跑）
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'console_queue_state() 的 head.agent 出現 % 次，預期 1 次——現行定義變了，這個替換要重寫', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$do$;
