-- 管線健康度的時間序列：每 4 小時一筆，給網站上的圖表用。
--
-- 為什麼用 SQL 函式加 pg_cron，不做成 Edge Function：
-- 採樣要定時跑，如果做成 HTTP 端點就得再開一支對外的路，而排程器又不方便帶金鑰
-- （apply-verified 就是為了讓 cron 打得到而刻意不設守衛的）。這件事完全可以在
-- 資料庫裡算完，不需要任何對外表面。

CREATE TABLE IF NOT EXISTS pipeline_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 任務池：總數與各類缺口的細目
  tasks_open    INTEGER NOT NULL DEFAULT 0,
  tasks_by_type JSONB   NOT NULL DEFAULT '{}'::jsonb,
  -- 貢獻佇列
  pending       INTEGER NOT NULL DEFAULT 0,
  applied       INTEGER NOT NULL DEFAULT 0,
  disputed      INTEGER NOT NULL DEFAULT 0,
  rejected      INTEGER NOT NULL DEFAULT 0,
  -- 驗證：累計票數，以及投過票的人數
  votes_total   INTEGER NOT NULL DEFAULT 0,
  voters        INTEGER NOT NULL DEFAULT 0,
  -- 正式資料量，看管線到底有沒有讓資料長出來
  policies      INTEGER NOT NULL DEFAULT 0,
  politicians   INTEGER NOT NULL DEFAULT 0,
  questions     INTEGER NOT NULL DEFAULT 0
);
COMMENT ON TABLE pipeline_snapshots IS '每 4 小時一筆的管線健康度快照；網站上的追蹤圖表讀這張表';
CREATE INDEX IF NOT EXISTS pipeline_snapshots_taken_idx ON pipeline_snapshots (taken_at DESC);

ALTER TABLE pipeline_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON pipeline_snapshots;
CREATE POLICY "Public read" ON pipeline_snapshots FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON pipeline_snapshots;
CREATE POLICY "Service role write" ON pipeline_snapshots FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 採樣函式
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION pipeline_take_snapshot() RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_by_type JSONB;
  v_auto    INTEGER;
  v_manual  INTEGER;
  v_id      BIGINT;
BEGIN
  -- 各類自動缺口。contribution_auto_tasks 是即時算的，所以這裡拿到的是當下真實缺口。
  SELECT COALESCE(jsonb_object_agg(task_type, total), '{}'::jsonb), COALESCE(SUM(total), 0)
    INTO v_by_type, v_auto
    FROM contribution_auto_task_counts(NULL);

  SELECT COUNT(*) INTO v_manual FROM contribution_tasks WHERE status = 'open';
  v_by_type := v_by_type || jsonb_build_object('manual_open', v_manual);

  INSERT INTO pipeline_snapshots (
    tasks_open, tasks_by_type, pending, applied, disputed, rejected,
    votes_total, voters, policies, politicians, questions
  )
  SELECT
    v_auto + v_manual,
    v_by_type,
    (SELECT COUNT(*) FROM contributions WHERE status = 'pending'),
    (SELECT COUNT(*) FROM contributions WHERE status = 'applied'),
    (SELECT COUNT(*) FROM contributions WHERE status = 'disputed'),
    (SELECT COUNT(*) FROM contributions WHERE status = 'rejected'),
    (SELECT COUNT(*) FROM contribution_votes),
    (SELECT COUNT(DISTINCT agent_name) FROM contribution_votes),
    (SELECT COUNT(*) FROM policies WHERE removed_at IS NULL),
    (SELECT COUNT(*) FROM politicians),
    (SELECT COUNT(*) FROM citizen_questions WHERE status <> 'hidden')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION pipeline_take_snapshot IS '寫入一筆管線快照；由 pg_cron 每 4 小時呼叫一次';

-- ------------------------------------------------------------
-- 排程：每 4 小時（00、04、08、12、16、20 時整）
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule('pipeline-snapshot-4h');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- 還沒排過就略過
END $$;

SELECT cron.schedule('pipeline-snapshot-4h', '0 */4 * * *', 'SELECT pipeline_take_snapshot();');

-- 先寫一筆，圖表不要一開始是空的
SELECT pipeline_take_snapshot();
