-- 停放判斷修正（2026-10-28）：elections.bulletin_published_on 在公報還沒上架時就已經有「預計上架日」（2026 是 2026-11-18），
-- 不是空的；所以「公報還沒上架」＝日期為空 或 還沒到（晚於今天）。20261028130000 只看 IS NULL，正式庫一件都沒停放到。
CREATE OR REPLACE FUNCTION web_request_parked(p_task_id UUID) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM contribution_tasks t
      JOIN politician_elections pe ON pe.politician_id = uuid_or_null(t.target->>'politician_id')
      JOIN elections e ON e.id = pe.election_id
     WHERE t.id = p_task_id
       AND t.source = 'web_request' AND t.task_type = 'policy_missing'
       AND pe.election_type IN ('村里長', '鄉鎮市民代表')
       AND e.election_date >= CURRENT_DATE
       AND (e.bulletin_published_on IS NULL OR e.bulletin_published_on > CURRENT_DATE)
  )
$$;
COMMENT ON FUNCTION web_request_parked IS '網站請求是否停放（2026-10-28）：缺政見且目標人物是還沒投票、選舉公報還沒上架（上架日為空或晚於今天）的村里長／鄉鎮市民代表候選人。停放的請求不進派工臂 manual_visitor、不被每小時整點拉回；公報上架日到了自動放出來。';

-- 已經在佇列裡的停放請求：收回派工列（20261028130000 的收回當時沒命中）
DELETE FROM task_dispatches d
 WHERE d.task_id NOT LIKE 'verify:%' AND d.task_id NOT LIKE 'auto:%'
   AND uuid_or_null(d.task_id) IS NOT NULL AND web_request_parked(uuid_or_null(d.task_id));

NOTIFY pgrst, 'reload schema';
