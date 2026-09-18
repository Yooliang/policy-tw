-- 任務帶「上次派出時間」，派過就排到後面。
--
-- 2026-09-17：「李四川這個任務怎麼好像跑 n 多次了」→「我覺得任務自己要有個
-- 時間戳，派過就向後排」。
--
-- 病灶：挑手動任務時只從「最高優先層的前 3 筆」裡挑（dispatch.ts 的 pickManualTask），
-- 而排序是 priority DESC、created_at ASC——最舊的那幾筆永遠佔著那個視窗。任務又要等
-- 「有貢獻上線」才關，李四川底下 21 筆全卡在票數不夠，於是它永遠在視窗裡，每個代理
-- 都抽到它，同一件事被查了十幾次（「居住新五箭」三份、醫療那包兩份、運動幣兩份）。
--
-- 有了這個欄位，排序改成 priority DESC → last_dispatched_at ASC（沒派過的優先）
-- → created_at ASC，派出即蓋章，自然輪替。

ALTER TABLE contribution_tasks
  ADD COLUMN IF NOT EXISTS last_dispatched_at TIMESTAMPTZ;

COMMENT ON COLUMN contribution_tasks.last_dispatched_at IS
  '上次派給代理的時間；派工排序用（沒派過的優先，派過的排到後面）。NULL 代表從未派出。';

-- 派工每次都會用這個排序撈前 20 筆
CREATE INDEX IF NOT EXISTS idx_tasks_dispatch_order
  ON contribution_tasks (status, priority DESC, last_dispatched_at ASC NULLS FIRST, created_at ASC);
