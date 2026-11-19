-- 數據分佈頁（/regional-data）改版用的聚合視圖：瀏覽器不再為了數字下載 16k 筆政見。
--
-- 口徑（維護者 2026-11-19 拍板，裁決 docs/decisions/2026-11-19-數據分佈兌現率與資料不足顯示.md）：
--   承諾    ＝ status 為 Campaign Pledge 的政見（不論那一屆有沒有當選）
--   政見    ＝ status 不是 Campaign Pledge、而且屬選後／施政（同 policies_by_region.listed、lib/policy-stage.ts 的 isPostElectionStage）
--   已提出／施政中／已完成／停滯 ＝ 政見的 status：Proposed／In Progress／Achieved／Stalled＋Failed
--   兌現率  ＝ （施政中＋已完成）÷ 政見數（前端 lib/regional-overview.ts 算，不在視圖裡）
-- 縣市：COALESCE(regions.region, politicians.region)，與 policies_by_region、lib/policy-region.ts 同一個；全國範圍的人物 region＝全國，只進全台加總。
-- listed 的 SQL 與 TS 是同一份規則的兩份，改一邊要連另一邊一起改（守門 lib/regional-overview.test.ts 讀這支 migration）。
-- 權限：比照 politician_election_policy_counts——security_invoker＋給 anon／authenticated 讀；底層表的 RLS 照常生效。

-- 1) 縣市 × 分類 × 階段計數（約 23×19 列）；縣市階段漏斗由它加總（region_stage_counts）
CREATE OR REPLACE VIEW region_category_stage_counts AS
SELECT
  COALESCE(r.region, po.region) AS region,
  pl.category,
  count(*) FILTER (WHERE pl.status = 'Campaign Pledge')::int AS pledge_n,
  count(*) FILTER (WHERE x.listed AND pl.status = 'Proposed')::int AS proposed_n,
  count(*) FILTER (WHERE x.listed AND pl.status = 'In Progress')::int AS in_progress_n,
  count(*) FILTER (WHERE x.listed AND pl.status = 'Achieved')::int AS achieved_n,
  count(*) FILTER (WHERE x.listed AND pl.status IN ('Stalled', 'Failed'))::int AS stalled_n
FROM policies pl
JOIN politicians po ON po.id = pl.politician_id
LEFT JOIN regions r ON r.id = po.region_id
LEFT JOIN elections e ON e.id = pl.election_id
CROSS JOIN LATERAL (
  SELECT (
    NOT (CASE WHEN COALESCE(pl.origin, '') <> '' THEN pl.origin = 'pledge' ELSE pl.status = 'Campaign Pledge' END)
    OR (
      pl.election_id IS NOT NULL
      AND e.election_date < activity_today()
      AND EXISTS (
        SELECT 1 FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id AND q.candidacy_status = 'elected'
      )
    )
  ) AS listed
) x
WHERE pl.removed_at IS NULL
GROUP BY COALESCE(r.region, po.region), pl.category;

ALTER VIEW region_category_stage_counts SET (security_invoker = on);
GRANT SELECT ON region_category_stage_counts TO anon, authenticated;
COMMENT ON VIEW region_category_stage_counts IS
  '縣市 × 分類的承諾／政見階段計數（未移除）：pledge_n＝status 為 Campaign Pledge；政見（選後／施政、status 不是 Campaign Pledge）依 status 分 proposed_n／in_progress_n／achieved_n／stalled_n（Stalled＋Failed）。數據分佈頁的熱力圖與漏斗讀它。';

-- 2) 縣市階段漏斗：上面那支再加總到縣市
CREATE OR REPLACE VIEW region_stage_counts AS
SELECT
  region,
  sum(pledge_n)::int AS pledge_n,
  sum(proposed_n)::int AS proposed_n,
  sum(in_progress_n)::int AS in_progress_n,
  sum(achieved_n)::int AS achieved_n,
  sum(stalled_n)::int AS stalled_n
FROM region_category_stage_counts
GROUP BY region;

ALTER VIEW region_stage_counts SET (security_invoker = on);
GRANT SELECT ON region_stage_counts TO anon, authenticated;
COMMENT ON VIEW region_stage_counts IS
  '縣市階段計數（承諾／已提出／施政中／已完成／停滯），由 region_category_stage_counts 加總；約 23 列。兌現率＝（in_progress_n＋achieved_n）÷ 政見數，前端算。';

-- 3) 脈絡：一條（一覽會列出的）脈絡一列，帶它跨了哪幾屆、交接幾次
--    只算合格政見（policy_is_elected_term，同 lineages_full.policy_ids）；沒有合格政見的空脈絡不列（同 lib/lineage.ts isLineageListed）
CREATE OR REPLACE VIEW lineage_term_spans AS
SELECT
  l.id AS lineage_id,
  l.title,
  l.category,
  l.level,
  COALESCE(NULLIF(l.region, ''), '全國') AS region,
  t.election_ids,
  t.term_years,
  (SELECT count(*)::int FROM handovers h WHERE h.lineage_id = l.id) AS handover_n
FROM lineages l
CROSS JOIN LATERAL (
  SELECT
    array_agg(DISTINCT pl.election_id) FILTER (WHERE pl.election_id IS NOT NULL) AS election_ids,
    array_agg(DISTINCT EXTRACT(YEAR FROM e.election_date)::int) FILTER (WHERE e.election_date IS NOT NULL) AS term_years,
    count(*) AS policy_n
  FROM policies pl
  LEFT JOIN elections e ON e.id = pl.election_id
  WHERE pl.lineage_id = l.id AND pl.removed_at IS NULL AND policy_is_elected_term(pl.id)
) t
WHERE t.policy_n > 0;

ALTER VIEW lineage_term_spans SET (security_invoker = on);
GRANT SELECT ON lineage_term_spans TO anon, authenticated;
COMMENT ON VIEW lineage_term_spans IS
  '一覽會列出的脈絡（至少一條合格政見）一條一列：region（中央層級＝全國）、category、跨哪幾屆（election_ids／term_years）、交接數 handover_n。脈絡約百條；數據分佈頁的脈絡接力與熱力圖「脈絡」頁籤讀它，各縣市脈絡數、平均跨任期數前端用 lib/regional-overview.ts 算。';

-- 4) 政見三要素：縣市 × 層級（參選職位）；stated＝原文有寫，total＝有調查過的（沒有列＝未調查，不計入 total，#364）
CREATE OR REPLACE VIEW region_element_stats AS
SELECT
  COALESCE(r.region, po.region) AS region,
  COALESCE(pe.election_type::text, po.election_type::text, '') AS election_type,
  count(*) FILTER (WHERE pel.element = 'target' AND pel.stated)::int AS target_stated,
  count(*) FILTER (WHERE pel.element = 'target')::int AS target_total,
  count(*) FILTER (WHERE pel.element = 'deadline' AND pel.stated)::int AS deadline_stated,
  count(*) FILTER (WHERE pel.element = 'deadline')::int AS deadline_total,
  count(*) FILTER (WHERE pel.element = 'funding' AND pel.stated)::int AS funding_stated,
  count(*) FILTER (WHERE pel.element = 'funding')::int AS funding_total
FROM policy_elements pel
JOIN policies pl ON pl.id = pel.policy_id AND pl.removed_at IS NULL
JOIN politicians po ON po.id = pl.politician_id
LEFT JOIN regions r ON r.id = po.region_id
LEFT JOIN politician_elections pe ON pe.politician_id = pl.politician_id AND pe.election_id = pl.election_id
GROUP BY 1, 2;

ALTER VIEW region_element_stats SET (security_invoker = on);
GRANT SELECT ON region_element_stats TO anon, authenticated;
COMMENT ON VIEW region_element_stats IS
  '政見三要素說明比例的分子分母：縣市 × 層級（參選職位，沒標屆別的政見退回人物自己的職位），每個要素 stated（原文有寫）與 total（已調查）。沒有列＝未調查、不在分母。數據分佈頁「承諾品質」讀它。';

-- 5) 期限分佈與近 30 天進度：政見（選後／施政、status 不是 Campaign Pledge）為母體，依縣市
--    期限＝政見三要素裡 deadline 且有日期（deadline_date）；逾期＝日期早於台北今天；30 天內＝今天起（含）30 天；
--    近 30 天有進度更新＝tracking_logs 有 date 落在台北今天往前 30 天內（不用 policies.updated_at：資料整理也會動它）
CREATE OR REPLACE VIEW region_deadline_stats AS
SELECT
  COALESCE(r.region, po.region) AS region,
  count(*)::int AS policy_n,
  count(*) FILTER (WHERE d.deadline_date < activity_today())::int AS overdue_n,
  count(*) FILTER (WHERE d.deadline_date >= activity_today() AND d.deadline_date <= activity_today() + 30)::int AS within30_n,
  count(*) FILTER (WHERE d.deadline_date > activity_today() + 30)::int AS later_n,
  count(*) FILTER (WHERE d.deadline_date IS NULL)::int AS unset_n,
  count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM tracking_logs tl WHERE tl.policy_id = pl.id AND tl.date >= activity_today() - 30
  ))::int AS updated_30d_n
FROM policies pl
JOIN politicians po ON po.id = pl.politician_id
LEFT JOIN regions r ON r.id = po.region_id
LEFT JOIN elections e ON e.id = pl.election_id
LEFT JOIN LATERAL (
  SELECT min(pel.deadline_date) AS deadline_date FROM policy_elements pel
   WHERE pel.policy_id = pl.id AND pel.element = 'deadline' AND pel.stated AND pel.deadline_date IS NOT NULL
) d ON true
WHERE pl.removed_at IS NULL
  AND pl.status <> 'Campaign Pledge'
  AND (
    NOT (CASE WHEN COALESCE(pl.origin, '') <> '' THEN pl.origin = 'pledge' ELSE pl.status = 'Campaign Pledge' END)
    OR (
      pl.election_id IS NOT NULL
      AND e.election_date < activity_today()
      AND EXISTS (
        SELECT 1 FROM politician_elections q
         WHERE q.politician_id = pl.politician_id AND q.election_id = pl.election_id AND q.candidacy_status = 'elected'
      )
    )
  )
GROUP BY COALESCE(r.region, po.region);

ALTER VIEW region_deadline_stats SET (security_invoker = on);
GRANT SELECT ON region_deadline_stats TO anon, authenticated;
COMMENT ON VIEW region_deadline_stats IS
  '政見（選後／施政、status 不是 Campaign Pledge）依縣市：policy_n 總數、期限分佈 overdue_n／within30_n／later_n／unset_n（取該政見最早的已說明期限日期）、updated_30d_n（近 30 天 tracking_logs 有進度紀錄）。數據分佈頁「期限分佈」讀它。';
