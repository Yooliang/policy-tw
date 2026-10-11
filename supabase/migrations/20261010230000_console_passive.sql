-- 主控台派工頁第三段「被動（新聞與交件驅動）」的資料（工作單 Yooliang/policy-ops#78；決定 policy-ops docs/decisions/2026-10-11-派工頁加被動一類.md）
-- ============================================================
--
-- 維護者 10-11：日常、當屆選舉之外，還有一類是外面資料先進來才產生的（新聞收錄、交件），不設開關、有東西進來就處理。
-- 這支只加一支唯讀函式 console_passive()，不動派工、seed、規則、時間軸（console_timeline／console_arm_election_counts 一字不動）：
--   * verify_pending：等驗證的交件，依來源分——question（公民提問的回答）、web_request（網站請求任務底下的）、
--     news（新聞任務底下的）、adjudication（裁決）、agent（其餘一般代理交件）
--   * news_tasks：Jev 新聞初篩開出的任務（news_sweep、target.kind＝news_item），依 suggestion（new_pledge／progress）分開著、近 7 天完成
--   * news_queued：新聞任務在佇列裡的列數——它們算在手動任務臂 manual_open 裡，主控台把日常段的 manual_open 扣掉這個數，一筆只歸一類
--   * news_7d：近 7 天新聞收錄到開任務的漏斗（收進、無人名、判無關、把握不夠、新承諾、進度、開了任務、併進既有任務、延後）
-- 資料品質臂：逐支讀了定義（PR 說明附表），12 支都是對現存資料的全表盤點、沒有「新交件／新資料」才觸發的條件
-- （owner_mismatch 一半訊號來自交件回報、一半是名冊出生年與換縣市的盤點），所以這一版不把任何臂移進被動段。
-- 權限：SECURITY DEFINER、釘 search_path、REVOKE ALL FROM PUBLIC、只 GRANT EXECUTE 給 anon／authenticated／service_role（照 20261010110000）。
-- 日本站同形的一支在 20261010230100_policy_jp_console_passive.sql（沒有新聞收錄，news_* 回空）。

CREATE OR REPLACE FUNCTION console_passive() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH pend AS (
    SELECT CASE
             WHEN c.contribution_type = 'question_answer' THEN 'question'
             WHEN t.source = 'web_request' THEN 'web_request'
             WHEN t.task_type = 'news_sweep' THEN 'news'
             WHEN c.contribution_type = 'adjudication' THEN 'adjudication'
             ELSE 'agent' END AS src
      FROM contributions c
      LEFT JOIN contribution_tasks t ON t.id::TEXT = c.task_id
     WHERE c.status = 'pending'
  ),
  nt AS (
    SELECT COALESCE(t.target->>'suggestion', 'other') AS sug, t.status
      FROM contribution_tasks t
     WHERE t.task_type = 'news_sweep' AND t.target->>'kind' = 'news_item'
       AND (t.status = 'open' OR t.closed_at > now() - INTERVAL '7 days')
  ),
  ni AS (
    SELECT n.screen->>'result' AS r, n.task_id, (n.screen ? 'appended_to_task') AS appended,
           COALESCE((n.screen->>'deferred')::BOOLEAN, false) AS deferred
      FROM news_items n
     WHERE n.screened_at > now() - INTERVAL '7 days'
  )
  SELECT jsonb_build_object(
    'verify_pending', (SELECT COALESCE(jsonb_object_agg(x.src, x.n), '{}'::JSONB) FROM (SELECT src, count(*) AS n FROM pend GROUP BY 1) x),
    'news_tasks', (SELECT COALESCE(jsonb_object_agg(x.sug, jsonb_build_object('open', x.o, 'closed_7d', x.cl)), '{}'::JSONB)
                     FROM (SELECT sug, count(*) FILTER (WHERE status = 'open') AS o, count(*) FILTER (WHERE status <> 'open') AS cl
                             FROM nt GROUP BY 1) x),
    'news_queued', (SELECT count(*) FROM task_dispatches d JOIN contribution_tasks t ON t.id::TEXT = d.task_id
                     WHERE t.task_type = 'news_sweep'),
    'news_7d', (SELECT jsonb_build_object(
                  'received', (SELECT count(*) FROM news_items n WHERE n.created_at > now() - INTERVAL '7 days'),
                  'no_name', count(*) FILTER (WHERE r = 'no_name'),
                  'unrelated', count(*) FILTER (WHERE r = 'unrelated'),
                  'low_confidence', count(*) FILTER (WHERE r = 'low_confidence'),
                  'new_pledge', count(*) FILTER (WHERE r = 'new_pledge'),
                  'progress', count(*) FILTER (WHERE r = 'progress'),
                  'opened', count(*) FILTER (WHERE task_id IS NOT NULL AND NOT appended),
                  'appended', count(*) FILTER (WHERE appended),
                  'deferred', count(*) FILTER (WHERE deferred))
                  FROM ni)
  )
$$;
COMMENT ON FUNCTION console_passive IS
  '主控台派工頁「被動」段：等驗證交件依來源（question／web_request／news／adjudication／agent）、新聞任務開著與近 7 天完成、'
  '新聞任務在佇列的列數（算在 manual_open 裡，主控台扣掉）、近 7 天新聞漏斗。公開唯讀。2026-10-11（policy-ops #78）';
REVOKE ALL ON FUNCTION console_passive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_passive() TO anon, authenticated, service_role;
