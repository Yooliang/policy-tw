-- 名冊比對表：試跑（維護者 10-19 授權依序 1→2→3→4、每步主線檢查，#678／#689）
-- 第 1 步（開票結果補完）已檢查：13,687 筆、當選者任期全有、edit_history 全有、與中選會一致。
-- 第 2 步：打開開關，每輪 5 筆、只建新人物；主線檢查後再調成 100（第 3 步）。
UPDATE roster_reconcile_settings
   SET enabled = true, batch_limit = 5, actions = ARRAY['new'],
       note = '2026-10-20 試跑：每輪 5 筆、只建新人物；檢查後調 100，再放行 attach'
 WHERE id = 1;
