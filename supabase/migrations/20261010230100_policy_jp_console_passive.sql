-- 日本站：主控台派工頁「被動」段的資料（工作單 Yooliang/policy-ops#78），正見 20261010230000 console_passive() 的同形版。
-- 日本站沒有新聞收錄與公民提問：news_tasks 回空物件、news_queued 0、news_7d NULL；verify_pending 只分 web_request／adjudication／agent。
-- 只動 policy_jp，不碰 public。

CREATE OR REPLACE FUNCTION policy_jp.console_passive() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = policy_jp, pg_temp AS $$
  WITH pend AS (
    SELECT CASE
             WHEN t.source = 'web_request' THEN 'web_request'
             WHEN c.contribution_type = 'adjudication' THEN 'adjudication'
             ELSE 'agent' END AS src
      FROM policy_jp.contributions c
      LEFT JOIN policy_jp.contribution_tasks t ON t.id::TEXT = c.task_id
     WHERE c.status = 'pending'
  )
  SELECT jsonb_build_object(
    'verify_pending', (SELECT COALESCE(jsonb_object_agg(x.src, x.n), '{}'::JSONB) FROM (SELECT src, count(*) AS n FROM pend GROUP BY 1) x),
    'news_tasks', '{}'::JSONB,
    'news_queued', 0,
    'news_7d', NULL
  )
$$;
COMMENT ON FUNCTION policy_jp.console_passive IS
  '主控台派工頁「被動」段（日本站）：等驗證交件依來源（web_request／adjudication／agent）；沒有新聞收錄，news_* 為空。公開唯讀。2026-10-11（policy-ops #78）';
REVOKE ALL ON FUNCTION policy_jp.console_passive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION policy_jp.console_passive() TO anon, authenticated, service_role;
