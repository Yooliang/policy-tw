-- 鏡像：DiTurst 倉庫 sql/07_identity_public_rpc.sql @ cd0d24a（IDN-R14、IDN-R17）。
-- 編寫真相在 DiTurst；改動一律先改那邊再鏡像，不要直接改這裡。
-- 為什麼有這一份：ditrust schema 刻意不暴露給 PostgREST，而 service role 只繞 RLS、不繞 exposed schemas，
-- 所以 Edge Function 對 ditrust 的每一次存取都走這裡的 public.ditrust_* SECURITY DEFINER 包裝，
-- 只 GRANT 給 service_role。ditrust 表因此沒有任何直接的 PostgREST 路徑。

-- DiTrust identity: public-schema RPC wrappers
-- IDN-R17: PostgREST only serves the schemas listed as exposed, and the
-- service role does not change that — it bypasses RLS, not schema exposure.
-- So the edge functions cannot reach ditrust tables directly. Instead of
-- exposing the schema, every access goes through these SECURITY DEFINER
-- wrappers in public, which are revoked from PUBLIC/anon/authenticated and
-- granted only to service_role. The ditrust tables keep having no PostgREST
-- path at all, which is a stronger guarantee than exposing them and relying
-- on REVOKE.
--
-- Requires 06_identity_ditrust_schema.sql.

-- ============================================
-- provisioning (IDN-R8)
-- ============================================
CREATE OR REPLACE FUNCTION public.ditrust_provision_lookup(p_email TEXT)
RETURNS TABLE (agent_id UUID, auth_user_id UUID)
LANGUAGE sql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp AS $$
  SELECT * FROM ditrust.provision_lookup(p_email);
$$;

CREATE OR REPLACE FUNCTION public.ditrust_claim_agent(p_user_id UUID, p_email TEXT)
RETURNS TABLE (agent_id UUID, secret TEXT, created BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp AS $$
  SELECT * FROM ditrust.claim_agent(p_user_id, p_email);
$$;

-- ============================================
-- rate limiting (IDN-R2)
-- ============================================
CREATE OR REPLACE FUNCTION public.ditrust_consume_rate_limit(
  p_scope TEXT,
  p_subject TEXT,
  p_window_start TIMESTAMPTZ,
  p_limit INT
) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp AS $$
  SELECT ditrust.consume_rate_limit(p_scope, p_subject, p_window_start, p_limit);
$$;

-- ============================================
-- client authentication (IDN-R5)
-- ============================================
-- The key is matched here and never returned, so a caller that guesses wrong
-- learns nothing but "no row". Inactive clients are filtered out in the same
-- predicate rather than being handed back for the caller to check.
CREATE OR REPLACE FUNCTION public.ditrust_client_by_key(p_api_key TEXT)
RETURNS TABLE (id UUID, name TEXT, domain TEXT, is_active BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp AS $$
  SELECT c.id, c.name, c.domain, c.is_active
  FROM ditrust.clients c
  WHERE c.api_key = p_api_key AND c.is_active
  LIMIT 1;
$$;

-- ============================================
-- agent identity
-- ============================================
-- verify. Revoked and unknown secrets both return no row, so the edge function
-- cannot tell them apart either (IDN-R3).
CREATE OR REPLACE FUNCTION public.ditrust_agent_by_secret(p_secret TEXT)
RETURNS TABLE (agent_id UUID, display_name TEXT, level INT, is_active BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp AS $$
  SELECT a.id, a.display_name, a.level, a.is_active
  FROM ditrust.agents a
  WHERE a.agent_secret = p_secret AND a.is_active
  LIMIT 1;
$$;

-- reveal.
CREATE OR REPLACE FUNCTION public.ditrust_agent_secret_by_email(p_email TEXT)
RETURNS TABLE (agent_id UUID, secret TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp AS $$
  SELECT a.id, a.agent_secret
  FROM ditrust.agents a
  WHERE a.email = p_email AND a.is_active
  LIMIT 1;
$$;

-- rotate. The new value is generated here so the old secret stops working in
-- the same statement that mints the replacement.
--
-- How to check by hand once this is pushed:
--   SELECT secret ~ '^[0-9a-f]{64}$' FROM public.ditrust_rotate_secret('<email>');
--     -> true, and the value differs from the previous call
--   SELECT * FROM public.ditrust_agent_by_secret('<the previous secret>');
--     -> no rows
CREATE OR REPLACE FUNCTION public.ditrust_rotate_secret(p_email TEXT)
RETURNS TABLE (agent_id UUID, secret TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp AS $$
  UPDATE ditrust.agents a
  SET agent_secret = encode(extensions.gen_random_bytes(32), 'hex')
  WHERE a.email = p_email AND a.is_active
  RETURNING a.id, a.agent_secret;
$$;

-- ============================================
-- privileges: service_role only
-- ============================================
REVOKE ALL ON FUNCTION public.ditrust_provision_lookup(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ditrust_claim_agent(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ditrust_consume_rate_limit(TEXT, TEXT, TIMESTAMPTZ, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ditrust_client_by_key(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ditrust_agent_by_secret(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ditrust_agent_secret_by_email(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ditrust_rotate_secret(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ditrust_provision_lookup(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ditrust_claim_agent(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ditrust_consume_rate_limit(TEXT, TEXT, TIMESTAMPTZ, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ditrust_client_by_key(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ditrust_agent_by_secret(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ditrust_agent_secret_by_email(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.ditrust_rotate_secret(TEXT) TO service_role;
