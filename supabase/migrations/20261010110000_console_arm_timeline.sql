-- 主控台派工開關的選舉時間軸（policy-ops #63，policy-tw #562，2026-10-10）
-- ============================================================
--
-- 維護者 10-10：主控台派工頁的開關看不出排列順序，要依選舉時期分類、用時間軸串起來。主線規劃 7 段：
--   1 常時（人物資料、出處、重複清理、網站請求）
--   2 參選期（表態 → 登記截止：名單清查、名冊缺口、參選紀錄出處）
--   3 登記後到投票（參選狀態與不參選核對自登記截止起、政黨名冊到投票日為止、號次自抽籤日起、補政見、公報、選區名額、退選查核）
--   4 開票（投票日隔天起：選舉結果、當選缺漏、政黨補齊）
--   5 就任（當選 → 就職：任內政見）
--   主線規劃原把參選狀態、政黨名冊放 2、政黨補齊放 5；審查（#565）裁定有日期規則的臂以規則算出的段為準（時間軸要表達任務實際何時開），
--   種子跟著改成 3／3／4，守門測試逐支比對。
--   6 任期中（進度追蹤、到期檢查、政策脈絡）
--   7 卸任交接
--
-- 這支只加唯讀的東西（正見 public；日本站同形的一套在下一支 20261010110100_policy_jp_console_arm_timeline.sql）：
--   * 表 console_arm_stage_map：臂 → 段。每支臂都登記；實際採用的只有「沒有日期規則」（只有 always 規則）的臂，有日期規則的這列是後備。改值＝一行 migration 的 UPDATE／INSERT。
--   * 函式 console_stage_of_kind(里程碑, 偏移, 是不是迄點)：里程碑 → 段的單一真相。
--   * 函式 console_arm_stages()：每支臂（activity_arm_names()）的段。有日期規則（event／term／recurring）的臂照 activity_rules 的
--     from_kind（沒有起點就看 until_kind）自動算，多條取最早的段（stage_source='rule'）；只有 always 規則的臂查對照表（'map'）；
--     兩邊都沒有＝1 常時（'default'，守門測試會紅，提醒登記）。
--   * 函式 console_timeline_elections()：主控台選舉下拉選單（離今天最近的 300 場）。
--   * 函式 console_timeline(選舉)：一場選舉的時間軸 jsonb——今天、選舉、里程碑（含投票日，正見另有就任日／屆滿日）、每支臂的段、
--     今天對這場選舉開不開（activity_open）、有沒有生效中的覆寫蓋到這場、佇列件數（console_arm_status）、每條規則在這場選舉的開放區間。
--
-- 不動的：console_arm_status() 的輸出（主控台現有頁面在讀，主線建議的「多一欄 stage」改成另一支函式，避免 DROP＋CREATE 既有函式）、
--   activity_rules／activity_overrides／election_milestones、派工與 seed。不回 created_by 或任何帳號資料。
--
-- 權限：函式一律 SECURITY DEFINER、釘 search_path、REVOKE ALL FROM PUBLIC 後只 GRANT EXECUTE 給 anon／authenticated／service_role；
--   對照表開 RLS、公開唯讀、寫入只有 service_role（實際上只走 migration）。
--
-- 守門：supabase/functions/_shared/console-arm-timeline.test.ts（PGlite，兩站：每支臂都歸得到段、規則自動歸段、區間計算、權限）、
--   日本站那支另登記在 policy-jp-dispatch-drift.test.ts 的 JP_ONLY。

CREATE TABLE IF NOT EXISTS console_arm_stage_map (
  arm   TEXT PRIMARY KEY,
  stage SMALLINT NOT NULL CHECK (stage BETWEEN 1 AND 7),
  note  TEXT
);
COMMENT ON TABLE console_arm_stage_map IS
  '主控台時間軸：派工臂 → 選舉時期（1 常時、2 參選期、3 登記後到投票、4 開票、5 就任、6 任期中、7 卸任交接）。'
  '每支臂都登記一列（守門測試擋漏登）；有日期規則的臂由 console_arm_stages() 照 activity_rules 自動算、這裡的值只是後備，沒有日期規則的才採用。改值走 migration。2026-10-10（policy-ops #63）';
ALTER TABLE console_arm_stage_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON console_arm_stage_map;
CREATE POLICY "Public read" ON console_arm_stage_map FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON console_arm_stage_map;
CREATE POLICY "Service role write" ON console_arm_stage_map FOR ALL USING (auth.role() = 'service_role');
REVOKE ALL ON console_arm_stage_map FROM PUBLIC, anon, authenticated;
GRANT SELECT ON console_arm_stage_map TO anon, authenticated;
GRANT ALL ON console_arm_stage_map TO service_role;

INSERT INTO console_arm_stage_map (arm, stage, note) VALUES
  ('manual_visitor', 1, '網站請求／公民提問'),
  ('manual_open', 1, '其他手動任務'),
  ('placeholder_politicians', 1, '測試資料／空殼人物'),
  ('dup', 1, '同名人物確認'),
  ('owner_mismatch', 1, '參選紀錄掛錯人'),
  ('policy_dup', 1, '政見重複清查'),
  ('raw:policy_validity', 1, '疑似不是政見'),
  ('raw:policy_election_missing', 1, '政見缺屆別'),
  ('mismatch', 1, '政見屆別對不上'),
  ('legacy', 1, '早期匯入核對'),
  ('raw:profile_gap', 1, '人物資料'),
  ('career_sources', 1, '學經歷出處'),
  ('party_info', 1, '政黨資訊'),
  ('township_gap', 1, '鄉鎮資料'),
  ('region_gap', 1, '選舉區'),
  ('regional_stats_missing', 1, '區域統計'),
  ('raw:roster_check', 2, '名單清查'),
  ('roster_villages', 2, '村里名單清查'),
  ('roster_cec_gap', 2, '名冊缺口'),
  ('raw:candidacy_source_missing', 2, '參選紀錄出處'),
  ('raw:candidate_status_stale', 3, '參選狀態（有日期規則：登記截止起，這列只是後備）'),
  ('party_roster', 3, '政黨名冊（有日期規則：到投票日為止，這列只是後備）'),
  ('not_running', 3, '不參選核對（有日期規則，這列只是後備）'),
  ('ballot_numbers', 3, '號次（有日期規則，這列只是後備）'),
  ('raw:policy_missing', 3, '補政見'),
  ('mayor_policies', 3, '縣市長政見'),
  ('policy_elements', 3, '政見三要素'),
  ('district_seats', 3, '選區名額'),
  ('withdrawn_filing', 3, '退選查核'),
  ('elected_missing', 4, '當選缺漏'),
  ('election_results', 4, '選舉結果（有日期規則，這列只是後備）'),
  ('raw:election_result_missing', 4, '選舉結果（有日期規則，這列只是後備）'),
  ('party_gap', 4, '政黨補齊（有日期規則：投票日隔天起，這列只是後備）'),
  ('term_policies', 5, '任內政見（補該屆政見）'),
  ('raw:progress_stale', 6, '進度追蹤'),
  ('deadline_due', 6, '到期檢查'),
  ('lineage_candidates', 6, '政策脈絡'),
  ('lineage_roles', 6, '政策脈絡'),
  ('lineage_links', 6, '政策脈絡'),
  ('handover_missing', 7, '卸任交接')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- 里程碑 → 段。起點（p_until=false）：這個里程碑開始的那一段；迄點（true）：這個里程碑之前的那一段
CREATE OR REPLACE FUNCTION console_stage_of_kind(p_kind TEXT, p_offset INTEGER, p_until BOOLEAN) RETURNS SMALLINT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (CASE
    WHEN NOT p_until THEN CASE
      WHEN p_kind IN ('announced', 'registration_open') THEN 2
      WHEN p_kind IN ('registration_close', 'list_published', 'qualification_review', 'draw', 'bulletin_published') THEN 3
      WHEN p_kind = 'polling' THEN CASE WHEN p_offset < 0 THEN 3 ELSE 4 END
      WHEN p_kind = 'result_announced' THEN 4
      WHEN p_kind = 'certified' THEN 5
      WHEN p_kind = 'term_start' THEN CASE WHEN p_offset < 0 THEN 5 ELSE 6 END
      WHEN p_kind = 'term_end' THEN 7
    END
    ELSE CASE
      WHEN p_kind IN ('announced', 'registration_open', 'registration_close') THEN 2
      WHEN p_kind IN ('list_published', 'qualification_review', 'draw', 'bulletin_published') THEN 3
      WHEN p_kind = 'polling' THEN CASE WHEN p_offset > 0 THEN 4 ELSE 3 END
      WHEN p_kind IN ('result_announced', 'certified') THEN 4
      WHEN p_kind = 'term_start' THEN 5
      WHEN p_kind = 'term_end' THEN 6
    END
  END)::SMALLINT
$$;
COMMENT ON FUNCTION console_stage_of_kind IS '主控台時間軸：里程碑＋偏移 → 選舉時期（1～7）。p_until=true 表示這是窗口的迄點（取它之前的那一段）。2026-10-10（policy-ops #63）';

CREATE OR REPLACE FUNCTION console_arm_stages()
RETURNS TABLE (arm TEXT, stage SMALLINT, stage_source TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH arms AS (SELECT a AS arm FROM unnest(activity_arm_names()) AS a),
  dated AS (
    SELECT r.activity AS arm,
           min(CASE WHEN r.from_kind IS NOT NULL THEN console_stage_of_kind(r.from_kind, r.from_offset, false)
                    ELSE console_stage_of_kind(r.until_kind, r.until_offset, true) END) AS stage
      FROM activity_rules r
     WHERE r.enabled AND r.window_kind <> 'always'
     GROUP BY r.activity
  )
  SELECT ar.arm,
         COALESCE(d.stage, m.stage, 1)::SMALLINT,
         CASE WHEN d.stage IS NOT NULL THEN 'rule' WHEN m.stage IS NOT NULL THEN 'map' ELSE 'default' END
    FROM arms ar
    LEFT JOIN dated d ON d.arm = ar.arm
    LEFT JOIN console_arm_stage_map m ON m.arm = ar.arm
   ORDER BY 2, 1
$$;
COMMENT ON FUNCTION console_arm_stages IS
  '主控台時間軸：每支派工臂的選舉時期。有日期規則的照 activity_rules 自動算（rule），只有 always 規則的查 console_arm_stage_map（map），都沒有＝1（default，要補登記）。公開唯讀。2026-10-10（policy-ops #63）';

CREATE OR REPLACE FUNCTION console_timeline_elections()
RETURNS TABLE (election_id TEXT, election_date DATE, election_reason TEXT, election_types TEXT[], name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.election_id, x.election_date, x.election_reason, x.election_types, x.name
    FROM (
      SELECT e.id::TEXT AS election_id, e.election_date, e.election_reason, e.election_types, e.name
        FROM elections e
       WHERE e.election_date IS NOT NULL
       ORDER BY abs(e.election_date - activity_today())
       LIMIT 300
    ) x
   ORDER BY x.election_date DESC
$$;
COMMENT ON FUNCTION console_timeline_elections IS '主控台時間軸的選舉下拉選單：離今天最近的 300 場，依投票日新到舊。公開唯讀。2026-10-10（policy-ops #63）';

CREATE OR REPLACE FUNCTION console_timeline(p_election_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id INTEGER;
  v_el elections%ROWTYPE;
BEGIN
  IF p_election_id IS NULL OR p_election_id !~ '^[0-9]+$' THEN RETURN NULL; END IF;
  v_id := p_election_id::INTEGER;
  SELECT * INTO v_el FROM elections e WHERE e.id = v_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'today', activity_today(),
    'election', jsonb_build_object('id', v_el.id::TEXT, 'date', v_el.election_date, 'reason', v_el.election_reason,
                                   'types', to_jsonb(v_el.election_types), 'name', v_el.name),
    'milestones', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('kind', m.kind, 'election_type', m.election_type, 'on_date', m.on_date, 'status', m.status)
                       ORDER BY m.on_date, m.kind, m.election_type)
        FROM election_milestones_all m WHERE m.election_id = v_id
    ), '[]'::JSONB),
    'arms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'arm', s.arm, 'stage', s.stage, 'stage_source', s.stage_source,
               'is_open', EXISTS (SELECT 1 FROM activity_open(s.arm, v_id, NULL))
                          OR EXISTS (SELECT 1 FROM unnest(v_el.election_types) t(x), activity_open(s.arm, v_id, t.x)),
               'overridden', EXISTS (
                 SELECT 1 FROM activity_overrides o
                  WHERE o.activity = s.arm AND (o.election_id IS NULL OR o.election_id = v_id)
                    AND (o.expires_at IS NULL OR o.expires_at >= activity_today())
                    AND (o."force" <> 'window' OR o.open_until IS NULL OR o.open_until >= activity_today())),
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
                   FROM activity_rules r
                   LEFT JOIN LATERAL (
                     SELECT min(m.on_date) AS d FROM election_milestones_all m
                      WHERE m.election_id = v_id AND m.kind = r.from_kind
                        AND (r.election_types IS NULL OR m.election_type IS NULL OR m.election_type = ANY (r.election_types))
                   ) f ON true
                   LEFT JOIN LATERAL (
                     SELECT max(m.on_date) AS d FROM election_milestones_all m
                      WHERE m.election_id = v_id AND m.kind = r.until_kind
                        AND (r.election_types IS NULL OR m.election_type IS NULL OR m.election_type = ANY (r.election_types))
                   ) u ON true
                  WHERE r.enabled AND r.activity = s.arm
                    AND (r.reasons IS NULL OR v_el.election_reason = ANY (r.reasons))
                    AND (r.election_types IS NULL OR r.election_types && v_el.election_types)
               ), '[]'::JSONB))
             ORDER BY s.stage, s.arm)
        FROM console_arm_stages() s
        LEFT JOIN console_arm_status() st ON st.arm = s.arm
    ), '[]'::JSONB)
  );
END
$$;
COMMENT ON FUNCTION console_timeline IS
  '主控台時間軸：一場選舉（elections.id 的文字）的今天、里程碑（election_milestones_all）、每支臂的段、今天對這場開不開（activity_open，整場或任一職位）、'
  '有沒有生效中的覆寫蓋到這場（overridden）、全站的 via／佇列件數（console_arm_status），與每條適用規則在這場選舉的開放區間（from／until；空＝不限；'
  'missing_milestone＝規則要的里程碑這場還沒有）。找不到選舉回 NULL。公開唯讀，不回帳號資料。2026-10-10（policy-ops #63）';

REVOKE ALL ON FUNCTION console_stage_of_kind(TEXT, INTEGER, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION console_arm_stages() FROM PUBLIC;
REVOKE ALL ON FUNCTION console_timeline_elections() FROM PUBLIC;
REVOKE ALL ON FUNCTION console_timeline(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_stage_of_kind(TEXT, INTEGER, BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION console_arm_stages() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION console_timeline_elections() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION console_timeline(TEXT) TO anon, authenticated, service_role;
