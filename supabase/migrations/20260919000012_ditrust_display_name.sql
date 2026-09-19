-- 鏡像：DiTurst 倉庫 sql/08_identity_display_name.sql @ bc61332（IDN-R14、IDN-R19）。編寫真相在 DiTurst；改動先改那邊再鏡像，不要直接改這裡。

-- DiTrust identity: agent display names
-- IDN-R19. display_name is what policy-tw shows as the agent's handle, so it
-- has to be unique and DiTrust has to be the one issuing it.
--
-- Requires 06_identity_ditrust_schema.sql.
--
-- Before pushing, confirm there is nothing to collide with:
--   SELECT lower(display_name), count(*) FROM ditrust.agents
--   WHERE display_name IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
-- A non-empty result makes the unique index below roll the migration back.

ALTER TABLE ditrust.agents
  ADD COLUMN IF NOT EXISTS display_name_changed_at TIMESTAMPTZ;

-- Deliberately coarser than the rule in _shared/display-name.ts. Postgres
-- regex has no \p{L}, and [[:alnum:]] follows the database collation, so a
-- strict mirror here could reject the Chinese names this feature is for. The
-- exact character rule is enforced in the edge function; this only stops the
-- shapes that are wrong under any collation.
ALTER TABLE ditrust.agents
  DROP CONSTRAINT IF EXISTS agents_display_name_shape;
ALTER TABLE ditrust.agents
  ADD CONSTRAINT agents_display_name_shape CHECK (
    display_name IS NULL
    OR (
      char_length(display_name) BETWEEN 2 AND 64
      AND display_name !~ '[[:space:][:cntrl:]]'
      AND lower(display_name) NOT LIKE 'ditrust-%'
      AND lower(display_name) NOT LIKE 'diturst-%'
    )
  );

-- Case-insensitive uniqueness. normalize() keeps two spellings of the same
-- name from both being taken; without it "小梁" in NFC and NFD would be two
-- different handles that render identically.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ditrust_agents_display_name
  ON ditrust.agents (lower(normalize(display_name, NFC)))
  WHERE display_name IS NOT NULL;

-- Returns a status rather than raising, so the caller can tell "someone else
-- has this name" apart from "you renamed too recently" without parsing errors.
--   set       name written
--   kept      account already has a name and this call must not overwrite it
--   taken     another agent holds it
--   cooldown  renamed too recently; retry_after_seconds says when
--   not_found no active agent with this email
--
-- p_enforce_cooldown is false for provision (first name) and true for rename.
CREATE OR REPLACE FUNCTION ditrust.set_display_name(
  p_email TEXT,
  p_name TEXT,
  p_enforce_cooldown BOOLEAN,
  p_cooldown INTERVAL
) RETURNS TABLE (agent_id UUID, display_name TEXT, status TEXT, retry_after_seconds INT) AS $$
DECLARE
  v_id UUID;
  v_current TEXT;
  v_changed_at TIMESTAMPTZ;
  v_ready_at TIMESTAMPTZ;
BEGIN
  SELECT a.id, a.display_name, a.display_name_changed_at
  INTO v_id, v_current, v_changed_at
  FROM ditrust.agents a
  WHERE a.email = p_email AND a.is_active;

  IF v_id IS NULL THEN
    RETURN QUERY SELECT NULL::UUID, NULL::TEXT, 'not_found'::TEXT, NULL::INT;
    RETURN;
  END IF;

  IF p_enforce_cooldown AND v_changed_at IS NOT NULL THEN
    v_ready_at := v_changed_at + p_cooldown;
    IF v_ready_at > now() THEN
      RETURN QUERY SELECT v_id, v_current, 'cooldown'::TEXT,
        GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_ready_at - now())))::INT);
      RETURN;
    END IF;
  END IF;

  IF NOT p_enforce_cooldown AND v_current IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_current, 'kept'::TEXT, NULL::INT;
    RETURN;
  END IF;

  BEGIN
    UPDATE ditrust.agents a
    SET display_name = p_name,
        display_name_changed_at = CASE WHEN p_enforce_cooldown THEN now() ELSE a.display_name_changed_at END
    WHERE a.id = v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT v_id, v_current, 'taken'::TEXT, NULL::INT;
    RETURN;
  END;

  RETURN QUERY SELECT v_id, p_name, 'set'::TEXT, NULL::INT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = ditrust, pg_temp;

REVOKE ALL ON FUNCTION ditrust.set_display_name(TEXT, TEXT, BOOLEAN, INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION ditrust.set_display_name(TEXT, TEXT, BOOLEAN, INTERVAL) TO service_role;
