-- 早期由 AI 搜尋匯入、有來源但從沒進過貢獻流程的政見（實查 137 筆），頁面掛著「尚未查核」（使用者 2026-09-20）。
-- 流程補法：
--   1. system-one?action=legacy（排程）：抓 source_url、逐欄問 Jev，記 jev_decisions（policy／source_support）——系統先核
--   2. legacy_audit 自動任務（每筆一次）：代理打開來源核對；對 → no_change；不對 → correction；不是政見 → removal
--   3. no_change 通過後在 edit_history 寫一列 policies.audit，頁面「尚未查核」變「已查核」，任務隨之消失
-- 沒來源的 44 筆維持 policy_validity 路徑。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_legacy()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $fn$
  SELECT 'auto:legacy_audit:' || pl.id, 'legacy_audit',
         jsonb_build_object('policy_id', pl.id, 'policy_title', pl.title, 'politician_id', p.id, 'name', p.name, 'region', p.region, 'source_url', pl.source_url),
         '「' || pl.title || '」（' || p.name || '）是早期由系統匯入的政見，附了來源但從沒有人核對過。'
           || '請打開來源：標題與內容是不是這個人的承諾、內容有沒有寫錯、屬於哪一場選舉。'
           || '資料正確 → 用 no_change 回報（note 寫你核對了什麼，這筆就算查核過了）；欄位有錯 → correction 改對；'
           || '不是政見（口號、行程、表態）→ removal（target_table policies、target_id、reason ≥20 字）。'
           || 'item.current.system_check 是系統對這個來源的逐欄核對結果，可以參考但請自己看過。',
         ARRAY[pl.source_url], 1, p.region
  FROM policies pl JOIN politicians p ON p.id = pl.politician_id
  WHERE pl.removed_at IS NULL
    AND COALESCE(pl.source_url, '') <> ''
    AND p.merged_into IS NULL
    -- 從沒進過流程：沒有任何查核履歷、也不是貢獻建出來的
    AND NOT EXISTS (SELECT 1 FROM edit_history e WHERE e.table_name = 'policies' AND e.record_id = pl.id::TEXT)
    AND NOT EXISTS (SELECT 1 FROM contributions c WHERE c.applied_policy_id = pl.id)
$fn$;
COMMENT ON FUNCTION contribution_auto_tasks_legacy IS '早期匯入、有來源、沒查核履歷的政見 → legacy_audit 任務；no_change 通過寫一列 policies.audit 後消失';

CREATE OR REPLACE FUNCTION contribution_auto_tasks(
  p_type TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 20,
  p_seed TEXT DEFAULT '',
  p_ip_hash TEXT DEFAULT NULL,
  p_agent TEXT DEFAULT NULL
) RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER)
LANGUAGE sql STABLE AS $$
  WITH t AS (
    SELECT * FROM contribution_auto_tasks_raw()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_dup()
    UNION ALL
    SELECT * FROM contribution_auto_tasks_legacy()
  ),
  inflight AS (
    SELECT c.task_id, COUNT(*) AS n FROM contributions c
    WHERE c.task_id IS NOT NULL AND c.status IN ('pending', 'verified', 'disputed') GROUP BY c.task_id
  )
  SELECT t.task_id, t.task_type, t.target, t.what_we_need, t.hint_sources, t.reward
  FROM t
  LEFT JOIN inflight f ON f.task_id = t.task_id
  LEFT JOIN task_dispatches d ON d.task_id = t.task_id
  WHERE (p_type IS NULL OR t.task_type = p_type)
    AND (p_region IS NULL OR t.region = p_region)
    -- 冷卻（有人回報過 no_change 並已落庫）
    AND NOT EXISTS (
      SELECT 1 FROM task_checks tc
      WHERE tc.task_id = t.task_id AND tc.checked_at > now() - (task_check_cooldown_days() || ' days')::INTERVAL
    )
    -- 底下在途 ≥5 筆：它缺的是票不是更多提交
    AND COALESCE(f.n, 0) < 5
    -- 有人回報「查了沒東西」還在等票：期間不派
    AND NOT EXISTS (
      SELECT 1 FROM contributions c WHERE c.contribution_type = 'no_change' AND c.status IN ('pending', 'verified') AND c.payload->>'task_id' = t.task_id
    )
    -- 以下三種是「對這個代理」的排除，沒帶身份就不做
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contribution_task_leases l
      WHERE l.leased_until > now() AND (p_agent IS NULL OR lower(l.agent_name) <> lower(p_agent))
        AND (l.task_id = t.task_id OR l.target_key = task_target_key(t.task_id, t.target))
    ))
    AND (p_ip_hash IS NULL OR NOT EXISTS (
      SELECT 1 FROM contributions c
      WHERE c.task_id = t.task_id AND c.status IN ('pending', 'verified', 'disputed')
        AND (c.contributor_ip_hash = p_ip_hash OR (p_agent IS NOT NULL AND c.agent_name = p_agent))
    ))
  ORDER BY
    -- 一次性插隊：Jev 有高信心答案、而且還沒派過的，排最前（派過一次就跟大家一樣按最久沒派排）
    CASE WHEN d.task_id IS NULL AND system_one_priority_enabled() AND (
      EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'election' AND j.choice <> 'unknown'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:policy_election_missing:' || j.subject_id)
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'politician_pair' AND j.question = 'same_person' AND j.choice = 'same'
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:duplicate_politician:' || j.subject_id)
      -- 早期匯入的政見：系統核過來源（支持或矛盾都算，矛盾更該先看）的排前面
      OR EXISTS (SELECT 1 FROM jev_decisions j
        WHERE j.subject_type = 'policy' AND j.question = 'source_support' AND j.choice IN ('supported', 'not_supported')
          AND j.probability >= system_one_min_probability() AND t.task_id = 'auto:legacy_audit:' || j.subject_id)
    ) THEN 0 ELSE 1 END,
    -- 最久沒派的優先；沒派過的算最久。這就是全序，不需要隨機（同時派給多人由 SQL 裡的認領排除擋）
    d.last_dispatched_at ASC NULLS FIRST,
    t.task_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100000));
$$;
COMMENT ON FUNCTION contribution_auto_tasks IS
  '自動任務派工（含同名配對與早期匯入核對）：合格判斷都在 LIMIT 之前；排序＝（沒派過且系統有判定）一次性插隊 → 最久沒派 → task_id';

-- 系統先核：每 30 分鐘 20 筆，直到 137 筆核完（候選查詢冪等，核完自然空）
SELECT cron.unschedule('system-one-legacy-30min')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'system-one-legacy-30min');
SELECT cron.schedule(
  'system-one-legacy-30min',
  '11,41 * * * *',
  $$SELECT net.http_post(
      url := 'https://wiiqoaytpqvegtknlbue.supabase.co/functions/v1/system-one?action=legacy&limit=20',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    );$$
);
