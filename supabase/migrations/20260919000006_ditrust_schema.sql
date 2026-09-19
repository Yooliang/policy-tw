-- 鏡像：DiTurst 倉庫 sql/06_identity_ditrust_schema.sql @ ec2c55d（IDN-R14）。
-- 編寫真相在 DiTurst；這份只是為了讓共用專案的 migration 歷史留在 policy-tw 這邊。
-- 改動一律先改 DiTurst 那份，再把新版本連同 commit SHA 鏡像過來；不要直接改這裡。
-- DiTurst 的 sql/01～05 是 public schema 的舊版原件，不進共用專案；只有 06 走鏡像（IDN-R9 補充）。
-- 紅線：ditrust schema 絕對不能加進 Supabase 的 Exposed schemas，正見的 anon key 是刻意公開的。

-- DiTrust identity schema
-- IDN-R7: shares policy-tw's Supabase project but lives in its own schema.
-- IDN-R9: this file supersedes the public-schema agents/clients in 01_tables.sql.
-- IDN-R11: canonical spelling is "ditrust".
--
-- RED LINE: never add "ditrust" to the project's Exposed schemas in the
-- Supabase dashboard. policy-tw's anon key is deliberately public; exposing
-- this schema would publish every agent_secret.

CREATE SCHEMA IF NOT EXISTS ditrust;

-- ============================================
-- clients (client websites that may call the management endpoints)
-- ============================================
CREATE TABLE ditrust.clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  domain TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  webhook_url TEXT,
  webhook_secret TEXT,
  allowed_categories TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ditrust_clients_api_key ON ditrust.clients(api_key);

-- ============================================
-- agents (agent accounts; id is the shared auth.users id)
-- ============================================
CREATE TABLE ditrust.agents (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  -- IDN-R16: pgcrypto lives in the extensions schema on the shared project and
  -- db push runs migrations without it on the search_path, so this must stay
  -- schema qualified. gen_random_uuid above is built in and must not be.
  agent_secret TEXT UNIQUE NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex'),
  level INT DEFAULT 0 CHECK (level >= 0 AND level <= 3),
  xp DECIMAL DEFAULT 0,
  accuracy_rate DECIMAL DEFAULT 1.0,
  total_submissions INT DEFAULT 0,
  correct_submissions INT DEFAULT 0,
  total_reviews INT DEFAULT 0,
  malicious_reports INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  level_up_at TIMESTAMPTZ
);

CREATE INDEX idx_ditrust_agents_secret ON ditrust.agents(agent_secret);
CREATE INDEX idx_ditrust_agents_email ON ditrust.agents(email);

-- ============================================
-- rate_limits (IDN-R2, fixed window)
-- ============================================
CREATE TABLE ditrust.rate_limits (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, subject, window_start)
);

CREATE INDEX idx_ditrust_rate_limits_window ON ditrust.rate_limits(window_start);

-- Increment and test in one statement so concurrent callers cannot both read
-- the same pre-increment count.
CREATE OR REPLACE FUNCTION ditrust.consume_rate_limit(
  p_scope TEXT,
  p_subject TEXT,
  p_window_start TIMESTAMPTZ,
  p_limit INT
) RETURNS BOOLEAN AS $$
DECLARE
  v_count INT;
BEGIN
  INSERT INTO ditrust.rate_limits (scope, subject, window_start, count)
  VALUES (p_scope, p_subject, p_window_start, 1)
  ON CONFLICT (scope, subject, window_start)
  DO UPDATE SET count = ditrust.rate_limits.count + 1
  RETURNING count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = ditrust, pg_temp;

CREATE OR REPLACE FUNCTION ditrust.purge_rate_limits(p_older_than INTERVAL DEFAULT '1 day')
RETURNS INT AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM ditrust.rate_limits WHERE window_start < NOW() - p_older_than;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = ditrust, pg_temp;

-- ============================================
-- provisioning (IDN-R8)
-- ============================================

-- Reads auth.users so the edge function does not have to page the Admin API.
-- agent_id is NULL when this email has no agent row yet, which is the only
-- thing that decides "created".
--
-- The join is on id, the filter is on email. Joining on email instead makes
-- the condition independent of u, so every auth.users row pairs with the
-- matching agent row and LIMIT 1 can return a stranger's id: with one agent
-- row for x@y and three auth users, the caller gets that agent paired with an
-- arbitrary user. This function is SECURITY DEFINER and reads auth.users, so
-- that id must never belong to anyone but the person being looked up.
CREATE OR REPLACE FUNCTION ditrust.provision_lookup(p_email TEXT)
RETURNS TABLE (agent_id UUID, auth_user_id UUID) AS $$
BEGIN
  RETURN QUERY
  SELECT a.id, u.id
  FROM auth.users u
  FULL OUTER JOIN ditrust.agents a ON a.id = u.id
  WHERE u.email = p_email OR a.email = p_email
  -- If the auth email and the agent email have drifted apart they can match
  -- two different rows; prefer the agent's own row so the answer is stable.
  ORDER BY (a.email = p_email) DESC NULLS LAST
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp;

-- Returns the secret only on the insert that created the row, so a lost race
-- degrades to "already linked" rather than handing out a second copy.
CREATE OR REPLACE FUNCTION ditrust.claim_agent(p_user_id UUID, p_email TEXT)
RETURNS TABLE (agent_id UUID, secret TEXT, created BOOLEAN) AS $$
DECLARE
  v_id UUID;
  v_secret TEXT;
BEGIN
  INSERT INTO ditrust.agents (id, email)
  VALUES (p_user_id, p_email)
  ON CONFLICT DO NOTHING
  RETURNING id, agent_secret INTO v_id, v_secret;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_secret, true;
  ELSE
    RETURN QUERY SELECT a.id, NULL::TEXT, false FROM ditrust.agents a WHERE a.email = p_email;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = ditrust, pg_temp;

-- ============================================
-- privileges: service_role only, nothing for the public anon key
-- ============================================
REVOKE ALL ON SCHEMA ditrust FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA ditrust TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA ditrust TO service_role;

REVOKE ALL ON FUNCTION ditrust.consume_rate_limit(TEXT, TEXT, TIMESTAMPTZ, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ditrust.purge_rate_limits(INTERVAL) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ditrust.provision_lookup(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION ditrust.claim_agent(UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION ditrust.consume_rate_limit(TEXT, TEXT, TIMESTAMPTZ, INT) TO service_role;
GRANT EXECUTE ON FUNCTION ditrust.purge_rate_limits(INTERVAL) TO service_role;
GRANT EXECUTE ON FUNCTION ditrust.provision_lookup(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION ditrust.claim_agent(UUID, TEXT) TO service_role;

-- ============================================

-- 排程（IDN-R13）：rate_limits 固定視窗每 (scope, subject, 視窗) 一列，不清會無限長大

-- ============================================

SELECT cron.unschedule('ditrust-purge-rate-limits-daily')

WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ditrust-purge-rate-limits-daily');

SELECT cron.schedule('ditrust-purge-rate-limits-daily', '20 3 * * *', $$SELECT ditrust.purge_rate_limits('1 day');$$);
