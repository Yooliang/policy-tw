-- 一人一包 PR1（docs/PLAN-bundle-policies.md 第 1、3 節）：只加結構，線上行為不變。
-- 沒有任何程式會寫 bundle_id，所以 contribution_queue_row 的早退目前永遠不成立；之後的 PR 才開始交包。
-- 只加新的（欄位、表、函式）；contribution_queue_row 簽名不變，沒有要刪的東西，不需要分兩次上。

-- ------------------------------------------------------------
-- 1. contributions 加包鍵
-- ------------------------------------------------------------
ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS bundle_id          UUID,
  ADD COLUMN IF NOT EXISTS bundle_index       SMALLINT,
  ADD COLUMN IF NOT EXISTS bundle_released_at TIMESTAMPTZ;
COMMENT ON COLUMN contributions.bundle_id IS '一人一包：同一包（policy_bundles.id）的條目共用；NULL＝一般逐條交件';
COMMENT ON COLUMN contributions.bundle_index IS '一人一包：條目在包裡的序號，0 起算；每包只有 0 號預設持有驗證票（載體）';
COMMENT ON COLUMN contributions.bundle_released_at IS '一人一包：NULL＝還在包裡（跟著載體的票）；有值＝已釋放成個別條目，自己走驗證票';
CREATE INDEX IF NOT EXISTS idx_contributions_bundle ON contributions (bundle_id) WHERE bundle_id IS NOT NULL;
-- 同一包的序號不重複；有 bundle_id 就一定要有 >= 0 的 bundle_index（index 為 NULL 會讓 contribution_queue_row 的早退「失敗開放」，所以直接擋掉）
CREATE UNIQUE INDEX IF NOT EXISTS idx_contributions_bundle_index ON contributions (bundle_id, bundle_index) WHERE bundle_id IS NOT NULL;
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_bundle_index_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_bundle_index_check CHECK (bundle_id IS NULL OR (bundle_index IS NOT NULL AND bundle_index >= 0)) NOT VALID;
ALTER TABLE contributions VALIDATE CONSTRAINT contributions_bundle_index_check;
-- bundle_id 刻意不設 FK 指向 policy_bundles：交件寫入的先後（先包後條目、或同交易）不該因外鍵卡住，包的存在由交件端保證；孤兒條目只是不屬於任何包的 pending，不影響計分

-- ------------------------------------------------------------
-- 2. policy_bundles：只記「這是一包」這件事；狀態都在逐條的 contributions
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_bundles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             TEXT,
  politician_id       UUID REFERENCES politicians(id) ON DELETE SET NULL,
  election_id         INTEGER,
  source_url          TEXT,
  agent_name          TEXT NOT NULL CHECK (char_length(agent_name) BETWEEN 2 AND 64),
  actor_id            TEXT,
  contributor_ip_hash TEXT,
  item_count          SMALLINT NOT NULL CHECK (item_count >= 1),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE policy_bundles IS '一人一包：一次交件的一包政見（同人、同公報）。只記包這個事實；計分、狀態都在逐條 contributions。';
CREATE INDEX IF NOT EXISTS idx_policy_bundles_task ON policy_bundles (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_policy_bundles_politician ON policy_bundles (politician_id) WHERE politician_id IS NOT NULL;
ALTER TABLE policy_bundles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role all" ON policy_bundles;
CREATE POLICY "Service role all" ON policy_bundles FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 3. bundle_votes：稽核＋冪等（一個人對一包只投一次）；計分來源仍是逐條的 contribution_votes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bundle_votes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id       UUID NOT NULL REFERENCES policy_bundles(id) ON DELETE CASCADE,
  voter_key       TEXT NOT NULL,
  agent_name      TEXT NOT NULL CHECK (char_length(agent_name) BETWEEN 2 AND 64),
  verdict         TEXT NOT NULL CHECK (verdict IN ('agree', 'disagree', 'unsure')),
  except_indexes  SMALLINT[] NOT NULL DEFAULT '{}',
  reasons         JSONB NOT NULL DEFAULT '{}'::jsonb,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bundle_votes_one_per_voter UNIQUE (bundle_id, voter_key)
);
COMMENT ON TABLE bundle_votes IS '一人一包的整包投票紀錄：一人對一包一票（voter_key 與 contribution_votes 的 voter_key 算法相同）；逐條計分走 contribution_votes。';
ALTER TABLE bundle_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role all" ON bundle_votes;
CREATE POLICY "Service role all" ON bundle_votes FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 4. 驗證票插入抽成函式；觸發器加載體早退
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION verify_ticket_enqueue(p_contribution_id UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO task_dispatches (task_id, last_dispatched_at, queue_at, dispatch_count)
  VALUES ('verify:' || p_contribution_id, now(), now(), 0)
  ON CONFLICT (task_id) DO NOTHING;
END $$;
COMMENT ON FUNCTION verify_ticket_enqueue IS '替一條 contribution 建驗證票（已有就不動；位置由觸發器 task_dispatches_queue_key 算）。contribution_queue_row、bundle_pick_carrier 呼叫。2026-11-12';
REVOKE ALL ON FUNCTION verify_ticket_enqueue(UUID) FROM PUBLIC, anon, authenticated;

-- 以 20261017010000 的定義為底，只加「在包裡的非載體條目不建票」早退，並把插票改呼叫 verify_ticket_enqueue
CREATE OR REPLACE FUNCTION contribution_queue_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    -- 一人一包：還在包裡、不是 0 號的條目沒有自己的票，票在載體（0 號）上
    -- （有 bundle_id 而 bundle_index 為 NULL 的列已被 contributions_bundle_index_check 擋掉，這裡遇不到）
    IF NEW.bundle_id IS NOT NULL AND NEW.bundle_index > 0 AND NEW.bundle_released_at IS NULL THEN
      RETURN NEW;
    END IF;
    PERFORM verify_ticket_enqueue(NEW.id);
  END IF;
  RETURN NEW;
END $$;

-- ------------------------------------------------------------
-- 5. 載體移轉：票交給仍在包裡、仍 pending、序號最小的條目；回傳新載體的 contribution id（包裡沒有了就 NULL）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION bundle_pick_carrier(p_bundle_id UUID) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE v_id UUID;
BEGIN
  -- 同一包的載體移轉一次只有一個交易在做，確保一包只有一張票
  PERFORM pg_advisory_xact_lock(hashtext(p_bundle_id::text));
  SELECT c.id INTO v_id
    FROM contributions c
   WHERE c.bundle_id = p_bundle_id AND c.bundle_released_at IS NULL AND c.status = 'pending'
   ORDER BY c.bundle_index ASC, c.created_at ASC, c.id ASC
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    PERFORM verify_ticket_enqueue(v_id);
  END IF;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION bundle_pick_carrier IS '一人一包：載體被釋放或定案後，把票交給同包仍在包裡（bundle_released_at IS NULL）、仍 pending、bundle_index 最小的條目（沒票就建）；回傳新載體 id，沒有可接的回 NULL。不刪舊票（舊載體已非 pending 的票由 seed 清）。2026-11-12';
REVOKE ALL ON FUNCTION bundle_pick_carrier(UUID) FROM PUBLIC, anon, authenticated;
