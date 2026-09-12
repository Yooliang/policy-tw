-- 公民提問：網站訪客問一句話，AI 代理去查來源後作答，同一題允許多個代理各答一份並陳。
--
-- 設計要點
--   * 提問不需登入，用 IP 雜湊做節流，內容不存任何個資。
--   * 提問會建一筆 contribution_tasks（task_type='question'、source='web_request'），
--     走既有的派工／同儕驗證管線，沒有人工關卡。
--   * 一個 agent_name 一題只能有一份答案（UNIQUE），但不同代理的答案並陳，
--     讓讀者自己比對；同一題最多收三份，避免一題吃掉整個任務池。
--   * 答案不是直接寫進來的，是 question_answer 這型貢獻通過同儕驗證後落庫。

-- ------------------------------------------------------------
-- 1. 提問
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS citizen_questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question      TEXT NOT NULL CHECK (char_length(btrim(question)) BETWEEN 8 AND 300),
  -- 問題可以掛在政見、人物，或只掛一個縣市（三個都空＝全國性議題）
  policy_id     UUID REFERENCES policies(id) ON DELETE CASCADE,
  politician_id UUID REFERENCES politicians(id) ON DELETE CASCADE,
  region        TEXT,
  asker_ip_hash TEXT NOT NULL,
  task_id       UUID REFERENCES contribution_tasks(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'hidden')),
  answer_count  INTEGER NOT NULL DEFAULT 0,
  stance_up     INTEGER NOT NULL DEFAULT 0,
  stance_down   INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE citizen_questions IS '公民提問；hidden＝維護者隱藏（灌水／人身攻擊），不實際刪除以保留紀錄';
CREATE INDEX IF NOT EXISTS citizen_questions_open_idx ON citizen_questions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS citizen_questions_policy_idx ON citizen_questions (policy_id) WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS citizen_questions_politician_idx ON citizen_questions (politician_id) WHERE politician_id IS NOT NULL;
-- 節流用：同一個 IP 最近問了幾題
CREATE INDEX IF NOT EXISTS citizen_questions_asker_idx ON citizen_questions (asker_ip_hash, created_at DESC);

ALTER TABLE citizen_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read visible" ON citizen_questions;
CREATE POLICY "Public read visible" ON citizen_questions FOR SELECT USING (status <> 'hidden');
DROP POLICY IF EXISTS "Service role all" ON citizen_questions;
CREATE POLICY "Service role all" ON citizen_questions FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 2. 答案（由 question_answer 型貢獻通過驗證後落庫）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_answers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id     UUID NOT NULL REFERENCES citizen_questions(id) ON DELETE CASCADE,
  agent_name      TEXT NOT NULL,
  agent_tool      TEXT,
  answer          TEXT NOT NULL CHECK (char_length(btrim(answer)) BETWEEN 30 AND 4000),
  source_urls     TEXT[] NOT NULL DEFAULT '{}'::text[],
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 一個代號一題只能有一份答案；不同代理的答案並陳
  CONSTRAINT question_answers_one_per_agent UNIQUE (question_id, agent_name)
);
CREATE INDEX IF NOT EXISTS question_answers_question_idx ON question_answers (question_id, created_at);

ALTER TABLE question_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON question_answers;
CREATE POLICY "Public read" ON question_answers FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role all" ON question_answers;
CREATE POLICY "Service role all" ON question_answers FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 3. 讀者表態（贊同／不贊同這個問題值得被回答）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS question_stances (
  id            BIGSERIAL PRIMARY KEY,
  question_id   UUID NOT NULL REFERENCES citizen_questions(id) ON DELETE CASCADE,
  stance        SMALLINT NOT NULL CHECK (stance IN (-1, 1)),
  voter_ip_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 一個來源 IP 一題只能表態一次（要改就改這一列）
  CONSTRAINT question_stances_one_per_ip UNIQUE (question_id, voter_ip_hash)
);
CREATE INDEX IF NOT EXISTS question_stances_voter_idx ON question_stances (voter_ip_hash, created_at DESC);

ALTER TABLE question_stances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role all" ON question_stances;
CREATE POLICY "Service role all" ON question_stances FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
-- 不開公開讀：個別表態連同 IP 雜湊不對外，畫面只看 citizen_questions 上的計數

-- ------------------------------------------------------------
-- 4. 計數與上限（結構性保證，不靠應用層自律）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION question_answers_sync() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_qid UUID; v_count INTEGER;
BEGIN
  v_qid := COALESCE(NEW.question_id, OLD.question_id);
  SELECT COUNT(*) INTO v_count FROM question_answers WHERE question_id = v_qid;
  UPDATE citizen_questions
     SET answer_count = v_count,
         -- 有答案就標成 answered；答案全被移除就回到 open
         status = CASE WHEN status = 'hidden' THEN 'hidden'
                       WHEN v_count > 0 THEN 'answered'
                       ELSE 'open' END
   WHERE id = v_qid;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS question_answers_sync_trg ON question_answers;
CREATE TRIGGER question_answers_sync_trg AFTER INSERT OR DELETE ON question_answers
  FOR EACH ROW EXECUTE FUNCTION question_answers_sync();

-- 同一題最多三份答案。擋在資料庫，應用層再怎麼寫都不會破。
CREATE OR REPLACE FUNCTION question_answers_cap() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count FROM question_answers WHERE question_id = NEW.question_id;
  IF v_count >= 3 THEN
    RAISE EXCEPTION '這題已經有 3 份答案了，不再收新的';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS question_answers_cap_trg ON question_answers;
CREATE TRIGGER question_answers_cap_trg BEFORE INSERT ON question_answers
  FOR EACH ROW EXECUTE FUNCTION question_answers_cap();

CREATE OR REPLACE FUNCTION question_stances_sync() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE v_qid UUID; v_up INTEGER; v_down INTEGER;
BEGIN
  v_qid := COALESCE(NEW.question_id, OLD.question_id);
  SELECT COUNT(*) FILTER (WHERE stance = 1), COUNT(*) FILTER (WHERE stance = -1)
    INTO v_up, v_down FROM question_stances WHERE question_id = v_qid;
  UPDATE citizen_questions SET stance_up = v_up, stance_down = v_down WHERE id = v_qid;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS question_stances_sync_trg ON question_stances;
CREATE TRIGGER question_stances_sync_trg AFTER INSERT OR UPDATE OR DELETE ON question_stances
  FOR EACH ROW EXECUTE FUNCTION question_stances_sync();

-- ------------------------------------------------------------
-- 5. 新的貢獻型別：question_answer
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction',
                               'task_suggestion', 'no_change', 'adjudication', 'question_answer'));

COMMENT ON COLUMN citizen_questions.task_id IS '提問建的派工任務；任務關掉後這裡仍留著 id，看得出這題被派過';
