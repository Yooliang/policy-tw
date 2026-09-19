-- 鏡像：DiTurst 倉庫 sql/09_identity_display_name_rpc.sql @ bc61332（IDN-R14、IDN-R19）。編寫真相在 DiTurst；改動先改那邊再鏡像，不要直接改這裡。

-- DiTrust identity: public-schema RPC wrapper for display names
-- IDN-R17 applies unchanged: ditrust stays unexposed, the edge functions only
-- ever reach it through wrappers in public that are granted to service_role.
--
-- Requires 07_identity_public_rpc.sql and 08_identity_display_name.sql.
--
-- How to check by hand once this is pushed:
--   SELECT * FROM public.ditrust_set_display_name('<email>', '小梁', false, '7 days');
--     -> status 'set' the first time, then 'kept' because provision never
--        overwrites a name that is already there
--   SELECT * FROM public.ditrust_set_display_name('<other email>', '小梁', true, '7 days');
--     -> status 'taken'
--   SELECT * FROM public.ditrust_set_display_name('<email>', '小梁2', true, '7 days');
--     -> status 'set', then calling it again returns 'cooldown' with
--        retry_after_seconds close to 7 days
CREATE OR REPLACE FUNCTION public.ditrust_set_display_name(
  p_email TEXT,
  p_name TEXT,
  p_enforce_cooldown BOOLEAN,
  p_cooldown INTERVAL
) RETURNS TABLE (agent_id UUID, display_name TEXT, status TEXT, retry_after_seconds INT)
LANGUAGE sql SECURITY DEFINER SET search_path = ditrust, auth, pg_temp AS $$
  SELECT * FROM ditrust.set_display_name(p_email, p_name, p_enforce_cooldown, p_cooldown);
$$;

REVOKE ALL ON FUNCTION public.ditrust_set_display_name(TEXT, TEXT, BOOLEAN, INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ditrust_set_display_name(TEXT, TEXT, BOOLEAN, INTERVAL) TO service_role;
