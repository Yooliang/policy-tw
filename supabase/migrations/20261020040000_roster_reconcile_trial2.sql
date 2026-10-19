-- 名冊比對表：重新試跑（#708 修好異體字、同單位比對、安全網後）
-- 上一次試跑 5 筆有 2 筆重複，已撤回（10-20 02:0x 主線緊急停止）。
UPDATE roster_reconcile_settings
   SET enabled = true, batch_limit = 5, actions = ARRAY['new'],
       note = '2026-10-20 #708 後重新試跑：每輪 5 筆、只建新人物；檢查後調 100，再放行 attach'
 WHERE id = 1;
