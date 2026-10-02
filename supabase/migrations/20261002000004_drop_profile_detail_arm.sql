-- 緊急：把 profile_detail_gap 的臂從 contribution_auto_tasks_arms() 拿掉（2026-10-02）
--
-- 事故：/next 不帶 region 時回 500
--   {"error":"internal_error","message":"auto tasks: canceling statement due to statement timeout"}
-- 可重現：無 region 13.7s / 12.3s 兩次都 timeout；帶 region=台北市 4.8s 正常 → 是量的問題。
-- 影響：**所有外部貢獻者**領不到任務（/next 是四主端點之一），不只維護者自己的代理。
-- 發生時間：產出在 13:42 那一輪歸零（12:40 還有 116 筆），對應 20261002000002／000003 上線後缺口量暴增。
--
-- 20261002000002 清掉 417 張佔位圖 → profile_gap 從 32 筆變成 320 筆（那是**想要**的效果，不動它）。
-- 20261002000003 又加了一支掃全表（politicians 16,195 列、btrim(bio) 與 cardinality 都不吃索引）
-- 的 profile_detail_gap 臂、105 筆。兩者疊加把 contribution_auto_tasks 推過 statement timeout。
--
-- 🔴 這一支是**止血**，不是已證明的根因：我沒有 DB 連線可以量各臂耗時，
--    只能先拿掉「最新加的、最沒被證明過的那一個」恢復服務。拿掉後若還 timeout，
--    問題在別處（下一步要量各臂，不要再猜）。
-- profile_detail_gap 的函式本身保留（沒 DROP），要重新啟用只要把 UNION 那一行加回來；
--    重新啟用前必須先解決效能（例如加 partial index，或把範圍從全表收到 2026 候選人）。
-- 其餘 TS 側（task-types／skill.md／task-guidance 等）不動：型別存在但不再派出，無害。

CREATE OR REPLACE FUNCTION contribution_auto_tasks_arms()
RETURNS TABLE (task_id TEXT, task_type TEXT, target JSONB, what_we_need TEXT, hint_sources TEXT[], reward INTEGER, region TEXT)
LANGUAGE sql STABLE AS $$
  SELECT * FROM contribution_auto_tasks_raw()
  UNION ALL SELECT * FROM contribution_auto_tasks_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_legacy()
  UNION ALL SELECT * FROM contribution_auto_tasks_mismatch()
  UNION ALL SELECT * FROM contribution_auto_tasks_policy_dup()
  UNION ALL SELECT * FROM contribution_auto_tasks_not_running()
  UNION ALL SELECT * FROM contribution_auto_tasks_mayor_policies()
  UNION ALL SELECT * FROM contribution_auto_tasks_term_policies()
$$;
COMMENT ON FUNCTION contribution_auto_tasks_arms IS
  '所有自動缺口的來源，只有 UNION：新增任務型別只改這一支，派工規則（contribution_auto_tasks）不要再為此重寫。'
  '2026-10-02 暫時移除 contribution_auto_tasks_profile_details（/next statement timeout 止血），函式本體保留。';
