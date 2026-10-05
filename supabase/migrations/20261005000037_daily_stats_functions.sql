-- ============================================================
-- 管理儀表板「今日統計」改在資料庫端聚合（2026-10-05，小良哥裁決）
-- ============================================================
--
-- useDailyStats 原本在前端撈 ai_prompts 的 status／result_data 逐列再算：
-- PostgREST 單次上限 1,000 筆，一天任務超過就靜默少算（成功率、花費都偏）。
-- 改成兩支 SQL 函式，前端只拿聚合結果。只新增函式，不動任何既有物件。
--
-- 權限：照 get_politicians_by_level，不寫 SECURITY DEFINER（＝SECURITY INVOKER），
-- RLS 照呼叫者身分判定，也不寫 GRANT，靠建立函式時的預設權限。
-- 這幾張表原本前端就是用 anon 直接讀（ai_prompts 有公開讀取政策），沒有放寬。
--
-- 日界線：台灣時間（+08:00）的 [當日 00:00, 隔日 00:00)；p_date 為 NULL 時取台灣的今天。
-- 前端舊寫法的結尾是 23:59:59，會漏掉最後一秒內的資料，這裡改成半開區間。

CREATE OR REPLACE FUNCTION daily_stats(p_date date DEFAULT NULL)
RETURNS TABLE (
  today_candidates bigint,
  today_policies bigint,
  today_updates bigint,
  today_tasks bigint,
  today_completed bigint,
  today_cost_usd numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH d AS (
    SELECT (COALESCE(p_date, (now() AT TIME ZONE 'Asia/Taipei')::date)::text || ' 00:00:00+08')::timestamptz AS s
  ), r AS (
    SELECT s, s + interval '1 day' AS e FROM d
  )
  SELECT
    -- politicians／policies 沒有 created_at（舊前端這兩格一直查錯、靜默顯示 0；10-05 db push 因此失敗）。
    -- 改算「今天上線的貢獻」：資料都走貢獻流程，applied_at 就是它進正式資料的時間。
    (SELECT count(*) FROM contributions x, r WHERE x.status = 'applied' AND x.contribution_type IN ('politician', 'candidacy')
      AND x.applied_at >= r.s AND x.applied_at < r.e),
    (SELECT count(*) FROM contributions x, r WHERE x.status = 'applied' AND x.contribution_type = 'policy'
      AND x.applied_at >= r.s AND x.applied_at < r.e),
    (SELECT count(*) FROM ai_prompts x, r
      WHERE x.task_type = 'politician_update' AND x.status = 'completed'
        AND x.completed_at >= r.s AND x.completed_at < r.e),
    (SELECT count(*) FROM ai_prompts x, r WHERE x.created_at >= r.s AND x.created_at < r.e),
    (SELECT count(*) FROM ai_prompts x, r
      WHERE x.status = 'completed' AND x.created_at >= r.s AND x.created_at < r.e),
    (SELECT COALESCE(sum((x.result_data->'usage'->>'total_cost_usd')::numeric), 0) FROM ai_prompts x, r
      WHERE x.status = 'completed' AND x.completed_at >= r.s AND x.completed_at < r.e
        AND jsonb_typeof(x.result_data->'usage'->'total_cost_usd') = 'number');
$$;

CREATE OR REPLACE FUNCTION daily_task_type_counts(p_date date DEFAULT NULL)
RETURNS TABLE (task_type text, task_count bigint)
LANGUAGE sql
STABLE
AS $$
  WITH d AS (
    SELECT (COALESCE(p_date, (now() AT TIME ZONE 'Asia/Taipei')::date)::text || ' 00:00:00+08')::timestamptz AS s
  )
  SELECT COALESCE(x.task_type, 'unknown') AS task_type, count(*) AS task_count
  FROM ai_prompts x, d
  WHERE x.created_at >= d.s AND x.created_at < d.s + interval '1 day'
  GROUP BY 1
  ORDER BY 2 DESC, 1;
$$;
