-- 補回那些「查過、沒東西可補」卻沒留下痕跡的紀錄。
--
-- 為什麼會漏：task_checks 的寫入在 _shared/apply-contribution.ts 的 applyNoChange 裡，
-- 但 apply 與 apply-verified 這兩支落庫函式的部署時間（16:00）早於那段程式碼的提交
-- 時間（16:07），我當時只補部署了 next。於是 migration 建好了表、派工端也套了冷卻
-- 過濾，唯獨沒有人往表裡寫——冷卻機制看起來上線了，實際上永遠命中不到。
--
-- 這支只補資料，不改結構。checked_at 用該筆貢獻的落庫時間，不用 now()：冷卻是從
-- 「查證那天」起算十四天，不是從我發現漏洞那天起算。

INSERT INTO task_checks (task_id, checked_at, agent_name, note, contribution_id)
SELECT c.payload->>'task_id',
       COALESCE(c.applied_at, c.created_at),
       c.agent_name,
       COALESCE(c.payload->>'finding', c.payload->>'note', c.note),
       c.id
FROM contributions c
WHERE c.contribution_type = 'no_change'
  AND c.status IN ('applied', 'verified')
  AND c.payload->>'task_id' LIKE 'auto:%'
  AND NOT EXISTS (
    SELECT 1 FROM task_checks tc WHERE tc.contribution_id = c.id
  );
