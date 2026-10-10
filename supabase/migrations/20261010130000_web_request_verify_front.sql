-- 網站請求（「請 AI 查證」）與公民提問的交件：驗證一路排前段，直到通過或退件（工作單 Yooliang/policy-ops#68；
-- 決定 policy-ops docs/decisions/2026-10-10-網站請求交件驗證一路優先.md，維護者 2026-10-10 列為最優先）。
--
-- 現況：這類交件的驗證列入列時 queue_at＝1970（contribution_queue_at），但第一次派出後 task_dispatched() 用 queue_slot('verify')
-- 把它排回隊尾；10-10 唯讀查正式庫，等票中的 204 筆只有 5 筆還在前段，中位數前面排約 5,200 件。
--
-- 做法：task_dispatches 加一個 BEFORE UPDATE 觸發器——驗證列被派出（dispatch_count 變了）而且要排回 2000 年以後時，
-- 若那筆貢獻還在 pending、而且是前段那一類（判準就是 contribution_queue_at 回 2000 年以前，跟入列同一份），
-- 改排到前段的最後面（1970 段裡驗證列的最大 queue_at ＋ 1 秒），在前段裡輪流，不回隊尾。
--   - 不改 task_dispatched／queue_slot／contribution_queue_at：這三支日本站有逐字抄本（policy-jp-dispatch-drift.test.ts），
--     改了日本那邊要跟；日本站還沒有網站請求，觸發器是正見自己的、日本站有網站請求後再照搬
--   - rebalance_queue 只重排 2000 年以後的列，前段的列它不動；/boost 的 1980 段也不受影響（觸發器只攔「排回 2000 年以後」）
--   - 同一台機器投過的不重派給它、一筆貢獻只有一列：照舊（/next 的過濾、task_id 主鍵）
--   - 通過或退件後不是 pending：下一次派出照常回隊尾；seed 也會把不是 pending 的驗證列刪掉
-- 既有的：等票中、前段那一類、但已經被排到隊尾的驗證列，照交件時間先後一次拉回前段。

CREATE OR REPLACE FUNCTION verify_front_keep() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_front BOOLEAN;
BEGIN
  SELECT contribution_queue_at(c.contribution_type, c.task_id, c.created_at) < TIMESTAMPTZ '2000-01-01'
    INTO v_front
    FROM contributions c
   WHERE c.id::TEXT = substr(NEW.task_id, 8) AND c.status = 'pending';
  IF COALESCE(v_front, false) THEN
    NEW.queue_at := COALESCE((SELECT max(d.queue_at) FROM task_dispatches d
                               WHERE d.task_id LIKE 'verify:%'
                                 AND d.queue_at >= TIMESTAMPTZ '1970-01-01' AND d.queue_at < TIMESTAMPTZ '1971-01-01'),
                             TIMESTAMPTZ '1970-01-01') + INTERVAL '1 second';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION verify_front_keep IS
  '網站請求與公民提問的交件還在等票時，驗證列派出後留在前段輪流、不回隊尾（OPS #68，2026-10-10）';

DROP TRIGGER IF EXISTS trg_task_dispatches_verify_front ON task_dispatches;
CREATE TRIGGER trg_task_dispatches_verify_front
  BEFORE UPDATE OF queue_at ON task_dispatches
  FOR EACH ROW
  WHEN (NEW.task_id LIKE 'verify:%' AND NEW.queue_at >= TIMESTAMPTZ '2000-01-01'
        AND NEW.dispatch_count IS DISTINCT FROM OLD.dispatch_count)
  EXECUTE FUNCTION verify_front_keep();

-- 既有的拉回前段：照交件時間先後排在 1970 段驗證列的後面（觸發器不攔：dispatch_count 沒變）
WITH base AS (
  SELECT COALESCE((SELECT max(d.queue_at) FROM task_dispatches d
                    WHERE d.task_id LIKE 'verify:%'
                      AND d.queue_at >= TIMESTAMPTZ '1970-01-01' AND d.queue_at < TIMESTAMPTZ '1971-01-01'),
                  TIMESTAMPTZ '1970-01-01') AS t
), back AS (
  SELECT d.task_id, row_number() OVER (ORDER BY c.created_at, c.id) AS rn
    FROM task_dispatches d
    JOIN contributions c ON 'verify:' || c.id = d.task_id
   WHERE c.status = 'pending' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
     AND contribution_queue_at(c.contribution_type, c.task_id, c.created_at) < TIMESTAMPTZ '2000-01-01'
)
UPDATE task_dispatches d SET queue_at = (SELECT t FROM base) + back.rn * INTERVAL '1 second'
  FROM back WHERE d.task_id = back.task_id;

-- 自我檢查：等票中的這一類沒有一列還在隊尾
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM task_dispatches d JOIN contributions c ON 'verify:' || c.id = d.task_id
              WHERE c.status = 'pending' AND d.queue_at >= TIMESTAMPTZ '2000-01-01'
                AND contribution_queue_at(c.contribution_type, c.task_id, c.created_at) < TIMESTAMPTZ '2000-01-01') THEN
    RAISE EXCEPTION '網站請求／公民提問的等票驗證列還有排在隊尾的';
  END IF;
END $$;
