-- 名冊比對表第 3 步：每輪 100 筆、只建新人物（第三次試跑 5 筆檢查通過：姓名原文、無重複、edit_history 齊）
UPDATE roster_reconcile_settings
   SET enabled = true, batch_limit = 100, actions = ARRAY['new'],
       note = '2026-10-20 第 3 步：每輪 100、只建新人物；檢查後放行 attach（第 4 步）'
 WHERE id = 1;
