-- 地方統計（regional_stats_missing）降到後段優先（2026-10-26，維護者「B. 降優先」）
--
-- 起因：這臂永遠開、全台約 370 個縣市與鄉鎮市區 × 4 項指標都在派，一個地區一件任務、代理依「一地區一指標一年度一筆」拆成最多 4 筆交件，
-- 每筆各要 3 票。10-26 一天內待審從 33 衝到 525、近 1 小時交件 200 筆，驗證力被吃光（那一小時只有 1 票），
-- 網站請求（264 件開著、每天新進 286 件）與政見、人物的待審跟著堆。維護者不急著上線，選「降優先」而不是停派。
--
-- 做法：加一條優先規則 priority:regional_stats_missing，放後段（priority=3，優先秒數 −30 天，跟現有後段規則同一組數字，
-- 不另發明數字）。排序鍵＝進隊時間 − 優先秒數，負的優先秒數把新任務的鍵推到 30 天後；晚於「現在＋一天」的先不派（cooling），時間到自然放出來。
-- 效果：其他臂的任務先派，地方統計任務排到後段、慢慢輪；已經交的待審照舊進驗證池。要停派改 activity_rules.enabled；
-- 要恢復把這條規則停用或刪掉即可（不用改函式）。
INSERT INTO activity_rules (activity, window_kind, priority, priority_seconds, note)
SELECT 'priority:regional_stats_missing', 'always', 3, -2592000,
       '後段：地方統計（人口・面積・總預算歲出・65歲以上比例）不急著上線，一天內待審暴增到 500 筆、擠掉驗證力（2026-10-26 維護者選降優先）。優先秒數 −30 天＝與現有後段規則同一組數字。恢復：停用或刪除這條規則'
 WHERE NOT EXISTS (SELECT 1 FROM activity_rules r WHERE r.activity = 'priority:regional_stats_missing');

NOTIFY pgrst, 'reload schema';
