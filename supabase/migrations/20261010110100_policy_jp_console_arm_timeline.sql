-- 主控台派工開關的選舉時間軸：日本站（policy-ops #63，2026-10-10）
-- ============================================================
--
-- 正見版在 20261010110000_console_arm_timeline.sql（7 段的定義、各函式的用途寫在那支檔頭）。這支是 policy_jp 的同形一套，
-- 函式內容依日本站的表改寫（不是逐字複本），登記在 policy-jp-dispatch-drift.test.ts 的 JP_ONLY。差在：
--  選舉 id 是文字鍵、一場選舉一個職位、沒有就任日／屆滿日里程碑；
--   告示日（announced）就是立候補受付日，所以告示日起算第 3 段（正見的 announced 是選舉公告，算第 2 段）
--
-- 守門：supabase/functions/_shared/console-arm-timeline.test.ts（PGlite，兩站）。不碰 public、ditrust。

CREATE TABLE IF NOT EXISTS policy_jp.console_arm_stage_map (
  arm   TEXT PRIMARY KEY,
  stage SMALLINT NOT NULL CHECK (stage BETWEEN 1 AND 7),
  note  TEXT
);
COMMENT ON TABLE policy_jp.console_arm_stage_map IS
  '主控台時間軸（日本站）：派工臂 → 選舉時期（1～7，同正見）。只給沒有日期規則的臂用。改值走 migration。2026-10-10（policy-ops #63）';
ALTER TABLE policy_jp.console_arm_stage_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON policy_jp.console_arm_stage_map;
CREATE POLICY "Public read" ON policy_jp.console_arm_stage_map FOR SELECT USING (true);
REVOKE ALL ON policy_jp.console_arm_stage_map FROM PUBLIC, anon, authenticated;
GRANT SELECT ON policy_jp.console_arm_stage_map TO anon, authenticated;
GRANT ALL ON policy_jp.console_arm_stage_map TO service_role;

INSERT INTO policy_jp.console_arm_stage_map (arm, stage, note) VALUES
  ('manual_visitor', 1, '網站請求'),
  ('manual_open', 1, '其他手動任務'),
  ('election_discovery', 1, '找任期屆滿卻沒有對應選舉的團體'),
  ('local_government_missing', 1, '地方公共團體'),
  ('regional_stats_missing', 1, '區域統計'),
  ('roster_check', 3, '候選人名單（告示後）'),
  ('profile_gap', 3, '人物資料（告示後）'),
  ('profile_detail_gap', 3, '人物細節（告示後）'),
  ('policy_missing', 3, '這次的政見（告示後）')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

CREATE OR REPLACE FUNCTION policy_jp.console_stage_of_kind(p_kind TEXT, p_offset INTEGER, p_until BOOLEAN) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE SET search_path = policy_jp, pg_temp AS $$
  SELECT (CASE
    WHEN NOT p_until THEN CASE
      WHEN p_kind = 'registration_open' THEN 2
      WHEN p_kind IN ('announced', 'registration_close', 'list_published', 'draw', 'bulletin_published') THEN 3
      WHEN p_kind = 'polling' THEN CASE WHEN p_offset < 0 THEN 3 ELSE 4 END
      WHEN p_kind = 'result_announced' THEN 4
      WHEN p_kind = 'certified' THEN 5
    END
    ELSE CASE
      WHEN p_kind IN ('announced', 'registration_open') THEN 2
      WHEN p_kind IN ('registration_close', 'list_published', 'draw', 'bulletin_published') THEN 3
      WHEN p_kind = 'polling' THEN CASE WHEN p_offset > 0 THEN 4 ELSE 3 END
      WHEN p_kind IN ('result_announced', 'certified') THEN 4
    END
  END)::SMALLINT
$$;
COMMENT ON FUNCTION policy_jp.console_stage_of_kind IS '主控台時間軸（日本站）：里程碑＋偏移 → 選舉時期。告示日（announced＝立候補受付）起算第 3 段。2026-10-10（policy-ops #63）';

CREATE OR REPLACE FUNCTION policy_jp.console_arm_stages()
RETURNS TABLE (arm TEXT, stage SMALLINT, stage_source TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH arms AS (SELECT a AS arm FROM unnest(policy_jp.activity_arm_names()) AS a),
  dated AS (
    SELECT r.activity AS arm,
           min(CASE WHEN r.from_kind IS NOT NULL THEN policy_jp.console_stage_of_kind(r.from_kind, r.from_offset, false)
                    ELSE policy_jp.console_stage_of_kind(r.until_kind, r.until_offset, true) END) AS stage
      FROM policy_jp.activity_rules r
     WHERE r.enabled AND r.window_kind <> 'always'
     GROUP BY r.activity
  )
  SELECT ar.arm,
         COALESCE(d.stage, m.stage, 1)::SMALLINT,
         CASE WHEN d.stage IS NOT NULL THEN 'rule' WHEN m.stage IS NOT NULL THEN 'map' ELSE 'default' END
    FROM arms ar
    LEFT JOIN dated d ON d.arm = ar.arm
    LEFT JOIN policy_jp.console_arm_stage_map m ON m.arm = ar.arm
   ORDER BY 2, 1
$$;
COMMENT ON FUNCTION policy_jp.console_arm_stages IS '主控台時間軸（日本站）：每支派工臂的選舉時期（rule／map／default，同正見）。公開唯讀。2026-10-10（policy-ops #63）';

CREATE OR REPLACE FUNCTION policy_jp.console_timeline_elections()
RETURNS TABLE (election_id TEXT, election_date DATE, election_reason TEXT, election_types TEXT[], name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  SELECT x.election_id, x.election_date, x.election_reason, x.election_types, x.name
    FROM (
      SELECT e.id AS election_id, e.election_date, e.election_reason, ARRAY[e.election_type]::TEXT[] AS election_types, e.name
        FROM policy_jp.elections e
       WHERE e.review_status NOT IN ('rejected', 'not_found')
       ORDER BY abs(e.election_date - policy_jp.activity_today()), e.id
       LIMIT 300
    ) x
   ORDER BY x.election_date DESC, x.election_id
$$;
COMMENT ON FUNCTION policy_jp.console_timeline_elections IS '主控台時間軸（日本站）的選舉下拉選單：離今天最近的 300 場（退件、查無的不列）。公開唯讀。2026-10-10（policy-ops #63）';

CREATE OR REPLACE FUNCTION policy_jp.console_timeline(p_election_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
DECLARE
  v_el policy_jp.elections%ROWTYPE;
BEGIN
  SELECT * INTO v_el FROM policy_jp.elections e WHERE e.id = p_election_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'today', policy_jp.activity_today(),
    'election', jsonb_build_object('id', v_el.id, 'date', v_el.election_date, 'reason', v_el.election_reason,
                                   'types', jsonb_build_array(v_el.election_type), 'name', v_el.name),
    'milestones', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind', m.kind, 'election_type', m.election_type, 'on_date', m.on_date, 'status', m.status)
                       ORDER BY m.on_date, m.kind, m.election_type)
        FROM policy_jp.election_milestones_all m WHERE m.election_id = v_el.id
    ), '[]'::JSONB),
    'arms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'arm', s.arm, 'stage', s.stage, 'stage_source', s.stage_source,
               'is_open', EXISTS (SELECT 1 FROM policy_jp.activity_open(s.arm, v_el.id, NULL))
                          OR EXISTS (SELECT 1 FROM policy_jp.activity_open(s.arm, v_el.id, v_el.election_type)),
               'overridden', EXISTS (
                 SELECT 1 FROM policy_jp.activity_overrides o
                  WHERE o.activity = s.arm AND (o.election_id IS NULL OR o.election_id = v_el.id)
                    AND (o.expires_at IS NULL OR o.expires_at >= policy_jp.activity_today())
                    AND (o."force" <> 'window' OR o.open_until IS NULL OR o.open_until >= policy_jp.activity_today())),
               'via', st.via, 'queue_count', st.queue_count,
               'windows', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'rule_id', r.id, 'window_kind', r.window_kind, 'election_types', to_jsonb(r.election_types),
                          'from_kind', r.from_kind, 'until_kind', r.until_kind,
                          'from', CASE WHEN r.window_kind = 'always' THEN NULL ELSE f.d + r.from_offset END,
                          'until', CASE WHEN r.window_kind = 'always' THEN NULL ELSE u.d + r.until_offset END,
                          'missing_milestone', r.window_kind <> 'always'
                            AND ((r.from_kind IS NOT NULL AND f.d IS NULL) OR (r.until_kind IS NOT NULL AND u.d IS NULL)))
                          ORDER BY r.id)
                   FROM policy_jp.activity_rules r
                   LEFT JOIN LATERAL (
                     SELECT min(m.on_date) AS d FROM policy_jp.election_milestones_all m
                      WHERE m.election_id = v_el.id AND m.kind = r.from_kind
                   ) f ON true
                   LEFT JOIN LATERAL (
                     SELECT max(m.on_date) AS d FROM policy_jp.election_milestones_all m
                      WHERE m.election_id = v_el.id AND m.kind = r.until_kind
                   ) u ON true
                  WHERE r.enabled AND r.activity = s.arm
                    AND (r.reasons IS NULL OR v_el.election_reason = ANY (r.reasons))
                    AND (r.election_types IS NULL OR v_el.election_type = ANY (r.election_types))
               ), '[]'::JSONB))
             ORDER BY s.stage, s.arm)
        FROM policy_jp.console_arm_stages() s
        LEFT JOIN policy_jp.console_arm_status() st ON st.arm = s.arm
    ), '[]'::JSONB)
  );
END
$$;
COMMENT ON FUNCTION policy_jp.console_timeline IS
  '主控台時間軸（日本站）：一場選舉的今天、里程碑、每支臂的段、今天開不開、覆寫標記、佇列件數與規則在這場的開放區間（同正見版）。找不到回 NULL。公開唯讀。2026-10-10（policy-ops #63）';

REVOKE ALL ON FUNCTION policy_jp.console_stage_of_kind(TEXT, INTEGER, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION policy_jp.console_arm_stages() FROM PUBLIC;
REVOKE ALL ON FUNCTION policy_jp.console_timeline_elections() FROM PUBLIC;
REVOKE ALL ON FUNCTION policy_jp.console_timeline(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION policy_jp.console_stage_of_kind(TEXT, INTEGER, BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION policy_jp.console_arm_stages() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION policy_jp.console_timeline_elections() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION policy_jp.console_timeline(TEXT) TO anon, authenticated, service_role;
