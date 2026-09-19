-- 傳聞參選（rumored／likely）改成登記或不參選，走一般級 2／2／3／3，不走加減參選人的 4／6／8（外部審查建議 12，2026-09-20）。
-- TS 鏡像：_shared/correction.ts correctionOnlyFromRumor、consensus.ts riskLevel。

CREATE OR REPLACE FUNCTION correction_only_from_rumor(p_payload JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  WITH ch AS (
    SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'changes') = 'array' THEN p_payload->'changes' ELSE '[]'::jsonb END) e
    UNION ALL
    SELECT jsonb_build_object('field', p_payload->>'field', 'current_value', p_payload->>'current_value')
    WHERE p_payload ? 'field'
  ),
  cs AS (SELECT e FROM ch WHERE e->>'field' = 'candidate_status')
  SELECT EXISTS (SELECT 1 FROM cs)
     AND NOT EXISTS (SELECT 1 FROM cs WHERE COALESCE(e->>'current_value', '') NOT IN ('rumored', 'likely'))
$$;

CREATE OR REPLACE FUNCTION contribution_required_agree(p_type TEXT, p_payload JSONB, p_source_urls TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_risk TEXT; v_kind TEXT;
BEGIN
  v_kind := contribution_source_kind(p_source_urls);
  v_risk := CASE
    WHEN p_type = 'adjudication' THEN 'adjudication'
    WHEN p_type = 'removal' THEN 'removal'
    WHEN p_type = 'merge_politician' THEN 'high'
    WHEN p_type = 'candidacy'
         AND p_payload->>'election_result' IN ('elected', 'not_elected')
         AND p_payload->>'politician_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'past_result'
    WHEN p_type = 'correction' AND correction_only_from_rumor(p_payload) THEN 'normal'
    WHEN p_type = 'candidacy' OR (p_type = 'correction' AND (p_payload->>'field' = 'candidate_status' OR p_payload->'changes' @> '[{"field":"candidate_status"}]'::jsonb)) THEN 'high'
    WHEN p_type IN ('task_suggestion', 'no_change', 'roster_check') THEN 'light'
    ELSE 'normal'
  END;
  RETURN CASE
    WHEN v_risk = 'normal' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 3 ELSE 3 END
    WHEN v_risk = 'high' THEN CASE v_kind WHEN 'official' THEN 4 WHEN 'media' THEN 6 WHEN 'social' THEN 8 ELSE 8 END
    WHEN v_risk = 'light' THEN CASE v_kind WHEN 'official' THEN 1 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'past_result' THEN CASE v_kind WHEN 'official' THEN 2 WHEN 'media' THEN 2 WHEN 'social' THEN 2 ELSE 2 END
    WHEN v_risk = 'removal' THEN CASE v_kind WHEN 'official' THEN 3 WHEN 'media' THEN 3 WHEN 'social' THEN 3 ELSE 3 END
    ELSE 4
  END;
END;
$$;

-- 還在等票的那些傳聞更正照新門檻重算
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM contributions WHERE contribution_type = 'correction' AND status IN ('pending', 'verified') AND correction_only_from_rumor(payload) LOOP
    PERFORM contribution_apply_consensus(r.id);
  END LOOP;
END $$;
