-- 脈絡只收「那一屆已投票且當選」的政見：承諾 → 政見 → 脈絡（維護者 2026-10-19，協議 1.99.0，#670 第二步）
-- ============================================================
--
-- 維護者原話：「本來就該當選才叫政見啊，這之前叫承諾，這之後叫脈絡」「承諾 政見 脈絡」。
-- 選前叫承諾，當選後才叫政見，政見串起來才叫脈絡。這更正 10-06 #349（20261006034900）的分組範圍「還沒投票的屆別看在選者」：
-- 選前的承諾、落選者的承諾都不是政見，不進脈絡。
-- 起因：脈絡 1a6b1dc7（新北大巨蛋建設案）把 2026 新北市長兩位候選人的承諾建成一條脈絡；線上 10 條有 6 條是同一屆多人（唯讀 10-19）。
--
-- 判斷看**那條政見所屬的那一屆**（policies.election_id 對 politician_elections 的 candidacy_status＝'elected'，而且 elections.election_date 早於今天），
-- 不是看這個人現在在不在任——2018 當選、2022 落選的人，2018 那一屆的政見仍然收。「今天」一律用台北日期 activity_today()，投票日當天算還沒投票。
--
-- 做了什麼（只加不刪；**不改任何資料列**）：
--   1. 共用資格判斷，**拆兩層**（issue #672「承諾→政見」要用同一個條件，不留兩份規則）：
--      底層 policy_is_elected_term(政見 id, 今天 date)＝那一屆已投票而且提出者在那一屆有當選紀錄；
--      脈絡的資格 lineage_policy_ineligible_reason(政見 id, 今天)（回不合格的原因，合格是 NULL）與 lineage_policy_eligible() 建在它上面。
--      TS 鏡像：底層 _shared/elected-term.ts 的 isElectedTerm（純函式、沒有 import，前端 lib 也能引用）、脈絡資格 _shared/lineage.ts 的
--      lineagePolicyIneligibleReason（交件前置檢查與落庫用）；lineage-elected-only.test.ts 把兩邊放在同一批資料上、用好幾個「今天」逐案比對。
--   2. 分組任務：lineage_candidate_scope() 只收合格的（20261006220000 那一版只換 WHERE 一處，其餘一字不動）。
--      contribution_auto_tasks_lineage_candidates 的 terms（跨人或跨屆）不動：範圍已經只剩當選者，同一場選舉兩位候選人不會再被放進同一格。
--      **開票後當選人的政見自動進格**：政見一進 scope，那一格的指紋就變了，task_id 帶指紋所以是新的一件（守門測試跑真的臂本體驗這一點）。
--   3. **讀取端推導、資料不動**（維護者 10-19，跟 #672 承諾→政見、10-07「推導、不寫資料」同一做法）：不合格的政見仍然掛在 policies.lineage_id 上，
--      但 lineages_full.policy_ids 只算合格的（前一版 20261006034900 只多 policy_is_elected_term 一個條件）。好處：開票後當選者那條自動回到脈絡、
--      結果更正自動跟著變、沒有 edit_history 雜訊。合格政見數 0 的脈絡在讀取端隱藏（不進脈絡一覽、不進網站地圖、頁面標 noindex，網址照開），
--      資料列一列都不刪；分組任務的 existing_lineages 仍列出它。
--   4. 落庫前檢查（TS，apply-precheck.ts／apply-contribution.ts）：新歸入不合格的政見 → 400 apply_would_fail；detach_policy_ids 不受限。
--
-- 日本站（policy_jp.lineage_candidate_scope）有同樣的選前範圍，這支不動，待通知日本站（P-日本）決定跟不跟。
--
-- 先唯讀查過正式庫（2026-10-19）：policies（id、election_id、politician_id、lineage_id、removed_at、title）、elections（id、election_date）、
-- politician_elections（politician_id、election_id、candidacy_status）、lineages（id、title、level、region、sub_region、category）都有這些欄位；
-- 現在 10 條脈絡裡 8 條有不合格政見（共 15 條，全是 2026-11-28 還沒投票），其中 6 條合格政見數會是 0。

-- ------------------------------------------------------------
-- 1. 共用資格判斷（兩層）
-- ------------------------------------------------------------
-- 底層：這條政見所屬的那一屆「已投票且當選」。看**政見所屬的那一屆**（policies.election_id），不是看這個人現在在不在任。
-- p_today 參數化（預設 activity_today()＝台北日期）：投票日早於 p_today 才算已投票，**投票日當天算還沒投票**。沒這條政見、沒標屆別、那一屆不存在都回 false。
-- 不看政見有沒有被移除（那是脈絡自己的事，在上層）。
CREATE OR REPLACE FUNCTION policy_is_elected_term(p_policy_id UUID, p_today DATE DEFAULT activity_today()) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT e.election_date < p_today
           AND EXISTS (
             SELECT 1 FROM politician_elections q
              WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id AND q.candidacy_status = 'elected'
           )
      FROM policies pl
      JOIN elections e ON e.id = pl.election_id
     WHERE pl.id = p_policy_id
  ), false)
$$;
COMMENT ON FUNCTION policy_is_elected_term IS
  '這條政見所屬的那一屆已投票（投票日早於 p_today，當天算還沒投票）而且提出者在那一屆有當選紀錄（candidacy_status＝elected）。看政見所屬的那一屆（policies.election_id），不是看這個人現在在不在任。脈絡資格 lineage_policy_ineligible_reason 與 #672「承諾→政見」共用這一支。TS 鏡像：_shared/elected-term.ts 的 isElectedTerm，兩邊由 lineage-elected-only.test.ts 對齊（2026-10-19）';

-- 上層（脈絡的資格）：原因（跟 TS 的 LINEAGE_INELIGIBLE_REASONS 同一組）：not_found 沒這條政見、removed 已移除、no_election 沒標屆別、
-- not_voted_yet 那一屆還沒投票（投票日當天也算還沒）、not_elected 提出者在那一屆沒有當選紀錄；合格回 NULL。
CREATE OR REPLACE FUNCTION lineage_policy_ineligible_reason(p_policy_id UUID, p_today DATE DEFAULT activity_today()) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN pl.id IS NULL THEN 'not_found'
           WHEN pl.removed_at IS NOT NULL THEN 'removed'
           WHEN pl.election_id IS NULL OR e.id IS NULL THEN 'no_election'
           WHEN policy_is_elected_term(pl.id, p_today) THEN NULL
           WHEN e.election_date >= p_today THEN 'not_voted_yet'
           ELSE 'not_elected'
         END
    FROM (SELECT 1) d
    LEFT JOIN policies pl ON pl.id = p_policy_id
    LEFT JOIN elections e ON e.id = pl.election_id
$$;
COMMENT ON FUNCTION lineage_policy_ineligible_reason IS
  '這條政見不能進脈絡的原因（合格回 NULL）：脈絡只收那一屆已投票且當選的政見（維護者 2026-10-19，承諾 → 政見 → 脈絡）。建在底層 policy_is_elected_term 上面：先排除找不到、已移除、沒標屆別，通過底層就合格，沒通過再分還沒投票或沒當選。TS 鏡像：_shared/lineage.ts 的 lineagePolicyIneligibleReason，兩邊由 lineage-elected-only.test.ts 對齊';

CREATE OR REPLACE FUNCTION lineage_policy_eligible(p_policy_id UUID, p_today DATE DEFAULT activity_today()) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT lineage_policy_ineligible_reason(p_policy_id, p_today) IS NULL
$$;
COMMENT ON FUNCTION lineage_policy_eligible IS '這條政見能不能進脈絡（lineage_policy_ineligible_reason 是 NULL）。2026-10-19';

-- ------------------------------------------------------------
-- 2. 分組任務的範圍（前一版＝20261006220000_candidacy_read_side.sql；只改 WHERE 那一處，標記 >>> 只收那一屆已投票且當選的）
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION lineage_candidate_scope()
RETURNS TABLE(policy_id uuid, title text, content_md5 text, category text, status text, lineage_id uuid, politician_id uuid, name text, election_id integer, election_date date, election_type text, level text, region text, sub_region text)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT pl.id AS policy_id, pl.title, md5(pl.title || COALESCE(pl.description, '')) AS content_md5, pl.category,
           pl.status::TEXT AS status, pl.lineage_id, p.id AS politician_id, p.name, pl.election_id, e.election_date,
           x.election_type,
           -- 縣市與鄉鎮只來自那一屆參選紀錄自己（10-05 裁決：不借人物表的地區；缺地區的由「補縣市／補選區」任務補上後才進格）
           replace(r.region, '臺', '台') AS county, r.sub_region AS r_sub
      FROM policies pl
      JOIN politicians p ON p.id = pl.politician_id AND p.merged_into IS NULL
      JOIN elections e ON e.id = pl.election_id
      JOIN LATERAL (
        SELECT q.election_type, q.candidacy_status, q.region_id
          FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id
         ORDER BY (q.candidacy_status = 'elected') DESC NULLS LAST,
                  (q.candidacy_status IS DISTINCT FROM 'withdrawn') DESC NULLS LAST, q.id
         LIMIT 1
      ) x ON true
      LEFT JOIN regions r ON r.id = x.region_id
     WHERE pl.removed_at IS NULL AND pl.category IS NOT NULL
       -- >>> 只收那一屆已投票且當選的（2026-10-19）：拿掉「還沒投票看在選者」那一支——選前叫承諾、不是政見；判斷看這條政見所屬的那一屆
       AND e.election_date < activity_today() AND x.candidacy_status = 'elected'
       -- <<< 只收那一屆已投票且當選的
  )
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'national', NULL::TEXT, NULL::TEXT
    FROM scoped s WHERE s.election_type IN ('總統副總統', '立法委員')
  UNION ALL
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'county', s.county, NULL::TEXT
    FROM scoped s
   WHERE s.county IS NOT NULL AND s.county <> '全國'
     AND (s.election_type IN ('縣市長', '縣市議員') OR s.election_type = '立法委員')
  UNION ALL
  SELECT s.policy_id, s.title, s.content_md5, s.category, s.status, s.lineage_id, s.politician_id, s.name, s.election_id,
         s.election_date, s.election_type, 'township', s.county, s.r_sub
    FROM scoped s
   WHERE s.election_type IN ('鄉鎮市長', '直轄市山地原住民區長') AND s.county IS NOT NULL AND s.r_sub IS NOT NULL
$$;
COMMENT ON FUNCTION lineage_candidate_scope IS '脈絡候選的範圍（#349）：哪些政見、放在哪一格（層級＋縣市＋鄉鎮＋類別）。**只收那一屆已投票且當選的人提的政見**（維護者 2026-10-19 更正 10-06 的「還沒投票的屆別看在選者」：選前叫承諾、當選後才叫政見，政見串起來才叫脈絡）；判斷看政見所屬的那一屆，同 lineage_policy_ineligible_reason｜#345 第二階段 A（2026-10-06）：參選狀態讀 candidacy_status 一欄，不再讀舊的 candidate_status／election_result';

-- ------------------------------------------------------------
-- 3. 讀取端：lineages_full 的 policy_ids 只算合格的政見（前一版＝20261006034900；只改 policy_ids 那一處，標記 >>> 只算合格的政見）
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
  ) AS links
FROM lineages l;
ALTER VIEW lineages_full SET (security_invoker = on);
GRANT SELECT ON lineages_full TO anon, authenticated;
COMMENT ON VIEW lineages_full IS '政策脈絡一條一列（#349）：脈絡頁與脈絡一覽讀這個；政見只給 id（內容讀 policies_with_logs），參與者、交接、關聯各帶出處';
-- 視圖以呼叫者身分執行，用到的判斷函式明寫可執行
GRANT EXECUTE ON FUNCTION policy_is_elected_term(UUID, DATE) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION lineage_policy_ineligible_reason(UUID, DATE) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION lineage_policy_eligible(UUID, DATE) TO anon, authenticated;

-- ------------------------------------------------------------
-- 4. 自我檢查
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('policy_is_elected_term(uuid,date)') IS NULL OR to_regprocedure('lineage_policy_ineligible_reason(uuid,date)') IS NULL
     OR to_regprocedure('lineage_policy_eligible(uuid,date)') IS NULL THEN
    RAISE EXCEPTION '共用資格判斷函式沒建起來';
  END IF;
  -- 範圍已經沒有「還沒投票看在選者」那一支
  IF position('election_date >= CURRENT_DATE' IN pg_get_functiondef('lineage_candidate_scope()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'lineage_candidate_scope 還在收還沒投票的政見';
  END IF;
  -- 範圍裡的每一條政見都合格（範圍只可能比資格窄：多了分類、人物沒被合併、層級對得上的條件）
  IF EXISTS (SELECT 1 FROM lineage_candidate_scope() s WHERE NOT lineage_policy_eligible(s.policy_id)) THEN
    RAISE EXCEPTION 'lineage_candidate_scope 收了不合格的政見：範圍與共用資格判斷對不上';
  END IF;
  -- 讀取視圖只剩合格的政見
  IF EXISTS (SELECT 1 FROM lineages_full f, json_array_elements_text(f.policy_ids) x(id) WHERE NOT policy_is_elected_term(x.id::uuid)) THEN
    RAISE EXCEPTION 'lineages_full 還帶著不合格的政見';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
