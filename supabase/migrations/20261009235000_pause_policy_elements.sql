-- 暫緩派出「政見三要素」補件任務（policy_elements_missing），維護者 2026-10-09 裁示。
-- 現況（正式庫唯讀 10-09）：policy_elements 0 列；交件 90 筆全在等驗證，其中原文有寫數值目標 23、
-- 達成期限 8、財源 5，其餘都是「沒寫」。佇列裡 1,654 件，七天內全派出過。
-- 做法：只關規則（rule_id 33 不變），窗口一關 seed 下一輪把派工列以 reason='window' 收回；
-- 已交的 90 筆照常驗證。要恢復＝新 migration 把 enabled 改回 true。
UPDATE activity_rules
   SET enabled = false,
       note = '維護者 2026-10-09 暫緩：資料量先盤點再決定是否恢復（原 P1 種子，rule_id 不變）'
 WHERE id = 33 AND activity = 'policy_elements';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM activity_rules WHERE activity = 'policy_elements' AND enabled AND priority IS NULL) THEN
    RAISE EXCEPTION 'policy_elements 仍有開著的規則，暫緩沒有生效';
  END IF;
END $$;
