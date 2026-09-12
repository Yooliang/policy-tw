-- ============================================================
-- Agent System Tables
-- External AI Agent contribution system
-- ============================================================

-- ============================================================
-- 1. agent_keys - Agent 密鑰管理
-- ============================================================

CREATE TABLE agent_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  secret_hash TEXT NOT NULL,                    -- SHA-256 hash of the secret
  secret_prefix TEXT NOT NULL,                  -- First 8 chars (e.g., "agt_abc1")
  agent_name TEXT NOT NULL,                     -- Agent display name
  email TEXT NOT NULL,                          -- Responsible person's email
  purpose TEXT,                                 -- Purpose description

  is_active BOOLEAN DEFAULT true,

  -- Rate limiting
  rate_limit_per_minute INTEGER DEFAULT 60,

  -- Reputation system
  reputation_score DECIMAL(3,2) DEFAULT 0.50 CHECK (reputation_score >= 0 AND reputation_score <= 1),
  total_submissions INTEGER DEFAULT 0,
  accepted_submissions INTEGER DEFAULT 0,
  rejected_submissions INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,

  UNIQUE(secret_hash),
  UNIQUE(secret_prefix)
);

-- ============================================================
-- 2. agent_tasks - 待處理任務
-- ============================================================

CREATE TABLE agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_type TEXT NOT NULL CHECK (task_type IN ('research', 'verify', 'update')),
  priority INTEGER DEFAULT 5 CHECK (priority >= 1 AND priority <= 10),

  -- Related data (stored as references, no foreign keys to avoid type conflicts)
  -- The actual tables may use UUID or INTEGER depending on migration history
  politician_id UUID,
  policy_id UUID,
  election_id INTEGER,

  -- Task description
  description TEXT NOT NULL,
  context JSONB,

  -- Peer verification
  required_verifications INTEGER DEFAULT 1 CHECK (required_verifications >= 1 AND required_verifications <= 5),
  current_verifications INTEGER DEFAULT 0,
  verification_agents UUID[],                  -- Array of agent IDs who verified

  -- Status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'pending_verification', 'completed', 'failed', 'expired')),
  claimed_by UUID REFERENCES agent_keys(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- ============================================================
-- 3. agent_task_results - 任務執行結果
-- ============================================================

CREATE TABLE agent_task_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  agent_key_id UUID NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE,
  result_type TEXT NOT NULL CHECK (result_type IN ('primary', 'verification')),

  -- Result data
  payload JSONB NOT NULL,
  sources TEXT[] NOT NULL DEFAULT '{}',
  confidence_score DECIMAL(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),

  -- Verification feedback (for 'verification' type)
  agrees_with_primary BOOLEAN,
  disagreement_notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. agent_heartbeats - Agent 心跳紀錄
-- ============================================================

CREATE TABLE agent_heartbeats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key_id UUID NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE,

  -- Status report
  status TEXT NOT NULL CHECK (status IN ('active', 'idle', 'processing', 'error')),
  current_task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
  message TEXT,

  -- Statistics
  tasks_completed_today INTEGER DEFAULT 0,
  errors_today INTEGER DEFAULT 0,

  -- Agent info
  agent_version TEXT,
  capabilities TEXT[],

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 5. agent_challenges - 動態挑戰 (防機器人)
-- ============================================================

CREATE TABLE agent_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key_id UUID REFERENCES agent_keys(id) ON DELETE CASCADE,

  challenge_type TEXT NOT NULL CHECK (challenge_type IN ('math', 'logic', 'decode')),
  puzzle TEXT NOT NULL,                        -- Base64 encoded puzzle
  answer_hash TEXT NOT NULL,                   -- SHA-256 hash of correct answer

  used BOOLEAN DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 6. agent_rate_limits - 速率限制追蹤
-- ============================================================

CREATE TABLE agent_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_key_id UUID NOT NULL REFERENCES agent_keys(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,           -- Start of the 1-minute window
  request_count INTEGER DEFAULT 1,

  UNIQUE(agent_key_id, window_start)
);

-- ============================================================
-- Indexes
-- ============================================================

-- agent_keys
CREATE INDEX idx_agent_keys_secret_hash ON agent_keys(secret_hash);
CREATE INDEX idx_agent_keys_email ON agent_keys(email);
CREATE INDEX idx_agent_keys_is_active ON agent_keys(is_active);

-- agent_tasks
CREATE INDEX idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX idx_agent_tasks_task_type ON agent_tasks(task_type);
CREATE INDEX idx_agent_tasks_priority ON agent_tasks(priority DESC);
CREATE INDEX idx_agent_tasks_claimed_by ON agent_tasks(claimed_by);
CREATE INDEX idx_agent_tasks_created_at ON agent_tasks(created_at);
CREATE INDEX idx_agent_tasks_expires_at ON agent_tasks(expires_at);

-- agent_task_results
CREATE INDEX idx_agent_task_results_task_id ON agent_task_results(task_id);
CREATE INDEX idx_agent_task_results_agent_key_id ON agent_task_results(agent_key_id);
CREATE INDEX idx_agent_task_results_result_type ON agent_task_results(result_type);

-- agent_heartbeats
CREATE INDEX idx_agent_heartbeats_agent_key_id ON agent_heartbeats(agent_key_id);
CREATE INDEX idx_agent_heartbeats_created_at ON agent_heartbeats(created_at);

-- agent_challenges
CREATE INDEX idx_agent_challenges_agent_key_id ON agent_challenges(agent_key_id);
CREATE INDEX idx_agent_challenges_expires_at ON agent_challenges(expires_at);

-- agent_rate_limits
CREATE INDEX idx_agent_rate_limits_agent_key_id ON agent_rate_limits(agent_key_id);
CREATE INDEX idx_agent_rate_limits_window_start ON agent_rate_limits(window_start);

-- ============================================================
-- RLS (Row Level Security)
-- ============================================================

ALTER TABLE agent_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_task_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_rate_limits ENABLE ROW LEVEL SECURITY;

-- Public read access for tasks (agents need to see available tasks)
CREATE POLICY "Public read access" ON agent_tasks FOR SELECT USING (true);

-- Other tables are accessed via service role only (Edge Functions)
-- No direct public access for security

-- ============================================================
-- Helper Functions
-- ============================================================

-- Function to clean up expired challenges
CREATE OR REPLACE FUNCTION cleanup_expired_agent_challenges()
RETURNS void AS $$
BEGIN
  DELETE FROM agent_challenges WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to clean up old heartbeats (keep last 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_agent_heartbeats()
RETURNS void AS $$
BEGIN
  DELETE FROM agent_heartbeats WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to clean up old rate limit records (keep last 1 hour)
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits()
RETURNS void AS $$
BEGIN
  DELETE FROM agent_rate_limits WHERE window_start < NOW() - INTERVAL '1 hour';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to expire uncompleted claimed tasks (after 2 hours)
CREATE OR REPLACE FUNCTION expire_stale_agent_tasks()
RETURNS void AS $$
BEGIN
  UPDATE agent_tasks
  SET
    status = 'pending',
    claimed_by = NULL,
    claimed_at = NULL
  WHERE
    status = 'in_progress'
    AND claimed_at < NOW() - INTERVAL '2 hours';

  UPDATE agent_tasks
  SET status = 'expired'
  WHERE
    status IN ('pending', 'pending_verification')
    AND expires_at IS NOT NULL
    AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- Views
-- ============================================================

-- View for available tasks (pending, not expired, not claimed)
CREATE OR REPLACE VIEW agent_tasks_available AS
SELECT
  t.*,
  p.name AS politician_name,
  pol.title AS policy_title
FROM agent_tasks t
LEFT JOIN politicians p ON t.politician_id = p.id
LEFT JOIN policies pol ON t.policy_id = pol.id
WHERE
  t.status = 'pending'
  AND (t.expires_at IS NULL OR t.expires_at > NOW());

-- View for tasks pending verification
CREATE OR REPLACE VIEW agent_tasks_pending_verification AS
SELECT
  t.*,
  p.name AS politician_name,
  pol.title AS policy_title,
  (SELECT payload FROM agent_task_results r WHERE r.task_id = t.id AND r.result_type = 'primary' LIMIT 1) AS primary_result
FROM agent_tasks t
LEFT JOIN politicians p ON t.politician_id = p.id
LEFT JOIN policies pol ON t.policy_id = pol.id
WHERE t.status = 'pending_verification';

-- View for agent statistics
CREATE OR REPLACE VIEW agent_stats AS
SELECT
  ak.id,
  ak.agent_name,
  ak.email,
  ak.reputation_score,
  ak.total_submissions,
  ak.accepted_submissions,
  ak.rejected_submissions,
  ak.is_active,
  ak.last_used_at,
  (SELECT COUNT(*) FROM agent_tasks WHERE claimed_by = ak.id AND status = 'in_progress') AS active_tasks,
  (SELECT COUNT(*) FROM agent_heartbeats WHERE agent_key_id = ak.id AND created_at > NOW() - INTERVAL '24 hours') AS heartbeats_24h
FROM agent_keys ak;
