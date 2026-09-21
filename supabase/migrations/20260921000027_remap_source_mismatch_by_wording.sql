-- 既有「來源不支持內容」的提議改成 source_mismatch 型別（#13 補遺，2026-09-22 00:3x）
--
-- 000026 只認 [source_mismatch] 前綴，命中 0 筆：claim-audit 那批 89 筆查出的提議根本沒用這個前綴，
-- 它們是 other 型別、標題直接寫「原文查無」「來源寫的是 48 億，不是 49 億」「來源完全沒提到」。
-- 留著不改的話，之後別的代理對同一筆政見用 source_mismatch 提，claimKey 含型別 → 算成兩個提議、併不成票。
-- 只動「對象是政見」（target_policy_id 非空）而且字面講來源／原文／出處對不上的；人物欄位錯（簡志偉、藍聰信）、
-- 歸屬錯（廖先翔）那些型別本來就不是這個，不碰。

DO $$
DECLARE
  n_contrib int;
  n_task int;
BEGIN
  UPDATE contributions
     SET payload = jsonb_set(payload, '{task_type}', '"source_mismatch"'::jsonb)
   WHERE contribution_type = 'task_suggestion'
     AND status IN ('pending', 'verified')
     AND COALESCE(payload->>'task_type', 'other') = 'other'
     AND payload->>'target_policy_id' IS NOT NULL
     AND (COALESCE(payload->>'title', '') || ' ' || COALESCE(payload->>'reason', ''))
         ~ '(查無|對不上|不符|沒根據|來源未提|來源.*(沒提|沒有|不相關|無關|寫的是)|出處)';
  GET DIAGNOSTICS n_contrib = ROW_COUNT;

  UPDATE contribution_tasks
     SET task_type = 'source_mismatch'
   WHERE status = 'open' AND task_type = 'other'
     AND target_policy_id IS NOT NULL
     AND (COALESCE(title, '') || ' ' || COALESCE(description, ''))
         ~ '(查無|對不上|不符|沒根據|來源未提|來源.*(沒提|沒有|不相關|無關|寫的是)|出處)';
  GET DIAGNOSTICS n_task = ROW_COUNT;

  RAISE NOTICE 'source_mismatch 遷型別：提議 % 筆、任務 % 筆', n_contrib, n_task;
END $$;
