-- 政策脈絡「現況」（policy-ops#201 第 2 期；計畫 docs/PLAN-lineage-whole-picture.md 2.4／2.5／3.1／4.4，2026-11-05 規劃第 7 節第 2 期）
-- ============================================================
--
-- 維護者 2026-11-05 指示：程式可以先寫，但派工開關維持關閉，選前不佔用代理額度。
--
-- 本檔做的事（只做現況，不做立場、事件、往外擴、頁面改版）：
--   1. 表 lineage_statuses：一條脈絡、一個截至日一列（現行＝最大 as_of 那列，歷史留著）。出處走 source_refs（target_table 加 lineage_statuses）。
--   2. 表 lineage_settings：單列參數（現況過期天數、查不到的冷卻天數）；函式裡不寫死數字。
--   3. 貢獻型別 lineage_status（DB CHECK）。
--   4. 派工臂 lineage_status（任務型別 lineage_status_stale，task_id＝auto:lineage_status_stale:<脈絡 id>:<現行截至日或 none>）。
--      **規則 activity_rules 種成 enabled = false**：總表照常登記這支臂，但 activity_open() 對它回空，
--      所以 seed 不會把它寫進 task_dispatches、/next 不會派出、gap_events 沒有紀錄。要開，另一支 migration 把那一列 enabled 改成 true。
--   5. 視圖 lineages_full 多一欄 status（現行現況的物件，沒有就是 NULL）；讀取端只多這一欄，既有 14 欄一個字不動。
--
-- 沒有做的事（計畫有、本檔刻意不做）：
--   * 事件（lineage_events）：計畫 4.4 的「有比現況截至日更晚的事件」這一條過期條件需要事件表，這裡只剩「沒有現況」「超過天數」兩條。
--   * lineage_settings 的其他欄位（事件重查天數、往外擴參數）：之後各期自己 ADD COLUMN。
--
-- 本檔不改任何既有資料列。唯一的 INSERT 是：新表 lineage_settings 的一列預設值、activity_rules 的一列（停用）、console_arm_stage_map 的一列。
-- 既有物件的改動都是「現行定義加一處」：contributions 型別 CHECK（加一值）、source_refs 目標表 CHECK（加一值）、
-- activity_arm_names()（加一個名字）、contribution_auto_tasks_arms()（加一行 UNION）、lineages_full（加一欄）、
-- system_one_vote_budget_candidates()（型別清單加一值）。

-- ------------------------------------------------------------
-- 1. 參數表 lineage_settings（單列，改值一行 UPDATE，走 activity_audit 進 edit_history；同 traffic_boost_settings 的慣例）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage_settings (
  id                       SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- 現況的階段是 approved／in_progress，截至日超過幾天就派 lineage_status_stale
  status_stale_days_active INTEGER NOT NULL DEFAULT 90 CHECK (status_stale_days_active >= 1),
  -- 階段是 proposed／planning／paused
  status_stale_days_idle   INTEGER NOT NULL DEFAULT 180 CHECK (status_stale_days_idle >= 1),
  -- 同一條脈絡的現況任務回報 not_found 之後，多久內不再派（比一般任務的 14 天長：查不到多半是真的還沒有公開資料）
  gap_not_found_days       INTEGER NOT NULL DEFAULT 60 CHECK (gap_not_found_days >= 1),
  note                     TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE lineage_settings IS
  '政策脈絡派工參數（單列 id=1；policy-ops#201 第 2 期先放現況用的三欄，之後各期自己加欄）。改值一行 UPDATE，例：UPDATE lineage_settings SET status_stale_days_active = 60, note = ''…'' WHERE id = 1;（每次修改進 edit_history，agent_name=activity-audit）';
INSERT INTO lineage_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE lineage_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON lineage_settings;
CREATE POLICY "Public read" ON lineage_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON lineage_settings;
CREATE POLICY "Service role write" ON lineage_settings FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON lineage_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON lineage_settings TO anon, authenticated;
GRANT ALL ON lineage_settings TO service_role;
DROP TRIGGER IF EXISTS trg_lineage_settings_touch ON lineage_settings;
CREATE TRIGGER trg_lineage_settings_touch BEFORE UPDATE ON lineage_settings FOR EACH ROW EXECUTE FUNCTION activity_touch_updated_at();
DROP TRIGGER IF EXISTS trg_lineage_settings_audit ON lineage_settings;
CREATE TRIGGER trg_lineage_settings_audit AFTER INSERT OR UPDATE OR DELETE ON lineage_settings FOR EACH ROW EXECUTE FUNCTION activity_audit();

-- ------------------------------------------------------------
-- 2. 現況表 lineage_statuses
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage_statuses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lineage_id      UUID NOT NULL REFERENCES lineages(id) ON DELETE CASCADE,
  -- 示意圖那顆標籤；沒有「未知」——沒資料就沒有列，畫面顯示未調查
  phase           TEXT NOT NULL CHECK (phase IN ('proposed', 'planning', 'approved', 'in_progress', 'completed', 'paused', 'cancelled')),
  -- 一句現況，只寫有出處的事實（字數跟 _shared/lineage.ts 的 STATUS_TEXT_MIN／MAX 同一組數字，lineage-status.test.ts 盯著）
  text            TEXT NOT NULL CHECK (char_length(btrim(text)) BETWEEN 8 AND 120),
  -- 截至日＝出處講到這個狀態的那個日期，不是查的日子（防假新鮮）；晚於今天由交件守門擋（CHECK 不能用 now()）
  as_of           DATE NOT NULL,
  source_url      TEXT NOT NULL CHECK (source_url ~* '^https?://[^/\s]+'),
  source_locator  TEXT NOT NULL CHECK (char_length(btrim(source_locator)) BETWEEN 1 AND 200),
  contribution_id UUID REFERENCES contributions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 一條脈絡一個截至日一列；現行現況＝最大 as_of 那一列，歷史留著
  CONSTRAINT lineage_statuses_one_per_date UNIQUE (lineage_id, as_of)
);
CREATE INDEX IF NOT EXISTS idx_lineage_statuses_lineage ON lineage_statuses (lineage_id, as_of DESC);
COMMENT ON TABLE lineage_statuses IS
  '政策脈絡的現況（policy-ops#201 第 2 期）：一句現況＋階段＋截至日＋出處。現行＝每條脈絡最大 as_of 那一列。只能經 lineage_status 交件 → 同儕驗證 → 落庫寫入。';
COMMENT ON COLUMN lineage_statuses.as_of IS '出處講到這個狀態的日期，不是查詢日';
COMMENT ON COLUMN lineage_statuses.phase IS 'proposed 提案／planning 規劃中／approved 已核定／in_progress 進行中／completed 已完成／paused 暫緩／cancelled 已終止';

ALTER TABLE lineage_statuses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read" ON lineage_statuses;
CREATE POLICY "Public read" ON lineage_statuses FOR SELECT USING (true);
DROP POLICY IF EXISTS "Service role write" ON lineage_statuses;
CREATE POLICY "Service role write" ON lineage_statuses FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON lineage_statuses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON lineage_statuses TO anon, authenticated;
GRANT ALL ON lineage_statuses TO service_role;

DROP TRIGGER IF EXISTS trg_lineage_statuses_touch ON lineage_statuses;
CREATE TRIGGER trg_lineage_statuses_touch BEFORE UPDATE ON lineage_statuses FOR EACH ROW EXECUTE FUNCTION lineage_touch_updated_at();

-- 現況一變，父脈絡的 updated_at 跟著動（網站地圖的 lastmod 讀 lineages.updated_at）
CREATE OR REPLACE FUNCTION lineage_touch_parent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE lineages SET updated_at = now() WHERE id = COALESCE(NEW.lineage_id, OLD.lineage_id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION lineage_touch_parent() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_lineage_statuses_touch_parent ON lineage_statuses;
CREATE TRIGGER trg_lineage_statuses_touch_parent AFTER INSERT OR UPDATE OR DELETE ON lineage_statuses
  FOR EACH ROW EXECUTE FUNCTION lineage_touch_parent();

-- ------------------------------------------------------------
-- 3. 出處：source_refs 的目標表清單加 lineage_statuses（現行定義＝正式庫 2026-11-05 唯讀查到的十個值，加一個）；做法同交接
-- ------------------------------------------------------------
ALTER TABLE source_refs DROP CONSTRAINT IF EXISTS source_refs_target_table_check;
ALTER TABLE source_refs ADD CONSTRAINT source_refs_target_table_check
  CHECK (target_table IN ('policies', 'tracking_logs', 'policy_elements', 'lineage_participants', 'handovers', 'lineage_links', 'politician_careers', 'parties', 'politician_elections', 'regional_stats', 'lineage_statuses'));

DROP TRIGGER IF EXISTS trg_lineage_statuses_sync_source ON lineage_statuses;
CREATE TRIGGER trg_lineage_statuses_sync_source AFTER INSERT OR UPDATE OF source_url ON lineage_statuses
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_sync_source();
DROP TRIGGER IF EXISTS trg_lineage_statuses_drop_refs ON lineage_statuses;
CREATE TRIGGER trg_lineage_statuses_drop_refs AFTER DELETE ON lineage_statuses
  FOR EACH ROW EXECUTE FUNCTION lineage_rows_drop_refs();

-- ------------------------------------------------------------
-- 4. 貢獻型別：新增 lineage_status（漏這個 CHECK 的話代理交件全被擋而測試全綠）
-- ------------------------------------------------------------
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_contribution_type_check;
ALTER TABLE contributions ADD CONSTRAINT contributions_contribution_type_check
  CHECK (contribution_type IN ('politician', 'candidacy', 'policy', 'policy_progress', 'correction', 'task_suggestion', 'no_change', 'adjudication', 'question_answer', 'removal', 'roster_check', 'merge_politician', 'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link', 'party_info', 'election_results', 'reassign_candidacy', 'regional_stat', 'cand_numbers', 'policy_subtopics', 'lineage_status'));

-- ------------------------------------------------------------
-- 5. 視圖 lineages_full：以 20261019020000 的現行定義為底，在 links 後面多一欄 status（CREATE OR REPLACE 只准在最後加欄）
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW lineages_full AS
SELECT
  l.id, l.title, l.summary, l.category, l.level, l.region, l.sub_region, l.admin_code, l.created_at, l.updated_at,
  COALESCE(
    (SELECT json_agg(pl.id ORDER BY e.election_date NULLS LAST, pl.proposed_date NULLS LAST, pl.id)
       FROM policies pl LEFT JOIN elections e ON e.id = pl.election_id
      -- >>> 只算合格的政見（那一屆已投票且當選；台北日期）：不合格的資料不動、讀取端不算（2026-10-19）
      WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)),
    '[]'::json
  ) AS policy_ids,
  COALESCE(
    (SELECT json_agg(json_build_object(
              'id', lp.id, 'politician_id', COALESCE(pp.merged_into, lp.politician_id), 'name', COALESCE(mp.name, pp.name),
              'role', lp.role, 'basis', lp.basis, 'source_url', lp.source_url, 'source_locator', lp.source_locator, 'note', lp.note,
              'source', source_brief('lineage_participants', lp.id::text))
            ORDER BY array_position(ARRAY['proposer', 'co_proposer', 'cosigner', 'advocate'], lp.role),
                     array_position(ARRAY['official_record', 'self_claim'], lp.basis), lp.created_at, lp.id)
       FROM lineage_participants lp
       JOIN politicians pp ON pp.id = lp.politician_id
       LEFT JOIN politicians mp ON mp.id = pp.merged_into
      WHERE lp.lineage_id = l.id),
    '[]'::json
  ) AS participants,
  COALESCE(
    (SELECT json_agg(json_build_object(
              'id', h.id,
              'from_politician_id', COALESCE(fp.merged_into, h.from_politician_id), 'from_name', COALESCE(fm.name, fp.name), 'from_election_id', h.from_election_id,
              'to_politician_id', COALESCE(tp.merged_into, h.to_politician_id), 'to_name', COALESCE(tm.name, tp.name), 'to_election_id', h.to_election_id,
              'from_office_id', h.from_office_id, 'to_office_id', h.to_office_id,
              'handover_type', h.handover_type, 'decided_on', h.decided_on, 'note', h.note,
              'source_url', h.source_url, 'source_locator', h.source_locator, 'source', source_brief('handovers', h.id::text))
            ORDER BY te.election_date NULLS LAST, h.decided_on NULLS LAST, h.created_at, h.id)
       FROM handovers h
       JOIN politicians fp ON fp.id = h.from_politician_id
       LEFT JOIN politicians fm ON fm.id = fp.merged_into
       JOIN politicians tp ON tp.id = h.to_politician_id
       LEFT JOIN politicians tm ON tm.id = tp.merged_into
       LEFT JOIN elections te ON te.id = h.to_election_id
      WHERE h.lineage_id = l.id),
    '[]'::json
  ) AS handovers,
  COALESCE(
    (SELECT json_agg(json_build_object(
              'id', k.id, 'direction', CASE WHEN k.upper_lineage_id = l.id THEN 'lower' ELSE 'upper' END,
              'lineage_id', o.id, 'title', o.title, 'level', o.level, 'region', o.region, 'sub_region', o.sub_region,
              'link_type', k.link_type, 'note', k.note, 'source_url', k.source_url, 'source_locator', k.source_locator,
              'source', source_brief('lineage_links', k.id::text))
            ORDER BY array_position(ARRAY['national', 'county', 'township'], o.level), o.region NULLS FIRST, o.title, o.id)
       FROM lineage_links k
       JOIN lineages o ON o.id = CASE WHEN k.upper_lineage_id = l.id THEN k.lower_lineage_id ELSE k.upper_lineage_id END
      WHERE k.upper_lineage_id = l.id OR k.lower_lineage_id = l.id),
    '[]'::json
  ) AS links,
  -- >>> 現況（policy-ops#201 第 2 期）：現行＝最大 as_of 那一列；沒有就是 NULL（畫面不顯示）
  (SELECT json_build_object(
            'id', st.id, 'phase', st.phase, 'text', st.text, 'as_of', st.as_of,
            'source_url', st.source_url, 'source_locator', st.source_locator, 'source', source_brief('lineage_statuses', st.id::text))
     FROM lineage_statuses st
    WHERE st.lineage_id = l.id
    ORDER BY st.as_of DESC
    LIMIT 1) AS status
  -- <<< 現況
FROM lineages l;
ALTER VIEW lineages_full SET (security_invoker = on);
GRANT SELECT ON lineages_full TO anon, authenticated;
COMMENT ON VIEW lineages_full IS '政策脈絡一條一列（#349）：脈絡頁與脈絡一覽讀這個；政見只給 id（內容讀 policies_with_logs），參與者、交接、關聯各帶出處；status 是現行現況（policy-ops#201）';

-- ------------------------------------------------------------
-- 6. 派工臂 lineage_status：沒有現況、或現況過期的脈絡（只對「有合格政見」的脈絡派）
-- ------------------------------------------------------------
-- 合格政見＝那一屆已投票且當選（policy_is_elected_term，同 lineages_full.policy_ids；一處判斷，不另寫第二份）。
-- 過期：階段 approved／in_progress 超過 status_stale_days_active、其他未結案階段超過 status_stale_days_idle；
-- 階段 completed／cancelled 的現況不再過期。今天＝台北日期 activity_today()。
-- 不派：在途的 lineage_status 交件；同一條脈絡的現況任務 not_found 後 gap_not_found_days 天內（查 task_checks，task_id 前綴比對、不比指紋）。
-- 計畫 4.4 的第三個條件（有比現況截至日更晚的事件）需要事件表，這一期沒有事件，不做。
CREATE OR REPLACE FUNCTION contribution_auto_tasks_lineage_status()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT st.status_stale_days_active AS d_active, st.status_stale_days_idle AS d_idle, st.gap_not_found_days AS d_nf, activity_today() AS today
      FROM lineage_settings st WHERE st.id = 1
  ),
  cur AS (
    SELECT DISTINCT ON (x.lineage_id) x.lineage_id, x.id, x.phase, x.text, x.as_of, x.source_url
      FROM lineage_statuses x
     ORDER BY x.lineage_id, x.as_of DESC
  ),
  due AS (
    SELECT l.id AS lineage_id, l.title, l.summary, l.level, l.region, l.sub_region, l.category,
           c.phase, c.text AS cur_text, c.as_of AS cur_as_of, c.source_url AS cur_source_url, s.today
      FROM lineages l
      CROSS JOIN s
      LEFT JOIN cur c ON c.lineage_id = l.id
     WHERE EXISTS (SELECT 1 FROM policies pl WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id))
       AND (c.lineage_id IS NULL
            OR (c.phase IN ('approved', 'in_progress') AND c.as_of < s.today - s.d_active)
            OR (c.phase IN ('proposed', 'planning', 'paused') AND c.as_of < s.today - s.d_idle))
       AND NOT EXISTS (
         SELECT 1 FROM contributions k
          WHERE k.contribution_type = 'lineage_status' AND k.status IN ('pending', 'verified', 'disputed', 'apply_failed')
            AND k.payload->>'lineage_id' = l.id::TEXT)
       AND NOT EXISTS (
         SELECT 1 FROM task_checks tc
          WHERE tc.task_id LIKE 'auto:lineage_status_stale:' || l.id::TEXT || ':%'
            AND tc.outcome = 'not_found'
            AND tc.checked_at > now() - make_interval(days => s.d_nf))
  )
  SELECT 'auto:lineage_status_stale:' || d.lineage_id::TEXT || ':' || COALESCE(d.cur_as_of::TEXT, 'none'),
         'lineage_status_stale',
         jsonb_strip_nulls(jsonb_build_object(
           'lineage_id', d.lineage_id, 'lineage_title', d.title, 'summary', d.summary, 'level', d.level, 'region', d.region, 'sub_region', d.sub_region, 'category', d.category,
           'today', d.today,
           'reason', CASE WHEN d.cur_as_of IS NULL THEN 'none' ELSE 'stale' END,
           'current', CASE WHEN d.cur_as_of IS NULL THEN NULL
                           ELSE jsonb_build_object('phase', d.phase, 'text', d.cur_text, 'as_of', d.cur_as_of, 'source_url', d.cur_source_url) END)),
         CASE WHEN d.cur_as_of IS NULL
              THEN '脈絡「' || d.title || '」還沒有現況。'
              ELSE '脈絡「' || d.title || '」的現況（' || d.cur_text || '）截至 ' || d.cur_as_of::TEXT || '，已經過期。' END
           || '請找這件事**最新的公開文件**（政府公告、議會議事錄、預算書、新聞稿、可靠報導），寫一句現況：用 lineage_status 交一筆，'
           || 'phase 選階段（proposed 提案／planning 規劃中／approved 已核定／in_progress 進行中／completed 已完成／paused 暫緩／cancelled 已終止）、'
           || 'text 一句（8～120 字，只寫出處有的事實，不評價）、as_of 填**出處講到這個狀態的日期**（不是你查的日子）、source_locator 寫在出處哪裡。'
           || '現況沒變、但找得到近期有日期的文件證明仍如此，就用那份文件的日期交新的一筆；沒有新消息不等於新截至日。'
           || '什麼都查不到 → no_change，outcome=not_found，checked_urls 列你查過的網址。',
         ARRAY['政府公告與新聞稿（*.gov.tw）', '縣市議會議事錄與公報', '總預算書與計畫書', '可靠媒體報導'],
         1, COALESCE(d.region, '全國')
    FROM due d
$$;
COMMENT ON FUNCTION contribution_auto_tasks_lineage_status IS
  '有合格政見的脈絡，沒有現況或現況過期（階段決定天數，lineage_settings）→ lineage_status_stale（交 lineage_status）。在途交件、not_found 冷卻內不派。規則 activity_rules.lineage_status 上線時 enabled=false（policy-ops#201 第 2 期）';

-- ------------------------------------------------------------
-- 7. 臂名清單與總表：現行定義（臂名＝20261102010000、總表＝20261103010000）加一個名字／一行 UNION，其餘一字不改
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION activity_arm_names() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    'raw:policy_missing',
    'raw:profile_gap',
    'raw:policy_validity',
    'raw:progress_stale',
    'raw:candidacy_source_missing',
    'raw:roster_check',
    'raw:policy_election_missing',
    'raw:candidate_status_stale',
    'dup',
    'legacy',
    'mismatch',
    'policy_dup',
    'not_running',
    'mayor_policies',
    'term_policies',
    'roster_villages',
    'township_gap',
    'region_gap',
    'elected_missing',
    'roster_cec_gap',
    'district_seats',
    'policy_elements',
    'deadline_due',
    'lineage_candidates',
    'handover_missing',
    'lineage_roles',
    'lineage_links',
    'career_sources',
    'withdrawn_filing',
    'party_gap',
    'party_roster',
    'party_info',
    'placeholder_politicians',
    'election_results',
    'owner_mismatch',
    'ballot_numbers',
    'manual_visitor',
    'manual_open',
    'regional_stats_missing',
    'traffic:progress_stale',
    'traffic:deadline_due',
    'traffic:term_policies',
    'issue_too_broad',
    'lineage_status'
  ]::TEXT[]
$$;

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT, arm TEXT, opened_by JSONB)
LANGUAGE sql STABLE AS $$
  WITH raw AS (SELECT * FROM contribution_auto_tasks_raw()),
       due AS (SELECT * FROM contribution_auto_tasks_deadline_due()),
       -- 姓名看起來是測試資料的人物（2026-10-08）：他們的任務只走 placeholder_politician（見檔頭）
       ph AS MATERIALIZED (SELECT p.id::TEXT AS pid FROM politicians p WHERE politician_name_is_placeholder(p.name)),
       phe AS MATERIALIZED (SELECT pe.id AS peid FROM politician_elections pe JOIN politicians p ON p.id = pe.politician_id WHERE politician_name_is_placeholder(p.name)),
       -- >>> 名單清查收斂：名冊類差異按單位彙總（開關關著就不算）；原臂在開關開著時停用，單位清查掛 items（見 20261101020000）
       fnd AS MATERIALIZED (SELECT * FROM roster_unit_findings() WHERE roster_unify_on()),
       -- <<< 名單清查收斂
       tagged0 AS (
  SELECT 'raw:' || r.task_type AS arm, r.task_id, r.task_type, r.target,
         r.what_we_need || CASE WHEN r.task_type = 'roster_check'
                                 AND r.target->>'election_type' IN ('鄉鎮市長', '鄉鎮市民代表', '直轄市山地原住民區長', '直轄市山地原住民區民代表')
                                THEN '【這種選舉】每筆 candidacy 都要填 sub_region＝候選人所在的鄉鎮市區（例：東港鎮、茂林區），不要只填縣市。'
                                ELSE '' END AS what_we_need,
         r.hint_sources, r.reward, r.region
    FROM raw r
   WHERE (r.task_type <> 'roster_check' OR roster_scope_covers(r.target->>'election_type', r.region))
     AND NOT (r.task_type = 'progress_stale' AND EXISTS (SELECT 1 FROM due d WHERE d.target->>'policy_id' = r.target->>'policy_id'))
  UNION ALL SELECT 'dup' AS arm, t.* FROM contribution_auto_tasks_dup() t
  UNION ALL SELECT 'legacy' AS arm, t.* FROM contribution_auto_tasks_legacy() t
  UNION ALL SELECT 'mismatch' AS arm, t.* FROM contribution_auto_tasks_mismatch() t
  UNION ALL SELECT 'policy_dup' AS arm, t.* FROM contribution_auto_tasks_policy_dup() t
  UNION ALL SELECT 'not_running' AS arm, t.* FROM contribution_auto_tasks_not_running() t
  UNION ALL SELECT 'mayor_policies' AS arm, t.* FROM contribution_auto_tasks_mayor_policies() t
  UNION ALL SELECT 'term_policies' AS arm, t.* FROM contribution_auto_tasks_term_policies() t
  UNION ALL SELECT 'roster_villages' AS arm, t.* FROM contribution_auto_tasks_roster_villages() t
  UNION ALL SELECT 'township_gap' AS arm, t.* FROM contribution_auto_tasks_township_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'region_gap' AS arm, t.* FROM contribution_auto_tasks_region_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'elected_missing' AS arm, t.* FROM contribution_auto_tasks_elected_missing() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'roster_cec_gap' AS arm, t.* FROM contribution_auto_tasks_roster_cec_gap() t
  UNION ALL SELECT 'district_seats' AS arm, t.* FROM contribution_auto_tasks_district_seats() t
  UNION ALL SELECT 'policy_elements' AS arm, t.* FROM contribution_auto_tasks_policy_elements() t
  UNION ALL SELECT 'deadline_due' AS arm, t.* FROM due t
  UNION ALL SELECT 'lineage_candidates' AS arm, t.* FROM contribution_auto_tasks_lineage_candidates() t
  UNION ALL SELECT 'handover_missing' AS arm, t.* FROM contribution_auto_tasks_handover_missing() t
  UNION ALL SELECT 'lineage_roles' AS arm, t.* FROM contribution_auto_tasks_lineage_roles() t
  UNION ALL SELECT 'lineage_links' AS arm, t.* FROM contribution_auto_tasks_lineage_links() t
  UNION ALL SELECT 'career_sources' AS arm, t.* FROM contribution_auto_tasks_career_sources() t
  UNION ALL SELECT 'withdrawn_filing' AS arm, t.* FROM contribution_auto_tasks_withdrawn_filing() t
  UNION ALL SELECT 'party_gap' AS arm, t.* FROM contribution_auto_tasks_party_gap() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_roster' AS arm, t.* FROM contribution_auto_tasks_party_roster() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'party_info' AS arm, t.* FROM contribution_auto_tasks_party_info() t
  UNION ALL SELECT 'placeholder_politicians' AS arm, t.* FROM contribution_auto_tasks_placeholder_politicians() t
  UNION ALL SELECT 'election_results' AS arm, t.* FROM contribution_auto_tasks_election_results() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'owner_mismatch' AS arm, t.* FROM contribution_auto_tasks_owner_mismatch() t WHERE NOT roster_unify_on()  -- 名單清查收斂：併進 roster_check
  UNION ALL SELECT 'ballot_numbers' AS arm, t.* FROM contribution_auto_tasks_ballot_numbers() t
  UNION ALL SELECT 'manual_visitor' AS arm, t.* FROM contribution_auto_tasks_manual(true) t
  UNION ALL SELECT 'manual_open' AS arm, t.* FROM contribution_auto_tasks_manual(false) t
  UNION ALL SELECT 'regional_stats_missing' AS arm, t.* FROM contribution_auto_tasks_regional_stats_missing() t
  UNION ALL SELECT 'issue_too_broad' AS arm, t.* FROM contribution_auto_tasks_issue_too_broad() t
  UNION ALL SELECT 'lineage_status' AS arm, t.* FROM contribution_auto_tasks_lineage_status() t
       ),
       -- >>> 名單清查收斂：單位已經有 roster_check（raw、roster_villages、roster_cec_gap）就掛 items；沒有、但有差異的單位開一張（findings_only）
       tagged AS (
  SELECT t0.arm, t0.task_id, t0.task_type, t0.target || COALESCE(x.extra, '{}'::JSONB) AS target,
         CASE WHEN x.extra IS NULL THEN t0.what_we_need
              ELSE t0.what_we_need || ' ' || roster_unify_text((x.extra->>'items_count')::INTEGER, COALESCE(f.voted, t0.target->>'list_source' = 'cec', false)) END AS what_we_need,
         t0.hint_sources, t0.reward, t0.region
    FROM tagged0 t0
    LEFT JOIN fnd f ON t0.task_type = 'roster_check' AND f.task_id = t0.task_id
    CROSS JOIN LATERAL (SELECT CASE WHEN t0.task_type = 'roster_check' AND roster_unify_on() THEN roster_unify_attach(t0.target, f.items, f.items_count, f.kinds) END AS extra) x
  UNION ALL
  SELECT f.arm, f.task_id, 'roster_check', f.target, f.what_we_need, f.hint_sources, 2, f.county
    FROM fnd f
   WHERE NOT EXISTS (SELECT 1 FROM tagged0 t0 WHERE t0.task_id = f.task_id)
       ),
       -- <<< 名單清查收斂
       -- >>> 名單缺口只派有缺口的單位（20261103010000，policy-ops#180）：2026 的 roster_check 列，單位有缺口 → 缺口 items 併進 target.items；
       --     單位沒有 roster_check 列但有缺口 → 開一列；官方名冊鏡像新鮮、卻無缺口也無別種差異 → 不派（收回）。開關同 roster_unify_on()
       gapu AS MATERIALIZED (SELECT * FROM roster_gap_units() WHERE roster_unify_on()),
       gapfresh AS MATERIALIZED (SELECT x.tid FROM roster_gap_fresh_units() AS x(tid) WHERE roster_unify_on()),
       tagged_g AS (
  SELECT t.arm, t.task_id, t.task_type,
         CASE WHEN gu.task_id IS NULL THEN t.target ELSE t.target || roster_gap_attach(t.target, gu.items, gu.items_count, gu.kinds) END AS target,
         CASE WHEN gu.task_id IS NULL THEN t.what_we_need ELSE t.what_we_need || ' ' || roster_gap_text() END AS what_we_need,
         t.hint_sources, t.reward, t.region
    FROM tagged t
    LEFT JOIN gapu gu ON t.task_type = 'roster_check' AND gu.task_id = roster_gap_tid(t.task_id)
   WHERE NOT (t.task_type = 'roster_check' AND t.task_id LIKE 'auto:roster_check:2026:%' AND gu.task_id IS NULL
              AND roster_gap_tid(t.task_id) IN (SELECT f.tid FROM gapfresh f)
              AND (COALESCE(t.target->'items_kinds', '{}'::JSONB) - '缺人' - '缺號次') = '{}'::JSONB)
  UNION ALL
  SELECT gu.arm, gu.task_id, 'roster_check', gu.target, gu.what_we_need, gu.hint_sources, 2, gu.county
    FROM gapu gu
   WHERE NOT EXISTS (SELECT 1 FROM tagged t WHERE t.task_type = 'roster_check' AND roster_gap_tid(t.task_id) = gu.task_id)
       ),
       -- <<< 名單缺口
       -- 每一列的選舉與職位（target 裡沒有就是「不屬於任何選舉」）；規則只對「臂×選舉×職位」各問一次，不是每一列問一次
       -- >>> 村里長進度：target 沒有職位的臂（進度追蹤的 progress_stale、deadline_due），若這支臂有規則要看職位（except_election_types 排除清單或 election_types 正向清單，任何一種），職位從人物在那一屆的參選紀錄補；其餘臂的分組一個字不變
       -- 兩種都要看：只看排除清單的話，排除規則一被停用，職位全是 NULL，「村里長、要流量」那條正向規則就永遠比對不到、缺口被無聲收回（agy 審查 #480）
       needs_etype AS MATERIALIZED (SELECT DISTINCT r.activity FROM activity_rules r WHERE r.enabled AND (r.except_election_types IS NOT NULL OR r.election_types IS NOT NULL)
                                    -- >>> 有人看才追：來源臂一律補職位（要照職位決定歸不歸流量臂）
                                    UNION SELECT s.arm FROM unnest(traffic_watch_source_arms()) AS s(arm)
                                    -- <<< 有人看才追
                                   ),
       -- <<< 村里長進度
       keyed0 AS (
  SELECT g.*, election_id_or_null(g.target->>'election_id') AS eid,
         COALESCE(NULLIF(g.target->>'election_type', ''),
                  CASE WHEN g.arm IN (SELECT n.activity FROM needs_etype n)
                       THEN (SELECT pe.election_type FROM politician_elections pe
                              WHERE pe.politician_id = uuid_or_null(g.target->>'politician_id') AND pe.election_id = election_id_or_null(g.target->>'election_id')
                              ORDER BY pe.id LIMIT 1) END) AS etype
    FROM tagged_g g
       ),
       -- >>> 有人看才追：來源臂裡、職位在 traffic_watch_levels 開著的列，改歸流量臂 traffic:<型別>（task_id、內容一個字不變，只換臂名）；其餘照舊
       traffic_levels AS MATERIALIZED (SELECT l.election_type FROM traffic_watch_levels l WHERE l.enabled),
       keyed AS (
  SELECT CASE WHEN k.arm = ANY (traffic_watch_source_arms()) AND k.etype IN (SELECT t.election_type FROM traffic_levels t)
              THEN traffic_watch_arm(k.arm) ELSE k.arm END AS arm,
         k.task_id, k.task_type, k.target, k.what_we_need, k.hint_sources, k.reward, k.region, k.eid, k.etype
    FROM keyed0 k
       ),
       -- <<< 有人看才追
       opened AS (
  SELECT k.arm, k.eid, k.etype, o.source, o.rule_id, o.override_id, o.milestone_kind, o.milestone_on_date, o.expected_open_on, o.open_until
    FROM (SELECT x.arm, x.eid, x.etype
            FROM (SELECT DISTINCT d.arm, d.eid, d.etype FROM keyed d OFFSET 0) x
           WHERE activity_require_rule(x.arm) OFFSET 0) k  -- 每組（約 84 組）檢查一次；OFFSET 0 擋住檢查被推到 7 千多列上去
    LEFT JOIN LATERAL (  -- LEFT：窗口關著的組也留下來（o.source 是 NULL），旗標 gap.arms_all 開著時 seed 要看它們
      SELECT * FROM activity_open(k.arm, k.eid, k.etype)
       ORDER BY expected_open_on NULLS LAST, rule_id NULLS LAST, override_id NULLS LAST LIMIT 1
    ) o ON true
       )
  SELECT g.task_id, g.task_type, g.target, g.what_we_need, g.hint_sources, g.reward, g.region, g.arm,
         CASE WHEN w.ok THEN jsonb_strip_nulls(jsonb_build_object(
           'basis', o.source, 'arm', g.arm, 'rule_id', o.rule_id, 'override_id', o.override_id, 'election_id', g.eid,
           'milestone_kind', o.milestone_kind, 'milestone_on_date', o.milestone_on_date, 'expected_open_on', o.expected_open_on, 'open_until', o.open_until,
           'traffic_gate', CASE WHEN g.arm LIKE 'traffic:%' THEN true END)) END AS opened_by
    FROM keyed g
    JOIN opened o ON o.arm = g.arm AND COALESCE(o.eid, -1) = COALESCE(g.eid, -1) AND COALESCE(o.etype, '') = COALESCE(g.etype, '')
    -- >>> 流量開窗：窗口有開（o.source），而且是流量臂（traffic:）時，這一列的人物頁或政見頁要在 page_traffic_hot；沒開的列照舊（旗標 gap.arms_all 開著時留下，opened_by 是 NULL）
    CROSS JOIN LATERAL (SELECT o.source IS NOT NULL AND (g.arm NOT LIKE 'traffic:%' OR EXISTS (
           SELECT 1 FROM page_traffic_hot h
            WHERE (h.kind = 'politician' AND h.target_id = g.target->>'politician_id') OR (h.kind = 'policy' AND h.target_id = g.target->>'policy_id'))) AS ok) w
    -- <<< 流量開窗
   WHERE (w.ok OR (SELECT current_setting('gap.arms_all', true) = 'on'))  -- 旗標沒設（預設）＝只回開著的列；一個 InitPlan，不是每列算
     AND (g.arm = 'placeholder_politicians'
      OR NOT (EXISTS (SELECT 1 FROM ph WHERE strpos(g.target::TEXT, ph.pid) > 0)
              OR EXISTS (SELECT 1 FROM phe WHERE g.target->'politician_election_ids' @> to_jsonb(phe.peid) OR g.target->>'politician_election_id' = phe.peid::TEXT)))
$$;

-- ------------------------------------------------------------
-- 8. 規則：**enabled = false**（維護者 2026-11-05：程式先寫、派工開關維持關閉，選前不佔用代理額度）
--    總表對這支臂照常 activity_require_rule()（有規則，只是停用）；activity_open() 只看 enabled 的規則，所以它回空，
--    總表過濾掉這支臂的所有列、seed 不寫 task_dispatches、/next 不派。要開＝另一支 migration 把這一列 enabled 改成 true。
--    副作用：視圖 activity_health 的 activity_all_rules_disabled 會多一列 lineage_status（預期中的「這一類刻意不派」）。
-- ------------------------------------------------------------
INSERT INTO activity_rules (activity, window_kind, enabled, params, note)
SELECT 'lineage_status', 'always', false, '{}'::JSONB,
       '政策脈絡現況過期／缺現況（policy-ops#201 第 2 期，計畫 4.4）。上線時停用：維護者 2026-11-05 指示選前不佔用代理額度；要開改 enabled=true（永遠開，沒有選舉窗口）'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'lineage_status');

INSERT INTO console_arm_stage_map (arm, stage, note) VALUES
  ('lineage_status', 6, '政策脈絡')
ON CONFLICT (arm) DO UPDATE SET stage = EXCLUDED.stage, note = EXCLUDED.note;

-- ------------------------------------------------------------
-- 9. 票數預算影子排程的候選型別：TS 的 VOTE_DIMENSIONS 有 lineage_status，SQL 候選清單要同步（以 20261102010000 的定義為底，只多一個值）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION system_one_vote_budget_candidates(p_limit INTEGER DEFAULT 20)
RETURNS TABLE (id UUID, contribution_type TEXT, payload JSONB, source_urls TEXT[])
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.contribution_type, c.payload, c.source_urls
  FROM contributions c
  WHERE c.status = 'pending'
    AND c.contribution_type IN ('policy', 'candidacy', 'correction', 'no_change', 'politician', 'policy_progress',
                                'removal', 'merge_politician', 'question_answer', 'adjudication', 'roster_check', 'task_suggestion',
                                'district_seats', 'policy_elements', 'lineage', 'lineage_participants', 'lineage_handover', 'lineage_link',
                                'party_info', 'election_results', 'reassign_candidacy', 'regional_stat', 'cand_numbers', 'policy_subtopics', 'lineage_status')
    AND NOT EXISTS (
      SELECT 1 FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget'
        AND (c.contribution_type <> 'no_change' OR j.state->'target' ? 'outcome')
    )
    AND (c.contribution_type <> 'no_change' OR (
      SELECT COUNT(*) FROM jev_decisions j
      WHERE j.subject_type = 'contribution' AND j.subject_id = c.id::TEXT AND j.question = 'vote_budget') < 2)
  -- 新的先：新件的影子結果之後才對得到它的實際結果；舊件一天內也會輪到
  ORDER BY c.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 60));
$$;

-- ------------------------------------------------------------
-- 10. 自我檢查：規則一定要在而且是停用的、臂名與總表都接上、lineages_full 既有欄位沒少、這支 migration 沒有讓派工列多出現況任務
-- ------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT count(*) FROM activity_rules r WHERE r.activity = 'lineage_status') <> 1 THEN
    RAISE EXCEPTION 'lineage_status 要剛好一條規則';
  END IF;
  IF EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'lineage_status' AND r.enabled) THEN
    RAISE EXCEPTION 'lineage_status 的規則必須是停用的（選前不佔用代理額度）';
  END IF;
  IF NOT ('lineage_status' = ANY (activity_arm_names())) THEN
    RAISE EXCEPTION '臂名清單漏了 lineage_status';
  END IF;
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'contribution_auto_tasks_lineage_status()') = 0 THEN
    RAISE EXCEPTION '總表沒有接上 lineage_status';
  END IF;
  IF strpos(pg_get_functiondef('contribution_auto_tasks_arms()'::regprocedure), 'roster_gap_units()') = 0 THEN
    RAISE EXCEPTION '總表漏了名單缺口的段落（抄底錯版）';
  END IF;
  IF EXISTS (SELECT 1 FROM task_dispatches d WHERE d.task_type = 'lineage_status_stale') THEN
    RAISE EXCEPTION '派工列不該有 lineage_status_stale（規則停用中）';
  END IF;
  IF EXISTS (SELECT 1 FROM contribution_auto_tasks_arms() a WHERE a.arm = 'lineage_status') THEN
    RAISE EXCEPTION '規則停用中，總表卻還回了 lineage_status 的列';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lineages_full') <> 15 THEN
    RAISE EXCEPTION 'lineages_full 欄位數不是 15（原 14 欄加 status）';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
