-- ============================================================
-- 日本站：驗證派工的原子認領（正見 20261011370000_verify_dispatch_claim.sql 的複本，只換 schema 與 search_path）。
-- jp-next 跟 next 同一個寫法：15 分鐘內已派給同一網段的回 false，jp-next 換下一筆候選。
-- ============================================================
CREATE OR REPLACE FUNCTION policy_jp.verify_dispatch_claim(p_contribution_id UUID, p_ip_hash TEXT, p_agent_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql VOLATILE SET search_path = policy_jp, pg_temp AS $$
  WITH claimed AS (
    INSERT INTO policy_jp.verify_dispatches AS vd (contribution_id, ip_hash, agent_name, dispatched_at)
    VALUES (p_contribution_id, p_ip_hash, p_agent_name, now())
    ON CONFLICT (contribution_id, ip_hash) DO UPDATE
      SET agent_name = EXCLUDED.agent_name, dispatched_at = EXCLUDED.dispatched_at
      WHERE vd.dispatched_at <= now() - interval '15 minutes'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;
COMMENT ON FUNCTION policy_jp.verify_dispatch_claim(UUID, TEXT, TEXT) IS
  '驗證派工的原子認領（正見 verify_dispatch_claim 的複本）：15 分鐘內已派給同一網段的回 false，否則寫 verify_dispatches 回 true。2026-10-14。';
REVOKE ALL ON FUNCTION policy_jp.verify_dispatch_claim(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION policy_jp.verify_dispatch_claim(UUID, TEXT, TEXT) TO service_role;
