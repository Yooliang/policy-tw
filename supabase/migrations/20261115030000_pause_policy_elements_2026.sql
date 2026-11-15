-- 暫停「政見三要素」補件任務（policy_elements_missing，規則 33），維護者 2026-11-15 裁示（正見VM #773）：
-- 2026 選前的承諾等當選後再做三要素比較合適，現在做是浪費代理額度。
-- 現況（正式庫唯讀 11-15）：規則 33 只派 2026 縣市長的數值目標（elements=['target']），近 24 小時交件 396 件、占全部 3565 件約 11%。
-- 做法同 20261009235000：只關規則（rule_id、params、election_types 不動），窗口一關 seed 下一輪以 reason='window' 收回；
-- 已交的照常驗證。要恢復＝新 migration 把 enabled 改回 true（選後，或改 election_ids 指當選的屆別）。
UPDATE activity_rules
   SET enabled = false,
       note = '維護者 2026-11-15 暫停：三要素等當選後再做（原 10-10 設定：只派數值目標、2026 縣市長；params 保留）'
 WHERE id = 33 AND activity = 'policy_elements';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM activity_rules WHERE activity = 'policy_elements' AND enabled AND priority IS NULL) THEN
    RAISE EXCEPTION 'policy_elements 仍有開著的規則，暫停沒有生效';
  END IF;
END $$;
