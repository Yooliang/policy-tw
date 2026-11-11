-- 強模型裁決作業表（2026-11-11 維護者要求；主控台「強模型裁決」頁）。
-- 端點 strong-adjudicate 不呼叫任何模型：維護者 enqueue 一件 → 執行者（持 STRONG_LANE_KEY 的 VM 上 claude）claim 取題、complete 回報
-- 結果（status=previewed）→ 維護者在主控台看過後 finalize（伺服器端帶鑰匙送 /report）或 return_to_human。
-- 本表只有 service_role 能碰（RLS 開、不給 anon／authenticated 任何政策）。cause_category 的值與 strong-adjudicate.ts 的 CAUSE_CATEGORIES 同一份（守門測試比對）。

CREATE TABLE IF NOT EXISTS strong_adjudications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            TEXT NOT NULL,
  contribution_id    TEXT,
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','previewed','finalizing','finalized','finalize_failed','returned','failed')),
  requested_by       TEXT NOT NULL,
  claimed_by         TEXT,
  claimed_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  model              TEXT,
  verdict            TEXT CHECK (verdict IN ('uphold','uphold_with_correction','reject')),
  corrected_fields   JSONB,
  reasoning          TEXT,
  checked_urls       JSONB,
  cause_category     TEXT CHECK (cause_category IN ('來源難讀','前提過時','沒判斷型別','身分','拿錯名冊','規格不清','來源打不開','其他')),
  cause_note         TEXT,
  prompt_tokens      INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens  INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  cost               NUMERIC(10,6) CHECK (cost IS NULL OR cost >= 0),
  finalized_by       TEXT,
  finalized_at       TIMESTAMPTZ,
  report_response    JSONB,
  returned_by        TEXT,
  returned_at        TIMESTAMPTZ,
  return_reason      TEXT,
  error              TEXT,
  last_error         TEXT,
  claim_failures     INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一件任務同時只能有一筆排隊或執行中（enqueue 並發也只有一筆成功）
CREATE UNIQUE INDEX IF NOT EXISTS strong_adjudications_one_active_per_task
  ON strong_adjudications (task_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS strong_adjudications_task_idx ON strong_adjudications (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS strong_adjudications_created_idx ON strong_adjudications (created_at DESC);

CREATE OR REPLACE FUNCTION strong_adjudications_touch() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS strong_adjudications_touch ON strong_adjudications;
CREATE TRIGGER strong_adjudications_touch BEFORE UPDATE ON strong_adjudications FOR EACH ROW EXECUTE FUNCTION strong_adjudications_touch();

ALTER TABLE strong_adjudications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON strong_adjudications FROM PUBLIC, anon, authenticated;
GRANT ALL ON strong_adjudications TO service_role;
DROP POLICY IF EXISTS "Service role only" ON strong_adjudications;
CREATE POLICY "Service role only" ON strong_adjudications FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE strong_adjudications IS '強模型裁決作業（queued→running→previewed→finalized／returned／failed）。只有 service_role 能碰；端點 strong-adjudicate 不呼叫模型，執行者 claim／complete。2026-11-11';
