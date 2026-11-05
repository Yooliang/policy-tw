-- 政策脈絡任務提前三天（2026-11-05，policy-ops#201）
--
-- 起因：維護者問「怎麼讓政策脈絡動起來」。他的長期規則是偏向某一群走規則秒數、不要反覆 /boost。
-- 唯讀量到（2026-11-05 正式庫）：lineage_candidate 218 件任務列（124 件從沒派過）、lineage_roles_missing 27 件。
-- 現況：脈絡的三條窗口規則（activity_rules id 6、25、26，活動名 lineage_candidates／lineage_links／lineage_roles）priority、priority_seconds 都是 NULL，
-- 且沒有 priority: 規則，所以走預設層（中段，0 秒）；其中 79 件已因流量提層拿到 3 天。
--
-- 做法：加兩條優先規則 priority:lineage_candidates、priority:lineage_roles，放前段（priority=1，優先秒數 259200＝3 天，
-- 跟現有前段規則 id 37／40／44 同一個數字，不另發明）。排序鍵＝進隊時間 − 優先秒數（見 task_queue_key、activity_priority_seconds，20261011320000）。
-- 為什麼不是改 id 6／26 的 priority_seconds：activity_priority_seconds 只讀活動名開頭 priority: 的規則，而且
-- activity_rules_priority_seconds_check 要求 priority_seconds 非 NULL 時 priority 也要非 NULL，窗口規則上填了不會生效。
-- 不動 lineage_links 臂（lineage_links 0 筆、#675 規劃淘汰）、不動任何窗口規則、門檻、協議、計分與臂的 SQL。
--
-- 效果：秒數是 seed 每輪重算進 task_dispatches.priority_seconds，下一輪 seed（每 10 分鐘）起生效；已存在的驗證票排序已凍結（20261104120000），不會移位。
-- 異動走既有觸發器 trg_activity_rules_audit → edit_history。
--
-- 還原（任選一種，都不用改函式；下一輪 seed 回到 0 秒）：
--   停用：UPDATE activity_rules SET enabled = false, note = '還原脈絡提前' WHERE activity IN ('priority:lineage_candidates', 'priority:lineage_roles');
--   刪除：DELETE FROM activity_rules WHERE activity IN ('priority:lineage_candidates', 'priority:lineage_roles');
--   想改幅度：UPDATE activity_rules SET priority_seconds = <秒數> WHERE activity IN (...)（主控台規則總表也能改）。
INSERT INTO activity_rules (activity, window_kind, priority, priority_seconds, note)
SELECT v.activity, 'always', 1, 259200,
       '前段：政策脈絡（' || v.label || '）提前 3 天（2026-11-05 維護者問怎麼讓脈絡動起來；偏向某一群走規則秒數、不反覆 /boost）。優先秒數 259200＝與現有前段規則同一個數字，數值是實作者的選擇。還原：停用或刪除這條規則'
  FROM (VALUES ('priority:lineage_candidates', '脈絡候選 lineage_candidate'),
               ('priority:lineage_roles', '脈絡角色補齊 lineage_roles_missing')) AS v(activity, label)
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = v.activity);

NOTIFY pgrst, 'reload schema';
