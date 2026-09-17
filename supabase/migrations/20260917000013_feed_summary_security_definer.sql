-- 承 000012：統計函式要以定義者身分執行。
--
-- 匿名呼叫時回的是 0 與空陣列——函式沒有 SECURITY DEFINER，跑在呼叫者的權限下，
-- 而 contributions 的 RLS 擋住匿名讀取。Edge Function 用 service role 不受影響，
-- 但那樣就只有伺服器用得到，前端與外部代理仍得繞遠路。
--
-- 這兩支只回聚合數字（各狀態筆數、每日統計、代號與分數），站上本來就公開顯示，
-- 不會洩漏個別貢獻內容或 IP 雜湊。search_path 固定，避免被搜尋路徑注入同名物件。

ALTER FUNCTION contribution_leaderboard(INTEGER) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION contribution_feed_summary() SECURITY DEFINER SET search_path = public;
