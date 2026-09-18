-- 名單清查：把「發現新候選人」這件事也變成任務。
--
-- 現有的自動缺口全部是對已知資料下查詢，所以系統只會補洞、不會發現新東西。
-- 2026 選舉還在進行，候選人名單會變，而系統不會自己知道。
--
-- 設計：一個任務只查一個縣市的一種選舉。範圍小＝單一代理負擔小，
-- 而且驗證者只要打開同一個中選會頁面數一遍就能核對，不必重做整份比對。
--
-- 缺口怎麼算出來：記下每個（縣市 × 選舉類型）最後被清查的時間，超過 N 天沒查
-- 就自動變成任務。查完了任務自己消失，不需要任何人去關掉——跟其他自動缺口同一套邏輯。

CREATE TABLE IF NOT EXISTS roster_checks (
  id            BIGSERIAL PRIMARY KEY,
  election_id   INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  region        TEXT NOT NULL,
  election_type TEXT NOT NULL,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 清查當下中選會上有幾人、我們資料庫有幾人、代理另外補交了幾筆
  cec_count     INTEGER,
  ours_count    INTEGER,
  submitted     INTEGER NOT NULL DEFAULT 0,
  agent_name    TEXT,
  source_url    TEXT,
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  CONSTRAINT roster_checks_one_per_slot UNIQUE (election_id, region, election_type, checked_at)
);
COMMENT ON TABLE roster_checks IS '每個縣市×選舉類型的名單清查紀錄；自動缺口用最後清查時間決定要不要再派';
CREATE INDEX IF NOT EXISTS roster_checks_slot_idx ON roster_checks (election_id, region, election_type, checked_at DESC);

ALTER TABLE roster_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON roster_checks;
CREATE POLICY "Public read" ON roster_checks FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON roster_checks;
CREATE POLICY "Service role write" ON roster_checks FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 這一屆要清查哪些組合。刻意只放縣市長與縣市議員：
-- 村里長全台上萬人，一個任務查一個縣市的村里長太大，違背「範圍小才好驗證」。
-- 之後要擴充就往這張表加列，不用改函式。
CREATE TABLE IF NOT EXISTS roster_check_scope (
  election_id     INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  election_type   TEXT NOT NULL,
  recheck_days    INTEGER NOT NULL DEFAULT 7,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (election_id, election_type)
);
COMMENT ON TABLE roster_check_scope IS '名單清查的範圍與重查週期；加一列就多一種選舉類型進任務池';

ALTER TABLE roster_check_scope ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON roster_check_scope;
CREATE POLICY "Public read" ON roster_check_scope FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON roster_check_scope;
CREATE POLICY "Service role write" ON roster_check_scope FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

INSERT INTO roster_check_scope (election_id, election_type, recheck_days) VALUES
  (2026, '縣市長', 7),
  (2026, '縣市議員', 7)
ON CONFLICT (election_id, election_type) DO NOTHING;

-- 新的貢獻型別：roster_check（回報清查結果，不直接改核心資料）
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction',
                               'task_suggestion', 'no_change', 'adjudication', 'question_answer',
                               'removal', 'roster_check'));
