-- 開票結果自動寫入：試寫通過，調回每輪 2000（維護者 10-19「好」，#678）
-- 試寫 100 筆核對：中選會一致 100/100、當選者任期 79/79、edit_history 100/100。
UPDATE cec_results_auto_settings
   SET batch_limit = 2000,
       note = '2026-10-19 試寫 100 筆核對無誤（中選會一致、任期、edit_history 全對），維護者同意調回 2000'
 WHERE id = 1;
