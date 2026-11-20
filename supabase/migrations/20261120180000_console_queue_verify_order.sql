-- /queue 與主控台隊列預覽照 /next 的實際順序排（2026-11-20，#989；接 #988 的 20261119100000 驗證先於任務）
--
-- 現象：#988 之後 /next 的驗證隊伍順序是 verify_rank → queue_at → task_id，且驗證一律先於任務；
--   但 console_queue_state()（/queue 頁與主控台隊列頁共用）的 head 仍照 queue_at 合成，看到的順序跟實際派工不一致。
-- 做法：對 console_queue_state() 的現行定義機械式替換（同 20261109010000 的手法；現行定義是 20261017020100 起疊了
--   20261107030000、20261109010000、20261109130000 幾次替換，不整支重寫以免蓋掉它們），每處斷言只出現一次、可重跑：
--   1. 驗證票 CTE（vt）多帶 d.verify_rank
--   2. head 合成順序改成 ORDER BY 驗證先於任務（tie：驗證 0、任務 1）→ verify_rank（NULLS LAST）→ queue_at → task_id；
--      後三者與 contribution_verify_pool 的 ORDER BY（d.verify_rank ASC NULLS LAST, d.queue_at ASC, d.task_id）同一組，
--      測試逐案比對兩邊；任務列 verify_rank 為 NULL，任務之間照舊（queue_at → task_id）
--   3. head 每列多一個鍵 verify_rank（任務列為 null）
-- 簽名、權限（SECURITY DEFINER、anon 可執行、唯讀）與其他欄位一字不動；只動正見（日本站不跟）。
-- 回滾：把三個替換反過來（見各處 v_new → v_old），或重放上一版定義；不動資料。
DO $do$
DECLARE
  v_def TEXT; v_n INTEGER; r RECORD;
BEGIN
  v_def := pg_get_functiondef('console_queue_state()'::REGPROCEDURE);
  IF strpos(v_def, 'verify_rank') > 0 THEN RETURN; END IF;  -- 已替換過（重跑）
  FOR r IN SELECT * FROM (VALUES
      ('vt 多帶 verify_rank',
       $s$d.last_dispatched_at, v.contribution_type, v.payload,$s$,
       $s$d.last_dispatched_at, d.verify_rank, v.contribution_type, v.payload,$s$),
      ('head 合成順序',
       $s$OVER (ORDER BY m.queue_at, m.tie, m.task_id)::INTEGER AS pos$s$,
       $s$OVER (ORDER BY m.tie, m.verify_rank ASC NULLS LAST, m.queue_at, m.task_id)::INTEGER AS pos$s$),
      ('任務列補 verify_rank 欄',
       $s$o.last_dispatched_at, 1 AS tie$s$,
       $s$o.last_dispatched_at, 1 AS tie, NULL::SMALLINT AS verify_rank$s$),
      ('驗證列補 verify_rank 欄',
       $s$v.last_dispatched_at, 0$s$,
       $s$v.last_dispatched_at, 0, v.verify_rank$s$),
      ('head 輸出 verify_rank',
       $s$'pos', o.pos, 'kind', o.kind,$s$,
       $s$'pos', o.pos, 'kind', o.kind, 'verify_rank', o.verify_rank,$s$)) AS t(label, v_old, v_new)
  LOOP
    v_n := (length(v_def) - length(replace(v_def, r.v_old, ''))) / length(r.v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'console_queue_state() 的「%」出現 % 次，預期 1 次——現行定義變了，這個替換要重寫', r.label, v_n;
    END IF;
    v_def := replace(v_def, r.v_old, r.v_new);
  END LOOP;
  EXECUTE v_def;
END
$do$;

COMMENT ON FUNCTION console_queue_state IS '主控台派工隊列頁（唯讀）：投太多輪（overvoted）、非驗證列的狀態分布、隊頭 60 列（驗證票先於任務；驗證票照 /next 的 verify_rank → queue_at → task_id，任務其後照 queue_at → task_id，每列 kind、驗證列帶 verify_rank）、停放中的任務、驗證佇列、24 小時實際派出、可派列的距上次派出分桶。2026-10-17；2026-11-20 隊頭改照 /next 實際順序（#989）';
