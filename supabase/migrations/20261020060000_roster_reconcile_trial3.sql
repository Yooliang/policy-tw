-- 名冊比對表：第三次試跑（#710 改用名冊原文姓名後）
UPDATE roster_reconcile_settings
   SET enabled = true, batch_limit = 5, actions = ARRAY['new'],
       note = '2026-10-20 #710 後第三次試跑：每輪 5 筆、只建新人物；檢查姓名原文後調 100'
 WHERE id = 1;
