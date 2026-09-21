-- task_suggestion 加 source_mismatch 型別（#13，2026-09-22）：來源存在但不支持內容。
-- 型別本身在 TS 白名單（contribution-schema TASK_TYPES）與派工建議（task-types）裡；這支只把
-- 型別上線前先用 other 提、reason／description 開頭標 [source_mismatch] 的既有提議與任務改過來，
-- 免得同一個缺陷分裂成兩個型別、被併票機制算成兩個提議（leatherback 2026-09-21 指出的順序問題）。

UPDATE contributions
   SET payload = jsonb_set(payload, '{task_type}', '"source_mismatch"'::jsonb)
 WHERE contribution_type = 'task_suggestion'
   AND status IN ('pending', 'verified')
   AND COALESCE(payload->>'task_type', 'other') = 'other'
   AND (COALESCE(payload->>'reason', '') LIKE '[source_mismatch]%'
        OR COALESCE(payload->>'description', '') LIKE '[source_mismatch]%'
        OR COALESCE(payload->>'title', '') LIKE '[source_mismatch]%');

UPDATE contribution_tasks
   SET task_type = 'source_mismatch'
 WHERE status = 'open' AND task_type = 'other'
   AND (COALESCE(description, '') LIKE '[source_mismatch]%' OR COALESCE(title, '') LIKE '[source_mismatch]%');
