-- queue_preview 改 SECURITY DEFINER（2026-09-23）
-- contributions 表對 anon 關閉（RLS），/queue 頁用 anon 呼叫時看不到任何待驗證項目，清單只剩任務——
-- 但佇列最前面 1,516 筆正是驗證。這支函式只回型別、姓名／標題、縣市、排隊時間，不回 IP、不回 payload 全文，
-- 用 definer 跑是安全的。search_path 釘死避免被劫持。
ALTER FUNCTION queue_preview(INTEGER) SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION queue_preview(INTEGER) FROM public;
GRANT EXECUTE ON FUNCTION queue_preview(INTEGER) TO anon, authenticated;
