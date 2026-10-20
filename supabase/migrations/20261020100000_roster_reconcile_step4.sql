-- 名冊比對表第 4 步：放行掛既有人物（第 3 步檢查：新建 6,266 筆，姓名原文、無重複、地區僅 1 筆缺（名冊缺村里））
UPDATE roster_reconcile_settings
   SET enabled = true, batch_limit = 100, actions = ARRAY['new','attach'],
       note = '2026-10-20 第 4 步：放行 attach，每輪 100'
 WHERE id = 1;
